const MAX_ACCESS_TOKEN_CHARS = 64 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function copyOptionalString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = nonEmptyString(source[key]);
  if (value) {
    target[key] = value;
  }
}

/**
 * Return only the ChatGPT/Codex subscription fields needed by the controller.
 * A coexisting legacy OPENAI_API_KEY and every unknown field are deliberately
 * omitted so test onboarding cannot silently switch to paid API-key billing.
 */
export function sanitizeCodexSubscriptionAuthJson(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.tokens)) {
    throw new Error("The local Codex login is not usable.");
  }

  const accessToken = nonEmptyString(value.tokens.access_token);
  if (!accessToken || accessToken.length > MAX_ACCESS_TOKEN_CHARS) {
    throw new Error("The local Codex login is not usable.");
  }

  const tokens: Record<string, unknown> = { access_token: accessToken };
  copyOptionalString(tokens, value.tokens, "account_id");
  copyOptionalString(tokens, value.tokens, "id_token");
  copyOptionalString(tokens, value.tokens, "refresh_token");

  const sanitized: Record<string, unknown> = {
    auth_mode: "chatgpt",
    tokens,
  };
  copyOptionalString(sanitized, value, "last_refresh");
  return sanitized;
}

/**
 * Build the fail-closed PostgREST filter used when replacing the one canonical
 * Playwright Codex credential. Never permit a service-role delete by label
 * alone, especially when a test intentionally targets hosted production.
 */
export function buildCodexCredentialCleanupFilter(options: {
  userId: string;
  label: string;
}): URLSearchParams {
  const userId = options.userId.trim();
  const label = options.label.trim();
  if (!UUID_PATTERN.test(userId) || !label) {
    throw new Error("A canonical test user and credential label are required for cleanup.");
  }

  return new URLSearchParams({
    user_id: `eq.${userId}`,
    label: `eq.${label}`,
    kind: "eq.codex_auth_json",
    "metadata->>source": "eq.codex_cli",
  });
}
