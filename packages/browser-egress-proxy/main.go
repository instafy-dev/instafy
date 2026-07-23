package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultBindAddress    = "127.0.0.1:9226"
	defaultAllowedPorts   = "80,443"
	defaultMaxConnections = 128
	maxRequestHeaders     = 32 * 1024
)

type config struct {
	bindAddress    string
	allowedPorts   map[uint16]struct{}
	maxConnections int
}

func main() {
	configuration, err := loadConfig()
	if err != nil {
		log.Fatalf("invalid browser egress proxy configuration: %v", err)
	}

	listener, err := net.Listen("tcp", configuration.bindAddress)
	if err != nil {
		log.Fatalf("listen on browser egress proxy loopback: %v", err)
	}
	listener = newLimitedListener(listener, configuration.maxConnections)

	proxy := newEgressProxy(destinationResolver{
		resolver:     net.DefaultResolver,
		allowedPorts: configuration.allowedPorts,
		timeout:      defaultDNSResolveTimeout,
	})
	server := &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    maxRequestHeaders,
	}

	shutdownContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownContext.Done()
		context, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(context)
	}()

	log.Printf(
		"Shared Browser egress proxy listening on %s (maxConnections=%d)",
		configuration.bindAddress,
		configuration.maxConnections,
	)
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig() (config, error) {
	bindAddress := envOrDefault("INSTAFY_BROWSER_EGRESS_PROXY_BIND", defaultBindAddress)
	host, rawPort, err := net.SplitHostPort(bindAddress)
	if err != nil {
		return config{}, fmt.Errorf("invalid bind address: %w", err)
	}
	bindIP, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil || !bindIP.IsLoopback() {
		return config{}, errors.New("bind address must use a literal loopback IP")
	}
	port, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil || port == 0 {
		return config{}, errors.New("bind address must contain a valid port")
	}

	allowedPorts, err := parseAllowedPorts(envOrDefault(
		"INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS",
		defaultAllowedPorts,
	))
	if err != nil {
		return config{}, err
	}
	maxConnections, err := parseBoundedInt(
		envOrDefault("INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS", strconv.Itoa(defaultMaxConnections)),
		1,
		1024,
	)
	if err != nil {
		return config{}, fmt.Errorf("invalid maximum connections: %w", err)
	}

	return config{
		bindAddress:    net.JoinHostPort(bindIP.String(), strconv.Itoa(int(port))),
		allowedPorts:   allowedPorts,
		maxConnections: maxConnections,
	}, nil
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func parseBoundedInt(raw string, minimum, maximum int) (int, error) {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("must be between %d and %d", minimum, maximum)
	}
	return value, nil
}
