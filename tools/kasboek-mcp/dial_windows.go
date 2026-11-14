//go:build windows

package main

import (
	"errors"
	"io"
	"os"
	"syscall"
	"time"
)

const errPipeBusy = syscall.Errno(231)

// A named pipe opens like a file. Each request uses its own connection and does strictly
// write-then-read, so the synchronous handle never has a read and a write pending at once.
// When every pipe instance is busy (several calls at once), wait briefly and try again.
func dial(path string) (io.ReadWriteCloser, error) {
	deadline := time.Now().Add(2 * time.Second)
	for {
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err == nil || !errors.Is(err, errPipeBusy) || time.Now().After(deadline) {
			return f, err
		}
		time.Sleep(25 * time.Millisecond)
	}
}
