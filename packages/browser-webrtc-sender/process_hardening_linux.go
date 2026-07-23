//go:build linux

package main

import (
	"fmt"
	"syscall"
)

const prSetDumpable = 4

func hardenProcess() error {
	_, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prSetDumpable, 0, 0, 0, 0, 0)
	if errno != 0 {
		return fmt.Errorf("prctl(PR_SET_DUMPABLE, 0): %w", errno)
	}
	return nil
}
