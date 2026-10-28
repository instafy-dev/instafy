type ProxyErrorRecord = Record<string, unknown>;

export interface ProxyUpstreamErrorInfo {
  proxyStatus: number;
  proxyStatusText: string | null;
  upstreamStatus: number | null;
  upstreamType: string | null;
  upstreamCode: string | null;
  upstreamMessage: string | null;
  upstreamEndpoint: string | null;
  resetsInSeconds: number | null;
  planType: string | null;
}

export interface ProxyUpstreamErrorGuidance {
  summary: string;
  detail: string | null;
  actionLabel: string | null;
  actionKind: "open_ai_settings" | null;
}

// What a person reads for a proxy failure. Plain words only: never "upstream",
// "provider" or "credentials", which name the plumbing, not what happened.
const SIGN_IN_SUMMARY = "Your AI connection needs you to sign in again.";
const QUOTA_SUMMARY = "Your AI account has reached its limit.";
const REFUSED_SUMMARY = "Your AI connection couldn't answer this message.";
const BUSY_SUMMARY = "Your AI connection is busy right now.";

// Summaries this module wrote before. A message that is exactly one of these,
// or of the summaries above, gets the same guidance back (a summary shown
// again, as in an expanded step); other prose never does.
const LEGACY_SIGN_IN_SUMMARIES = [
  "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
  "AI credentials need reconnecting. Reconnect AI credentials, then retry the message.",
];

type ProxyEnvelope = { status: number; code: string; sentence: string };

// The proxy's safe envelopes (openai-proxy-server/src/upstream_error.rs) for
// a sign-in it could not use and for a spent quota. A JSON diagnostic carries
// the code. Codex's plain diagnostic quotes only the envelope's message
// ("unexpected status 424 Failed Dependency: Upstream credentials could not
// be refreshed., url: …"), so the proxy's fixed sentence stands in for it.
const SIGN_IN_PROXY_ENVELOPES: readonly ProxyEnvelope[] = [
  {
    status: 401,
    code: "upstream_authentication_error",
    sentence: "the upstream provider rejected authentication",
  },
  {
    status: 424,
    code: "upstream_credential_refresh_failed",
    sentence: "upstream credentials could not be refreshed",
  },
];
const QUOTA_PROXY_ENVELOPE: ProxyEnvelope = {
  status: 402,
  code: "upstream_insufficient_quota",
  sentence: "the upstream provider has no available quota",
};

function asRecord(value: unknown): ProxyErrorRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as ProxyErrorRecord;
}

function extractProxyDiagnosticText(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as unknown;
      const root = asRecord(parsed);
      const error = asRecord(root?.error);
      const message = typeof error?.message === "string" ? error.message.trim() : "";
      if (/unexpected status\s+\d{3}/i.test(message)) {
        return message;
      }
    } catch {
      // A plain diagnostic can contain a JSON body followed by a request URL.
    }
  }

  return /unexpected status\s+\d{3}/i.test(trimmed) ? trimmed : null;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      continue;
    }
  }

  return null;
}

function parseNestedProviderError(
  diagnosticText: string,
): Pick<
  ProxyUpstreamErrorInfo,
  "upstreamStatus" | "upstreamType" | "upstreamCode" | "upstreamMessage" | "resetsInSeconds" | "planType"
> {
  const upstreamStatusMatch =
    diagnosticText.match(/backend responded with\s+(\d{3})/i) ??
    diagnosticText.match(/controller credentials returned\s+(\d{3})/i);
  const upstreamStatus = upstreamStatusMatch ? Number(upstreamStatusMatch[1]) : null;

  const jsonSlice = extractFirstJsonObject(diagnosticText);
  if (!jsonSlice) {
    return {
      upstreamStatus,
      upstreamType: null,
      upstreamCode: null,
      upstreamMessage: null,
      resetsInSeconds: null,
      planType: null,
    };
  }

  try {
    const parsed = JSON.parse(jsonSlice) as unknown;
    const root = asRecord(parsed);
    const nestedError = asRecord(root?.error);
    const nestedStatus =
      typeof root?.status === "number" && Number.isFinite(root.status) ? root.status : null;
    const rootCode = typeof root?.code === "string" ? root.code : null;
    const rootMessage = typeof root?.message === "string" ? root.message : null;
    return {
      upstreamStatus: upstreamStatus ?? nestedStatus,
      upstreamType: typeof nestedError?.type === "string" ? nestedError.type : null,
      upstreamCode: typeof nestedError?.code === "string" ? nestedError.code : rootCode,
      upstreamMessage: typeof nestedError?.message === "string" ? nestedError.message : rootMessage,
      resetsInSeconds:
        typeof nestedError?.resets_in_seconds === "number" &&
        Number.isFinite(nestedError.resets_in_seconds)
          ? nestedError.resets_in_seconds
          : null,
      planType: typeof nestedError?.plan_type === "string" ? nestedError.plan_type : null,
    };
  } catch {
    return {
      upstreamStatus,
      upstreamType: null,
      upstreamCode: null,
      upstreamMessage: null,
      resetsInSeconds: null,
      planType: null,
    };
  }
}

function formatDurationSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${Math.max(1, minutes)}m`;
}

/**
 * True when the diagnostic is this proxy envelope: its status, and its typed
 * code when the diagnostic carries one, else its fixed sentence. Never a
 * generic 401/424 or a provider's similarly named error.
 */
function isProxyEnvelope(
  info: ProxyUpstreamErrorInfo,
  diagnosticText: string,
  envelope: ProxyEnvelope,
): boolean {
  if (info.proxyStatus !== envelope.status) {
    return false;
  }
  const upstreamCode = info.upstreamCode?.trim().toLowerCase() ?? "";
  if (upstreamCode) {
    return info.upstreamType === "upstream_error" && upstreamCode === envelope.code;
  }
  return diagnosticText.toLowerCase().includes(envelope.sentence);
}

function isExpiredCredentialProxyErrorInfo(info: ProxyUpstreamErrorInfo, diagnosticText: string): boolean {
  const upstreamCode = info.upstreamCode?.trim().toLowerCase() ?? "";
  if (SIGN_IN_PROXY_ENVELOPES.some((envelope) => isProxyEnvelope(info, diagnosticText, envelope))) {
    return true;
  }
  if (
    upstreamCode === "token_expired" ||
    upstreamCode === "refresh_token_reused" ||
    upstreamCode === "token_invalidated"
  ) {
    return true;
  }

  const details = `${info.upstreamMessage ?? ""}`.toLowerCase();
  const controllerRefreshFailed =
    details.includes("codex oauth refresh failed") ||
    details.includes("controller forced credential refresh failed");
  if (!details.includes("token") && !controllerRefreshFailed) {
    return false;
  }

  const credentialStatus =
    info.upstreamStatus === 401 ||
    info.proxyStatus === 401 ||
    controllerRefreshFailed ||
    details.includes("refresh token");
  if (!credentialStatus) {
    return false;
  }

  return (
    details.includes("expired") ||
    details.includes("invalidated") ||
    details.includes("session has ended") ||
    details.includes("log in again") ||
    details.includes("sign in again") ||
    details.includes("signing in again") ||
    details.includes("signin again") ||
    details.includes("already been used")
  );
}

function hasUpstreamErrorToken(info: ProxyUpstreamErrorInfo, value: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  return [info.upstreamType, info.upstreamCode, info.upstreamMessage].some((candidate) =>
    candidate?.toLowerCase().includes(normalizedValue),
  );
}

// Proxy envelope codes for failures the proxy marks retryable because the
// provider connection, not the credential, broke (see
// openai-proxy-server/src/upstream_error.rs). Switching credentials does not
// help with any of them.
const TRANSIENT_PROXY_ERROR_CODES = new Set([
  "upstream_transport_error",
  "upstream_timeout",
  "upstream_stream_error",
  "upstream_invalid_response",
]);

// The proxy's safe messages for those codes. A plain-text diagnostic such as
// "unexpected status 502 Bad Gateway: The upstream request failed., url: …"
// carries only the message, without the JSON envelope's code.
const TRANSIENT_PROXY_ERROR_MESSAGES = [
  "the upstream request failed.",
  "the upstream request timed out.",
  "the upstream provider reported a stream failure.",
  "the upstream provider returned an invalid response.",
  "the upstream provider returned an unexpected http status.",
];

function isTransientProxyErrorInfo(info: ProxyUpstreamErrorInfo, diagnosticText: string): boolean {
  const upstreamCode = info.upstreamCode?.trim().toLowerCase() ?? "";
  if (TRANSIENT_PROXY_ERROR_CODES.has(upstreamCode)) {
    return true;
  }
  // A provider-reported status decides on its own: a 401/403/429 behind a 502
  // is a credential or quota problem, a 5xx is the provider having a moment.
  if (info.upstreamStatus !== null) {
    return info.upstreamStatus >= 500;
  }
  if (upstreamCode) {
    return upstreamCode === "upstream_http_error" && info.proxyStatus >= 500;
  }
  if (info.proxyStatus !== 502 && info.proxyStatus !== 503 && info.proxyStatus !== 504) {
    return false;
  }
  const lowered = diagnosticText.toLowerCase();
  return TRANSIENT_PROXY_ERROR_MESSAGES.some((message) => lowered.includes(message));
}

function isProxyTimeout(info: ProxyUpstreamErrorInfo, diagnosticText: string): boolean {
  return (
    info.proxyStatus === 504 ||
    info.upstreamCode?.trim().toLowerCase() === "upstream_timeout" ||
    diagnosticText.toLowerCase().includes("the upstream request timed out.")
  );
}

function buildTransientProxyErrorGuidance(
  info: ProxyUpstreamErrorInfo,
  diagnosticText: string,
  isRetrying: boolean,
): ProxyUpstreamErrorGuidance {
  const headline = isProxyTimeout(info, diagnosticText)
    ? "The AI took too long to answer"
    : "The connection to the AI dropped";
  return {
    summary: isRetrying ? `${headline}. Trying again.` : `${headline}. This is usually temporary.`,
    detail: isRetrying
      ? "It is being tried again on its own. Nothing needs to change."
      : "If the turn stopped, send your message again.",
    actionLabel: null,
    actionKind: null,
  };
}

function buildQuotaGuidance(): ProxyUpstreamErrorGuidance {
  return {
    summary: QUOTA_SUMMARY,
    detail: "This is a limit on your AI account, not on your Instafy credits.",
    actionLabel: "Manage AI",
    actionKind: "open_ai_settings",
  };
}

function buildSignInGuidance(): ProxyUpstreamErrorGuidance {
  return {
    summary: SIGN_IN_SUMMARY,
    // The button opens AI settings and nothing more, with no retry control
    // on this row, so the sentence must not promise one.
    detail: "Sign in again under Manage AI, then send your message again.",
    actionLabel: "Manage AI",
    actionKind: "open_ai_settings",
  };
}

function resolveFormattedProxySummaryGuidance(content: string): ProxyUpstreamErrorGuidance | null {
  const trimmed = content.trim();
  // Only recognize summaries generated by this module. Do not infer CTAs from arbitrary user prose.
  if (trimmed === SIGN_IN_SUMMARY || LEGACY_SIGN_IN_SUMMARIES.includes(trimmed)) {
    return buildSignInGuidance();
  }
  if (trimmed === QUOTA_SUMMARY) {
    return buildQuotaGuidance();
  }

  const match = trimmed.match(/^(Upstream\s+\d{3})\s+rejected the AI request\s+\(([^)]+)\)\.?/i);
  if (!match) {
    return null;
  }
  if (match[2]?.trim().toLowerCase() !== "insufficient_quota") {
    return null;
  }
  return buildQuotaGuidance();
}

export function parseProxyUpstreamError(content: string): ProxyUpstreamErrorInfo | null {
  const diagnosticText = extractProxyDiagnosticText(content);
  if (!diagnosticText) {
    return null;
  }

  const statusMatch = diagnosticText.match(/unexpected status\s+(\d{3})(?:\s+([^:]+))?:/i);
  if (!statusMatch) {
    return null;
  }

  const proxyStatus = Number(statusMatch[1]);
  const proxyStatusText = statusMatch[2]?.trim() ? statusMatch[2].trim() : null;
  const endpointMatch = diagnosticText.match(/endpoint=([^,\s)]+)/i);
  const upstreamEndpoint = endpointMatch?.[1]?.trim() || null;
  const nested = parseNestedProviderError(diagnosticText);

  return {
    proxyStatus,
    proxyStatusText,
    upstreamStatus: nested.upstreamStatus,
    upstreamType: nested.upstreamType,
    upstreamCode: nested.upstreamCode,
    upstreamMessage: nested.upstreamMessage,
    upstreamEndpoint,
    resetsInSeconds: nested.resetsInSeconds,
    planType: nested.planType,
  };
}

export function isExpiredCredentialProxyError(content: string): boolean {
  const info = parseProxyUpstreamError(content);
  if (!info) {
    return false;
  }
  return isExpiredCredentialProxyErrorInfo(info, extractProxyDiagnosticText(content) ?? content);
}

export function formatProxyUpstreamErrorSummary(content: string): string | null {
  return resolveProxyUpstreamErrorGuidance(content)?.summary ?? null;
}

export function resolveProxyUpstreamErrorGuidance(content: string): ProxyUpstreamErrorGuidance | null {
  const formattedGuidance = resolveFormattedProxySummaryGuidance(content);
  if (formattedGuidance) {
    return formattedGuidance;
  }

  const info = parseProxyUpstreamError(content);
  if (!info) {
    return null;
  }

  const diagnosticText = extractProxyDiagnosticText(content) ?? content;
  if (isExpiredCredentialProxyErrorInfo(info, diagnosticText)) {
    return buildSignInGuidance();
  }

  if (
    hasUpstreamErrorToken(info, "insufficient_quota") ||
    isProxyEnvelope(info, diagnosticText, QUOTA_PROXY_ENVELOPE)
  ) {
    return buildQuotaGuidance();
  }

  if (isTransientProxyErrorInfo(info, diagnosticText)) {
    return buildTransientProxyErrorGuidance(info, diagnosticText, /^\s*retrying:/i.test(content));
  }

  // What remains is the AI service refusing the request itself (auth,
  // permission, rate limit, bad request), where another connection can help.
  const busy = info.upstreamStatus === 429 || (info.upstreamStatus === null && info.proxyStatus === 429);
  const wait =
    typeof info.resetsInSeconds === "number"
      ? `Try again in ${formatDurationSeconds(info.resetsInSeconds)}.`
      : busy
        ? "Wait a little, then try again."
        : null;
  return {
    summary: [busy ? BUSY_SUMMARY : REFUSED_SUMMARY, wait].filter(Boolean).join(" "),
    detail: "If this keeps happening, check your AI connection under Manage AI.",
    actionLabel: "Manage AI",
    actionKind: "open_ai_settings",
  };
}
