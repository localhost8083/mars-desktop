//go:build linux

// boxrun runs an Mars box with no container engine: the pinned image is
// pulled and unpacked by boxrun itself (no daemon, no root), and a project's
// box is that root filesystem under a per-project overlay upper layer, in
// its own user, mount, PID, IPC and UTS namespaces made by bubblewrap
// (unprivileged), or by unshare(1) when boxrun runs as root (inside the
// Mars WSL distro). The network is the host's, so installs work and
// boxd (the same helper the container boxes run) listens on the host's
// loopback. The upper layer stays on disk, so installs survive restarts.
//
//	boxrun probe   [--bwrap PATH] [--fuse-overlayfs PATH] [--dir DIR]   can boxes run here, and how
//	boxrun pull    --store DIR --ref REF [--arch A]                      download + unpack an image
//	boxrun import  --store DIR --file TAR [--ref REF] [--arch A]         unpack `docker save` / a rootfs tar
//	boxrun image   --store DIR --ref REF [--arch A]                      the unpacked image, if any
//	boxrun rmimage --store DIR --id ID                                   delete an unpacked image
//	boxrun up      --box DIR --store DIR --image ID --boxd FILE ...      start (or reuse) a project's box
//	boxrun stop    --box DIR                                             stop it (the upper layer stays)
//	boxrun rm      --box DIR                                             stop it and delete its layer
//	boxrun status  --box DIR                                             running or not, port
//	boxrun enter   --box DIR -- CMD...                                   run CMD inside (an interactive shell)
//
// Every command prints one JSON line on stdout.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"marsai.click/box/oci"
)

var version = "dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: boxrun probe|pull|import|image|up|stop|rm|status|enter|--version")
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "--version", "version":
		fmt.Println(version)
		return
	case "probe":
		err = cmdProbe(args)
	case "pull":
		err = cmdPull(args)
	case "import":
		err = cmdImport(args)
	case "image":
		err = cmdImage(args)
	case "rmimage":
		err = cmdRmImage(args)
	case "up":
		err = cmdUp(args)
	case "stop":
		err = cmdStop(args, false)
	case "rm":
		err = cmdStop(args, true)
	case "status":
		err = cmdStatus(args)
	case "enter":
		err = cmdEnter(args)
	case "init":
		// Inside the namespaces (internal): overlay, mounts, switch root, exec boxd.
		err = stageInit(args)
	case "probe-inner":
		probeInner(args)
		return
	case "rmtree":
		// Inside the namespaces (internal): delete what the user's own uid cannot (subuid owners).
		err = rmtreeInner(args)
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		emit(map[string]any{"ok": false, "error": err.Error()})
		os.Exit(1)
	}
}

func emit(v any) {
	data, _ := json.Marshal(v)
	fmt.Println(string(data))
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

// --- images -----------------------------------------------------------------

func cmdPull(args []string) error {
	fs := newFlags("pull")
	store := fs.String("store", "", "image store folder")
	refS := fs.String("ref", "", "image reference")
	arch := fs.String("arch", runtime.GOARCH, "architecture")
	timeout := fs.Duration("timeout", 60*time.Minute, "give up after")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *store == "" || *refS == "" {
		return errors.New("--store and --ref are needed")
	}
	if file, ok := archiveRef(*refS); ok {
		// docker-archive:<tar> / oci-archive:<tar>: a local image (a host kit, a box image not published yet).
		start := time.Now()
		s := oci.Store{Dir: *store}
		if img, id := s.FindArchive(*refS); img != nil {
			emit(map[string]any{"ok": true, "id": id, "digest": img.Digest, "config": img.Config, "arch": img.Arch, "ref": img.Ref, "ms": time.Since(start).Milliseconds()})
			return nil
		}
		img, id, err := s.Import(file, "", *arch, oci.ApplyOptions{Chown: os.Geteuid() == 0})
		if err != nil {
			return err
		}
		_ = s.RememberArchive(*refS, id)
		emit(map[string]any{"ok": true, "id": id, "digest": img.Digest, "config": img.Config, "arch": img.Arch, "ref": img.Ref, "ms": time.Since(start).Milliseconds()})
		return nil
	}
	ref, err := oci.ParseRef(*refS)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	start := time.Now()
	s := oci.Store{Dir: *store}
	// A progress line on stderr at most every 200 ms (and at the end of each
	// layer): {"progress":{"bytes":N,"total":M}}, read by the CLI's progress line.
	var last time.Time
	s.Bytes = func(done, total int64) {
		if now := time.Now(); now.Sub(last) >= 200*time.Millisecond || done == total {
			last = now
			fmt.Fprintf(os.Stderr, "{\"progress\":{\"bytes\":%d,\"total\":%d}}\n", done, total)
		}
	}
	img, id, err := s.Pull(ctx, oci.NewClient(), ref, *arch, oci.ApplyOptions{Chown: os.Geteuid() == 0}, func(i, n int, digest string, size int64) {
		fmt.Fprintf(os.Stderr, "layer %d/%d %s %d bytes\n", i, n, digest, size)
	})
	if err != nil {
		return err
	}
	emit(map[string]any{"ok": true, "id": id, "digest": img.Digest, "manifest": img.Manifest, "config": img.Config, "arch": img.Arch, "ref": img.Ref, "ms": time.Since(start).Milliseconds()})
	return nil
}

func cmdImport(args []string) error {
	fs := newFlags("import")
	store := fs.String("store", "", "image store folder")
	file := fs.String("file", "", "archive")
	refS := fs.String("ref", "", "reference to file it under")
	arch := fs.String("arch", runtime.GOARCH, "architecture")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *store == "" || *file == "" {
		return errors.New("--store and --file are needed")
	}
	start := time.Now()
	img, id, err := (oci.Store{Dir: *store}).Import(*file, *refS, *arch, oci.ApplyOptions{Chown: os.Geteuid() == 0})
	if err != nil {
		return err
	}
	emit(map[string]any{"ok": true, "id": id, "digest": img.Digest, "config": img.Config, "arch": img.Arch, "ref": img.Ref, "ms": time.Since(start).Milliseconds()})
	return nil
}

func cmdImage(args []string) error {
	fs := newFlags("image")
	store := fs.String("store", "", "image store folder")
	refS := fs.String("ref", "", "image reference")
	id := fs.String("id", "", "image id")
	arch := fs.String("arch", runtime.GOARCH, "architecture")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s := oci.Store{Dir: *store}
	var img *oci.Image
	found := *id
	if found != "" {
		img = s.Lookup(found)
	} else if _, ok := archiveRef(*refS); ok {
		img, found = s.FindArchive(*refS)
	} else {
		ref, err := oci.ParseRef(*refS)
		if err != nil {
			return err
		}
		img, found = s.Find(ref, *arch)
	}
	if img == nil {
		emit(map[string]any{"ok": true, "present": false})
		return nil
	}
	emit(map[string]any{"ok": true, "present": true, "id": found, "digest": img.Digest, "config": img.Config, "arch": img.Arch, "ref": img.Ref})
	return nil
}

// archiveRef reads docker-archive:<file> and oci-archive:<file>.
func archiveRef(ref string) (string, bool) {
	for _, p := range []string{"docker-archive:", "oci-archive:"} {
		if strings.HasPrefix(ref, p) && len(ref) > len(p) {
			return ref[len(p):], true
		}
	}
	return "", false
}

func cmdRmImage(args []string) error {
	fs := newFlags("rmimage")
	store := fs.String("store", "", "image store folder")
	id := fs.String("id", "", "image id")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *store == "" || *id == "" || strings.ContainsAny(*id, "/\\.") {
		return errors.New("--store and a plain --id are needed")
	}
	if err := removeTree(filepath.Join(*store, "images", *id)); err != nil {
		return err
	}
	emit(map[string]any{"ok": true, "removed": *id})
	return nil
}

// --- probe -------------------------------------------------------------------

func readSysctl(name string) *int {
	data, err := os.ReadFile("/proc/sys/" + strings.ReplaceAll(name, ".", "/"))
	if err != nil {
		return nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return nil
	}
	return &n
}

func kernelRelease() string {
	var u syscall.Utsname
	if syscall.Uname(&u) != nil {
		return ""
	}
	b := make([]byte, 0, len(u.Release))
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

// kernelAtLeast compares "6.8.0-139-generic" with major.minor.
func kernelAtLeast(release string, major, minor int) bool {
	num := func(s string) int {
		n := 0
		for _, c := range s {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		return n
	}
	parts := strings.SplitN(release, ".", 3)
	if len(parts) < 2 {
		return false
	}
	ma, mi := num(parts[0]), num(parts[1])
	return ma > major || (ma == major && mi >= minor)
}

func findBwrap(asked string) string {
	if asked != "" {
		if _, err := os.Stat(asked); err == nil {
			return asked
		}
	}
	if p, err := exec.LookPath("bwrap"); err == nil {
		return p
	}
	for _, p := range []string{"/usr/bin/bwrap", "/usr/local/bin/bwrap"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func findTool(asked, name string) string {
	if asked != "" {
		if _, err := os.Stat(asked); err == nil {
			return asked
		}
		return ""
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, d := range []string{"/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local/bin"} {
		p := filepath.Join(d, name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func bwrapVersion(bin string) string {
	out, err := exec.Command(bin, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "bubblewrap"))
}

// subIDs is the user's subordinate id range from /etc/subuid or /etc/subgid.
func subIDs(file string, name string, id int) (start, count int) {
	data, err := os.ReadFile(file)
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) != 3 || (f[0] != name && f[0] != strconv.Itoa(id)) {
			continue
		}
		s, e1 := strconv.Atoi(f[1])
		c, e2 := strconv.Atoi(f[2])
		if e1 == nil && e2 == nil && c > 0 {
			return s, c
		}
	}
	return 0, 0
}

func userName() string {
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	data, _ := os.ReadFile("/etc/passwd")
	uid := strconv.Itoa(os.Getuid())
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Split(line, ":")
		if len(f) > 2 && f[2] == uid {
			return f[0]
		}
	}
	return ""
}

// idMap is how box uids map to this machine's: "single" (the user is root
// inside, nothing else is mapped) or "subuid" (65536 ids from /etc/subuid
// through newuidmap, so apt/dpkg can own files as other users).
type idMap struct {
	Mode                 string
	UIDStart, UIDCount   int
	GIDStart, GIDCount   int
	NewUIDMap, NewGIDMap string
}

func detectIDMap(asked string) idMap {
	if asked == "single" || os.Geteuid() == 0 {
		return idMap{Mode: "single"}
	}
	nu, ng := findTool("", "newuidmap"), findTool("", "newgidmap")
	us, uc := subIDs("/etc/subuid", userName(), os.Getuid())
	gs, gc := subIDs("/etc/subgid", userName(), os.Getuid())
	if nu == "" || ng == "" || uc < 65536 || gc < 65536 {
		return idMap{Mode: "single"}
	}
	return idMap{Mode: "subuid", UIDStart: us, UIDCount: 65536, GIDStart: gs, GIDCount: 65536, NewUIDMap: nu, NewGIDMap: ng}
}

type probeResult struct {
	OK          bool   `json:"ok"`
	Launcher    string `json:"launcher,omitempty"`
	Bwrap       string `json:"bwrap,omitempty"`
	BwrapVer    string `json:"bwrap_version,omitempty"`
	Overlay     string `json:"overlay,omitempty"`
	IDMap       string `json:"idmap,omitempty"`
	Kernel      string `json:"kernel"`
	AppArmor    *int   `json:"apparmor_restrict_unprivileged_userns"`
	UsernsClone *int   `json:"unprivileged_userns_clone"`
	MaxUserNS   *int   `json:"max_user_namespaces"`
	Root        bool   `json:"root"`
	Reason      string `json:"reason,omitempty"`
	Code        string `json:"code,omitempty"`
	Detail      string `json:"detail,omitempty"`
	Ms          int64  `json:"ms"`
}

func cmdProbe(args []string) error {
	fs := newFlags("probe")
	bw := fs.String("bwrap", "", "bwrap to use")
	fuse := fs.String("fuse-overlayfs", "", "fuse-overlayfs to use")
	dir := fs.String("dir", os.TempDir(), "a folder on the disk boxes will use")
	if err := fs.Parse(args); err != nil {
		return err
	}
	emit(probe(*bw, *fuse, *dir))
	return nil
}

func probe(bwAsked, fuseAsked, dir string) probeResult {
	start := time.Now()
	r := probeResult{Kernel: kernelRelease(), AppArmor: readSysctl("kernel.apparmor_restrict_unprivileged_userns"), UsernsClone: readSysctl("kernel.unprivileged_userns_clone"), MaxUserNS: readSysctl("user.max_user_namespaces"), Root: os.Geteuid() == 0}
	defer func() { r.Ms = time.Since(start).Milliseconds() }()
	fail := func(code, reason, detail string) probeResult {
		r.OK, r.Code, r.Reason, r.Detail = false, code, reason, strings.TrimSpace(detail)
		r.Ms = time.Since(start).Milliseconds()
		return r
	}
	tmp, err := os.MkdirTemp(dir, ".boxrun-probe-")
	if err != nil {
		return fail("disk", "cannot write the box folder", err.Error())
	}
	defer removeTree(tmp)
	for _, d := range []string{"lower", "upper", "work", "merged"} {
		_ = os.MkdirAll(filepath.Join(tmp, d), 0o755)
	}
	_ = os.WriteFile(filepath.Join(tmp, "lower", "f"), []byte("x"), 0o644)
	self, _ := os.Executable()
	fuseBin := findTool(fuseAsked, "fuse-overlayfs")
	var cmd *exec.Cmd
	if r.Root {
		un := findTool("", "unshare")
		if un == "" {
			return fail("no_unshare", "unshare (util-linux) is missing", "")
		}
		r.Launcher = "unshare"
		cmd = exec.Command(un, "--mount", "--propagation", "private", "--", self, "probe-inner", tmp, fuseBin)
	} else {
		bin := findBwrap(bwAsked)
		if bin == "" {
			return fail("no_bwrap", "bubblewrap (bwrap) is not installed", "")
		}
		r.Launcher, r.Bwrap, r.BwrapVer = "bwrap", bin, bwrapVersion(bin)
		bargs := []string{"--unshare-user", "--uid", "0", "--gid", "0", "--unshare-pid", "--cap-add", "ALL",
			"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", tmp, tmp}
		if fuseBin != "" {
			bargs = append(bargs, "--dev-bind-try", "/dev/fuse", "/dev/fuse")
		}
		bargs = append(bargs, "--", self, "probe-inner", tmp, fuseBin)
		cmd = exec.Command(bin, bargs...)
	}
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	out, err := cmd.CombinedOutput()
	text := string(out)
	var inner struct {
		Overlay string `json:"overlay"`
		Error   string `json:"error"`
		UID     int    `json:"uid"`
	}
	jsonLine := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "{") {
			jsonLine = line
		}
	}
	if err != nil || jsonLine == "" || json.Unmarshal([]byte(jsonLine), &inner) != nil {
		return classify(r, text, fail)
	}
	if inner.Overlay == "none" || inner.Overlay == "" {
		if !kernelAtLeast(r.Kernel, 5, 11) {
			return fail("overlay", fmt.Sprintf("this kernel (%s) cannot mount overlayfs without root (5.11+ can) and fuse-overlayfs is not installed", r.Kernel), inner.Error)
		}
		return fail("overlay", "overlayfs does not mount in a user namespace here and fuse-overlayfs is not installed", inner.Error)
	}
	r.OK = true
	r.Overlay = inner.Overlay
	r.IDMap = detectIDMap("auto").Mode
	r.Ms = time.Since(start).Milliseconds()
	return r
}

// classify turns a failed namespace start into one line for the user.
func classify(r probeResult, text string, fail func(code, reason, detail string) probeResult) probeResult {
	low := strings.ToLower(text)
	// bwrap could not even create the namespace (clone refused). Ubuntu's AppArmor
	// rule lets that through and denies what comes after (the uid map), so this is
	// never AppArmor: a container's seccomp filter, or namespaces turned off.
	refused := strings.Contains(low, "no permissions to creat")
	switch {
	case refused && inContainer():
		return fail("container", "this runs in a container that does not allow user namespaces (its seccomp profile)", text)
	case !refused && r.AppArmor != nil && *r.AppArmor == 1:
		return fail("apparmor", "AppArmor blocks unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 23.10+)", text)
	case r.UsernsClone != nil && *r.UsernsClone == 0:
		return fail("userns_off", "unprivileged user namespaces are off (kernel.unprivileged_userns_clone=0)", text)
	case r.MaxUserNS != nil && *r.MaxUserNS == 0:
		return fail("userns_off", "user namespaces are off (user.max_user_namespaces=0)", text)
	case refused || strings.Contains(low, "setting up uid map") || strings.Contains(low, "uid_map") || strings.Contains(low, "operation not permitted") || strings.Contains(low, "permission denied"):
		return fail("userns_denied", "this system does not let unprivileged users create namespaces (a container or a hardened kernel)", text)
	}
	return fail("start", "bubblewrap could not start a namespace", text)
}

// inContainer: this process runs in a Docker/Podman (or similar) container.
var inContainer = func() bool {
	for _, f := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(f); err == nil {
			return true
		}
	}
	return os.Getenv("container") != ""
}

// probeInner runs inside the probe's namespaces: can overlayfs mount here?
func probeInner(args []string) {
	out := map[string]any{"uid": os.Getuid()}
	if len(args) < 1 {
		out["error"] = "no dir"
		emit(out)
		return
	}
	dir := args[0]
	fuse := ""
	if len(args) > 1 {
		fuse = args[1]
	}
	merged := filepath.Join(dir, "merged")
	mode, err := mountOverlay(filepath.Join(dir, "lower"), filepath.Join(dir, "upper"), filepath.Join(dir, "work"), merged, fuse)
	if err != nil {
		out["overlay"] = "none"
		out["error"] = err.Error()
		emit(out)
		return
	}
	// A write lands in the upper layer, a delete leaves a whiteout.
	_ = os.WriteFile(filepath.Join(merged, "g"), []byte("y"), 0o644)
	_ = os.Remove(filepath.Join(merged, "f"))
	_, errUp := os.Stat(filepath.Join(dir, "upper", "g"))
	_ = syscall.Unmount(merged, syscall.MNT_DETACH)
	if errUp != nil {
		out["overlay"] = "none"
		out["error"] = "upper layer not written"
	} else {
		out["overlay"] = mode
	}
	emit(out)
}

// --- the box -----------------------------------------------------------------

// spec is what `init` does inside the namespaces (written to <box>/spec.json).
type spec struct {
	Lower    string     `json:"lower"`
	Upper    string     `json:"upper"`
	Work     string     `json:"work"`
	Merged   string     `json:"merged"`
	Fuse     string     `json:"fuse,omitempty"`
	Boxd     string     `json:"boxd"`
	Resolv   string     `json:"resolv,omitempty"`
	Hosts    string     `json:"hosts,omitempty"`
	Binds    []bindSpec `json:"binds"`
	Env      []string   `json:"env"`
	Hostname string     `json:"hostname"`
	InitOut  string     `json:"init_out"`
	Root     bool       `json:"root"`                        // unshare as real root (WSL distro): mount /dev and /sys from the host
	NoKernel bool       `json:"no_kernel_overlay,omitempty"` // fuse-overlayfs only (a kernel without overlayfs in user namespaces, or a test of one)
	AptRoot  bool       `json:"apt_root"`
}

type bindSpec struct {
	Src string `json:"src"`
	Dst string `json:"dst"`
	RO  bool   `json:"ro,omitempty"`
}

type state struct {
	Pid      int    `json:"pid"`
	Port     int    `json:"port"`
	Launcher string `json:"launcher"`
	IDMap    string `json:"idmap"`
	Overlay  string `json:"overlay"`
	Image    string `json:"image"`
	Started  int64  `json:"started"`
	Version  string `json:"version"`
}

func readState(box string) *state {
	data, err := os.ReadFile(filepath.Join(box, "state.json"))
	if err != nil {
		return nil
	}
	var s state
	if json.Unmarshal(data, &s) != nil {
		return nil
	}
	return &s
}

func writeJSONFile(file string, v any) error {
	data, _ := json.MarshalIndent(v, "", "  ")
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// alive: the pid runs and is our launcher (not a reused pid).
func alive(s *state) bool {
	if s == nil || s.Pid <= 0 {
		return false
	}
	if syscall.Kill(s.Pid, 0) != nil {
		return false
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", s.Pid))
	if err != nil {
		return false
	}
	switch filepath.Base(strings.SplitN(string(cmdline), "\x00", 2)[0]) {
	case "bwrap", "unshare", "boxrun":
		return true
	}
	return false
}

func portOpen(port int) bool {
	if port <= 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func parseBind(v string) (bindSpec, error) {
	i := strings.LastIndex(v, "=/")
	if i <= 0 {
		return bindSpec{}, fmt.Errorf("bad bind %q (SRC=DST)", v)
	}
	src, _ := filepath.Abs(v[:i])
	return bindSpec{Src: src, Dst: filepath.Clean(v[i+1:])}, nil
}

func resolvFile() string {
	p, err := filepath.EvalSymlinks("/etc/resolv.conf")
	if err != nil {
		return ""
	}
	// systemd-resolved's stub (127.0.0.53) works: the network is the host's.
	return p
}

func cmdUp(args []string) error {
	fs := newFlags("up")
	box := fs.String("box", "", "the box's folder (upper layer, state)")
	store := fs.String("store", "", "image store folder")
	image := fs.String("image", "", "image id (boxrun image)")
	boxd := fs.String("boxd", "", "boxd binary")
	portFile := fs.String("port-file", "", "host path of the file boxd writes its port to")
	launcher := fs.String("launcher", "auto", "auto|bwrap|unshare")
	bwAsked := fs.String("bwrap", "", "bwrap to use")
	fuseAsked := fs.String("fuse-overlayfs", "", "fuse-overlayfs to use")
	idmapAsked := fs.String("idmap", "auto", "auto|single|subuid")
	foreground := fs.Bool("foreground", false, "stay attached (the WSL keeper): exit when stdin closes")
	timeout := fs.Duration("timeout", 30*time.Second, "wait this long for boxd")
	overlayMode := fs.String("overlay", "auto", "auto|fuse (fuse-overlayfs only)")
	var binds, roBinds, envs multi
	fs.Var(&binds, "bind", "SRC=DST (repeat)")
	fs.Var(&roBinds, "ro-bind", "SRC=DST read-only (repeat)")
	fs.Var(&envs, "env", "K=V for boxd (repeat)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *box == "" || *store == "" || *image == "" || *boxd == "" || *portFile == "" {
		return errors.New("--box, --store, --image, --boxd and --port-file are needed")
	}
	for _, p := range []*string{box, store, boxd, portFile} {
		*p, _ = filepath.Abs(*p)
	}
	start := time.Now()
	if s := readState(*box); alive(s) {
		if port := readPort(*portFile); port > 0 && portOpen(port) {
			emit(map[string]any{"ok": true, "reused": true, "pid": s.Pid, "port": port, "launcher": s.Launcher, "idmap": s.IDMap, "overlay": s.Overlay, "ms": time.Since(start).Milliseconds()})
			if *foreground {
				keep(nil)
			}
			return nil
		}
		killTree(s.Pid)
	}
	st := oci.Store{Dir: *store}
	img := st.Lookup(*image)
	if img == nil {
		return fmt.Errorf("image %s is not unpacked", *image)
	}
	for _, d := range []string{"upper", "work"} {
		if err := os.MkdirAll(filepath.Join(*box, d), 0o755); err != nil {
			return err
		}
	}
	_ = os.Remove(*portFile)
	root := os.Geteuid() == 0
	mode := *launcher
	if mode == "auto" {
		mode = "bwrap"
		if root {
			mode = "unshare"
		}
	}
	ids := detectIDMap(*idmapAsked)
	if *idmapAsked == "subuid" && ids.Mode != "subuid" {
		return errors.New("no subordinate ids for this user (newuidmap, /etc/subuid)")
	}
	var bs []bindSpec
	for i, v := range append(append([]string{}, binds...), roBinds...) {
		b, err := parseBind(v)
		if err != nil {
			return err
		}
		b.RO = i >= len(binds)
		bs = append(bs, b)
	}
	self, _ := os.Executable()
	fuseBin := findTool(*fuseAsked, "fuse-overlayfs")
	env := append([]string{}, img.Env...)
	if !hasKey(env, "PATH") {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	env = append(env, envs...)
	sp := spec{Hostname: "mars-box", Env: env, AptRoot: ids.Mode == "single" && !root, NoKernel: *overlayMode == "fuse"}
	if sp.NoKernel && fuseBin == "" {
		return errors.New("--overlay fuse: fuse-overlayfs is not installed")
	}
	// /etc/hosts: this machine's (the network is shared) plus the box's own name, as a
	// container runtime writes it (sudo looks its host name up).
	hostsData, _ := os.ReadFile("/etc/hosts")
	hostsText := strings.TrimRight(string(hostsData), "\n") + "\n127.0.1.1\tmars-box\n"
	if err := os.WriteFile(filepath.Join(*box, "hosts"), []byte(hostsText), 0o644); err != nil {
		return err
	}
	var cmd *exec.Cmd
	if mode == "unshare" {
		un := findTool("", "unshare")
		if un == "" {
			return errors.New("unshare (util-linux) is missing")
		}
		sp.Lower, sp.Upper, sp.Work = st.RootFS(*image), filepath.Join(*box, "upper"), filepath.Join(*box, "work")
		sp.Merged = filepath.Join(*box, "merged")
		_ = os.MkdirAll(sp.Merged, 0o755)
		sp.Fuse, sp.Boxd, sp.Resolv, sp.Hosts = fuseBin, *boxd, resolvFile(), filepath.Join(*box, "hosts")
		sp.Binds, sp.InitOut, sp.Root = bs, filepath.Join(*box, "init.json"), true
		if err := writeJSONFile(filepath.Join(*box, "spec.json"), sp); err != nil {
			return err
		}
		cmd = exec.Command(un, "--mount", "--pid", "--fork", "--ipc", "--uts", "--propagation", "private", "--kill-child", "--", self, "init", filepath.Join(*box, "spec.json"))
	} else {
		bin := findBwrap(*bwAsked)
		if bin == "" {
			return errors.New("bubblewrap (bwrap) is not installed")
		}
		sp.Lower, sp.Upper, sp.Work, sp.Merged = "/.omni/lower", "/.omni/box/upper", "/.omni/box/work", "/.omni/merged"
		sp.Boxd, sp.InitOut = "/.omni/boxd", "/.omni/box/init.json"
		bargs := []string{"--unshare-user", "--uid", "0", "--gid", "0", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
			"--hostname", "mars-box", "--cap-add", "ALL", "--new-session",
			"--dev", "/dev", "--proc", "/proc", "--ro-bind", "/sys", "/sys",
			"--dir", "/.omni/merged",
			"--ro-bind", st.RootFS(*image), "/.omni/lower",
			"--bind", *box, "/.omni/box",
			"--ro-bind", self, "/.omni/boxrun",
			"--ro-bind", *boxd, "/.omni/boxd",
		}
		if ids.Mode == "subuid" {
			bargs = append(bargs, "--userns-block-fd", "4", "--info-fd", "3")
		}
		if r := resolvFile(); r != "" {
			bargs = append(bargs, "--ro-bind-try", r, "/.omni/resolv.conf")
			sp.Resolv = "/.omni/resolv.conf"
		}
		sp.Hosts = "/.omni/box/hosts"
		if fuseBin != "" {
			// fuse-overlayfs is a dynamic program: the host's libraries go in for the setup only
			// (the root switch leaves them behind; the daemon keeps what it opened).
			bargs = append(bargs, "--dev-bind-try", "/dev/fuse", "/dev/fuse", "--ro-bind", fuseBin, "/.omni/fuse-overlayfs")
			for _, d := range []string{"/usr", "/lib", "/lib64", "/lib32", "/etc/ld.so.cache"} {
				bargs = append(bargs, "--ro-bind-try", d, d)
			}
			sp.Fuse = "/.omni/fuse-overlayfs"
		}
		for i, b := range bs {
			staged := fmt.Sprintf("/.omni/b/%d", i)
			flagName := "--bind"
			if b.RO {
				flagName = "--ro-bind"
			}
			bargs = append(bargs, flagName, b.Src, staged)
			sp.Binds = append(sp.Binds, bindSpec{Src: staged, Dst: b.Dst, RO: b.RO})
		}
		if err := writeJSONFile(filepath.Join(*box, "spec.json"), sp); err != nil {
			return err
		}
		bargs = append(bargs, "--chdir", "/", "--", "/.omni/boxrun", "init", "/.omni/box/spec.json")
		cmd = exec.Command(bin, bargs...)
	}
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	logFile, err := os.OpenFile(filepath.Join(*box, "boxd.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	var infoR, blockW *os.File
	if mode == "bwrap" && ids.Mode == "subuid" {
		ir, iw, err := os.Pipe()
		if err != nil {
			return err
		}
		br, bw, err := os.Pipe()
		if err != nil {
			return err
		}
		cmd.ExtraFiles = []*os.File{iw, br}
		infoR, blockW = ir, bw
		defer ir.Close()
		defer bw.Close()
		defer iw.Close()
		defer br.Close()
	}
	_ = os.Remove(filepath.Join(*box, "init.json"))
	if err := cmd.Start(); err != nil {
		return err
	}
	if infoR != nil {
		cmd.ExtraFiles[0].Close()
		cmd.ExtraFiles[1].Close()
		if err := mapIDs(infoR, blockW, ids); err != nil {
			killTree(cmd.Process.Pid)
			return fmt.Errorf("subordinate ids: %w", err)
		}
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.Now().Add(*timeout)
	port := 0
	for time.Now().Before(deadline) {
		if port = readPort(*portFile); port > 0 && portOpen(port) {
			break
		}
		port = 0
		select {
		case err := <-exited:
			return fmt.Errorf("the box exited at start (%v): %s", err, tail(filepath.Join(*box, "boxd.log"), 600))
		case <-time.After(15 * time.Millisecond):
		}
	}
	if port == 0 {
		killTree(cmd.Process.Pid)
		return fmt.Errorf("boxd did not answer in %v: %s", *timeout, tail(filepath.Join(*box, "boxd.log"), 600))
	}
	var initInfo struct {
		Overlay string `json:"overlay"`
	}
	if data, err := os.ReadFile(filepath.Join(*box, "init.json")); err == nil {
		_ = json.Unmarshal(data, &initInfo)
	}
	s := state{Pid: cmd.Process.Pid, Port: port, Launcher: mode, IDMap: ids.Mode, Overlay: initInfo.Overlay, Image: *image, Started: time.Now().Unix(), Version: version}
	_ = writeJSONFile(filepath.Join(*box, "state.json"), s)
	emit(map[string]any{"ok": true, "reused": false, "pid": s.Pid, "port": port, "launcher": mode, "idmap": ids.Mode, "overlay": s.Overlay, "ms": time.Since(start).Milliseconds()})
	if *foreground {
		keep(func() { killTree(cmd.Process.Pid) })
		return nil
	}
	_ = cmd.Process.Release()
	return nil
}

// keep holds the WSL keeper attached until stdin closes or a signal comes
// (wsl.exe ended): the distro stays up while a session uses its box.
func keep(onEnd func()) {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 256)
		for {
			if _, err := os.Stdin.Read(buf); err != nil {
				close(done)
				return
			}
		}
	}()
	select {
	case <-done:
	case <-sigs:
	}
	// The box itself keeps running until boxd's idle limit: another
	// session may still use it. Only a keeper's own box with no other
	// keeper would be stopped here, which `onEnd` leaves to boxd's idle exit.
	_ = onEnd
}

func hasKey(env []string, key string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			return true
		}
	}
	return false
}

func readPort(file string) int {
	data, err := os.ReadFile(file)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return n
}

func tail(file string, max int) string {
	data, _ := os.ReadFile(file)
	s := strings.TrimSpace(string(data))
	if len(s) > max {
		s = s[len(s)-max:]
	}
	return strings.ReplaceAll(s, "\n", " | ")
}

// mapIDs runs newuidmap/newgidmap for bwrap's child, then lets it go on.
func mapIDs(info *os.File, block *os.File, ids idMap) error {
	dec := json.NewDecoder(info)
	var msg struct {
		Pid int `json:"child-pid"`
	}
	done := make(chan error, 1)
	go func() { done <- dec.Decode(&msg) }()
	select {
	case err := <-done:
		if err != nil {
			return err
		}
	case <-time.After(10 * time.Second):
		return errors.New("bwrap did not report its child")
	}
	pid := strconv.Itoa(msg.Pid)
	uid, gid := strconv.Itoa(os.Getuid()), strconv.Itoa(os.Getgid())
	if out, err := exec.Command(ids.NewUIDMap, pid, "0", uid, "1", "1", strconv.Itoa(ids.UIDStart), strconv.Itoa(ids.UIDCount-1)).CombinedOutput(); err != nil {
		return fmt.Errorf("newuidmap: %v %s", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command(ids.NewGIDMap, pid, "0", gid, "1", "1", strconv.Itoa(ids.GIDStart), strconv.Itoa(ids.GIDCount-1)).CombinedOutput(); err != nil {
		return fmt.Errorf("newgidmap: %v %s", err, strings.TrimSpace(string(out)))
	}
	_, err := block.Write([]byte{1})
	return err
}

// killTree kills a process and everything below it, deepest first.
func killTree(pid int) {
	children := map[int][]int{}
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		p, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		s := string(data)
		i := strings.LastIndex(s, ")")
		if i < 0 {
			continue
		}
		f := strings.Fields(s[i+1:])
		if len(f) < 2 {
			continue
		}
		pp, _ := strconv.Atoi(f[1])
		children[pp] = append(children[pp], p)
	}
	var order []int
	var visit func(int)
	visit = func(p int) {
		for _, c := range children[p] {
			visit(c)
		}
		order = append(order, p)
	}
	visit(pid)
	for _, p := range order {
		_ = syscall.Kill(p, syscall.SIGKILL)
	}
	for i := 0; i < 100 && syscall.Kill(pid, 0) == nil; i++ {
		var ws syscall.WaitStatus
		_, _ = syscall.Wait4(pid, &ws, syscall.WNOHANG, nil)
		time.Sleep(10 * time.Millisecond)
	}
}

func cmdStop(args []string, remove bool) error {
	fs := newFlags("stop")
	box := fs.String("box", "", "the box's folder")
	bwAsked := fs.String("bwrap", "", "bwrap to use")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *box == "" {
		return errors.New("--box is needed")
	}
	*box, _ = filepath.Abs(*box)
	s := readState(*box)
	wasRunning := alive(s)
	if wasRunning {
		killTree(s.Pid)
	}
	_ = os.Remove(filepath.Join(*box, "state.json"))
	if remove {
		if err := removeTree(*box); err != nil {
			// Files owned by subordinate ids: delete them from inside a namespace that maps them.
			if err2 := rmtreeViaNamespace(*box, *bwAsked); err2 != nil {
				return fmt.Errorf("%v; %v", err, err2)
			}
			if err := removeTree(*box); err != nil {
				return err
			}
		}
	}
	emit(map[string]any{"ok": true, "was_running": wasRunning, "removed": remove})
	return nil
}

func rmtreeViaNamespace(box, bwAsked string) error {
	ids := detectIDMap("auto")
	bin := findBwrap(bwAsked)
	if ids.Mode != "subuid" || bin == "" {
		return errors.New("cannot remove files owned by other ids")
	}
	self, _ := os.Executable()
	cmd := exec.Command(bin, "--unshare-user", "--uid", "0", "--gid", "0", "--cap-add", "ALL", "--userns-block-fd", "4", "--info-fd", "3",
		"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", box, box, "--", self, "rmtree", box)
	ir, iw, _ := os.Pipe()
	br, bw, _ := os.Pipe()
	cmd.ExtraFiles = []*os.File{iw, br}
	if err := cmd.Start(); err != nil {
		return err
	}
	iw.Close()
	br.Close()
	if err := mapIDs(ir, bw, ids); err != nil {
		killTree(cmd.Process.Pid)
		return err
	}
	ir.Close()
	bw.Close()
	return cmd.Wait()
}

func rmtreeInner(args []string) error {
	if len(args) < 1 {
		return errors.New("no folder")
	}
	entries, _ := os.ReadDir(args[0])
	for _, e := range entries {
		if err := removeTree(filepath.Join(args[0], e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func removeTree(p string) error {
	// WalkDir calls back before it reads a folder, so an unreadable one (overlayfs leaves
	// work/work as d---------) is made readable first and its contents are reached too.
	_ = filepath.WalkDir(p, func(q string, d fs.DirEntry, err error) error {
		if d != nil && d.IsDir() {
			if info, e := d.Info(); e == nil && info.Mode().Perm()&0o700 != 0o700 {
				_ = os.Chmod(q, info.Mode().Perm()|0o700)
			}
		}
		return nil
	})
	return os.RemoveAll(p)
}

func cmdStatus(args []string) error {
	fs := newFlags("status")
	box := fs.String("box", "", "the box's folder")
	portFile := fs.String("port-file", "", "boxd's port file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s := readState(*box)
	running := alive(s)
	port := 0
	if running && *portFile != "" {
		port = readPort(*portFile)
	}
	out := map[string]any{"ok": true, "running": running, "port": port, "upper_bytes": dirBytes(filepath.Join(*box, "upper"))}
	if s != nil {
		out["pid"], out["launcher"], out["idmap"], out["overlay"], out["image"] = s.Pid, s.Launcher, s.IDMap, s.Overlay, s.Image
	}
	emit(out)
	return nil
}

func dirBytes(dir string) int64 {
	var n int64
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			n += fi.Size()
		}
		return nil
	})
	return n
}

// cmdEnter runs a command inside a running box (an interactive shell for
// `mars sandbox shell`) with nsenter: the box's user (when bwrap made
// one), mount and PID namespaces, and its root.
func cmdEnter(args []string) error {
	fs := newFlags("enter")
	box := fs.String("box", "", "the box's folder")
	wd := fs.String("wd", "/", "working folder inside")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) == 0 {
		rest = []string{"/bin/bash", "-l"}
	}
	s := readState(*box)
	if !alive(s) {
		return errors.New("the box is not running")
	}
	target := innermost(s.Pid)
	ns := findTool("", "nsenter")
	if ns == "" {
		return errors.New("nsenter (util-linux) is missing")
	}
	nargs := []string{"-t", strconv.Itoa(target), "-m", "-p", "-u", "-i"}
	if s.Launcher == "bwrap" {
		nargs = append(nargs, "-U", "--preserve-credentials=no")
	}
	nargs = append(nargs, "-r", "-w"+*wd, "--")
	nargs = append(nargs, rest...)
	// --preserve-credentials=no is not an option of every nsenter: drop it.
	clean := []string{}
	for _, a := range nargs {
		if a != "--preserve-credentials=no" {
			clean = append(clean, a)
		}
	}
	return syscall.Exec(ns, append([]string{"nsenter"}, clean...), os.Environ())
}

// innermost is the deepest descendant (boxd runs at the bottom of bwrap's chain).
func innermost(pid int) int {
	for i := 0; i < 8; i++ {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/children", pid, pid))
		if err != nil {
			return pid
		}
		f := strings.Fields(string(data))
		if len(f) == 0 {
			return pid
		}
		next, _ := strconv.Atoi(f[0])
		if next <= 0 {
			return pid
		}
		pid = next
		if comm, _ := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid)); strings.TrimSpace(string(comm)) == "boxd" {
			return pid
		}
	}
	return pid
}
