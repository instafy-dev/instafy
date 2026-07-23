import { createProviderSummary } from "@instafy/provider-contract";
import {
  SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID,
  SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI,
  SPEECH_PROVIDER_DESCRIPTION,
  SPEECH_PROVIDER_FAMILY,
  SPEECH_PROVIDER_ID,
  SPEECH_PROVIDER_KIND,
  SPEECH_PROVIDER_TITLE,
  SPEECH_PROVIDER_TYPE,
  SPEECH_STATUS_RESOURCE_URI,
  SPEECH_SYNTHESIS_CAPABILITY_ID,
  SPEECH_SYNTHESIZE_SPEECH_TOOL_ID,
  SPEECH_TRANSCRIBE_AUDIO_TOOL_ID,
  SPEECH_TRANSCRIPTION_CAPABILITY_ID,
  SPEECH_VOICES_RESOURCE_URI,
} from "@instafy/provider-contract/builtins";
import {
  getSpeechBackendDependencyStatus,
  runSpeechBackendBootstrap,
} from "../speech-backend-bootstrap.mjs";
import { resolveLocalSpeechServiceConfig } from "../shared/speech-host-config.mjs";
import {
  encodeAudioDataUrl,
  normalizeOptionalString,
  parseAudioDataUrl,
} from "../shared/audio-artifact.mjs";

function normalizeString(value) {
  return normalizeOptionalString(value);
}

function normalizeBoolean(value) {
  return value === true;
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

function parseOptionalJsonArray(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return [];
  }
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractTranscriptionText(payload) {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed) {
      return trimmed;
    }
    throw new Error("Speech transcription backend returned an empty response.");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Speech transcription backend returned an unsupported response.");
  }

  for (const key of ["text", "transcript", "output_text"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  if (payload.result && typeof payload.result === "object" && typeof payload.result.text === "string") {
    const trimmed = payload.result.text.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  if (Array.isArray(payload.segments)) {
    const transcript = payload.segments
      .map((segment) =>
        segment && typeof segment === "object" && typeof segment.text === "string"
          ? segment.text.trim()
          : "",
      )
      .filter(Boolean)
      .join(" ")
      .trim();
    if (transcript) {
      return transcript;
    }
  }

  throw new Error("Speech transcription backend returned an unsupported response.");
}

function resolveConfiguredBackendUrl(value) {
  const normalized = normalizeString(value);
  return normalized ? trimTrailingSlash(normalized) : null;
}

function resolveSpeechTranscriptionBackendUrl() {
  const localSpeechService = resolveLocalSpeechServiceConfig(process.env);
  return (
    resolveConfiguredBackendUrl(process.env.INSTAFY_SPEECH_TRANSCRIPTION_URL) ??
    (process.env.INSTAFY_SPEECH_AUTODETECT_LOCAL_SERVICE === "false"
      ? null
      : localSpeechService.transcriptionUrl)
  );
}

function resolveSpeechSynthesisBackendUrl() {
  const localSpeechService = resolveLocalSpeechServiceConfig(process.env);
  return (
    resolveConfiguredBackendUrl(process.env.INSTAFY_SPEECH_SYNTHESIS_URL) ??
    (process.env.INSTAFY_SPEECH_AUTODETECT_LOCAL_SERVICE === "false"
      ? null
      : localSpeechService.synthesisUrl)
  );
}

function buildSpeechStatusValue() {
  const localSpeechService = resolveLocalSpeechServiceConfig(process.env);
  const configuredTranscriptionUrl = resolveConfiguredBackendUrl(process.env.INSTAFY_SPEECH_TRANSCRIPTION_URL);
  const configuredSynthesisUrl = resolveConfiguredBackendUrl(process.env.INSTAFY_SPEECH_SYNTHESIS_URL);
  const transcriptionUrl = resolveSpeechTranscriptionBackendUrl();
  const synthesisUrl = resolveSpeechSynthesisBackendUrl();
  const voices = parseOptionalJsonArray(process.env.INSTAFY_SPEECH_VOICES_JSON);

  return {
    supported: Boolean(configuredTranscriptionUrl || configuredSynthesisUrl),
    provider: "local_provider_host",
    backend: SPEECH_PROVIDER_TYPE,
    hostMode: localSpeechService.hostMode,
    localService: {
      baseUrl: localSpeechService.baseUrl,
      healthUrl: localSpeechService.healthUrl,
    },
    transcription: {
      configured: Boolean(configuredTranscriptionUrl),
      url: configuredTranscriptionUrl,
      resolvedUrl: transcriptionUrl,
      model: normalizeString(process.env.INSTAFY_SPEECH_TRANSCRIPTION_MODEL),
      language: normalizeString(process.env.INSTAFY_SPEECH_TRANSCRIPTION_LANGUAGE),
    },
    synthesis: {
      configured: Boolean(configuredSynthesisUrl),
      url: configuredSynthesisUrl,
      resolvedUrl: synthesisUrl,
      defaultVoice: normalizeString(process.env.INSTAFY_SPEECH_SYNTHESIS_VOICE),
      voicesConfigured: voices.length,
    },
  };
}

function resolveVoicesEndpointUrl() {
  const configuredVoicesUrl = resolveConfiguredBackendUrl(process.env.INSTAFY_SPEECH_VOICES_URL);
  if (configuredVoicesUrl) {
    return configuredVoicesUrl;
  }
  const synthesisUrl = resolveSpeechSynthesisBackendUrl();
  if (!synthesisUrl) {
    return null;
  }
  try {
    const url = new URL(synthesisUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/synthesize")) {
      url.pathname = `${pathname.slice(0, -"synthesize".length)}voices`;
    } else {
      url.pathname = pathname ? `${pathname}/voices` : "/voices";
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function buildSpeechVoicesValue() {
  const configuredVoices = parseOptionalJsonArray(process.env.INSTAFY_SPEECH_VOICES_JSON);
  const defaultVoice = normalizeString(process.env.INSTAFY_SPEECH_SYNTHESIS_VOICE);
  if (configuredVoices.length > 0) {
    return {
      voices: configuredVoices,
      defaultVoice,
      source: "configured",
    };
  }

  const voicesUrl = resolveVoicesEndpointUrl();
  if (!voicesUrl) {
    return {
      voices: [],
      defaultVoice,
      source: "none",
    };
  }

  try {
    const headers = new Headers();
    const authToken = normalizeString(process.env.INSTAFY_SPEECH_SYNTHESIS_TOKEN);
    if (authToken) {
      headers.set("authorization", `Bearer ${authToken}`);
    }
    const response = await fetch(voicesUrl, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      return {
        voices: [],
        defaultVoice,
        source: "none",
      };
    }
    const payload = await response.json();
    return {
      voices: Array.isArray(payload?.voices) ? payload.voices : [],
      defaultVoice: normalizeString(payload?.defaultVoice) ?? defaultVoice,
      source: "runtime",
    };
  } catch {
    return {
      voices: [],
      defaultVoice,
      source: "none",
    };
  }
}

async function buildSummary(overrides = {}) {
  const status = buildSpeechStatusValue();
  const dependencyStatus = await getSpeechBackendDependencyStatus();
  const discoverable = Boolean(status.supported || dependencyStatus.localService.health.reachable);
  return createProviderSummary({
    id: SPEECH_PROVIDER_ID,
    title: SPEECH_PROVIDER_TITLE,
    description: SPEECH_PROVIDER_DESCRIPTION,
    kind: SPEECH_PROVIDER_KIND,
    providerType: SPEECH_PROVIDER_TYPE,
    configured:
      status.supported ||
      dependencyStatus.localService.health.reachable ||
      dependencyStatus.transcription.ready ||
      dependencyStatus.synthesis.ready,
    discoverable,
    rootUri: SPEECH_PROVIDER_FAMILY.rootUri,
    transportProbeSupported: SPEECH_PROVIDER_FAMILY.transportProbeSupported,
    capabilityIds: SPEECH_PROVIDER_FAMILY.capabilityIds,
    toolIds: [
      SPEECH_TRANSCRIBE_AUDIO_TOOL_ID,
      SPEECH_SYNTHESIZE_SPEECH_TOOL_ID,
      SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID,
    ],
    resourceUris: [
      SPEECH_STATUS_RESOURCE_URI,
      SPEECH_VOICES_RESOURCE_URI,
      SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI,
    ],
    toolAliases: SPEECH_PROVIDER_FAMILY.toolAliases,
    resourceAliases: SPEECH_PROVIDER_FAMILY.resourceAliases,
    manifest: SPEECH_PROVIDER_FAMILY.manifest,
    ...overrides,
  });
}

function buildDiscoveryProvider(id, title, description) {
  const status = buildSpeechStatusValue();
  return {
    id,
    title,
    description,
    provider_kind: SPEECH_PROVIDER_KIND,
    provider_type: SPEECH_PROVIDER_TYPE,
    root_uri: SPEECH_PROVIDER_FAMILY.rootUri,
    capability_ids: SPEECH_PROVIDER_FAMILY.capabilityIds,
    transport_probe_supported: SPEECH_PROVIDER_FAMILY.transportProbeSupported,
    tool_surfaces: [
      {
        id: SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID,
        title: "Bootstrap host dependencies",
        description: "Check or install local host dependencies required for self-hosted speech.",
      },
      {
        id: SPEECH_TRANSCRIBE_AUDIO_TOOL_ID,
        title: "Transcribe audio",
        description: "Convert uploaded speech audio into text.",
      },
      {
        id: SPEECH_SYNTHESIZE_SPEECH_TOOL_ID,
        title: "Synthesize speech",
        description: "Convert text into playable speech audio.",
      },
    ],
    resources: [
      {
        uri: SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI,
        title: "Speech host dependency status",
      },
      {
        uri: SPEECH_STATUS_RESOURCE_URI,
        title: "Speech provider status",
      },
      {
        uri: SPEECH_VOICES_RESOURCE_URI,
        title: "Configured speech voices",
      },
    ],
    status,
  };
}

function buildUnavailableToolResult(providerId, name, message) {
  return {
    ok: false,
    statusCode: 503,
    providerId,
    name,
    error: message,
  };
}

async function callConfiguredTranscriptionBackend(args = {}) {
  const url = resolveSpeechTranscriptionBackendUrl();
  if (!url) {
    throw new Error("Speech transcription backend is not configured.");
  }

  const { buffer, mimeType } = parseAudioDataUrl(args.audioDataUrl);
  const fileName = normalizeString(args.fileName) ?? "voice-capture.webm";
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), fileName);

  const model =
    normalizeString(args.model) ?? normalizeString(process.env.INSTAFY_SPEECH_TRANSCRIPTION_MODEL);
  const language =
    normalizeString(args.language) ?? normalizeString(process.env.INSTAFY_SPEECH_TRANSCRIPTION_LANGUAGE);

  if (model) {
    formData.append("model", model);
  }
  if (language) {
    formData.append("language", language);
  }

  const headers = new Headers();
  const authToken = normalizeString(process.env.INSTAFY_SPEECH_TRANSCRIPTION_TOKEN);
  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(
      `Speech transcription failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  return {
    ok: true,
    text: extractTranscriptionText(payload),
    backend: "speech_http",
    url,
  };
}

async function callConfiguredSynthesisBackend(args = {}) {
  const url = resolveSpeechSynthesisBackendUrl();
  if (!url) {
    throw new Error("Speech synthesis backend is not configured.");
  }

  const text = normalizeString(args.text);
  if (!text) {
    throw new Error("Speech synthesis requires text.");
  }

  const body = {
    text,
    voice:
      normalizeString(args.voice) ?? normalizeString(process.env.INSTAFY_SPEECH_SYNTHESIS_VOICE),
    language: normalizeString(args.language) ?? null,
    format: normalizeString(args.format) ?? null,
    rate: typeof args.rate === "number" ? args.rate : null,
    pitch: typeof args.pitch === "number" ? args.pitch : null,
    volume: typeof args.volume === "number" ? args.volume : null,
  };

  const headers = new Headers({
    "content-type": "application/json",
  });
  const authToken = normalizeString(process.env.INSTAFY_SPEECH_SYNTHESIS_TOKEN);
  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(
      `Speech synthesis failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("audio/")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: true,
      audioDataUrl: encodeAudioDataUrl(buffer, contentType),
      mimeType: contentType,
      backend: "speech_http",
      url,
    };
  }

  const payload = contentType.includes("application/json")
    ? await response.json()
    : { text: await response.text() };
  return {
    ok: true,
    ...payload,
    backend: "speech_http",
    url,
  };
}

export function createSpeechProviderRegistration(overrides = {}) {
  const id =
    typeof overrides.id === "string" && overrides.id.trim().length > 0
      ? overrides.id.trim()
      : SPEECH_PROVIDER_ID;
  const title =
    typeof overrides.title === "string" && overrides.title.trim().length > 0
      ? overrides.title.trim()
      : SPEECH_PROVIDER_TITLE;
  const description =
    typeof overrides.description === "string" && overrides.description.trim().length > 0
      ? overrides.description.trim()
      : SPEECH_PROVIDER_DESCRIPTION;

  return {
    id,
    summary: createProviderSummary({
      id,
      title,
      description,
      kind: SPEECH_PROVIDER_KIND,
      providerType: SPEECH_PROVIDER_TYPE,
      capabilityIds: SPEECH_PROVIDER_FAMILY.capabilityIds,
      manifest: SPEECH_PROVIDER_FAMILY.manifest,
    }),
    async getSummary() {
      return buildSummary({ id, title, description });
    },
    async discover() {
      return {
        ok: true,
        statusCode: 200,
        providerId: id,
        provider: buildDiscoveryProvider(id, title, description),
      };
    },
    async readResource(uri) {
      if (uri === SPEECH_STATUS_RESOURCE_URI) {
        return {
          ok: true,
          statusCode: 200,
          providerId: id,
          uri,
          exists: true,
          value: buildSpeechStatusValue(),
        };
      }
      if (uri === SPEECH_VOICES_RESOURCE_URI) {
        return {
          ok: true,
          statusCode: 200,
          providerId: id,
          uri,
          exists: true,
          value: await buildSpeechVoicesValue(),
        };
      }
      if (uri === SPEECH_HOST_DEPENDENCY_STATUS_RESOURCE_URI) {
        return {
          ok: true,
          statusCode: 200,
          providerId: id,
          uri,
          exists: true,
          value: await getSpeechBackendDependencyStatus(),
        };
      }

      return {
        ok: false,
        statusCode: 404,
        providerId: id,
        uri,
        error: `unknown resource uri: ${uri}`,
      };
    },
    async callTool(name, args = {}) {
      if (name === SPEECH_TRANSCRIBE_AUDIO_TOOL_ID) {
        try {
          return {
            ok: true,
            statusCode: 200,
            providerId: id,
            name,
            value: await callConfiguredTranscriptionBackend(args),
          };
        } catch (error) {
          return buildUnavailableToolResult(
            id,
            name,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (name === SPEECH_SYNTHESIZE_SPEECH_TOOL_ID) {
        try {
          return {
            ok: true,
            statusCode: 200,
            providerId: id,
            name,
            value: await callConfiguredSynthesisBackend(args),
          };
        } catch (error) {
          return buildUnavailableToolResult(
            id,
            name,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (name === SPEECH_BOOTSTRAP_HOST_DEPENDENCIES_TOOL_ID) {
        try {
          return {
            ok: true,
            statusCode: 200,
            providerId: id,
            name,
            value: await runSpeechBackendBootstrap({
              action: normalizeString(args.action) ?? "check",
              dryRun: args.dryRun === true,
            }),
          };
        } catch (error) {
          return buildUnavailableToolResult(
            id,
            name,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      return {
        ok: false,
        statusCode: 404,
        providerId: id,
        name,
        error: `unknown tool: ${name}`,
      };
    },
    async getHealthDetails() {
      return {
        ...(await getSpeechBackendDependencyStatus()),
        runtime: buildSpeechStatusValue(),
      };
    },
  };
}

export const SPEECH_PROVIDER_DEFAULT_ENABLED = process.env.INSTAFY_SPEECH_PROVIDER_ENABLED !== "false";
