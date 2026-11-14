//go:build !windows

package main

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fakeListener struct {
	addr   string
	accept func() (io.ReadWriteCloser, error)
}

func listen(t *testing.T) fakeListener {
	sock := filepath.Join(os.TempDir(), "kb-mcp-test-"+time.Now().Format("150405.000000")+".sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close(); os.Remove(sock) })
	return fakeListener{addr: sock, accept: func() (io.ReadWriteCloser, error) { return ln.Accept() }}
}
