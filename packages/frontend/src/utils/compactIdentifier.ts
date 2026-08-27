/**
 * Compact a long opaque identifier for display: first 8 chars, ellipsis, last
 * 4. The full value belongs in a `title` attribute and in copy actions.
 */
export function compactIdentifier(value: string, maxLength = 18): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
