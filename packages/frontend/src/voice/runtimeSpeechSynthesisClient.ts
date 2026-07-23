import {
  createAudioArtifactFromBlob,
  encodeAudioArtifactDataUrl,
} from "./audioArtifact";
import { resolveControllerSpeechProxyRequest } from "../services/runtimeController/speech";
import {
  nativeSpeechBridgeAvailable,
  nativeSpeechBridgeSynthesize,
} from "../native/nativeSpeechBridge";
import type { RuntimeSpeechRouteOverride } from "./runtimeTranscriptionClient";

export type RuntimeSpeechSynthesisBackendConfig = {
  url: string;
  authToken: string | null;
};

export type RuntimeSpeechSynthesisDebugEvent = {
  stage:
    | "proxy_resolve_start"
    | "proxy_resolve_ready"
    | "native_request_start"
    | "native_request_success"
    | "native_request_failed"
    | "fetch_request_start"
    | "fetch_request_success"
    | "fetch_request_failed";
  detail?: string | null;
  sourceKind?: "audio" | "json" | "none" | null;
};

type RuntimeSpeechSynthesisEnv = Partial<
  Pick<
    ImportMetaEnv,
    | "VITE_INSTAFY_SPEECH_BASE_URL"
    | "VITE_INSTAFY_SPEECH_TOKEN"
    | "VITE_INSTAFY_SYNTHESIS_URL"
    | "VITE_INSTAFY_SYNTHESIS_TOKEN"
  >
>;

const DIRECT_SPEECH_REQUEST_TIMEOUT_MS = 20_000;

function trimEnvValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

async function withDirectSpeechTimeout<T>(
  label: string,
  task: Promise<T>,
  timeoutMs = DIRECT_SPEECH_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createTimedRequestSignal(options?: {
  timeoutMs?: number;
  upstreamSignal?: AbortSignal;
}) {
  if (typeof AbortController === "undefined") {
    return {
      signal: options?.upstreamSignal,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? DIRECT_SPEECH_REQUEST_TIMEOUT_MS;
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const upstreamAbort = () => {
    controller.abort();
  };
  options?.upstreamSignal?.addEventListener("abort", upstreamAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      options?.upstreamSignal?.removeEventListener("abort", upstreamAbort);
    },
  };
}

export function getRuntimeSpeechSynthesisBackendConfig(
  env: RuntimeSpeechSynthesisEnv = import.meta.env,
  routeOverride?: RuntimeSpeechRouteOverride | null,
): RuntimeSpeechSynthesisBackendConfig | null {
  const overrideBaseUrl = trimEnvValue(routeOverride?.baseUrl);
  const explicitUrl = trimEnvValue(env.VITE_INSTAFY_SYNTHESIS_URL);
  const baseUrl = trimEnvValue(env.VITE_INSTAFY_SPEECH_BASE_URL);
  const url =
    (overrideBaseUrl ? `${trimTrailingSlash(overrideBaseUrl)}/synthesize` : null) ||
    explicitUrl ||
    (baseUrl ? `${trimTrailingSlash(baseUrl)}/synthesize` : null);
  if (!url) {
    return null;
  }
  return {
    url,
    authToken:
      trimEnvValue(routeOverride?.authToken) ??
      trimEnvValue(env.VITE_INSTAFY_SYNTHESIS_TOKEN) ??
      trimEnvValue(env.VITE_INSTAFY_SPEECH_TOKEN),
  };
}

export function getRuntimeSpeechSynthesisBackendLabel(
  config: RuntimeSpeechSynthesisBackendConfig | null,
): string | null {
  if (!config) {
    return null;
  }
  try {
    const parsed = new URL(config.url);
    return parsed.hostname || parsed.origin || config.url;
  } catch {
    return config.url;
  }
}

export async function synthesizeRuntimeSpeech(options: {
  text: string;
  voice?: string | null;
  language?: string | null;
  rate?: number;
  pitch?: number;
  volume?: number;
  format?: string | null;
  signal?: AbortSignal;
  env?: RuntimeSpeechSynthesisEnv;
  projectId?: string | null;
  accessToken?: string | null;
  config?: RuntimeSpeechSynthesisBackendConfig | null;
  onDebugEvent?: (event: RuntimeSpeechSynthesisDebugEvent) => void;
}): Promise<{
  audioUrl?: string;
  audioDataUrl?: string;
  mimeType?: string;
}> {
  const config = options.config ?? getRuntimeSpeechSynthesisBackendConfig(options.env ?? import.meta.env);
  if (!config) {
    throw new Error("Mounted runtime speech synthesis is not configured.");
  }

  options.onDebugEvent?.({
    stage: "proxy_resolve_start",
    detail: config.url,
    sourceKind: null,
  });
  const proxiedRequest = await resolveControllerSpeechProxyRequest({
    projectId: options.projectId ?? null,
    baseUrl: config.url,
    accessToken: options.accessToken ?? null,
    upstreamAuthToken: config.authToken,
  });
  options.onDebugEvent?.({
    stage: "proxy_resolve_ready",
    detail: proxiedRequest?.baseUrl ?? config.url,
    sourceKind: null,
  });
  const body = {
    text: options.text,
    voice: options.voice ?? null,
    language: options.language ?? null,
    rate: typeof options.rate === "number" ? options.rate : null,
    pitch: typeof options.pitch === "number" ? options.pitch : null,
    volume: typeof options.volume === "number" ? options.volume : null,
    format: options.format ?? null,
  };
  const normalizeNativeResponse = (nativeResponse: Awaited<ReturnType<typeof nativeSpeechBridgeSynthesize>>) => {
    if (nativeResponse.audioDataUrl) {
      return {
        audioDataUrl: nativeResponse.audioDataUrl,
        mimeType: nativeResponse.mimeType ?? nativeResponse.contentType ?? undefined,
      };
    }
    if (nativeResponse.payload && typeof nativeResponse.payload === "object") {
      const record = nativeResponse.payload as Record<string, unknown>;
      return {
        audioUrl: typeof record.audioUrl === "string" ? record.audioUrl : undefined,
        audioDataUrl:
          typeof record.audioDataUrl === "string"
            ? record.audioDataUrl
            : typeof record.audio_data_url === "string"
              ? record.audio_data_url
              : undefined,
        mimeType:
          typeof record.mimeType === "string"
            ? record.mimeType
            : typeof record.mime_type === "string"
              ? record.mime_type
              : undefined,
      };
    }
    return {};
  };

  const fetchSynthesis = async () => {
    const timedSignal = createTimedRequestSignal({
      timeoutMs: DIRECT_SPEECH_REQUEST_TIMEOUT_MS,
      upstreamSignal: options.signal,
    });
    options.onDebugEvent?.({
      stage: "fetch_request_start",
      detail: proxiedRequest?.baseUrl ?? config.url,
      sourceKind: null,
    });
    let response: Response;
    try {
      response = await fetch(proxiedRequest?.baseUrl ?? config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(proxiedRequest?.headers ??
            (config.authToken ? { authorization: `Bearer ${config.authToken}` } : {})),
        },
        body: JSON.stringify(body),
        signal: timedSignal.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onDebugEvent?.({
        stage: "fetch_request_failed",
        detail: message,
        sourceKind: null,
      });
      throw new Error(`Speech synthesis request failed for ${config.url}: ${message}`);
    } finally {
      timedSignal.cleanup();
    }

    if (!response.ok) {
      const detail = (await response.text()).trim();
      const suffix = detail ? `: ${detail.slice(0, 180)}` : "";
      options.onDebugEvent?.({
        stage: "fetch_request_failed",
        detail: `HTTP ${response.status}${suffix}`,
        sourceKind: null,
      });
      throw new Error(`Speech synthesis failed (${response.status})${suffix}`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("audio/")) {
      const blob = new Blob([await response.arrayBuffer()], { type: contentType });
      const artifact = createAudioArtifactFromBlob(blob, {
        baseName: "instafy-speech-reply",
        mimeType: contentType,
      });
      const audioDataUrl = await encodeAudioArtifactDataUrl(artifact);
      const objectUrl =
        typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(blob)
          : null;
      options.onDebugEvent?.({
        stage: "fetch_request_success",
        detail: contentType,
        sourceKind: "audio",
      });
      return {
        audioUrl: objectUrl ?? undefined,
        audioDataUrl,
        mimeType: contentType,
      };
    }

    if (contentType.includes("application/json")) {
      const payload = await response.json();
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        return {
          audioUrl: typeof record.audioUrl === "string" ? record.audioUrl : undefined,
          audioDataUrl:
            typeof record.audioDataUrl === "string"
              ? record.audioDataUrl
              : typeof record.audio_data_url === "string"
                ? record.audio_data_url
                : undefined,
          mimeType:
            typeof record.mimeType === "string"
              ? record.mimeType
              : typeof record.mime_type === "string"
                ? record.mime_type
                : undefined,
        };
      }
    }

    options.onDebugEvent?.({
      stage: "fetch_request_success",
      detail: contentType || "empty",
      sourceKind: contentType.startsWith("audio/") ? "audio" : contentType.includes("application/json") ? "json" : "none",
    });
    return {};
  };

  const canTryNative = !proxiedRequest && nativeSpeechBridgeAvailable();
  const preferNative = canTryNative;
  let nativeError: Error | null = null;
  if (preferNative) {
    try {
      options.onDebugEvent?.({
        stage: "native_request_start",
        detail: config.url,
        sourceKind: null,
      });
      const nativeResponse = await withDirectSpeechTimeout(
        "Native speech bridge synthesis",
        nativeSpeechBridgeSynthesize({
          url: config.url,
          authToken: config.authToken,
          body,
        }),
      );
      options.onDebugEvent?.({
        stage: "native_request_success",
        detail: nativeResponse.contentType ?? nativeResponse.mimeType ?? "empty",
        sourceKind:
          nativeResponse.audioDataUrl
            ? "audio"
            : nativeResponse.payload
              ? "json"
              : "none",
      });
      return normalizeNativeResponse(
        nativeResponse,
      );
    } catch (error) {
      nativeError = error instanceof Error ? error : new Error(String(error));
      options.onDebugEvent?.({
        stage: "native_request_failed",
        detail: nativeError.message,
        sourceKind: null,
      });
    }
  }

  try {
    const fetched = await fetchSynthesis();
    if (fetched.audioDataUrl || fetched.audioUrl) {
      options.onDebugEvent?.({
        stage: "fetch_request_success",
        detail: fetched.mimeType ?? "ok",
        sourceKind: fetched.audioDataUrl || fetched.audioUrl ? "audio" : "none",
      });
      return fetched;
    }
  } catch (error) {
    if (!preferNative && canTryNative) {
      nativeError = error instanceof Error ? error : new Error(String(error));
    } else if (nativeError) {
      const fetchMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Speech synthesis request failed for ${config.url}: native bridge failed (${nativeError.message}); fetch fallback failed (${fetchMessage})`,
      );
    } else {
      throw error;
    }
  }

  if (!preferNative && canTryNative) {
    try {
      return normalizeNativeResponse(
        await withDirectSpeechTimeout(
          "Native speech bridge synthesis",
          nativeSpeechBridgeSynthesize({
            url: config.url,
            authToken: config.authToken,
            body,
          }),
        ),
      );
    } catch (error) {
      const nativeMessage = error instanceof Error ? error.message : String(error);
      if (nativeError) {
        throw new Error(
          `Speech synthesis request failed for ${config.url}: fetch failed (${nativeError.message}); native fallback failed (${nativeMessage})`,
        );
      }
      throw error;
    }
  }

  return {};
}
