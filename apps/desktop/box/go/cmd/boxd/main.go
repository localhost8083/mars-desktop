//go:build linux

// boxd runs inside an Mars box (one persistent Linux container per
// project). It executes the agent's shell commands for the host-side shell
// client (boxsh) over one TCP connection per command, so a tool call costs a
// fork/exec instead of a `docker exec` round trip, and it reads the files a
// turn changed for the per-turn snapshot (stat + tar).
//
// Configuration (environment, removed before any command runs):
//
//	BOXD_TOKEN   shared secret; every request must carry it
//	BOXD_LISTEN  address to listen on (default 0.0.0.0:7777)
//	BOXD_UID, BOXD_GID  who commands run as (default 0:0)
//	BOXD_HOME    HOME for commands (default /root)
//	BOXD_ROOT    the project folder inside (fallback working directory)
//	BOXD_PATH    folders put in front of PATH (the package-manager wrappers)
//	BOXD_ENV_FILE  KEY=VALUE lines read before each command (host-written)
//	BOXD_SHELL   shell for commands (default /bin/bash, else /bin/sh)
//	BOXD_PORT_FILE  where to write the port it listens on (BOXD_LISTEN may end in :0)
//	BOXD_IDLE_EXIT  minutes with no request after which it exits (0: never; the
//	                bubblewrap and WSL boxes, which have no engine to keep them)
package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"encoding/gob"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"io/fs"
	"os/exec"
	"path/filepath"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"marsai.click/box/proto"
)

var version = "dev"

type config struct {
	token   string
	listen  string
	uid     int
	gid     int
	home    string
	root    string
	pathPre string
	envFile string
	shell   string
	portFile string
	idle    time.Duration
	baseEnv []string
}

// snapshotGate lets a snapshot read the files with no new command starting
// meanwhile. Both waits are bounded: a command that never ends (a server in
// the foreground) cannot hold a snapshot, and a snapshot cannot hold
// commands for long.
type snapshotGate struct {
	mu      sync.Mutex
	running int
	snap    bool
}

var gate snapshotGate

// enter waits (up to max) for a snapshot to end, then counts a command in.
func (g *snapshotGate) enter(max time.Duration) {
	deadline := time.Now().Add(max)
	for {
		g.mu.Lock()
		if !g.snap || time.Now().After(deadline) {
			g.running++
			g.mu.Unlock()
			return
		}
		g.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
}

func (g *snapshotGate) leave() {
	g.mu.Lock()
	g.running--
	g.mu.Unlock()
}

// begin stops new commands and waits (up to max) for running ones; it
// reports whether the box was quiet.
func (g *snapshotGate) begin(max time.Duration) bool {
	g.mu.Lock()
	g.snap = true
	g.mu.Unlock()
	deadline := time.Now().Add(max)
	for {
		g.mu.Lock()
		quiet := g.running == 0
		g.mu.Unlock()
		if quiet {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (g *snapshotGate) end() {
	g.mu.Lock()
	g.snap = false
	g.mu.Unlock()
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	// PID 1 with no init in front (WSL containers have no --init; `unshare
	// --pid --fork` in the WSL distro): be a tiny init that reaps orphans and
	// run the daemon as its child, so a reaper never takes a command's exit
	// status from the daemon's own Wait.
	if os.Getpid() == 1 && os.Getenv("BOXD_INIT_CHILD") == "" {
		os.Exit(runInit())
	}
	cfg := loadConfig()
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix("boxd ")
	// The command user first, then the image's file index (once per
	// container, before anything runs in it): the user's setup is not a change.
	_, statErr := os.Stat(baselineFile)
	first := statErr != nil
	prepareUser(cfg, first)
	if first {
		start := time.Now()
		n, err := writeBaseline()
		log.Printf("baseline: %d entries in %v (err=%v)", n, time.Since(start), err)
	}
	ln, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	if cfg.portFile != "" {
		port := ln.Addr().(*net.TCPAddr).Port
		tmp := cfg.portFile + ".tmp"
		if err := os.WriteFile(tmp, []byte(strconv.Itoa(port)+"\n"), 0o644); err == nil {
			_ = os.Rename(tmp, cfg.portFile)
		}
	}
	if cfg.idle > 0 {
		go idleExit(cfg.idle, ln)
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		_ = ln.Close()
		os.Exit(0)
	}()
	log.Printf("ready %s listen=%s uid=%d", version, cfg.listen, cfg.uid)
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept: %v", err)
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetNoDelay(true)
		}
		activity.Add(1)
		lastActive.Store(time.Now().UnixNano())
		go func() {
			defer func() { activity.Add(-1); lastActive.Store(time.Now().UnixNano()) }()
			serve(cfg, conn)
		}()
	}
}

// Open connections, and when the last one ended (BOXD_IDLE_EXIT).
var (
	activity   atomic.Int64
	lastActive atomic.Int64
)

// idleExit ends boxd (and with it the box) once no request came for `idle`
// and none is running (a server in the foreground holds its connection).
func idleExit(idle time.Duration, ln net.Listener) {
	lastActive.Store(time.Now().UnixNano())
	for {
		time.Sleep(idle / 20)
		if activity.Load() == 0 && time.Since(time.Unix(0, lastActive.Load())) > idle {
			log.Printf("idle for %v: exiting", idle)
			_ = ln.Close()
			os.Exit(0)
		}
	}
}

func loadConfig() config {
	get := func(k, d string) string {
		v := os.Getenv(k)
		if v == "" {
			return d
		}
		return v
	}
	atoi := func(k string) int {
		n, _ := strconv.Atoi(os.Getenv(k))
		return n
	}
	cfg := config{
		token:   os.Getenv("BOXD_TOKEN"),
		listen:  get("BOXD_LISTEN", "0.0.0.0:7777"),
		uid:     atoi("BOXD_UID"),
		gid:     atoi("BOXD_GID"),
		home:    get("BOXD_HOME", "/root"),
		root:    get("BOXD_ROOT", "/"),
		pathPre: os.Getenv("BOXD_PATH"),
		envFile: os.Getenv("BOXD_ENV_FILE"),
		shell:   os.Getenv("BOXD_SHELL"),
		portFile: os.Getenv("BOXD_PORT_FILE"),
		idle:    time.Duration(atoi("BOXD_IDLE_EXIT")) * time.Minute,
	}
	if cfg.shell == "" {
		cfg.shell = "/bin/bash"
		if _, err := os.Stat(cfg.shell); err != nil {
			cfg.shell = "/bin/sh"
		}
	}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "BOXD_") {
			continue
		}
		cfg.baseEnv = append(cfg.baseEnv, kv)
	}
	for _, k := range []string{"BOXD_TOKEN", "BOXD_LISTEN", "BOXD_UID", "BOXD_GID", "BOXD_HOME", "BOXD_ROOT", "BOXD_PATH", "BOXD_ENV_FILE", "BOXD_SHELL", "BOXD_PORT_FILE", "BOXD_IDLE_EXIT"} {
		_ = os.Unsetenv(k)
	}
	if cfg.token == "" {
		log.Fatal("BOXD_TOKEN is not set")
	}
	return cfg
}

// prepareUser gives a non-root command user (the uid-matched user of a
// rootful Docker) an account, HOME=/root that it owns, and passwordless sudo
// that keeps PATH (so the package-manager wrappers stay in front).
func prepareUser(cfg config, first bool) {
	_ = os.MkdirAll(cfg.home, 0o755)
	if cfg.uid == 0 {
		return
	}
	uid, gid := strconv.Itoa(cfg.uid), strconv.Itoa(cfg.gid)
	if _, err := exec.LookPath("useradd"); err == nil {
		_ = exec.Command("groupadd", "-o", "-g", gid, "mars").Run()
		_ = exec.Command("useradd", "-o", "-u", uid, "-g", gid, "-M", "-d", cfg.home, "-s", "/bin/bash", "mars").Run()
	}
	ensureLine("/etc/group", ":"+gid+":", fmt.Sprintf("mars:x:%d:\n", cfg.gid))
	ensureLine("/etc/passwd", ":"+uid+":", fmt.Sprintf("mars:x:%d:%d:mars:%s:/bin/bash\n", cfg.uid, cfg.gid, cfg.home))
	if data, err := os.ReadFile("/etc/shadow"); err == nil && !strings.Contains(string(data), "\nmars:") && !strings.HasPrefix(string(data), "mars:") {
		if f, err := os.OpenFile("/etc/shadow", os.O_APPEND|os.O_WRONLY, 0); err == nil {
			_, _ = f.WriteString("mars:*:20000:0:99999:7:::\n")
			f.Close()
		}
	}
	if first {
		// HOME is the user's: what the image put there (.local, .cache) too.
		_ = filepath.WalkDir(cfg.home, func(p string, d fs.DirEntry, err error) error {
			if err == nil {
				_ = os.Lchown(p, cfg.uid, cfg.gid)
			}
			return nil
		})
	}
	if _, err := os.Stat("/etc/sudoers.d"); err == nil {
		rule := "mars ALL=(ALL) NOPASSWD:ALL\nDefaults:mars !secure_path\nDefaults:mars !requiretty\nDefaults:mars env_keep += \"PATH PYTHONPATH NODE_OPTIONS HOME MARS_*\"\n"
		_ = os.WriteFile("/etc/sudoers.d/mars", []byte(rule), 0o440)
	}
}

func ensureLine(file, needle, line string) {
	data, _ := os.ReadFile(file)
	for _, l := range strings.Split(string(data), "\n") {
		parts := strings.Split(l, ":")
		if len(parts) > 2 && ":"+parts[2]+":" == needle {
			return
		}
	}
	f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if len(data) > 0 && data[len(data)-1] != '\n' {
		_, _ = f.WriteString("\n")
	}
	_, _ = f.WriteString(line)
}

// runInit is PID 1: start boxd as a child, forward signals to it, reap
// every orphan, and exit with the daemon's status.
func runInit() int {
	self, err := os.Executable()
	if err != nil {
		self = "/proc/self/exe"
	}
	cmd := exec.Command(self, os.Args[1:]...)
	cmd.Env = append(os.Environ(), "BOXD_INIT_CHILD=1")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "boxd init: %v\n", err)
		return 1
	}
	child := cmd.Process.Pid
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT)
	go func() {
		for sig := range sigs {
			_ = cmd.Process.Signal(sig)
		}
	}()
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, 0, nil)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return 1
		}
		if pid == child {
			if status.Signaled() {
				return 128 + int(status.Signal())
			}
			return status.ExitStatus()
		}
	}
}

// conn wraps a connection with a write lock (frames come from several goroutines).
type conn struct {
	net.Conn
	r  *bufio.Reader
	mu sync.Mutex
}

func (c *conn) frame(kind byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return proto.WriteFrame(c.Conn, kind, payload)
}

func (c *conn) exit(info proto.ExitInfo) {
	data, _ := json.Marshal(info)
	_ = c.frame(proto.Exit, data)
}

func (c *conn) fail(start time.Time, err error) {
	_ = c.frame(proto.Fail, []byte(err.Error()))
	c.exit(proto.ExitInfo{Code: 125, Ms: ms(start)})
}

func ms(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000
}

func serve(cfg config, raw net.Conn) {
	defer raw.Close()
	c := &conn{Conn: raw, r: bufio.NewReaderSize(raw, 64<<10)}
	start := time.Now()
	_ = raw.SetReadDeadline(time.Now().Add(10 * time.Second))
	req, err := proto.ReadRequest(c.r, cfg.token)
	_ = raw.SetReadDeadline(time.Time{})
	if err != nil {
		c.fail(start, err)
		return
	}
	switch req.Op {
	case "ping":
		info, _ := json.Marshal(map[string]any{"version": version, "pid": os.Getpid(), "uid": cfg.uid, "home": cfg.home, "root": cfg.root, "shell": cfg.shell})
		_ = c.frame(proto.Data, info)
		c.exit(proto.ExitInfo{Ms: ms(start)})
	case "exec":
		runExec(cfg, c, req, start)
	case "stat":
		out, _ := json.Marshal(statPaths(req.Paths))
		_ = c.frame(proto.Data, out)
		c.exit(proto.ExitInfo{Ms: ms(start)})
	case "changes":
		// What differs from the image (like `docker diff`, with stat fields),
		// by walking the box and comparing with the baseline index. Paths are
		// folders not walked (caches; their kept subfolders are walked).
		out, err := changes(req.Paths, req.Env)
		if err != nil {
			c.fail(start, err)
			return
		}
		_ = c.frame(proto.Data, out)
		c.exit(proto.ExitInfo{Ms: ms(start)})
	case "walk":
		// Every entry below the given folders (dependency folders inside
		// the project), with the stat fields of the snapshot diff.
		max := req.Wait
		if max <= 0 {
			max = 400000
		}
		entries, truncated := walkPaths(req.Paths, max)
		out, _ := json.Marshal(map[string]any{"entries": entries, "truncated": truncated})
		_ = c.frame(proto.Data, out)
		c.exit(proto.ExitInfo{Ms: ms(start)})
	case "tar":
		// No new command starts while the snapshot reads the files.
		quiet := gate.begin(3 * time.Second)
		err := writeTar(c, req.Paths, cfg.uid, cfg.gid)
		gate.end()
		if !quiet {
			_ = c.frame(proto.Stderr, []byte("busy: a command was running during the snapshot\n"))
		}
		if err != nil {
			c.fail(start, err)
			return
		}
		c.exit(proto.ExitInfo{Ms: ms(start)})
	default:
		c.fail(start, fmt.Errorf("unknown op %q", req.Op))
	}
}

// handBack gives the command user back what root (sudo inside the box) made
// in the folders the launcher reads and clears on this machine (the install
// log's note folders), so they never pile up undeletable there. Listed by the
// launcher as BOXD_CHOWN_DIRS in the env file.
func handBack(cfg config) {
	if cfg.uid == 0 || cfg.envFile == "" {
		return
	}
	data, err := os.ReadFile(cfg.envFile)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "BOXD_CHOWN_DIRS=") {
			continue
		}
		for _, dir := range strings.Split(strings.TrimPrefix(line, "BOXD_CHOWN_DIRS="), ":") {
			if dir = strings.TrimSpace(dir); dir == "" {
				continue
			}
			_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				var st syscall.Stat_t
				if syscall.Lstat(p, &st) == nil && st.Uid == 0 {
					_ = os.Lchown(p, cfg.uid, cfg.gid)
				}
				return nil
			})
		}
	}
}

func commandEnv(cfg config, extra map[string]string) []string {
	env := map[string]string{}
	order := []string{}
	set := func(k, v string) {
		if _, ok := env[k]; !ok {
			order = append(order, k)
		}
		env[k] = v
	}
	for _, kv := range cfg.baseEnv {
		if i := strings.IndexByte(kv, '='); i > 0 {
			set(kv[:i], kv[i+1:])
		}
	}
	set("HOME", cfg.home)
	user := "root"
	if cfg.uid != 0 {
		user = "mars"
	}
	set("USER", user)
	set("LOGNAME", user)
	if env["PATH"] == "" {
		set("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	if cfg.envFile != "" {
		if data, err := os.ReadFile(cfg.envFile); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				if i := strings.IndexByte(line, '='); i > 0 {
					set(line[:i], line[i+1:])
				}
			}
		}
	}
	for k, v := range extra {
		set(k, v)
	}
	delete(env, "BOXD_CHOWN_DIRS")
	// The package-manager wrappers' folder, written by the launcher after the start.
	if pre, ok := env["BOXD_PATH_PREFIX"]; ok {
		delete(env, "BOXD_PATH_PREFIX")
		if pre != "" {
			set("PATH", pre+":"+env["PATH"])
		}
	}
	if cfg.pathPre != "" {
		set("PATH", cfg.pathPre+":"+env["PATH"])
	}
	out := make([]string, 0, len(order))
	for _, k := range order {
		if v, ok := env[k]; ok {
			out = append(out, k+"="+v)
		}
	}
	return out
}

func runExec(cfg config, c *conn, req proto.Request, start time.Time) {
	if len(req.Argv) == 0 {
		c.fail(start, errors.New("empty argv"))
		return
	}
	// Wait (bounded) for a snapshot in progress, so it sees a quiet box.
	waitStart := time.Now()
	wait := time.Duration(req.Wait) * time.Millisecond
	if wait <= 0 {
		wait = 15 * time.Second
	}
	gate.enter(wait)
	defer gate.leave()
	waited := ms(waitStart)

	argv := req.Argv
	if argv[0] == "" || argv[0] == "$SHELL" {
		argv = append([]string{cfg.shell}, argv[1:]...)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = commandEnv(cfg, req.Env)
	cmd.Dir = cfg.root
	if req.Cwd != "" {
		if st, err := os.Stat(req.Cwd); err == nil && st.IsDir() {
			cmd.Dir = req.Cwd
		}
	}
	attr := &syscall.SysProcAttr{Setpgid: true}
	if cfg.uid != 0 && !req.Root {
		attr.Credential = &syscall.Credential{Uid: uint32(cfg.uid), Gid: uint32(cfg.gid), NoSetGroups: true}
	}
	cmd.SysProcAttr = attr
	// Our own pipes: Wait() would close StdoutPipe's read end and drop
	// output still buffered in it.
	stdin, _ := cmd.StdinPipe()
	outR, outW, err1 := os.Pipe()
	errR, errW, err2 := os.Pipe()
	if err1 != nil || err2 != nil {
		c.fail(start, errors.New("pipe failed"))
		return
	}
	cmd.Stdout, cmd.Stderr = outW, errW
	if err := cmd.Start(); err != nil {
		outW.Close()
		errW.Close()
		outR.Close()
		errR.Close()
		c.fail(start, err)
		return
	}
	outW.Close()
	errW.Close()
	defer outR.Close()
	defer errR.Close()
	pgid := cmd.Process.Pid
	kill := func(sig syscall.Signal) { _ = syscall.Kill(-pgid, sig) }

	var lastRead atomic.Int64
	lastRead.Store(time.Now().UnixNano())
	var pumps sync.WaitGroup
	pump := func(r io.Reader, kind byte) {
		defer pumps.Done()
		buf := make([]byte, 32<<10)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				lastRead.Store(time.Now().UnixNano())
				if c.frame(kind, buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	pumps.Add(2)
	go pump(outR, proto.Stdout)
	go pump(errR, proto.Stderr)

	// Client frames: stdin, signals; a closed connection kills the command.
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 0, 64<<10)
		for {
			kind, payload, err := proto.ReadFrame(c.r, buf)
			if err != nil {
				select {
				case <-done:
				default:
					kill(syscall.SIGKILL)
				}
				_ = stdin.Close()
				return
			}
			switch kind {
			case proto.Stdin:
				_, _ = stdin.Write(payload)
			case proto.StdinEOF:
				_ = stdin.Close()
			case proto.Signal:
				kill(parseSignal(string(payload)))
			}
		}
	}()

	err := cmd.Wait()
	close(done)
	handBack(cfg)
	// Output a background child still holds open is not waited for: the
	// command is over when its shell exits (as on the host). What is in the
	// pipes is drained until they close or go quiet.
	drained := make(chan struct{})
	go func() { pumps.Wait(); close(drained) }()
	for quiet := false; !quiet; {
		select {
		case <-drained:
			quiet = true
		case <-time.After(10 * time.Millisecond):
			quiet = time.Since(time.Unix(0, lastRead.Load())) > 30*time.Millisecond
		}
	}
	info := proto.ExitInfo{Ms: ms(start), WaitedMs: waited}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				info.Signal = ws.Signal().String()
				info.Code = 128 + int(ws.Signal())
			} else {
				info.Code = ee.ExitCode()
			}
		} else {
			info.Code = 126
		}
	}
	c.exit(info)
}

func parseSignal(name string) syscall.Signal {
	switch strings.ToUpper(strings.TrimPrefix(strings.ToUpper(name), "SIG")) {
	case "KILL":
		return syscall.SIGKILL
	case "INT":
		return syscall.SIGINT
	case "HUP":
		return syscall.SIGHUP
	case "QUIT":
		return syscall.SIGQUIT
	default:
		return syscall.SIGTERM
	}
}

func statPaths(paths []string) []proto.StatEntry {
	out := make([]proto.StatEntry, 0, len(paths))
	for _, p := range paths {
		var st syscall.Stat_t
		e := proto.StatEntry{Path: p}
		if err := syscall.Lstat(p, &st); err != nil {
			e.Type = "missing"
			out = append(out, e)
			continue
		}
		e.Mode = st.Mode & 0o7777
		e.Size = st.Size
		e.MtimeNs = st.Mtim.Sec*1e9 + st.Mtim.Nsec
		e.CtimeNs = st.Ctim.Sec*1e9 + st.Ctim.Nsec
		e.Ino = st.Ino
		e.Nlink = uint64(st.Nlink)
		e.UID = st.Uid
		e.GID = st.Gid
		switch st.Mode & syscall.S_IFMT {
		case syscall.S_IFREG:
			e.Type = "file"
		case syscall.S_IFDIR:
			e.Type = "dir"
			e.Size = 0
		case syscall.S_IFLNK:
			e.Type = "symlink"
			e.Link, _ = os.Readlink(p)
		default:
			e.Type = "other"
		}
		out = append(out, e)
	}
	return out
}

func walkPaths(roots []string, max int) ([]proto.StatEntry, bool) {
	var paths []string
	truncated := false
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if len(paths) >= max {
				truncated = true
				return filepath.SkipAll
			}
			paths = append(paths, p)
			return nil
		})
	}
	return statPaths(paths), truncated
}

const baselineFile = "/opt/mars/state/baseline.gz"

// Folders never walked for changes: kernel and runtime state, our own files.
var walkSkip = []string{"/proc", "/sys", "/dev", "/run", "/opt/mars"}

type sig struct {
	Mt, Ct, Size int64
	Mode         uint32
	Ino          uint64
	UID, GID     uint32
	Kind         byte
}

func entrySig(st *syscall.Stat_t) sig {
	k := byte('o')
	switch st.Mode & syscall.S_IFMT {
	case syscall.S_IFREG:
		k = 'f'
	case syscall.S_IFDIR:
		k = 'd'
	case syscall.S_IFLNK:
		k = 'l'
	}
	s := sig{Mode: st.Mode & 0o7777, Ino: st.Ino, UID: st.Uid, GID: st.Gid, Kind: k}
	if k != 'd' {
		s.Mt = st.Mtim.Sec*1e9 + st.Mtim.Nsec
		s.Ct = st.Ctim.Sec*1e9 + st.Ctim.Nsec
		s.Size = st.Size
	}
	return s
}

func within(p, dir string) bool {
	return p == dir || strings.HasPrefix(p, dir+"/")
}

// skipper: a path under a skipped folder is not walked, unless it leads to
// or lies in a kept one.
func skipper(skip, keep []string) func(string) bool {
	return func(p string) bool {
		for _, k := range keep {
			if within(p, k) || within(k, p) {
				return false
			}
		}
		for _, s := range skip {
			if within(p, s) {
				return true
			}
		}
		return false
	}
}

// walkRoot visits every path of the box's own filesystem (not other mounts).
func walkRoot(skipped func(string) bool, visit func(p string, st *syscall.Stat_t)) {
	var rootSt syscall.Stat_t
	_ = syscall.Lstat("/", &rootSt)
	var walk func(dir string)
	walk = func(dir string) {
		f, err := os.Open(dir)
		if err != nil {
			return
		}
		names, _ := f.Readdirnames(-1)
		f.Close()
		for _, name := range names {
			p := dir + "/" + name
			if dir == "/" {
				p = "/" + name
			}
			if skipped(p) {
				continue
			}
			var st syscall.Stat_t
			if syscall.Lstat(p, &st) != nil {
				continue
			}
			if st.Dev != rootSt.Dev {
				continue // a mount: the project folder, docker-init, /etc/hosts
			}
			visit(p, &st)
			if st.Mode&syscall.S_IFMT == syscall.S_IFDIR {
				walk(p)
			}
		}
	}
	walk("/")
}

func writeBaseline() (int, error) {
	if err := os.MkdirAll(filepath.Dir(baselineFile), 0o700); err != nil {
		return 0, err
	}
	tmp := baselineFile + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return 0, err
	}
	zw := gzip.NewWriter(f)
	enc := gob.NewEncoder(zw)
	index := map[string]sig{}
	walkRoot(skipper(walkSkip, nil), func(p string, st *syscall.Stat_t) { index[p] = entrySig(st) })
	if err := enc.Encode(index); err != nil {
		f.Close()
		return 0, err
	}
	if err := zw.Close(); err != nil {
		f.Close()
		return 0, err
	}
	if err := f.Close(); err != nil {
		return 0, err
	}
	return len(index), os.Rename(tmp, baselineFile)
}

var baselineCache map[string]sig

func loadBaseline() (map[string]sig, error) {
	if baselineCache != nil {
		return baselineCache, nil
	}
	f, err := os.Open(baselineFile)
	if err != nil {
		return nil, fmt.Errorf("no baseline: %w", err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	index := map[string]sig{}
	if err := gob.NewDecoder(zr).Decode(&index); err != nil {
		return nil, err
	}
	baselineCache = index
	return index, nil
}

type change struct {
	Kind string `json:"kind"`
	proto.StatEntry
}

// changes lists A/C/D against the image. extra["keep"] (comma list) are
// folders under a skipped one that are still walked.
func changes(skip []string, extra map[string]string) ([]byte, error) {
	base, err := loadBaseline()
	if err != nil {
		return nil, err
	}
	var keep []string
	if v := extra["keep"]; v != "" {
		keep = strings.Split(v, ",")
	}
	skipped := skipper(append(append([]string(nil), walkSkip...), skip...), keep)
	seen := make(map[string]bool, len(base))
	out := []change{}
	walkRoot(skipped, func(p string, st *syscall.Stat_t) {
		seen[p] = true
		now := entrySig(st)
		old, ok := base[p]
		if ok && old == now {
			return
		}
		kind := "A"
		if ok {
			kind = "C"
		}
		out = append(out, change{Kind: kind, StatEntry: statPaths([]string{p})[0]})
	})
	for p := range base {
		if !seen[p] && !skipped(p) {
			out = append(out, change{Kind: "D", StatEntry: proto.StatEntry{Path: p, Type: "missing"}})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return json.Marshal(out)
}

// frameWriter streams tar bytes as Data frames.
type frameWriter struct{ c *conn }

func (w frameWriter) Write(p []byte) (int, error) {
	if err := w.c.frame(proto.Data, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// writeTar writes exactly the listed paths (not recursively): parents before
// children, numeric owners, a hard link only to a file already in this tar.
// The command user (a uid-matched user on rootful Docker) is root in the tar:
// a replay runs as root.
func writeTar(c *conn, paths []string, uid, gid int) error {
	sorted := append([]string(nil), paths...)
	sort.Strings(sorted)
	bw := bufio.NewWriterSize(frameWriter{c}, 256<<10)
	tw := tar.NewWriter(bw)
	seen := map[[2]uint64]string{}
	for _, p := range sorted {
		if !strings.HasPrefix(p, "/") {
			continue
		}
		var st syscall.Stat_t
		if err := syscall.Lstat(p, &st); err != nil {
			continue // gone meanwhile: the next snapshot sees it
		}
		name := strings.TrimPrefix(p, "/")
		owner, group := int(st.Uid), int(st.Gid)
		if uid != 0 && owner == uid {
			owner = 0
		}
		if gid != 0 && group == gid {
			group = 0
		}
		hdr := &tar.Header{
			Name:    name,
			Mode:    int64(st.Mode & 0o7777),
			Uid:     owner,
			Gid:     group,
			ModTime: time.Unix(st.Mtim.Sec, st.Mtim.Nsec),
			Format:  tar.FormatPAX,
		}
		switch st.Mode & syscall.S_IFMT {
		case syscall.S_IFDIR:
			hdr.Typeflag = tar.TypeDir
			hdr.Name += "/"
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
		case syscall.S_IFLNK:
			target, err := os.Readlink(p)
			if err != nil {
				continue
			}
			hdr.Typeflag = tar.TypeSymlink
			hdr.Linkname = target
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
		case syscall.S_IFREG:
			key := [2]uint64{uint64(st.Dev), st.Ino}
			if first, ok := seen[key]; ok && st.Nlink > 1 {
				hdr.Typeflag = tar.TypeLink
				hdr.Linkname = first
				if err := tw.WriteHeader(hdr); err != nil {
					return err
				}
				continue
			}
			f, err := os.Open(p)
			if err != nil {
				continue
			}
			hdr.Typeflag = tar.TypeReg
			hdr.Size = st.Size
			if err := tw.WriteHeader(hdr); err != nil {
				f.Close()
				return err
			}
			n, err := io.CopyN(tw, f, st.Size)
			f.Close()
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			if n < st.Size {
				// Shrank while read: pad so the archive stays valid.
				if _, err := tw.Write(make([]byte, st.Size-n)); err != nil {
					return err
				}
			}
			if st.Nlink > 1 {
				seen[key] = name
			}
		default:
			continue // fifos, sockets, devices: not environment
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return bw.Flush()
}
