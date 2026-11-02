/** FNV-1a 32 over UTF-16 code units: the AI face hash (utils/aiFace.ts). */
export function hashStringToNumber(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function normalizeAgentAvatarHandle(handle: string | null | undefined): string {
  const raw = typeof handle === "string" ? handle.trim() : "";
  const withoutAt = raw.startsWith("@") ? raw.slice(1).trim() : raw;
  return withoutAt.toLowerCase();
}

export function normalizeCustomAgentAvatarSrc(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("/")) {
    return normalized;
  }
  if (normalized.startsWith("data:image/")) {
    return normalized;
  }
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  return null;
}
