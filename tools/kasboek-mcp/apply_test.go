package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakePlatform struct {
	events      []string
	openErr     error
	image       string
	exits       bool
	othersLeft  int // polls that still see another Kasboek process
	codes       []int
	msiexecRuns [][]string
	started     [][]string
}

func (f *fakePlatform) log(s string) { f.events = append(f.events, s) }

func (f *fakePlatform) openProcess(pid int) (procHandle, error) {
	f.log("open")
	return 7, f.openErr
}
func (f *fakePlatform) closeProcess(procHandle) { f.log("close") }
func (f *fakePlatform) waitExit(procHandle, time.Duration) (bool, error) {
	f.log("wait")
	return f.exits, nil
}
func (f *fakePlatform) imagePath(procHandle) (string, error) {
	f.log("image")
	return f.image, nil
}
func (f *fakePlatform) othersRunning(string) (bool, error) {
	f.log("others")
	if f.othersLeft > 0 {
		f.othersLeft--
		return true, nil
	}
	return false, nil
}
func (f *fakePlatform) runMsiexec(args []string) (int, error) {
	f.log("msiexec")
	f.msiexecRuns = append(f.msiexecRuns, args)
	code := f.codes[0]
	if len(f.codes) > 1 {
		f.codes = f.codes[1:]
	}
	return code, nil
}
func (f *fakePlatform) start(exe string, args []string) error {
	f.log("start")
	f.started = append(f.started, append([]string{exe}, args...))
	return nil
}

type fakeUI struct{ events []string }

func (u *fakeUI) waiting()        { u.events = append(u.events, "waiting") }
func (u *fakeUI) installing()     { u.events = append(u.events, "installing") }
func (u *fakeUI) starting()       { u.events = append(u.events, "starting") }
func (u *fakeUI) failed(m string) { u.events = append(u.events, "failed:"+m) }
func (u *fakeUI) close()          { u.events = append(u.events, "close") }

func testTiming(slept *[]time.Duration) timing {
	t := realTiming
	t.sleep = func(d time.Duration) { *slept = append(*slept, d) }
	return t
}

// A plan with a real msi file (any bytes) next to it in a folder with a space and an accent.
func testPlan(t *testing.T) updatePlan {
	dir := filepath.Join(t.TempDir(), "Jérôme Dupont", "updates")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	msi := filepath.Join(dir, "Kasboek-1.2.0-win-x64.msi")
	body := []byte("not really an installer")
	if err := os.WriteFile(msi, body, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	exe := filepath.Join(dir, "Kasboek.exe")
	if err := os.WriteFile(exe, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	pl := updatePlan{V: 1, PID: 4242, Exe: exe, Args: []string{"--x"}, MSI: msi, SHA256: hex.EncodeToString(sum[:]), Log: filepath.Join(dir, "install.log"), Result: filepath.Join(dir, "result.json"), ToVersion: "1.2.0"}
	pl.Texts.Failed, pl.Texts.Cancelled = "failed text", "cancelled text"
	return pl
}

func readResult(t *testing.T, pl updatePlan) updateResult {
	raw, err := os.ReadFile(pl.Result)
	if err != nil {
		t.Fatal(err)
	}
	var r updateResult
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestUpdateStepsInOrder(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: pl.Exe, exits: true, codes: []int{0}}
	u := &fakeUI{}
	var slept []time.Duration
	if err := runUpdate(f, u, pl, testTiming(&slept), true); err != nil {
		t.Fatal(err)
	}
	want := []string{"open", "image", "wait", "close", "others", "msiexec", "start"}
	if !reflect.DeepEqual(f.events, want) {
		t.Fatalf("steps %v, want %v", f.events, want)
	}
	if !reflect.DeepEqual(u.events, []string{"waiting", "installing", "starting", "close"}) {
		t.Fatalf("ui %v", u.events)
	}
	if !reflect.DeepEqual(f.started, [][]string{{pl.Exe, "--x"}}) {
		t.Fatalf("started %v", f.started)
	}
	r := readResult(t, pl)
	if r.Code != 0 || r.Outcome != "ok" || r.ToVersion != "1.2.0" {
		t.Fatalf("result %+v", r)
	}
	if _, err := time.Parse(time.RFC3339, r.At); err != nil {
		t.Fatalf("at %q: %v", r.At, err)
	}
}

func TestReusedProcessIdIsNotWaitedFor(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: `C:\Windows\notepad.exe`, codes: []int{0}}
	if err := runUpdate(f, &fakeUI{}, pl, testTiming(new([]time.Duration)), true); err != nil {
		t.Fatal(err)
	}
	for _, e := range f.events {
		if e == "wait" {
			t.Fatalf("waited on a process that is not Kasboek: %v", f.events)
		}
	}
	if len(f.msiexecRuns) != 1 {
		t.Fatal("did not install")
	}
}

func TestKasboekNeverClosesMeansNoInstallAndNoRelaunch(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: pl.Exe, exits: false, codes: []int{0}}
	u := &fakeUI{}
	if err := runUpdate(f, u, pl, testTiming(new([]time.Duration)), true); err == nil {
		t.Fatal("expected an error")
	}
	if len(f.msiexecRuns) != 0 || len(f.started) != 0 {
		t.Fatalf("installed or relaunched: %v %v", f.msiexecRuns, f.started)
	}
	if r := readResult(t, pl); r.Outcome != "not_closed" {
		t.Fatalf("result %+v", r)
	}
	if !reflect.DeepEqual(u.events, []string{"waiting", "failed:failed text", "close"}) {
		t.Fatalf("ui %v", u.events)
	}
}

func TestChildProcessesThatStayMeanNotClosed(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: pl.Exe, exits: true, othersLeft: 1 << 30, codes: []int{0}}
	var slept []time.Duration
	if err := runUpdate(f, &fakeUI{}, pl, testTiming(&slept), true); err == nil {
		t.Fatal("expected an error")
	}
	var total time.Duration
	for _, d := range slept {
		total += d
	}
	if total != 30*time.Second || len(f.msiexecRuns) != 0 || len(f.started) != 0 {
		t.Fatalf("waited %v, ran %v, started %v", total, f.msiexecRuns, f.started)
	}
	if r := readResult(t, pl); r.Outcome != "not_closed" {
		t.Fatalf("result %+v", r)
	}
}

func TestChildProcessesThatLeaveAreWaitedFor(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: pl.Exe, exits: true, othersLeft: 3, codes: []int{0}}
	if err := runUpdate(f, &fakeUI{}, pl, testTiming(new([]time.Duration)), true); err != nil {
		t.Fatal(err)
	}
	if len(f.msiexecRuns) != 1 {
		t.Fatal("did not install")
	}
}

func TestFailedInstallStillRelaunches(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: pl.Exe, exits: true, codes: []int{1603}}
	u := &fakeUI{}
	if err := runUpdate(f, u, pl, testTiming(new([]time.Duration)), true); err != nil {
		t.Fatal(err)
	}
	if len(f.started) != 1 {
		t.Fatal("Kasboek was not opened again")
	}
	if r := readResult(t, pl); r.Code != 1603 || r.Outcome != "failed" {
		t.Fatalf("result %+v", r)
	}
	if !reflect.DeepEqual(u.events, []string{"waiting", "installing", "failed:failed text", "starting", "close"}) {
		t.Fatalf("ui %v", u.events)
	}
}

func TestCancelledInstallSaysSo(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: pl.Exe, exits: true, codes: []int{1602}}
	u := &fakeUI{}
	if err := runUpdate(f, u, pl, testTiming(new([]time.Duration)), true); err != nil {
		t.Fatal(err)
	}
	if u.events[2] != "failed:cancelled text" || readResult(t, pl).Outcome != "cancelled" {
		t.Fatalf("ui %v", u.events)
	}
}

func TestBusyInstallerIsRetriedThreeTimes(t *testing.T) {
	pl := testPlan(t)
	f := &fakePlatform{image: pl.Exe, exits: true, codes: []int{1618, 1618, 0}}
	var slept []time.Duration
	if err := runUpdate(f, &fakeUI{}, pl, testTiming(&slept), true); err != nil {
		t.Fatal(err)
	}
	if len(f.msiexecRuns) != 3 || readResult(t, pl).Outcome != "ok" {
		t.Fatalf("runs %d", len(f.msiexecRuns))
	}

	f = &fakePlatform{image: pl.Exe, exits: true, codes: []int{1618}}
	slept = nil
	if err := runUpdate(f, &fakeUI{}, pl, testTiming(&slept), true); err != nil {
		t.Fatal(err)
	}
	if len(f.msiexecRuns) != 4 {
		t.Fatalf("runs %d, want 1 + 3 retries", len(f.msiexecRuns))
	}
	tens := 0
	for _, d := range slept {
		if d == 10*time.Second {
			tens++
		}
	}
	if tens != 3 || len(f.started) != 1 {
		t.Fatalf("pauses %v, started %v", slept, f.started)
	}
	if r := readResult(t, pl); r.Code != 1618 || r.Outcome != "busy" {
		t.Fatalf("result %+v", r)
	}
}

func TestChecksumMismatchSkipsInstallButRelaunches(t *testing.T) {
	pl := testPlan(t)
	pl.SHA256 = strings.Repeat("0", 64)
	f := &fakePlatform{image: pl.Exe, exits: true, codes: []int{0}}
	if err := runUpdate(f, &fakeUI{}, pl, testTiming(new([]time.Duration)), true); err == nil {
		t.Fatal("expected an error")
	}
	if len(f.msiexecRuns) != 0 || len(f.started) != 1 {
		t.Fatalf("ran %v, started %v", f.msiexecRuns, f.started)
	}
	if r := readResult(t, pl); r.Outcome != "checksum" {
		t.Fatalf("result %+v", r)
	}
}

func TestMsiexecArgs(t *testing.T) {
	got := msiexecArgs(`C:\a b\x.msi`, `C:\a b\i.log`, true)
	want := []string{"/i", `C:\a b\x.msi`, "/passive", "/norestart", "/l*v", `C:\a b\i.log`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	if msiexecArgs("a", "b", false)[2] != "/qn" {
		t.Fatal("expected /qn")
	}
}

func TestMsiOutcome(t *testing.T) {
	cases := map[int]string{0: "ok", 3010: "reboot", 1641: "reboot", 1602: "cancelled", 1618: "busy", 1625: "blocked", 1643: "blocked", 1603: "failed", -1: "failed"}
	for code, want := range cases {
		if got := msiOutcome(code); got != want {
			t.Errorf("%d: %s, want %s", code, got, want)
		}
	}
}

func TestValidatePlan(t *testing.T) {
	pl := testPlan(t)
	dir := filepath.Dir(pl.MSI)
	if err := validatePlan(pl, dir); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(p *updatePlan){
		"version":     func(p *updatePlan) { p.V = 2 },
		"pid":         func(p *updatePlan) { p.PID = 0 },
		"checksum":    func(p *updatePlan) { p.SHA256 = "abc" },
		"relative":    func(p *updatePlan) { p.Log = "install.log" },
		"other dir":   func(p *updatePlan) { p.MSI = filepath.Join(filepath.Dir(dir), "x.msi") },
		"not msi":     func(p *updatePlan) { p.MSI = filepath.Join(dir, "x.exe") },
		"not Kasboek": func(p *updatePlan) { p.Exe = filepath.Join(dir, "other.exe") },
		"missing exe": func(p *updatePlan) { p.Exe = filepath.Join(dir, "sub", "Kasboek.exe") },
	}
	for name, mutate := range bad {
		p := pl
		mutate(&p)
		if err := validatePlan(p, dir); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLoadPlanReadsTheFileNextToIt(t *testing.T) {
	pl := testPlan(t)
	raw, _ := json.Marshal(pl)
	file := filepath.Join(filepath.Dir(pl.MSI), "apply.json")
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := loadPlan(file)
	if err != nil || got.MSI != pl.MSI {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := loadPlan(filepath.Join(t.TempDir(), "none.json")); err == nil {
		t.Fatal("expected an error")
	}
}
