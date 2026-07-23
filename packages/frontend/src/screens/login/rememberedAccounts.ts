import type { User } from "@supabase/supabase-js";

export type RememberedAccountProvider = "email" | "github";

export type RememberedAccount = {
  email: string;
  displayName: string;
  lastUsedAt: number;
  provider: RememberedAccountProvider;
};

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeProvider(value: unknown): RememberedAccountProvider {
  return typeof value === "string" && value.trim().toLowerCase() === "github"
    ? "github"
    : "email";
}

function toTitleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function buildDisplayNameFromEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const cleaned = localPart.replace(/[._+-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? toTitleCase(cleaned) : email;
}

export function parseRememberedAccounts(raw: string | null): RememberedAccount[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const accounts: RememberedAccount[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const email = typeof record.email === "string" ? normalizeEmail(record.email) : "";
      const displayName =
        typeof record.displayName === "string" ? record.displayName.trim() : "";
      const lastUsedAt = typeof record.lastUsedAt === "number" ? record.lastUsedAt : 0;
      if (!email) continue;
      accounts.push({
        email,
        displayName: displayName || buildDisplayNameFromEmail(email),
        lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
        provider: normalizeProvider(record.provider),
      });
    }
    return accounts
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
      .slice(0, 5);
  } catch {
    return [];
  }
}

export function upsertRememberedAccount(
  existing: RememberedAccount[],
  email: string,
  options?: {
    displayName?: string;
    provider?: RememberedAccountProvider;
  },
): RememberedAccount[] {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return existing;
  }
  const now = Date.now();
  const nextDisplayName = options?.displayName?.trim() || buildDisplayNameFromEmail(normalized);
  const nextProvider = options?.provider ?? "email";
  const next = existing.filter((account) => account.email !== normalized);
  next.unshift({
    email: normalized,
    displayName: nextDisplayName,
    lastUsedAt: now,
    provider: nextProvider,
  });
  return next.slice(0, 5);
}

export function removeRememberedAccount(existing: RememberedAccount[], email: string): RememberedAccount[] {
  const normalized = normalizeEmail(email);
  return existing.filter((account) => account.email !== normalized);
}

export function deriveRememberedAccountProviderFromUser(
  user: Pick<User, "app_metadata" | "identities">,
): RememberedAccountProvider {
  const appMetadataProvider =
    typeof user.app_metadata?.provider === "string" ? user.app_metadata.provider : null;
  if (normalizeProvider(appMetadataProvider) === "github") {
    return "github";
  }

  if (Array.isArray(user.app_metadata?.providers)) {
    for (const provider of user.app_metadata.providers) {
      if (normalizeProvider(provider) === "github") {
        return "github";
      }
    }
  }

  if (Array.isArray(user.identities)) {
    for (const identity of user.identities) {
      if (normalizeProvider(identity?.provider) === "github") {
        return "github";
      }
    }
  }

  return "email";
}
