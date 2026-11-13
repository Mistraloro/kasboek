//go:build !windows

package main

import (
	"io"
	"net"
	"time"
)

func dial(path string) (io.ReadWriteCloser, error) {
	return net.DialTimeout("unix", path, 3*time.Second)
}
