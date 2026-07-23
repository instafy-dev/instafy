function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function fetchSpeechServiceHealth(healthUrl) {
  const response = await fetch(healthUrl, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Speech service health probe failed (${response.status} ${response.statusText}).`);
  }
  const payload = await response.json();
  return payload && typeof payload === "object" ? payload : {};
}

export function getSpeechServiceReadiness(payload, options = {}) {
  const requireTranscription = options.requireTranscription !== false;
  const requireSynthesis = options.requireSynthesis !== false;
  const transcription = payload?.transcription ?? null;
  const synthesis = payload?.synthesis ?? null;
  const transcriptionReady = !requireTranscription || transcription?.ready === true;
  const synthesisReady = !requireSynthesis || synthesis?.ready === true;
  const fullyReady = transcriptionReady && synthesisReady;
  const failureDetail =
    normalizeOptionalString(transcription?.lastError) ??
    normalizeOptionalString(synthesis?.lastError) ??
    normalizeOptionalString(payload?.error) ??
    null;

  return {
    ready: fullyReady,
    transcriptionReady,
    synthesisReady,
    transcriptionStatus: normalizeOptionalString(transcription?.status) ?? "unknown",
    synthesisStatus: normalizeOptionalString(synthesis?.status) ?? "unknown",
    failureDetail,
    payload,
  };
}

export function formatSpeechServiceReadinessMessage(healthUrl, readiness) {
  if (readiness.failureDetail) {
    return `Speech service at ${healthUrl} is not ready: ${readiness.failureDetail}`;
  }
  return `Speech service at ${healthUrl} is not ready yet (transcription=${readiness.transcriptionStatus}, synthesis=${readiness.synthesisStatus}).`;
}

export async function waitForSpeechServiceReady(healthUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const pollMs = Number(options.pollMs || 500);
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "unknown error";

  while (Date.now() < deadline) {
    try {
      const payload = await fetchSpeechServiceHealth(healthUrl);
      const readiness = getSpeechServiceReadiness(payload, options);
      if (readiness.ready) {
        return readiness;
      }
      lastDetail = formatSpeechServiceReadinessMessage(healthUrl, readiness);
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for ${healthUrl}: ${lastDetail}`);
}
