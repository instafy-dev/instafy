import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeSpeechHttpResponse = {
  payloadJson?: string | null;
  text?: string | null;
  audioDataUrl?: string | null;
  mimeType?: string | null;
  contentType?: string | null;
  statusCode?: number | null;
};

type NativeSpeechBridgePlugin = {
  health(options: {
    url: string;
    authToken?: string | null;
  }): Promise<NativeSpeechHttpResponse>;
  transcribe(options: {
    url: string;
    authToken?: string | null;
    bodyJson: string;
  }): Promise<NativeSpeechHttpResponse>;
  synthesize(options: {
    url: string;
    authToken?: string | null;
    bodyJson: string;
  }): Promise<NativeSpeechHttpResponse>;
};

let nativeSpeechBridgePlugin: NativeSpeechBridgePlugin | null = null;
let nativeSpeechBridgePluginInitialized = false;

function getNativeSpeechBridgePlugin(): NativeSpeechBridgePlugin | null {
  if (!Capacitor.isNativePlatform()) {
    return null;
  }
  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") {
    return null;
  }
  if (!nativeSpeechBridgePluginInitialized) {
    nativeSpeechBridgePlugin = registerPlugin<NativeSpeechBridgePlugin>("InstafySpeechHttpBridge");
    nativeSpeechBridgePluginInitialized = true;
  }
  return nativeSpeechBridgePlugin;
}

function normalizeString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePayloadJson(payloadJson: string | null | undefined) {
  const normalized = normalizeString(payloadJson);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return normalized;
  }
}

export function nativeSpeechBridgeAvailable() {
  return getNativeSpeechBridgePlugin() !== null;
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function shouldUseNativeSpeechBridgeForUrl(url: string) {
  const plugin = getNativeSpeechBridgePlugin();
  if (!plugin) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return !isLoopbackHostname(parsed.hostname);
  } catch {
    return true;
  }
}

export async function nativeSpeechBridgeHealth(options: {
  url: string;
  authToken?: string | null;
}): Promise<{
  payload: unknown;
  text: string | null;
  contentType: string | null;
  statusCode: number | null;
}> {
  const plugin = getNativeSpeechBridgePlugin();
  if (!plugin) {
    throw new Error("Native speech bridge is unavailable.");
  }
  const response = await plugin.health({
    url: options.url,
    authToken: normalizeString(options.authToken),
  });
  return {
    payload: parsePayloadJson(response.payloadJson),
    text: normalizeString(response.text),
    contentType: normalizeString(response.contentType),
    statusCode:
      typeof response.statusCode === "number" && Number.isFinite(response.statusCode)
        ? response.statusCode
        : null,
  };
}

export async function nativeSpeechBridgeTranscribe(options: {
  url: string;
  authToken?: string | null;
  body: Record<string, unknown>;
}): Promise<{
  payload: unknown;
  contentType: string | null;
  statusCode: number | null;
}> {
  const plugin = getNativeSpeechBridgePlugin();
  if (!plugin) {
    throw new Error("Native speech bridge is unavailable.");
  }
  const response = await plugin.transcribe({
    url: options.url,
    authToken: normalizeString(options.authToken),
    bodyJson: JSON.stringify(options.body),
  });
  return {
    payload:
      parsePayloadJson(response.payloadJson) ??
      normalizeString(response.text) ??
      null,
    contentType: normalizeString(response.contentType),
    statusCode:
      typeof response.statusCode === "number" && Number.isFinite(response.statusCode)
        ? response.statusCode
        : null,
  };
}

export async function nativeSpeechBridgeSynthesize(options: {
  url: string;
  authToken?: string | null;
  body: Record<string, unknown>;
}): Promise<{
  audioDataUrl?: string;
  mimeType?: string | null;
  payload?: unknown;
  text?: string | null;
  contentType: string | null;
  statusCode: number | null;
}> {
  const plugin = getNativeSpeechBridgePlugin();
  if (!plugin) {
    throw new Error("Native speech bridge is unavailable.");
  }
  const response = await plugin.synthesize({
    url: options.url,
    authToken: normalizeString(options.authToken),
    bodyJson: JSON.stringify(options.body),
  });
  return {
    audioDataUrl: normalizeString(response.audioDataUrl) ?? undefined,
    mimeType: normalizeString(response.mimeType),
    payload: parsePayloadJson(response.payloadJson),
    text: normalizeString(response.text),
    contentType: normalizeString(response.contentType),
    statusCode:
      typeof response.statusCode === "number" && Number.isFinite(response.statusCode)
        ? response.statusCode
        : null,
  };
}
