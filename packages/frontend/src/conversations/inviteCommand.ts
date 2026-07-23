const INVITE_PREFIX_PATTERN = /^\/invite\b/i;
const INVITE_ROLES = new Set(["viewer", "builder"]);

export interface InviteCommandRequest {
  email: string;
  role: string;
  error: string | null;
}

export function isLikelyInviteEmail(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function parseInviteCommandRequest(input: string): InviteCommandRequest | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const match = trimmed.match(INVITE_PREFIX_PATTERN);
  if (!match) {
    return null;
  }

  const remainder = trimmed.slice(match[0].length).trim();
  if (!remainder) {
    return {
      email: "",
      role: "builder",
      error: null,
    };
  }

  const parts = remainder.split(/\s+/).filter((part) => part.length > 0);
  const email = parts[0] ?? "";
  if (parts.length === 1) {
    return {
      email,
      role: "builder",
      error: null,
    };
  }

  const role = (parts[1] ?? "").trim().toLowerCase();
  if (parts.length > 2) {
    return {
      email,
      role: "builder",
      error: "Use /invite email@example.com or /invite email@example.com builder.",
    };
  }
  if (!INVITE_ROLES.has(role)) {
    return {
      email,
      role: "builder",
      error: "Role must be viewer or builder.",
    };
  }

  return {
    email,
    role,
    error: null,
  };
}
