//go:build !windows

package main

import "errors"

// applyUpdate is only needed on Windows: the other systems install updates another way.
func applyUpdate(string) error {
	return errors.New("--apply-update works only on Windows")
}
