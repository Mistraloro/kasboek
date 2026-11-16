//go:build !windows

package main

// startWindow: only Windows has an update window; elsewhere --apply-update does not run at all.
func startWindow(updatePlan) (ui, error) { return noUI{}, nil }
