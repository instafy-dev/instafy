import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_AUTH_JSON_BYTES = 1024 * 1024;
const MAX_ACCESS_TOKEN_CHARS = 64 * 1024;
const MAX_LABEL_CHARS = 120;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DesktopCodexAuthJsonStatus = {
  exists: boolean;
};

export type DesktopCodexCredentialConnectRequest = {
  controllerUrl?: string;
  label?: string;
  makeDefault?: boolean;
};

export type DesktopCodexVisibleSession = {
  accessToken?: string;
  userId?: string;
  expiresAt?: number;
};

export type DesktopInstafySessionIdentity = {
  accessToken: string;
  userId: string;
};

export type DesktopCodexCredentialConnectResult = {
  credentialId: string;
  kind: "codex_auth_json";
  isDefault: boolean;
};

export type DesktopCodexCredentialFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type ConnectDefaultCodexCredentialOptions = {
  appUrl: string;
  callerUrl: string;
  fetch: DesktopCodexCredentialFetch;
  resolveCurrentSession: () => Promise<DesktopCodexVisibleSession | null>;
  homeDirectory?: string;
  timeoutMs?: number;
};

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
 * Keep only the ChatGPT/Codex subscription fields that the controller needs.
 * In particular, a legacy OPENAI_API_KEY entry is never uploaded, even when
 * it happens to coexist with valid subscription tokens in the local file.
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

function defaultCodexAuthJsonPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".codex", "auth.json");
}

async function loadDefaultCodexSubscriptionAuthJson(
  homeDirectory?: string,
): Promise<Record<string, unknown>> {
  const authPath = defaultCodexAuthJsonPath(homeDirectory);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(authPath, fs.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUTH_JSON_BYTES) {
      throw new Error("invalid auth file");
    }
    if (process.platform !== "win32") {
      const currentUserId =
        typeof process.getuid === "function" ? process.getuid() : null;
      if (
        (currentUserId !== null && stat.uid !== currentUserId) ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error("unsafe auth file ownership or permissions");
      }
    }
    const contents = await handle.readFile("utf8");
    return sanitizeCodexSubscriptionAuthJson(JSON.parse(contents) as unknown);
  } catch {
    throw new Error("The local Codex login is unavailable or invalid.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function getDefaultCodexAuthJsonStatus(
  homeDirectory?: string,
): Promise<DesktopCodexAuthJsonStatus> {
  try {
    await loadDefaultCodexSubscriptionAuthJson(homeDirectory);
    return { exists: true };
  } catch {
    return { exists: false };
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

const TRUSTED_INSTAFY_APP_ORIGINS = new Set([
  "https://prod.instafy.dev",
]);

const CREDENTIAL_AUTH_OVERRIDE_QUERY_KEYS = new Set([
  "controlleraccesstoken",
  "controllerurl",
]);

function hasCredentialAuthOverride(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_AUTH_OVERRIDE_QUERY_KEYS.has(key.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

function parseOriginOnlyUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} is invalid.`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`${label} must not contain a path.`);
  }
  return parsed;
}

export function resolveCodexCredentialControllerEndpoint(
  appUrl: string,
  callerUrl: string,
  requestedControllerUrl: string,
): string {
  const controllerOrigin = resolveTrustedDesktopControllerOrigin(
    appUrl,
    callerUrl,
    requestedControllerUrl,
  );
  return new URL("/me/credentials/codex", controllerOrigin).toString();
}

/**
 * Resolve a renderer-supplied controller URL against the native app's trust
 * policy. The renderer may tell us which loopback controller it is using in
 * development, but it cannot redirect a native bearer credential off that
 * trusted boundary.
 */
export function resolveTrustedDesktopControllerOrigin(
  appUrl: string,
  callerUrl: string,
  requestedControllerUrl: string,
): string {
  const app = new URL(appUrl);
  const caller = new URL(callerUrl);
  if (caller.origin !== app.origin) {
    throw new Error("The Desktop request did not come from the active Instafy app.");
  }
  if (
    TRUSTED_INSTAFY_APP_ORIGINS.has(app.origin) &&
    hasCredentialAuthOverride(caller)
  ) {
    throw new Error(
      "Native credential operations are disabled for an overridden Desktop session.",
    );
  }

  const controller = parseOriginOnlyUrl(
    requestedControllerUrl,
    "The controller URL",
  );
  if (isLoopbackHostname(app.hostname)) {
    if (!isLoopbackHostname(controller.hostname)) {
      throw new Error("Local Desktop may only send native credentials to a loopback controller.");
    }
  } else if (TRUSTED_INSTAFY_APP_ORIGINS.has(app.origin)) {
    if (controller.origin !== "https://controller.instafy.dev") {
      throw new Error("Instafy Desktop may only send native credentials to the Instafy controller.");
    }
  } else {
    // The packaged app accepts a custom start URL for diagnostics and
    // self-hosted surfaces. That must never implicitly grant the loaded origin
    // access to ~/.codex/auth.json: a caller could otherwise point Desktop at
    // an attacker-controlled page and have the native bridge POST the local
    // Codex tokens back to that same origin. A future self-hosted credential
    // bridge needs an explicit, native trust configuration of its own.
    throw new Error("This Desktop app origin is not trusted for local Codex credentials.");
  }

  return controller.origin;
}

function normalizeAccessToken(value: unknown): string {
  const token = nonEmptyString(value);
  if (!token || token.length > MAX_ACCESS_TOKEN_CHARS) {
    throw new Error("A valid signed-in Instafy session is required.");
  }
  return token;
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("A valid signed-in Instafy session is required.");
  }
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("invalid JWT payload");
    }
    return parsed;
  } catch {
    throw new Error("A valid signed-in Instafy session is required.");
  }
}

export function normalizeVisibleInstafySession(
  value: DesktopCodexVisibleSession | null,
): DesktopInstafySessionIdentity {
  if (!value || !isRecord(value)) {
    throw new Error("A valid signed-in Instafy session is required.");
  }
  const accessToken = normalizeAccessToken(value.accessToken);
  const userId = nonEmptyString(value.userId);
  const expiresAt = value.expiresAt;
  if (
    !userId ||
    !UUID_PATTERN.test(userId) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt * 1000 - Date.now() < 30_000
  ) {
    throw new Error("A valid signed-in Instafy session is required.");
  }

  const payload = decodeJwtPayload(accessToken);
  const subject = nonEmptyString(payload.sub);
  const jwtExpiresAt = payload.exp;
  if (
    subject !== userId ||
    typeof jwtExpiresAt !== "number" ||
    !Number.isFinite(jwtExpiresAt) ||
    jwtExpiresAt * 1000 - Date.now() < 30_000 ||
    Math.abs(jwtExpiresAt - expiresAt) > 5
  ) {
    throw new Error("The active Instafy session changed. Sign in again and retry.");
  }
  return { accessToken, userId };
}

function normalizeLabel(value: unknown): string {
  const label = nonEmptyString(value) ?? "Codex on this computer";
  return label
    .split("")
    .map((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_CHARS);
}

export async function connectDefaultCodexCredential(
  request: DesktopCodexCredentialConnectRequest,
  options: ConnectDefaultCodexCredentialOptions,
): Promise<DesktopCodexCredentialConnectResult> {
  if (
    Object.prototype.hasOwnProperty.call(request, "controllerAccessToken") ||
    Object.prototype.hasOwnProperty.call(request, "sessionAccessToken")
  ) {
    throw new Error("Desktop credential requests must not include session tokens.");
  }
  const controllerUrl = nonEmptyString(request.controllerUrl);
  if (!controllerUrl) {
    throw new Error("The controller URL is required.");
  }
  const endpoint = resolveCodexCredentialControllerEndpoint(
    options.appUrl,
    options.callerUrl,
    controllerUrl,
  );
  const { accessToken } = normalizeVisibleInstafySession(
    await options.resolveCurrentSession(),
  );
  const authJson = await loadDefaultCodexSubscriptionAuthJson(
    options.homeDirectory,
  );
  const body = JSON.stringify({
    authJson,
    label: normalizeLabel(request.label),
    ...(typeof request.makeDefault === "boolean"
      ? { makeDefault: request.makeDefault }
      : {}),
  });

  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(),
    options.timeoutMs ?? 30_000,
  );
  let response: Awaited<ReturnType<DesktopCodexCredentialFetch>>;
  try {
    response = await options.fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      signal: abortController.signal,
    });
  } catch {
    throw new Error("Unable to connect the local Codex login to Instafy.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Instafy rejected the local Codex login (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Instafy returned an invalid credential response.");
  }
  if (!isRecord(payload)) {
    throw new Error("Instafy returned an invalid credential response.");
  }
  const credentialId = nonEmptyString(payload.credentialId);
  if (
    !credentialId ||
    !UUID_PATTERN.test(credentialId) ||
    payload.kind !== "codex_auth_json" ||
    typeof payload.isDefault !== "boolean"
  ) {
    throw new Error("Instafy returned an invalid credential response.");
  }
  return {
    credentialId,
    kind: "codex_auth_json",
    isDefault: payload.isDefault,
  };
}
