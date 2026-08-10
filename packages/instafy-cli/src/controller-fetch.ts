import { type AccessTokenSource } from "./config.js";
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
  return { ...init, headers };
}

// Node's fetch has no request timeout, so a stalled controller endpoint
// pinned any networked command for ~5 minutes of TCP defaults. Agents
// typically kill the process before that and learn nothing. Callers that
// genuinely stream for longer can raise INSTAFY_HTTP_TIMEOUT_MS.
const HTTP_TIMEOUT_MS = Number(process.env["INSTAFY_HTTP_TIMEOUT_MS"] || 60_000);

function withTimeout(init: RequestInit | undefined): RequestInit {
  if (init?.signal) return init ?? {};
  return { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) };
}

export async function fetchWithControllerAuth(params: {
  url: string;
  init?: RequestInit;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile?: string | null;
  cwd?: string | null;
}): Promise<{ response: Response; accessToken: string }> {
  const response = await fetch(params.url, withTimeout(withBearer(params.init, params.accessToken)));
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

  const refreshed = await refreshStoredSupabaseSession({ profile: params.profile ?? null, cwd: params.cwd ?? null });
  if (!refreshed?.accessToken) {
    return { response, accessToken: params.accessToken };
  }

  const retry = await fetch(params.url, withTimeout(withBearer(params.init, refreshed.accessToken)));
  return { response: retry, accessToken: refreshed.accessToken };
}

