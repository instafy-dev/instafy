import { normalizeOptionalString } from "./audio-artifact.mjs";

const OPENAI_AUDIO_SPEECH_PATH = "/v1/audio/speech";
const OPENAI_AUDIO_TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";

export function deriveOpenAiAudioPeerUrl(url, fromPathname, toPathname) {
  const normalizedUrl = normalizeOptionalString(url);
  if (!normalizedUrl) {
    return null;
  }

  try {
    const endpoint = new URL(normalizedUrl);
    if (!endpoint.pathname.endsWith(fromPathname)) {
      return null;
    }
    endpoint.pathname = `${endpoint.pathname.slice(0, -fromPathname.length)}${toPathname}`;
    endpoint.hash = "";
    return endpoint.toString();
  } catch {
    return null;
  }
}

export function resolveTranscriptionBackendConfig(env = process.env) {
  const explicitUrl = normalizeOptionalString(env.LOCAL_SPEECH_TRANSCRIPTION_BACKEND_URL);
  if (explicitUrl) {
    return {
      url: explicitUrl,
      authToken: normalizeOptionalString(env.LOCAL_SPEECH_TRANSCRIPTION_BACKEND_TOKEN),
      derivedFromSynthesis: false,
      source: "LOCAL_SPEECH_TRANSCRIPTION_BACKEND_URL",
    };
  }

  const synthesisUrl = normalizeOptionalString(env.LOCAL_SPEECH_TTS_BACKEND_URL);
  const derivedUrl = deriveOpenAiAudioPeerUrl(
    synthesisUrl,
    OPENAI_AUDIO_SPEECH_PATH,
    OPENAI_AUDIO_TRANSCRIPTIONS_PATH,
  );
  return {
    url: derivedUrl,
    authToken:
      normalizeOptionalString(env.LOCAL_SPEECH_TRANSCRIPTION_BACKEND_TOKEN) ??
      normalizeOptionalString(env.LOCAL_SPEECH_TTS_BACKEND_TOKEN),
    derivedFromSynthesis: Boolean(derivedUrl),
    source: derivedUrl ? "LOCAL_SPEECH_TTS_BACKEND_URL" : null,
  };
}

export function isOpenAiAudioSpeechUrl(url) {
  const normalizedUrl = normalizeOptionalString(url);
  if (!normalizedUrl) {
    return false;
  }
  try {
    return new URL(normalizedUrl).pathname.endsWith(OPENAI_AUDIO_SPEECH_PATH);
  } catch {
    return false;
  }
}
