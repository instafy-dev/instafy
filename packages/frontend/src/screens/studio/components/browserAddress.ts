const DOMAIN_WITH_PORT_PATTERN =
  /^(?:localhost|(?:[a-z\d-]+\.)+[a-z\d-]+|\d{1,3}(?:\.\d{1,3}){3}):\d+(?:[/?#]|$)/i;
const EXPLICIT_SCHEME_PATTERN = /^([a-z][a-z\d+.-]*):/i;

/**
 * Shared address policy for both Personal and Shared Browser chrome.
 * Browser engines still enforce their own network policy; this only keeps the
 * user-facing navigation affordance consistent and rejects privileged schemes
 * or credential-bearing URLs before crossing either control boundary.
 */
export function normalizeBrowserAddress(rawAddress: string): string | null {
  const value = rawAddress.trim();
  if (!value) {
    return null;
  }
  if (value.toLowerCase() === "about:blank") {
    return "about:blank";
  }

  const schemeMatch = value.match(EXPLICIT_SCHEME_PATTERN);
  const hasAuthorityPort = DOMAIN_WITH_PORT_PATTERN.test(value);
  if (schemeMatch && !hasAuthorityPort) {
    const protocol = schemeMatch[1]?.toLowerCase();
    if (protocol !== "http" && protocol !== "https") {
      return null;
    }
  }

  const candidate = schemeMatch && !hasAuthorityPort ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** What the Personal Browser's address bar does with what was typed. */
export type BrowserAddressInput =
  | { kind: "address"; url: string }
  | { kind: "search"; query: string }
  | { kind: "invalid" };

// Schemes that are always an address attempt, never search words: the web's
// own, and the privileged ones the address bar refuses (so "javascript:…" is
// refused, not searched for).
const ADDRESS_SCHEMES = new Set([
  "http", "https", "about", "javascript", "data", "file", "blob", "filesystem", "vbscript",
  "view-source", "chrome", "chrome-extension", "devtools", "ftp", "ws", "wss", "mailto", "tel", "intent",
]);
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// An IPv6 literal with a port, such as "[::1]:3000".
const IPV6_WITH_PORT = /^\[[0-9a-f:.]+\]:\d+(?:[/?#]|$)/i;
// A dotted name whose last label could be a top-level domain: letters, or an
// international one in punycode.
const DOTTED_NAME = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/iu;

/**
 * The Personal Browser's address bar: an address opens as before, and words
 * that are not one open a search with the person's chosen engine (the Desktop
 * builds the search link). "example.com", "localhost:3000", "192.168.1.1" and
 * "http://…" are addresses; "best ramen tokyo" and a single word such as
 * "ramen" are searches. Privileged schemes stay refused. The Shared Browser
 * keeps `normalizeBrowserAddress` and does not search.
 */
export function personalBrowserAddressInput(rawAddress: string): BrowserAddressInput {
  const value = rawAddress.trim();
  if (!value) {
    return { kind: "invalid" };
  }
  const address = () => {
    const url = normalizeBrowserAddress(value);
    return url ? { kind: "address" as const, url } : { kind: "invalid" as const };
  };
  if (DOMAIN_WITH_PORT_PATTERN.test(value) || IPV6_WITH_PORT.test(value)) {
    return address();
  }
  const scheme = value.match(EXPLICIT_SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (scheme && (ADDRESS_SCHEMES.has(scheme) || value.slice(scheme.length + 1).startsWith("//"))) {
    return address();
  }
  if (/\s/.test(value)) {
    return { kind: "search", query: value };
  }
  const authority = value.split(/[/?#]/, 1)[0]!;
  // A user name or password before the host is an address, which is refused
  // as one: it is never sent to a search engine.
  if (authority.includes("@")) {
    return address();
  }
  const host = authority.replace(/\.+$/, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    IPV4_HOST.test(host) ||
    /^\[[0-9a-f:.]+\]$/i.test(host) ||
    DOTTED_NAME.test(host)
  ) {
    return address();
  }
  return { kind: "search", query: value };
}
