//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// mountOverlay mounts lower+upper at merged: the kernel's overlayfs (in a
// user namespace: 5.11+, with userxattr), else fuse-overlayfs when given.
// Returns "kernel" or "fuse".
func mountOverlay(lower, upper, work, merged, fuse string) (string, error) {
	return mountOverlayMode(lower, upper, work, merged, fuse, false)
}

func mountOverlayMode(lower, upper, work, merged, fuse string, noKernel bool) (string, error) {
	base := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", lower, upper, work)
	var errs []string
	kernel := []string{base + ",userxattr", base}
	if noKernel {
		kernel = nil
		errs = append(errs, "kernel overlay skipped")
	}
	for _, opts := range kernel {
		err := syscall.Mount("overlay", merged, "overlay", 0, opts)
		if err == nil {
			return "kernel", nil
		}
		errs = append(errs, err.Error())
	}
	if fuse != "" {
		if _, err := os.Stat("/dev/fuse"); err == nil {
			cmd := exec.Command(fuse, "-o", base, merged)
			out, err := cmd.CombinedOutput()
			if err == nil {
				return "fuse", nil
			}
			errs = append(errs, fmt.Sprintf("fuse-overlayfs: %v %s", err, strings.TrimSpace(string(out))))
		} else {
			errs = append(errs, "no /dev/fuse")
		}
	}
	return "", errors.New("overlay: " + strings.Join(errs, "; "))
}

func ensureDir(p string) error {
	if fi, err := os.Lstat(p); err == nil {
		if fi.IsDir() {
			return nil
		}
		return fmt.Errorf("%s is not a folder", p)
	}
	return os.MkdirAll(p, 0o755)
}

func ensureFile(p string) error {
	if fi, err := os.Lstat(p); err == nil {
		if fi.Mode().IsRegular() {
			return nil
		}
		return fmt.Errorf("%s is not a file", p)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	return f.Close()
}

func bind(src, dst string, ro bool, rec bool) error {
	flags := uintptr(syscall.MS_BIND)
	if rec {
		flags |= syscall.MS_REC
	}
	if err := syscall.Mount(src, dst, "", flags, ""); err != nil {
		return fmt.Errorf("bind %s: %w", dst, err)
	}
	if ro {
		// Read-only needs a remount of the bind; flags locked by the parent namespace must be kept.
		var st syscall.Statfs_t
		extra := uintptr(0)
		if syscall.Statfs(dst, &st) == nil {
			extra = uintptr(st.Flags) & (syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC | syscall.MS_NOATIME | syscall.MS_RELATIME)
		}
		if err := syscall.Mount("", dst, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|extra, ""); err != nil {
			return fmt.Errorf("read-only %s: %w", dst, err)
		}
	}
	return nil
}

// stageInit runs inside the namespaces as root: overlay root, the project
// and run folders, /proc /dev /sys, DNS, then the root switch and boxd.
func stageInit(args []string) error {
	if len(args) < 1 {
		return errors.New("init: no spec")
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	var sp spec
	if err := json.Unmarshal(data, &sp); err != nil {
		return err
	}
	t0 := time.Now()
	if sp.Root {
		// unshare(1) as real root: nothing may leak back to the distro's mounts.
		_ = syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, "")
	}
	if sp.Hostname != "" {
		_ = syscall.Sethostname([]byte(sp.Hostname))
	}
	m := sp.Merged
	if err := ensureDir(m); err != nil {
		return err
	}
	overlay, err := mountOverlayMode(sp.Lower, sp.Upper, sp.Work, m, sp.Fuse, sp.NoKernel)
	if err != nil {
		return err
	}
	in := func(p string) string { return filepath.Join(m, p) }
	// The command folders boxd and the launcher use. They are made once, in
	// the upper layer, before boxd's first index, so they are no change.
	for _, d := range []string{"proc", "dev", "sys", "tmp", "run", "opt/mars/bin"} {
		if err := ensureDir(in(d)); err != nil {
			return err
		}
	}
	_ = os.Chmod(in("tmp"), 0o1777)
	if err := syscall.Mount("proc", in("proc"), "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""); err != nil {
		// Some kernels refuse a fresh proc while the host's is partly covered: bind the namespace's own.
		if err2 := bind("/proc", in("proc"), false, true); err2 != nil {
			return fmt.Errorf("proc: %v; %v", err, err2)
		}
	}
	if err := bind("/dev", in("dev"), false, true); err != nil {
		return err
	}
	if fi, err := os.Stat(in("dev/shm")); err == nil && fi.IsDir() {
		_ = syscall.Mount("tmpfs", in("dev/shm"), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=1777")
	}
	if err := bind("/sys", in("sys"), true, true); err != nil {
		// /sys is only read by a few tools: go on without it.
		fmt.Fprintf(os.Stderr, "boxrun: %v\n", err)
	}
	if err := ensureFile(in("opt/mars/bin/boxd")); err != nil {
		return err
	}
	if err := bind(sp.Boxd, in("opt/mars/bin/boxd"), true, false); err != nil {
		return err
	}
	for _, f := range []struct{ src, dst string }{{sp.Resolv, "etc/resolv.conf"}, {sp.Hosts, "etc/hosts"}} {
		if f.src == "" {
			continue
		}
		if _, err := os.Stat(f.src); err != nil {
			continue
		}
		target := in(f.dst)
		if fi, err := os.Lstat(target); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			continue // the image links it somewhere: leave it
		}
		if ensureFile(target) == nil {
			_ = bind(f.src, target, true, false)
		}
	}
	for _, b := range sp.Binds {
		target := in(b.Dst)
		fi, err := os.Stat(b.Src)
		if err != nil {
			return fmt.Errorf("bind source %s: %w", b.Dst, err)
		}
		if fi.IsDir() {
			err = ensureDir(target)
		} else {
			err = ensureFile(target)
		}
		if err != nil {
			return err
		}
		if err := bind(b.Src, target, b.RO, true); err != nil {
			return err
		}
	}
	if sp.AptRoot {
		// One uid is mapped (the user's, as root): apt cannot drop to _apt.
		conf := in("etc/apt/apt.conf.d")
		if fi, err := os.Stat(conf); err == nil && fi.IsDir() {
			file := filepath.Join(conf, "00mars-box")
			if _, err := os.Stat(file); err != nil {
				_ = os.WriteFile(file, []byte("APT::Sandbox::User \"root\";\n"), 0o644)
			}
		}
	}
	if sp.InitOut != "" {
		info, _ := json.Marshal(map[string]any{"overlay": overlay, "ms": time.Since(t0).Milliseconds()})
		_ = os.WriteFile(sp.InitOut, info, 0o600)
	}
	// Switch root: pivot_root(".", ".") stacks the old root on the new one;
	// detaching it leaves only the box.
	if err := os.Chdir(m); err != nil {
		return err
	}
	if err := syscall.PivotRoot(".", "."); err != nil {
		return fmt.Errorf("pivot_root: %w", err)
	}
	if err := syscall.Unmount(".", syscall.MNT_DETACH); err != nil {
		return fmt.Errorf("detach old root: %w", err)
	}
	if err := os.Chdir("/"); err != nil {
		return err
	}
	return syscall.Exec("/opt/mars/bin/boxd", []string{"boxd"}, sp.Env)
}
