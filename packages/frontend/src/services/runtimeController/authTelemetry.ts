import { controllerBaseUrl, resolveControllerAccessToken, runtimeControllerEnabled } from "./core";

type AuthTelemetryLevel = "info" | "warning" | "error";

interface PostAuthTelemetryEventParams {
  kind: string;
  level?: AuthTelemetryLevel;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function postAuthTelemetryEvent(params: PostAuthTelemetryEventParams): Promise<void> {
  if (!runtimeControllerEnabled) {
    return;
  }

  const kind = params.kind.trim();
  if (!kind) {
    return;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  try {
    const accessToken = await resolveControllerAccessToken(null);
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    }
  } catch {
    // ignore token resolution failures; anonymous auth telemetry is allowed server-side
  }

  try {
    const response = await fetch(`${controllerBaseUrl}/telemetry`, {
      method: "POST",
      headers,
      keepalive: true,
      body: JSON.stringify({
        kind,
        level: params.level ?? "info",
        message: params.message ?? null,
        metadata: params.metadata ?? {},
      }),
    });
    if (!response.ok && import.meta.env.DEV) {
      console.warn("[auth-telemetry] controller rejected event", { kind, status: response.status });
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[auth-telemetry] failed to post event", { kind, message });
    }
  }
}
