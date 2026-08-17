import kleur from "kleur";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  clearInstafyCliConfig,
  clearInstafyProfileConfig,
  getInstafyConfigPath,
  getInstafyProfileConfigPath,
  resolveConfiguredControllerUrl,
  resolveConfiguredStudioUrl,
  resolveUserAccessToken,
  writeInstafyCliConfig,
  writeInstafyProfileConfig,
} from "./config.js";
import { installGitCredentialHelper, uninstallGitCredentialHelper } from "./git-setup.js";

const require = createRequire(import.meta.url);
const cliVersion = (() => {
  try {
    const pkg = require("../package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
})();
const isStagingCli = cliVersion.includes("-staging.");

type CliLoginCallbackServer = {
  callbackUrl: string;
  state: string;
  waitForToken: (timeoutMs: number) => Promise<CliLoginPayload>;
  cancel: () => void;
  close: () => void;
};

function normalizeUrl(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/$/, "");
}

function normalizeToken(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") {
    return null;
  }
  return trimmed;
}

type CliLoginPayload = {
  accessToken: string;
  refreshToken: string | null;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
};

async function loginWithPassword(params: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  email: string;
  password: string;
}): Promise<CliLoginPayload> {
  const baseUrl = new URL(`${params.supabaseUrl.replace(/\/$/, "")}/`);
  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new Error("Supabase login URL must be HTTP(S) without embedded credentials.");
  }
  const timeoutValue = Number(process.env["INSTAFY_HTTP_TIMEOUT_MS"] ?? 60_000);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 60_000;
  const response = await fetch(new URL("auth/v1/token?grant_type=password", baseUrl), {
    method: "POST",
    headers: {
      apikey: params.supabaseAnonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: params.email, password: params.password }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase login failed (${response.status}): ${text}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof body["access_token"] === "string" ? (body["access_token"] as string) : null;
  if (!accessToken) {
    throw new Error("Supabase login response missing access_token");
  }
  const refreshToken =
    typeof body["refresh_token"] === "string" ? (body["refresh_token"] as string) : null;
  return {
    accessToken,
    refreshToken: normalizeToken(refreshToken),
    supabaseUrl: normalizeUrl(params.supabaseUrl),
    supabaseAnonKey: normalizeToken(params.supabaseAnonKey),
  };
}

function looksLikeLocalControllerUrl(controllerUrl: string): boolean {
  try {
    const parsed = new URL(controllerUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return controllerUrl.includes("127.0.0.1") || controllerUrl.includes("localhost");
  }
}

async function isStudioHealthy(studioUrl: string, timeoutMs: number): Promise<boolean> {
  const target = new URL("/cli/login", studioUrl).toString();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(target, { signal: abort.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveDefaultStudioUrl(controllerUrl: string): Promise<string> {
  const hosted = "https://staging.instafy.dev";
  if (isStagingCli) {
    return hosted;
  }
  if (!looksLikeLocalControllerUrl(controllerUrl)) {
    return hosted;
  }
  const local = "http://localhost:5173";
  const healthy = await isStudioHealthy(local, 250);
  return healthy ? local : hosted;
}

async function isControllerHealthy(controllerUrl: string, timeoutMs: number): Promise<boolean> {
  const target = `${controllerUrl.replace(/\/$/, "")}/healthz`;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(target, { signal: abort.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function readRequestBody(request: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > maxBytes) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(buffer));
    request.on("error", (error) => reject(error));
  });
}

function applyCorsHeaders(request: http.IncomingMessage, response: http.ServerResponse) {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  } else {
    response.setHeader("access-control-allow-origin", "*");
  }
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");

  // Private Network Access preflight (Chrome): allow https -> http://127.0.0.1 callbacks.
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("access-control-allow-private-network", "true");
  }
}

async function startCliLoginCallbackServer(): Promise<CliLoginCallbackServer> {
  const state = randomBytes(16).toString("hex");
  let resolved = false;
  let resolveToken: ((token: CliLoginPayload) => void) | null = null;
  let rejectToken: ((error: Error) => void) | null = null;
  const tokenPromise = new Promise<CliLoginPayload>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = http.createServer(async (request, response) => {
    applyCorsHeaders(request, response);

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/callback") {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: false, error: "Not found" }));
      return;
    }

    if (resolved) {
      response.statusCode = 409;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: false, error: "Already completed" }));
      return;
    }

    try {
      const body = await readRequestBody(request);
      const contentType = typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : "";
      let parsedToken: string | null = null;
      let parsedRefreshToken: string | null = null;
      let parsedSupabaseUrl: string | null = null;
      let parsedSupabaseAnonKey: string | null = null;
      let parsedState: string | null = null;

      if (contentType.includes("application/json")) {
        const json = JSON.parse(body) as Record<string, unknown>;
        parsedToken =
          typeof json.token === "string"
            ? (json.token as string)
            : typeof json.accessToken === "string"
              ? (json.accessToken as string)
              : typeof json.access_token === "string"
                ? (json.access_token as string)
                : null;
        parsedRefreshToken =
          typeof json.refreshToken === "string"
            ? (json.refreshToken as string)
            : typeof json.refresh_token === "string"
              ? (json.refresh_token as string)
              : null;
        parsedSupabaseUrl = typeof json.supabaseUrl === "string" ? (json.supabaseUrl as string) : null;
        parsedSupabaseAnonKey =
          typeof json.supabaseAnonKey === "string"
            ? (json.supabaseAnonKey as string)
            : typeof json.supabase_anon_key === "string"
              ? (json.supabase_anon_key as string)
              : null;
        parsedState = typeof json.state === "string" ? (json.state as string) : null;
      } else {
        const params = new URLSearchParams(body);
        parsedToken = params.get("token");
        parsedRefreshToken = params.get("refreshToken") ?? params.get("refresh_token");
        parsedSupabaseUrl = params.get("supabaseUrl") ?? params.get("supabase_url");
        parsedSupabaseAnonKey = params.get("supabaseAnonKey") ?? params.get("supabase_anon_key");
        parsedState = params.get("state");
      }

      const token = normalizeToken(parsedToken);
      const refreshToken = normalizeToken(parsedRefreshToken);
      const supabaseUrl = normalizeUrl(parsedSupabaseUrl);
      const supabaseAnonKey = normalizeToken(parsedSupabaseAnonKey);
      const receivedState = normalizeToken(parsedState);
      if (!token) {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: false, error: "Missing token" }));
        return;
      }
      if (!receivedState || receivedState !== state) {
        response.statusCode = 403;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: false, error: "Invalid state" }));
        return;
      }

      resolved = true;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      resolveToken?.({
        accessToken: token,
        refreshToken,
        supabaseUrl,
        supabaseAnonKey,
      });
      resolveToken = null;
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address !== "object" || typeof address.port !== "number") {
    server.close();
    throw new Error("Failed to start login callback server.");
  }

  return {
    callbackUrl: `http://127.0.0.1:${address.port}/callback`,
    state,
    waitForToken: async (timeoutMs: number) => {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return tokenPromise;
      }
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        rejectToken?.(new Error("Timed out waiting for browser login. Copy the token and paste it into the CLI instead."));
        rejectToken = null;
      }, timeoutMs);
      timeout.unref?.();
      try {
        return await tokenPromise;
      } finally {
        clearTimeout(timeout);
      }
    },
    cancel: () => {
      if (resolved) return;
      resolved = true;
      rejectToken?.(new Error("Login cancelled."));
      rejectToken = null;
      resolveToken = null;
    },
    close: () => server.close(),
  };
}

export async function login(options: {
  controllerUrl?: string;
  studioUrl?: string;
  token?: string;
  email?: string;
  password?: string;
  noStore?: boolean;
  gitSetup?: boolean;
  profile?: string;
  json?: boolean;
  waitForBrowser?: boolean;
}): Promise<void> {
  if (options.json && options.waitForBrowser) {
    throw new Error("--json cannot be combined with --wait-for-browser");
  }
  const profile = typeof options.profile === "string" && options.profile.trim() ? options.profile.trim() : null;
  const explicitControllerUrl =
    normalizeUrl(options.controllerUrl ?? null) ??
    normalizeUrl(process.env["INSTAFY_SERVER_URL"] ?? null) ??
    (isStagingCli ? null : resolveConfiguredControllerUrl({ profile }));

  const defaultLocalControllerUrl = "http://127.0.0.1:8788";
  const defaultHostedControllerUrl = "https://controller.instafy.dev";

  const controllerUrl =
    explicitControllerUrl ??
    (isStagingCli
      ? defaultHostedControllerUrl
      : (await isControllerHealthy(defaultLocalControllerUrl, 250))
        ? defaultLocalControllerUrl
        : defaultHostedControllerUrl);

  const studioUrl =
    normalizeUrl(options.studioUrl ?? null) ??
    normalizeUrl(process.env["INSTAFY_STUDIO_URL"] ?? null) ??
    (isStagingCli ? null : resolveConfiguredStudioUrl({ profile })) ??
    (await resolveDefaultStudioUrl(controllerUrl));

  const url = new URL("/cli/login", studioUrl);
  url.searchParams.set("serverUrl", controllerUrl);

  const jsonWantsUrlOnly =
    Boolean(options.json) &&
    !normalizeToken(options.token ?? null) &&
    !normalizeToken(options.email ?? null) &&
    !normalizeToken(process.env["INSTAFY_LOGIN_EMAIL"] ?? null);
  if (jsonWantsUrlOnly) {
    console.log(
      JSON.stringify({
        url: url.toString(),
        profile,
        configPath: profile ? getInstafyProfileConfigPath(profile) : getInstafyConfigPath(),
      }),
    );
    return;
  }

  const existing = resolveUserAccessToken({ profile });
  const provided = normalizeToken(options.token ?? null);
  let authPayload: CliLoginPayload | null = provided
    ? { accessToken: provided, refreshToken: null, supabaseUrl: null, supabaseAnonKey: null }
    : null;
  let usedPasswordGrant = false;

  if (!authPayload) {
    const email =
      normalizeToken(options.email ?? null) ?? normalizeToken(process.env["INSTAFY_LOGIN_EMAIL"] ?? null);
    const password =
      normalizeToken(options.password ?? null) ??
      normalizeToken(process.env["INSTAFY_LOGIN_PASSWORD"] ?? null);

    if (email && password) {
      const supabaseUrl =
        normalizeUrl(process.env["SUPABASE_URL"] ?? null) ??
        normalizeUrl(process.env["VITE_SUPABASE_URL"] ?? null) ??
        normalizeUrl(process.env["SUPABASE_PROJECT_URL"] ?? null);
      const supabaseAnonKey =
        normalizeToken(process.env["SUPABASE_ANON_KEY"] ?? null) ??
        normalizeToken(process.env["VITE_SUPABASE_ANON_KEY"] ?? null);

      if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error(
          "Email/password login requires Supabase env.\n\nSet:\n- SUPABASE_URL + SUPABASE_ANON_KEY (or VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)\n\nThen retry: instafy login --email <email> --password <password>",
        );
      }

      authPayload = await loginWithPassword({ supabaseUrl, supabaseAnonKey, email, password });
      usedPasswordGrant = true;
    }
  }

  if (!authPayload && !input.isTTY && !options.waitForBrowser) {
    throw new Error(
      [
        "Non-interactive session and no credentials were provided.",
        "",
        "Authenticate non-interactively with one of:",
        "- instafy login --token <token>   (open the URL below in a browser to obtain one)",
        "- instafy login --email <email> --password <password>   (requires SUPABASE_URL + SUPABASE_ANON_KEY)",
        "- INSTAFY_LOGIN_EMAIL + INSTAFY_LOGIN_PASSWORD environment variables",
        "",
        `Login URL: ${url.toString()}`,
      ].join("\n"),
    );
  }

  let callbackServer: CliLoginCallbackServer | null = null;
  if (!authPayload) {
    try {
      callbackServer = await startCliLoginCallbackServer();
      url.searchParams.set("cliCallbackUrl", callbackServer.callbackUrl);
      url.searchParams.set("cliState", callbackServer.state);
    } catch {
      callbackServer = null;
    }
  }

  if (!options.json) {
    console.log(kleur.green("Instafy CLI login"));
    console.log("");
  }
  if (!authPayload) {
    console.log("1) Open this URL in your browser:");
    console.log(kleur.cyan(url.toString()));
    console.log("");
    if (callbackServer) {
      console.log("2) Sign in — this terminal should continue automatically.");
      console.log(kleur.gray("If it doesn't, copy the token shown on that page and paste it here."));
    } else {
      console.log("2) After you sign in, copy the token shown on that page.");
    }
    console.log("");
  } else if (usedPasswordGrant && !options.json) {
    console.log(kleur.gray("Authenticated via email/password."));
    console.log("");
  }

  if (!authPayload && callbackServer) {
    if (input.isTTY) {
      console.log(kleur.gray("Waiting for browser login…"));
      console.log(kleur.gray("If it doesn't continue, paste the token here and press Enter."));
      console.log("");

      const rl = createInterface({ input, output });
      const abort = new AbortController();
      const manualTokenPromise = (async (): Promise<CliLoginPayload> => {
        while (true) {
          const answer = await rl.question("Paste token (or wait): ", { signal: abort.signal });
          const candidate = normalizeToken(answer);
          if (!candidate) continue;
          if (candidate.startsWith("{")) {
            try {
              const json = JSON.parse(candidate) as Record<string, unknown>;
              const accessToken =
                typeof json.accessToken === "string"
                  ? (json.accessToken as string)
                  : typeof json.access_token === "string"
                    ? (json.access_token as string)
                    : typeof json.token === "string"
                      ? (json.token as string)
                      : "";
              if (accessToken.trim()) {
                return {
                  accessToken: accessToken.trim(),
                  refreshToken:
                    typeof json.refreshToken === "string"
                      ? (json.refreshToken as string).trim()
                      : typeof json.refresh_token === "string"
                        ? (json.refresh_token as string).trim()
                        : null,
                  supabaseUrl: typeof json.supabaseUrl === "string" ? (json.supabaseUrl as string).trim() : null,
                  supabaseAnonKey:
                    typeof json.supabaseAnonKey === "string"
                      ? (json.supabaseAnonKey as string).trim()
                      : typeof json.supabase_anon_key === "string"
                        ? (json.supabase_anon_key as string).trim()
                        : null,
                };
              }
            } catch {
              // ignore and fall back to treating this as an access token
            }
          }
          return { accessToken: candidate, refreshToken: null, supabaseUrl: null, supabaseAnonKey: null };
        }
      })();

      try {
        const result = await Promise.race([
          callbackServer
            .waitForToken(10 * 60_000)
            .then((tokenValue) => ({ source: "browser" as const, token: tokenValue })),
          manualTokenPromise.then((tokenValue) => ({ source: "manual" as const, token: tokenValue })),
        ]);

        authPayload = result.token;
        if (result.source === "browser") {
          abort.abort();
        } else {
          callbackServer.cancel();
        }
      } catch (_error) {
        // If browser login fails, keep waiting for a pasted token.
        authPayload = await manualTokenPromise;
        callbackServer.cancel();
      } finally {
        try {
          rl.close();
        } catch {
          // ignore
        }
        callbackServer.close();
        callbackServer = null;
      }
    } else {
      try {
        authPayload = await callbackServer.waitForToken(10 * 60_000);
      } catch (error) {
        if (!input.isTTY) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      } finally {
        callbackServer.close();
        callbackServer = null;
      }
    }
  }

  if (!authPayload?.accessToken) {
    if (!input.isTTY) {
      throw new Error("No token provided.");
    }
    const rl = createInterface({ input, output });
    try {
      const raw = normalizeToken(await rl.question("Paste token: "));
      if (raw) {
        if (raw.startsWith("{")) {
          try {
            const json = JSON.parse(raw) as Record<string, unknown>;
            const accessToken =
              typeof json.accessToken === "string"
                ? (json.accessToken as string)
                : typeof json.access_token === "string"
                  ? (json.access_token as string)
                  : typeof json.token === "string"
                    ? (json.token as string)
                    : "";
            if (accessToken.trim()) {
              authPayload = {
                accessToken: accessToken.trim(),
                refreshToken:
                  typeof json.refreshToken === "string"
                    ? (json.refreshToken as string).trim()
                    : typeof json.refresh_token === "string"
                      ? (json.refresh_token as string).trim()
                      : null,
                supabaseUrl: typeof json.supabaseUrl === "string" ? (json.supabaseUrl as string).trim() : null,
                supabaseAnonKey:
                  typeof json.supabaseAnonKey === "string"
                    ? (json.supabaseAnonKey as string).trim()
                    : typeof json.supabase_anon_key === "string"
                      ? (json.supabase_anon_key as string).trim()
                      : null,
              };
            }
          } catch {
            // ignore and fall through to raw token
          }
        }
        authPayload ??= { accessToken: raw, refreshToken: null, supabaseUrl: null, supabaseAnonKey: null };
      }
    } finally {
      rl.close();
    }
  }

  if (!authPayload?.accessToken) {
    throw new Error("No token provided.");
  }

  if (!options.noStore) {
    const update = {
      controllerUrl,
      studioUrl,
      accessToken: authPayload.accessToken,
      refreshToken: authPayload.refreshToken,
      supabaseUrl: authPayload.supabaseUrl,
      supabaseAnonKey: authPayload.supabaseAnonKey,
    };
    if (profile) {
      writeInstafyProfileConfig(profile, update);
    } else {
      writeInstafyCliConfig(update);
    }
    if (!options.json) {
      console.log("");
      console.log(
        kleur.green(
          `Saved token to ${profile ? getInstafyProfileConfigPath(profile) : getInstafyConfigPath()}`,
        ),
      );
    }
    if (options.gitSetup !== false) {
      try {
        const result = installGitCredentialHelper();
        if (result.changed && !options.json) {
          console.log(kleur.green("Enabled git auth (credential helper installed)."));
        }
      } catch (error) {
        if (!options.json) {
          console.log(
            kleur.yellow(
              `Warning: failed to configure git credential helper: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      }
    }
  } else if (existing && !options.json) {
    console.log("");
    console.log(kleur.yellow("Token not stored (existing token kept)."));
  }

  if (options.json) {
    console.log(
      JSON.stringify({
        ok: true,
        profile: profile ?? null,
        configPath: profile ? getInstafyProfileConfigPath(profile) : getInstafyConfigPath(),
        stored: !options.noStore,
        method: usedPasswordGrant ? "password" : "token",
      }),
    );
    return;
  }

  console.log("");
  console.log("Next:");
  console.log(`- ${kleur.cyan("instafy space init")}`);
  console.log(`- ${kleur.cyan("instafy runtime start")}`);
}

export async function logout(options?: { json?: boolean; profile?: string }): Promise<void> {
  if (options?.profile) {
    clearInstafyProfileConfig(options.profile, ["accessToken", "refreshToken", "supabaseUrl", "supabaseAnonKey"]);
  } else {
    clearInstafyCliConfig(["accessToken", "refreshToken", "supabaseUrl", "supabaseAnonKey"]);
    try {
      uninstallGitCredentialHelper();
    } catch {
      // ignore git helper cleanup failures
    }
  }
  if (options?.json) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  if (options?.profile) {
    console.log(kleur.green(`Logged out (cleared saved access token for profile "${options.profile}").`));
  } else {
    console.log(kleur.green("Logged out (cleared saved access token)."));
  }
}
