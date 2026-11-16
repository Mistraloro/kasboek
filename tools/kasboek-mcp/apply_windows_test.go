//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test program plays three parts when started with the right environment: a fake msiexec
// (first argument /i: exits with the code in KB_TEST_MSIEXEC_CODE, after a minute if
// KB_TEST_MSIEXEC_HANG is set), a Kasboek that was opened again (creates the file in KB_TEST_MARK),
// and a program that just sits there (KB_TEST_SLEEP).
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "/i" {
		if os.Getenv("KB_TEST_MSIEXEC_HANG") != "" {
			time.Sleep(time.Minute)
		}
		code, _ := strconv.Atoi(os.Getenv("KB_TEST_MSIEXEC_CODE"))
		os.Exit(code)
	}
	if mark := os.Getenv("KB_TEST_MARK"); mark != "" {
		_ = os.WriteFile(mark, nil, 0o600)
		os.Exit(0)
	}
	if os.Getenv("KB_TEST_SLEEP") != "" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func sleeper(t *testing.T) *exec.Cmd {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "KB_TEST_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return cmd
}

func TestWaitExit(t *testing.T) {
	var w winPlatform
	cmd := sleeper(t)
	h, err := w.openProcess(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	defer w.closeProcess(h)
	if img, err := w.imagePath(h); err != nil || !samePath(img, os.Args[0]) {
		t.Fatalf("image path %q, %v", img, err)
	}
	if exited, err := w.waitExit(h, 200*time.Millisecond); err != nil || exited {
		t.Fatalf("exited=%v err=%v while it still runs", exited, err)
	}
	_ = cmd.Process.Kill()
	if exited, err := w.waitExit(h, 10*time.Second); err != nil || !exited {
		t.Fatalf("exited=%v err=%v after it was killed", exited, err)
	}
}

func TestOthersRunningMatchesTheExactPath(t *testing.T) {
	var w winPlatform
	cmd := sleeper(t)
	if running, err := w.othersRunning(os.Args[0]); err != nil || !running {
		t.Fatalf("running=%v err=%v", running, err)
	}
	if running, _ := w.othersRunning(filepath.Join(t.TempDir(), filepath.Base(os.Args[0]))); running {
		t.Fatal("matched a program with the same name in another folder")
	}
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	if running, err := w.othersRunning(os.Args[0]); err != nil || running {
		t.Fatalf("running=%v err=%v after it ended", running, err)
	}
}

func TestOthersRunningIgnoresAProcessThatHasEndedButIsStillHeld(t *testing.T) {
	var w winPlatform
	cmd := sleeper(t) // the test holds a handle to it (cmd.Process) until the end
	h, err := w.openProcess(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	defer w.closeProcess(h)
	_ = cmd.Process.Kill()
	if exited, err := w.waitExit(h, 10*time.Second); err != nil || !exited {
		t.Fatalf("exited=%v err=%v", exited, err)
	}
	if running, err := w.othersRunning(os.Args[0]); err != nil || running {
		t.Fatalf("running=%v err=%v for a process that has ended", running, err)
	}
}

func TestSameFileComparesTheFileNotTheSpelling(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "A Long Folder Name")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "Kasboek.exe")
	other := filepath.Join(dir, "Other.exe")
	for _, f := range []string{file, other} {
		if err := os.WriteFile(f, []byte("x"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if !sameFile(file, strings.ToUpper(file)) {
		t.Error("upper case spelling")
	}
	if sameFile(file, other) {
		t.Error("two different files")
	}
	// A hard link is the same file under a name no path comparison would match.
	link := filepath.Join(dir, "Link.exe")
	if err := os.Link(file, link); err == nil && !sameFile(file, link) {
		t.Error("hard link")
	}
	// An 8.3 name, when the volume makes them.
	long, _ := syscall.UTF16PtrFromString(dir)
	buf := make([]uint16, 512)
	if n, err := syscall.GetShortPathName(long, &buf[0], uint32(len(buf))); err == nil && n > 0 {
		short := filepath.Join(syscall.UTF16ToString(buf[:n]), "Kasboek.exe")
		if !sameFile(file, short) {
			t.Errorf("short name %s", short)
		}
	}
	// Files that can't be opened are compared by path, ignoring case.
	missing := filepath.Join(dir, "missing.exe")
	if !sameFile(missing, strings.ToUpper(missing)) || sameFile(missing, filepath.Join(dir, "other-missing.exe")) {
		t.Error("fallback comparison")
	}
}

func TestSystemMsiexecComesFromTheSystemFolder(t *testing.T) {
	exe, err := systemMsiexec()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(exe) || !strings.EqualFold(filepath.Base(exe), "msiexec.exe") {
		t.Fatalf("path %q", exe)
	}
	if _, err := os.Stat(exe); err != nil {
		t.Fatal(err)
	}
	if got := newWinPlatform().msiexec; got != exe {
		t.Fatalf("platform uses %q", got)
	}
	if _, err := (winPlatform{}).runMsiexec([]string{"/i"}, time.Second); err == nil {
		t.Fatal("ran without a known msiexec")
	}
	if _, err := (winPlatform{msiexec: "msiexec.exe"}).runMsiexec([]string{"/i"}, time.Second); err == nil {
		t.Fatal("ran a relative msiexec")
	}
}

func TestLockAndHashAllowsReadingButNotChangingUntilReleased(t *testing.T) {
	file := filepath.Join(t.TempDir(), "x.msi")
	if err := os.WriteFile(file, []byte("not really an installer"), 0o600); err != nil {
		t.Fatal(err)
	}
	var w winPlatform
	sum, release, err := w.lockAndHash(file)
	if err != nil {
		t.Fatal(err)
	}
	if want := sha256.Sum256([]byte("not really an installer")); sum != hex.EncodeToString(want[:]) {
		t.Fatalf("sum %q", sum)
	}
	// What Windows Installer does: open for reading.
	r, err := os.Open(file)
	if err != nil {
		t.Fatalf("reading while locked: %v", err)
	}
	r.Close()
	if f, err := os.OpenFile(file, os.O_WRONLY, 0); err == nil {
		f.Close()
		t.Fatal("could write while locked")
	}
	if err := os.Remove(file); err == nil {
		t.Fatal("could delete while locked")
	}
	if err := os.Rename(file, file+".x"); err == nil {
		t.Fatal("could rename while locked")
	}
	release()
	if f, err := os.OpenFile(file, os.O_WRONLY, 0); err != nil {
		t.Fatalf("still locked after release: %v", err)
	} else {
		f.Close()
	}
	if _, _, err := w.lockAndHash(filepath.Join(t.TempDir(), "missing.msi")); err == nil {
		t.Fatal("a missing file was hashed")
	}
}

func TestMsiexecThatHangsIsEnded(t *testing.T) {
	t.Setenv("KB_TEST_MSIEXEC_HANG", "1")
	start := time.Now()
	_, err := winPlatform{msiexec: os.Args[0]}.runMsiexec([]string{"/i"}, 500*time.Millisecond)
	if !errors.Is(err, errMsiexecTimeout) {
		t.Fatalf("error %v", err)
	}
	if time.Since(start) > 20*time.Second {
		t.Fatal("it was not ended")
	}
}

func TestCmdLineQuotesPathsWithSpacesAndAccents(t *testing.T) {
	got := cmdLine(`C:\Windows\System32\msiexec.exe`, msiexecArgs(`C:\Users\Jérôme Dupont\a b.msi`, `C:\Users\Jérôme Dupont\i.log`, true))
	want := `C:\Windows\System32\msiexec.exe /i "C:\Users\Jérôme Dupont\a b.msi" /passive /norestart /l*v "C:\Users\Jérôme Dupont\i.log"`
	if got != want {
		t.Fatalf("%s\nwant %s", got, want)
	}
}

// The whole update with the test program as msiexec.
func TestApplyUpdateWithFakeMsiexec(t *testing.T) {
	for _, tc := range []struct {
		code    int
		outcome string
	}{{0, "ok"}, {1603, "failed"}, {1618, "busy"}} {
		t.Run(tc.outcome, func(t *testing.T) {
			pl := testPlan(t)
			dir := filepath.Dir(pl.MSI)
			// Kasboek is a copy of the test program, so "opening it again" can be seen.
			self, err := os.ReadFile(os.Args[0])
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(pl.Exe, self, 0o700); err != nil {
				t.Fatal(err)
			}
			// A process id that has ended already: Kasboek is gone.
			gone := exec.Command(os.Args[0], "-test.run=^$")
			if err := gone.Run(); err != nil {
				t.Fatal(err)
			}
			pl.PID = gone.Process.Pid
			pl.Args = []string{"-test.run=^$"}
			mark := filepath.Join(dir, "opened")
			t.Setenv("KB_TEST_MARK", mark)
			t.Setenv("KB_TEST_MSIEXEC_CODE", strconv.Itoa(tc.code))
			raw, _ := json.Marshal(pl)
			file := filepath.Join(dir, "apply.json")
			if err := os.WriteFile(file, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			fast := realTiming
			fast.sleep = func(time.Duration) {}
			if err := applyWith(file, winPlatform{msiexec: os.Args[0]}, fast, startNoWindow); err != nil {
				t.Fatal(err)
			}
			if r := readResult(t, pl); r.Code != tc.code || r.Outcome != tc.outcome {
				t.Fatalf("result %+v", r)
			}
			for i := 0; i < 50; i++ {
				if _, err := os.Stat(mark); err == nil {
					return
				}
				time.Sleep(100 * time.Millisecond)
			}
			t.Fatal("Kasboek was not opened again")
		})
	}
}
