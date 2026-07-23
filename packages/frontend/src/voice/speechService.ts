import {
  callLocalProviderTool,
  getLocalProviderForCapability,
  getLocalProviderSummary,
  readLocalProviderResource,
  type LocalProviderSummary,
} from "../capabilities/localProviderHostClient";
import {
  extractRuntimeTranscriptionText,
  getRuntimeTranscriptionBackendConfig,
  getRuntimeTranscriptionBackendLabel,
  type RuntimeTranscriptionBackendConfig,
  transcribeRuntimeAudio,
} from "./runtimeTranscriptionClient";
import {
  getRuntimeSpeechSynthesisBackendConfig,
  getRuntimeSpeechSynthesisBackendLabel,
  type RuntimeSpeechSynthesisBackendConfig,
  synthesizeRuntimeSpeech,
} from "./runtimeSpeechSynthesisClient";
import { resolveControllerSpeechProxyRequest } from "../services/runtimeController/speech";
import {
  createAudioArtifactFromBlob,
  encodeAudioArtifactDataUrl,
  type AudioArtifact,
} from "./audioArtifact";
import {
  nativeSpeechBridgeAvailable,
  nativeSpeechBridgeHealth,
  shouldUseNativeSpeechBridgeForUrl,
} from "../native/nativeSpeechBridge";
import { playNativeHostAudio } from "../audio/nativeAudioPlaybackBridge";
import {
  SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID,
  SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI,
  SPEECH_PROVIDER_ID,
  SPEECH_SYNTHESIS_CAPABILITY_ID,
  SPEECH_SYNTHESIZE_SPEECH_TOOL_ID,
  SPEECH_TRANSCRIPTION_CAPABILITY_ID,
  SPEECH_TRANSCRIBE_AUDIO_TOOL_ID,
  SPEECH_VOICES_RESOURCE_URI,
} from "./speechCapabilityMetadata";
import { readProjectSpeechRoutes } from "./projectSpeechRoute";
import { readDiscoveredDesktopLanSpeechRoutes } from "./desktopLanDiscovery";
import {
  buildSpeechRouteHealthUrl,
  createEnvSpeechRoute,
  describeSpeechRouteTransport,
  selectReachableSpeechRoute,
  selectPreferredSpeechRoute,
  toSpeechRouteOverride,
  type SpeechRoute,
} from "./speechRoute";

type SpeechProviderToolAliasKey =
  | "transcribeAudio"
  | "synthesizeSpeech"
  | "bootstrapHostDependencies";

type ResolvedSpeechProviderTool = {
  provider: LocalProviderSummary;
  toolName: string;
};

export type SpeechTranscriptionBackendDescriptor = {
  kind: "provider" | "http" | "none";
  label: string | null;
  providerId?: string | null;
};

export type SpeechDependencyAction = {
  id: string;
  label: string;
  command: string;
  available?: boolean;
  required?: boolean;
  installed?: boolean;
  detail?: string | null;
};

export type SpeechDependencyStatus = {
  supported?: boolean;
  platform?: string;
  arch?: string;
  localService?: {
    command?: string | null;
    scriptPath?: string | null;
    scriptExists?: boolean;
    health?: {
      configured?: boolean;
      reachable?: boolean;
      url?: string | null;
      detail?: string | null;
      statusCode?: number;
      payload?: Record<string, unknown> | null;
    } | null;
  } | null;
  dependencies?: {
    python3?: { available?: boolean; path?: string | null } | null;
    managedRuntime?: {
      available?: boolean;
      home?: string | null;
      cacheDir?: string | null;
      cacheRootDir?: string | null;
      uvCacheDir?: string | null;
      runtimeCacheDir?: string | null;
      huggingfaceHome?: string | null;
      huggingfaceHubCache?: string | null;
      transformersCache?: string | null;
      xdgCacheHome?: string | null;
      modelCacheReady?: boolean;
      uvInstallerPath?: string | null;
      uvInstallerSource?: string | null;
      uvPath?: string | null;
      pythonPath?: string | null;
      whisperPath?: string | null;
      ffmpegPath?: string | null;
      installedAt?: string | null;
      uvVersion?: string | null;
      pythonVersion?: string | null;
      whisperVersion?: string | null;
      imageioFfmpegVersion?: string | null;
    } | null;
    whisper?: {
      available?: boolean;
      path?: string | null;
      command?: string | null;
      managed?: boolean;
    } | null;
    ffmpeg?: {
      available?: boolean;
      path?: string | null;
      command?: string | null;
      managed?: boolean;
    } | null;
    macSay?: { available?: boolean; path?: string | null } | null;
  } | null;
  transcription?: {
    configured?: boolean;
    ready?: boolean;
    engine?: string | null;
    model?: string | null;
    deviceId?: string | null;
    installState?: string | null;
    url?: string | null;
  } | null;
  synthesis?: {
    configured?: boolean;
    ready?: boolean;
    engine?: string | null;
    defaultVoice?: string | null;
    installState?: string | null;
    strictRoundtripSupported?: boolean;
    strictRoundtripReason?: string | null;
    url?: string | null;
  } | null;
  nextSteps?: string[];
  actions?: SpeechDependencyAction[];
};

export type SpeechServiceConnectionRoute = "local" | "tunnel" | "http" | "device" | "unknown";

export type SpeechServiceConnectionSummary = {
  route: SpeechServiceConnectionRoute;
  configured: boolean;
  reachable: boolean;
  hostLabel: string | null;
  badgeLabel: string;
  badgeTone: "success" | "warning" | "neutral";
  detail: string;
};

export type SpeechBootstrapResult = {
  ok: boolean;
  action?: string;
  dryRun?: boolean;
  commandsRun?: string[];
  error?: string;
  status?: SpeechDependencyStatus;
};

export type SpeechSynthesisBackendPreference = "auto" | "provider" | "browser";

export type SpeechVoiceOption = {
  id: string;
  label: string;
  language: string | null;
  source: "provider" | "browser";
  isDefault: boolean;
};

export type SpeechPlaybackDebugSnapshot = {
  stage: string;
  detail: string | null;
  sourceKind: string | null;
  via: "native" | "browser" | "provider" | "http" | "none" | null;
  updatedAt: string | null;
};

const DEFAULT_SPEECH_PLAYBACK_DEBUG_SNAPSHOT: SpeechPlaybackDebugSnapshot = {
  stage: "idle",
  detail: null,
  sourceKind: null,
  via: null,
  updatedAt: null,
};

let speechPlaybackDebugSnapshot: SpeechPlaybackDebugSnapshot = {
  ...DEFAULT_SPEECH_PLAYBACK_DEBUG_SNAPSHOT,
};

const speechPlaybackDebugListeners = new Set<(snapshot: SpeechPlaybackDebugSnapshot) => void>();

function setSpeechPlaybackDebugSnapshot(
  patch: Partial<SpeechPlaybackDebugSnapshot>,
): SpeechPlaybackDebugSnapshot {
  speechPlaybackDebugSnapshot = {
    ...speechPlaybackDebugSnapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  for (const listener of speechPlaybackDebugListeners) {
    listener(speechPlaybackDebugSnapshot);
  }
  return speechPlaybackDebugSnapshot;
}

export function readSpeechPlaybackDebugSnapshot(): SpeechPlaybackDebugSnapshot {
  return {
    ...speechPlaybackDebugSnapshot,
  };
}

export function subscribeSpeechPlaybackDebug(
  listener: (snapshot: SpeechPlaybackDebugSnapshot) => void,
) {
  speechPlaybackDebugListeners.add(listener);
  listener(readSpeechPlaybackDebugSnapshot());
  return () => {
    speechPlaybackDebugListeners.delete(listener);
  };
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function inferSpeechServiceConnectionRoute(url: string | null | undefined): SpeechServiceConnectionRoute {
  if (!url) {
    return "unknown";
  }
  try {
    const parsed = new URL(url);
    return isLoopbackHostname(parsed.hostname) ? "local" : "tunnel";
  } catch {
    return "unknown";
  }
}

function formatSpeechServiceHostLabel(url: string | null | undefined) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.host || url;
  } catch {
    return url;
  }
}

export function describeSpeechServiceConnection(
  status: SpeechDependencyStatus | null,
): SpeechServiceConnectionSummary {
  const health = status?.localService?.health ?? null;
  const route = inferSpeechServiceConnectionRoute(health?.url);
  const hostLabel = formatSpeechServiceHostLabel(health?.url);
  const configured = health?.configured === true;
  const reachable = health?.reachable === true;
  const transcriptionReady = status?.transcription?.ready === true;
  const synthesisReady = status?.synthesis?.ready === true;
  const fullyReady = transcriptionReady && synthesisReady;

  if (!status) {
    return {
      route: "unknown",
      configured: false,
      reachable: false,
      hostLabel: null,
      badgeLabel: "Provider unavailable",
      badgeTone: "warning",
      detail: "No provider-backed speech service is discoverable right now.",
    };
  }

  if (reachable) {
    if (!fullyReady) {
      return {
        route,
        configured: true,
        reachable: true,
        hostLabel,
        badgeLabel: "Provider warming",
        badgeTone: "warning",
        detail:
          health?.detail?.trim() ||
          (route === "tunnel"
            ? `Speech provider is reachable through ${hostLabel ?? "the configured tunnel"}, but transcription or reply playback is still warming up.`
            : "Speech provider is reachable on this machine, but transcription or reply playback is still warming up."),
      };
    }
    return {
      route,
      configured: true,
      reachable: true,
      hostLabel,
      badgeLabel: route === "tunnel" ? "Provider via tunnel" : "Provider reachable",
      badgeTone: "success",
      detail:
        route === "tunnel"
          ? `Speech provider is reachable through ${hostLabel ?? "the configured tunnel"}${fullyReady ? " and ready for transcription and reply playback." : "."}`
          : `Speech provider is reachable on this machine${fullyReady ? " and ready for transcription and reply playback." : "."}`,
    };
  }

  if (configured) {
    return {
      route,
      configured: true,
      reachable: false,
      hostLabel,
      badgeLabel: route === "tunnel" ? "Tunnel offline" : "Provider offline",
      badgeTone: "warning",
      detail:
        health?.detail?.trim() ||
        (route === "tunnel"
          ? `Speech provider tunnel${hostLabel ? ` at ${hostLabel}` : ""} is configured but not reachable yet.`
          : "Speech provider is configured on this machine but not reachable yet."),
    };
  }

  if (fullyReady) {
    return {
      route,
      configured: false,
      reachable: false,
      hostLabel,
      badgeLabel: "Provider ready",
      badgeTone: "neutral",
      detail: "Speech provider dependencies are ready, but the service route has not been confirmed yet.",
    };
  }

  if (status.nextSteps?.length) {
    return {
      route,
      configured: false,
      reachable: false,
      hostLabel,
      badgeLabel: "Provider setup",
      badgeTone: "warning",
      detail: status.nextSteps[0] ?? "Speech provider still needs setup.",
    };
  }

  return {
    route,
    configured: false,
    reachable: false,
    hostLabel,
    badgeLabel: "Provider setup",
    badgeTone: "warning",
    detail: "Speech provider is visible, but host dependencies still need setup.",
  };
}

export function describeSpeechTranscriptionBackendRoute(options: {
  backend: SpeechTranscriptionBackendDescriptor;
  dependencyStatus?: SpeechDependencyStatus | null;
}): SpeechServiceConnectionSummary {
  if (options.backend.kind === "http") {
    return {
      route: "http",
      configured: true,
      reachable: true,
      hostLabel: options.backend.label,
      badgeLabel: "HTTP backend",
      badgeTone: "success",
      detail: options.backend.label
        ? `Hosted speech is using ${options.backend.label}.`
        : "Hosted speech is using the configured HTTP backend.",
    };
  }

  if (options.backend.kind === "provider") {
    return describeSpeechServiceConnection(options.dependencyStatus ?? null);
  }

  const providerSummary = describeSpeechServiceConnection(options.dependencyStatus ?? null);
  if (providerSummary.configured || providerSummary.badgeLabel === "Provider warming") {
    return {
      route: "device",
      configured: false,
      reachable: true,
      hostLabel: null,
      badgeLabel: "Fallback to device",
      badgeTone: "warning",
      detail:
        providerSummary.route === "tunnel"
          ? `Speech provider tunnel${providerSummary.hostLabel ? ` at ${providerSummary.hostLabel}` : ""} is not ready, so voice is falling back to this device.`
          : "Speech provider is not ready, so voice is falling back to this device.",
    };
  }

  return {
    route: "device",
    configured: false,
    reachable: true,
    hostLabel: null,
    badgeLabel: "This device",
    badgeTone: "neutral",
    detail: "Voice capture and playback are staying on this device.",
  };
}

type SpeechVoicesResourceValue = {
  voices?: unknown[];
  defaultVoice?: string | null;
};

function canUseSpeechSynthesis() {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

function resolveSpeechProviderTool(
  provider: LocalProviderSummary | null,
  aliasKey: SpeechProviderToolAliasKey,
  defaultToolName: string,
): ResolvedSpeechProviderTool | null {
  if (!provider) {
    return null;
  }
  const toolAliases = provider.toolAliases as Record<string, string | undefined> | undefined;
  const aliasName = toolAliases?.[aliasKey]?.trim();
  if (aliasName) {
    return {
      provider,
      toolName: aliasName,
    };
  }
  if ((provider.toolIds ?? []).includes(defaultToolName)) {
    return {
      provider,
      toolName: defaultToolName,
    };
  }
  return null;
}

async function getSpeechProviderTool(
  capabilityId: string,
  aliasKey: SpeechProviderToolAliasKey,
  defaultToolName: string,
): Promise<ResolvedSpeechProviderTool | null> {
  try {
    const provider = await getLocalProviderForCapability(capabilityId);
    const resolvedFromCapability = resolveSpeechProviderTool(provider, aliasKey, defaultToolName);
    if (resolvedFromCapability) {
      return resolvedFromCapability;
    }
  } catch {
    // Fall back to the canonical speech provider summary below.
  }

  try {
    const provider = await getSpeechProviderSummary();
    return resolveSpeechProviderTool(provider, aliasKey, defaultToolName);
  } catch {
    return null;
  }
}

async function getSpeechProviderSummary() {
  try {
    return await getLocalProviderSummary(SPEECH_PROVIDER_ID);
  } catch {
    return null;
  }
}

function normalizeVoiceId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSpeechVoiceEntry(
  entry: unknown,
  source: "provider" | "browser",
  defaultVoiceId: string | null,
): SpeechVoiceOption | null {
  if (typeof entry === "string") {
    const id = normalizeVoiceId(entry);
    if (!id) {
      return null;
    }
    return {
      id,
      label: id,
      language: null,
      source,
      isDefault: defaultVoiceId === id,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const id =
    normalizeVoiceId(record.id) ??
    normalizeVoiceId(record.voiceId) ??
    normalizeVoiceId(record.name) ??
    normalizeVoiceId(record.voiceURI);
  if (!id) {
    return null;
  }
  const label =
    normalizeVoiceId(record.label) ??
    normalizeVoiceId(record.title) ??
    normalizeVoiceId(record.name) ??
    id;
  const language =
    normalizeVoiceId(record.language) ??
    normalizeVoiceId(record.lang) ??
    normalizeVoiceId(record.locale);

  return {
    id,
    label,
    language,
    source,
    isDefault: defaultVoiceId === id || normalizeVoiceId(record.defaultVoice) === id || record.default === true,
  };
}

function dedupeSpeechVoices(voices: SpeechVoiceOption[]) {
  const seen = new Set<string>();
  return voices.filter((voice) => {
    const key = `${voice.source}:${voice.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function readBrowserSpeechVoices(): SpeechVoiceOption[] {
  if (!canUseSpeechSynthesis()) {
    return [];
  }
  const browserVoices = window.speechSynthesis.getVoices();
  const defaultVoiceId =
    browserVoices.find((voice) => voice.default)?.voiceURI ??
    browserVoices.find((voice) => voice.default)?.name ??
    null;
  return dedupeSpeechVoices(
    browserVoices
      .map((voice) =>
        normalizeSpeechVoiceEntry(
          {
            id: voice.voiceURI || voice.name,
            name: voice.name,
            label: `${voice.name}${voice.lang ? ` (${voice.lang})` : ""}`,
            language: voice.lang || null,
            default: voice.default,
          },
          "browser",
          defaultVoiceId,
        ),
      )
      .filter((voice): voice is SpeechVoiceOption => Boolean(voice)),
  );
}

function normalizeSpeechSynthesisValue(value: unknown): {
  audioUrl?: string;
  audioDataUrl?: string;
  mimeType?: string;
} | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const audioUrl =
    typeof record.audioUrl === "string"
      ? record.audioUrl
      : typeof record.url === "string"
        ? record.url
        : undefined;
  const audioDataUrl =
    typeof record.audioDataUrl === "string"
      ? record.audioDataUrl
      : typeof record.audio_data_url === "string"
        ? record.audio_data_url
        : typeof record.audio_base64 === "string"
          ? `data:${typeof record.mimeType === "string" ? record.mimeType : "audio/mpeg"};base64,${record.audio_base64}`
          : undefined;
  const mimeType =
    typeof record.mimeType === "string"
      ? record.mimeType
      : typeof record.mime_type === "string"
        ? record.mime_type
        : undefined;
  if (!audioUrl && !audioDataUrl) {
    return null;
  }
  return {
    audioUrl,
    audioDataUrl,
    mimeType,
  };
}

const BROWSER_AUDIO_PLAYBACK_TIMEOUT_MS = 10_000;
const BROWSER_AUDIO_COMPLETION_TIMEOUT_MS = 60_000;

function describeAudioPlaybackSourceKind(url: string) {
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith("data:")) {
    return "data_url";
  }
  if (trimmed.startsWith("blob:")) {
    return "blob_url";
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return "remote_url";
  }
  return "local_url";
}

async function playAudioUrl(url: string): Promise<boolean> {
  const blobUrl = url.startsWith("blob:");
  const sourceKind = describeAudioPlaybackSourceKind(url);
  setSpeechPlaybackDebugSnapshot({
    stage: "audio_start",
    detail: sourceKind,
    sourceKind,
  });
  if (!blobUrl) {
    setSpeechPlaybackDebugSnapshot({
      stage: "audio_native_start",
      detail: sourceKind,
      sourceKind,
      via: "native",
    });
    const playedNatively = await playNativeHostAudio({
      audioUrl: url,
      audioDataUrl: url.startsWith("data:") ? url : undefined,
    });
    if (playedNatively) {
      setSpeechPlaybackDebugSnapshot({
        stage: "audio_complete",
        detail: sourceKind,
        sourceKind,
        via: "native",
      });
      return true;
    }
    setSpeechPlaybackDebugSnapshot({
      stage: "audio_native_fallback",
      detail: sourceKind,
      sourceKind,
      via: "native",
    });
  }
  if (typeof Audio === "undefined") {
    setSpeechPlaybackDebugSnapshot({
      stage: "audio_unavailable",
      detail: "Audio constructor is unavailable.",
      sourceKind,
      via: "browser",
    });
    return false;
  }
  const audio = new Audio(url);
  audio.preload = "auto";
  try {
    setSpeechPlaybackDebugSnapshot({
      stage: "audio_browser_start",
      detail: sourceKind,
      sourceKind,
      via: "browser",
    });
    const playback = audio.play();
    if (playback && typeof playback.then === "function") {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          playback,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`Browser audio playback timed out after ${BROWSER_AUDIO_PLAYBACK_TIMEOUT_MS}ms.`));
            }, BROWSER_AUDIO_PLAYBACK_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }
    setSpeechPlaybackDebugSnapshot({
      stage: "audio_browser_playing",
      detail: sourceKind,
      sourceKind,
      via: "browser",
    });
    if (!audio.ended) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(
            new Error(
              `Browser audio completion timed out after ${BROWSER_AUDIO_COMPLETION_TIMEOUT_MS}ms.`,
            ),
          );
        }, BROWSER_AUDIO_COMPLETION_TIMEOUT_MS);

        const handleEnded = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        };

        const handleError = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error("Browser audio playback failed before completion."));
        };

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          audio.removeEventListener("ended", handleEnded);
          audio.removeEventListener("error", handleError);
        };

        audio.addEventListener("ended", handleEnded, { once: true });
        audio.addEventListener("error", handleError, { once: true });
      });
    }
    setSpeechPlaybackDebugSnapshot({
      stage: "audio_complete",
      detail: sourceKind,
      sourceKind,
      via: "browser",
    });
    return true;
  } catch (error) {
    setSpeechPlaybackDebugSnapshot({
      stage: "audio_browser_error",
      detail: error instanceof Error ? error.message : String(error),
      sourceKind,
      via: "browser",
    });
    return false;
  } finally {
    if (blobUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(url);
    }
  }
}

async function speakWithProvider(options: {
  text: string;
  voice?: string | null;
  language?: string | null;
  rate?: number;
  pitch?: number;
  volume?: number;
}) {
  setSpeechPlaybackDebugSnapshot({
    stage: "provider_start",
    detail: null,
    sourceKind: null,
    via: "provider",
  });
  const providerTool = await getSpeechProviderTool(
    SPEECH_SYNTHESIS_CAPABILITY_ID,
    "synthesizeSpeech",
    SPEECH_SYNTHESIZE_SPEECH_TOOL_ID,
  );

  if (!providerTool) {
    setSpeechPlaybackDebugSnapshot({
      stage: "provider_unavailable",
      detail: "No speech provider tool is available.",
      sourceKind: null,
      via: "provider",
    });
    return null;
  }

  const result = await callLocalProviderTool<unknown>(providerTool.provider.id, providerTool.toolName, {
    text: options.text,
    voice: options.voice ?? undefined,
    language: options.language ?? undefined,
    rate: options.rate,
    pitch: options.pitch,
    volume: options.volume,
  });
  const normalized = normalizeSpeechSynthesisValue(result.value);
  if (normalized?.audioDataUrl) {
    setSpeechPlaybackDebugSnapshot({
      stage: "provider_result",
      detail: "data_url",
      sourceKind: "data_url",
      via: "provider",
    });
    const played = await playAudioUrl(normalized.audioDataUrl);
    if (!played) {
      return null;
    }
    return {
      spoken: true,
      backend: "provider" as const,
      label: providerTool.provider.title || providerTool.provider.id,
    };
  }
  if (normalized?.audioUrl) {
    setSpeechPlaybackDebugSnapshot({
      stage: "provider_result",
      detail: describeAudioPlaybackSourceKind(normalized.audioUrl),
      sourceKind: describeAudioPlaybackSourceKind(normalized.audioUrl),
      via: "provider",
    });
    const played = await playAudioUrl(normalized.audioUrl);
    if (!played) {
      return null;
    }
    return {
      spoken: true,
      backend: "provider" as const,
      label: providerTool.provider.title || providerTool.provider.id,
    };
  }
  setSpeechPlaybackDebugSnapshot({
    stage: "provider_missing_audio",
    detail: "Provider synthesis did not return audio.",
    sourceKind: null,
    via: "provider",
  });
  return null;
}

function speakWithBrowser(options: {
  text: string;
  voice?: string | null;
  language?: string | null;
  rate?: number;
  pitch?: number;
  volume?: number;
}) {
  if (!canUseSpeechSynthesis()) {
    setSpeechPlaybackDebugSnapshot({
      stage: "browser_unavailable",
      detail: "SpeechSynthesis is unavailable.",
      sourceKind: null,
      via: "browser",
    });
    return null;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(options.text);
  if (typeof options.rate === "number") {
    utterance.rate = options.rate;
  }
  if (typeof options.pitch === "number") {
    utterance.pitch = options.pitch;
  }
  if (typeof options.volume === "number") {
    utterance.volume = options.volume;
  }
  if (options.language) {
    utterance.lang = options.language;
  }
  if (options.voice) {
    const matchingVoice = window.speechSynthesis
      .getVoices()
      .find((candidate) => candidate.name === options.voice || candidate.voiceURI === options.voice);
    if (matchingVoice) {
      utterance.voice = matchingVoice;
    }
  }
  window.speechSynthesis.speak(utterance);
  setSpeechPlaybackDebugSnapshot({
    stage: "browser_tts_complete",
    detail: normalizeVoiceId(options.voice) ?? normalizeVoiceId(options.language) ?? "device_tts",
    sourceKind: null,
    via: "browser",
  });
  return {
    spoken: true,
    backend: "browser" as const,
    label: "This device",
  };
}

export async function resolveSpeechTranscriptionBackend(options?: {
  projectId?: string | null;
  accessToken?: string | null;
}): Promise<SpeechTranscriptionBackendDescriptor> {
  return resolveSpeechTranscriptionBackendForProject(options);
}

type SpeechRouteCapability = "transcription" | "synthesis";

function isSpeechCapabilityReady(payload: unknown, capability: SpeechRouteCapability) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const branch = record[capability];
  if (!branch || typeof branch !== "object") {
    return null;
  }
  return (branch as { ready?: unknown }).ready === true;
}

async function probeRuntimeSpeechRoute(
  route: SpeechRoute,
  capability: SpeechRouteCapability,
  options?: {
    projectId?: string | null;
    accessToken?: string | null;
  },
) {
  const healthUrl = buildSpeechRouteHealthUrl(route);
  if (!healthUrl) {
    return false;
  }

  const proxiedRequest = await resolveControllerSpeechProxyRequest({
    projectId: options?.projectId ?? null,
    baseUrl: healthUrl,
    accessToken: options?.accessToken ?? null,
    upstreamAuthToken: route.authToken,
  });

  const canUseNativeBridge =
    !proxiedRequest &&
    nativeSpeechBridgeAvailable() &&
    shouldUseNativeSpeechBridgeForUrl(route.baseUrl);

  if (canUseNativeBridge) {
    try {
      const result = await nativeSpeechBridgeHealth({
        url: healthUrl,
        authToken: route.authToken,
      });
      if (result.statusCode === null || result.statusCode < 200 || result.statusCode >= 300) {
        return false;
      }
      const ready = isSpeechCapabilityReady(result.payload, capability);
      return ready ?? true;
    } catch {
      return false;
    }
  }

  try {
    const headers = new Headers(proxiedRequest?.headers);
    headers.set("cache-control", "no-store");
    if (route.authToken && !proxiedRequest) {
      headers.set("Authorization", `Bearer ${route.authToken}`);
    }
    const response = await fetch(proxiedRequest?.baseUrl ?? healthUrl, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return true;
    }
    const ready = isSpeechCapabilityReady(await response.json().catch(() => null), capability);
    return ready ?? true;
  } catch {
    return false;
  }
}

async function resolveProjectScopedSpeechRoute(options: {
  projectId?: string | null;
  accessToken?: string | null;
  capability: SpeechRouteCapability;
}): Promise<{
  route: SpeechRoute | null;
  hasPublishedRoutes: boolean;
}> {
  const projectRoutes = await readProjectSpeechRoutes(options.projectId ?? null, options.accessToken ?? null);
  const discoveredRoutes = await readDiscoveredDesktopLanSpeechRoutes(projectRoutes);
  const publishedRoutes = [...discoveredRoutes, ...projectRoutes];
  const reachablePublishedRoute = await selectReachableSpeechRoute(publishedRoutes, {
    fallbackToPreferred: false,
    probeImpl: (route) =>
      probeRuntimeSpeechRoute(route, options.capability, {
        projectId: options.projectId ?? null,
        accessToken: options.accessToken ?? null,
      }),
  });
  if (reachablePublishedRoute) {
    return {
      route: reachablePublishedRoute,
      hasPublishedRoutes: publishedRoutes.length > 0,
    };
  }

  const preferredPublishedRoute = selectPreferredSpeechRoute(publishedRoutes);
  if (preferredPublishedRoute && describeSpeechRouteTransport(preferredPublishedRoute) !== "desktop_lan") {
    return {
      route: preferredPublishedRoute,
      hasPublishedRoutes: true,
    };
  }

  return {
    route: publishedRoutes.length > 0 ? null : createEnvSpeechRoute(import.meta.env),
    hasPublishedRoutes: publishedRoutes.length > 0,
  };
}

async function resolveProjectRuntimeTranscriptionConfig(options?: {
  projectId?: string | null;
  accessToken?: string | null;
}): Promise<RuntimeTranscriptionBackendConfig | null> {
  const resolvedRoute = await resolveProjectScopedSpeechRoute({
    projectId: options?.projectId ?? null,
    accessToken: options?.accessToken ?? null,
    capability: "transcription",
  });
  if (resolvedRoute.route) {
    return getRuntimeTranscriptionBackendConfig(
      import.meta.env,
      toSpeechRouteOverride(resolvedRoute.route),
    );
  }
  return resolvedRoute.hasPublishedRoutes
    ? null
    : getRuntimeTranscriptionBackendConfig(import.meta.env);
}

export async function resolveProjectRuntimeSpeechSynthesisConfig(options?: {
  projectId?: string | null;
  accessToken?: string | null;
}): Promise<RuntimeSpeechSynthesisBackendConfig | null> {
  const resolvedRoute = await resolveProjectScopedSpeechRoute({
    projectId: options?.projectId ?? null,
    accessToken: options?.accessToken ?? null,
    capability: "synthesis",
  });
  if (resolvedRoute.route) {
    return getRuntimeSpeechSynthesisBackendConfig(
      import.meta.env,
      toSpeechRouteOverride(resolvedRoute.route),
    );
  }
  return resolvedRoute.hasPublishedRoutes
    ? null
    : getRuntimeSpeechSynthesisBackendConfig(import.meta.env);
}

export async function resolveSpeechTranscriptionBackendForProject(options?: {
  projectId?: string | null;
  accessToken?: string | null;
}): Promise<SpeechTranscriptionBackendDescriptor> {
  const providerTool = await getSpeechProviderTool(
    SPEECH_TRANSCRIPTION_CAPABILITY_ID,
    "transcribeAudio",
    SPEECH_TRANSCRIBE_AUDIO_TOOL_ID,
  );
  if (providerTool) {
    return {
      kind: "provider",
      label: providerTool.provider.title || providerTool.provider.id,
      providerId: providerTool.provider.id,
    };
  }

  const config = await resolveProjectRuntimeTranscriptionConfig(options);
  if (config) {
    return {
      kind: "http",
      label: getRuntimeTranscriptionBackendLabel(config),
      providerId: null,
    };
  }

  return {
    kind: "none",
    label: null,
    providerId: null,
  };
}

export async function readSpeechDependencyStatus(): Promise<{
  provider: LocalProviderSummary | null;
  value: SpeechDependencyStatus | null;
}> {
  const provider = await getSpeechProviderSummary();
  if (!provider) {
    return {
      provider: null,
      value: null,
    };
  }

  const uri =
    (provider.resourceAliases as Record<string, string | undefined> | undefined)?.hostDependencyStatus?.trim() ||
    SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI;
  try {
    const result = await readLocalProviderResource<SpeechDependencyStatus>(provider.id, uri);
    return {
      provider,
      value: result.value ?? null,
    };
  } catch {
    return {
      provider,
      value: null,
    };
  }
}

export async function readSpeechVoiceOptions(): Promise<{
  provider: LocalProviderSummary | null;
  providerVoices: SpeechVoiceOption[];
  browserVoices: SpeechVoiceOption[];
  providerDefaultVoiceId: string | null;
}> {
  const provider = await getSpeechProviderSummary();
  let providerVoices: SpeechVoiceOption[] = [];
  let providerDefaultVoiceId: string | null = null;

  if (provider) {
    const uri =
      (provider.resourceAliases as Record<string, string | undefined> | undefined)?.speechVoices?.trim() ||
      SPEECH_VOICES_RESOURCE_URI;
    try {
      const result = await readLocalProviderResource<SpeechVoicesResourceValue>(provider.id, uri);
      const value = result.value;
      providerDefaultVoiceId = normalizeVoiceId(value?.defaultVoice);
      providerVoices = dedupeSpeechVoices(
        (Array.isArray(value?.voices) ? value.voices : [])
          .map((voice) => normalizeSpeechVoiceEntry(voice, "provider", providerDefaultVoiceId))
          .filter((voice): voice is SpeechVoiceOption => Boolean(voice)),
      );
    } catch {
      providerVoices = [];
    }
  }

  return {
    provider,
    providerVoices,
    browserVoices: readBrowserSpeechVoices(),
    providerDefaultVoiceId,
  };
}

export async function bootstrapSpeechDependencies(options?: {
  action?: "check" | "install_transcription" | "remove_transcription";
  dryRun?: boolean;
}): Promise<{
  provider: LocalProviderSummary | null;
  result: SpeechBootstrapResult | null;
}> {
  const provider = await getSpeechProviderSummary();
  if (!provider) {
    return {
      provider: null,
      result: null,
    };
  }

  const toolName =
    resolveSpeechProviderTool(
      provider,
      "bootstrapHostDependencies",
      SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID,
    )?.toolName ?? SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID;

  try {
    const result = await callLocalProviderTool<SpeechBootstrapResult>(provider.id, toolName, {
      action: options?.action ?? "check",
      dryRun: options?.dryRun === true,
    });
    return {
      provider,
      result: result.value ?? null,
    };
  } catch {
    return {
      provider,
      result: null,
    };
  }
}

export async function transcribeAudioWithSpeechService(options: {
  audioBlob?: Blob;
  artifact?: AudioArtifact;
  fileName?: string;
  signal?: AbortSignal;
  projectId?: string | null;
  accessToken?: string | null;
}): Promise<{
  transcript: string;
  backend: SpeechTranscriptionBackendDescriptor;
}> {
  const artifact =
    options.artifact ??
    (options.audioBlob
      ? createAudioArtifactFromBlob(options.audioBlob, {
          fileName: options.fileName,
          baseName: "voice-capture",
        })
      : null);
  if (!artifact) {
    throw new Error("Speech transcription requires an audio artifact.");
  }
  const providerTool = await getSpeechProviderTool(
    SPEECH_TRANSCRIPTION_CAPABILITY_ID,
    "transcribeAudio",
    SPEECH_TRANSCRIBE_AUDIO_TOOL_ID,
  );

  if (providerTool) {
    const audioDataUrl = await encodeAudioArtifactDataUrl(artifact);
    const result = await callLocalProviderTool<unknown>(providerTool.provider.id, providerTool.toolName, {
      audioDataUrl,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType || undefined,
    });
    return {
      transcript: extractRuntimeTranscriptionText(result.value),
      backend: {
        kind: "provider",
        label: providerTool.provider.title || providerTool.provider.id,
        providerId: providerTool.provider.id,
      },
    };
  }

  const config = await resolveProjectRuntimeTranscriptionConfig({
    projectId: options.projectId ?? null,
    accessToken: options.accessToken ?? null,
  });
  const transcript = await transcribeRuntimeAudio({
    artifact,
    signal: options.signal,
    projectId: options.projectId ?? null,
    accessToken: options.accessToken ?? null,
    config,
  });
  return {
    transcript,
    backend: {
      kind: "http",
      label: getRuntimeTranscriptionBackendLabel(config),
      providerId: null,
    },
  };
}

export async function speakTextWithSpeechService(options: {
  text: string;
  voice?: string | null;
  language?: string | null;
  rate?: number;
  pitch?: number;
  volume?: number;
  backendPreference?: SpeechSynthesisBackendPreference;
  projectId?: string | null;
  accessToken?: string | null;
}): Promise<{
  spoken: boolean;
  backend: "provider" | "http" | "browser" | "none";
  label: string | null;
}> {
  const text = options.text.trim();
  setSpeechPlaybackDebugSnapshot({
    ...DEFAULT_SPEECH_PLAYBACK_DEBUG_SNAPSHOT,
    stage: text ? "request_start" : "request_empty",
    updatedAt: new Date().toISOString(),
  });
  if (!text) {
    return {
      spoken: false,
      backend: "none",
      label: null,
    };
  }

  const backendPreference = options.backendPreference ?? "auto";

  const tryProvider = () =>
    speakWithProvider({
      text,
      voice: options.voice,
      language: options.language,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
    });
  const tryHttp = () =>
    speakWithRuntimeBackend({
      text,
      voice: options.voice,
      language: options.language,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
      projectId: options.projectId,
      accessToken: options.accessToken,
    });
  const tryBrowser = () =>
    speakWithBrowser({
      text,
      voice: options.voice,
      language: options.language,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
    });

  if (backendPreference === "browser") {
    return (
      tryBrowser() ??
      (await tryHttp()) ??
      (await tryProvider()) ?? {
        spoken: false,
        backend: "none",
        label: null,
      }
    );
  }

  if (backendPreference === "provider") {
    return (
      (await tryProvider()) ??
      (await tryHttp()) ??
      tryBrowser() ?? {
        spoken: false,
        backend: "none",
        label: null,
      }
    );
  }

  return (
    (await tryProvider()) ??
    (await tryHttp()) ??
    tryBrowser() ?? {
      spoken: false,
      backend: "none",
      label: null,
    }
  );
}

async function speakWithRuntimeBackend(options: {
  text: string;
  voice?: string | null;
  language?: string | null;
  rate?: number;
  pitch?: number;
  volume?: number;
  projectId?: string | null;
  accessToken?: string | null;
}) {
  setSpeechPlaybackDebugSnapshot({
    stage: "http_start",
    detail: null,
    sourceKind: null,
    via: "http",
  });
  const config = await resolveProjectRuntimeSpeechSynthesisConfig({
    projectId: options.projectId ?? null,
    accessToken: options.accessToken ?? null,
  });
  if (!config) {
    setSpeechPlaybackDebugSnapshot({
      stage: "http_unavailable",
      detail: "No hosted speech synthesis config is available.",
      sourceKind: null,
      via: "http",
    });
    return null;
  }

  setSpeechPlaybackDebugSnapshot({
    stage: "http_request",
    detail: getRuntimeSpeechSynthesisBackendLabel(config),
    sourceKind: null,
    via: "http",
  });
  const result = await synthesizeRuntimeSpeech({
    text: options.text,
    voice: options.voice,
    language: options.language,
    rate: options.rate,
    pitch: options.pitch,
    volume: options.volume,
    format: "wav",
    projectId: options.projectId ?? null,
    accessToken: options.accessToken ?? null,
    config,
    onDebugEvent: (event) => {
      setSpeechPlaybackDebugSnapshot({
        stage: `http_${event.stage}`,
        detail: event.detail ?? getRuntimeSpeechSynthesisBackendLabel(config),
        sourceKind: event.sourceKind ?? null,
        via: "http",
      });
    },
  });
  const normalized = normalizeSpeechSynthesisValue(result);
  if (normalized?.audioDataUrl) {
    setSpeechPlaybackDebugSnapshot({
      stage: "http_result",
      detail: "data_url",
      sourceKind: "data_url",
      via: "http",
    });
    const played = await playAudioUrl(normalized.audioDataUrl);
    if (!played) {
      return null;
    }
    return {
      spoken: true,
      backend: "http" as const,
      label: getRuntimeSpeechSynthesisBackendLabel(config),
    };
  }
  if (normalized?.audioUrl) {
    setSpeechPlaybackDebugSnapshot({
      stage: "http_result",
      detail: describeAudioPlaybackSourceKind(normalized.audioUrl),
      sourceKind: describeAudioPlaybackSourceKind(normalized.audioUrl),
      via: "http",
    });
    const played = await playAudioUrl(normalized.audioUrl);
    if (!played) {
      return null;
    }
    return {
      spoken: true,
      backend: "http" as const,
      label: getRuntimeSpeechSynthesisBackendLabel(config),
    };
  }
  setSpeechPlaybackDebugSnapshot({
    stage: "http_missing_audio",
    detail: "Hosted speech synthesis did not return audio.",
    sourceKind: null,
    via: "http",
  });
  return null;
}
