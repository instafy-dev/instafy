package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type capturedLog struct {
	mu    sync.Mutex
	lines []string
}

func (captured *capturedLog) printf(format string, arguments ...any) {
	captured.mu.Lock()
	defer captured.mu.Unlock()
	captured.lines = append(captured.lines, fmt.Sprintf(format, arguments...))
}

func (captured *capturedLog) all() []string {
	captured.mu.Lock()
	defer captured.mu.Unlock()
	return append([]string(nil), captured.lines...)
}

func proxyWithLog(resolver ipResolver, dial dialContextFunc) (*egressProxy, *capturedLog) {
	proxy := newEgressProxy(testPolicy(resolver))
	proxy.dial = dial
	captured := &capturedLog{}
	proxy.failures.printf = captured.printf
	return proxy, captured
}

func connectThrough(t *testing.T, proxy *egressProxy, authority string) int {
	t.Helper()
	server := httptest.NewServer(proxy)
	defer server.Close()
	connection, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
	if err != nil {
		t.Fatalf("dial test proxy: %v", err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, "CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+"\r\n\r\n"); err != nil {
		t.Fatalf("write CONNECT request: %v", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatalf("read CONNECT response: %v", err)
	}
	return response.StatusCode
}

// Live drive, Oct 28: https://roborock.com/ failed in Instafy's browser with
// net::ERR_TUNNEL_CONNECTION_FAILED while other sites loaded. The apex's only
// address (203.107.60.192) never answers on 443 (plain HTTP on 80 redirects to
// www), so the proxy's dial timed out and it answered 502, which Chromium
// reports as a failed tunnel. The proxy's log said nothing about it.
func TestTunnelToASiteThatNeverAnswersIsLoggedWithoutItsHost(t *testing.T) {
	t.Parallel()

	proxy, captured := proxyWithLog(
		fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("203.107.60.192")}},
		func(context.Context, string, string) (net.Conn, error) {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: os.ErrDeadlineExceeded}
		},
	)
	if status := connectThrough(t, proxy, "roborock.com:443"); status != http.StatusBadGateway {
		t.Fatalf("expected 502 for an upstream that never answers, got %d", status)
	}
	lines := captured.all()
	if len(lines) != 1 || lines[0] != "browser egress tunnel failed (port 443): the site did not answer in time" {
		t.Fatalf("unexpected log: %#v", lines)
	}
	for _, line := range lines {
		if strings.Contains(line, "roborock") || strings.Contains(line, "203.107") {
			t.Fatalf("the log must not name the destination: %q", line)
		}
	}
}

func TestEachFailedDestinationIsLoggedWithAFixedReason(t *testing.T) {
	t.Parallel()

	refused := func(context.Context, string, string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	}
	unreachable := func(context.Context, string, string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.EHOSTUNREACH)}
	}
	public := fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34")}}
	for _, tc := range []struct {
		name      string
		resolver  ipResolver
		dial      dialContextFunc
		authority string
		status    int
		line      string
	}{
		{"refused", public, refused, "refusing.example:443", http.StatusBadGateway,
			"browser egress tunnel failed (port 443): the site refused the connection"},
		{"unreachable", public, unreachable, "far.example:443", http.StatusBadGateway,
			"browser egress tunnel failed (port 443): the site's address is unreachable from here"},
		{"not found", fakeResolver{err: &net.DNSError{Err: "no such host", Name: "missing.example", IsNotFound: true}}, refused,
			"missing.example:443", http.StatusBadGateway, "browser egress tunnel failed (port 443): name not found"},
		{"private", fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("10.0.0.7")}}, refused,
			"intranet.example:443", http.StatusForbidden, "browser egress tunnel failed (port 443): destination denied (DNS returned prohibited IP)"},
		{"port", public, refused, "public.example:8443", http.StatusForbidden,
			"browser egress tunnel failed (port 8443): destination denied (port is not allowed)"},
	} {
		proxy, captured := proxyWithLog(tc.resolver, tc.dial)
		if status := connectThrough(t, proxy, tc.authority); status != tc.status {
			t.Errorf("%s: expected %d, got %d", tc.name, tc.status, status)
		}
		lines := captured.all()
		if len(lines) != 1 || lines[0] != tc.line {
			t.Errorf("%s: unexpected log %#v", tc.name, lines)
		}
		host := strings.Split(tc.authority, ":")[0]
		for _, line := range lines {
			if strings.Contains(line, host) {
				t.Errorf("%s: the log must not name the destination: %q", tc.name, line)
			}
		}
	}

	// A plain HTTP request to a denied address is logged the same way.
	proxy, captured := proxyWithLog(fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("169.254.169.254")}}, refused)
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://metadata.test/", nil))
	if lines := captured.all(); len(lines) != 1 || lines[0] != "browser egress request failed (port 80): destination denied (DNS returned prohibited IP)" {
		t.Fatalf("unexpected log for a denied request: %#v", lines)
	}
}

func TestFailureLogIsBoundedPerMinute(t *testing.T) {
	t.Parallel()

	captured := &capturedLog{}
	clock := time.Unix(1_800_000_000, 0)
	failures := &failureLog{printf: captured.printf, now: func() time.Time { return clock }}
	for range failureLogLinesPerWindow + 15 {
		failures.record("tunnel", 443, "the site refused the connection")
	}
	if lines := captured.all(); len(lines) != failureLogLinesPerWindow {
		t.Fatalf("expected %d lines in a minute, got %d", failureLogLinesPerWindow, len(lines))
	}
	clock = clock.Add(failureLogWindow)
	failures.record("tunnel", 443, "the site refused the connection")
	lines := captured.all()
	if len(lines) != failureLogLinesPerWindow+2 ||
		lines[failureLogLinesPerWindow] != "browser egress: 15 more failed destinations were not logged" {
		t.Fatalf("expected the count of left-out lines first in the next minute, got %#v", lines[failureLogLinesPerWindow:])
	}
}
