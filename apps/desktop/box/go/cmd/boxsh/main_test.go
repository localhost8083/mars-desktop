package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseShellArgs(t *testing.T) {
	cases := []struct {
		in    []string
		cmd   string
		rest  []string
		login bool
		ok    bool
	}{
		{[]string{"-c", "ls -la"}, "ls -la", []string{}, false, true},
		{[]string{"-lc", "cygpath -w -- \"$1\"", "_", "/x"}, "cygpath -w -- \"$1\"", []string{"_", "/x"}, true, true},
		{[]string{"-l", "-c", "echo hi"}, "echo hi", []string{}, true, true},
		{[]string{}, "", nil, false, false},
		{[]string{"script.sh"}, "", nil, false, false},
		{[]string{"-c"}, "", nil, false, false},
		{[]string{"-ec", "x"}, "", nil, false, false},
	}
	for _, c := range cases {
		cmd, rest, login, ok := parseShellArgs(c.in)
		if ok != c.ok || cmd != c.cmd || login != c.login || (c.ok && !reflect.DeepEqual(rest, c.rest)) {
			t.Errorf("%v: got %q %v %v %v", c.in, cmd, rest, login, ok)
		}
	}
}

func TestMapPathSame(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	rec := &Record{Root: "/home/u/proj", CRoot: "/home/u/proj"}
	if got := mapPath("/home/u/proj/src", rec); got != "/home/u/proj/src" {
		t.Fatal(got)
	}
	rec = &Record{Root: "/home/u/proj", CRoot: "/app"}
	for in, want := range map[string]string{"/home/u/proj": "/app", "/home/u/proj/a/b": "/app/a/b", "/home/u/projx": "/home/u/projx", "/tmp": "/tmp", "": "/app"} {
		if got := mapPath(in, rec); got != want {
			t.Errorf("%q -> %q want %q", in, got, want)
		}
	}
	if got := unmapPath("/app/a/b", rec); got != "/home/u/proj/a/b" {
		t.Fatal(got)
	}
}

func TestForwardEnv(t *testing.T) {
	t.Setenv("MARS_BOX_PASS_ENV", "MY_FLAG")
	got := forwardEnv([]string{"TERM=xterm", "MARS_ACCESS_TOKEN=secret", "OPENAI_API_KEY=k", "PATH=/x", "HOME=/h", "MARS_TURN=3", "MY_FLAG=1", "AWS_SECRET_ACCESS_KEY=s"})
	want := map[string]string{"TERM": "xterm", "MARS_TURN": "3", "MY_FLAG": "1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestWindowsArgs(t *testing.T) {
	if got := windowsArgs(`C:\Windows\System32\cmd.exe`, []string{"-c", "dir"}); !reflect.DeepEqual(got, []string{"/c", "dir"}) {
		t.Fatal(got)
	}
	if got := windowsArgs(`C:\Program Files\Git\bin\bash.exe`, []string{"-c", "ls"}); !reflect.DeepEqual(got, []string{"-c", "ls"}) {
		t.Fatal(got)
	}
}

func TestWindowsToBox(t *testing.T) {
	if got := windowsToBox(`C:\Users\Sam\.mars\pkglog\raw\12-ab`); got != "/c/Users/Sam/.mars/pkglog/raw/12-ab" {
		t.Fatal(got)
	}
}

// A box whose image is downloading is waited for past the start limit; the limit counts once it starts.
func TestWaitReadyThroughDownload(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MARS_BOX_HOME", home)
	t.Setenv("MARS_BOX_WAIT_MS", "300")
	if err := os.MkdirAll(filepath.Join(home, "boxes"), 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(state string) {
		data := `{"v":1,"key":"abc123","root":"/p","croot":"/p","state":"` + state + `","port":1,"token":"t"}`
		if err := os.WriteFile(filepath.Join(home, "boxes", "abc123.json"), []byte(data), 0o600); err != nil {
			t.Error(err)
		}
	}
	write("pulling")
	go func() {
		time.Sleep(700 * time.Millisecond)
		write("ready")
	}()
	rec, err := waitReady("abc123")
	if err != nil || rec == nil || rec.State != "ready" {
		t.Fatalf("waited through the download: %v %+v", err, rec)
	}
	write("starting")
	if _, err := waitReady("abc123"); err == nil || !strings.Contains(err.Error(), "did not start in time") {
		t.Fatalf("a start that hangs still times out: %v", err)
	}
}
