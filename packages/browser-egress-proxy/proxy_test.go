package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeResolver struct {
	addresses []netip.Addr
	err       error
}

func (resolver fakeResolver) LookupNetIP(
	_ context.Context,
	_ string,
	_ string,
) ([]netip.Addr, error) {
	return resolver.addresses, resolver.err
}

func testPolicy(resolver ipResolver) destinationResolver {
	return destinationResolver{
		resolver: resolver,
		allowedPorts: map[uint16]struct{}{
			80:  {},
			443: {},
		},
		timeout: time.Second,
	}
}

func TestDestinationIPPolicy(t *testing.T) {
	t.Parallel()

	denied := []string{
		"0.0.0.0",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"192.168.1.1",
		"198.18.0.1",
		"224.0.0.1",
		"240.0.0.1",
		"::",
		"::1",
		"fc00::1",
		"fd00:ec2::254",
		"fe80::1",
		"ff02::1",
		"::ffff:10.0.0.1",
		"::ffff:127.0.0.1",
		"::a00:1",
		"64:ff9b::a00:1",
		"2001:0000:4136:e378:8000:63bf:3fff:fdd2",
		"2002:0a00:0001::",
	}
	for _, raw := range denied {
		address := netip.MustParseAddr(raw)
		if destinationIPAllowed(address) {
			t.Errorf("expected %s to be denied", raw)
		}
	}

	for _, raw := range []string{"1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"} {
		address := netip.MustParseAddr(raw)
		if !destinationIPAllowed(address) {
			t.Errorf("expected %s to be allowed", raw)
		}
	}
}

func TestResolverRejectsMixedPublicAndPrivateDNSAnswers(t *testing.T) {
	t.Parallel()

	policy := testPolicy(fakeResolver{addresses: []netip.Addr{
		netip.MustParseAddr("93.184.216.34"),
		netip.MustParseAddr("10.0.0.7"),
	}})
	_, err := policy.resolve(context.Background(), "example.test", "443", 443)
	if !errors.Is(err, errDestinationDenied) {
		t.Fatalf("mixed DNS answer must fail closed, got %v", err)
	}
}

func TestDestinationHostPolicyRejectsLocalAndMetadataNames(t *testing.T) {
	t.Parallel()

	for _, host := range []string{
		"localhost",
		"service.localhost",
		"printer.local",
		"metadata.google.internal",
		"instance-data.ec2.internal",
		"metadata",
	} {
		if _, err := normalizeDestinationHost(host); !errors.Is(err, errDestinationDenied) {
			t.Errorf("expected %q to be denied, got %v", host, err)
		}
	}
	if host, err := normalizeDestinationHost("EXAMPLE.COM."); err != nil || host != "example.com" {
		t.Fatalf("expected public FQDN normalization, got host=%q err=%v", host, err)
	}
}

func TestResolverPinsValidatedPublicAddresses(t *testing.T) {
	t.Parallel()

	policy := testPolicy(fakeResolver{addresses: []netip.Addr{
		netip.MustParseAddr("93.184.216.34"),
		netip.MustParseAddr("2606:2800:220:1:248:1893:25c8:1946"),
	}})
	target, err := policy.resolve(context.Background(), "example.test", "", 80)
	if err != nil {
		t.Fatalf("resolve public target: %v", err)
	}
	got := target.dialAddresses()
	if len(got) != 2 || got[0] != "93.184.216.34:80" || got[1] != "[2606:2800:220:1:248:1893:25c8:1946]:80" {
		t.Fatalf("unexpected pinned addresses: %#v", got)
	}
}

func TestHTTPProxyDialsValidatedIPAndStripsProxyCredentials(t *testing.T) {
	t.Parallel()

	proxy := newEgressProxy(testPolicy(fakeResolver{addresses: []netip.Addr{
		netip.MustParseAddr("93.184.216.34"),
	}}))
	var mu sync.Mutex
	var dialed string
	var upstreamRequest *http.Request
	proxy.dial = func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" {
			t.Fatalf("unexpected network: %s", network)
		}
		mu.Lock()
		dialed = address
		mu.Unlock()
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			request, err := http.ReadRequest(bufio.NewReader(server))
			if err != nil {
				return
			}
			mu.Lock()
			upstreamRequest = request
			mu.Unlock()
			_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
		}()
		return client, nil
	}

	request := httptest.NewRequest(http.MethodGet, "http://example.test/resource", nil)
	request.Header.Set("Proxy-Authorization", "Basic secret")
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "ok" {
		t.Fatalf("unexpected response: status=%d body=%q", response.Code, response.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if dialed != "93.184.216.34:80" {
		t.Fatalf("proxy dialed unpinned address %q", dialed)
	}
	if upstreamRequest == nil || upstreamRequest.Host != "example.test" {
		t.Fatalf("unexpected upstream request: %#v", upstreamRequest)
	}
	if upstreamRequest.Header.Get("Proxy-Authorization") != "" {
		t.Fatal("proxy credentials leaked upstream")
	}
}

func TestConnectProxyDialsValidatedIPAndBridgesTunnel(t *testing.T) {
	t.Parallel()

	proxy := newEgressProxy(testPolicy(fakeResolver{addresses: []netip.Addr{
		netip.MustParseAddr("93.184.216.34"),
	}}))
	dialed := make(chan string, 1)
	proxy.dial = func(_ context.Context, _ string, address string) (net.Conn, error) {
		dialed <- address
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			buffer := make([]byte, 4)
			if _, err := io.ReadFull(server, buffer); err == nil {
				_, _ = server.Write(buffer)
			}
		}()
		return client, nil
	}

	server := httptest.NewServer(proxy)
	defer server.Close()
	connection, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
	if err != nil {
		t.Fatalf("dial test proxy: %v", err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n"); err != nil {
		t.Fatalf("write CONNECT request: %v", err)
	}
	reader := bufio.NewReader(connection)
	request := &http.Request{Method: http.MethodConnect}
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		t.Fatalf("read CONNECT response: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected CONNECT status: %s", response.Status)
	}

	if _, err := connection.Write([]byte("ping")); err != nil {
		t.Fatalf("write tunnel payload: %v", err)
	}
	echo := make([]byte, 4)
	if _, err := io.ReadFull(reader, echo); err != nil {
		t.Fatalf("read tunnel echo: %v", err)
	}
	if string(echo) != "ping" {
		t.Fatalf("unexpected tunnel echo %q", echo)
	}
	select {
	case address := <-dialed:
		if address != "93.184.216.34:443" {
			t.Fatalf("CONNECT dialed unpinned address %q", address)
		}
	case <-time.After(time.Second):
		t.Fatal("CONNECT did not dial upstream")
	}
}

func TestPrivateDestinationIsDeniedBeforeDial(t *testing.T) {
	t.Parallel()

	proxy := newEgressProxy(testPolicy(fakeResolver{addresses: []netip.Addr{
		netip.MustParseAddr("169.254.169.254"),
	}}))
	proxy.dial = func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("denied destination must not be dialed")
		return nil, errors.New("unreachable")
	}
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://metadata.test/", nil))
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden, got %d", response.Code)
	}
}

func TestConfigRejectsNonLoopbackBindingAndInvalidPorts(t *testing.T) {
	t.Setenv("INSTAFY_BROWSER_EGRESS_PROXY_BIND", "0.0.0.0:9226")
	if _, err := loadConfig(); err == nil {
		t.Fatal("non-loopback bind must fail")
	}

	t.Setenv("INSTAFY_BROWSER_EGRESS_PROXY_BIND", "127.0.0.1:9226")
	t.Setenv("INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS", "443,0")
	if _, err := loadConfig(); err == nil {
		t.Fatal("invalid allowed port must fail")
	}
}
