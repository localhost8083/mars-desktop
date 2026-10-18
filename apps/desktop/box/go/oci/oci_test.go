//go:build linux

package oci

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type entry struct {
	name, body, link string
	typ              byte
	mode             int64
}

func tarBytes(t *testing.T, entries []entry, gz bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	var w = &buf
	var zw *gzip.Writer
	tw := tar.NewWriter(w)
	if gz {
		zw = gzip.NewWriter(w)
		tw = tar.NewWriter(zw)
	}
	for _, e := range entries {
		mode := e.mode
		if mode == 0 {
			mode = 0o644
			if e.typ == tar.TypeDir {
				mode = 0o755
			}
		}
		hdr := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: mode, Size: int64(len(e.body)), Linkname: e.link}
		if e.typ != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	if zw != nil {
		zw.Close()
	}
	return buf.Bytes()
}

func digestOf(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}

func TestParseRef(t *testing.T) {
	cases := map[string]string{
		"ubuntu":                                 "docker.io/library/ubuntu:latest",
		"ubuntu:24.04":                           "docker.io/library/ubuntu:24.04",
		"ghcr.io/omnirush-ai/box-base:2026.10.1": "ghcr.io/omnirush-ai/box-base:2026.10.1",
		"localhost:5000/x/y:t":                   "localhost:5000/x/y:t",
		"127.0.0.1:5000/omnirush-ai/box-base:1":  "127.0.0.1:5000/omnirush-ai/box-base:1",
	}
	for in, want := range cases {
		r, err := ParseRef(in)
		if err != nil || r.String() != want {
			t.Errorf("%s -> %v %v, want %s", in, r.String(), err, want)
		}
	}
	d := "sha256:" + strings.Repeat("a", 64)
	r, err := ParseRef("ghcr.io/o/b:1@" + d)
	if err != nil || r.Digest != d || r.Reference() != d || r.Tag != "1" {
		t.Fatalf("pinned: %+v %v", r, err)
	}
	if _, err := ParseRef("ghcr.io/O/B"); err == nil {
		t.Fatal("upper case accepted")
	}
	if !(Ref{Registry: "localhost:5000"}).Plain() || (Ref{Registry: "ghcr.io"}).Plain() {
		t.Fatal("plain http only on loopback")
	}
}

func TestParseChallenge(t *testing.T) {
	s, p := ParseChallenge(`Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/b:pull"`)
	if s != "bearer" || p["realm"] != "https://ghcr.io/token" || p["service"] != "ghcr.io" || p["scope"] != "repository:o/b:pull" {
		t.Fatalf("%s %v", s, p)
	}
}

func TestApplyWhiteoutsAndModes(t *testing.T) {
	root := t.TempDir()
	u := &Unpacker{Root: root}
	l1 := tarBytes(t, []entry{
		{name: "etc/", typ: tar.TypeDir},
		{name: "etc/a", typ: tar.TypeReg, body: "a"},
		{name: "etc/b", typ: tar.TypeReg, body: "b"},
		{name: "opt/", typ: tar.TypeDir},
		{name: "opt/old", typ: tar.TypeReg, body: "x"},
		{name: "ro/", typ: tar.TypeDir, mode: 0o555},
		{name: "ro/f", typ: tar.TypeReg, body: "f"},
		{name: "bin/", typ: tar.TypeDir},
		{name: "bin/sudo", typ: tar.TypeReg, body: "s", mode: 0o4755},
		{name: "bin/link", typ: tar.TypeSymlink, link: "sudo"},
		{name: "bin/hard", typ: tar.TypeLink, link: "bin/sudo"},
		{name: "dev/", typ: tar.TypeDir},
		{name: "dev/null", typ: tar.TypeChar},
	}, true)
	if _, err := u.Apply(bytes.NewReader(l1)); err != nil {
		t.Fatal(err)
	}
	l2 := tarBytes(t, []entry{
		{name: "etc/.wh.a", typ: tar.TypeReg},
		{name: "opt/.wh..wh..opq", typ: tar.TypeReg},
		{name: "opt/new", typ: tar.TypeReg, body: "n"},
		{name: "ro/g", typ: tar.TypeReg, body: "g"},
	}, false)
	st, err := u.Apply(bytes.NewReader(l2))
	if err != nil {
		t.Fatal(err)
	}
	u.Finish()
	if st.Whiteouts != 2 {
		t.Fatalf("whiteouts %d", st.Whiteouts)
	}
	if _, err := os.Stat(filepath.Join(root, "etc/a")); !os.IsNotExist(err) {
		t.Fatal("etc/a not removed")
	}
	if _, err := os.Stat(filepath.Join(root, "etc/b")); err != nil {
		t.Fatal("etc/b removed")
	}
	if _, err := os.Stat(filepath.Join(root, "opt/old")); !os.IsNotExist(err) {
		t.Fatal("opaque folder kept a lower file")
	}
	if _, err := os.Stat(filepath.Join(root, "opt/new")); err != nil {
		t.Fatal("opaque folder lost its own file")
	}
	if _, err := os.Stat(filepath.Join(root, "ro/g")); err != nil {
		t.Fatal("a 0555 folder of a lower layer refused a file")
	}
	fi, _ := os.Stat(filepath.Join(root, "ro"))
	if fi.Mode().Perm() != 0o555 {
		t.Fatalf("ro mode %v", fi.Mode())
	}
	fi, _ = os.Stat(filepath.Join(root, "bin/sudo"))
	if fi.Mode()&os.ModeSetuid == 0 {
		t.Fatal("setuid bit lost")
	}
	if l, _ := os.Readlink(filepath.Join(root, "bin/link")); l != "sudo" {
		t.Fatal("symlink")
	}
	a, _ := os.Stat(filepath.Join(root, "bin/hard"))
	if !os.SameFile(a, fi) {
		t.Fatal("hard link")
	}
	os.Chmod(filepath.Join(root, "ro"), 0o755)
}

func TestApplyRefusesEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	u := &Unpacker{Root: root}
	l := tarBytes(t, []entry{
		{name: "evil", typ: tar.TypeSymlink, link: outside},
		{name: "evil/pwned", typ: tar.TypeReg, body: "x"},
	}, false)
	if _, err := u.Apply(bytes.NewReader(l)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "pwned")); err == nil {
		t.Fatal("a symlinked parent wrote outside the root")
	}
	if _, err := os.Stat(filepath.Join(root, outside, "pwned")); err != nil {
		t.Fatal("the file should land inside the root")
	}
	l2 := tarBytes(t, []entry{{name: "../x", typ: tar.TypeReg, body: "x"}}, false)
	(&Unpacker{Root: root}).Apply(bytes.NewReader(l2))
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "x")); err == nil {
		t.Fatal("../ escaped")
	}
}

// fakeRegistry serves one multi-arch image behind a bearer token.
func fakeRegistry(t *testing.T, layers [][]byte) (*httptest.Server, string) {
	t.Helper()
	blobs := map[string][]byte{}
	var descs []Descriptor
	for _, l := range layers {
		d := digestOf(l)
		blobs[d] = l
		descs = append(descs, Descriptor{MediaType: "application/vnd.oci.image.layer.v1.tar+gzip", Digest: d, Size: int64(len(l))})
	}
	cfg, _ := json.Marshal(map[string]any{"architecture": "amd64", "os": "linux", "config": map[string]any{"Env": []string{"PATH=/usr/bin:/bin", "HOME=/root"}, "WorkingDir": "/root"}})
	blobs[digestOf(cfg)] = cfg
	man, _ := json.Marshal(map[string]any{"schemaVersion": 2, "mediaType": MediaOCIManifest, "config": Descriptor{MediaType: "application/vnd.oci.image.config.v1+json", Digest: digestOf(cfg), Size: int64(len(cfg))}, "layers": descs})
	armMan := []byte(`{"schemaVersion":2}`)
	idx, _ := json.Marshal(map[string]any{"schemaVersion": 2, "mediaType": MediaOCIIndex, "manifests": []Descriptor{
		{MediaType: MediaOCIManifest, Digest: digestOf(armMan), Size: int64(len(armMan)), Platform: &Platform{OS: "linux", Architecture: "arm64", Variant: "v8"}},
		{MediaType: MediaOCIManifest, Digest: digestOf(man), Size: int64(len(man)), Platform: &Platform{OS: "linux", Architecture: "amd64"}},
	}})
	manifests := map[string][]byte{"1": idx, digestOf(idx): idx, digestOf(man): man, digestOf(armMan): armMan}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			if r.URL.Query().Get("scope") != "repository:o/box:pull" {
				w.WriteHeader(400)
				return
			}
			w.Write([]byte(`{"token":"t0k"}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer t0k" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+srv.URL+`/token",service="test"`)
			w.WriteHeader(401)
			return
		}
		parts := strings.Split(r.URL.Path, "/")
		last := parts[len(parts)-1]
		switch parts[len(parts)-2] {
		case "manifests":
			if body, ok := manifests[last]; ok {
				var probe map[string]any
				json.Unmarshal(body, &probe)
				w.Header().Set("Content-Type", probe["mediaType"].(string))
				w.Write(body)
				return
			}
		case "blobs":
			if body, ok := blobs[last]; ok {
				w.Write(body)
				return
			}
		}
		w.WriteHeader(404)
	}))
	return srv, digestOf(idx)
}

func TestPullIndexWithToken(t *testing.T) {
	l1 := tarBytes(t, []entry{{name: "etc/", typ: tar.TypeDir}, {name: "etc/os-release", typ: tar.TypeReg, body: "ID=test\n"}}, true)
	l2 := tarBytes(t, []entry{{name: "etc/.wh.os-release", typ: tar.TypeReg}, {name: "etc/hi", typ: tar.TypeReg, body: "hi"}}, true)
	srv, idxDigest := fakeRegistry(t, [][]byte{l1, l2})
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "http://")
	host = strings.Replace(host, "127.0.0.1", "localhost", 1)
	ref, err := ParseRef(host + "/o/box:1")
	if err != nil {
		t.Fatal(err)
	}
	ref.Registry = strings.TrimPrefix(srv.URL, "http://")
	var seen, lastDone, lastTotal int64
	store := Store{Dir: t.TempDir(), Bytes: func(done, total int64) {
		if done < lastDone {
			t.Errorf("progress went back: %d after %d", done, lastDone)
		}
		seen++
		lastDone, lastTotal = done, total
	}}
	c := NewClient()
	img, id, err := store.Pull(context.Background(), c, ref, "x64", ApplyOptions{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := int64(len(l1) + len(l2)); seen < 2 || lastTotal != want || lastDone != want {
		t.Fatalf("progress: %d calls, ended at %d/%d, want %d", seen, lastDone, lastTotal, want)
	}
	store.Bytes = nil
	if img.Digest != idxDigest || img.Arch != "amd64" || len(img.Env) != 2 || img.WorkDir != "/root" {
		t.Fatalf("%+v", img)
	}
	root := store.RootFS(id)
	if b, _ := os.ReadFile(filepath.Join(root, "etc/hi")); string(b) != "hi" {
		t.Fatal("layer 2 missing")
	}
	if _, err := os.Stat(filepath.Join(root, "etc/os-release")); !os.IsNotExist(err) {
		t.Fatal("whiteout across layers")
	}
	// Second pull: found by tag without the network.
	srv.Close()
	img2, id2, err := store.Pull(context.Background(), c, ref, "amd64", ApplyOptions{}, nil)
	if err != nil || id2 != id || img2.Digest != idxDigest {
		t.Fatalf("cached: %v %s", err, id2)
	}
	// Pinned by digest.
	pinned := ref
	pinned.Digest = idxDigest
	if got, _ := store.Find(pinned, "amd64"); got == nil {
		t.Fatal("not found by digest")
	}
}

func TestPullRejectsBadBlob(t *testing.T) {
	l1 := tarBytes(t, []entry{{name: "a", typ: tar.TypeReg, body: "a"}}, true)
	srv, _ := fakeRegistry(t, [][]byte{l1})
	defer srv.Close()
	ref, _ := ParseRef("localhost:1/o/box:1")
	ref.Registry = strings.TrimPrefix(srv.URL, "http://")
	ref.Digest = "sha256:" + strings.Repeat("0", 64)
	_, _, err := (Store{Dir: t.TempDir()}).Pull(context.Background(), NewClient(), ref, "amd64", ApplyOptions{}, nil)
	if err == nil {
		t.Fatal("a wrong pinned digest was accepted")
	}
}

func TestImportDockerSave(t *testing.T) {
	layer := tarBytes(t, []entry{{name: "usr/", typ: tar.TypeDir}, {name: "usr/x", typ: tar.TypeReg, body: "x"}}, false)
	cfg := []byte(`{"architecture":"arm64","os":"linux","config":{"Env":["A=1"]}}`)
	man := []byte(`[{"Config":"cfg.json","RepoTags":["omnirush-ai/box-base:t"],"Layers":["l1/layer.tar"]}]`)
	archive := tarBytes(t, []entry{
		{name: "manifest.json", typ: tar.TypeReg, body: string(man)},
		{name: "cfg.json", typ: tar.TypeReg, body: string(cfg)},
		{name: "l1/layer.tar", typ: tar.TypeReg, body: string(layer)},
	}, false)
	file := filepath.Join(t.TempDir(), "img.tar")
	os.WriteFile(file, archive, 0o644)
	store := Store{Dir: t.TempDir()}
	img, id, err := store.Import(file, "", "amd64", ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if img.Digest != digestOf(cfg) || img.Arch != "arm64" || img.Env[0] != "A=1" {
		t.Fatalf("%+v", img)
	}
	if b, _ := os.ReadFile(filepath.Join(store.RootFS(id), "usr/x")); string(b) != "x" {
		t.Fatal("layer not applied")
	}
}

func TestImportRootfsTar(t *testing.T) {
	archive := tarBytes(t, []entry{{name: "./", typ: tar.TypeDir}, {name: "./etc/", typ: tar.TypeDir}, {name: "./etc/wsl.conf", typ: tar.TypeReg, body: "[interop]\n"}}, true)
	file := filepath.Join(t.TempDir(), "rootfs.tar.gz")
	os.WriteFile(file, archive, 0o644)
	store := Store{Dir: t.TempDir()}
	img, id, err := store.Import(file, "mars/wsl:1", "amd64", ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if img.Digest != digestOf(archive) || img.Ref != "mars/wsl:1" {
		t.Fatalf("%+v", img)
	}
	if _, err := os.Stat(filepath.Join(store.RootFS(id), "etc/wsl.conf")); err != nil {
		t.Fatal(err)
	}
}
