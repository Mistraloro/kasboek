//go:build windows

package main

import (
	"testing"
	"time"
)

// These create the real window. Without an interactive desktop (a service session, say) it can't
// be created, and the test skips: the update itself then falls back to Windows Installer's dialog.
func openTestWindow(t *testing.T, theme string) *window {
	t.Helper()
	pl := testPlan(t)
	pl.Theme = theme
	u, err := startWindow(pl)
	if err != nil {
		t.Skipf("no window could be created here: %v", err)
	}
	w, ok := u.(*window)
	if !ok {
		t.Fatalf("unexpected ui %T", u)
	}
	return w
}

func TestWindowOpensRunsThroughTheStepsAndCloses(t *testing.T) {
	for _, theme := range []string{"light", "dark"} {
		w := openTestWindow(t, theme)
		w.mu.Lock()
		h := w.hwnd
		w.mu.Unlock()
		if h == 0 {
			t.Fatal("no window handle")
		}
		if ok, _, _ := procIsWindow.Call(h); ok == 0 {
			t.Fatal("the window does not exist")
		}
		w.waiting()
		time.Sleep(100 * time.Millisecond)
		w.installing()
		time.Sleep(200 * time.Millisecond) // a few timer ticks and paints
		w.starting()
		start := time.Now()
		w.close()
		if time.Since(start) > 2*time.Second {
			t.Fatal("close took too long")
		}
		select {
		case <-w.done:
		default:
			t.Fatal("the window thread is still running")
		}
		if ok, _, _ := procIsWindow.Call(h); ok != 0 {
			t.Fatal("the window is still there")
		}
		// After close nothing may hang or panic.
		w.installing()
		w.failed("x")
		w.close()
	}
}

func TestWindowIgnoresCloseRequests(t *testing.T) {
	w := openTestWindow(t, "light")
	defer w.close()
	w.mu.Lock()
	h := w.hwnd
	w.mu.Unlock()
	// SendMessage waits for the window procedure, so the answer is its own.
	procSendMessage.Call(h, wmClose, 0, 0)
	time.Sleep(50 * time.Millisecond)
	if ok, _, _ := procIsWindow.Call(h); ok == 0 {
		t.Fatal("a close request closed the window")
	}
}

func TestFailedMessageStaysUntilItWasShownLongEnough(t *testing.T) {
	w := openTestWindow(t, "dark")
	w.installing()
	w.failed("failed")
	w.starting()
	if m := w.snapshot(); m.step != stepFailed || m.text != "failed" {
		t.Fatalf("%+v", m)
	}
	start := time.Now()
	w.close()
	if d := time.Since(start); d < failedShown-time.Second || d > failedShown+3*time.Second {
		t.Fatalf("close after a failure took %v", d)
	}
}
