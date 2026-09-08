/** Canonical URL replacements retain their visit; PUSH/POP use the router entry key. */
export function getStudioVisitKey(location: { key: string; state?: unknown }): string {
  const state = location.state;
  const visitKey = state && typeof state === "object" && "instafyVisitKey" in state
    ? state.instafyVisitKey
    : null;
  return typeof visitKey === "string" && visitKey.trim().length > 0
    ? visitKey
    : location.key;
}
