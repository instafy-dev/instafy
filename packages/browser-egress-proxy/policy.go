package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

const (
	defaultDNSResolveTimeout = 5 * time.Second
	maxResolvedAddresses     = 16
)

var errDestinationDenied = errors.New("destination denied by browser egress policy")

type ipResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type resolvedTarget struct {
	host      string
	port      uint16
	addresses []netip.Addr
}

type destinationResolver struct {
	resolver     ipResolver
	allowedPorts map[uint16]struct{}
	timeout      time.Duration
}

var deniedIPv4Prefixes = mustPrefixes(
	"0.0.0.0/8",       // current network and unspecified aliases
	"10.0.0.0/8",      // RFC 1918
	"100.64.0.0/10",   // RFC 6598 carrier-grade NAT
	"127.0.0.0/8",     // loopback
	"169.254.0.0/16",  // link-local and cloud metadata
	"172.16.0.0/12",   // RFC 1918
	"192.0.0.0/24",    // IETF protocol assignments
	"192.0.2.0/24",    // documentation
	"192.88.99.0/24",  // deprecated 6to4 relay anycast
	"192.168.0.0/16",  // RFC 1918
	"198.18.0.0/15",   // RFC 2544 benchmarking
	"198.51.100.0/24", // documentation
	"203.0.113.0/24",  // documentation
	"224.0.0.0/4",     // multicast
	"240.0.0.0/4",     // reserved and limited broadcast
)

var deniedIPv6Prefixes = mustPrefixes(
	"::/96",          // unspecified and deprecated IPv4-compatible addresses
	"::1/128",        // loopback
	"64:ff9b::/96",   // NAT64 can otherwise translate to a blocked IPv4 target
	"64:ff9b:1::/48", // local-use NAT64
	"100::/64",       // discard-only
	"2001::/32",      // Teredo embeds an IPv4 destination outside this policy
	"2001:2::/48",    // benchmarking
	"2001:db8::/32",  // documentation
	"2002::/16",      // 6to4 embeds an IPv4 destination outside this policy
	"fc00::/7",       // unique-local
	"fe80::/10",      // link-local
	"ff00::/8",       // multicast
)

func mustPrefixes(values ...string) []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefixes = append(prefixes, netip.MustParsePrefix(value))
	}
	return prefixes
}

func destinationIPAllowed(raw netip.Addr) bool {
	if !raw.IsValid() || raw.Zone() != "" {
		return false
	}

	// Normalize IPv4-mapped IPv6 before every classification so ::ffff:10.0.0.1
	// cannot evade the IPv4 deny ranges.
	address := raw.Unmap()
	if address.IsUnspecified() || address.IsLoopback() || address.IsPrivate() ||
		address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsMulticast() || !address.IsGlobalUnicast() {
		return false
	}

	prefixes := deniedIPv6Prefixes
	if address.Is4() {
		prefixes = deniedIPv4Prefixes
	}
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func normalizeDestinationHost(raw string) (string, error) {
	host := strings.TrimSpace(raw)
	host = strings.TrimSuffix(host, ".")
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "\x00\r\n\t /\\%@") {
		return "", fmt.Errorf("%w: invalid host", errDestinationDenied)
	}

	if address, err := netip.ParseAddr(host); err == nil {
		if address.Zone() != "" || !destinationIPAllowed(address) {
			return "", fmt.Errorf("%w: prohibited IP", errDestinationDenied)
		}
		return address.Unmap().String(), nil
	}

	host = strings.ToLower(host)
	if host == "localhost" || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") ||
		host == "metadata" || host == "instance-data" {
		return "", fmt.Errorf("%w: local or metadata hostname", errDestinationDenied)
	}

	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return "", fmt.Errorf("%w: hostname must be fully qualified", errDestinationDenied)
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", fmt.Errorf("%w: invalid hostname label", errDestinationDenied)
		}
		for _, char := range label {
			if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
				return "", fmt.Errorf("%w: invalid hostname character", errDestinationDenied)
			}
		}
	}
	return host, nil
}

func parseDestinationPort(raw string, fallback uint16, allowed map[uint16]struct{}) (uint16, error) {
	port := fallback
	if strings.TrimSpace(raw) != "" {
		value, err := strconv.ParseUint(raw, 10, 16)
		if err != nil || value == 0 {
			return 0, fmt.Errorf("%w: invalid port", errDestinationDenied)
		}
		port = uint16(value)
	}
	if _, ok := allowed[port]; !ok {
		return 0, fmt.Errorf("%w: port is not allowed", errDestinationDenied)
	}
	return port, nil
}

func (policy destinationResolver) resolve(
	ctx context.Context,
	rawHost string,
	rawPort string,
	defaultPort uint16,
) (resolvedTarget, error) {
	host, err := normalizeDestinationHost(rawHost)
	if err != nil {
		return resolvedTarget{}, err
	}
	port, err := parseDestinationPort(rawPort, defaultPort, policy.allowedPorts)
	if err != nil {
		return resolvedTarget{}, err
	}

	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		return resolvedTarget{host: host, port: port, addresses: []netip.Addr{address.Unmap()}}, nil
	}

	resolveTimeout := policy.timeout
	if resolveTimeout <= 0 {
		resolveTimeout = defaultDNSResolveTimeout
	}
	resolveContext, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	addresses, err := policy.resolver.LookupNetIP(resolveContext, "ip", host)
	if err != nil {
		return resolvedTarget{}, fmt.Errorf("resolve destination: %w", err)
	}
	if len(addresses) == 0 || len(addresses) > maxResolvedAddresses {
		return resolvedTarget{}, fmt.Errorf("resolve destination: invalid address count")
	}

	unique := make(map[netip.Addr]struct{}, len(addresses))
	validated := make([]netip.Addr, 0, len(addresses))
	for _, rawAddress := range addresses {
		address := rawAddress.Unmap()
		// Fail the entire resolution if any answer is prohibited. Selecting only a
		// public answer from a mixed public/private set would preserve the DNS
		// rebinding primitive for a later connection attempt.
		if !destinationIPAllowed(address) {
			return resolvedTarget{}, fmt.Errorf("%w: DNS returned prohibited IP", errDestinationDenied)
		}
		if _, exists := unique[address]; exists {
			continue
		}
		unique[address] = struct{}{}
		validated = append(validated, address)
	}
	if len(validated) == 0 {
		return resolvedTarget{}, fmt.Errorf("resolve destination: no usable addresses")
	}
	return resolvedTarget{host: host, port: port, addresses: validated}, nil
}

func (target resolvedTarget) dialAddresses() []string {
	addresses := make([]string, 0, len(target.addresses))
	for _, address := range target.addresses {
		addresses = append(addresses, net.JoinHostPort(address.String(), strconv.Itoa(int(target.port))))
	}
	return addresses
}
