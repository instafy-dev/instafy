import os from "node:os";

export interface MintOriginTokenParams {
  controllerUrl: string;
  projectId: string;
  supabaseAccessToken: string;
  runtimeDisplayName?: string | null;
  deviceId?: string | null;
  ttlSeconds?: number;
}

export interface MintOriginTokenResponse {
  token: string;
  expiresAt: string;
  expiresIn: number;
}

export async function mintOriginInternalToken(
  params: MintOriginTokenParams,
): Promise<MintOriginTokenResponse> {
  const controllerBase = params.controllerUrl.replace(/\/$/, "");
  const endpoint = `${controllerBase}/projects/${encodeURIComponent(params.projectId)}/runtime/token`;

  const body: Record<string, unknown> = {
    runtimeId: null,
    leaseId: null,
    subject: params.runtimeDisplayName ?? os.hostname(),
  };
  if (params.ttlSeconds && params.ttlSeconds >= 300) {
    body.ttlSeconds = params.ttlSeconds;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.supabaseAccessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to mint origin token (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const token = typeof payload.token === "string" ? payload.token : "";
  const expiresAt =
    typeof payload.expires_at === "string"
      ? payload.expires_at
      : typeof payload.expiresAt === "string"
        ? payload.expiresAt
        : "";
  const expiresIn =
    typeof payload.expires_in === "number"
      ? payload.expires_in
      : typeof payload.expiresIn === "number"
        ? payload.expiresIn
        : 0;

  if (!token || !expiresAt) {
    throw new Error("Origin token response missing required fields.");
  }

  return {
    token,
    expiresAt,
    expiresIn,
  };
}
