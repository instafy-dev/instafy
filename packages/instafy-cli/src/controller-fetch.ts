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

export async function fetchWithControllerAuth(params: {
  url: string;
  init?: RequestInit;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile?: string | null;
  cwd?: string | null;
}): Promise<{ response: Response; accessToken: string }> {
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
