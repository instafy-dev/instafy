import fs from "node:fs";
import {
  resolveActiveProfileName,
  resolveConfiguredAccessToken,
  resolveControllerUrl,
  type AccessTokenSource,
} from "./config.js";
import { formatAuthRejectedError } from "./errors.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import {
  resolveRuntimeBoundControllerUrl,
  resolveRuntimeControllerCredential,
} from "./runtime-controller-binding.js";

export type ControllerApiRequestOptions = {
  method: string;
  path: string;
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  query?: string[];
  headers?: string[];
  json?: string;
  jsonFile?: string;
  pretty?: boolean;
  allowCrossOrigin?: boolean;
};

export type ControllerApiJsonRequestOptions = {
  method: string;
  path: string;
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  query?: string[];
  headers?: string[];
  jsonBody?: unknown;
  allowCrossOrigin?: boolean;
};

function normalizeUrl(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "http://127.0.0.1:8788";
  return value.replace(/\/$/, "");
}

function normalizeToken(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function resolveBearerTokenWithSource(options: ControllerApiRequestOptions): {
  token: string | null;
  source: AccessTokenSource;
  profile: string | null;
  runtimeControllerUrl: string | null;
} {
  const cwd = process.cwd();
  const profile = resolveActiveProfileName({ cwd });
  const stored = resolveConfiguredAccessToken({ profile, cwd });

  const explicit = normalizeToken(options.accessToken);
  if (explicit) {
    return { token: explicit, source: "explicit", profile, runtimeControllerUrl: null };
  }

  // Runtime-launched AI tools receive a scoped child-process credential.
  // Do not treat the same legacy-looking environment names as public shell
  // inputs unless the runtime job context is present as well.
  const runtimeCredential = resolveRuntimeControllerCredential();
  if (runtimeCredential) {
    return {
      token: runtimeCredential.token,
      source: "env",
      profile: null,
      runtimeControllerUrl: runtimeCredential.controllerUrl,
    };
  }

  const envKeys = [
    "INSTAFY_ACCESS_TOKEN",
    "SUPABASE_ACCESS_TOKEN",
  ] as const;
  for (const key of envKeys) {
    const value = normalizeToken(process.env[key]);
    if (value) {
      return { token: value, source: "env", profile, runtimeControllerUrl: null };
    }
  }

  if (stored) {
    return { token: stored, source: "config", profile, runtimeControllerUrl: null };
  }
  return { token: null, source: "none", profile, runtimeControllerUrl: null };
}

function parseKeyValue(raw: string): { key: string; value: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Key/value pair cannot be empty");
  }
  const equals = trimmed.indexOf("=");
  if (equals === -1) {
    return { key: trimmed, value: "" };
  }
  const key = trimmed.slice(0, equals).trim();
  const value = trimmed.slice(equals + 1).trim();
  if (!key) {
    throw new Error(`Invalid pair "${raw}" (missing key)`);
  }
  return { key, value };
}

function parseHeader(raw: string): { key: string; value: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Header cannot be empty");
  }
  const colon = trimmed.indexOf(":");
  if (colon !== -1) {
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!key) {
      throw new Error(`Invalid header "${raw}" (missing name)`);
    }
    return { key, value };
  }
  return parseKeyValue(trimmed);
}

function parseJsonBody(options: ControllerApiRequestOptions): string | undefined {
  if (options.jsonFile) {
    const raw = fs.readFileSync(options.jsonFile, "utf8");
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  }
  if (options.json) {
    const parsed = JSON.parse(options.json);
    return JSON.stringify(parsed);
  }
  return undefined;
}

function buildRequestUrl(
  options: ControllerApiRequestOptions,
  runtimeControllerUrl: string | null,
): { url: URL; crossOrigin: boolean } {
  const selectedControllerUrl = options.controllerUrl ?? runtimeControllerUrl;
  const base = new URL(
    `${normalizeUrl(resolveControllerUrl({ controllerUrl: selectedControllerUrl ?? null }))}/`,
  );
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("The configured controller URL must use http or https.");
  }
  if (base.username || base.password) {
    throw new Error("The configured controller URL must not contain embedded credentials.");
  }
  if (runtimeControllerUrl) {
    resolveRuntimeBoundControllerUrl(
      { controllerUrl: runtimeControllerUrl },
      base.toString(),
    );
  }

  const rawPath = options.path.trim();
  if (!rawPath) {
    throw new Error("Path is required");
  }

  const isAbsoluteReference = /^[a-z][a-z\d+.-]*:/i.test(rawPath) || rawPath.startsWith("//");
  const url = new URL(
    isAbsoluteReference ? rawPath : rawPath.startsWith("/") ? rawPath : `/${rawPath}`,
    base,
  );
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Controller API URLs must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Controller API URLs must not contain embedded credentials.");
  }
  const crossOrigin = url.origin !== base.origin;
  if (crossOrigin && !options.allowCrossOrigin) {
    throw new Error(
      "Refusing a cross-origin controller API request. Set --server-url to that origin and use a relative path, or pass --allow-cross-origin only when you explicitly intend to send credentials and request data there.",
    );
  }

  for (const pair of options.query ?? []) {
    const { key, value } = parseKeyValue(pair);
    url.searchParams.set(key, value);
  }

  return { url, crossOrigin };
}

function maybePrettyPrintJson(text: string, pretty: boolean): string {
  if (!pretty) return text;
  if (!text.trim()) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function executeControllerApiRequest(
  options: ControllerApiRequestOptions,
  bodyOverride?: string | undefined,
): Promise<{ response: Response; responseText: string; isJson: boolean }> {
  const resolved = resolveBearerTokenWithSource(options);
  const { url, crossOrigin } = buildRequestUrl(options, resolved.runtimeControllerUrl);
  const bearer = resolved.token;
  if (crossOrigin && (!bearer || resolved.source !== "explicit")) {
    throw new Error(
      "Cross-origin controller API requests require --allow-cross-origin and an explicit --access-token.",
    );
  }

  const headers = new Headers();
  headers.set("accept", "application/json");

  for (const header of options.headers ?? []) {
    const { key, value } = parseHeader(header);
    headers.set(key, value);
  }

  const body = bodyOverride ?? parseJsonBody(options);
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const init: RequestInit = {
    method: options.method,
    headers,
    body,
    redirect: "error",
  };
  const response = bearer
    ? (
        await fetchWithControllerAuth({
          url: url.toString(),
          init,
          accessToken: bearer,
          tokenSource: resolved.source,
          profile: resolved.profile,
          cwd: process.cwd(),
        })
      ).response
    : await fetch(url, init);

  const responseText = await response.text().catch(() => "");
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json") || contentType.includes("+json");

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: responseText,
        retryCommand: "instafy login",
        advancedHint: "pass --access-token, or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN",
      });
    }
    const formattedBody = isJson ? maybePrettyPrintJson(responseText, true) : responseText;
    const prefix = `Request failed (${response.status} ${response.statusText})`;
    const suffix = formattedBody.trim() ? `: ${formattedBody}` : "";
    throw new Error(`${prefix}${suffix}`);
  }

  return { response, responseText, isJson };
}

export async function requestControllerApiJson<T = unknown>(
  options: ControllerApiJsonRequestOptions,
): Promise<T> {
  const body =
    options.jsonBody === undefined ? undefined : JSON.stringify(options.jsonBody);
  const { responseText, isJson } = await executeControllerApiRequest(
    {
      method: options.method,
      path: options.path,
      controllerUrl: options.controllerUrl,
      accessToken: options.accessToken,
      serviceToken: options.serviceToken,
      query: options.query,
      headers: options.headers,
      allowCrossOrigin: options.allowCrossOrigin,
    },
    body,
  );

  if (!isJson) {
    throw new Error("Expected JSON response from controller API");
  }

  return JSON.parse(responseText) as T;
}

export async function requestControllerApi(options: ControllerApiRequestOptions) {
  const { responseText, isJson } = await executeControllerApiRequest(options);
  const pretty = options.pretty !== false;
  const formattedBody = isJson ? maybePrettyPrintJson(responseText, pretty) : responseText;

  if (formattedBody) console.log(formattedBody);
}
