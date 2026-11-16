//go:build windows

package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// The test program plays three parts when started with the right environment: a fake msiexec
// (first argument /i: exits with the code in KB_TEST_MSIEXEC_CODE), a Kasboek that was opened
// again (creates the file in KB_TEST_MARK), and a program that just sits there (KB_TEST_SLEEP).
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "/i" {
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
