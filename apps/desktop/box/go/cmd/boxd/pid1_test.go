//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"marsai.click/box/proto"
)

// TestPID1ExitCodes runs the real boxd binary as PID 1 of its own PID
// namespace (what `unshare --pid --fork` in the WSL distro, wslc and Apple
// containers without --init give it) and checks 200 quick commands, several
// with children that outlive them, against their exit codes. A reaper that
// took a command's status from exec.Cmd.Wait turned some of them into 126.
// Needs unprivileged user namespaces; skipped where they are blocked.
func TestPID1ExitCodes(t *testing.T) {
	unshare, err := exec.LookPath("unshare")
	if err != nil {
		t.Skip("no unshare")
	}
	if out, err := exec.Command(unshare, "--user", "--map-root-user", "--pid", "--fork", "true").CombinedOutput(); err != nil {
		t.Skipf("no user namespaces here: %s", strings.TrimSpace(string(out)))
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "boxd")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	portFile := filepath.Join(dir, "port")
	// A fixed free port too, so the same test runs against a boxd without BOXD_PORT_FILE.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fixed := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	cmd := exec.Command(unshare, "--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc", "--kill-child", bin)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "BOXD_TOKEN=tok", "BOXD_LISTEN=127.0.0.1:" + strconv.Itoa(fixed), "BOXD_PORT_FILE=" + portFile, "BOXD_HOME=" + dir, "BOXD_ROOT=" + dir, "BOXD_SHELL=/bin/sh"}
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	addr := ""
	for i := 0; i < 200 && addr == ""; i++ {
		if data, err := os.ReadFile(portFile); err == nil && strings.TrimSpace(string(data)) != "" {
			addr = "127.0.0.1:" + strings.TrimSpace(string(data))
		} else if c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(fixed), 50*time.Millisecond); err == nil {
			c.Close()
			addr = "127.0.0.1:" + strconv.Itoa(fixed)
		} else {
			time.Sleep(25 * time.Millisecond)
		}
	}
	if addr == "" {
		t.Fatal("boxd did not start")
	}
	// boxd must be PID 1 there (with the init in front, its daemon is PID 2).
	r := call(t, addr, proto.Request{Op: "exec", Argv: []string{"/bin/sh", "-c", "cat /proc/1/comm; echo $PPID"}}, nil)
	if !strings.HasPrefix(r.out, "boxd") {
		t.Fatalf("PID 1 is %q", r.out)
	}
	wrong := 0
	for i := 0; i < 200; i++ {
		want := i % 7
		script := fmt.Sprintf("exit %d", want)
		if i%3 == 0 {
			// An orphan that outlives the command: PID 1 must reap it, not the command.
			script = fmt.Sprintf("(sleep 0.05 &) ; echo x; exit %d", want)
		}
		res := call(t, addr, proto.Request{Op: "exec", Argv: []string{"/bin/sh", "-c", script}}, nil)
		if res.exit.Code != want {
			wrong++
			t.Logf("call %d: exit %d, want %d (%s)", i, res.exit.Code, want, strconv.Quote(res.err))
		}
	}
	if wrong != 0 {
		t.Fatalf("%d of 200 commands got a wrong exit code", wrong)
	}
}
