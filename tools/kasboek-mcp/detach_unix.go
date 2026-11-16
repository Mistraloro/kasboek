//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detach lets Kasboek keep running when the Claude app ends this helper.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
