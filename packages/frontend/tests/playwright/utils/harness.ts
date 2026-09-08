import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { switchToProject } from "./projects.js";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";
import { sanitizeCodexSubscriptionAuthJson } from "./codexSubscriptionAuthJson.js";
import { DEFAULT_CONTROLLER_URL, resolvePlaywrightControllerUrl } from "./controllerUrl.js";

const DEFAULT_SUPABASE_URL = "http://127.0.0.1:54321";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const DOCKER_DIR = path.join(REPO_ROOT, "docker");
const MACHINE_CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const PROXY_CODEX_AUTH_PATH = path.join(REPO_ROOT, "tmp", "proxy-codex", "auth.json");
const PLAYWRIGHT_CANONICAL_CODEX_LABEL = "Playwright canonical local Codex auth";
const USER_ENV_PATH = path.join(REPO_ROOT, ".env.user");
const PLAYWRIGHT_TOUCHED_PROJECT_IDS_PATH = path.join(
  REPO_ROOT,
  "tmp",
  ".playwright-touched-project-ids.log",
);
const ORIGIN_APPLY_BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const touchedProjectIds = new Set<string>();

function isOriginApplyBusyResponse(status: number, body: string): boolean {
  if (status !== 409) {
    return false;
  }
  try {
    const payload = JSON.parse(body) as { error?: unknown };
    return payload.error === "workspace is already applying changes";
  } catch {
    return false;
  }
}

function readEnvFile(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, "utf8");
    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          if (separator === -1) {
            return [line, ""];
          }
          const key = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
          return [key, value];
        }),
    );
  } catch {
    return {};
  }
}

const userEnv = readEnvFile(USER_ENV_PATH);
const PLAYWRIGHT_TEST_EMAIL_ENV =
  process.env.PLAYWRIGHT_TEST_EMAIL?.trim() ||
  process.env.TEST_USER_1_EMAIL?.trim() ||
  userEnv.PLAYWRIGHT_TEST_EMAIL?.trim() ||
  userEnv.TEST_USER_1_EMAIL?.trim() ||
  "";
const PLAYWRIGHT_TEST_PASSWORD_ENV =
  process.env.PLAYWRIGHT_TEST_PASSWORD?.trim() ||
  process.env.TEST_USER_1_PASSWORD?.trim() ||
  userEnv.PLAYWRIGHT_TEST_PASSWORD?.trim() ||
  userEnv.TEST_USER_1_PASSWORD?.trim() ||
  "";
const TEST_USER_EMAIL = PLAYWRIGHT_TEST_EMAIL_ENV || "playwright@instafy.dev";
const TEST_USER_PASSWORD = PLAYWRIGHT_TEST_PASSWORD_ENV || "Playwright123!";
const HAS_EXPLICIT_TEST_USER_CREDENTIALS =
  PLAYWRIGHT_TEST_EMAIL_ENV.length > 0 && PLAYWRIGHT_TEST_PASSWORD_ENV.length > 0;
const PLAYWRIGHT_LOGIN_MODE = (
  process.env.PLAYWRIGHT_LOGIN_MODE ??
  (HAS_EXPLICIT_TEST_USER_CREDENTIALS ? "service" : "guest")
).toLowerCase();

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type RuntimeStatusEntrySnapshot = {
  runtimeId?: string | null;
  displayName?: string | null;
  status?: string | null;
  health?: string | null;
  isLocal?: boolean;
};

export type HostedRuntimeReadyResult = {
  runtimeId: string;
  displayName: string | null;
  status: string | null;
  health: string | null;
  isLocal: boolean | null;
};

export type AuthSessionSnapshot = {
  accessToken: string;
  refreshToken: string;
  userId: string | null;
};

export type RealCodexCredentialSeedResult = {
  credentialId: string;
  kind: string;
  isDefault: boolean;
  created: boolean;
};

export type GuestLoginResult = {
  disposableUserId: string | null;
};

type HostedRuntimeExistingStrategy = "use-existing" | "launch-new" | "cancel";

export type OriginPresenceStatus = "online" | "offline" | "degraded";

export function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return UUID_REGEX.test(trimmed) ? trimmed : null;
}

export async function expectAssistantReplyOrSkipRateLimit(
  page: Page,
  expected: RegExp,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 90_000;
  const bubble = page.locator('[data-testid="chat-bubble-assistant"]').last();
  await expect(bubble).toBeVisible({ timeout });

  const text = await bubble.innerText().catch(() => "");
  if (isLiveAiBackendUnavailableText(text)) {
    const snippet = text.replace(/\s+/g, " ").slice(0, 240);
    test.skip(true, `Live AI backend unavailable; skipping Codex-dependent assertion. (${snippet})`);
  }

  try {
    await expect(bubble).toHaveText(expected, { timeout });
  } catch (error) {
    const finalText = await bubble.innerText().catch(() => "");
    if (isLiveAiBackendUnavailableText(finalText)) {
      const snippet = finalText.replace(/\s+/g, " ").slice(0, 240);
      test.skip(true, `Live AI backend unavailable; skipping Codex-dependent assertion. (${snippet})`);
    }
    throw error;
  }
}

export function isLiveAiBackendUnavailableText(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    lowered.includes("usage_limit_reached") ||
    lowered.includes("too many requests") ||
    lowered.includes("rate limit") ||
    lowered.includes("upstream 429") ||
    lowered.includes("429") ||
    lowered.includes("invalid_issuer") ||
    lowered.includes("invalid_api_key") ||
    lowered.includes("invalid api key") ||
    lowered.includes("authentication token is not from a valid issuer") ||
    ((lowered.includes("ai proxy error") || lowered.includes("proxy returned")) &&
      (lowered.includes("401") ||
        lowered.includes("unauthorized") ||
        lowered.includes("auth error code")))
  );
}

async function waitForBrowserSupabaseClient(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const client = (window as any).__INSTAFY_SUPABASE__;
        return !!client?.auth && typeof client.auth.setSession === "function";
      },
      undefined,
      {
        timeout: 15_000,
      },
    )
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Supabase client unavailable in browser context: ${message}`);
    });
}

async function gotoAppPath(
  page: Page,
  target: string,
  options?: {
    timeoutMs?: number;
    stepTimeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const stepTimeoutMs = options?.stepTimeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: stepTimeoutMs,
      });

      const currentUrl = page.url();
      if (currentUrl && !currentUrl.startsWith("chrome-error://") && currentUrl !== "about:blank") {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await page.waitForTimeout(500);
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`App path ${target} did not become reachable within ${timeoutMs}ms: ${message}`);
}

function cacheProjectId(value: string | null | undefined) {
  const normalized = normalizeProjectId(value);
  if (!normalized || touchedProjectIds.has(normalized)) {
    return;
  }
  touchedProjectIds.add(normalized);
  try {
    fs.mkdirSync(path.dirname(PLAYWRIGHT_TOUCHED_PROJECT_IDS_PATH), { recursive: true });
    fs.appendFileSync(PLAYWRIGHT_TOUCHED_PROJECT_IDS_PATH, `${normalized}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cacheProjectId] Failed to persist touched project id ${normalized}: ${message}`);
  }
}

async function readActiveProjectIdFromStore(page: Page): Promise<string | null> {
  try {
    const value = await page.evaluate(() => {
      const store = (window as any)?.["__INSTAFY_STORE__"];
      const state = store?.getState?.();
      const active = state?.activeProjectId;
      return typeof active === "string" && active.trim().length > 0 ? active.trim() : null;
    });
    return normalizeProjectId(value);
  } catch {
    return null;
  }
}

export async function getActiveOrgName(page: Page): Promise<string> {
  const orgName = await page
    .evaluate(() => {
      const store = (window as any)?.["__INSTAFY_STORE__"];
      const state = store?.getState?.();
      const activeProjectId = state?.activeProjectId;
      const projects = state?.projects;
      const org = activeProjectId ? projects?.[activeProjectId]?.org : null;
      return typeof org?.name === "string" ? org.name : null;
    })
    .catch(() => null);

  if (typeof orgName !== "string" || orgName.trim().length === 0) {
    throw new Error("Unable to resolve active org name.");
  }

  return orgName.trim();
}

export async function waitForStoreProjectId(
  page: Page,
  expected: string,
  timeoutMs = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readActiveProjectIdFromStore(page);
    if (current === expected) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  const finalValue = await readActiveProjectIdFromStore(page);
  return finalValue === expected;
}

export async function waitForProjectBootstrap(
  page: Page,
  expectedProjectId: string,
  timeoutMs = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const runtimeWindow = window as typeof window & {
          __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
          __INSTAFY_PROJECT_INITIALIZED__?: boolean;
        };
        if (!runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__) {
          return null;
        }
        return runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ ?? null;
      })
      .catch(() => null);
    if (ready && normalizeProjectId(ready) === expectedProjectId) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  const finalValue = await page
    .evaluate(() => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
        __INSTAFY_PROJECT_INITIALIZED__?: boolean;
      };
      if (!runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__) {
        return null;
      }
      return runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ ?? null;
    })
    .catch(() => null);
  return normalizeProjectId(finalValue) === expectedProjectId;
}

function resolvePreferredProjectId(candidate?: string | null): string | null {
  return normalizeProjectId(candidate);
}

async function syncStudioProjectQuery(page: Page, projectId: string): Promise<void> {
  await page
    .evaluate((pid) => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("projectId") === pid) {
        return;
      }
      url.searchParams.set("projectId", pid);
      const next = `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
      window.history.replaceState(window.history.state, document.title, next);
    }, projectId)
    .catch(() => {});
}

function parseProjectIdFromUrl(urlString: string | null | undefined): string | null {
  if (!urlString) {
    return null;
  }
  try {
    const parsed = new URL(urlString, "http://127.0.0.1");
    return normalizeProjectId(parsed.searchParams.get("projectId"));
  } catch {
    return null;
  }
}

type StudioGotoOptions = {
  projectId?: string | null;
  params?: Record<string, string | number | boolean | null | undefined>;
  hash?: string | null;
  waitUntil?: Parameters<Page["goto"]>[1]["waitUntil"];
};

export async function gotoStudio(
  page: Page,
  options?: StudioGotoOptions
): Promise<string | null> {
  const waitUntil = options?.waitUntil ?? "domcontentloaded";
  const normalizedProjectId = resolvePreferredProjectId(options?.projectId ?? null);
  const search = new URLSearchParams();
  if (options?.params) {
    for (const [key, rawValue] of Object.entries(options.params)) {
      if (rawValue === undefined || rawValue === null) {
        continue;
      }
      search.set(key, String(rawValue));
    }
  }
  if (normalizedProjectId && !search.has("projectId")) {
    search.set("projectId", normalizedProjectId);
  }
  const query = search.toString();
  const hash = options?.hash ? options.hash.replace(/^#/, "") : "";
  const targetUrl = `/studio${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
  await page.goto(targetUrl, { waitUntil });
  if (normalizedProjectId) {
    await waitForStoreProjectId(page, normalizedProjectId).catch(() => {});
    await switchToProject(page, normalizedProjectId).catch(() => {});
    await syncStudioProjectQuery(page, normalizedProjectId).catch(() => {});
  }
  return normalizedProjectId;
}

async function resolveAuthenticatedUserId(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_SUPABASE__?: { auth?: { getUser?: () => Promise<{ data?: { user?: { id?: string | null } | null } }> } };
      };
      const client = runtimeWindow.__INSTAFY_SUPABASE__;
      if (!client?.auth?.getUser) {
        return null;
      }
      const result = await client.auth.getUser();
      const userId = result?.data?.user?.id;
      return typeof userId === "string" && userId.trim().length > 0 ? userId.trim() : null;
    });
  } catch (_error) {
    return null;
  }
}

export async function resolveAuthenticatedAccessToken(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_SUPABASE__?: {
          auth?: {
            getSession?: () => Promise<{
              data?: {
                session?: {
                  access_token?: string | null;
                } | null;
              };
            }>;
          };
        };
      };
      const client = runtimeWindow.__INSTAFY_SUPABASE__;
      if (!client?.auth?.getSession) {
        return null;
      }
      const result = await client.auth.getSession();
      const accessToken = result?.data?.session?.access_token;
      return typeof accessToken === "string" && accessToken.trim().length > 0
        ? accessToken.trim()
        : null;
    });
  } catch (_error) {
    return null;
  }
}

function resolveRealCodexAuthJson(): Record<string, unknown> | null {
  // The canonical local Codex login is the only accepted source. Never let an
  // ambient paid API key silently switch these tests onto managed/API-key
  // billing when the machine login is unavailable.
  const authPath = fs.existsSync(MACHINE_CODEX_AUTH_PATH)
    ? MACHINE_CODEX_AUTH_PATH
    : PROXY_CODEX_AUTH_PATH;
  if (fs.existsSync(authPath)) {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    try {
      return sanitizeCodexSubscriptionAuthJson(parsed);
    } catch {
      throw new Error(
        `${authPath === MACHINE_CODEX_AUTH_PATH ? "~/.codex/auth.json" : "The mirrored Codex auth.json"} does not contain a usable Codex subscription login.`,
      );
    }
  }
  return null;
}

async function fetchCredentialJson(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<{ response: Response; payload: unknown }> {
  // Use Node fetch rather than Playwright's APIRequestContext. The latter is
  // recorded in retain-on-failure trace.zip files, including request bodies;
  // auth.json must exist only in memory and in the controller's encrypted
  // credential store.
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set("accept", "application/json");
    response = await fetch(url, {
      ...init,
      headers,
    });
  } catch (error) {
    throw new Error(
      `Credential controller request failed (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  }
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function assertByocCredentialMode(
  controllerUrl: string,
  accessToken: string,
): Promise<boolean> {
  const requirements = await fetchCredentialJson(
    `${controllerUrl}/me/credentials/requirements`,
    accessToken,
  );
  if (!requirements.response.ok) {
    throw new Error(
      `Unable to check Codex credential requirements (${requirements.response.status}).`,
    );
  }
  const payload =
    requirements.payload &&
    typeof requirements.payload === "object" &&
    !Array.isArray(requirements.payload)
      ? (requirements.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    throw new Error("Codex credential requirements response was invalid.");
  }
  const proxyBackend =
    typeof payload.proxyBackend === "string"
      ? payload.proxyBackend.trim().toLowerCase()
      : "";
  const byocBackend = proxyBackend === "remote_dynamic";
  if (!byocBackend) {
    if (fs.existsSync(MACHINE_CODEX_AUTH_PATH)) {
      throw new Error(
        "The controller is not using its BYOC proxy backend; refusing managed/static AI access while this machine's Codex login is available.",
      );
    }
    return false;
  }
  return true;
}

async function emitAiConfigChanged(page: Page, reason: string): Promise<void> {
  await page
    .evaluate((eventReason) => {
      window.dispatchEvent(
        new CustomEvent("instafy:ai-config-changed", {
          detail: {
            reason: eventReason,
            at: Date.now(),
          },
        })
      );
    }, reason)
    .catch(() => {});
}

export async function ensureRealDefaultCodexCredentialForAccessToken(
  controllerUrl: string,
  accessToken: string,
): Promise<RealCodexCredentialSeedResult> {
  if (!controllerUrl.trim() || !accessToken.trim()) {
    throw new Error(
      "Unable to seed a real Codex credential without an authenticated controller session.",
    );
  }
  await assertByocCredentialMode(controllerUrl, accessToken);

  const listed = await fetchCredentialJson(
    `${controllerUrl}/me/credentials`,
    accessToken,
  );
  if (!listed.response.ok) {
    throw new Error(
      `Unable to list user credentials (${listed.response.status}).`,
    );
  }

  if (!Array.isArray(listed.payload)) {
    throw new Error("Credential list response from controller was invalid.");
  }
  const credentials = listed.payload as Array<Record<string, unknown>>;
  const existingDefault = credentials.find((entry) => {
    const kind = typeof entry?.kind === "string" ? entry.kind : "";
    const label = typeof entry?.label === "string" ? entry.label : "";
    const isDefault = entry?.isDefault === true;
    const revokedAt = entry?.revokedAt;
    return (
      isDefault &&
      revokedAt == null &&
      kind === "codex_auth_json" &&
      label === PLAYWRIGHT_CANONICAL_CODEX_LABEL
    );
  });

  if (existingDefault) {
    const credentialId =
      typeof existingDefault.id === "string" && existingDefault.id.trim().length > 0
        ? existingDefault.id.trim()
        : null;
    if (!credentialId) {
      throw new Error("Default Codex credential response was missing its id.");
    }
    return {
      credentialId,
      kind: "codex_auth_json",
      isDefault: true,
      created: false,
    };
  }

  const authJson = resolveRealCodexAuthJson();
  if (!authJson) {
    throw new Error(
      "No canonical local Codex auth is available for Playwright. Run `pnpm controller:up` after `codex login` so tmp/proxy-codex/auth.json is present.",
    );
  }

  const createdResponse = await fetchCredentialJson(
    `${controllerUrl}/me/credentials/codex`,
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authJson,
        label: PLAYWRIGHT_CANONICAL_CODEX_LABEL,
        makeDefault: true,
      }),
    },
  );
  if (!createdResponse.response.ok) {
    throw new Error(
      `Unable to create Codex credential (${createdResponse.response.status}).`,
    );
  }

  const created =
    createdResponse.payload &&
    typeof createdResponse.payload === "object" &&
    !Array.isArray(createdResponse.payload)
      ? (createdResponse.payload as Record<string, unknown>)
      : null;
  const credentialId =
    typeof created?.credentialId === "string" && created.credentialId.trim().length > 0
      ? created.credentialId.trim()
      : null;
  const kind = created?.kind;
  const isDefault = created?.isDefault === true;
  if (!credentialId || kind !== "codex_auth_json" || !isDefault) {
    throw new Error(
      "Controller did not confirm a default Codex auth.json credential.",
    );
  }

  return {
    credentialId,
    kind,
    isDefault,
    created: true,
  };
}

export async function ensureRealDefaultCodexCredential(
  page: Page
): Promise<RealCodexCredentialSeedResult> {
  const controllerUrl = resolveControllerUrl();
  const accessToken = await resolveAuthenticatedAccessToken(page);
  if (!controllerUrl || !accessToken) {
    throw new Error(
      "Unable to seed a real Codex credential without an authenticated controller session.",
    );
  }
  const result = await ensureRealDefaultCodexCredentialForAccessToken(
    controllerUrl,
    accessToken,
  );
  await emitAiConfigChanged(
    page,
    result.created
      ? "playwright_seed_codex_credential"
      : "playwright_existing_codex_credential",
  );
  return result;
}

export async function ensureRealDefaultCodexCredentialWhenRequired(
  page: Page,
): Promise<RealCodexCredentialSeedResult | null> {
  const controllerUrl = resolveControllerUrl();
  const accessToken = await resolveAuthenticatedAccessToken(page);
  if (!controllerUrl || !accessToken) {
    throw new Error(
      "Unable to check Codex credential requirements without an authenticated controller session.",
    );
  }
  if (!(await assertByocCredentialMode(controllerUrl, accessToken))) {
    return null;
  }
  return ensureRealDefaultCodexCredential(page);
}

export async function purgeRealUserCredential(page: Page, credentialId: string): Promise<void> {
  const normalizedId = credentialId.trim();
  if (!normalizedId) {
    throw new Error("Unable to purge a credential without its identifier.");
  }
  const supabaseUrl = resolveSupabaseUrl();
  const serviceRole = resolveServiceRoleKey();
  const session = await resolveAuthenticatedSessionSnapshot(page);
  const userId = session?.userId?.trim() ?? "";
  if (!supabaseUrl || !serviceRole || !userId) {
    throw new Error(
      "Unable to purge the disposable Codex credential without service-role and user identity evidence.",
    );
  }
  const filter = new URLSearchParams({
    id: `eq.${normalizedId}`,
    user_id: `eq.${userId}`,
  });
  const headers = {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
  };
  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_credentials?${filter.toString()}`,
    { method: "DELETE", headers: { ...headers, prefer: "return=minimal" } },
  );
  if (!response.ok) {
    throw new Error(`Unable to purge the disposable Codex credential (HTTP ${response.status}).`);
  }
  const verify = await fetch(
    `${supabaseUrl}/rest/v1/user_credentials?${filter.toString()}&select=id`,
    { headers: { ...headers, accept: "application/json" } },
  );
  if (!verify.ok) {
    throw new Error(`Unable to verify disposable credential purge (HTTP ${verify.status}).`);
  }
  const remaining = (await verify.json().catch(() => null)) as unknown;
  if (!Array.isArray(remaining) || remaining.length > 0) {
    throw new Error("Disposable Codex credential purge could not be verified.");
  }
  await emitAiConfigChanged(page, "playwright_purge_codex_credential");
}

export async function deleteDisposableTestUser(userId: string): Promise<void> {
  const normalizedUserId = userId.trim();
  const supabaseUrl = resolveSupabaseUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!normalizedUserId || !supabaseUrl || !serviceRole) {
    throw new Error("Unable to delete the disposable test user without service-role identity evidence.");
  }
  const response = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(normalizedUserId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceRole,
        authorization: `Bearer ${serviceRole}`,
      },
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Disposable test-user cleanup returned HTTP ${response.status}.`);
  }
}

async function resolveAuthenticatedSessionSnapshot(
  page: Page
): Promise<AuthSessionSnapshot | null> {
  try {
    return await page.evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_SUPABASE__?: {
          auth?: {
            getSession?: () => Promise<{
              data?: {
                session?: {
                  access_token?: string | null;
                  refresh_token?: string | null;
                  user?: { id?: string | null } | null;
                } | null;
              };
            }>;
          };
        };
      };
      const client = runtimeWindow.__INSTAFY_SUPABASE__;
      if (!client?.auth?.getSession) {
        return null;
      }
      const result = await client.auth.getSession();
      const session = result?.data?.session;
      const accessToken =
        typeof session?.access_token === "string" && session.access_token.trim().length > 0
          ? session.access_token.trim()
          : null;
      const refreshToken =
        typeof session?.refresh_token === "string" && session.refresh_token.trim().length > 0
          ? session.refresh_token.trim()
          : null;
      if (!accessToken || !refreshToken) {
        return null;
      }
      const userId =
        typeof session?.user?.id === "string" && session.user.id.trim().length > 0
          ? session.user.id.trim()
          : null;
      return { accessToken, refreshToken, userId };
    });
  } catch (_error) {
    return null;
  }
}

export async function captureAuthenticatedSession(
  page: Page
): Promise<AuthSessionSnapshot | null> {
  return await resolveAuthenticatedSessionSnapshot(page);
}

export async function clearNotificationInbox(page: Page): Promise<void> {
  const session = await resolveAuthenticatedSessionSnapshot(page);
  const accessToken = session?.accessToken?.trim() ?? "";
  if (!accessToken) {
    throw new Error("Unable to clear inbox without an authenticated controller session.");
  }

  const controllerUrl = (process.env.PLAYWRIGHT_CONTROLLER_URL ?? DEFAULT_CONTROLLER_URL).trim();
  const normalizedControllerUrl = controllerUrl.replace(/\/+$/g, "");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${normalizedControllerUrl}/me/notifications/inbox?limit=100`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Unable to list inbox items (${response.status}): ${detail}`);
    }

    const payload = (await response.json().catch(() => null)) as
      | { items?: Array<{ conversationId?: string | null }> | null }
      | null;
    const conversationIds = [
      ...new Set(
        (payload?.items ?? [])
          .map((item) => (typeof item?.conversationId === "string" ? item.conversationId.trim() : ""))
          .filter((value) => value.length > 0),
      ),
    ];
    if (conversationIds.length === 0) {
      return;
    }

    await Promise.all(
      conversationIds.map(async (conversationId) => {
        const ackResponse = await fetch(`${normalizedControllerUrl}/me/notifications/inbox/ack`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ conversationId }),
        });
        if (!ackResponse.ok) {
          const detail = await ackResponse.text().catch(() => "");
          throw new Error(`Unable to acknowledge inbox item ${conversationId} (${ackResponse.status}): ${detail}`);
        }
      }),
    );
  }

  throw new Error("Inbox still contained items after repeated acknowledgement attempts.");
}

export async function restoreAuthenticatedSession(
  page: Page,
  session: AuthSessionSnapshot,
  options?: {
    landingPath?: string | null;
  },
): Promise<void> {
  await gotoAppPath(page, "/login");
  await clearSupabaseAuthState(page);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await waitForSupabaseClient(page);
  await page
    .waitForFunction(
      () => {
        const client = (window as any)?.__INSTAFY_SUPABASE__;
        return !!client?.auth && typeof client.auth.setSession === "function";
      },
      undefined,
      { timeout: 15_000 }
    )
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Supabase client unavailable in browser context: ${message}`);
    });

  await page.evaluate(
    async ({ accessToken, refreshToken }) => {
      const client = (window as any).__INSTAFY_SUPABASE__;
      await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    },
    {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    }
  );

  const landingPath = options?.landingPath === undefined ? "/studio" : options.landingPath;
  if (landingPath) {
    const expectedPathname = (() => {
      try {
        return new URL(landingPath, "http://127.0.0.1").pathname;
      } catch {
        return landingPath;
      }
    })();
    await gotoAppPath(page, landingPath);
    await page
      .waitForURL((url) => url.pathname === expectedPathname, {
        timeout: 30_000,
      })
      .catch(() => {});
  }

  if (session.userId) {
    if (landingPath) {
      await expect
        .poll(async () => await resolveAuthenticatedUserId(page), {
          timeout: 30_000,
        })
        .toBe(session.userId);
    } else {
      await expect
        .poll(async () => (await resolveAuthenticatedSessionSnapshot(page))?.userId ?? null, {
          timeout: 10_000,
        })
        .toBe(session.userId);
    }
  }
}

async function resolveTestUserId(page: Page): Promise<string | null> {
  // Guest-mode tests create a new authenticated user for each browser context.
  // Resolve the current page session before every lease operation so a worker
  // never reuses another test's user id against a newly created project.
  const sessionUserId = await resolveAuthenticatedUserId(page);
  if (sessionUserId) {
    return sessionUserId;
  }
  const supabaseUrl = resolveSupabaseUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!supabaseUrl || !serviceRole) {
    return null;
  }
  try {
    const response = await page.context().request.get(
      `${supabaseUrl}/auth/v1/admin/users`,
      {
        headers: {
          apikey: serviceRole,
          authorization: `Bearer ${serviceRole}`,
        },
        params: { email: TEST_USER_EMAIL },
      }
    );
    if (!response.ok()) {
      return null;
    }
    const payload = (await response.json()) as
      | { users?: Array<{ id?: string }> }
      | { user?: { id?: string } }
      | Array<{ id?: string }>;
    let userId: string | null = null;
    if (Array.isArray(payload)) {
      userId = payload.find((entry) => typeof entry?.id === "string")?.id ?? null;
    } else if (payload && "users" in payload && Array.isArray(payload.users)) {
      userId = payload.users.find((entry) => typeof entry?.id === "string")?.id ?? null;
    } else if (payload && "user" in payload && payload.user && typeof payload.user.id === "string") {
      userId = payload.user.id;
    }
    return userId ?? null;
  } catch (_error) {
    return null;
  }
}

function resolveSupabaseUrl(): string {
  return (
    process.env.PLAYWRIGHT_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    DEFAULT_SUPABASE_URL
  );
}

function resolveSupabaseAnonKey(): string {
  return (
    process.env.PLAYWRIGHT_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  );
}

export function getSupabaseUrl(): string {
  return resolveSupabaseUrl();
}

export const getHarnessUrl = getSupabaseUrl; // backwards compatibility for existing imports

export async function resetSupabase(page: Page) {
  await purgeProjectData(page).catch((error) => {
    console.warn(
      `[resetSupabase] Unable to purge project data: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

async function waitForSupabaseReady(page: Page, timeoutMs = 45_000) {
  const supabaseUrl = resolveSupabaseUrl();
  if (!supabaseUrl) {
    return;
  }

  const headers = getSupabaseAuthHeaders();
  const deadline = Date.now() + timeoutMs;

  // Poll a lightweight endpoint until Supabase responds or timeout expires.
  while (Date.now() < deadline) {
    try {
      const response = await page
        .context()
        .request.get(`${supabaseUrl}/rest/v1/projects?select=id&limit=1`, { headers });
      if (response.ok()) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ECONNREFUSED")) {
        console.warn(`[resetSupabase] Supabase probe failed: ${message}`);
      }
    }
    await page.waitForTimeout(300);
  }

  console.warn(`[resetSupabase] Timed out waiting for Supabase at ${supabaseUrl}`);
}

export const resetHarness = resetSupabase;

export async function readNumber(locator: import("@playwright/test").Locator) {
  await expect.poll(async () => Number((await locator.textContent())?.trim() ?? NaN)).toBeGreaterThanOrEqual(0);
  return Number((await locator.textContent())?.trim() ?? 0);
}

export function getSupabaseAuthHeaders(): Record<string, string> {
  const serviceRole =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    "";
  if (!serviceRole) {
    return {};
  }
  return {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`
  } satisfies Record<string, string>;
}

function resolveControllerUrl(): string {
  return resolvePlaywrightControllerUrl(process.env);
}

export function getControllerUrl(): string {
  return resolveControllerUrl();
}

function resolveServiceRoleKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    ""
  );
}

export async function resolveWorkspaceProjectId(page: Page): Promise<string | null> {
  const resolveFromWindow = async () => {
    try {
      return await page.evaluate(() => {
        const runtimeWindow = window as typeof window & {
          __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
          __INSTAFY_STORE__?: { getState?: () => { activeProjectId?: string | null } };
        };
        const explicit = runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__;
        if (typeof explicit === "string" && explicit.trim().length > 0) {
          return explicit.trim();
        }
        const storeState = runtimeWindow.__INSTAFY_STORE__?.getState?.();
        const storeProjectId = storeState?.activeProjectId;
        if (typeof storeProjectId === "string" && storeProjectId.trim().length > 0) {
          return storeProjectId.trim();
        }
        return null;
      });
    } catch {
      return null;
    }
  };

  const windowProjectId = normalizeProjectId(await resolveFromWindow());
  if (windowProjectId) {
    cacheProjectId(windowProjectId);
    return windowProjectId;
  }

  const urlProjectId = normalizeProjectId(parseProjectIdFromUrl(page.url()));
  if (urlProjectId) {
    cacheProjectId(urlProjectId);
    return urlProjectId;
  }

  return null;
}

type WorkspaceDeletionTarget =
  | string
  | {
      path: string;
      recursive?: boolean;
    };

export async function ensureWorkspacePathsAbsent(
  page: Page,
  paths: WorkspaceDeletionTarget[],
  options?: { projectId?: string | null }
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const normalizedTargets = Array.from(
    new Set(
      paths
        .map((entry) => (typeof entry === "string" ? entry : entry.path))
        .map((value) => normalizeWorkspaceRelativePath(value))
        .filter((value) => value.length > 0)
    )
  );
  if (normalizedTargets.length === 0) {
    return;
  }
  await applyWorkspaceChanges(page, {
    files: [],
    deletes: normalizedTargets,
    projectId: options?.projectId ?? undefined
  });
}

export async function readWorkspaceFileText(
  page: Page,
  path: string,
  options?: { projectId?: string | null; preferRuntimeId?: string | null }
): Promise<string | null> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    return null;
  }
  const projectId = options?.projectId ?? (await resolveWorkspaceProjectId(page));
  if (!projectId) {
    return null;
  }
  try {
    const token = await requestOriginAccessToken(page, {
      controllerUrl,
      serviceRole,
      projectId,
      scopes: ["fs.read"],
      preferRuntimeId: options?.preferRuntimeId ?? null,
    });
    if (!token) {
      return null;
    }
    const url = buildOriginFileUrl(token.endpoint, path ?? "");
	    if (path) {
	      // query param no longer required when using /files/* route, but keep
	      // compatibility with older HTTP origins that still inspect path.
	      url.searchParams.set("path", path);
	    }
	    type OriginFileResponse = {
	      type?: string;
	      contentBase64?: string | null;
	      content_base64?: string | null;
	    };

	    let payload: OriginFileResponse | null = null;
	    if (shouldResolveLocalTunnelHost(url.hostname)) {
	      const port = resolveUrlPort(url);
	      const resolveTarget = `${url.hostname}:${port}:${resolveLocalTunnelIngressIp()}`;
	      const { statusCode, body, stderr } = runCurlWithHttpStatus([
	        "--insecure",
	        "--resolve",
	        resolveTarget,
	        "--header",
	        `Host: ${url.hostname}`,
	        "--header",
	        `authorization: Bearer ${token.token}`,
	        "--header",
	        "accept: application/json",
	        url.toString()
	      ]);
	      if (statusCode === 404) {
	        return null;
	      }
	      if (statusCode < 200 || statusCode >= 300) {
	        const combined = [body.trim(), stderr.trim()].filter(Boolean).join("\n");
	        console.warn(
	          `[readWorkspaceFileText] origin returned ${statusCode} for ${url.toString()}: ${combined}`
	        );
	        return null;
	      }
	      payload = (body ? (JSON.parse(body) as OriginFileResponse) : null) ?? null;
	    } else {
	      const fileResponse = await page.context().request.get(url.toString(), {
	        headers: {
	          authorization: `Bearer ${token.token}`,
	          accept: "application/json"
	        }
	      });
	      if (!fileResponse.ok()) {
	        return null;
	      }
	      payload = (await fileResponse.json().catch(() => null)) as OriginFileResponse | null;
	    }
	    if (!payload || Array.isArray(payload)) {
	      return null;
	    }
	    const contentBase64 =
	      payload.contentBase64 ?? payload.content_base64 ?? "";
    if (!contentBase64) {
      return "";
    }
    return Buffer.from(contentBase64, "base64").toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[readWorkspaceFileText] Unable to read ${path}: ${message}`);
    return null;
  }
}

export type OriginWorkspaceEntry = {
  name: string;
  path: string;
  kind?: string | null;
  hasChildren?: boolean;
};

export async function listWorkspaceEntries(
  page: Page,
  rawPath: string,
  options?: { projectId?: string | null; preferRuntimeId?: string | null }
): Promise<OriginWorkspaceEntry[] | null> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    return null;
  }
  const projectId = options?.projectId ?? (await resolveWorkspaceProjectId(page));
  if (!projectId) {
    return null;
  }

  const normalizedPath = normalizeWorkspaceRelativePath(rawPath ?? "");

  try {
    const token = await requestOriginAccessToken(page, {
      controllerUrl,
      serviceRole,
      projectId,
      scopes: ["fs.read"],
      preferRuntimeId: options?.preferRuntimeId ?? null,
    });
    if (!token) {
      return null;
    }

    const sanitizedEndpoint = token.endpoint.replace(/\/+$/, "");
    const base = sanitizedEndpoint.endsWith("/") ? sanitizedEndpoint : `${sanitizedEndpoint}/`;
    const url = new URL("entries", base);
    if (normalizedPath) {
      url.searchParams.set("path", normalizedPath);
    }

    const resolvePayload = (payload: unknown): OriginWorkspaceEntry[] | null => {
      if (!Array.isArray(payload)) {
        return null;
      }
      return payload
        .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          name: typeof entry.name === "string" ? entry.name : "",
          path: typeof entry.path === "string" ? entry.path : "",
          kind: typeof entry.kind === "string" ? entry.kind : null,
          hasChildren: typeof entry.hasChildren === "boolean" ? entry.hasChildren : undefined,
        }))
        .filter((entry) => entry.name.trim().length > 0 && entry.path.trim().length > 0);
    };

    if (shouldResolveLocalTunnelHost(url.hostname)) {
      const port = resolveUrlPort(url);
      const resolveTarget = `${url.hostname}:${port}:${resolveLocalTunnelIngressIp()}`;
      const { statusCode, body, stderr } = runCurlWithHttpStatus([
        "--insecure",
        "--resolve",
        resolveTarget,
        "--header",
        `Host: ${url.hostname}`,
        "--header",
        `authorization: Bearer ${token.token}`,
        "--header",
        "accept: application/json",
        url.toString()
      ]);
      if (statusCode === 404) {
        return [];
      }
      if (statusCode < 200 || statusCode >= 300) {
        const combined = [body.trim(), stderr.trim()].filter(Boolean).join("\n");
        console.warn(
          `[listWorkspaceEntries] origin returned ${statusCode} for ${url.toString()}: ${combined}`
        );
        return null;
      }
      const parsed = body ? (JSON.parse(body) as unknown) : null;
      return resolvePayload(parsed);
    }

    const response = await page.context().request.get(url.toString(), {
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json"
      }
    });
    if (response.status() === 404) {
      return [];
    }
    if (!response.ok()) {
      const text = await response.text().catch(() => "");
      console.warn(`[listWorkspaceEntries] origin returned ${response.status()} for ${url.toString()}: ${text}`);
      return null;
    }
    const payload = await response.json().catch(() => null);
    return resolvePayload(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[listWorkspaceEntries] Unable to list ${rawPath}: ${message}`);
    return null;
  }
}

export async function fetchWorkspaceRawText(
  page: Page,
  rawPath: string,
  options?: { projectId?: string | null; preferRuntimeId?: string | null }
): Promise<{ url: string; statusCode: number; body: string } | null> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    return null;
  }
  const projectId = options?.projectId ?? (await resolveWorkspaceProjectId(page));
  if (!projectId) {
    return null;
  }

  const token = await requestOriginAccessToken(page, {
    controllerUrl,
    serviceRole,
    projectId,
    scopes: ["fs.read"],
    preferRuntimeId: options?.preferRuntimeId ?? null,
  });
  if (!token) {
    return null;
  }

  const url = buildOriginRawUrl(token.endpoint, rawPath ?? "");
  url.searchParams.set("token", token.token);

  if (shouldResolveLocalTunnelHost(url.hostname)) {
    const port = resolveUrlPort(url);
    const resolveTarget = `${url.hostname}:${port}:${resolveLocalTunnelIngressIp()}`;
    const { statusCode, body, stderr } = runCurlWithHttpStatus([
      "--insecure",
      "--resolve",
      resolveTarget,
      "--header",
      `Host: ${url.hostname}`,
      url.toString(),
    ]);
    if (statusCode === 0) {
      const combined = [body.trim(), stderr.trim()].filter(Boolean).join("\n");
      console.warn(`[fetchWorkspaceRawText] curl failed for ${url.toString()}: ${combined}`);
    }
    return { url: url.toString(), statusCode, body };
  }

  const response = await page.context().request.get(url.toString(), {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const body = await response.text().catch(() => "");
  return { url: url.toString(), statusCode: response.status(), body };
}

export async function readWorkspaceFileBytes(
  page: Page,
  path: string,
  options?: { projectId?: string | null }
): Promise<Buffer | null> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    return null;
  }
  const projectId = options?.projectId ?? (await resolveWorkspaceProjectId(page));
  if (!projectId) {
    return null;
  }
  try {
    const token = await requestOriginAccessToken(page, {
      controllerUrl,
      serviceRole,
      projectId,
      scopes: ["fs.read"]
    });
    if (!token) {
      return null;
    }
    const url = buildOriginFileUrl(token.endpoint, path ?? "");
    if (path) {
      // query param no longer required when using /files/* route, but keep
      // compatibility with older HTTP origins that still inspect path.
      url.searchParams.set("path", path);
    }
    type OriginFileResponse = {
      type?: string;
      contentBase64?: string | null;
      content_base64?: string | null;
    };

    let payload: OriginFileResponse | null = null;
    if (shouldResolveLocalTunnelHost(url.hostname)) {
      const port = resolveUrlPort(url);
      const resolveTarget = `${url.hostname}:${port}:${resolveLocalTunnelIngressIp()}`;
      const { statusCode, body, stderr } = runCurlWithHttpStatus([
        "--insecure",
        "--resolve",
        resolveTarget,
        "--header",
        `Host: ${url.hostname}`,
        "--header",
        `authorization: Bearer ${token.token}`,
        "--header",
        "accept: application/json",
        url.toString()
      ]);
      if (statusCode === 404) {
        return null;
      }
      if (statusCode < 200 || statusCode >= 300) {
        const combined = [body.trim(), stderr.trim()].filter(Boolean).join("\n");
        console.warn(
          `[readWorkspaceFileBytes] origin returned ${statusCode} for ${url.toString()}: ${combined}`
        );
        return null;
      }
      payload = (body ? (JSON.parse(body) as OriginFileResponse) : null) ?? null;
    } else {
      const fileResponse = await page.context().request.get(url.toString(), {
        headers: {
          authorization: `Bearer ${token.token}`,
          accept: "application/json"
        }
      });
      if (!fileResponse.ok()) {
        return null;
      }
      payload = (await fileResponse.json().catch(() => null)) as OriginFileResponse | null;
    }
    if (!payload || Array.isArray(payload)) {
      return null;
    }
    const contentBase64 = payload.contentBase64 ?? payload.content_base64 ?? "";
    if (!contentBase64) {
      return Buffer.alloc(0);
    }
    return Buffer.from(contentBase64, "base64");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[readWorkspaceFileBytes] Unable to read ${path}: ${message}`);
    return null;
  }
}

const DEFAULT_GIT_REMOTE_BASE_URL = "http://127.0.0.1:8080";

function resolveGitRemoteBaseUrl(): string {
  const explicit =
    process.env.PLAYWRIGHT_GIT_REMOTE_BASE_URL ||
    process.env.GIT_REMOTE_BASE_URL;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim().replace(/\/+$/, "");
  }

  const edgePort = Number(process.env.GIT_EDGE_PORT || 8080);
  if (Number.isFinite(edgePort) && edgePort > 0) {
    return `http://127.0.0.1:${edgePort}`;
  }

  return DEFAULT_GIT_REMOTE_BASE_URL;
}

async function requestGitAccessToken(
  page: Page,
  options: {
    controllerUrl: string;
    serviceRole: string;
    projectId: string;
    scopes?: string[];
    ttlSeconds?: number;
  }
): Promise<string | null> {
  const response = await page.context().request.post(
    `${options.controllerUrl}/projects/${encodeURIComponent(options.projectId)}/git/access_token`,
    {
      headers: {
        authorization: `Bearer ${options.serviceRole}`,
        "content-type": "application/json"
      },
      data: {
        scopes: options.scopes && options.scopes.length > 0 ? options.scopes : ["git.read"],
        ttlSeconds: options.ttlSeconds ?? 600
      }
    }
  );
  if (!response.ok()) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as
    | { token?: string }
    | null;
  const token = typeof payload?.token === "string" ? payload.token.trim() : "";
  return token || null;
}

function runGit(
  args: string[],
  options: { cwd: string }
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? ""
  };
}

function isTransientGitTransportFailure(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): boolean {
  if (result.exitCode === 0) {
    return false;
  }
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    text.includes("http 500") ||
    text.includes("http 502") ||
    text.includes("http 503") ||
    text.includes("http 504") ||
    text.includes("remote end hung up unexpectedly") ||
    text.includes("the requested url returned error") ||
    text.includes("connection reset by peer") ||
    text.includes("operation timed out") ||
    text.includes("connection timed out")
  );
}

function runGitWithTransientRetry(
  args: string[],
  options: { cwd: string; attempts?: number }
): { exitCode: number; stdout: string; stderr: string } {
  const attempts = Math.max(1, options.attempts ?? 1);
  let result = runGit(args, { cwd: options.cwd });
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (!isTransientGitTransportFailure(result)) {
      break;
    }
    result = runGit(args, { cwd: options.cwd });
  }
  return result;
}

export async function assertGitRemoteFileText(
  page: Page,
  filePath: string,
  options: {
    projectId: string;
    expectedText: string;
    branch?: string;
    timeoutMs?: number;
    gitRemoteBaseUrl?: string;
    requireGitRemote?: boolean;
  }
): Promise<void> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    throw new Error("[assertGitRemoteFileText] Controller auth missing for git remote assertion.");
  }

  const requireGitRemote =
    typeof options.requireGitRemote === "boolean"
      ? options.requireGitRemote
      : (process.env.GIT_CANONICAL ?? "").trim() === "1"
        ? true
        : undefined;

  const shardRoute = await page.context().request
    .get(`${controllerUrl}/projects/${encodeURIComponent(options.projectId)}/git/shard`, {
      headers: { authorization: `Bearer ${serviceRole}` }
    })
    .catch(() => null);

  if (!shardRoute?.ok()) {
    if (requireGitRemote ?? false) {
      const status = shardRoute?.status() ?? 0;
      const body = shardRoute ? await shardRoute.text().catch(() => "") : "";
      throw new Error(
        `[assertGitRemoteFileText] git shard routing unavailable (status=${status}). ${body.trim()}`
      );
    }
    return;
  }

  const requireForConfiguredRemote = requireGitRemote ?? true;

  const baseUrl = (options.gitRemoteBaseUrl ?? resolveGitRemoteBaseUrl())
    .trim()
    .replace(/\/+$/, "");

  const health = await page.context().request.get(`${baseUrl}/healthz`).catch(() => null);
  if (!health?.ok()) {
    if (requireForConfiguredRemote) {
      throw new Error(`[assertGitRemoteFileText] git-edge not reachable at ${baseUrl}.`);
    }
    return;
  }

  const remoteUrl = `${baseUrl}/${options.projectId}.git`;
  const token = await requestGitAccessToken(page, {
    controllerUrl,
    serviceRole,
    projectId: options.projectId,
    scopes: ["git.read"]
  });
  if (!token) {
    throw new Error("[assertGitRemoteFileText] Unable to mint git access token.");
  }

  const expected = (options.expectedText ?? "").trim();
  if (!expected) {
    throw new Error("[assertGitRemoteFileText] expectedText must be non-empty.");
  }

  const normalized = (filePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`[assertGitRemoteFileText] Invalid filePath: ${filePath}`);
  }

  const branch = options.branch ?? "main";
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pollDelayMs = 2_000;
  let lastError = "not started";

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-git-remote-"));
  try {
    const init = runGit(["init"], { cwd: tempDir });
    if (init.exitCode !== 0) {
      throw new Error(`[assertGitRemoteFileText] git init failed: ${init.stderr.trim()}`);
    }
    const remoteAdd = runGit(["remote", "add", "origin", remoteUrl], { cwd: tempDir });
    if (remoteAdd.exitCode !== 0) {
      throw new Error(
        `[assertGitRemoteFileText] git remote add failed: ${remoteAdd.stderr.trim()}`
      );
    }

    while (Date.now() < deadline) {
      const fetch = runGitWithTransientRetry(
        [
          "-c",
          `http.extraHeader=Authorization: Bearer ${token}`,
          "fetch",
          "--depth",
          "1",
          "origin",
          branch
        ],
        { cwd: tempDir, attempts: 3 }
      );

      if (fetch.exitCode === 0) {
        const checkout = runGit(["checkout", "-B", "main", "FETCH_HEAD"], { cwd: tempDir });
        if (checkout.exitCode === 0) {
          const absolutePath = path.join(tempDir, ...normalized.split("/"));
          if (fs.existsSync(absolutePath)) {
            const contents = fs.readFileSync(absolutePath, "utf8").trim();
            if (contents === expected) {
              return;
            }
            lastError = `file contents mismatch (got ${JSON.stringify(contents)})`;
          } else {
            lastError = "file missing in fetched commit";
          }
        } else {
          lastError = checkout.stderr.trim() || checkout.stdout.trim() || "git checkout failed";
        }
      } else {
        lastError = fetch.stderr.trim() || fetch.stdout.trim() || "git fetch failed";
      }

      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  throw new Error(
    `[assertGitRemoteFileText] Timed out waiting for ${normalized}=${JSON.stringify(expected)} in ${remoteUrl} (${branch}). ` +
      `Last error: ${lastError}`
  );
}

export async function assertGitRemotePathIsNotGitlink(
  page: Page,
  repoPath: string,
  options: {
    projectId: string;
    branch?: string;
    timeoutMs?: number;
    gitRemoteBaseUrl?: string;
    requireGitRemote?: boolean;
  }
): Promise<void> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    throw new Error(
      "[assertGitRemotePathIsNotGitlink] Controller auth missing for git remote assertion."
    );
  }

  const requireGitRemote =
    typeof options.requireGitRemote === "boolean"
      ? options.requireGitRemote
      : (process.env.GIT_CANONICAL ?? "").trim() === "1"
        ? true
        : undefined;

  const shardRoute = await page.context().request
    .get(`${controllerUrl}/projects/${encodeURIComponent(options.projectId)}/git/shard`, {
      headers: { authorization: `Bearer ${serviceRole}` }
    })
    .catch(() => null);

  if (!shardRoute?.ok()) {
    if (requireGitRemote ?? false) {
      const status = shardRoute?.status() ?? 0;
      const body = shardRoute ? await shardRoute.text().catch(() => "") : "";
      throw new Error(
        `[assertGitRemotePathIsNotGitlink] git shard routing unavailable (status=${status}). ${body.trim()}`
      );
    }
    return;
  }

  const requireForConfiguredRemote = requireGitRemote ?? true;
  const baseUrl = (options.gitRemoteBaseUrl ?? resolveGitRemoteBaseUrl())
    .trim()
    .replace(/\/+$/, "");
  const health = await page.context().request.get(`${baseUrl}/healthz`).catch(() => null);
  if (!health?.ok()) {
    if (requireForConfiguredRemote) {
      throw new Error(`[assertGitRemotePathIsNotGitlink] git-edge not reachable at ${baseUrl}.`);
    }
    return;
  }

  const remoteUrl = `${baseUrl}/${options.projectId}.git`;
  const token = await requestGitAccessToken(page, {
    controllerUrl,
    serviceRole,
    projectId: options.projectId,
    scopes: ["git.read"]
  });
  if (!token) {
    throw new Error("[assertGitRemotePathIsNotGitlink] Unable to mint git access token.");
  }

  const normalized = (repoPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`[assertGitRemotePathIsNotGitlink] Invalid repoPath: ${repoPath}`);
  }

  const branch = options.branch ?? "main";
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pollDelayMs = 2_000;
  let lastError = "not started";

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-git-remote-tree-"));
  try {
    const init = runGit(["init"], { cwd: tempDir });
    if (init.exitCode !== 0) {
      throw new Error(`[assertGitRemotePathIsNotGitlink] git init failed: ${init.stderr.trim()}`);
    }
    const remoteAdd = runGit(["remote", "add", "origin", remoteUrl], { cwd: tempDir });
    if (remoteAdd.exitCode !== 0) {
      throw new Error(
        `[assertGitRemotePathIsNotGitlink] git remote add failed: ${remoteAdd.stderr.trim()}`
      );
    }

    while (Date.now() < deadline) {
      const fetch = runGitWithTransientRetry(
        [
          "-c",
          `http.extraHeader=Authorization: Bearer ${token}`,
          "fetch",
          "--depth",
          "1",
          "origin",
          branch
        ],
        { cwd: tempDir, attempts: 3 }
      );

      if (fetch.exitCode === 0) {
        const checkout = runGit(["checkout", "-B", "main", "FETCH_HEAD"], { cwd: tempDir });
        if (checkout.exitCode === 0) {
          const lsTree = runGit(["ls-tree", "HEAD", normalized], { cwd: tempDir });
          if (lsTree.exitCode === 0) {
            const entry = lsTree.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find((line) => line.endsWith(`\t${normalized}`));
            if (entry) {
              const mode = entry.split(/\s+/)[0] ?? "";
              if (mode === "160000") {
                throw new Error(
                  `[assertGitRemotePathIsNotGitlink] ${normalized} is a gitlink in ${remoteUrl} (${branch}).`
                );
              }
              return;
            }
            lastError = "path missing in fetched commit";
          } else {
            lastError = lsTree.stderr.trim() || lsTree.stdout.trim() || "git ls-tree failed";
          }
        } else {
          lastError = checkout.stderr.trim() || checkout.stdout.trim() || "git checkout failed";
        }
      } else {
        lastError = fetch.stderr.trim() || fetch.stdout.trim() || "git fetch failed";
      }

      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  throw new Error(
    `[assertGitRemotePathIsNotGitlink] Timed out waiting for non-gitlink tree entry at ${normalized} in ${remoteUrl} (${branch}). ` +
      `Last error: ${lastError}`
  );
}

export async function pushGitRemoteFileText(
  page: Page,
  filePath: string,
  content: string,
  options: {
    projectId: string;
    message?: string;
    branch?: string;
    gitRemoteBaseUrl?: string;
    requireGitRemote?: boolean;
  }
): Promise<string | null> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    throw new Error("[pushGitRemoteFileText] Controller auth missing for git remote mutation.");
  }

  const requireGitRemote =
    typeof options.requireGitRemote === "boolean"
      ? options.requireGitRemote
      : (process.env.GIT_CANONICAL ?? "").trim() === "1"
        ? true
        : undefined;

  const shardRoute = await page.context().request
    .get(`${controllerUrl}/projects/${encodeURIComponent(options.projectId)}/git/shard`, {
      headers: { authorization: `Bearer ${serviceRole}` }
    })
    .catch(() => null);

  if (!shardRoute?.ok()) {
    if (requireGitRemote ?? false) {
      const status = shardRoute?.status() ?? 0;
      const body = shardRoute ? await shardRoute.text().catch(() => "") : "";
      throw new Error(
        `[pushGitRemoteFileText] git shard routing unavailable (status=${status}). ${body.trim()}`
      );
    }
    return null;
  }

  const requireForConfiguredRemote = requireGitRemote ?? true;

  const baseUrl = (options.gitRemoteBaseUrl ?? resolveGitRemoteBaseUrl())
    .trim()
    .replace(/\/+$/, "");

  const health = await page.context().request.get(`${baseUrl}/healthz`).catch(() => null);
  if (!health?.ok()) {
    if (requireForConfiguredRemote) {
      throw new Error(`[pushGitRemoteFileText] git-edge not reachable at ${baseUrl}.`);
    }
    return null;
  }

  const remoteUrl = `${baseUrl}/${options.projectId}.git`;
  const token = await requestGitAccessToken(page, {
    controllerUrl,
    serviceRole,
    projectId: options.projectId,
    scopes: ["git.read", "git.write"]
  });
  if (!token) {
    throw new Error("[pushGitRemoteFileText] Unable to mint git access token.");
  }

  const normalized = (filePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`[pushGitRemoteFileText] Invalid filePath: ${filePath}`);
  }

  const branch = options.branch ?? "main";
  const message =
    typeof options.message === "string" && options.message.trim().length > 0
      ? options.message.trim()
      : `playwright: remote update ${randomUUID()}`;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-git-remote-write-"));
  try {
    const init = runGit(["init"], { cwd: tempDir });
    if (init.exitCode !== 0) {
      throw new Error(`[pushGitRemoteFileText] git init failed: ${init.stderr.trim()}`);
    }
    const remoteAdd = runGit(["remote", "add", "origin", remoteUrl], { cwd: tempDir });
    if (remoteAdd.exitCode !== 0) {
      throw new Error(
        `[pushGitRemoteFileText] git remote add failed: ${remoteAdd.stderr.trim()}`
      );
    }

    const header = `http.extraHeader=Authorization: Bearer ${token}`;
    const fetch = runGitWithTransientRetry(
      ["-c", header, "fetch", "--depth", "1", "origin", branch],
      { cwd: tempDir, attempts: 3 }
    );
    if (fetch.exitCode !== 0) {
      throw new Error(`[pushGitRemoteFileText] git fetch failed: ${fetch.stderr.trim()}`);
    }

    const checkout = runGit(["checkout", "-B", branch, "FETCH_HEAD"], { cwd: tempDir });
    if (checkout.exitCode !== 0) {
      throw new Error(`[pushGitRemoteFileText] git checkout failed: ${checkout.stderr.trim()}`);
    }

    const configName = runGit(["config", "user.name", "Instafy Playwright"], { cwd: tempDir });
    if (configName.exitCode !== 0) {
      throw new Error(
        `[pushGitRemoteFileText] git config user.name failed: ${configName.stderr.trim()}`
      );
    }
    const configEmail = runGit(["config", "user.email", "playwright@instafy.dev"], { cwd: tempDir });
    if (configEmail.exitCode !== 0) {
      throw new Error(
        `[pushGitRemoteFileText] git config user.email failed: ${configEmail.stderr.trim()}`
      );
    }

    const absolutePath = path.join(tempDir, ...normalized.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content ?? "", "utf8");

    const add = runGit(["add", "--", normalized], { cwd: tempDir });
    if (add.exitCode !== 0) {
      throw new Error(`[pushGitRemoteFileText] git add failed: ${add.stderr.trim()}`);
    }

    const commit = runGit(["commit", "--no-gpg-sign", "-m", message], { cwd: tempDir });
    if (commit.exitCode !== 0) {
      throw new Error(
        `[pushGitRemoteFileText] git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`
      );
    }

    const remoteBranch = `origin/${branch}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refresh = runGitWithTransientRetry(
        ["-c", header, "fetch", "--prune", "origin", branch],
        { cwd: tempDir, attempts: 3 }
      );
      if (refresh.exitCode !== 0) {
        throw new Error(`[pushGitRemoteFileText] git fetch failed: ${refresh.stderr.trim()}`);
      }

      const hasRemote = runGit(
        ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteBranch}`],
        { cwd: tempDir }
      ).exitCode === 0;

      if (hasRemote) {
        const isFastForwardOk =
          runGit(["merge-base", "--is-ancestor", remoteBranch, "HEAD"], { cwd: tempDir })
            .exitCode === 0;
        if (!isFastForwardOk) {
          const rebase = runGit(["rebase", remoteBranch], { cwd: tempDir });
          if (rebase.exitCode !== 0) {
            runGit(["rebase", "--abort"], { cwd: tempDir });
            throw new Error(
              `[pushGitRemoteFileText] git rebase onto ${remoteBranch} failed: ${rebase.stderr.trim()}`
            );
          }
        }
      }

      const destRef = `HEAD:refs/heads/${branch}`;
      const push = runGit(["-c", header, "push", "origin", destRef], { cwd: tempDir });
      if (push.exitCode === 0) {
        break;
      }

      const stderr = push.stderr.toLowerCase();
      const looksLikeNonFastForward =
        stderr.includes("non-fast-forward") || stderr.includes("fetch first") || stderr.includes("[rejected]");
      if (looksLikeNonFastForward && attempt === 0) {
        continue;
      }

      throw new Error(
        `[pushGitRemoteFileText] git push failed: ${push.stderr.trim() || push.stdout.trim()}`
      );
    }

    const rev = runGit(["rev-parse", "HEAD"], { cwd: tempDir });
    if (rev.exitCode !== 0) {
      return null;
    }
    const hash = rev.stdout.trim();
    return hash.length > 0 ? hash : null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

function normalizeOriginEndpoint(rawValue: unknown): string {
  if (typeof rawValue !== "string") {
    return "";
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }
  const fallbackHost = "127.0.0.1";
  try {
    const url = new URL(trimmed);
    if (url.hostname === "host.docker.internal" || url.hostname === "0.0.0.0" || url.hostname === "::") {
      url.hostname = fallbackHost;
    }
    return url.toString().replace(/\/+$/, "");
  } catch (_error) {
    if (trimmed.includes("host.docker.internal")) {
      return trimmed.replace(/host\.docker\.internal/gi, fallbackHost).replace(/\/+$/, "");
    }
    return trimmed.replace(/\/+$/, "");
  }
}

const LOCAL_TUNNEL_DOMAIN_SUFFIX = ".rt.test";
const CURL_HTTP_STATUS_MARKER = "__INSTAFY_CURL_HTTP_STATUS__:";

function shouldResolveLocalTunnelHost(hostname: string): boolean {
  const normalized = (hostname ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "rt.test" || normalized.endsWith(LOCAL_TUNNEL_DOMAIN_SUFFIX);
}

function resolveLocalTunnelIngressIp(): string {
  const candidate = (process.env.PLAYWRIGHT_TUNNEL_INGRESS_IP ?? "").trim();
  return candidate || "127.0.0.1";
}

function resolveUrlPort(url: URL): string {
  const raw = (url.port ?? "").trim();
  if (raw) {
    return raw;
  }
  if (url.protocol === "http:") {
    return "80";
  }
  if (url.protocol === "https:") {
    return "443";
  }
  return "443";
}

function runCurlWithHttpStatus(args: string[]): {
  exitCode: number;
  statusCode: number;
  body: string;
  stderr: string;
} {
  const result = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--location",
      "--fail-with-body",
      "--connect-timeout",
      "15",
      "--max-time",
      "90",
      ...args,
      "--write-out",
      `\n${CURL_HTTP_STATUS_MARKER}%{http_code}`
    ],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }
  );

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const exitCode = result.status ?? result["code"] ?? 0;

  const markerIndex = stdout.lastIndexOf(CURL_HTTP_STATUS_MARKER);
  if (markerIndex === -1) {
    return {
      exitCode,
      statusCode: 0,
      body: stdout,
      stderr
    };
  }

  const body = stdout.slice(0, markerIndex);
  const rawStatus = stdout.slice(markerIndex + CURL_HTTP_STATUS_MARKER.length).trim();
  const parsed = Number.parseInt(rawStatus, 10);
  return {
    exitCode,
    statusCode: Number.isFinite(parsed) ? parsed : 0,
    body,
    stderr
  };
}

function buildOriginFileUrl(endpoint: string, rawPath: string): URL {
  const sanitizedEndpoint = endpoint.replace(/\/+$/, "");
  const base = sanitizedEndpoint.endsWith("/")
    ? sanitizedEndpoint
    : `${sanitizedEndpoint}/`;
  const trimmedPath = (rawPath ?? "")
    .toString()
    .trim()
    .replace(/^\/+/, "");
  const encodedPath = encodeOriginPath(trimmedPath);
  // Use a relative path segment (no leading slash) so callers can pass endpoints
  // with path prefixes (e.g. controller origin proxy: http://.../origin/<id>).
  const relative = encodedPath ? `files/${encodedPath}` : "entries";
  return new URL(relative, base);
}

function buildOriginRawUrl(endpoint: string, rawPath: string): URL {
  const sanitizedEndpoint = endpoint.replace(/\/+$/, "");
  const base = sanitizedEndpoint.endsWith("/")
    ? sanitizedEndpoint
    : `${sanitizedEndpoint}/`;
  const trimmedPath = (rawPath ?? "")
    .toString()
    .trim()
    .replace(/^\/+/, "");
  const encodedPath = encodeOriginPath(trimmedPath);
  const relative = encodedPath ? `raw/${encodedPath}` : "raw";
  return new URL(relative, base);
}

function encodeOriginPath(path: string): string {
  if (!path) {
    return "";
  }
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function waitForSupabaseClient(page: Page): Promise<void> {
  await page
    .waitForFunction(() => Boolean((window as any)?.__INSTAFY_SUPABASE__), null, {
      timeout: 5_000
    })
    .catch(() => {});
}

async function clearSupabaseAuthState(page: Page): Promise<void> {
  await waitForSupabaseClient(page);
  await page
    .evaluate(async () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_CONTROLLER_TOKEN__?: string | null;
        __INSTAFY_CONTROLLER_BASE_URL__?: string | null;
        __INSTAFY_SUPABASE__?: {
          auth?: {
            signOut?: (options?: { scope?: "local" | "global" | "others" }) => Promise<void>;
          };
        };
      };
      const client = runtimeWindow.__INSTAFY_SUPABASE__;
      if (client?.auth?.signOut) {
        try {
          await client.auth.signOut({ scope: "local" });
        } catch (error) {
          console.warn("[clearSupabaseAuthState] signOut failed", error);
        }
      }

      runtimeWindow.__INSTAFY_CONTROLLER_TOKEN__ = null;
      runtimeWindow.__INSTAFY_CONTROLLER_BASE_URL__ = null;

      const shouldClearKey = (key: string | null): key is string => {
        if (!key) {
          return false;
        }
        const normalized = key.toLowerCase();
        return normalized.startsWith("sb-") || normalized.includes("instafy");
      };

      try {
        const localKeys: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (shouldClearKey(key)) {
            localKeys.push(key);
          }
        }
        localKeys.forEach((key) => window.localStorage.removeItem(key));
      } catch (error) {
        console.warn("[clearSupabaseAuthState] localStorage cleanup failed", error);
      }

      try {
        const sessionKeys: string[] = [];
        for (let index = 0; index < window.sessionStorage.length; index += 1) {
          const key = window.sessionStorage.key(index);
          if (shouldClearKey(key)) {
            sessionKeys.push(key);
          }
        }
        sessionKeys.forEach((key) => window.sessionStorage.removeItem(key));
      } catch (error) {
        console.warn("[clearSupabaseAuthState] sessionStorage cleanup failed", error);
      }
    })
    .catch(() => {});
}

async function ensureGuestArrivesInStudio(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStudioNavigationAt = 0;

  while (Date.now() < deadline) {
    const userId = await resolveAuthenticatedUserId(page).catch(() => null);
    if (page.url().includes("/studio") && userId) {
      return;
    }

    if (userId) {
      const now = Date.now();
      if (now - lastStudioNavigationAt >= 2_000) {
        lastStudioNavigationAt = now;
        await page.goto("/studio", { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      if (page.url().includes("/studio")) {
        return;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error("Guest login did not navigate to /studio");
}

async function ensureWorkspaceConversationTab(page: Page): Promise<void> {
  const conversationTabs = page
    .getByTestId("workspace-tabs")
    .locator('[data-tab-kind="conversation"]');
  const countConversationTabs = async () => await conversationTabs.count().catch(() => 0);
  const topbarTabSelector = page.locator('[data-testid="topbar-tab-selector"], [data-testid="mobile-header-title"]');
  const hasConversationWorkspace = async (): Promise<boolean> => {
    if ((await countConversationTabs()) > 0) {
      return true;
    }
    const chatInputVisible = await page.getByTestId("chat-input").isVisible().catch(() => false);
    if (!chatInputVisible) {
      return false;
    }
    const topbarSelectorVisible = await topbarTabSelector.isVisible().catch(() => false);
    if (!topbarSelectorVisible) {
      return false;
    }
    const topbarLabel = (await topbarTabSelector.innerText().catch(() => "")).trim().toLowerCase();
    return topbarLabel.includes("conversation") || topbarLabel.includes("chat");
  };

  if (await hasConversationWorkspace()) {
    return;
  }

  await page
    .waitForFunction(() => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_CONVERSATIONS_DEBUG__?: {
          createConversation?: unknown;
        };
        __INSTAFY_WORKSPACE_TABS_DEBUG__?: {
          openConversationTab?: unknown;
          openPanelTab?: unknown;
        };
      };
      return (
        typeof runtimeWindow.__INSTAFY_CONVERSATIONS_DEBUG__?.createConversation === "function" &&
        (typeof runtimeWindow.__INSTAFY_WORKSPACE_TABS_DEBUG__?.openConversationTab === "function" ||
          typeof runtimeWindow.__INSTAFY_WORKSPACE_TABS_DEBUG__?.openPanelTab === "function")
      );
    }, undefined, { timeout: 15_000 })
    .catch(() => {});

  const openedViaDebugHook = await page
    .evaluate(() => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_CONVERSATIONS_DEBUG__?: {
          activeConversationLocalId?: string | null;
          conversations?: Array<{ localId: string }>;
          createConversation?: (options?: { title?: string; select?: boolean }) => string | null;
          selectConversation?: (conversationId: string) => void;
          markConversationRead?: (conversationId: string) => void;
        };
        __INSTAFY_WORKSPACE_TABS_DEBUG__?: {
          openPanelTab?: (panel: "chat", options?: { activate?: boolean }) => void;
          openConversationTab?: (conversationId: string, options?: { activate?: boolean }) => void;
        };
      };
      const conversationDebug = runtimeWindow.__INSTAFY_CONVERSATIONS_DEBUG__;
      const debug = runtimeWindow.__INSTAFY_WORKSPACE_TABS_DEBUG__;
      if (!conversationDebug || !debug) {
        return false;
      }
      let conversationId =
        typeof conversationDebug.activeConversationLocalId === "string" &&
        conversationDebug.activeConversationLocalId.trim().length > 0
          ? conversationDebug.activeConversationLocalId.trim()
          : typeof conversationDebug.conversations?.[0]?.localId === "string" &&
              conversationDebug.conversations[0].localId.trim().length > 0
            ? conversationDebug.conversations[0].localId.trim()
            : null;
      if (!conversationId && typeof conversationDebug.createConversation === "function") {
        conversationId = conversationDebug.createConversation({
          title: "Conversation 1",
          select: true,
        });
      }
      if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
        if (typeof debug.openPanelTab === "function") {
          debug.openPanelTab("chat");
          return true;
        }
        return false;
      }
      conversationDebug.selectConversation?.(conversationId);
      conversationDebug.markConversationRead?.(conversationId);
      if (typeof debug.openConversationTab === "function") {
        debug.openConversationTab(conversationId, { activate: true });
      } else if (typeof debug.openPanelTab === "function") {
        debug.openPanelTab("chat");
      }
      return true;
    })
    .catch(() => false);

  if (openedViaDebugHook) {
    const createdViaDebugHook = await expect
      .poll(async () => (await hasConversationWorkspace() ? 1 : 0), { timeout: 10_000 })
      .toBe(1)
      .then(() => true)
      .catch(() => false);
    if (createdViaDebugHook) {
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
      return;
    }
  }

  const openConversationMenu = async (): Promise<boolean> => {
    const newConversationButton = page.getByTestId("chat-new-conversation");
    const visible = await newConversationButton.isVisible().catch(() => false);
    if (!visible) {
      return false;
    }
    await newConversationButton.click().catch(() => {});
    const popover = page.getByTestId("chat-new-chat-menu-popover");
    const popoverVisible = await popover.isVisible().catch(() => false);
    if (popoverVisible) {
      await page.getByRole("button", { name: "Public chat" }).click().catch(() => {});
      return true;
    }
    return false;
  };

  if (!(await openConversationMenu())) {
    await page.getByTestId("sidebar-nav-chat").click().catch(() => {});
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    if (!(await hasConversationWorkspace())) {
      await openConversationMenu();
    }
  }

  await expect
    .poll(async () => (await hasConversationWorkspace() ? 1 : 0), { timeout: 30_000 })
    .toBe(1);
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
}

export async function loginAsGuest(
  page: Page,
  options: { appBaseUrl?: string | null } = {},
): Promise<GuestLoginResult> {
  const appPath = (pathname: string) => {
    const baseUrl = options.appBaseUrl?.trim();
    return baseUrl ? new URL(pathname, `${baseUrl.replace(/\/+$/g, "")}/`).toString() : pathname;
  };
  await page.context().clearCookies().catch(() => {});
  await gotoAppPath(page, appPath("/login"));
  await clearSupabaseAuthState(page);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});

  const supabaseUrl = resolveSupabaseUrl();
  const supabaseAnonKey = resolveSupabaseAnonKey();
  const supabaseAdminHeaders = getSupabaseAuthHeaders();

  // Prefer provisioning a unique confirmed user via service role so each "guest"
  // context behaves like a distinct user even when anonymous sign-ins are disabled.
  if (supabaseUrl && supabaseAnonKey && supabaseAdminHeaders.authorization) {
    const email = `guest+${randomUUID()}@instafy.dev`;
    const password = `Guest-${randomUUID()}!aA1`;
    const retryDelaysMs = [500, 1200, 2500];
    const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

    try {
      let created = false;
      let createdUserId: string | null = null;
      for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
        const response = await page
          .context()
          .request.post(`${supabaseUrl}/auth/v1/admin/users`, {
            headers: {
              ...supabaseAdminHeaders,
              "content-type": "application/json",
            },
            data: {
              email,
              password,
              email_confirm: true,
            },
          })
          .catch(() => null);

        if (response?.ok()) {
          const createdPayload = (await response.json().catch(() => null)) as
            | { id?: unknown; user?: { id?: unknown } }
            | null;
          const candidateId = createdPayload?.user?.id ?? createdPayload?.id;
          createdUserId =
            typeof candidateId === "string" && candidateId.trim()
              ? candidateId.trim()
              : null;
          created = true;
          break;
        }

        const status = response?.status() ?? 0;
        const body = response ? await response.text().catch(() => "") : "";
        const bodyLower = body.toLowerCase();

        if ((status === 409 || status === 422) && bodyLower.includes("already")) {
          created = true;
          break;
        }

        const shouldRetry =
          retryableStatuses.has(status) || bodyLower.includes("request_timeout") || bodyLower.includes("timed out");
        if (!shouldRetry || attempt >= retryDelaysMs.length) {
          throw new Error(`Failed to provision guest user (${status}): ${body}`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      }

      if (!created) {
        throw new Error("Failed to provision guest user (unknown error)");
      }

      let payload: {
        access_token: string;
        refresh_token: string;
        user?: { id?: string | null } | null;
      } | null = null;
      for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
        const response = await page
          .context()
          .request.post(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
            headers: {
              apikey: supabaseAnonKey,
              "content-type": "application/json",
            },
            data: { email, password },
          })
          .catch(() => null);

        if (response?.ok()) {
          payload = (await response.json()) as {
            access_token: string;
            refresh_token: string;
            user?: { id?: string | null } | null;
          };
          break;
        }

        const status = response?.status() ?? 0;
        const body = response ? await response.text().catch(() => "") : "";
        const bodyLower = body.toLowerCase();
        const shouldRetry =
          retryableStatuses.has(status) || bodyLower.includes("request_timeout") || bodyLower.includes("timed out");
        if (!shouldRetry || attempt >= retryDelaysMs.length) {
          throw new Error(`Failed to fetch guest session (${status}): ${body}`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      }

      if (!payload?.access_token || !payload?.refresh_token) {
        throw new Error("Failed to fetch guest session (empty payload)");
      }
      const disposableUserId =
        typeof payload.user?.id === "string" && payload.user.id.trim()
          ? payload.user.id.trim()
          : createdUserId;
      if (!disposableUserId) {
        throw new Error("Failed to retain the disposable guest user id for cleanup");
      }

      await gotoAppPath(page, appPath("/login"));
      await waitForBrowserSupabaseClient(page);

      await page.evaluate(
        async ({ access_token, refresh_token }) => {
          const client = (window as any).__INSTAFY_SUPABASE__;
          await client.auth.setSession({ access_token, refresh_token });
        },
        {
          access_token: payload.access_token,
          refresh_token: payload.refresh_token,
        }
      );

      await gotoAppPath(page, appPath("/studio"));
      await ensureGuestArrivesInStudio(page, 45_000);
      return { disposableUserId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[loginAsGuest] guest provisioning failed, falling back to UI login: ${message}`);
    }
  }

  // Fallback for environments without service-role access: use the UI affordance.
  await gotoAppPath(page, appPath("/login"));
  const guestButton = page.getByRole("button", { name: /Continue as guest/i });
  const guestButtonVisible = await guestButton.isVisible().catch(() => false);
  if (!guestButtonVisible) {
    if (HAS_EXPLICIT_TEST_USER_CREDENTIALS) {
      console.warn("[loginAsGuest] guest UI unavailable; falling back to test-user login.");
      await loginWithServiceUser(page);
      return { disposableUserId: null };
    }
    await expect(guestButton).toBeVisible({ timeout: 15_000 });
  }
  await guestButton.click();
  await ensureGuestArrivesInStudio(page, 60_000);
  return { disposableUserId: null };
}

async function loginWithServiceUser(page: Page): Promise<void> {
  const supabaseUrl = resolveSupabaseUrl();
  const supabaseAnonKey = resolveSupabaseAnonKey();
  if (!supabaseUrl || !supabaseAnonKey) {
    return;
  }

  const response = await page.context().request.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      headers: {
        apikey: supabaseAnonKey,
        "content-type": "application/json"
      },
      data: {
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD
      }
    }
  );

  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch Supabase session (${response.status()} ${response.statusText()}): ${body}`
    );
  }

  const payload = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };

  try {
    await page.context().clearCookies().catch(() => {});
    await gotoAppPath(page, "/login");
    await clearSupabaseAuthState(page);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await waitForBrowserSupabaseClient(page);

    await page.evaluate(
      async ({ access_token, refresh_token }) => {
        const client = (window as any).__INSTAFY_SUPABASE__;
        if (!client) {
          throw new Error("Supabase client unavailable on window");
        }
        await client.auth.setSession({ access_token, refresh_token });
      },
      {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token
      }
    );

    await gotoAppPath(page, "/studio");
    await page
      .waitForURL((url) => url.pathname.includes("/studio"), {
        timeout: 30_000
      })
      .catch(() => {});
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[loginWithServiceUser] browser session seed failed, falling back to UI login: ${message}`);
  }

  await gotoAppPath(page, "/login");
  await clearSupabaseAuthState(page);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});

  const useAnotherAccountButton = page.getByRole("button", { name: /log in to another account/i });
  const emailInput = page.locator("#email");
  await expect
    .poll(
      async () => {
        if (await emailInput.isVisible().catch(() => false)) {
          return "email";
        }
        if (await useAnotherAccountButton.isVisible().catch(() => false)) {
          return "chooser";
        }
        return "pending";
      },
      { timeout: 15_000 },
    )
    .not.toBe("pending");

  if (!(await emailInput.isVisible().catch(() => false)) && (await useAnotherAccountButton.isVisible().catch(() => false))) {
    await useAnotherAccountButton.click();
  }

  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(TEST_USER_EMAIL);
  await page.getByRole("button", { name: /^Continue$/ }).click();

  const passwordInput = page.locator("#password");
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await passwordInput.fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: /^Continue$/ }).click();

  await page
    .waitForURL((url) => url.pathname.includes("/studio"), {
      timeout: 30_000
    })
    .catch(() => {});
}

export async function ensureSignedIn(page: Page): Promise<void> {
  const existingUserId = await resolveAuthenticatedUserId(page).catch(() => null);
  if (existingUserId) {
    return;
  }
  if (PLAYWRIGHT_LOGIN_MODE === "service") {
    await loginWithServiceUser(page);
    return;
  }
  await loginAsGuest(page);
}

type ControllerOrgProject = {
  orgId: string;
  orgName: string;
  orgSlug: string | null;
  projectId: string;
};

type ControllerOrgProjectOptions = {
  controllerUrl?: string;
  accessToken?: string;
  orgName?: string;
  orgSlug?: string;
  ownerUserId?: string;
  projectType?: string;
  reuseAccessibleOrg?: boolean;
};

export async function createControllerOrgAndProject(
  request: APIRequestContext,
  options?: ControllerOrgProjectOptions
): Promise<ControllerOrgProject> {
  const controllerUrl = (options?.controllerUrl ?? resolveControllerUrl()).replace(/\/$/, "");
  const accessToken = options?.accessToken ?? resolveServiceRoleKey();
  if (!controllerUrl || !accessToken) {
    throw new Error("Controller URL and access token are required to create org projects.");
  }

  const orgName = options?.orgName?.trim() || `Playwright Workspace ${Date.now()}`;
  const orgSlug = options?.orgSlug?.trim();
  const ownerUserId = options?.ownerUserId?.trim() || undefined;
  let orgId: string | null = null;
  let resolvedOrgName = orgName;
  let resolvedOrgSlug: string | null = orgSlug ?? null;

  if (options?.reuseAccessibleOrg) {
    const orgsResponse = await request.get(`${controllerUrl}/orgs`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (orgsResponse.ok()) {
      const orgsPayload = (await orgsResponse.json().catch(() => null)) as {
        orgs?: Array<{
          id?: unknown;
          slug?: unknown;
          name?: unknown;
          role?: unknown;
        }>;
      } | null;
      const writableOrgs = (orgsPayload?.orgs ?? []).filter((candidate) =>
        Boolean(normalizeProjectId(candidate.id)),
      );
      const reusableOrg = ["owner", "admin", "builder"]
        .map((preferredRole) =>
          writableOrgs.find((candidate) => {
            const role =
              typeof candidate.role === "string"
                ? candidate.role.trim().toLowerCase()
                : "";
            return role === preferredRole;
          }),
        )
        .find(Boolean);
      orgId = normalizeProjectId(reusableOrg?.id);
      if (orgId) {
        resolvedOrgName =
          typeof reusableOrg?.name === "string" && reusableOrg.name.trim().length > 0
            ? reusableOrg.name
            : orgName;
        resolvedOrgSlug =
          typeof reusableOrg?.slug === "string" && reusableOrg.slug.trim().length > 0
            ? reusableOrg.slug
            : null;
      }
    }
  }

  if (!orgId) {
    const orgResponse = await request.post(`${controllerUrl}/orgs`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      data: {
        orgName,
        orgSlug,
        ownerUserId,
      },
    });
    if (!orgResponse.ok()) {
      const body = await orgResponse.text().catch(() => "");
      throw new Error(
        `Controller org create failed (${orgResponse.status()} ${orgResponse.statusText()}): ${body}`
      );
    }
    const orgPayload = (await orgResponse.json()) as {
      orgId?: unknown;
      orgSlug?: unknown;
      orgName?: unknown;
    };
    orgId = normalizeProjectId(orgPayload.orgId);
    if (!orgId) {
      throw new Error(
        `Controller org create did not return a valid orgId. body=${JSON.stringify(orgPayload)}`
      );
    }
    resolvedOrgName =
      typeof orgPayload.orgName === "string" && orgPayload.orgName.trim().length > 0
        ? orgPayload.orgName
        : orgName;
    resolvedOrgSlug =
      typeof orgPayload.orgSlug === "string" && orgPayload.orgSlug.trim().length > 0
        ? orgPayload.orgSlug
        : orgSlug ?? null;
  }

  const projectResponse = await request.post(
    `${controllerUrl}/orgs/${encodeURIComponent(orgId)}/projects`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      data: {
        projectType: options?.projectType ?? "customer",
        ownerUserId,
      },
    }
  );
  if (!projectResponse.ok()) {
    const body = await projectResponse.text().catch(() => "");
    throw new Error(
      `Controller project create failed (${projectResponse.status()} ${projectResponse.statusText()}): ${body}`
    );
  }
  const projectPayload = (await projectResponse.json()) as { projectId?: unknown };
  const projectId = normalizeProjectId(projectPayload.projectId);
  if (!projectId) {
    throw new Error(
      `Controller project create did not return a valid projectId. body=${JSON.stringify(projectPayload)}`
    );
  }

  return {
    orgId,
    orgName: resolvedOrgName,
    orgSlug: resolvedOrgSlug,
    projectId,
  };
}

export async function attachControllerProjectToStudio(
  page: Page,
  options: {
    projectId: string;
    orgId: string;
    orgName: string;
    projectName: string;
  }
): Promise<string> {
  const normalizedProjectId = normalizeProjectId(options.projectId);
  if (!normalizedProjectId) {
    throw new Error("attachControllerProjectToStudio requires a valid projectId.");
  }

  await page.evaluate(
    ({ projectId, orgId, orgName, projectName }) => {
      const store = (window as any).__INSTAFY_STORE__;
      const state = store?.getState?.();
      if (typeof state?.createProject === "function") {
        state.createProject({
          projectId,
          projectName,
          orgId,
          orgName,
        });
      }
      if (typeof state?.switchProject === "function") {
        state.switchProject(projectId);
      }
      (window as any).__INSTAFY_ACTIVE_PROJECT_ID__ = projectId;
      (window as any).__INSTAFY_PROJECT_INITIALIZED__ = true;
    },
    {
      projectId: normalizedProjectId,
      orgId: options.orgId,
      orgName: options.orgName,
      projectName: options.projectName,
    },
  );

  await gotoStudio(page, {
    projectId: normalizedProjectId,
    waitUntil: "domcontentloaded",
  }).catch(() => {});
  await waitForStoreProjectId(page, normalizedProjectId, 30_000);
  return normalizedProjectId;
}

async function ensureControllerProjectExists(
  page: Page,
  projectId: string
): Promise<string> {
  const controllerUrl = resolveControllerUrl();
  const authToken =
    (await resolveAuthenticatedAccessToken(page).catch(() => null)) || resolveServiceRoleKey();
  if (!controllerUrl || !authToken) {
    return projectId;
  }

  const statusRes = await page.context().request.get(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`,
    {
      headers: {
        authorization: `Bearer ${authToken}`,
      },
    },
  );
  if (statusRes.ok()) {
    return projectId;
  }
  if (statusRes.status() !== 404) {
    const body = await statusRes.text().catch(() => "");
    throw new Error(
      `Controller runtime status failed (${statusRes.status()} ${statusRes.statusText()}): ${body}`,
    );
  }

  const ownerUserId = await resolveAuthenticatedUserId(page).catch(() => null);
  const created = await createControllerOrgAndProject(page.context().request, {
    controllerUrl,
    accessToken: authToken,
    ownerUserId: ownerUserId ?? undefined,
    projectType: "customer",
    reuseAccessibleOrg: true,
  });
  const createdProjectId = created.projectId;
  return createdProjectId;
}

export async function prepareStudio(
  page: Page,
  options?: { reuseExisting?: boolean; waitForHostedRuntime?: boolean }
): Promise<string | null> {
  const reuseExisting = options?.reuseExisting ?? false;
  const ensureHostedRuntime = options?.waitForHostedRuntime ?? true;
  await ensureSignedIn(page);
  const signedInProjectId = !reuseExisting
    ? await resolveWorkspaceProjectId(page)
    : null;

  if (!reuseExisting) {
    // Drop any cached project ids when we want a fresh session so we don't
    // accidentally pin the next run to a stale project that no longer exists.
    delete process.env.PLAYWRIGHT_PROJECT_ID;
    delete process.env.RUNTIME_PROJECT_ID;
    delete process.env.VITE_RUNTIME_PROJECT_ID;
    await page.evaluate(() => {
      try {
        const storage = window.localStorage;
        if (storage) {
          const keysToRemove: string[] = [];
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (!key) {
              continue;
            }
            if (
              key === "instafy.lastProjectId" ||
              key === "instafy.workspace.tabs" ||
              key.startsWith("instafy.workspace")
            ) {
              keysToRemove.push(key);
            }
          }
          for (const key of keysToRemove) {
            storage.removeItem(key);
          }
        }
      } catch {}
      try {
        window.sessionStorage?.setItem(
          "instafy.controllerBinding",
          JSON.stringify({ version: 1, token: null, baseUrl: null }),
        );
        window.sessionStorage?.removeItem("instafy.controllerAccessToken");
        window.sessionStorage?.removeItem("instafy.controllerBaseUrl");
      } catch {}
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
        __INSTAFY_PROJECT_INITIALIZED__?: boolean;
        __INSTAFY_STORE__?: {
          setState?: (input: Partial<{
            activeProjectId: string;
            projects: Record<string, unknown>;
            history: unknown[];
            future: unknown[];
          }>) => void;
        };
      };
      runtimeWindow.__INSTAFY_STORE__?.setState?.({
        activeProjectId: "",
        projects: {},
        history: [],
        future: [],
      });
      runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = null;
      runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = false;
    });
  }

  if (!reuseExisting || !page.url().includes("/studio")) {
    // A fresh reset mutates the mounted Zustand store directly. Remount Studio
    // so provider-local project ids, capabilities, and refs are rebuilt from the
    // same cleared state. Preserve the signed-in project when bootstrap already
    // created one, avoiding a second controller project during test setup.
    await gotoStudio(page, { projectId: signedInProjectId });
  }

  let projectId: string | null = null;
  if (reuseExisting) {
    projectId = await resolveWorkspaceProjectId(page);
  }

  if (!projectId) {
    const bootstrapTimeoutMs = reuseExisting ? 30_000 : 10_000;
    const bootstrapDeadline = Date.now() + bootstrapTimeoutMs;
    while (Date.now() < bootstrapDeadline) {
      projectId = await resolveWorkspaceProjectId(page);
      if (projectId) {
        break;
      }
      await page.waitForTimeout(250);
    }
  }

  if (!projectId && !reuseExisting) {
    const controllerUrl = resolveControllerUrl();
    // Keep privileged seeding in Playwright's Node request context; ownerUserId still
    // assigns the resulting workspace to the authenticated browser user.
    const authToken =
      resolveServiceRoleKey() ||
      (await resolveAuthenticatedAccessToken(page).catch(() => null));
    if (controllerUrl && authToken) {
      const ownerUserId = await resolveAuthenticatedUserId(page).catch(() => null);
      const created = await createControllerOrgAndProject(page.context().request, {
        controllerUrl,
        accessToken: authToken,
        ownerUserId: ownerUserId ?? undefined,
        projectType: "customer",
      });
      projectId = created.projectId;
      // Let ProjectAccessProvider resolve the new backend project in a fresh
      // document. Directly mutating Zustand/window flags can make bootstrap
      // appear complete while capabilities are still unresolved.
      await gotoStudio(page, { projectId });
    }
  }

  if (!projectId) {
    await expect(
      projectId,
      reuseExisting
        ? "Studio should expose an active project id when reusing an existing session"
        : "Studio should expose an active project id"
    ).toBeTruthy();
  }

  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    throw new Error("Unable to resolve active project id.");
  }

  const ensuredProjectId = await ensureControllerProjectExists(page, normalizedProjectId);

  cacheProjectId(ensuredProjectId);
  if (ensuredProjectId !== normalizedProjectId) {
    // A stale URL/store id was replaced in the controller. Remount so the
    // provider, Zustand store, URL, and capability state all resolve the same
    // replacement instead of fabricating readiness in the test harness.
    await gotoStudio(page, { projectId: ensuredProjectId });
  } else {
    await switchToProject(page, ensuredProjectId).catch(() => {});
    await syncStudioProjectQuery(page, ensuredProjectId);
  }

  const storeReady = await waitForStoreProjectId(page, ensuredProjectId, 30_000);
  if (!storeReady) {
    throw new Error(
      `Studio did not adopt project ${ensuredProjectId} after project preparation.`,
    );
  }

  const bootstrapReady = await waitForProjectBootstrap(page, ensuredProjectId, 30_000);
  if (!bootstrapReady) {
    throw new Error(
      `Studio project bootstrap did not complete for ${ensuredProjectId}.`,
    );
  }

  // Keep subsequent flows using the ensured id.
  const finalProjectId = ensuredProjectId;

  await page
    .getByTestId("runtime-selector-button")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});

  if (ensureHostedRuntime) {
    // Don’t “probe” readiness with an expect-based helper here. If the probe times out on a slower
    // run it can mark the test as failed even when we later recover. `requestHostedRuntime` is
    // idempotent (defaults to use-existing), so we can deterministically ensure a hosted runtime.
    await requestHostedRuntime(page, { projectId: finalProjectId }).catch(() => {});

    // Some suites can leave behind a freshly created but offline hosted runtime. Historically this
    // showed up as the send button staying disabled, but the composer primary action is now allowed
    // to render a hold-to-talk control while empty. Use hosted-runtime readiness as the durable
    // signal instead of coupling the harness to whichever empty-state button happens to be visible.
    try {
      await waitForHostedRuntimeReady(page, 60_000, { projectId: finalProjectId });
    } catch {
      await requestHostedRuntime(page, {
        projectId: finalProjectId,
        source: "chat",
        existingRuntimeStrategy: "launch-new",
        timeoutMs: 180_000,
      });
      await waitForHostedRuntimeReady(page, 60_000, { projectId: finalProjectId });
    }
  }

  await ensureWorkspaceConversationTab(page);

  return finalProjectId;
}

export async function waitForHostedRuntimeReady(
  page: Page,
  timeoutMs = 120_000,
  options?: { projectId?: string | null }
): Promise<HostedRuntimeReadyResult> {
  let readyEntry: HostedRuntimeReadyResult | null = null;
  let lastHostedEntries: HostedRuntimeReadyResult[] = [];
  const controllerUrl = getControllerUrl();
  const authToken =
    (await resolveAuthenticatedAccessToken(page).catch(() => null)) || resolveServiceRoleKey();
  const resolveProjectId = async () => await resolveWorkspaceProjectId(page);

  await expect
    .poll(
      async () => {
        const state = await page
          .evaluate(async () => {
            const runtimeApi = window?.["__INSTAFY_RUNTIME__"];
            if (runtimeApi?.refreshRuntimeStatuses) {
              const runtimeWindow = window as any;
              const now = Date.now();
              const lastRefresh = typeof runtimeWindow.__INSTAFY_TEST_LAST_RUNTIME_REFRESH__ === "number"
                ? runtimeWindow.__INSTAFY_TEST_LAST_RUNTIME_REFRESH__
                : 0;
              if (now - lastRefresh > 1500) {
                runtimeWindow.__INSTAFY_TEST_LAST_RUNTIME_REFRESH__ = now;
                try {
                  await runtimeApi.refreshRuntimeStatuses();
                } catch {}
              }
            }
            const snapshot = runtimeApi?.getSnapshot?.();
            const statuses = Array.isArray(snapshot?.runtimeStatuses)
              ? snapshot.runtimeStatuses.filter(Boolean)
              : [];
            const hostedEntries = statuses
              .filter((entry: any) => {
                if (!entry) return false;
                const name =
                  typeof entry.displayName === "string" ? entry.displayName.toLowerCase() : "";
                const isHostedName = name.includes("hosted runtime") || name.includes("instafy cloud");
                const isHostedFlag = typeof entry.isLocal === "boolean" ? entry.isLocal === false : false;
                return isHostedName || isHostedFlag;
              })
              .map((entry: any) => ({
                runtimeId: typeof entry.runtimeId === "string" ? entry.runtimeId : null,
                displayName: typeof entry.displayName === "string" ? entry.displayName : null,
                status: typeof entry.status === "string" ? entry.status : null,
                health: typeof entry.health === "string" ? entry.health : null,
                isLocal: typeof entry.isLocal === "boolean" ? entry.isLocal : null,
              }))
              .filter((entry: { runtimeId: string | null }) => Boolean(entry.runtimeId));

            const ready = hostedEntries.find((entry) => {
              const status = (entry.status ?? "").toLowerCase();
              const health = (entry.health ?? "").toLowerCase();
              const statusReady = status.length === 0 || status === "ready" || status === "running";
              const healthReady = health === "online" || health === "idle";
              return statusReady && healthReady && Boolean(entry.runtimeId);
            });

            return { ready, hostedEntries };
          })
          .catch(() => ({ ready: null, hostedEntries: [] }));

        lastHostedEntries = (state?.hostedEntries as HostedRuntimeReadyResult[]) ?? [];

        try {
          const candidate = (state?.ready as HostedRuntimeReadyResult | null) ?? null;
          if (!controllerUrl || !authToken) {
            if (candidate?.runtimeId) {
              readyEntry = {
                runtimeId: candidate.runtimeId,
                displayName: candidate.displayName ?? null,
                status: candidate.status ?? null,
                health: candidate.health ?? null,
                isLocal: candidate.isLocal ?? null,
              };
              return `ready:${candidate.runtimeId}`;
            }
            return `not-ready:no-controller-creds store=${JSON.stringify(lastHostedEntries.slice(0, 3))}`;
          }

          const projectId =
            normalizeProjectId(options?.projectId ?? null) ?? (await resolveProjectId());
          if (!projectId) {
            return `not-ready:no-project-id store=${JSON.stringify(lastHostedEntries.slice(0, 3))}`;
          }
          const response = await page.context().request.get(
            `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`,
            {
              headers: { authorization: `Bearer ${authToken}` },
            }
          );
          if (!response.ok()) {
            const body = await response.text().catch(() => "");
            return `not-ready:controller-status ${response.status()} ${response.statusText()} body=${body.slice(0, 180)}`;
          }

          const payload = (await response.json()) as { runtimes?: Array<Record<string, unknown>> };
          const entries = Array.isArray(payload.runtimes) ? payload.runtimes : [];
          const hosted = entries
            .map((entry) => {
              const runtimeId =
                typeof entry["runtimeId"] === "string"
                  ? entry["runtimeId"]
                  : typeof entry["runtime_id"] === "string"
                    ? entry["runtime_id"]
                    : null;
              const displayName =
                typeof entry["displayName"] === "string"
                  ? entry["displayName"]
                  : typeof entry["display_name"] === "string"
                    ? entry["display_name"]
                    : null;
              const status =
                typeof entry["status"] === "string"
                  ? entry["status"]
                  : typeof entry["status_text"] === "string"
                    ? entry["status_text"]
                    : null;
              const health = typeof entry["health"] === "string" ? entry["health"] : null;
              const isLocal =
                typeof entry["isLocal"] === "boolean"
                  ? entry["isLocal"]
                  : typeof entry["is_local"] === "boolean"
                    ? entry["is_local"]
                    : null;
              return { runtimeId, displayName, status, health, isLocal };
            })
            .filter((entry) => {
              const name = (entry.displayName ?? "").toLowerCase();
              const hostedName = name.includes("hosted runtime") || name.includes("instafy cloud");
              const hostedFlag = entry.isLocal === false;
              return hostedName || hostedFlag;
            })
            .filter((entry) => entry.runtimeId);

          lastHostedEntries = hosted as HostedRuntimeReadyResult[];

          const fallbackReady = hosted.find((entry) => {
            const status = (entry.status ?? "").toLowerCase();
            const health = (entry.health ?? "").toLowerCase();
            const statusReady = status.length === 0 || status === "ready" || status === "running";
            const healthReady = health === "online" || health === "idle";
            return statusReady && healthReady && Boolean(entry.runtimeId);
          });

          if (fallbackReady?.runtimeId) {
            readyEntry = {
              runtimeId: fallbackReady.runtimeId,
              displayName: fallbackReady.displayName ?? null,
              status: fallbackReady.status ?? null,
              health: fallbackReady.health ?? null,
              isLocal: fallbackReady.isLocal ?? null,
            };
            return `ready:${fallbackReady.runtimeId}`;
          }

          return `not-ready:controller-status store=${JSON.stringify(
            lastHostedEntries.slice(0, 3)
          )}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `not-ready:controller-error ${message.slice(0, 180)}`;
        }
      },
      {
        timeout: timeoutMs,
        message: "Hosted runtime should reach ready state",
      }
    )
    .toMatch(/^ready:/);

  if (readyEntry?.runtimeId) {
    return readyEntry;
  }

  const snapshot = lastHostedEntries
    .map((entry) => ({
      runtimeId: entry.runtimeId,
      status: entry.status,
      health: entry.health
    }))
    .slice(0, 5);
  throw new Error(
    `Hosted runtime did not reach ready state; last hosted entries=${JSON.stringify(snapshot)}`
  );
}

export async function requestHostedRuntime(
  page: Page,
  options?: {
    source?: "topbar" | "chat";
    timeoutMs?: number;
    existingRuntimeStrategy?: HostedRuntimeExistingStrategy;
    projectId?: string | null;
  }
): Promise<void> {
  const preferredProjectId = normalizeProjectId(options?.projectId ?? null);

  const controllerUrl = getControllerUrl();
  const authToken =
    (await resolveAuthenticatedAccessToken(page).catch(() => null)) || resolveServiceRoleKey();
  const strategy = options?.existingRuntimeStrategy ?? "use-existing";
  const source = options?.source ?? "topbar";
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const initialWaitMs =
    strategy === "use-existing" ? Math.min(60_000, Math.max(5_000, Math.floor(timeoutMs / 2))) : timeoutMs;
  const retryWaitMs = Math.max(0, timeoutMs - initialWaitMs);

  const ensureStudioRoute = async () => {
    const currentUrl = page.url();
    const currentUrlProjectId = parseProjectIdFromUrl(currentUrl);
    let activeProjectId = preferredProjectId;
    if (!activeProjectId) {
      activeProjectId = await readActiveProjectIdFromStore(page);
      activeProjectId = normalizeProjectId(activeProjectId);
    }
    if (
      !currentUrl.includes("/studio") ||
      (activeProjectId && currentUrlProjectId !== activeProjectId)
    ) {
      await gotoStudio(page, { projectId: activeProjectId ?? undefined }).catch(() => {});
    }
  };

  await ensureSignedIn(page);
  await ensureStudioRoute();
  const effectiveProjectId = preferredProjectId ?? (await resolveWorkspaceProjectId(page));
  if (!effectiveProjectId) {
    throw new Error("[requestHostedRuntime] projectId is required to ensure hosted runtime.");
  }

  if (preferredProjectId) {
    const storeReady = await waitForStoreProjectId(page, preferredProjectId).catch(() => false);
    if (!storeReady) {
      console.warn(
        `[requestHostedRuntime] Studio did not adopt project ${preferredProjectId} before requesting runtime; continuing with explicit project id.`,
      );
    }
    const bootstrapReady = await waitForProjectBootstrap(page, preferredProjectId).catch(() => false);
    if (!bootstrapReady) {
      console.warn(
        `[requestHostedRuntime] Studio bootstrap incomplete for ${preferredProjectId}; continuing with explicit project id.`,
      );
    }
  }

  await page
    .getByText("Preparing your studio workspace…", { exact: false })
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {});

  if (strategy === "cancel") {
    return;
  }

  if (!controllerUrl || !authToken) {
    console.warn(
      `[requestHostedRuntime] missing controller credentials; falling back to waiting only (source=${source})`,
    );
    await waitForHostedRuntimeReady(page, timeoutMs, { projectId: effectiveProjectId });
    return;
  }

  // Default hosted runtime sandbox to full access during Playwright so agent-driven commands
  // (e.g. git clone over HTTPS) can use network. Individual specs can override with
  // PLAYWRIGHT_CODEX_SANDBOX_MODE.
  const sandboxMode =
    (process.env.PLAYWRIGHT_CODEX_SANDBOX_MODE ?? "").trim() || "danger-full-access";
  const envOverrides: Record<string, string> = {
    CODEX_SANDBOX_MODE: sandboxMode,
  };

  const requestPayload: Record<string, unknown> = {
    project_id: effectiveProjectId,
    provider: "instafy-cloud",
    display_name: "Hosted Runtime",
    idle_ttl_seconds: 300,
    metadata: {
      source,
      env: {
        ...envOverrides,
        ...(process.env.INSTAFY_ENABLE_BROWSER_SESSION?.trim() === "1"
          ? {
              INSTAFY_ENABLE_BROWSER_SESSION: "1",
              INSTAFY_BROWSER_VIEWPORT_ONLY: "1",
              RUNTIME_AGENT_BUILD_TARGET: "runtime-webdev",
              RUNTIME_AGENT_IMAGE: "runtime-agent:webdev",
            }
          : {}),
      },
    },
    origin_mode: "hosted",
    origin_protocols: ["http"],
  };

  if (strategy === "launch-new") {
    requestPayload.runtime_id = randomUUID();
  }

  try {
    const response = await page.context().request.post(`${controllerUrl}/runtime/ensure`, {
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      data: requestPayload,
    });
    if (!response.ok()) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `[requestHostedRuntime] controller runtime/ensure failed (${response.status()} ${response.statusText()}): ${body}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[requestHostedRuntime] ensure request failed: ${message}`);
  }

  try {
    await waitForHostedRuntimeReady(page, initialWaitMs, { projectId: effectiveProjectId });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (strategy !== "use-existing" || retryWaitMs < 5_000) {
      throw error;
    }
    console.warn(
      `[requestHostedRuntime] hosted runtime did not become ready; retrying with launch-new: ${message}`,
    );
  }

  try {
    const response = await page.context().request.post(`${controllerUrl}/runtime/ensure`, {
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      data: {
        ...requestPayload,
        runtime_id: randomUUID(),
      },
    });
    if (!response.ok()) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `[requestHostedRuntime] controller runtime/ensure retry failed (${response.status()} ${response.statusText()}): ${body}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[requestHostedRuntime] ensure retry failed: ${message}`);
  }

  await waitForHostedRuntimeReady(page, Math.max(5_000, retryWaitMs), {
    projectId: effectiveProjectId,
  });
}

export async function selectPrimaryAgentModel(page: Page, model: string): Promise<void> {
  const targetModel = model.trim();
  if (!targetModel) {
    throw new Error("selectPrimaryAgentModel requires a non-empty model name");
  }

  const runtimeButton = page.getByTestId("runtime-selector-button").first();
  await runtimeButton.scrollIntoViewIfNeeded().catch(() => {});
  if (await runtimeButton.isDisabled().catch(() => false)) {
    console.warn("[selectPrimaryAgentModel] runtime button is disabled; skipping model change");
    return;
  }
  await runtimeButton.click();
  const popover = page.getByTestId("runtime-selector-popover");
  await expect(popover).toBeVisible({ timeout: 10_000 });

  const connectButton = popover.getByTestId("runtime-ai-connect-button");
  if (await connectButton.isVisible().catch(() => false)) {
    console.warn("[selectPrimaryAgentModel] AI setup card is active; skipping model change");
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  const modelTrigger = popover.getByTestId("octo-agent-model-select").first();
  if ((await modelTrigger.count().catch(() => 0)) === 0) {
    console.warn("[selectPrimaryAgentModel] model selector is unavailable; skipping model change");
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }
  await expect(modelTrigger).toBeVisible({ timeout: 10_000 });
  if (await modelTrigger.isDisabled().catch(() => false)) {
    console.warn("[selectPrimaryAgentModel] model selector is disabled; skipping model change");
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  const currentModelLabel = (await modelTrigger.innerText().catch(() => "")).trim().toLowerCase();
  if (currentModelLabel === targetModel.toLowerCase()) {
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  const modelMenu = page.getByTestId("octo-agent-model-menu");

  // react-aria nested popovers can be flaky in CI; retry opening the menu before failing.
  let menuOpened = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await modelTrigger.click().catch(() => {});
    try {
      await modelMenu.waitFor({ state: "visible", timeout: 2_500 });
      menuOpened = true;
      break;
    } catch {
      await page.waitForTimeout(150).catch(() => {});
    }
  }
  if (!menuOpened) {
    await modelTrigger.focus().catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await expect(modelMenu).toBeVisible({ timeout: 10_000 });
  }

  const modelOption = page.getByRole("menuitemradio", { name: targetModel, exact: true }).first();
  if ((await modelOption.count()) > 0) {
    await modelOption.click();
  } else {
    const customInput = page.getByTestId("octo-agent-model-select-custom-input");
    await expect(customInput).toBeVisible({ timeout: 10_000 });
    await customInput.fill(targetModel);
    await customInput.press("Enter").catch(() => {});
    if (await modelMenu.isVisible().catch(() => false)) {
      const applyButton = page.getByTestId("octo-agent-model-select-custom-apply");
      if (await applyButton.isVisible().catch(() => false)) {
        await applyButton.click();
      }
    }
  }

  await expect(modelTrigger).toContainText(targetModel, { timeout: 10_000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  const popoverStillVisible = await popover.isVisible().catch(() => false);
  if (popoverStillVisible) {
    const closeMenuButton = page.getByRole("button", { name: /close agent menu/i }).first();
    if (await closeMenuButton.isVisible().catch(() => false)) {
      await closeMenuButton.click({ timeout: 5_000 }).catch(() => {});
    }
    await page.getByTestId("runtime-selector-button").first().click().catch(() => {});
    await popover.waitFor({ state: "hidden", timeout: 5_000 }).catch(async () => {
      await page.keyboard.press("Escape").catch(() => {});
      await popover.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
    });
  }
  if (await popover.isVisible().catch(() => false)) {
    throw new Error("Runtime & AI popover remained open after model selection");
  }
}

export async function ensureVisionModelForImagePrompts(page: Page): Promise<string> {
  const preferred =
    (process.env.PLAYWRIGHT_VISION_MODEL ?? process.env.PLAYWRIGHT_IMAGE_MODEL ?? "gpt-5.5").trim() ||
    "gpt-5.5";
  await selectPrimaryAgentModel(page, preferred);
  return preferred;
}

export async function waitForRuntimeEntryByDisplayName(
  page: Page,
  matcher: RegExp | string,
  options?: { timeoutMs?: number }
): Promise<RuntimeStatusEntrySnapshot> {
  const timeout = options?.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeout;
  const isMatch =
    typeof matcher === "string"
      ? (name: string | null | undefined) => (name ?? "") === matcher
      : (name: string | null | undefined) => matcher.test((name ?? "").toLowerCase());

  while (Date.now() < deadline) {
    const entry = await page.evaluate<RuntimeStatusEntrySnapshot[]>(() => {
      const runtimeApi = window?.["__INSTAFY_RUNTIME__"];
      if (!runtimeApi?.getSnapshot) {
        return [];
      }
      const snapshot = runtimeApi.getSnapshot();
      if (!snapshot || !Array.isArray(snapshot.runtimeStatuses)) {
        return [];
      }
      return snapshot.runtimeStatuses.map((item: any) => ({
        runtimeId: item?.runtimeId ?? item?.runtime_id ?? null,
        displayName: item?.displayName ?? null,
        status: item?.status ?? null,
        health: item?.health ?? null,
        isLocal: Boolean(item?.isLocal)
      }));
    });

    const match = entry.find((candidate) => isMatch(candidate.displayName ?? null));
    if (match) {
      return match;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Runtime entry matching display name did not appear in time");
}

export async function markRuntimeOffline(page: Page, runtimeId: string) {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  const projectId = await resolveWorkspaceProjectId(page);
  if (!controllerUrl || !serviceRole || !projectId) {
    throw new Error("markRuntimeOffline requires controller, service role, and project id");
  }
  if (!runtimeId) {
    return;
  }

  const response = await page.context().request.post(
    `${controllerUrl}/dev/projects/${encodeURIComponent(projectId)}/runtime/offline`,
    {
      headers: {
        authorization: `Bearer ${serviceRole}`,
        "content-type": "application/json"
      },
      data: { runtime_id: runtimeId },
      timeout: 30_000
    }
  );

  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `markRuntimeOffline failed (${response.status()} ${response.statusText()}): ${body}`
    );
  }
}

export async function setDesktopOriginPresence(
  page: Page,
  options: { status: OriginPresenceStatus; latencyMs?: number; region?: string | null; metadata?: Record<string, unknown> }
) {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  const ownerAccessToken = await resolveAuthenticatedAccessToken(page);
  const projectId = await resolveWorkspaceProjectId(page);
  if (!controllerUrl || !serviceRole || !ownerAccessToken || !projectId) {
    throw new Error(
      "setDesktopOriginPresence requires controller, service role, authenticated owner, and project id",
    );
  }

  const {
    ensureDesktopOriginServer,
    setDesktopOriginPresenceStatus
  } = await import("./desktopRuntimeHarness.js");

  await ensureDesktopOriginServer({
    controllerUrl,
    serviceRoleKey: serviceRole,
    ownerAccessToken,
    projectId
  });

  await setDesktopOriginPresenceStatus({
    status: options.status,
    latencyMs: options.latencyMs,
    region: options.region ?? undefined,
    metadata: options.metadata
  });
}

export async function resetRuntimeUserState(
  page: Page,
  options?: {
    deviceId?: string | null;
    source?: string | null;
    /**
     * Additional project IDs to include in the cleanup.
     *
     * Default cleanup only targets the active project. Some suites (multi-project flows)
     * should pass the touched project ids explicitly to avoid scanning a full project list
     * from the store (which may include hundreds of stale projects from previous runs).
     */
    projectIds?: Array<string | null | undefined>;
    /**
     * When true, include all projects currently present in the Studio store.
     * This is expensive and should only be used by suites that intentionally
     * exercise multiple projects and need broad cleanup.
     */
    includeStoreProjects?: boolean;
  }
): Promise<void> {
  const keepRuntime = (process.env.KEEP_RUNTIME ?? "").trim() === "1";
  const source = (options?.source ?? "").toLowerCase();
  if (keepRuntime && (source.includes("cleanup") || source.includes("teardown"))) {
    return;
  }

  const projectId = await resolveWorkspaceProjectId(page);
  const includeStoreProjects = options?.includeStoreProjects === true;
  const storeProjectIds = includeStoreProjects
    ? await page
        .evaluate(() => {
          const store = (window as any)?.["__INSTAFY_STORE__"];
          const state = store?.getState?.();
          const projects = state?.projects;
          if (!projects || typeof projects !== "object") {
            return [];
          }
          return Object.keys(projects);
        })
        .catch(() => [] as string[])
    : ([] as string[]);
  const extraProjectIds = Array.isArray(options?.projectIds) ? options?.projectIds : [];
  const projectIds = Array.from(
    new Set(
      [projectId, ...extraProjectIds, ...storeProjectIds]
        .map((candidate) => normalizeProjectId(candidate))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const supabaseUrl = resolveSupabaseUrl();
  const serviceRoleKey = resolveServiceRoleKey();
  const controllerUrl = resolveControllerUrl();
  const requestTimeoutMs = 20_000;

  try {
    await unregisterLocalWorkspace(page, options?.deviceId ?? null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[resetRuntimeUserState] Failed to unregister workspace: ${message}`);
  }

  for (const candidateProjectId of projectIds) {
    try {
      await setRuntimePreference(
        page,
        candidateProjectId,
        null,
        options?.source ?? "playwright-runtime-reset",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = message.toLowerCase();
      if (
        message.includes("404") &&
        normalized.includes("project not found")
      ) {
        continue;
      }
      console.warn(`[resetRuntimeUserState] Failed to clear runtime preference: ${message}`);
    }
  }

  if (controllerUrl && serviceRoleKey && projectIds.length > 0) {
    for (const candidateProjectId of projectIds) {
      try {
        const statusResponse = await page.context().request.get(
          `${controllerUrl}/projects/${encodeURIComponent(candidateProjectId)}/runtime/status`,
          {
            headers: {
              authorization: `Bearer ${serviceRoleKey}`,
              accept: "application/json",
            },
            timeout: requestTimeoutMs,
          },
        );
        if (!statusResponse.ok()) {
          continue;
        }
        const payload = (await statusResponse.json()) as {
          runtimes?: Array<{ runtimeId?: string | null }>;
        };
        const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
        const runtimeIds = runtimes
          .map((runtime) =>
            typeof runtime?.runtimeId === "string" && runtime.runtimeId.trim().length > 0
              ? runtime.runtimeId.trim()
              : null,
          )
          .filter((value): value is string => Boolean(value));

        for (const runtimeId of runtimeIds) {
          await Promise.allSettled([
            page.context().request.post(
              `${controllerUrl}/dev/projects/${encodeURIComponent(candidateProjectId)}/runtime/offline`,
              {
                headers: {
                  authorization: `Bearer ${serviceRoleKey}`,
                  "content-type": "application/json",
                },
                data: { runtime_id: runtimeId },
                timeout: requestTimeoutMs,
              },
            ),
            page.context().request.post(`${controllerUrl}/runtime/stop`, {
              headers: {
                authorization: `Bearer ${serviceRoleKey}`,
                "content-type": "application/json",
              },
              data: {
                runtime_id: runtimeId,
                reason: options?.source ?? "playwright-runtime-reset",
              },
              timeout: requestTimeoutMs,
            }),
          ]);
        }
      } catch (statusError) {
        const statusMessage =
          statusError instanceof Error ? statusError.message : String(statusError);
      console.warn(`[resetRuntimeUserState] Failed to fetch runtime status: ${statusMessage}`);
      }
    }
  }

  const normalizedSource = (options?.source ?? "").trim().toLowerCase();
  const shouldQuiescePageBeforePurge =
    !page.isClosed() &&
    (normalizedSource.includes("cleanup") ||
      normalizedSource.includes("teardown"));

  if (shouldQuiescePageBeforePurge) {
    try {
      // Stop background Studio polling before we delete origin/runtime rows underneath the page.
      await page.goto("about:blank", {
        waitUntil: "load",
        timeout: 5_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[resetRuntimeUserState] Failed to quiesce page before purge: ${message}`);
    }
  }

  if (!supabaseUrl || !serviceRoleKey || projectIds.length === 0) {
    return;
  }

  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    prefer: "return=minimal",
    "content-type": "application/json"
  } as const;

  const tables = [
    "runtime_tunnel_grants",
    "origin_instances",
    "runtimes",
    "runtime_leases",
    "workspace_origins",
    "workspace_leases",
    "origin_presence",
    "workspace_commit_receipts",
    "origin_access_grants",
    "automations",
  ];

  for (const candidateProjectId of projectIds) {
    for (const table of tables) {
      try {
        await page.context().request.delete(
          `${supabaseUrl}/rest/v1/${table}?project_id=eq.${encodeURIComponent(candidateProjectId)}`,
          { headers, timeout: requestTimeoutMs },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[resetRuntimeUserState] Failed to purge ${table}: ${message}`);
      }
    }
  }
}

function resolveComposeHostPath(rawValue: string | undefined, fallbackRelativeToDockerDir: string): string {
  const trimmed = rawValue?.trim() ?? "";
  if (trimmed.length > 0) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(DOCKER_DIR, trimmed);
  }
  return path.resolve(DOCKER_DIR, fallbackRelativeToDockerDir);
}

function removeProjectArtifactPath(target: string) {
  try {
    if (!fs.existsSync(target)) {
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[teardownPlaywrightProject] Failed to remove ${target}: ${message}`);
  }
}

export async function teardownPlaywrightProject(
  page: Page,
  projectId: string,
  options?: {
    source?: string | null;
    deleteExclusiveOrg?: boolean;
  },
): Promise<void> {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    return;
  }

  await resetRuntimeUserState(page, {
    projectIds: [normalizedProjectId],
    source: options?.source ?? "playwright-project-teardown",
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[teardownPlaywrightProject] Failed to reset runtime state: ${message}`);
  });

  const controllerUrl = resolveControllerUrl();
  const controllerAccessToken =
    (await resolveAuthenticatedAccessToken(page).catch(() => null)) || resolveServiceRoleKey();
  if (controllerUrl && controllerAccessToken) {
    try {
      await page.context().request.delete(
        `${controllerUrl}/projects/${encodeURIComponent(normalizedProjectId)}`,
        {
          headers: {
            authorization: `Bearer ${controllerAccessToken}`,
          },
          timeout: 20_000,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[teardownPlaywrightProject] Controller delete failed: ${message}`);
    }
  }

  const supabaseUrl = resolveSupabaseUrl();
  const serviceRoleKey = resolveServiceRoleKey();
  if (supabaseUrl && serviceRoleKey) {
    const headers = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      prefer: "return=minimal",
    } as const;
    const readHeaders = {
      ...headers,
      prefer: "return=representation",
    } as const;

    let orgId: string | null = null;
    try {
      const orgResponse = await page.context().request.get(
        `${supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(normalizedProjectId)}&select=id,org_id`,
        {
          headers: readHeaders,
          timeout: 20_000,
        },
      );
      if (orgResponse.ok()) {
        const rows = (await orgResponse.json()) as Array<{ org_id?: string | null }>;
        const candidate = rows[0]?.org_id;
        orgId = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[teardownPlaywrightProject] Failed to resolve project org: ${message}`);
    }

    const projectScopedTables: Array<{ table: string; column: string }> = [
      { table: "conversation_messages", column: "project_id" },
      { table: "agent_jobs", column: "project_id" },
      { table: "runs", column: "project_id" },
      { table: "prompts", column: "project_id" },
      { table: "conversations", column: "project_id" },
      { table: "runtime_events", column: "project_id" },
      { table: "runtimes", column: "project_id" },
      { table: "runtime_tunnel_grants", column: "project_id" },
      { table: "origin_instances", column: "project_id" },
      { table: "runtime_leases", column: "project_id" },
      { table: "workspace_origins", column: "project_id" },
      { table: "workspace_leases", column: "project_id" },
      { table: "origin_presence", column: "project_id" },
      { table: "workspace_commit_receipts", column: "project_id" },
      { table: "origin_access_grants", column: "project_id" },
      { table: "automations", column: "project_id" },
      { table: "org_credit_ledger", column: "project_id" },
      { table: "sites", column: "project_id" },
    ];

    for (const { table, column } of projectScopedTables) {
      try {
        const response = await page.context().request.delete(
          `${supabaseUrl}/rest/v1/${table}?${column}=eq.${encodeURIComponent(normalizedProjectId)}`,
          {
            headers,
            timeout: 20_000,
          },
        );
        if (!response.ok() && response.status() !== 404) {
          const body = await response.text().catch(() => "");
          console.warn(
            `[teardownPlaywrightProject] Failed to purge ${table}: ${response.status()} ${response.statusText()} ${body}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[teardownPlaywrightProject] Failed to purge ${table}: ${message}`);
      }
    }

    try {
      const response = await page.context().request.delete(
        `${supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(normalizedProjectId)}`,
        {
          headers,
          timeout: 20_000,
        },
      );
      if (!response.ok() && response.status() !== 404) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[teardownPlaywrightProject] Failed to remove project record: ${response.status()} ${response.statusText()} ${body}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[teardownPlaywrightProject] Failed to remove project record: ${message}`);
    }

    if ((options?.deleteExclusiveOrg ?? true) && orgId) {
      try {
        const response = await page.context().request.get(
          `${supabaseUrl}/rest/v1/projects?org_id=eq.${encodeURIComponent(orgId)}&select=id`,
          {
            headers: readHeaders,
            timeout: 20_000,
          },
        );
        if (response.ok()) {
          const rows = (await response.json()) as Array<{ id?: string | null }>;
          const remainingProjects = rows.filter(
            (row) => normalizeProjectId(row?.id ?? null) !== normalizedProjectId,
          );
          if (remainingProjects.length === 0) {
            await page.context().request.delete(
              `${supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(orgId)}`,
              {
                headers,
                timeout: 20_000,
              },
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[teardownPlaywrightProject] Failed to remove organization: ${message}`);
      }
    }
  }

  const workspaceRoot =
    (process.env.WORKSPACE_ROOT ?? "").trim() || path.join(REPO_ROOT, "tmp", "runtime-sandbox");
  const originGatewayWorkspaceRoot = resolveComposeHostPath(
    process.env.ORIGIN_GATEWAY_WORKSPACE_VOLUME,
    "../tmp/origin-gateway-workspaces",
  );
  const gitRepoRoot = resolveComposeHostPath(
    process.env.GIT_REPO_VOLUME,
    "../tmp/git-repos",
  );

  removeProjectArtifactPath(path.join(workspaceRoot, normalizedProjectId));
  removeProjectArtifactPath(path.join(originGatewayWorkspaceRoot, normalizedProjectId));
  removeProjectArtifactPath(path.join(gitRepoRoot, `${normalizedProjectId}.git`));
}

interface LocalWorkspaceRegistrationOptions {
  path: string;
  deviceId?: string;
  hostname?: string;
  platform?: string;
  runtimeId?: string;
}

export async function registerLocalWorkspace(page: Page, options: LocalWorkspaceRegistrationOptions) {
  const controllerUrl = resolveControllerUrl();
  const accessToken = await resolveAuthenticatedAccessToken(page);
  if (!controllerUrl || !accessToken) {
    return;
  }
  const projectId = await resolveWorkspaceProjectId(page);
  if (!projectId) {
    return;
  }

  const payload = {
    path: options.path,
    deviceId: options.deviceId ?? "playwright-companion",
    hostname: options.hostname ?? "playwright",
    platform: options.platform ?? process.platform,
    release: process.release?.name ?? "",
    arch: process.arch,
    runtimeId: options.runtimeId
  } satisfies Record<string, unknown>;

  await page.context().request.put(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/workspaces/local`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      data: payload
    }
  );
}

interface AgentRuntimeOptions {
  provider?: string;
  idleTtlSeconds?: number;
  displayName?: string;
}

export async function registerRuntimeViaAgent(
  page: Page,
  options: AgentRuntimeOptions = {}
): Promise<string | null> {
  const controllerUrl = resolveControllerUrl();
  const accessToken = await resolveAuthenticatedAccessToken(page);
  const projectId = await resolveWorkspaceProjectId(page);
  if (!controllerUrl || !accessToken || !projectId) {
    return null;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };

  const response = await page.context().request.post(`${controllerUrl}/agent/login`, {
    headers,
    data: {
      projectId,
      runtimeType: options.provider ?? "self-hosted",
      idleTtlSeconds: options.idleTtlSeconds ?? 900,
      displayName: options.displayName
    }
  });

  if (!response.ok()) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `registerRuntimeViaAgent failed (${response.status()} ${response.statusText()}): ${text}`
    );
  }

  const payload = (await response.json()) as { runtime_id?: string | null };
  const runtimeId = payload.runtime_id?.trim() ?? "";
  return runtimeId || null;
}

export interface TunnelGrantResponse {
  tunnelId?: string;
  runtimeId?: string;
  hostname?: string | null;
  url?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export async function issueTunnelGrant(
  page: Page,
  runtimeId: string,
  options: { runtimeLeaseId?: string } = {}
): Promise<TunnelGrantResponse> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  const projectId = await resolveWorkspaceProjectId(page);
  if (!controllerUrl || !serviceRole || !projectId) {
    throw new Error("issueTunnelGrant requires controller, service role, and project id");
  }

  const leaseId = options.runtimeLeaseId ?? randomUUID();
  const response = await page.context().request.post(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/tunnels/request`,
    {
      headers: {
        authorization: `Bearer ${serviceRole}`,
        "content-type": "application/json"
      },
      data: {
        runtimeId,
        runtimeLeaseId: leaseId
      }
    }
  );

  if (!response.ok()) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `issueTunnelGrant failed (${response.status()} ${response.statusText()}): ${text}`
    );
  }

  return (await response.json()) as TunnelGrantResponse;
}

export async function revokeTunnelGrant(page: Page, tunnelId: string): Promise<void> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  const projectId = await resolveWorkspaceProjectId(page);
  if (!controllerUrl || !serviceRole || !projectId) {
    throw new Error("revokeTunnelGrant requires controller, service role, and project id");
  }

  const response = await page.context().request.post(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/tunnels/${encodeURIComponent(tunnelId)}/revoke`,
    {
      headers: {
        authorization: `Bearer ${serviceRole}`,
        "content-type": "application/json"
      },
      data: {}
    }
  );

  if (!response.ok()) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `revokeTunnelGrant failed (${response.status()} ${response.statusText()}): ${text}`
    );
  }
}

export async function updateTunnelStatus(
  page: Page,
  tunnelId: string,
  status: string,
): Promise<void> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  const projectId = await resolveWorkspaceProjectId(page);
  if (!controllerUrl || !serviceRole || !projectId) {
    throw new Error("updateTunnelStatus requires controller, service role, and project id");
  }

  const response = await page.context().request.post(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/tunnels/${encodeURIComponent(tunnelId)}/status`,
    {
      headers: {
        authorization: `Bearer ${serviceRole}`,
        "content-type": "application/json",
      },
      data: { status },
    },
  );

  if (!response.ok()) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `updateTunnelStatus failed (${response.status()} ${response.statusText()}): ${text}`,
    );
  }
}

export async function sendLocalWorkspaceHeartbeat(page: Page, deviceId?: string) {
  const controllerUrl = resolveControllerUrl();
  const accessToken = await resolveAuthenticatedAccessToken(page);
  if (!controllerUrl || !accessToken) {
    return;
  }
  const projectId = await resolveWorkspaceProjectId(page);
  if (!projectId) {
    return;
  }

  await page.context().request.post(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/workspaces/local/heartbeat`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      data: {
        deviceId: deviceId ?? "playwright-companion"
      }
    }
  );
}

export async function unregisterLocalWorkspace(page: Page, deviceId?: string) {
  const controllerUrl = resolveControllerUrl();
  const accessToken = await resolveAuthenticatedAccessToken(page);
  if (!controllerUrl || !accessToken) {
    return;
  }
  const projectId = await resolveWorkspaceProjectId(page);
  if (!projectId) {
    return;
  }

  await page.context().request.delete(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/workspaces/local`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      data: {
        deviceId: deviceId ?? null
      },
      timeout: 10_000
    }
  );
}

export async function setRuntimePreference(
  page: Page,
  projectId: string,
  runtimeId: string | null,
  source?: string | null
): Promise<void> {
  const controllerUrl = resolveControllerUrl();
  const accessToken =
    (await resolveAuthenticatedAccessToken(page).catch(() => null)) || resolveServiceRoleKey();
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!controllerUrl || !accessToken || !normalizedProjectId) {
    return;
  }

  const response = await page.context().request.post(
    `${controllerUrl}/projects/${encodeURIComponent(normalizedProjectId)}/runtime/preference`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      data: {
        runtimeId,
        source: source ?? undefined
      },
      timeout: 10_000
    }
  );

  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `setRuntimePreference failed (${response.status()} ${response.statusText()}): ${body}`
    );
  }
}

export async function clearRuntimePreference(
  page: Page,
  options?: { projectId?: string | null; source?: string | null }
): Promise<void> {
  const explicit = normalizeProjectId(options?.projectId ?? null);
  const projectId = explicit ?? (await resolveWorkspaceProjectId(page));
  if (!projectId) {
    return;
  }
  try {
    await setRuntimePreference(page, projectId, null, options?.source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (
      message.includes("404") &&
      normalized.includes("project not found")
    ) {
      console.warn(
        `[clearRuntimePreference] Project ${projectId} missing in controller; skipping preference reset.`
      );
      return;
    }
    if (
      normalized.includes("timeout") ||
      normalized.includes("timed out") ||
      normalized.includes("failed to get connection") ||
      normalized.includes("target page, context or browser has been closed")
    ) {
      console.warn(
        `[clearRuntimePreference] Transient controller error for project ${projectId}; continuing without reset: ${message}`,
      );
      return;
    }
    throw error;
  }
}

export async function requireWorkspaceProjectId(page: Page): Promise<string> {
  const projectId = await resolveWorkspaceProjectId(page);
  if (!projectId) {
    throw new Error("Unable to resolve workspace project id");
  }
  return projectId;
}

export async function writeWorkspaceFile(
  page: Page,
  path: string,
  content: string,
  options?: { createDirectories?: boolean; projectId?: string | null; preferRuntimeId?: string | null }
): Promise<void> {
  const normalizedPath = normalizeWorkspaceRelativePath(path);
  if (!normalizedPath) {
    throw new Error("writeWorkspaceFile requires a valid path");
  }
  await applyWorkspaceChanges(page, {
    files: [
      {
        path: normalizedPath,
        content,
        encoding: "utf-8"
      }
    ],
    deletes: [],
    projectId: options?.projectId ?? undefined,
    preferRuntimeId: options?.preferRuntimeId ?? null,
  });
}

export async function writeWorkspaceFiles(
  page: Page,
  files: Array<{ path: string; content: string }>,
  options?: { projectId?: string | null; preferRuntimeId?: string | null }
): Promise<void> {
  const normalizedFiles = files
    .map((file) => ({
      path: normalizeWorkspaceRelativePath(file.path),
      content: file.content ?? "",
      encoding: "utf-8",
    }))
    .filter((file) => file.path.length > 0);
  if (normalizedFiles.length === 0) {
    return;
  }
  await applyWorkspaceChanges(page, {
    files: normalizedFiles,
    deletes: [],
    projectId: options?.projectId ?? undefined,
    preferRuntimeId: options?.preferRuntimeId ?? null,
  });
}

export async function syncGitRemote(
  page: Page,
  options?: { projectId?: string | null; message?: string | null }
): Promise<string | null> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  const projectId = normalizeProjectId(options?.projectId ?? null) ?? (await resolveWorkspaceProjectId(page));
  if (!controllerUrl || !serviceRole || !projectId) {
    return null;
  }

  const shardRoute = await page.context().request
    .get(`${controllerUrl}/projects/${encodeURIComponent(projectId)}/git/shard`, {
      headers: { authorization: `Bearer ${serviceRole}` }
    })
    .catch(() => null);
  if (!shardRoute?.ok()) {
    return null;
  }

  const userId = await resolveTestUserId(page);
  if (!userId) {
    throw new Error("[syncGitRemote] Unable to resolve authenticated user id.");
  }

  let lease = await acquireWorkspaceLease(page, {
    controllerUrl,
    serviceRole,
    projectId,
    userId
  });
  let preferredRuntimeId: string | null = null;

  const mintAccessToken = async () =>
    await requestOriginAccessToken(page, {
      controllerUrl,
      serviceRole,
      projectId,
      scopes: ["fs.write"],
      leaseId: lease.leaseId,
      preferRuntimeId: preferredRuntimeId,
    });

  try {
    let accessToken = await mintAccessToken();
    if (!accessToken) {
      let hostedRuntime = await waitForHostedRuntimeReady(page, 10_000, { projectId }).catch(
        () => null
      );
      if (!hostedRuntime?.runtimeId) {
        await requestHostedRuntime(page, {
          projectId,
          source: "chat",
          timeoutMs: 180_000,
        }).catch(() => {});
        hostedRuntime = await waitForHostedRuntimeReady(page, 180_000, { projectId }).catch(
          () => null
        );
      }
      if (hostedRuntime?.runtimeId) {
        await releaseWorkspaceLease(page, {
          controllerUrl,
          serviceRole,
          projectId,
          leaseId: lease.leaseId,
          runtimeId: lease.runtimeId ?? null,
        }).catch(() => {});
        lease = await acquireWorkspaceLease(page, {
          controllerUrl,
          serviceRole,
          projectId,
          userId,
          runtimeId: hostedRuntime.runtimeId,
        });
        preferredRuntimeId = hostedRuntime.runtimeId;
        accessToken = await mintAccessToken();
      }
    }
    if (!accessToken) {
      const deadline = Date.now() + 20_000;
      while (!accessToken && Date.now() < deadline) {
        await page.waitForTimeout(500);
        accessToken = await mintAccessToken();
      }
    }
    if (!accessToken) {
      throw new Error(
        `[syncGitRemote] Unable to mint origin access token for ${projectId}. ` +
          "Ensure the UI has successfully launched a hosted runtime before syncing."
      );
    }

    const message =
      typeof options?.message === "string" && options.message.trim().length > 0
        ? options.message.trim()
        : `playwright: git sync ${randomUUID()}`;
    const payload = { message };

    const looksLikeTransientGitConfigRace = (body: string): boolean => {
      const normalized = body.toLowerCase();
      return (
        normalized.includes("could not write config file") &&
        normalized.includes(".instafy/.git/config") &&
        normalized.includes("no such file or directory")
      );
    };

    const syncUrl = `${accessToken.endpoint}/git/sync`;
    const syncUrlObj = new URL(syncUrl);
    if (shouldResolveLocalTunnelHost(syncUrlObj.hostname)) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-origin-git-sync-"));
      try {
        const payloadPath = path.join(tempDir, "payload.json");
        fs.writeFileSync(payloadPath, JSON.stringify(payload), "utf8");

        const port = resolveUrlPort(syncUrlObj);
        const resolveTarget = `${syncUrlObj.hostname}:${port}:${resolveLocalTunnelIngressIp()}`;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const { statusCode, body, stderr } = runCurlWithHttpStatus([
            "--insecure",
            "--request",
            "POST",
            "--resolve",
            resolveTarget,
            "--header",
            `Host: ${syncUrlObj.hostname}`,
            "--header",
            `authorization: Bearer ${accessToken.token}`,
            "--header",
            "content-type: application/json",
            "--data",
            `@${payloadPath}`,
            syncUrlObj.toString()
          ]);
          if (statusCode >= 200 && statusCode < 300) {
            const parsed = JSON.parse(body) as { rev?: string } | null;
            return typeof parsed?.rev === "string" ? parsed.rev : null;
          }

          const combined = [body.trim(), stderr.trim()].filter(Boolean).join("\n");
          const retryable = statusCode >= 500 && looksLikeTransientGitConfigRace(combined);
          if (!retryable || attempt >= 3) {
            throw new Error(`origin git sync failed (${statusCode}): ${combined}`);
          }
          await page.waitForTimeout(500 * attempt);
        }
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await page.context().request.post(syncUrl, {
        headers: {
          authorization: `Bearer ${accessToken.token}`,
          "content-type": "application/json"
        },
        data: payload,
        timeout: 120_000
      });
      if (response.ok()) {
        const result = (await response.json().catch(() => null)) as { rev?: string } | null;
        return typeof result?.rev === "string" ? result.rev : null;
      }
      const body = await response.text().catch(() => "");
      const retryable = response.status() >= 500 && looksLikeTransientGitConfigRace(body);
      if (!retryable || attempt >= 3) {
        throw new Error(
          `origin git sync failed (${response.status()} ${response.statusText()}): ${body}`
        );
      }
      await page.waitForTimeout(500 * attempt);
    }
    return null;
  } finally {
    if (lease?.leaseId) {
      await releaseWorkspaceLease(page, {
        controllerUrl,
        serviceRole,
        projectId,
        leaseId: lease.leaseId
      }).catch(() => {});
    }
    lease = null;
  }
}

interface WorkspaceFileChange {
  path: string;
  content: string;
  encoding: string;
}

async function applyWorkspaceChanges(
  page: Page,
  changes: {
    files?: WorkspaceFileChange[];
    deletes?: string[];
    projectId?: string | null;
    preferRuntimeId?: string | null;
  }
): Promise<void> {
  const controllerUrl = resolveControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  const projectId = changes.projectId ?? (await resolveWorkspaceProjectId(page));
  if (!controllerUrl || !serviceRole || !projectId) {
    throw new Error("applyWorkspaceChanges requires controller, service role, and project id");
  }
  const userId = await resolveTestUserId(page);
  if (!userId) {
    throw new Error("Unable to resolve authenticated user id for workspace changes");
  }

  const normalizedFiles = (changes.files ?? [])
    .map((file) => ({
      path: normalizeWorkspaceRelativePath(file.path),
      content: file.content ?? "",
      encoding: file.encoding ?? "utf-8"
    }))
    .filter((file) => file.path.length > 0);
  const normalizedDeletes = Array.from(
    new Set(
      (changes.deletes ?? [])
        .map((entry) => normalizeWorkspaceRelativePath(entry))
        .filter((entry) => entry.length > 0)
    )
  );

  if (normalizedFiles.length === 0 && normalizedDeletes.length === 0) {
    return;
  }

  let lease = await acquireWorkspaceLease(page, {
    controllerUrl,
    serviceRole,
    projectId,
    userId
  });

  try {
    let accessToken = await requestOriginAccessToken(page, {
      controllerUrl,
      serviceRole,
      projectId,
      scopes: ["fs.write"],
      leaseId: lease.leaseId,
      preferRuntimeId: changes.preferRuntimeId ?? null,
    });
    if (!accessToken) {
      const deadline = Date.now() + 20_000;
      while (!accessToken && Date.now() < deadline) {
        await page.waitForTimeout(500);
        accessToken = await requestOriginAccessToken(page, {
          controllerUrl,
          serviceRole,
          projectId,
          scopes: ["fs.write"],
          leaseId: lease.leaseId,
          preferRuntimeId: changes.preferRuntimeId ?? null,
        });
      }
    }
    if (!accessToken) {
      await releaseWorkspaceLease(page, {
        controllerUrl,
        serviceRole,
        projectId,
        leaseId: lease.leaseId
      }).catch(() => {});
      lease = null;
      throw new Error(
        `[applyWorkspaceChanges] Unable to mint origin access token for ${projectId}. ` +
          "Ensure the UI has successfully launched a hosted runtime before mutating files."
      );
    }

    const manifest = buildWorkspaceManifest({
      projectId,
      leaseId: lease.leaseId,
      files: normalizedFiles,
      deletes: normalizedDeletes
	    });
	    const archive = createWorkspaceArchive(normalizedFiles);
	    const applyUrl = `${accessToken.endpoint}/apply`;
	    const applyUrlObj = new URL(applyUrl);
		    if (shouldResolveLocalTunnelHost(applyUrlObj.hostname)) {
		      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-origin-apply-"));
		      try {
		        const manifestPath = path.join(tempDir, "manifest.json");
		        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
		        const archivePath = path.join(tempDir, "workspace.zip");
		        fs.writeFileSync(archivePath, Buffer.from(archive));

		        const port = resolveUrlPort(applyUrlObj);
		        const resolveTarget = `${applyUrlObj.hostname}:${port}:${resolveLocalTunnelIngressIp()}`;
	        for (let attempt = 0; ; attempt += 1) {
	          const { statusCode, body, stderr } = runCurlWithHttpStatus([
	            "--insecure",
	            "--resolve",
	            resolveTarget,
	            "--header",
	            `Host: ${applyUrlObj.hostname}`,
	            "--header",
	            `authorization: Bearer ${accessToken.token}`,
	            "--form",
	            `manifest=@${manifestPath};type=application/json`,
	            "--form",
	            `archive=@${archivePath};type=application/zip;filename=workspace.zip`,
	            applyUrlObj.toString()
	          ]);
	          if (statusCode >= 200 && statusCode < 300) {
	            break;
	          }
	          const retryDelayMs = ORIGIN_APPLY_BUSY_RETRY_DELAYS_MS[attempt];
	          if (isOriginApplyBusyResponse(statusCode, body) && retryDelayMs !== undefined) {
	            await page.waitForTimeout(retryDelayMs);
	            continue;
	          }
	          const combined = [body.trim(), stderr.trim()].filter(Boolean).join("\n");
	          throw new Error(`origin apply failed (${statusCode}): ${combined}`);
	        }
	      } finally {
	        try {
	          fs.rmSync(tempDir, { recursive: true, force: true });
	        } catch {}
	      }
	    } else {
	      for (let attempt = 0; ; attempt += 1) {
	        const response = await page.context().request.post(applyUrl, {
	          headers: {
	            authorization: `Bearer ${accessToken.token}`
	          },
	          multipart: {
	            manifest: JSON.stringify(manifest),
	            archive: {
	              name: "workspace.zip",
	              mimeType: "application/zip",
	              buffer: Buffer.from(archive)
	            }
	          }
	        });
	        if (response.ok()) {
	          break;
	        }
	        const body = await response.text().catch(() => "");
	        const retryDelayMs = ORIGIN_APPLY_BUSY_RETRY_DELAYS_MS[attempt];
	        if (isOriginApplyBusyResponse(response.status(), body) && retryDelayMs !== undefined) {
	          await page.waitForTimeout(retryDelayMs);
	          continue;
	        }
	        throw new Error(
	          `origin apply failed (${response.status()} ${response.statusText()}): ${body}`
	        );
	      }
	    }
	  } finally {
	    if (lease?.leaseId) {
	      await releaseWorkspaceLease(page, {
	        controllerUrl,
        serviceRole,
        projectId,
        leaseId: lease.leaseId
      }).catch(() => {});
    }
  }
}

async function requestOriginAccessToken(
  page: Page,
  options: {
    controllerUrl: string;
    serviceRole: string;
    projectId: string;
    scopes: string[];
    leaseId?: string | null;
    preferRuntimeId?: string | null;
  }
): Promise<{ endpoint: string; token: string } | null> {
  const response = await page.context().request.post(`${options.controllerUrl}/access_token`, {
    headers: {
      authorization: `Bearer ${options.serviceRole}`,
      "content-type": "application/json"
    },
    data: {
      projectId: options.projectId,
      protocol: "http",
      scopes: options.scopes,
      leaseId: options.leaseId ?? null,
      preferRuntime: options.preferRuntimeId ?? null
    }
  });
  if (!response.ok()) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as
    | { endpoint?: string; token?: string }
    | null;
  if (!payload) {
    return null;
  }
  const endpoint = normalizeOriginEndpoint(payload.endpoint);
  const token = typeof payload.token === "string" ? payload.token : "";
  if (!endpoint || !token) {
    return null;
  }
  return { endpoint, token };
}

async function acquireWorkspaceLease(
  page: Page,
  options: {
    controllerUrl: string;
    serviceRole: string;
    projectId: string;
    userId: string;
    leaseSeconds?: number;
    runtimeId?: string | null;
  }
): Promise<{ leaseId: string; runtimeId: string | null }> {
  const retryDelaysMs = [300, 600, 1_000, 1_600, 2_400, 3_200];

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const response = await page.context().request.post(`${options.controllerUrl}/lease/acquire`, {
      headers: {
        authorization: `Bearer ${options.serviceRole}`,
        "content-type": "application/json"
      },
      data: {
        projectId: options.projectId,
        userId: options.userId,
        runtimeId: options.runtimeId ?? null,
        leaseSeconds: options.leaseSeconds ?? 120
      }
    });

    if (response.ok()) {
      const payload = (await response.json()) as {
        leaseId?: string;
        lease_id?: string;
        runtimeId?: string | null;
        runtime_id?: string | null;
      };
      const leaseId = payload.leaseId ?? payload.lease_id;
      if (!leaseId) {
        throw new Error("Controller did not return a lease id");
      }
      return {
        leaseId,
        runtimeId: payload.runtimeId ?? payload.runtime_id ?? null
      };
    }

    const body = await response.text().catch(() => "");
    const shouldRetryLeaseConflict =
      response.status() === 409 &&
      /lease|leased|already leased|currently leased/i.test(body) &&
      attempt < retryDelaysMs.length;
    if (!shouldRetryLeaseConflict) {
      throw new Error(
        `lease acquire failed (${response.status()} ${response.statusText()}): ${body}`
      );
    }

    const untilMatch = body.match(/\buntil\s+([0-9T:\-+.Z]+)/i);
    const untilTimestamp = untilMatch ? Date.parse(untilMatch[1]) : Number.NaN;
    const untilWaitMs = Number.isFinite(untilTimestamp)
      ? Math.max(0, Math.min(10_000, untilTimestamp - Date.now() + 250))
      : 0;
    const retryDelayMs = Math.max(retryDelaysMs[attempt], untilWaitMs);
    await page.waitForTimeout(retryDelayMs);
  }

  throw new Error("lease acquire failed after retries");
}

async function releaseWorkspaceLease(
  page: Page,
  options: {
    controllerUrl: string;
    serviceRole: string;
    projectId: string;
    leaseId: string;
    runtimeId?: string | null;
  }
): Promise<void> {
  await page.context().request.post(`${options.controllerUrl}/lease/release`, {
    headers: {
      authorization: `Bearer ${options.serviceRole}`,
      "content-type": "application/json"
    },
    data: {
      projectId: options.projectId,
      leaseId: options.leaseId,
      runtimeId: options.runtimeId ?? null,
      status: "released"
    }
  });
}

function buildWorkspaceManifest(input: {
  projectId: string;
  leaseId: string | null;
  files: WorkspaceFileChange[];
  deletes: string[];
}) {
  return {
    projectId: input.projectId,
    leaseId: input.leaseId,
    files: input.files.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.content, "utf8"),
      encoding: file.encoding,
    })),
    deletes: input.deletes,
    generatedAt: new Date().toISOString(),
    sourceDeviceId: "playwright-tests",
  };
}

function createWorkspaceArchive(files: WorkspaceFileChange[]): Uint8Array {
  if (files.length === 0) {
    return zipSync({}, { level: 9 });
  }
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.path] = strToU8(file.content ?? "");
  }
  return zipSync(entries, { level: 9 });
}

function normalizeWorkspaceRelativePath(path: string): string {
  const trimmed = (path ?? "").trim().replace(/\\+/g, "/");
  const withoutRoot = trimmed.replace(/^\/+/, "");
  const segments = withoutRoot
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  return segments.join("/");
}

async function purgeProjectData(page: Page) {
  const supabaseUrl = resolveSupabaseUrl();
  const serviceRole =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    "";
  if (!supabaseUrl || !serviceRole) {
    return;
  }

  const headers = {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    prefer: "return=minimal"
  } satisfies Record<string, string>;

  const projectId = await resolveProjectId(page, supabaseUrl, headers);
  if (!projectId) {
    return;
  }

  const tables = [
    "conversation_messages",
    "agent_jobs",
    "runs",
    "prompts",
    "conversations"
  ];

  await waitForSupabaseReady(page);

  for (const table of tables) {
    try {
      const response = await page
        .context()
        .request.delete(`${supabaseUrl}/rest/v1/${table}?project_id=eq.${projectId}`, {
          headers
        });
      if (!response.ok() && response.status() !== 404) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[resetSupabase] Failed to purge ${table} (${response.status()} ${response.statusText()}): ${body}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ECONNREFUSED")) {
        console.warn(`[resetSupabase] Supabase not reachable while purging ${table}; continuing.`);
      } else {
        console.warn(`[resetSupabase] Unexpected error purging ${table}: ${message}`);
      }
    }
  }

}

async function resolveProjectId(
  page: Page,
  supabaseUrl: string,
  headers: Record<string, string>
): Promise<string | null> {
  try {
    const response = await page
      .context()
      .request.get(
        `${supabaseUrl}/rest/v1/runtimes?select=project_id,status&type=eq.codex-embedded&order=updated_at.desc&limit=1`,
        { headers }
      );
    if (!response.ok()) {
      return null;
    }
    const rows = (await response.json()) as Array<{ project_id?: string | null }>;
    return normalizeProjectId(rows[0]?.project_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[resolveProjectId] Unable to fetch runtime project id: ${message}`);
    return null;
  }
}
