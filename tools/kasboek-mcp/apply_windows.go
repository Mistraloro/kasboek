//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	processSynchronize      = 0x00100000
	processQueryLimitedInfo = 0x00001000
	waitObject0             = 0
	waitTimeout             = 0x102
	th32csSnapProcess       = 0x2
	maxLongPath             = 32768
)

var procQueryFullProcessImageName = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

type winPlatform struct {
	// msiexec is Windows Installer's program; tests replace it.
	msiexec string
}

func newWinPlatform() winPlatform {
	return winPlatform{msiexec: filepath.Join(os.Getenv("SystemRoot"), "System32", "msiexec.exe")}
}

func (winPlatform) openProcess(pid int) (procHandle, error) {
	h, err := syscall.OpenProcess(processSynchronize|processQueryLimitedInfo, false, uint32(pid))
	return procHandle(h), err
}

func (winPlatform) closeProcess(h procHandle) { _ = syscall.CloseHandle(syscall.Handle(h)) }

func (winPlatform) waitExit(h procHandle, timeout time.Duration) (bool, error) {
	ev, err := syscall.WaitForSingleObject(syscall.Handle(h), uint32(timeout.Milliseconds()))
	if err != nil {
		return false, err
	}
	switch ev {
	case waitObject0:
		return true, nil
	case waitTimeout:
		return false, nil
	}
	return false, errors.New("unexpected wait result")
}

func (winPlatform) imagePath(h procHandle) (string, error) {
	buf := make([]uint16, maxLongPath)
	n := uint32(len(buf))
	r, _, err := procQueryFullProcessImageName.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return "", err
	}
	return syscall.UTF16ToString(buf[:n]), nil
}

func (w winPlatform) othersRunning(exePath string) (bool, error) {
	snap, err := syscall.CreateToolhelp32Snapshot(th32csSnapProcess, 0)
	if err != nil {
		return false, err
	}
	defer syscall.CloseHandle(snap)
	var e syscall.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := syscall.Process32First(snap, &e); err != nil {
		return false, err
	}
	self := uint32(os.Getpid())
	for {
		// The name is only a quick filter; the full path decides.
		if e.ProcessID != self && strings.EqualFold(syscall.UTF16ToString(e.ExeFile[:]), filepath.Base(exePath)) {
			if h, err := w.openProcess(int(e.ProcessID)); err == nil {
				img, ierr := w.imagePath(h)
				w.closeProcess(h)
				if ierr == nil && samePath(img, exePath) {
					return true, nil
				}
			}
		}
		if err := syscall.Process32Next(snap, &e); err != nil {
			return false, nil // no more processes
		}
	}
}

// cmdLine quotes every argument exactly (paths with spaces and accents), so msiexec reads what we mean.
func cmdLine(program string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	for _, a := range append([]string{program}, args...) {
		parts = append(parts, syscall.EscapeArg(a))
	}
	return strings.Join(parts, " ")
}

// runMsiexec is not hidden, so Windows Installer's own progress dialog shows.
func (w winPlatform) runMsiexec(args []string) (int, error) {
	cmd := exec.Command(w.msiexec)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: cmdLine(w.msiexec, args)}
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return 0, err
}

func (winPlatform) start(exe string, args []string) error {
	cmd := exec.Command(exe, args...)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func applyUpdate(path string) error {
	return applyWith(path, newWinPlatform(), realTiming)
}

func applyWith(path string, p platform, t timing) error {
	pl, err := loadPlan(path)
	if err != nil {
		return err
	}
	return runUpdate(p, noUI{}, pl, t, true)
}
