import type { ControllerCredentialListItem } from "../sdk/instafy";

function resolveCredentialProvider(
  credential: Pick<ControllerCredentialListItem, "metadata">,
): string | null {
  const metadata = credential.metadata as Record<string, unknown> | null | undefined;
  const provider = metadata?.["provider"];
  if (typeof provider === "string" && provider.trim()) {
    return provider.trim().toLowerCase();
  }
  return null;
}

function resolveCredentialSource(credential: Pick<ControllerCredentialListItem, "metadata">): string {
  const metadata = credential.metadata as Record<string, unknown> | null | undefined;
  const source = metadata?.["source"];
  return typeof source === "string" ? source.trim().toLowerCase() : "";
}

export function isLocalCodexCredential(
  credential: Pick<ControllerCredentialListItem, "kind" | "metadata">,
): boolean {
  return credential.kind === "codex_auth_json" && resolveCredentialSource(credential) === "codex_cli";
}

export function formatCredentialKind(
  credential: Pick<ControllerCredentialListItem, "kind" | "metadata">,
): string {
  if (credential.kind === "codex_auth_json") {
    const source = resolveCredentialSource(credential);
    if (source === "codex_cli") {
      return "This machine";
    }
    if (source === "device_code") {
      return "Browser login (device code)";
    }
    return "Login session";
  }
  if (credential.kind === "openai_api_key") {
    const metadata = credential.metadata as Record<string, unknown> | null | undefined;
    const source = typeof metadata?.["source"] === "string" ? metadata["source"].trim().toLowerCase() : "";
    const provider = resolveCredentialProvider(credential);
    if (provider === "deepseek") {
      return "DeepSeek API key";
    }
    if (provider === "zai" || provider === "z.ai") {
      return "z.ai API key";
    }
    if (
      provider === "gemini" ||
      provider === "google" ||
      provider === "google-ai" ||
      provider === "google_gemini" ||
      provider === "google-gemini"
    ) {
      if (source === "google_oauth") {
        return "Gemini Google login";
      }
      return "Gemini API key";
    }
    if (provider === "openai" || !provider) {
      return "OpenAI API key";
    }
    return "API key";
  }
  return credential.kind;
}

export function resolveCredentialLabel(credential: ControllerCredentialListItem): string {
  const label = credential.label?.trim() ?? "";
  if (label) {
    return label;
  }

  const metadata = credential.metadata as Record<string, unknown> | null | undefined;
  const accountId = metadata?.["account_id"];
  if (typeof accountId === "string" && accountId.trim().length > 0) {
    return `Account ${accountId.trim()}`;
  }

  return `Credential ${credential.id.slice(0, 8)}`;
}

export function formatCredentialOptionLabel(credential: ControllerCredentialListItem): string {
  const label = resolveCredentialLabel(credential);
  const kind = formatCredentialKind(credential);
  return `${label} · ${kind}`;
}

export function formatCredentialLastUsed(
  credential: Pick<ControllerCredentialListItem, "lastUsedAt">,
  nowMs = Date.now(),
): string | null {
  if (!credential.lastUsedAt) {
    return null;
  }
  const usedMs = Date.parse(credential.lastUsedAt);
  if (!Number.isFinite(usedMs)) {
    return null;
  }
  const elapsedMs = Math.max(0, nowMs - usedMs);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (elapsedMs < minuteMs) {
    return "Last used just now";
  }
  if (elapsedMs < hourMs) {
    const minutes = Math.max(1, Math.floor(elapsedMs / minuteMs));
    return `Last used ${minutes}m ago`;
  }
  if (elapsedMs < dayMs) {
    const hours = Math.max(1, Math.floor(elapsedMs / hourMs));
    return `Last used ${hours}h ago`;
  }
  return `Last used ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(usedMs),
  )}`;
}

export function formatCredentialRuntimeDetail(
  credential: Pick<ControllerCredentialListItem, "kind" | "metadata" | "lastUsedAt">,
): string {
  return [formatCredentialKind(credential), formatCredentialLastUsed(credential)].filter(Boolean).join(" · ");
}
