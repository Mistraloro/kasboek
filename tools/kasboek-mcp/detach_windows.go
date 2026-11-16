package main

import (
	"os/exec"
	"syscall"
)

// detach lets Kasboek keep running when the Claude app ends this helper, without a console window.
func detach(cmd *exec.Cmd) {
	const createNewProcessGroup, detachedProcess = 0x00000200, 0x00000008
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup | detachedProcess, HideWindow: true}
}
