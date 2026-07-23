import sideOctoSrc from "../assets/octo-avatar.svg";
import {
  getDefaultAssistantHandle,
  resolveBuiltInAssistantHandle,
} from "../assistants/localBuiltInAssistantCatalog";

function hashStringToNumber(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export const OCTO_AVATAR_SRC = sideOctoSrc;

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

export function resolveAgentAvatarImageSrc(agent: {
  handle?: string | null;
  avatarSeed?: string | null;
  avatarUrl?: string | null;
}): string | null {
  const customAvatar =
    normalizeCustomAgentAvatarSrc(agent.avatarUrl) ??
    normalizeCustomAgentAvatarSrc(agent.avatarSeed);
  if (customAvatar) {
    return customAvatar;
  }
  const handle = resolveBuiltInAssistantHandle(normalizeAgentAvatarHandle(agent.handle));
  if (handle === getDefaultAssistantHandle()) {
    return OCTO_AVATAR_SRC;
  }
  return null;
}

export function resolveAgentAvatarGradient(seed: string): string {
  const base = seed?.trim() || "agent";
  const hash = hashStringToNumber(base);
  const hue1 = hash % 360;
  const hueShift = 40 + ((hash >>> 8) % 90);
  const hue2 = (hue1 + hueShift) % 360;
  const sat1 = 78;
  const sat2 = 82;
  const light1 = 58;
  const light2 = 52;
  return `linear-gradient(135deg, hsl(${hue1} ${sat1}% ${light1}%), hsl(${hue2} ${sat2}% ${light2}%))`;
}

export function resolveAgentAvatarText(agent: { handle?: string; displayName?: string | null }): string {
  const name = (agent.displayName ?? "").trim();
  const handle = (agent.handle ?? "").trim();
  const raw = name || handle;
  const base = raw.startsWith("@") ? raw.slice(1) : raw;
  if (!base) {
    return "?";
  }
  return base.slice(0, 1).toUpperCase();
}
