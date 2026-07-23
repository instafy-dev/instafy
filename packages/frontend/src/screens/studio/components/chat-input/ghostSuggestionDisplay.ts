export function formatGhostSuggestionRemainderForDisplay(remainder: string): string {
  return remainder.replace(/^ +/, (leadingSpaces) => "\u00A0".repeat(leadingSpaces.length));
}
