package oci

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Media types the boxes use.
const (
	MediaOCIIndex      = "application/vnd.oci.image.index.v1+json"
	MediaDockerList    = "application/vnd.docker.distribution.manifest.list.v2+json"
	MediaOCIManifest   = "application/vnd.oci.image.manifest.v1+json"
	MediaDockerSchema2 = "application/vnd.docker.distribution.manifest.v2+json"
)

// Descriptor points at a blob or manifest.
type Descriptor struct {
	MediaType string    `json:"mediaType"`
	Digest    string    `json:"digest"`
	Size      int64     `json:"size"`
	Platform  *Platform `json:"platform,omitempty"`
}

// Platform of an image (linux/amd64, linux/arm64/v8).
type Platform struct {
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Variant      string `json:"variant,omitempty"`
}

type manifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType"`
	Config        Descriptor   `json:"config"`
	Layers        []Descriptor `json:"layers"`
	Manifests     []Descriptor `json:"manifests"`
}

// Config is the part of an image config a box needs.
type Config struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	Config       struct {
		Env        []string          `json:"Env"`
		WorkingDir string            `json:"WorkingDir"`
		User       string            `json:"User"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
		Labels     map[string]string `json:"Labels"`
	} `json:"config"`
}

// Image is a resolved image: what to download, and what it was resolved from.
type Image struct {
	Ref      string            `json:"ref"`
	Digest   string            `json:"digest"`   // the pinned / top-level digest (index or manifest)
	Manifest string            `json:"manifest"` // the platform manifest's digest
	Config   string            `json:"config"`   // the config blob's digest (the image id)
	Arch     string            `json:"arch"`
	Layers   []Descriptor      `json:"layers"`
	Env      []string          `json:"env"`
	WorkDir  string            `json:"workdir,omitempty"`
	User     string            `json:"user,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
}

// Client talks to registries (anonymous; MARS_BOX_REGISTRY_AUTH=user:token
// for a private one).
type Client struct {
	HTTP      *http.Client
	Auth      string
	UserAgent string

	mu     sync.Mutex
	tokens map[string]string
}

// NewClient with the defaults the CLI uses.
func NewClient() *Client {
	return &Client{
		HTTP:      &http.Client{Timeout: 0, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 60 * time.Second, IdleConnTimeout: 30 * time.Second}},
		Auth:      os.Getenv("MARS_BOX_REGISTRY_AUTH"),
		UserAgent: "mars-boxrun",
	}
}

func (c *Client) base(ref Ref) string {
	scheme := "https"
	if ref.Plain() {
		scheme = "http"
	}
	return scheme + "://" + ref.Registry + "/v2/" + ref.Repo
}

// do sends a GET, answering a Bearer challenge once.
func (c *Client) do(ctx context.Context, ref Ref, u string, accept []string) (*http.Response, error) {
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		if len(accept) > 0 {
			req.Header.Set("Accept", strings.Join(accept, ", "))
		}
		req.Header.Set("User-Agent", c.UserAgent)
		c.mu.Lock()
		tok := c.tokens[ref.Registry+"/"+ref.Repo]
		c.mu.Unlock()
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			challenge := resp.Header.Get("WWW-Authenticate")
			resp.Body.Close()
			tok, err := c.token(ctx, ref, challenge)
			if err != nil {
				return nil, err
			}
			c.mu.Lock()
			if c.tokens == nil {
				c.tokens = map[string]string{}
			}
			c.tokens[ref.Registry+"/"+ref.Repo] = tok
			c.mu.Unlock()
			continue
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			resp.Body.Close()
			return nil, fmt.Errorf("%s: HTTP %d %s", redactURL(u), resp.StatusCode, strings.TrimSpace(string(body)))
		}
		return resp, nil
	}
	return nil, errors.New("registry refused the token")
}

func redactURL(u string) string {
	if p, err := url.Parse(u); err == nil {
		p.RawQuery = ""
		return p.String()
	}
	return u
}

// ParseChallenge reads `Bearer realm="...",service="...",scope="..."`.
func ParseChallenge(h string) (scheme string, params map[string]string) {
	params = map[string]string{}
	h = strings.TrimSpace(h)
	if i := strings.IndexByte(h, ' '); i > 0 {
		scheme, h = strings.ToLower(h[:i]), h[i+1:]
	} else {
		return strings.ToLower(h), params
	}
	for h != "" {
		h = strings.TrimLeft(h, " ,")
		eq := strings.IndexByte(h, '=')
		if eq <= 0 {
			break
		}
		key := strings.ToLower(strings.TrimSpace(h[:eq]))
		h = h[eq+1:]
		var val string
		if strings.HasPrefix(h, `"`) {
			end := strings.IndexByte(h[1:], '"')
			if end < 0 {
				val, h = h[1:], ""
			} else {
				val, h = h[1:1+end], h[2+end:]
			}
		} else {
			end := strings.IndexByte(h, ',')
			if end < 0 {
				val, h = h, ""
			} else {
				val, h = h[:end], h[end:]
			}
		}
		params[key] = val
	}
	return scheme, params
}

func (c *Client) token(ctx context.Context, ref Ref, challenge string) (string, error) {
	scheme, p := ParseChallenge(challenge)
	if scheme != "bearer" || p["realm"] == "" {
		return "", fmt.Errorf("registry wants %q auth", scheme)
	}
	u, err := url.Parse(p["realm"])
	if err != nil {
		return "", err
	}
	if u.Scheme != "https" && !ref.Plain() {
		return "", errors.New("registry token realm is not https")
	}
	q := u.Query()
	if p["service"] != "" {
		q.Set("service", p["service"])
	}
	scope := p["scope"]
	if scope == "" {
		scope = "repository:" + ref.Repo + ":pull"
	}
	q.Set("scope", scope)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", c.UserAgent)
	if c.Auth != "" {
		if user, pass, ok := strings.Cut(c.Auth, ":"); ok {
			req.SetBasicAuth(user, pass)
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry token: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", err
	}
	if body.Token != "" {
		return body.Token, nil
	}
	if body.AccessToken != "" {
		return body.AccessToken, nil
	}
	return "", errors.New("registry token: empty")
}

func (c *Client) getManifest(ctx context.Context, ref Ref, reference string) ([]byte, string, string, error) {
	resp, err := c.do(ctx, ref, c.base(ref)+"/manifests/"+reference, []string{MediaOCIIndex, MediaDockerList, MediaOCIManifest, MediaDockerSchema2})
	if err != nil {
		return nil, "", "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, "", "", err
	}
	sum := sha256.Sum256(body)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	if strings.HasPrefix(reference, "sha256:") && reference != digest {
		return nil, "", "", fmt.Errorf("manifest digest mismatch: asked %s, got %s", reference, digest)
	}
	mt := resp.Header.Get("Content-Type")
	if i := strings.IndexByte(mt, ';'); i >= 0 {
		mt = mt[:i]
	}
	return body, digest, strings.TrimSpace(mt), nil
}

// ArchOf maps Node/Go arch names to OCI ones.
func ArchOf(arch string) string {
	switch arch {
	case "x64", "x86_64", "amd64":
		return "amd64"
	case "arm64", "aarch64":
		return "arm64"
	}
	return arch
}

// PickPlatform chooses a manifest of an index for linux/<arch>.
func PickPlatform(list []Descriptor, arch string) (Descriptor, error) {
	arch = ArchOf(arch)
	for _, d := range list {
		if d.Platform == nil || d.Platform.OS != "linux" || d.Platform.Architecture != arch {
			continue
		}
		if arch == "arm64" && d.Platform.Variant != "" && d.Platform.Variant != "v8" {
			continue
		}
		return d, nil
	}
	have := []string{}
	for _, d := range list {
		if d.Platform != nil {
			have = append(have, d.Platform.OS+"/"+d.Platform.Architecture)
		}
	}
	return Descriptor{}, fmt.Errorf("no linux/%s image (has %s)", arch, strings.Join(have, ", "))
}

// Resolve reads the manifests and config of ref for linux/arch.
func (c *Client) Resolve(ctx context.Context, ref Ref, arch string) (*Image, error) {
	body, digest, mt, err := c.getManifest(ctx, ref, ref.Reference())
	if err != nil {
		return nil, err
	}
	var m manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	if mt == "" {
		mt = m.MediaType
	}
	img := &Image{Ref: ref.String(), Digest: digest, Manifest: digest}
	if mt == MediaOCIIndex || mt == MediaDockerList || len(m.Manifests) > 0 {
		pick, err := PickPlatform(m.Manifests, arch)
		if err != nil {
			return nil, err
		}
		body, mdigest, _, err := c.getManifest(ctx, ref, pick.Digest)
		if err != nil {
			return nil, err
		}
		m = manifest{}
		if err := json.Unmarshal(body, &m); err != nil {
			return nil, fmt.Errorf("manifest: %w", err)
		}
		img.Manifest = mdigest
	}
	if m.SchemaVersion != 2 || m.Config.Digest == "" {
		return nil, errors.New("unsupported manifest (schema 2 only)")
	}
	cfgBytes, err := c.blobBytes(ctx, ref, m.Config.Digest, 8<<20)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if err := fillConfig(img, cfgBytes, m.Config.Digest); err != nil {
		return nil, err
	}
	img.Layers = m.Layers
	for _, l := range img.Layers {
		if _, err := LayerCompression(l.MediaType); err != nil {
			return nil, err
		}
	}
	return img, nil
}

func fillConfig(img *Image, cfgBytes []byte, digest string) error {
	var cfg Config
	if err := json.Unmarshal(cfgBytes, &cfg); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if cfg.OS != "" && cfg.OS != "linux" {
		return fmt.Errorf("image is for %s, not linux", cfg.OS)
	}
	img.Config = digest
	img.Arch = cfg.Architecture
	img.Env = cfg.Config.Env
	img.WorkDir = cfg.Config.WorkingDir
	img.User = cfg.Config.User
	img.Labels = cfg.Config.Labels
	return nil
}

// LayerCompression says how a layer is stored: "gzip" or "" (plain tar).
func LayerCompression(mediaType string) (string, error) {
	switch {
	case strings.HasSuffix(mediaType, "+gzip") || strings.HasSuffix(mediaType, ".tar.gzip"):
		return "gzip", nil
	case strings.HasSuffix(mediaType, "+zstd"):
		return "", errors.New("zstd image layers are not supported yet")
	case strings.HasSuffix(mediaType, ".tar") || strings.HasSuffix(mediaType, "layer.v1.tar") || mediaType == "":
		return "", nil
	case strings.Contains(mediaType, "foreign") || strings.Contains(mediaType, "nondistributable"):
		return "", fmt.Errorf("foreign layer %s", mediaType)
	}
	return "", fmt.Errorf("unknown layer type %s", mediaType)
}

func (c *Client) blobBytes(ctx context.Context, ref Ref, digest string, max int64) ([]byte, error) {
	rc, err := c.OpenBlob(ctx, ref, digest)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, max))
	if err != nil {
		return nil, err
	}
	return data, rc.Close()
}

// OpenBlob streams a blob; Close reports a digest mismatch once it was read to the end.
func (c *Client) OpenBlob(ctx context.Context, ref Ref, digest string) (io.ReadCloser, error) {
	if !ValidDigest(digest) {
		return nil, fmt.Errorf("bad digest %q", digest)
	}
	resp, err := c.do(ctx, ref, c.base(ref)+"/blobs/"+digest, nil)
	if err != nil {
		return nil, err
	}
	return NewVerifier(resp.Body, digest), nil
}

// Verifier hashes what is read; Close (or a read to EOF) checks the digest.
type Verifier struct {
	r      io.ReadCloser
	want   string
	h      hashWriter
	eof    bool
	closed bool
}

type hashWriter interface {
	io.Writer
	Sum([]byte) []byte
}

// NewVerifier wraps r.
func NewVerifier(r io.ReadCloser, digest string) *Verifier {
	return &Verifier{r: r, want: digest, h: sha256.New()}
}

func (v *Verifier) Read(p []byte) (int, error) {
	n, err := v.r.Read(p)
	if n > 0 {
		v.h.Write(p[:n])
	}
	if errors.Is(err, io.EOF) {
		v.eof = true
		if got := "sha256:" + hex.EncodeToString(v.h.Sum(nil)); got != v.want {
			return n, fmt.Errorf("digest mismatch: want %s, got %s", v.want, got)
		}
	}
	return n, err
}

// Close checks the digest when the blob was read to the end.
func (v *Verifier) Close() error {
	if v.closed {
		return nil
	}
	v.closed = true
	err := v.r.Close()
	if !v.eof {
		return err
	}
	if got := "sha256:" + hex.EncodeToString(v.h.Sum(nil)); got != v.want {
		return fmt.Errorf("digest mismatch: want %s, got %s", v.want, got)
	}
	return err
}
