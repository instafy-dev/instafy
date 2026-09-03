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

const CHATGPT_CREDENTIAL_RECONNECT_SUMMARY =
  "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.";
const AI_CREDENTIAL_RECONNECT_SUMMARY =
  "AI credentials need reconnecting. Reconnect AI credentials, then retry the message.";

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

  if (/unexpected status\s+\d{3}/i.test(trimmed)) {
    return trimmed;
  }

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as unknown;
    const root = asRecord(parsed);
    const error = asRecord(root?.error);
    const message = typeof error?.message === "string" ? error.message.trim() : "";
    if (!message || !/unexpected status\s+\d{3}/i.test(message)) {
      return null;
    }
    return message;
  } catch {
    return null;
  }
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

function isExpiredCredentialProxyErrorInfo(info: ProxyUpstreamErrorInfo): boolean {
  const upstreamCode = info.upstreamCode?.trim().toLowerCase() ?? "";
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

function formatProxyUpstreamErrorStatus(info: ProxyUpstreamErrorInfo): string {
  return info.upstreamStatus ? `Upstream ${info.upstreamStatus}` : "The upstream provider";
}

function buildInsufficientQuotaGuidance(upstreamLabel: string): ProxyUpstreamErrorGuidance {
  return {
    summary: `${upstreamLabel} rejected the AI request (insufficient_quota).`,
    detail:
      "The selected upstream AI credential/account has no available provider quota. This is separate from Instafy workspace credits.",
    actionLabel: "Manage AI",
    actionKind: "open_ai_settings",
  };
}

function buildExpiredCredentialGuidance(summary: string): ProxyUpstreamErrorGuidance {
  return {
    summary,
    // The button opens AI settings and nothing more — there is no credential
    // picker and no retry control on this row, so the sentence must not
    // promise either. Send the message again once the connection is fixed.
    detail:
      "The saved AI login is stale. Fix the connection in AI settings, then send your message again.",
    actionLabel: "Open AI settings",
    actionKind: "open_ai_settings",
  };
}

function resolveFormattedProxySummaryGuidance(content: string): ProxyUpstreamErrorGuidance | null {
  const trimmed = content.trim();
  // Only recognize summaries generated by this module. Do not infer CTAs from arbitrary user prose.
  if (trimmed === CHATGPT_CREDENTIAL_RECONNECT_SUMMARY || trimmed === AI_CREDENTIAL_RECONNECT_SUMMARY) {
    return buildExpiredCredentialGuidance(trimmed);
  }

  const match = trimmed.match(/^(Upstream\s+\d{3})\s+rejected the AI request\s+\(([^)]+)\)\.?/i);
  if (!match) {
    return null;
  }
  if (match[2]?.trim().toLowerCase() !== "insufficient_quota") {
    return null;
  }
  return buildInsufficientQuotaGuidance(match[1] ?? "Upstream 429");
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
  return isExpiredCredentialProxyErrorInfo(info);
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

  if (isExpiredCredentialProxyErrorInfo(info)) {
    const providerLabel =
      (info.upstreamEndpoint && info.upstreamEndpoint.toLowerCase().includes("chatgpt.com")) ||
      info.upstreamMessage?.toLowerCase().includes("codex oauth refresh failed")
        ? "ChatGPT login needs reconnecting."
        : "AI credentials need reconnecting.";
    return buildExpiredCredentialGuidance(`${providerLabel} Reconnect AI credentials, then retry the message.`);
  }

  const upstreamLabel = formatProxyUpstreamErrorStatus(info);
  if (hasUpstreamErrorToken(info, "insufficient_quota")) {
    return buildInsufficientQuotaGuidance(upstreamLabel);
  }

  const parts = [
    `${upstreamLabel} rejected the AI request${info.upstreamType ? ` (${info.upstreamType})` : ""}.`,
    "Retry later or switch credentials.",
  ];
  if (typeof info.resetsInSeconds === "number") {
    parts.push(
      `Rate limit resets in ${formatDurationSeconds(info.resetsInSeconds)}${info.planType ? ` (${info.planType})` : ""}.`,
    );
  }

  return {
    summary: parts.join(" "),
    detail: "If this keeps happening, switch to another AI credential or reconnect the selected provider.",
    actionLabel: "Manage AI",
    actionKind: "open_ai_settings",
  };
}
