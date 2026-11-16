package main

// helper.log: the update helper runs without a console (Kasboek starts it with no output), so what
// goes wrong is written to a small file next to apply.json, where Kasboek's error message points.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"
)

const (
	helperLogName = "helper.log"
	// A full log is started again from the top; one entry is cut at maxLogEntry.
	maxHelperLog = 64 << 10
	maxLogEntry  = 4 << 10
)

// helperLogFile is where logf writes; empty until the update starts (then logf only prints).
var helperLogFile string

// helperLogPath is helper.log next to the plan, or in the system's temp folder when the plan's
// folder is not known (a relative path, or a folder that does not exist).
func helperLogPath(planPath string) string {
	dir := filepath.Dir(planPath)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() || !filepath.IsAbs(dir) {
		dir = os.TempDir()
	}
	return filepath.Join(dir, helperLogName)
}

func logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, "kasboek-mcp:", msg)
	appendHelperLog(msg)
}

func appendHelperLog(msg string) {
	if helperLogFile == "" {
		return
	}
	if len(msg) > maxLogEntry {
		msg = msg[:maxLogEntry] + "…"
	}
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if st, err := os.Stat(helperLogFile); err == nil && st.Size() > maxHelperLog {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(helperLogFile, flags, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().UTC().Format(time.RFC3339), msg)
}

// applyAndLog runs the update for the plan file and writes whatever goes wrong, a panic included,
// to helper.log. It returns the error so the exit code can say it.
func applyAndLog(planPath string, apply func(string) error) (err error) {
	helperLogFile = helperLogPath(planPath)
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v\n%s", r, debug.Stack())
		}
		if err != nil {
			logf("update failed: %v", err)
		}
	}()
	return apply(planPath)
}
