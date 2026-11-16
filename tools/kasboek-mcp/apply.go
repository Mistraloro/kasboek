package main

// The Windows update, run by a copy of this helper (kasboek-mcp --apply-update <plan.json>) that
// Kasboek starts just before it quits. The steps are wait -> verify -> install -> relaunch, written
// against the small platform interface so the order and the failure paths are tested everywhere;
// apply_windows.go holds the real Windows implementation.
//
// Kasboek always opens again, after a successful and after a failed install, except when it never
// closed: then nothing is installed and nothing is started (a second copy would only hand over).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// updatePlan is apply.json, written by Kasboek (see buildUpdatePlan in src/core/update.ts).
type updatePlan struct {
	V         int      `json:"v"`
	PID       int      `json:"pid"`
	Exe       string   `json:"exe"`
	Args      []string `json:"args"`
	MSI       string   `json:"msi"`
	SHA256    string   `json:"sha256"`
	Log       string   `json:"log"`
	Result    string   `json:"result"`
	ToVersion string   `json:"toVersion"`
	Theme     string   `json:"theme"`
	Texts     struct {
		Waiting    string `json:"waiting"`
		Installing string `json:"installing"`
		Starting   string `json:"starting"`
		Failed     string `json:"failed"`
		Cancelled  string `json:"cancelled"`
	} `json:"texts"`
}

// updateResult is result.json: what Kasboek reads at its next start. Code is msiexec's exit code,
// or -1 when msiexec did not run.
type updateResult struct {
	Code      int    `json:"code"`
	Outcome   string `json:"outcome"`
	ToVersion string `json:"toVersion"`
	At        string `json:"at"`
}

// ui shows the person what is going on: the progress window (updatewin_windows.go), or nothing.
type ui interface {
	waiting()
	installing()
	starting()
	failed(message string)
	close()
}

type noUI struct{}

func (noUI) waiting()      {}
func (noUI) installing()   {}
func (noUI) starting()     {}
func (noUI) failed(string) {}
func (noUI) close()        {}

// procHandle is an open process (a Windows handle).
type procHandle uintptr

type platform interface {
	// openProcess opens the process right away, so its id can't be taken over by another program.
	openProcess(pid int) (procHandle, error)
	closeProcess(h procHandle)
	// waitExit blocks until the process ends (true) or the timeout passes (false). No polling.
	waitExit(h procHandle, timeout time.Duration) (bool, error)
	imagePath(h procHandle) (string, error)
	// othersRunning: is any process running from exactly this program file?
	othersRunning(exePath string) (bool, error)
	// runMsiexec runs Windows Installer with these arguments and returns its exit code.
	runMsiexec(args []string) (int, error)
	// start starts a program and does not wait for it.
	start(exe string, args []string) error
}

var hex64 = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// loadPlan reads and checks the plan: it came from a file on disk, so nothing in it is trusted
// beyond what is checked here.
func loadPlan(path string) (updatePlan, error) {
	var p updatePlan
	raw, err := os.ReadFile(path)
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, fmt.Errorf("plan: %w", err)
	}
	return p, validatePlan(p, filepath.Dir(path))
}

func validatePlan(p updatePlan, dir string) error {
	if p.V != 1 {
		return errors.New("plan: unknown version")
	}
	if p.PID <= 0 {
		return errors.New("plan: bad process id")
	}
	if !hex64.MatchString(p.SHA256) {
		return errors.New("plan: bad checksum")
	}
	for _, f := range []string{p.Exe, p.MSI, p.Log, p.Result} {
		if !filepath.IsAbs(f) {
			return errors.New("plan: paths must be absolute")
		}
	}
	for _, f := range []string{p.MSI, p.Log, p.Result} {
		if !samePath(filepath.Dir(f), dir) {
			return errors.New("plan: files must be in the plan's folder")
		}
	}
	if !strings.EqualFold(filepath.Ext(p.MSI), ".msi") {
		return errors.New("plan: not an msi file")
	}
	if !strings.EqualFold(filepath.Base(p.Exe), "Kasboek.exe") {
		return errors.New("plan: not Kasboek")
	}
	if st, err := os.Stat(p.Exe); err != nil || st.IsDir() {
		return errors.New("plan: Kasboek not found")
	}
	return nil
}

// msiexecArgs: /passive shows Windows Installer's own small progress dialog (used only when our own
// window could not be shown), /qn shows nothing (our window shows the progress).
func msiexecArgs(msi, log string, passive bool) []string {
	mode := "/qn"
	if passive {
		mode = "/passive"
	}
	return []string{"/i", msi, mode, "/norestart", "/l*v", log}
}

// msiOutcome mirrors msiOutcome in src/core/update.ts.
func msiOutcome(code int) string {
	switch code {
	case 0:
		return "ok"
	case 3010, 1641:
		return "reboot"
	case 1602:
		return "cancelled"
	case 1618:
		return "busy"
	case 1625, 1643:
		return "blocked"
	}
	return "failed"
}

type timing struct {
	exitWait    time.Duration // Kasboek closing
	othersWait  time.Duration // its helper processes closing
	othersPoll  time.Duration
	busyRetries int // another installation running (1618)
	busyWait    time.Duration
	sleep       func(time.Duration)
}

var realTiming = timing{exitWait: 120 * time.Second, othersWait: 30 * time.Second, othersPoll: 500 * time.Millisecond, busyRetries: 3, busyWait: 10 * time.Second, sleep: time.Sleep}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// writeResult replaces result.json in one step, so Kasboek never reads half of it.
func writeResult(pl updatePlan, code int, outcome string) error {
	raw, _ := json.Marshal(updateResult{Code: code, Outcome: outcome, ToVersion: pl.ToVersion, At: time.Now().UTC().Format(time.RFC3339)})
	tmp := pl.Result + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, pl.Result)
}

// waitForKasboek returns true once Kasboek and its helper processes are gone.
func waitForKasboek(p platform, pl updatePlan, t timing) bool {
	if h, err := p.openProcess(pl.PID); err == nil {
		// A different program under this id means Kasboek is already gone and the id was reused.
		img, ierr := p.imagePath(h)
		exited := true
		if ierr == nil && samePath(img, pl.Exe) {
			var werr error
			exited, werr = p.waitExit(h, t.exitWait)
			exited = exited && werr == nil
		}
		p.closeProcess(h)
		if !exited {
			return false
		}
	}
	for waited := time.Duration(0); ; waited += t.othersPoll {
		running, err := p.othersRunning(pl.Exe)
		if err == nil && !running {
			return true
		}
		if waited >= t.othersWait {
			return false
		}
		t.sleep(t.othersPoll)
	}
}

func runUpdate(p platform, u ui, pl updatePlan, t timing, passive bool) error {
	defer u.close()
	u.waiting()
	if !waitForKasboek(p, pl, t) {
		u.failed(pl.text(textFailed))
		return errors.Join(errors.New("kasboek did not close"), writeResult(pl, -1, "not_closed"))
	}
	sum, err := fileSHA256(pl.MSI)
	if err != nil || !strings.EqualFold(sum, pl.SHA256) {
		u.failed(pl.text(textFailed))
		return errors.Join(errors.New("update file does not match its checksum"), writeResult(pl, -1, "checksum"), relaunch(p, u, pl))
	}
	u.installing()
	code, err := p.runMsiexec(msiexecArgs(pl.MSI, pl.Log, passive))
	for retry := 0; err == nil && code == 1618 && retry < t.busyRetries; retry++ {
		t.sleep(t.busyWait)
		code, err = p.runMsiexec(msiexecArgs(pl.MSI, pl.Log, passive))
	}
	if err != nil {
		code = -1
	}
	outcome := msiOutcome(code)
	if outcome == "cancelled" {
		u.failed(pl.text(textCancelled))
	} else if outcome != "ok" && outcome != "reboot" {
		u.failed(pl.text(textFailed))
	}
	werr := writeResult(pl, code, outcome)
	return errors.Join(err, werr, relaunch(p, u, pl))
}

func relaunch(p platform, u ui, pl updatePlan) error {
	u.starting()
	return p.start(pl.Exe, pl.Args)
}
