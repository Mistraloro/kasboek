package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func useHelperLog(t *testing.T) {
	t.Cleanup(func() { helperLogFile = "" })
}

func TestFailureIsWrittenToHelperLogNextToThePlan(t *testing.T) {
	useHelperLog(t)
	dir := t.TempDir()
	plan := filepath.Join(dir, "apply.json")
	err := applyAndLog(plan, func(string) error { return errors.New("plan: bad checksum") })
	if err == nil {
		t.Fatal("the error was lost")
	}
	raw, rerr := os.ReadFile(filepath.Join(dir, "helper.log"))
	if rerr != nil || !strings.Contains(string(raw), "plan: bad checksum") {
		t.Fatalf("log %q, %v", raw, rerr)
	}
}

func TestPanicIsRecoveredAndLogged(t *testing.T) {
	useHelperLog(t)
	dir := t.TempDir()
	err := applyAndLog(filepath.Join(dir, "apply.json"), func(string) error { panic("boom") })
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("error %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "helper.log"))
	if !strings.Contains(string(raw), "panic: boom") {
		t.Fatalf("log %q", raw)
	}
}

func TestSuccessLeavesNoLog(t *testing.T) {
	useHelperLog(t)
	dir := t.TempDir()
	if err := applyAndLog(filepath.Join(dir, "apply.json"), func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "helper.log")); err == nil {
		t.Fatal("a log was written without a failure")
	}
}

func TestHelperLogFallsBackToTheTempFolderAndStaysSmall(t *testing.T) {
	if got := helperLogPath(filepath.Join(t.TempDir(), "missing", "apply.json")); filepath.Dir(got) != filepath.Clean(os.TempDir()) {
		t.Fatalf("unknown folder: %s", got)
	}
	if got := helperLogPath("apply.json"); filepath.Dir(got) != filepath.Clean(os.TempDir()) {
		t.Fatalf("relative path: %s", got)
	}

	useHelperLog(t)
	helperLogFile = filepath.Join(t.TempDir(), "helper.log")
	line := strings.Repeat("x", 3000)
	for i := 0; i < 100; i++ {
		appendHelperLog(line)
	}
	st, err := os.Stat(helperLogFile)
	if err != nil || st.Size() > maxHelperLog+maxLogEntry+64 {
		t.Fatalf("size %v, %v", st, err)
	}
	appendHelperLog(strings.Repeat("y", 100000))
	if st, _ := os.Stat(helperLogFile); st.Size() > maxHelperLog+maxLogEntry+64 {
		t.Fatalf("one entry was not cut: %d", st.Size())
	}
}

func TestBaseName(t *testing.T) {
	for in, want := range map[string]string{`C:\a\Kasboek.exe`: "Kasboek.exe", "/a/b/Kasboek.exe": "Kasboek.exe", "Kasboek.exe": "Kasboek.exe", "": ""} {
		if got := baseName(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}
