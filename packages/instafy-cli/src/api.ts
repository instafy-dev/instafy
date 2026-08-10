import fs from "node:fs";
import { resolveActiveProfileName, resolveConfiguredAccessToken, resolveControllerUrl, type AccessTokenSource } from "./config.js";
import { formatAuthRejectedError } from "./errors.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";

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
} {
  const cwd = process.cwd();
  const profile = resolveActiveProfileName({ cwd });
  const stored = resolveConfiguredAccessToken({ profile, cwd });

  const explicit = normalizeToken(options.accessToken) ?? normalizeToken(options.serviceToken);
  if (explicit) {
    return { token: explicit, source: "explicit", profile };
  }

  const envKeys = [
    "CONTROLLER_ACCESS_TOKEN",
    "INSTAFY_ACCESS_TOKEN",
    "INSTAFY_SERVICE_TOKEN",
    "CONTROLLER_TOKEN",
    "SUPABASE_ACCESS_TOKEN",
  ] as const;
  for (const key of envKeys) {
    const value = normalizeToken(process.env[key]);
    if (value) {
      return { token: value, source: "env", profile };
    }
  }

  if (stored) {
    return { token: stored, source: "config", profile };
  }
  return { token: null, source: "none", profile };
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

function buildRequestUrl(options: ControllerApiRequestOptions): URL {
  // The one shared resolver, not a private fallback chain: this path used to
  // skip the controller URL that `instafy login` saved, so chat, history,
  // conversation, agents and api silently talked to localhost while every
  // other command honored the login. Same resolver everywhere, same answer
  // everywhere.
  const base = normalizeUrl(
    resolveControllerUrl({ controllerUrl: options.controllerUrl ?? null }),
  );

  const rawPath = options.path.trim();
  if (!rawPath) {
    throw new Error("Path is required");
  }

  const url = rawPath.startsWith("http://") || rawPath.startsWith("https://")
    ? new URL(rawPath)
    : new URL(rawPath.startsWith("/") ? rawPath : `/${rawPath}`, `${base}/`);

  for (const pair of options.query ?? []) {
    const { key, value } = parseKeyValue(pair);
    url.searchParams.set(key, value);
  }

  return url;
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
  const url = buildRequestUrl(options);
  const resolved = resolveBearerTokenWithSource(options);
  const bearer = resolved.token;

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
        advancedHint: "pass --access-token / --service-token, or set INSTAFY_ACCESS_TOKEN / INSTAFY_SERVICE_TOKEN",
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
