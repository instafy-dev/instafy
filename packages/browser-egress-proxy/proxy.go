package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	dialTimeout               = 10 * time.Second
	responseHeaderTimeout     = 20 * time.Second
	tunnelIdleTimeout         = 2 * time.Minute
	maxUpstreamResponseHeader = 64 * 1024
)

type dialContextFunc func(context.Context, string, string) (net.Conn, error)

type egressProxy struct {
	policy destinationResolver
	dial   dialContextFunc
}

func newEgressProxy(policy destinationResolver) *egressProxy {
	dialer := &net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
	return &egressProxy{policy: policy, dial: dialer.DialContext}
}

func (proxy *egressProxy) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// Origin-form requests are only used by the entrypoint readiness probe. A
	// real forward-proxy request always has an absolute URL or CONNECT authority.
	if request.Method == http.MethodGet && !request.URL.IsAbs() && request.URL.Path == "/healthz" {
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Cache-Control", "no-store")
		response.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(response, `{"ok":true,"policy":"public-http-only"}`)
		return
	}

	if request.Method == http.MethodConnect {
		proxy.handleConnect(response, request)
		return
	}
	proxy.handleHTTP(response, request)
}

func (proxy *egressProxy) handleHTTP(response http.ResponseWriter, request *http.Request) {
	if !request.URL.IsAbs() || !strings.EqualFold(request.URL.Scheme, "http") || request.URL.User != nil {
		http.Error(response, "only absolute HTTP proxy requests are supported", http.StatusBadRequest)
		return
	}

	target, err := proxy.policy.resolve(request.Context(), request.URL.Hostname(), request.URL.Port(), 80)
	if err != nil {
		writeResolutionError(response, err)
		return
	}

	outbound := request.Clone(request.Context())
	outbound.RequestURI = ""
	outbound.URL.User = nil
	outbound.Host = request.URL.Host
	outbound.Header = request.Header.Clone()
	stripHopByHopHeaders(outbound.Header)
	outbound.Header.Del("Proxy-Authorization")
	outbound.Header.Del("Proxy-Connection")

	transport := &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		ForceAttemptHTTP2:      false,
		MaxConnsPerHost:        1,
		ResponseHeaderTimeout:  responseHeaderTimeout,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: maxUpstreamResponseHeader,
	}
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return proxy.dialResolvedTarget(ctx, network, target)
	}
	defer transport.CloseIdleConnections()

	upstream, err := transport.RoundTrip(outbound)
	if err != nil {
		http.Error(response, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer upstream.Body.Close()

	stripHopByHopHeaders(upstream.Header)
	copyHeaders(response.Header(), upstream.Header)
	response.WriteHeader(upstream.StatusCode)
	if _, err := io.Copy(response, upstream.Body); err != nil {
		log.Printf("browser egress response copy failed: %v", err)
	}
}

func (proxy *egressProxy) handleConnect(response http.ResponseWriter, request *http.Request) {
	authority := request.URL.Host
	if authority == "" {
		authority = request.RequestURI
	}
	if request.Host != "" && !strings.EqualFold(request.Host, authority) {
		http.Error(response, "CONNECT authority does not match Host", http.StatusBadRequest)
		return
	}
	host, rawPort, err := splitConnectAuthority(authority)
	if err != nil {
		http.Error(response, "invalid CONNECT authority", http.StatusBadRequest)
		return
	}
	target, err := proxy.policy.resolve(request.Context(), host, rawPort, 443)
	if err != nil {
		writeResolutionError(response, err)
		return
	}

	upstream, err := proxy.dialResolvedTarget(request.Context(), "tcp", target)
	if err != nil {
		http.Error(response, "upstream connection failed", http.StatusBadGateway)
		return
	}

	hijacker, ok := response.(http.Hijacker)
	if !ok {
		upstream.Close()
		http.Error(response, "CONNECT is unavailable", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	defer client.Close()
	defer upstream.Close()

	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err := buffered.Flush(); err != nil {
		return
	}

	if buffered.Reader.Buffered() > 0 {
		if _, err := io.CopyN(upstream, buffered.Reader, int64(buffered.Reader.Buffered())); err != nil {
			return
		}
	}
	bridgeTunnel(client, upstream, tunnelIdleTimeout)
}

func splitConnectAuthority(authority string) (string, string, error) {
	if strings.ContainsAny(authority, "\x00\r\n /\\@") {
		return "", "", errors.New("invalid CONNECT authority")
	}
	host, port, err := net.SplitHostPort(authority)
	if err != nil || strings.TrimSpace(host) == "" || strings.TrimSpace(port) == "" {
		return "", "", errors.New("CONNECT authority must include a host and port")
	}
	return host, port, nil
}

func (proxy *egressProxy) dialResolvedTarget(
	ctx context.Context,
	network string,
	target resolvedTarget,
) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("unsupported network %q", network)
	}
	var lastErr error
	for _, address := range target.dialAddresses() {
		connection, err := proxy.dial(ctx, "tcp", address)
		if err == nil {
			return connection, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no validated destination addresses")
	}
	return nil, lastErr
}

func writeResolutionError(response http.ResponseWriter, err error) {
	if errors.Is(err, errDestinationDenied) {
		http.Error(response, "destination denied", http.StatusForbidden)
		return
	}
	http.Error(response, "destination resolution failed", http.StatusBadGateway)
}

func stripHopByHopHeaders(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			header.Del(strings.TrimSpace(token))
		}
	}
	for _, name := range []string{
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Proxy-Connection",
		"TE",
		"Trailer",
		"Transfer-Encoding",
		"Upgrade",
	} {
		header.Del(name)
	}
}

func copyHeaders(destination, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func bridgeTunnel(client, upstream net.Conn, idleTimeout time.Duration) {
	var once sync.Once
	closeBoth := func() {
		_ = client.Close()
		_ = upstream.Close()
	}
	done := make(chan struct{}, 2)
	go func() {
		copyWithIdleTimeout(upstream, client, idleTimeout)
		once.Do(closeBoth)
		done <- struct{}{}
	}()
	go func() {
		copyWithIdleTimeout(client, upstream, idleTimeout)
		once.Do(closeBoth)
		done <- struct{}{}
	}()
	<-done
}

func copyWithIdleTimeout(destination, source net.Conn, idleTimeout time.Duration) {
	buffer := make([]byte, 32*1024)
	for {
		_ = source.SetReadDeadline(time.Now().Add(idleTimeout))
		read, readErr := source.Read(buffer)
		if read > 0 {
			_ = destination.SetWriteDeadline(time.Now().Add(idleTimeout))
			written := 0
			for written < read {
				count, writeErr := destination.Write(buffer[written:read])
				if writeErr != nil {
					return
				}
				if count == 0 {
					return
				}
				written += count
			}
		}
		if readErr != nil {
			return
		}
	}
}

type limitedListener struct {
	net.Listener
	semaphore chan struct{}
}

func newLimitedListener(listener net.Listener, maximum int) net.Listener {
	return &limitedListener{Listener: listener, semaphore: make(chan struct{}, maximum)}
}

func (listener *limitedListener) Accept() (net.Conn, error) {
	for {
		connection, err := listener.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case listener.semaphore <- struct{}{}:
			return &limitedConnection{Conn: connection, release: func() { <-listener.semaphore }}, nil
		default:
			_ = connection.Close()
		}
	}
}

type limitedConnection struct {
	net.Conn
	releaseOnce sync.Once
	release     func()
}

func (connection *limitedConnection) Close() error {
	err := connection.Conn.Close()
	connection.releaseOnce.Do(connection.release)
	return err
}

func parseAllowedPorts(raw string) (map[uint16]struct{}, error) {
	allowed := make(map[uint16]struct{})
	for _, part := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		value, err := strconv.ParseUint(trimmed, 10, 16)
		if err != nil || value == 0 {
			return nil, fmt.Errorf("invalid allowed port %q", trimmed)
		}
		allowed[uint16(value)] = struct{}{}
		if len(allowed) > 16 {
			return nil, errors.New("too many allowed ports")
		}
	}
	if len(allowed) == 0 {
		return nil, errors.New("at least one allowed port is required")
	}
	return allowed, nil
}
