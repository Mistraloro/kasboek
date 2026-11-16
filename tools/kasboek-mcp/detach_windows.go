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

// detachVisible starts Kasboek again after an update: its first window must show. HideWindow would
// make Windows hide that window (the launch window), so it is not set; and DETACHED_PROCESS is left
// out because a program with a window needs no console to be freed of. The new process lives on
// when this helper exits (Windows has no parent-child kill). CREATE_NEW_PROCESS_GROUP only keeps
// Ctrl+C aimed at this helper from reaching it. CREATE_BREAKAWAY_FROM_JOB is not used: it makes the
// start fail when the job does not allow breakaway.
func detachVisible(cmd *exec.Cmd) {
	const createNewProcessGroup = 0x00000200
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}
