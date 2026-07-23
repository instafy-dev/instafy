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
