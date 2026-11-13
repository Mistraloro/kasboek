//go:build windows

package main

import (
	"io"
	"os"
)

// A named pipe opens like a file. Each request uses its own connection and does strictly
// write-then-read, so the synchronous handle never has a read and a write pending at once.
func dial(path string) (io.ReadWriteCloser, error) {
	return os.OpenFile(path, os.O_RDWR, 0)
}
