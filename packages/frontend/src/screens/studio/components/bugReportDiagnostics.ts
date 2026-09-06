/**
 * Keep only the page origin and path. Query strings and fragments routinely contain
 * OAuth codes, invite tokens, search text, or other values that do not belong in a report.
 */
export function sanitizeBugReportLocation(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}
