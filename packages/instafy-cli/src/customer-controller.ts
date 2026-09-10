import {
  resolveActiveProfileName,
  resolveConfiguredAccessToken,
  resolveControllerUrl,
  type AccessTokenSource,
} from "./config.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import { formatAuthRejectedError } from "./errors.js";

export type CustomerControllerAuthOptions = {
  controllerUrl?: string;
  accessToken?: string;
};

type ResolvedCustomerToken = {
  token: string;
  source: AccessTokenSource;
  profile: string | null;
};

type JsonRecord = Record<string, unknown>;

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveCustomerToken(explicitToken?: string): ResolvedCustomerToken {
  const cwd = process.cwd();
  const profile = resolveActiveProfileName({ cwd });
  const candidates: Array<{ value: string | null | undefined; source: AccessTokenSource }> = [
    { value: explicitToken, source: "explicit" },
    { value: process.env["INSTAFY_ACCESS_TOKEN"], source: "env" },
    { value: process.env["SUPABASE_ACCESS_TOKEN"], source: "env" },
    { value: resolveConfiguredAccessToken({ profile, cwd }), source: "config" },
  ];

  for (const candidate of candidates) {
    const token = cleanText(candidate.value);
    if (token) {
      return { token, source: candidate.source, profile };
    }
  }

  throw new Error(
    "This command requires a signed-in user. Run `instafy login` or pass --access-token.",
  );
}

export async function customerControllerJsonRequest<T>(
  options: CustomerControllerAuthOptions & {
    method: "GET" | "POST";
    apiPath: string;
    body?: unknown;
    operation: string;
    notFoundMessage?: string;
  },
): Promise<T> {
  const resolved = resolveCustomerToken(options.accessToken);
  const controllerUrl = resolveControllerUrl({
    controllerUrl: options.controllerUrl ?? null,
    profile: resolved.profile,
    cwd: process.cwd(),
  });
  const baseUrl = new URL(controllerUrl.endsWith("/") ? controllerUrl : `${controllerUrl}/`);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("The Instafy controller URL must use http or https.");
  }
  if (baseUrl.username || baseUrl.password) {
    throw new Error("The Instafy controller URL must not contain embedded credentials.");
  }
  const requestUrl = new URL(options.apiPath.replace(/^\/+/, ""), baseUrl);
  if (requestUrl.origin !== baseUrl.origin) {
    throw new Error(`${options.operation} requests must use the configured Instafy controller origin.`);
  }

  const headers = new Headers({ accept: "application/json" });
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const { response } = await fetchWithControllerAuth({
    url: requestUrl.toString(),
    init: {
      method: options.method,
      headers,
      body,
      redirect: "error",
    },
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd: process.cwd(),
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    if (response.status === 404 && options.notFoundMessage) throw new Error(options.notFoundMessage);
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: responseText,
        retryCommand: "instafy login",
        advancedHint: "pass --access-token with an interactive Instafy user token",
      });
    }
    let detail = responseText.trim();
    try {
      const parsed = JSON.parse(responseText) as JsonRecord;
      detail = cleanText(parsed["message"]) ?? cleanText(parsed["error"]) ?? detail;
    } catch {
      // Preserve a bounded controller response when it is not JSON.
    }
    if (detail.length > 500) {
      detail = `${detail.slice(0, 497)}...`;
    }
    throw new Error(
      `${options.operation} request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }
  if (!responseText.trim()) {
    throw new Error(`${options.operation} response was empty.`);
  }
  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new Error(`${options.operation} response was not valid JSON.`);
  }
}
