import {
  normalizeVisibleInstafySession,
  resolveTrustedDesktopControllerOrigin,
  type DesktopCodexVisibleSession,
} from "./codexCredentialBridge";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PersonalBrowserIdentityRequest = {
  controllerUrl?: string;
};

export type PersonalBrowserRuntimeConnectionRequest = {
  controllerUrl?: string;
  proxyBaseUrl?: string;
  ambientProxyBaseUrl?: string;
};

export type PersonalBrowserRuntimeConnection = {
  controllerUrl: string;
  controllerAccessToken: string;
  proxyBaseUrl?: string;
};

export type PersonalBrowserIdentityFetch = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type AttestPersonalBrowserIdentityOptions = {
  appUrl: string;
  callerUrl: string;
  fetch: PersonalBrowserIdentityFetch;
  resolveCurrentSession: () => Promise<DesktopCodexVisibleSession | null>;
  timeoutMs?: number;
};

type ResolvePersonalBrowserRuntimeConnectionOptions = {
  appUrl: string;
  callerUrl: string;
  packaged: boolean;
  attestedProfileUserId: string | null;
  resolveCurrentSession: () => Promise<DesktopCodexVisibleSession | null>;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function resolveLoopbackProxyOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Personal Browser proxy URL is invalid.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    !isLoopbackHostname(parsed.hostname)
  ) {
    throw new Error("Development Personal Browser proxies must be loopback origins.");
  }
  return parsed.origin;
}

/**
 * Resolve every authority handed to the Personal runtime in the main process.
 * Renderer values select neither the authenticated controller bearer nor an
 * arbitrary proxy: packaged production uses the pinned Instafy controller's
 * narrow authenticated proxy ingress, while local development is restricted
 * to origin-only loopback endpoints.
 */
export async function resolvePersonalBrowserRuntimeConnection(
  request: PersonalBrowserRuntimeConnectionRequest,
  options: ResolvePersonalBrowserRuntimeConnectionOptions,
): Promise<PersonalBrowserRuntimeConnection> {
  const requestedControllerUrl = nonEmptyString(request.controllerUrl);
  if (!requestedControllerUrl) {
    throw new Error("The controller URL is required.");
  }
  const controllerUrl = resolveTrustedDesktopControllerOrigin(
    options.appUrl,
    options.callerUrl,
    requestedControllerUrl,
  );
  const attestedProfileUserId = nonEmptyString(options.attestedProfileUserId);
  if (!attestedProfileUserId || !UUID_PATTERN.test(attestedProfileUserId)) {
    throw new Error("Personal Browser requires a server-attested profile owner.");
  }
  const currentIdentity = normalizeVisibleInstafySession(
    await options.resolveCurrentSession(),
  );
  if (currentIdentity.userId !== attestedProfileUserId) {
    throw new Error("The active Instafy session changed. Sign in again and retry.");
  }

  const requestedProxyBaseUrl = nonEmptyString(request.proxyBaseUrl);
  const ambientProxyBaseUrl = nonEmptyString(request.ambientProxyBaseUrl);
  if (options.packaged) {
    if (requestedProxyBaseUrl || ambientProxyBaseUrl) {
      throw new Error(
        "Packaged Personal Browser runtimes must use controller-issued proxy configuration.",
      );
    }
    return {
      controllerUrl,
      controllerAccessToken: currentIdentity.accessToken,
      proxyBaseUrl: controllerUrl,
    };
  }

  const proxyBaseUrl = resolveLoopbackProxyOrigin(
    requestedProxyBaseUrl ?? ambientProxyBaseUrl ?? "http://127.0.0.1:8789",
  );
  return {
    controllerUrl,
    controllerAccessToken: currentIdentity.accessToken,
    proxyBaseUrl,
  };
}

/**
 * Resolve the Personal Browser profile owner through the authenticated
 * controller. A renderer-provided user id is deliberately not an input: the
 * persistent Electron partition is selected only by this server-attested id.
 */
export async function attestPersonalBrowserIdentity(
  request: PersonalBrowserIdentityRequest,
  options: AttestPersonalBrowserIdentityOptions,
): Promise<string> {
  if (
    Object.prototype.hasOwnProperty.call(request, "controllerAccessToken") ||
    Object.prototype.hasOwnProperty.call(request, "sessionAccessToken") ||
    Object.prototype.hasOwnProperty.call(request, "profileUserId")
  ) {
    throw new Error("Personal Browser identity requests must not include identity credentials.");
  }
  const requestedControllerUrl = nonEmptyString(request.controllerUrl);
  if (!requestedControllerUrl) {
    throw new Error("The controller URL is required.");
  }
  const controllerOrigin = resolveTrustedDesktopControllerOrigin(
    options.appUrl,
    options.callerUrl,
    requestedControllerUrl,
  );
  const localIdentity = normalizeVisibleInstafySession(
    await options.resolveCurrentSession(),
  );

  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(),
    options.timeoutMs ?? 10_000,
  );
  let response: Awaited<ReturnType<PersonalBrowserIdentityFetch>>;
  try {
    response = await options.fetch(
      new URL("/me/session", controllerOrigin).toString(),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${localIdentity.accessToken}`,
        },
        redirect: "error",
        signal: abortController.signal,
      },
    );
  } catch {
    throw new Error("Unable to verify the active Instafy session for Personal Browser.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `Instafy rejected the Personal Browser session (HTTP ${response.status}).`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Instafy returned an invalid Personal Browser session response.");
  }
  const attestedUserId = isRecord(payload) ? nonEmptyString(payload.userId) : null;
  if (!attestedUserId || !UUID_PATTERN.test(attestedUserId)) {
    throw new Error("Instafy returned an invalid Personal Browser session response.");
  }
  if (attestedUserId !== localIdentity.userId) {
    throw new Error("The active Instafy session changed. Sign in again and retry.");
  }
  // Re-read the visible session after the network round trip. This closes the
  // useful auth-switch race: a response for user A must never open A's
  // persistent partition after the Studio has already switched to user B.
  const currentIdentity = normalizeVisibleInstafySession(
    await options.resolveCurrentSession(),
  );
  if (currentIdentity.userId !== attestedUserId) {
    throw new Error("The active Instafy session changed. Sign in again and retry.");
  }
  return attestedUserId;
}
