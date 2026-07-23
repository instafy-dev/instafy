export interface MintControllerSessionParams {
  controllerUrl: string;
  supabaseAccessToken: string;
}

export interface MintControllerSessionResponse {
  token: string;
  expiresAt: string;
  expiresIn: number;
}

export async function mintControllerSessionToken(
  params: MintControllerSessionParams,
): Promise<MintControllerSessionResponse> {
  const base = params.controllerUrl.replace(/\/$/, "");
  const endpoint = `${base}/auth/session`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.supabaseAccessToken}`,
      "content-type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to create controller session (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const token = typeof payload.token === "string" ? payload.token : "";
  const expiresAt =
    typeof payload.expires_at === "number"
      ? new Date(payload.expires_at * 1000).toISOString()
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
    throw new Error("Controller session response missing required fields.");
  }

  return {
    token,
    expiresAt,
    expiresIn,
  };
}
