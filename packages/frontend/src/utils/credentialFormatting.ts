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
        // Google no longer permits this login, so a credential stored this way
        // can never refresh again. Say so on the row rather than waiting for
        // the reader to press Test and find out.
        return "Gemini Google login (no longer supported)";
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

/**
 * The ChatGPT account a sign-in belongs to, as the end of its account id, so
 * two sign-ins with the same label (each device sign-in is "ChatGPT") read
 * differently wherever they are listed.
 */
function resolveCredentialAccountIdHint(
  credential: Pick<ControllerCredentialListItem, "kind" | "metadata">,
): string | null {
  const metadata = credential.metadata as Record<string, unknown> | null | undefined;
  const accountId = typeof metadata?.account_id === "string" ? metadata.account_id.trim() : "";
  return credential.kind === "codex_auth_json" && accountId ? `acct …${accountId.slice(-6)}` : null;
}

/** What tells a credential apart in Your AI: its ChatGPT account, else for a sign-in its own id. */
export function resolveCredentialAccountHint(
  credential: Pick<ControllerCredentialListItem, "kind" | "id" | "metadata">,
): string | null {
  const accountHint = resolveCredentialAccountIdHint(credential);
  if (accountHint) {
    return accountHint;
  }
  if (credential.kind === "codex_auth_json") {
    return `id …${credential.id.slice(0, 6)}`;
  }
  return null;
}

export function formatCredentialOptionLabel(credential: ControllerCredentialListItem): string {
  const label = resolveCredentialLabel(credential);
  const kind = formatCredentialKind(credential);
  const accountHint = resolveCredentialAccountIdHint(credential);
  return accountHint ? `${label} · ${kind} · ${accountHint}` : `${label} · ${kind}`;
}
