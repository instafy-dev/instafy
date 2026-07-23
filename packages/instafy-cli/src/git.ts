import fs from "node:fs";
import path from "node:path";
import kleur from "kleur";
import { resolveConfiguredAccessToken, resolveControllerUrl } from "./config.js";
import { formatAuthRejectedError } from "./errors.js";

function normalizeToken(value: string | undefined | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTokenFromFile(filePath: string | undefined | null): string | null {
  const normalized = normalizeToken(filePath);
  if (!normalized) {
    return null;
  }
  const resolved = path.resolve(normalized);
  const contents = fs.readFileSync(resolved, "utf8").trim();
  if (!contents) {
    throw new Error(`token file ${resolved} was empty`);
  }
  return contents;
}

function resolveControllerAccessToken(options: {
  controllerAccessToken?: string;
  supabaseAccessToken?: string;
  supabaseAccessTokenFile?: string;
}): string | null {
  return (
    normalizeToken(options.controllerAccessToken) ??
    normalizeToken(process.env["INSTAFY_ACCESS_TOKEN"]) ??
    normalizeToken(process.env["CONTROLLER_ACCESS_TOKEN"]) ??
    normalizeToken(process.env["RUNTIME_ACCESS_TOKEN"]) ??
    normalizeToken(options.supabaseAccessToken) ??
    readTokenFromFile(options.supabaseAccessTokenFile) ??
    normalizeToken(process.env["SUPABASE_ACCESS_TOKEN"]) ??
    resolveConfiguredAccessToken() ??
    null
  );
}

export async function mintGitAccessToken(params: {
  controllerUrl: string;
  controllerAccessToken: string;
  projectId: string;
  scopes?: string[];
  ttlSeconds?: number;
  signal?: AbortSignal;
}): Promise<{
  projectId: string;
  token: string;
  expiresIn: number;
  scopes: string[];
}> {
  const url = params.controllerUrl.replace(/\/$/, "");
  const target = `${url}/projects/${encodeURIComponent(params.projectId)}/git/access_token`;

  const scopes =
    params.scopes && params.scopes.length > 0
      ? params.scopes
      : ["git.read", "git.write"];

  const response = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.controllerAccessToken}`,
      "content-type": "application/json",
    },
    signal: params.signal,
    body: JSON.stringify({
      scopes,
      ttlSeconds: params.ttlSeconds,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
      });
    }
    throw new Error(
      `Instafy server rejected git token request (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const payload = (await response.json()) as {
    projectId?: string;
    token?: string;
    expiresIn?: number;
    scopes?: string[];
  };

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("Instafy server response missing token field while minting git token.");
  }

  const expiresIn = typeof payload.expiresIn === "number" ? payload.expiresIn : 0;
  return {
    projectId: payload.projectId ?? params.projectId,
    token,
    expiresIn,
    scopes: Array.isArray(payload.scopes) ? payload.scopes : scopes,
  };
}

export async function gitToken(options: {
  project: string;
  controllerUrl?: string;
  controllerAccessToken?: string;
  supabaseAccessToken?: string;
  supabaseAccessTokenFile?: string;
  scopes?: string[];
  ttlSeconds?: number;
  json?: boolean;
}): Promise<string | void> {
  const controllerUrl = resolveControllerUrl({ controllerUrl: options.controllerUrl ?? null });

  const token = resolveControllerAccessToken({
    controllerAccessToken: options.controllerAccessToken,
    supabaseAccessToken: options.supabaseAccessToken,
    supabaseAccessTokenFile: options.supabaseAccessTokenFile,
  });
  if (!token) {
    throw new Error(
      "Login required. Run `instafy login` or pass --access-token / --supabase-access-token.",
    );
  }

  const minted = await mintGitAccessToken({
    controllerUrl,
    controllerAccessToken: token,
    projectId: options.project,
    scopes: options.scopes,
    ttlSeconds: options.ttlSeconds,
  });

  if (options.json) {
    console.log(JSON.stringify(minted));
  } else {
    console.log(minted.token);
    if (minted.expiresIn > 0) {
      console.error(kleur.gray(`expiresIn=${minted.expiresIn}s`));
    }
  }
  return minted.token;
}
