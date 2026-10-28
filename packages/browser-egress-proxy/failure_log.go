package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Failed destinations are logged so a page that would not load can be told
// apart later: the site refused or never answered, its name did not resolve,
// or the policy denied it. Chromium reports all of them through the proxy as
// the same net::ERR_TUNNEL_CONNECTION_FAILED, and before this the proxy wrote
// nothing. A line names the request kind, port and a fixed reason; never the
// host, path or address, which are the person's browsing.
const (
	failureLogWindow         = time.Minute
	failureLogLinesPerWindow = 30
)

type failureLog struct {
	mu          sync.Mutex
	printf      func(format string, arguments ...any)
	now         func() time.Time
	windowStart time.Time
	written     int
	suppressed  int
}

func newFailureLog() *failureLog {
	return &failureLog{printf: log.Printf, now: time.Now}
}

// record writes one line, at most failureLogLinesPerWindow a minute; the
// first line of the next minute says how many were left out, so a page that
// fails many requests cannot fill the disk.
func (failures *failureLog) record(kind string, port uint16, reason string) {
	if failures == nil {
		return
	}
	failures.mu.Lock()
	defer failures.mu.Unlock()
	now := failures.now()
	if failures.windowStart.IsZero() || now.Sub(failures.windowStart) >= failureLogWindow {
		if failures.suppressed > 0 {
			failures.printf("browser egress: %d more failed destinations were not logged", failures.suppressed)
		}
		failures.windowStart = now
		failures.written = 0
		failures.suppressed = 0
	}
	if failures.written >= failureLogLinesPerWindow {
		failures.suppressed++
		return
	}
	failures.written++
	failures.printf("browser egress %s failed (port %s): %s", kind, portLabel(port), reason)
}

// recordError writes the line for a failed resolution or dial, with
// `reason`'s fixed text for err. A request the browser gave up on itself (it
// navigated away or dropped a speculative connection, so the request's
// context was cancelled) is not a failed destination and writes nothing.
func (failures *failureLog) recordError(kind string, port uint16, err error, reason func(error) string) {
	if errors.Is(err, context.Canceled) {
		return
	}
	failures.record(kind, port, reason(err))
}

func portLabel(port uint16) string {
	if port == 0 {
		return "unknown"
	}
	return strconv.Itoa(int(port))
}

// resolutionFailureReason is the fixed reason of a failed policy check or
// name lookup.
func resolutionFailureReason(err error) string {
	if errors.Is(err, errDestinationDenied) {
		if reason := deniedDestinationReason(err); reason != "" {
			return "destination denied (" + reason + ")"
		}
		return "destination denied"
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		switch {
		case dnsError.IsNotFound:
			return "name not found"
		case dnsError.IsTimeout:
			return "name lookup timed out"
		default:
			return "name lookup failed"
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "name lookup timed out"
	}
	return "name lookup failed"
}

// dialFailureReason is the fixed reason the site's address did not take the
// connection.
func dialFailureReason(err error) string {
	var timeout interface{ Timeout() bool }
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		return "the site did not answer in time"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "the site refused the connection"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "the site's address is unreachable from here"
	case errors.Is(err, syscall.ECONNRESET):
		return "the site reset the connection"
	case errors.Is(err, os.ErrDeadlineExceeded):
		return "the site did not answer in time"
	default:
		return "the connection failed"
	}
}
