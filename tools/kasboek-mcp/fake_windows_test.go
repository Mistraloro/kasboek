//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

type fakeListener struct {
	addr   string
	accept func() (io.ReadWriteCloser, error)
}

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procCreateNamedPipe  = kernel32.NewProc("CreateNamedPipeW")
	procConnectNamedPipe = kernel32.NewProc("ConnectNamedPipe")
)

const (
	pipeAccessDuplex = 0x3
	pipeTypeByte     = 0x0
	pipeWait         = 0x0
	unlimited        = 255
	errPipeConnected = syscall.Errno(535)
)

// A named-pipe server like the app's: one pipe instance per connection.
func listen(t *testing.T) fakeListener {
	name := fmt.Sprintf(`\\.\pipe\kb-mcp-test-%d`, time.Now().UnixNano())
	p, _ := syscall.UTF16PtrFromString(name)
	conns := make(chan io.ReadWriteCloser)
	// Several instances waiting at once, as Node's pipe server keeps.
	for i := 0; i < 4; i++ {
		go func() {
			for {
				h, _, _ := procCreateNamedPipe.Call(uintptr(unsafe.Pointer(p)), pipeAccessDuplex, pipeTypeByte|pipeWait, unlimited, 4096, 4096, 0, 0)
				if syscall.Handle(h) == syscall.InvalidHandle {
					return
				}
				if r, _, err := procConnectNamedPipe.Call(h, 0); r == 0 && err != errPipeConnected {
					syscall.CloseHandle(syscall.Handle(h))
					return
				}
				conns <- os.NewFile(h, name)
			}
		}()
	}
	return fakeListener{addr: name, accept: func() (io.ReadWriteCloser, error) { return <-conns, nil }}
}
