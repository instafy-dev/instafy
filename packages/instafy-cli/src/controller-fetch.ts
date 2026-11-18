import {
  readInstafyCliConfig,
  readInstafyProfileConfig,
  resolveActiveProfileName,
  type AccessTokenSource,
  type InstafyCliConfig,
  type StoredAuthSessionSnapshot,
} from "./config.js";
import { extractControllerErrorMessage } from "./errors.js";
import { refreshStoredSupabaseSession } from "./supabase-session.js";

function shouldAttemptRefresh(status: number, body: string): boolean {
  if (status !== 401) {
    return false;
  }
  const message = extractControllerErrorMessage(body) ?? "";
  return message.toLowerCase().includes("expired");
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers, redirect: "error" };
}

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

function controllerRequestTimeoutMs(): number {
  const parsed = Number(process.env["INSTAFY_HTTP_TIMEOUT_MS"] ?? DEFAULT_HTTP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_TIMEOUT_MS;
}

function withTimeout(init: RequestInit | undefined): RequestInit {
  if (init?.signal) return init;
  return { ...init, signal: AbortSignal.timeout(controllerRequestTimeoutMs()) };
}

function assertStoredTokenOrigin(params: {
  url: string;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile?: string | null;
  cwd?: string | null;
}): { profile: string | null; config: InstafyCliConfig } | null {
  if (params.tokenSource !== "config") return null;
  const profile = resolveActiveProfileName({
    profile: params.profile ?? null,
    cwd: params.cwd ?? null,
  });
  const config = profile ? readInstafyProfileConfig(profile) : readInstafyCliConfig();
  const configuredUrl = config.controllerUrl?.trim() ?? "";
  if (!configuredUrl) {
    throw new Error(
      "The saved access token has no saved controller origin. Run `instafy login` again, or pass an explicit --access-token for this request.",
    );
  }
  const destination = new URL(params.url);
  const configured = new URL(configuredUrl);
  if (
    (configured.protocol !== "http:" && configured.protocol !== "https:") ||
    configured.username ||
    configured.password
  ) {
    throw new Error("The saved controller URL is invalid. Run `instafy login` again.");
  }
  if (destination.origin !== configured.origin) {
    throw new Error(
      "Refusing to send a saved access token to a different controller origin. Use the controller saved by `instafy login`, or pass an explicit --access-token.",
    );
  }
  if (!config.accessToken || config.accessToken !== params.accessToken) {
    throw new Error(
      "The saved login changed while this request was being prepared. Retry the command.",
    );
  }
  return { profile, config };
}

function authSnapshot(config: InstafyCliConfig): StoredAuthSessionSnapshot {
  return {
    controllerUrl: config.controllerUrl ?? null,
    accessToken: config.accessToken ?? null,
    refreshToken: config.refreshToken ?? null,
    supabaseUrl: config.supabaseUrl ?? null,
    supabaseAnonKey: config.supabaseAnonKey ?? null,
  };
}

/**
 * Drops leading and trailing control characters and spaces, as a URL parser does first. A scan
 * from each end, because an end-anchored pattern retries from every position of a long run of
 * them, which takes time in the square of its length.
 */
function trimControlsAndSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
}

/**
 * Refuses a controller request whose path has a "." or ".." segment, in any of the spellings a URL
 * parser resolves. An id that is one of those passes through encodeURIComponent unchanged, and
 * resolving the URL would then move the request, with its token, to another route. Like the
 * parser, it first drops leading and trailing control characters and spaces and every tab and line
 * break, and it reads a backslash as a slash. A scheme with no "//" after it, as in "http:../x", is
 * a path relative to the base, so its path is checked too.
 */
export function refuseDotSegments(target: string): void {
  const afterOrigin = trimControlsAndSpaces(target)
    .replace(/[\t\n\r]/g, "")
    .replace(/^[a-z][a-z\d+.-]*:(?:[\\/]{2}[^/\\?#]*)?/i, "");
  const pathname = afterOrigin.split(/[?#]/, 1)[0] ?? "";
  if (pathname.split(/[\\/]/).some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new Error(
      'Refusing a controller request whose path has a "." or ".." segment, which would send it to another route.',
    );
  }
}

/** When a JWT access token expires, from its `exp` claim, or null when it has none to read. */
export function accessTokenExpiresAtMs(accessToken: string): number | null {
  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object") return null;
    const exp = (payload as Record<string, unknown>)["exp"];
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The saved session's access token, refreshed first when it ends within `marginMs`. A runtime
 * token minted from a person's session ends no later than the session, so one minted from a
 * session about to end could expire before its runtime registers, as after a slow image pull.
 * Only a saved session is refreshed: any other token, one with no expiry to read, or a refresh
 * that does not land leaves the token as it was.
 */
export async function freshenStoredAccessToken(params: {
  url: string;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile?: string | null;
  cwd?: string | null;
  marginMs: number;
  nowMs?: number;
}): Promise<string> {
  if (params.tokenSource !== "config") return params.accessToken;
  const expiresAtMs = accessTokenExpiresAtMs(params.accessToken);
  if (expiresAtMs === null || expiresAtMs - (params.nowMs ?? Date.now()) > params.marginMs) {
    return params.accessToken;
  }
  const stored = assertStoredTokenOrigin(params);
  if (!stored) return params.accessToken;
  let refreshed: Awaited<ReturnType<typeof refreshStoredSupabaseSession>> = null;
  try {
    refreshed = await refreshStoredSupabaseSession({
      profile: stored.profile,
      cwd: params.cwd ?? null,
      expected: authSnapshot(stored.config),
    });
  } catch {
    // The request that follows refreshes on its own if the controller finds the token expired.
    return params.accessToken;
  }
  if (!refreshed?.accessToken) return params.accessToken;
  assertStoredTokenOrigin({
    ...params,
    profile: stored.profile,
    accessToken: refreshed.accessToken,
  });
  return refreshed.accessToken;
}

export async function fetchWithControllerAuth(params: {
  url: string;
  init?: RequestInit;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile?: string | null;
  cwd?: string | null;
}): Promise<{ response: Response; accessToken: string }> {
  refuseDotSegments(params.url);
  const stored = assertStoredTokenOrigin(params);
  const response = await fetch(
    params.url,
    withTimeout(withBearer(params.init, params.accessToken)),
  );
  if (response.ok) {
    return { response, accessToken: params.accessToken };
  }

  if (params.tokenSource !== "config") {
    return { response, accessToken: params.accessToken };
  }

  const responseText = await response.clone().text().catch(() => "");
  if (!shouldAttemptRefresh(response.status, responseText)) {
    return { response, accessToken: params.accessToken };
  }

  if (!stored) {
    return { response, accessToken: params.accessToken };
  }
  const refreshed = await refreshStoredSupabaseSession({
    profile: stored.profile,
    cwd: params.cwd ?? null,
    expected: authSnapshot(stored.config),
  });
  if (!refreshed?.accessToken) {
    return { response, accessToken: params.accessToken };
  }

  // A concurrent login/config change invalidates this retry. Re-read the exact stored
  // session and require the refreshed token to still be current before sending it.
  assertStoredTokenOrigin({
    ...params,
    profile: stored.profile,
    accessToken: refreshed.accessToken,
  });

  const retry = await fetch(
    params.url,
    withTimeout(withBearer(params.init, refreshed.accessToken)),
  );
  return { response: retry, accessToken: refreshed.accessToken };
}
