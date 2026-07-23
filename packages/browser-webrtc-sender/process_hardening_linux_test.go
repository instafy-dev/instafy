//go:build linux

package main

import (
	"syscall"
	"testing"
)

const prGetDumpable = 3

func TestHardenProcessDisablesDumping(t *testing.T) {
	if err := hardenProcess(); err != nil {
		t.Fatalf("harden process: %v", err)
	}
	dumpable, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prGetDumpable, 0, 0, 0, 0, 0)
	if errno != 0 {
		t.Fatalf("prctl(PR_GET_DUMPABLE): %v", errno)
	}
	if dumpable != 0 {
		t.Fatalf("process remained dumpable: %d", dumpable)
	}
}
