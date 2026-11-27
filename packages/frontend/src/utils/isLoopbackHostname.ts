/**
 * Whether a URL's host is this machine: `localhost`, `127.0.0.1` or the IPv6
 * loopback address. `URL.hostname` writes an IPv6 address in brackets
 * (`[::1]`), so it counts with them and without.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
