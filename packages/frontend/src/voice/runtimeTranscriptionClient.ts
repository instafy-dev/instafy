import type { AudioArtifact } from "./audioArtifact";
import { encodeAudioArtifactDataUrl } from "./audioArtifact";
import { resolveControllerSpeechProxyRequest } from "../services/runtimeController/speech";
import {
  nativeSpeechBridgeAvailable,
  nativeSpeechBridgeTranscribe,
} from "../native/nativeSpeechBridge";

export type RuntimeTranscriptionBackendConfig = {
  url: string;
  authToken: string | null;
  model: string | null;
  language: string | null;
};

export type RuntimeSpeechRouteOverride = {
  baseUrl?: string | null;
  authToken?: string | null;
};

type RuntimeTranscriptionEnv = Partial<
  Pick<
    ImportMetaEnv,
    | "VITE_INSTAFY_SPEECH_BASE_URL"
    | "VITE_INSTAFY_SPEECH_TOKEN"
    | "VITE_INSTAFY_TRANSCRIPTION_URL"
    | "VITE_INSTAFY_TRANSCRIPTION_TOKEN"
    | "VITE_INSTAFY_TRANSCRIPTION_MODEL"
    | "VITE_INSTAFY_TRANSCRIPTION_LANGUAGE"
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

export function getRuntimeTranscriptionBackendConfig(
  env: RuntimeTranscriptionEnv = import.meta.env,
  routeOverride?: RuntimeSpeechRouteOverride | null,
): RuntimeTranscriptionBackendConfig | null {
  const overrideBaseUrl = trimEnvValue(routeOverride?.baseUrl);
  const explicitUrl = trimEnvValue(env.VITE_INSTAFY_TRANSCRIPTION_URL);
  const baseUrl = trimEnvValue(env.VITE_INSTAFY_SPEECH_BASE_URL);
  const url =
    (overrideBaseUrl ? `${trimTrailingSlash(overrideBaseUrl)}/transcribe` : null) ||
    explicitUrl ||
    (baseUrl ? `${trimTrailingSlash(baseUrl)}/transcribe` : null);
  if (!url) {
    return null;
  }
  return {
    url,
    authToken:
      trimEnvValue(routeOverride?.authToken) ??
      trimEnvValue(env.VITE_INSTAFY_TRANSCRIPTION_TOKEN) ??
      trimEnvValue(env.VITE_INSTAFY_SPEECH_TOKEN),
    model: trimEnvValue(env.VITE_INSTAFY_TRANSCRIPTION_MODEL),
    language: trimEnvValue(env.VITE_INSTAFY_TRANSCRIPTION_LANGUAGE),
  };
}

export function getRuntimeTranscriptionBackendLabel(
  config: RuntimeTranscriptionBackendConfig | null,
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

export function extractRuntimeTranscriptionText(payload: unknown): string {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed) {
      return trimmed;
    }
    throw new Error("Transcription service returned an empty response.");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Transcription service returned an unsupported response.");
  }

  const record = payload as Record<string, unknown>;
  for (const key of ["text", "transcript", "output_text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  if (record.result && typeof record.result === "object") {
    const nested = record.result as Record<string, unknown>;
    if (typeof nested.text === "string" && nested.text.trim()) {
      return nested.text.trim();
    }
  }

  if (Array.isArray(record.segments)) {
    const transcript = record.segments
      .map((segment) =>
        segment && typeof segment === "object" && typeof (segment as { text?: unknown }).text === "string"
          ? (segment as { text: string }).text.trim()
          : "",
      )
      .filter(Boolean)
      .join(" ")
      .trim();
    if (transcript) {
      return transcript;
    }
  }

  throw new Error("Transcription service returned an unsupported response shape.");
}

export async function transcribeRuntimeAudio(options: {
  artifact: AudioArtifact;
  signal?: AbortSignal;
  env?: RuntimeTranscriptionEnv;
  projectId?: string | null;
  accessToken?: string | null;
  config?: RuntimeTranscriptionBackendConfig | null;
}): Promise<string> {
  const config = options.config ?? getRuntimeTranscriptionBackendConfig(options.env ?? import.meta.env);
  if (!config) {
    throw new Error("Mounted runtime transcription is not configured.");
  }

  const formData = new FormData();
  formData.append("file", options.artifact.blob, options.artifact.fileName);
  if (config.model) {
    formData.append("model", config.model);
  }
  if (config.language) {
    formData.append("language", config.language);
  }

  const proxiedRequest = await resolveControllerSpeechProxyRequest({
    projectId: options.projectId ?? null,
    baseUrl: config.url,
    accessToken: options.accessToken ?? null,
    upstreamAuthToken: config.authToken,
  });
  const headers = new Headers(proxiedRequest?.headers);
  if (config.authToken && !proxiedRequest) {
    headers.set("Authorization", `Bearer ${config.authToken}`);
  }

  const fetchTranscription = async () => {
    const controller =
      !proxiedRequest && typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId =
      controller && !options.signal
        ? setTimeout(() => {
            controller.abort();
          }, DIRECT_SPEECH_REQUEST_TIMEOUT_MS)
        : null;
    let response: Response;
    try {
      response = await fetch(proxiedRequest?.baseUrl ?? config.url, {
        method: "POST",
        body: formData,
        headers,
        signal: controller?.signal ?? options.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Transcription request failed for ${config.url}: ${message}`);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    if (!response.ok) {
      const detail = (await response.text()).trim();
      const suffix = detail ? `: ${detail.slice(0, 180)}` : "";
      throw new Error(`Transcription failed (${response.status})${suffix}`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      return extractRuntimeTranscriptionText(await response.json());
    }

    return extractRuntimeTranscriptionText(await response.text());
  };

  const canTryNative = !proxiedRequest && nativeSpeechBridgeAvailable();
  let nativeError: Error | null = null;
  if (canTryNative) {
    try {
      const audioDataUrl = await encodeAudioArtifactDataUrl(options.artifact);
      const nativeResponse = await withDirectSpeechTimeout(
        "Native speech bridge transcription",
        nativeSpeechBridgeTranscribe({
          url: config.url,
          authToken: config.authToken,
          body: {
            audioDataUrl,
            fileName: options.artifact.fileName,
            model: config.model,
            language: config.language,
          },
        }),
      );
      return extractRuntimeTranscriptionText(nativeResponse.payload);
    } catch (error) {
      nativeError = error instanceof Error ? error : new Error(String(error));
    }
  }

  try {
    return await fetchTranscription();
  } catch (error) {
    if (nativeError) {
      const fetchMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Transcription request failed for ${config.url}: native bridge failed (${nativeError.message}); fetch fallback failed (${fetchMessage})`,
      );
    }
    throw error;
  }
}
