export type HostedVoiceUiTestConfig = {
  text: string;
  fileName: string;
  readyDelayMs: number;
  finalDelayMs: number;
};

const HOSTED_VOICE_TEXT_QUERY_PARAM = "uiTestHostedVoiceText";
const HOSTED_VOICE_FILE_NAME_QUERY_PARAM = "uiTestHostedVoiceFileName";
const HOSTED_VOICE_READY_DELAY_QUERY_PARAM = "uiTestHostedVoiceReadyDelayMs";
const HOSTED_VOICE_FINAL_DELAY_QUERY_PARAM = "uiTestHostedVoiceFinalDelayMs";
const DEFAULT_HOSTED_VOICE_FILE_NAME = "ios-voice-tunnel-smoke.wav";
const DEFAULT_READY_DELAY_MS = 120;
const DEFAULT_FINAL_DELAY_MS = 150;
const MAX_DELAY_MS = 10_000;

function normalizeSearch(search: string) {
  const trimmed = search.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("?") ? trimmed : `?${trimmed}`;
}

function readOptionalTrimmedQueryParam(params: URLSearchParams, key: string) {
  const rawValue = params.get(key);
  if (typeof rawValue !== "string") {
    return null;
  }
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDelayMs(
  params: URLSearchParams,
  key: string,
  fallback: number,
) {
  const rawValue = readOptionalTrimmedQueryParam(params, key);
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 0), MAX_DELAY_MS);
}

export function readHostedVoiceUiTestConfigFromSearch(
  search: string,
): HostedVoiceUiTestConfig | null {
  const normalizedSearch = normalizeSearch(search);
  if (!normalizedSearch) {
    return null;
  }

  const params = new URLSearchParams(normalizedSearch);
  const text = readOptionalTrimmedQueryParam(params, HOSTED_VOICE_TEXT_QUERY_PARAM);
  if (!text) {
    return null;
  }

  return {
    text,
    fileName:
      readOptionalTrimmedQueryParam(params, HOSTED_VOICE_FILE_NAME_QUERY_PARAM) ??
      DEFAULT_HOSTED_VOICE_FILE_NAME,
    readyDelayMs: readDelayMs(
      params,
      HOSTED_VOICE_READY_DELAY_QUERY_PARAM,
      DEFAULT_READY_DELAY_MS,
    ),
    finalDelayMs: readDelayMs(
      params,
      HOSTED_VOICE_FINAL_DELAY_QUERY_PARAM,
      DEFAULT_FINAL_DELAY_MS,
    ),
  };
}
