import { formatAuthRejectedError } from "./errors.js";

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
  const controller = new URL(params.controllerUrl);
  if (
    (controller.protocol !== "http:" && controller.protocol !== "https:") ||
    controller.username ||
    controller.password
  ) {
    throw new Error("The controller URL must use http or https and must not contain credentials.");
  }
  const url = controller.toString().replace(/\/$/, "");
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
    signal: params.signal ?? AbortSignal.timeout(60_000),
    redirect: "error",
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
