import { describe, expect, it } from "vitest";

import {
  formatProxyUpstreamErrorSummary,
  isExpiredCredentialProxyError,
  parseProxyUpstreamError,
  resolveProxyUpstreamErrorGuidance,
} from "../proxyError";

const TOKEN_EXPIRED_ERROR = `unexpected status 502 Bad Gateway: upstream request failed (credential_source=claim, endpoint=chatgpt.com/backend-api/codex/responses, requested_model=gpt-5.1-codex-max, resolved_model=gpt-5.1-codex-max): backend responded with 401 Unauthorized: {
  "error": {
    "message": "Provided authentication token is expired. Please try signing in again.",
    "type": null,
    "code": "token_expired",
    "param": null
  },
  "status": 401
}, url: http://proxy:8789/v1/responses`;

const RATE_LIMIT_ERROR = `unexpected status 502 Bad Gateway: upstream request failed (credential_source=claim, endpoint=api.openai.com/v1/responses): backend responded with 429 Too Many Requests: {
  "error": {
    "message": "Rate limit reached",
    "type": "rate_limit_error",
    "code": "rate_limit_reached",
    "resets_in_seconds": 120,
    "plan_type": "pro"
  },
  "status": 429
}`;

const INSUFFICIENT_QUOTA_ERROR = `unexpected status 502 Bad Gateway: upstream request failed (credential_source=claim, endpoint=api.openai.com/v1/responses): backend responded with 429 Too Many Requests: {
  "error": {
    "message": "You exceeded your current quota.",
    "type": "insufficient_quota",
    "code": "insufficient_quota"
  },
  "status": 429
}`;

const REFRESH_TOKEN_REUSED_ERROR = `AI proxy error: upstream provider (invalid_request_error). Proxy returned 502 Bad Gateway.
unexpected status 502 Bad Gateway: upstream request failed (credential_source=static, endpoint=chatgpt.com/backend-api/codex/responses, requested_model=gpt-5.4, resolved_model=gpt-5.4): failed to refresh ChatGPT access token: failed to refresh ChatGPT token: 401 Unauthorized {
  "error": {
    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
    "type": "invalid_request_error",
    "code": "refresh_token_reused"
  }
}, url: http://proxy:8789/v1/responses`;

const CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR = `unexpected status 401 Unauthorized: controller credential fetch failed: controller credentials returned 500 Internal Server Error: {
  "message": "Codex OAuth refresh failed: Your refresh token has already been used to generate a new access token. Please try signing in again."
}`;

const CONTROLLER_CREDENTIAL_SESSION_ENDED_ERROR = `unexpected status 502 Bad Gateway: upstream request failed (credential_source=claim, requested_model=gpt-5.4): controller forced credential refresh failed: controller credential fetch failed: controller credentials returned 500 Internal Server Error: {"message":"Codex OAuth refresh failed: Your session has ended. Please log in again."}, url: http://proxy:8789/v1/responses`;

function safeProxyError(status: number, code: string, message: string, type = "upstream_error") {
  return `unexpected status ${status}: ${JSON.stringify({ error: { type, code, message } })}, url: http://proxy:8789/v1/responses`;
}

// What Codex stores when the proxy refuses: the status and the envelope's
// message, without its JSON code.
function plainProxyError(status: string, message: string) {
  return `unexpected status ${status}: ${message}, url: http://proxy:8789/v1/responses`;
}

const SIGN_IN = "Your AI connection needs you to sign in again.";
const JARGON = /upstream|provider|credential|switch/i;

describe("proxyError", () => {
  it.each([
    [401, "upstream_authentication_error", "The upstream provider rejected authentication."],
    [424, "upstream_credential_refresh_failed", "Upstream credentials could not be refreshed."],
  ] as const)("retains reconnect guidance for safe credential error %s", (status, code, message) => {
    const diagnostic = safeProxyError(status, code, message);
    for (const content of [diagnostic, JSON.stringify({ error: { message: diagnostic } })]) {
      expect(parseProxyUpstreamError(content)?.upstreamCode).toBe(code);
      expect(isExpiredCredentialProxyError(content)).toBe(true);
      const guidance = resolveProxyUpstreamErrorGuidance(content);
      expect(guidance?.summary).toBe(SIGN_IN);
      expect(guidance?.actionKind).toBe("open_ai_settings");
      expect(guidance?.actionLabel).toBe("Manage AI");
    }
  });

  it.each([
    ["424 Failed Dependency", "Upstream credentials could not be refreshed."],
    ["401 Unauthorized", "The upstream provider rejected authentication."],
  ] as const)("reads the proxy's plain %s sentence as a sign-in to renew", (status, message) => {
    const diagnostic = plainProxyError(status, message);
    expect(isExpiredCredentialProxyError(diagnostic)).toBe(true);
    expect(resolveProxyUpstreamErrorGuidance(diagnostic)).toMatchObject({
      summary: SIGN_IN,
      actionLabel: "Manage AI",
      actionKind: "open_ai_settings",
    });
  });

  it("needs the proxy's own status beside its sentence", () => {
    for (const diagnostic of [
      plainProxyError("502 Bad Gateway", "Upstream credentials could not be refreshed."),
      plainProxyError("424 Failed Dependency", "The upstream request configuration is invalid."),
      plainProxyError("401 Unauthorized", "proxy token missing credential_id for BYOC request"),
    ]) {
      expect(isExpiredCredentialProxyError(diagnostic), diagnostic).toBe(false);
      expect(resolveProxyUpstreamErrorGuidance(diagnostic)?.summary, diagnostic).not.toBe(SIGN_IN);
    }
  });

  it.each([
    [424, "upstream_configuration_error"],
    [402, "upstream_insufficient_quota"],
    [403, "upstream_access_denied"],
    [429, "upstream_rate_limit"],
    [502, "upstream_transport_error"],
    [503, "upstream_http_error"],
    [504, "upstream_timeout"],
    [502, "upstream_authentication_error"],
    [502, "upstream_credential_refresh_failed"],
  ] as const)("does not reconnect for %s %s", (status, code) => {
    const diagnostic = safeProxyError(status, code, "Safe failure message.");
    expect(isExpiredCredentialProxyError(diagnostic)).toBe(false);
    expect(resolveProxyUpstreamErrorGuidance(diagnostic)?.summary).not.toBe(SIGN_IN);
  });

  it("requires the proxy envelope type for safe credential codes", () => {
    const diagnostic = safeProxyError(401, "upstream_authentication_error", "Request failed.", "other_error");
    expect(isExpiredCredentialProxyError(diagnostic)).toBe(false);
    expect(isExpiredCredentialProxyError("upstream_credential_refresh_failed")).toBe(false);
  });

  it("keeps safe quota failures separate from reconnectable credentials", () => {
    for (const diagnostic of [
      safeProxyError(402, "upstream_insufficient_quota", "The upstream provider has no available quota."),
      plainProxyError("402 Payment Required", "The upstream provider has no available quota."),
    ]) {
      const guidance = resolveProxyUpstreamErrorGuidance(diagnostic);
      expect(guidance?.summary).toBe("Your AI account has reached its limit.");
      expect(guidance?.detail).toContain("not on your Instafy credits");
      expect(guidance?.actionLabel).toBe("Manage AI");
      expect(isExpiredCredentialProxyError(diagnostic)).toBe(false);
    }
  });

  it("detects expired credential proxy responses", () => {
    expect(isExpiredCredentialProxyError(TOKEN_EXPIRED_ERROR)).toBe(true);
    expect(formatProxyUpstreamErrorSummary(TOKEN_EXPIRED_ERROR)).toBe(SIGN_IN);
  });

  it("detects reused ChatGPT refresh tokens as reconnectable credentials", () => {
    expect(isExpiredCredentialProxyError(REFRESH_TOKEN_REUSED_ERROR)).toBe(true);
    expect(formatProxyUpstreamErrorSummary(REFRESH_TOKEN_REUSED_ERROR)).toBe(SIGN_IN);
  });

  it("detects controller credential refresh failures as reconnectable credentials", () => {
    expect(isExpiredCredentialProxyError(CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR)).toBe(
      true,
    );
    expect(formatProxyUpstreamErrorSummary(CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR)).toBe(SIGN_IN);
  });

  it("detects ended ChatGPT sessions after forced refresh as reconnectable credentials", () => {
    expect(isExpiredCredentialProxyError(CONTROLLER_CREDENTIAL_SESSION_ENDED_ERROR)).toBe(true);
    expect(formatProxyUpstreamErrorSummary(CONTROLLER_CREDENTIAL_SESSION_ENDED_ERROR)).toBe(SIGN_IN);
  });

  it("extracts structured upstream metadata for rate limits", () => {
    const parsed = parseProxyUpstreamError(RATE_LIMIT_ERROR);
    expect(parsed).toBeTruthy();
    expect(parsed?.proxyStatus).toBe(502);
    expect(parsed?.upstreamStatus).toBe(429);
    expect(parsed?.upstreamType).toBe("rate_limit_error");
    expect(parsed?.resetsInSeconds).toBe(120);
    expect(parsed?.planType).toBe("pro");
  });

  it("explains insufficient upstream quota separately from Instafy credits", () => {
    const guidance = resolveProxyUpstreamErrorGuidance(INSUFFICIENT_QUOTA_ERROR);
    expect(guidance?.summary).toBe("Your AI account has reached its limit.");
    expect(guidance?.detail).toBe("This is a limit on your AI account, not on your Instafy credits.");
    expect(guidance?.actionKind).toBe("open_ai_settings");
    expect(formatProxyUpstreamErrorSummary(INSUFFICIENT_QUOTA_ERROR)).toBe(guidance?.summary);
  });

  it("recognizes already summarized insufficient quota messages", () => {
    for (const summary of [
      "Your AI account has reached its limit.",
      "Upstream 429 rejected the AI request (insufficient_quota). Retry later or switch credentials.",
    ]) {
      const guidance = resolveProxyUpstreamErrorGuidance(summary);
      expect(guidance?.summary).toBe("Your AI account has reached its limit.");
      expect(guidance?.actionLabel).toBe("Manage AI");
    }
  });

  it("recognizes already summarized reconnectable credential messages", () => {
    for (const summary of [
      SIGN_IN,
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    ]) {
      const guidance = resolveProxyUpstreamErrorGuidance(summary);
      expect(guidance?.summary).toBe(SIGN_IN);
      expect(guidance?.detail).toBe("Sign in again under Manage AI, then send your message again.");
      expect(guidance?.actionLabel).toBe("Manage AI");
      expect(guidance?.actionKind).toBe("open_ai_settings");
    }
  });

  it("never names the plumbing in what a person reads", () => {
    for (const diagnostic of [
      TOKEN_EXPIRED_ERROR,
      RATE_LIMIT_ERROR,
      INSUFFICIENT_QUOTA_ERROR,
      REFRESH_TOKEN_REUSED_ERROR,
      plainProxyError("424 Failed Dependency", "Upstream credentials could not be refreshed."),
      plainProxyError("424 Failed Dependency", "The upstream request configuration is invalid."),
      plainProxyError("403 Forbidden", "The upstream provider denied access."),
      plainProxyError("429 Too Many Requests", "The upstream provider rate limit was reached."),
      plainProxyError("502 Bad Gateway", "The upstream request failed."),
      `Retrying: ${plainProxyError("504 Gateway Timeout", "The upstream request timed out.")}`,
    ]) {
      const guidance = resolveProxyUpstreamErrorGuidance(diagnostic);
      expect(guidance, diagnostic).not.toBeNull();
      expect(guidance?.summary, diagnostic).not.toMatch(JARGON);
      expect(guidance?.detail ?? "", diagnostic).not.toMatch(JARGON);
    }
  });

  describe("transient provider failures", () => {
    // The proxy's retryable transport failure, as Codex quotes it in a retry
    // notice and as it reads once retries run out.
    const TRANSPORT_DIAGNOSTIC =
      "unexpected status 502 Bad Gateway: The upstream request failed., url: http://proxy:8789/v1/responses";

    it("reads a retried 502 transport failure as a dropped connection, not a rejection", () => {
      const guidance = resolveProxyUpstreamErrorGuidance(`Retrying: ${TRANSPORT_DIAGNOSTIC}`);
      expect(guidance?.summary).toBe("The connection to the AI dropped. Trying again.");
      expect(guidance?.actionKind).toBeNull();
      expect(guidance?.actionLabel).toBeNull();
    });

    it("reads a final 502 transport failure as a temporary dropped connection", () => {
      const guidance = resolveProxyUpstreamErrorGuidance(TRANSPORT_DIAGNOSTIC);
      expect(guidance?.summary).toBe("The connection to the AI dropped. This is usually temporary.");
      expect(guidance?.detail).toContain("send your message again");
      expect(guidance?.actionKind).toBeNull();
      expect(isExpiredCredentialProxyError(TRANSPORT_DIAGNOSTIC)).toBe(false);
    });

    it.each([
      [502, "upstream_transport_error", "The upstream request failed.", "The connection to the AI dropped"],
      [502, "upstream_stream_error", "The upstream provider reported a stream failure.", "The connection to the AI dropped"],
      [502, "upstream_invalid_response", "The upstream provider returned an invalid response.", "The connection to the AI dropped"],
      [503, "upstream_http_error", "The upstream provider is unavailable.", "The connection to the AI dropped"],
      [504, "upstream_timeout", "The upstream request timed out.", "The AI took too long to answer"],
    ] as const)("maps the %s %s envelope to transient wording", (status, code, message, headline) => {
      const summary = formatProxyUpstreamErrorSummary(safeProxyError(status, code, message));
      expect(summary).toBe(`${headline}. This is usually temporary.`);
    });

    it("maps a provider 5xx behind the proxy to transient wording", () => {
      const diagnostic = `unexpected status 502 Bad Gateway: upstream request failed (credential_source=claim, endpoint=api.openai.com/v1/responses): backend responded with 500 Internal Server Error: {"error":{"message":"Server error","type":"server_error"},"status":500}`;
      expect(formatProxyUpstreamErrorSummary(diagnostic)).toBe(
        "The connection to the AI dropped. This is usually temporary.",
      );
    });

    it.each([
      [401, "upstream_authentication_error", "The upstream provider rejected authentication.", SIGN_IN],
      [403, "upstream_access_denied", "The upstream provider denied access.", "Your AI connection couldn't answer this request."],
      [402, "upstream_insufficient_quota", "The upstream provider has no available quota.", "Your AI account has reached its limit."],
      [
        429,
        "upstream_rate_limit",
        "The upstream provider rate limit was reached.",
        "Your AI connection is limiting requests right now. Wait a little, then try again.",
      ],
    ] as const)("keeps account guidance for %s %s", (status, code, message, summary) => {
      const guidance = resolveProxyUpstreamErrorGuidance(safeProxyError(status, code, message));
      expect(guidance?.summary).toBe(summary);
      expect(guidance?.actionLabel).toBe("Manage AI");
    });

    it("keeps the refusal wording for a provider 403 behind a 502", () => {
      const diagnostic = `unexpected status 502 Bad Gateway: upstream request failed (endpoint=api.openai.com/v1/responses): backend responded with 403 Forbidden: {"error":{"message":"Project does not have access to model","type":"invalid_request_error"},"status":403}`;
      expect(formatProxyUpstreamErrorSummary(diagnostic)).toBe(
        "Your AI connection couldn't answer this request.",
      );
    });

    it("keeps the quota and rate-limit wording when the proxy itself returned 502", () => {
      expect(formatProxyUpstreamErrorSummary(INSUFFICIENT_QUOTA_ERROR)).toBe(
        "Your AI account has reached its limit.",
      );
      expect(formatProxyUpstreamErrorSummary(RATE_LIMIT_ERROR)).toBe(
        "Your AI connection is limiting requests right now. Try again in 2m.",
      );
    });
  });

  it("returns null for unrelated content", () => {
    expect(parseProxyUpstreamError("hello world")).toBeNull();
    expect(formatProxyUpstreamErrorSummary("hello world")).toBeNull();
    expect(isExpiredCredentialProxyError("hello world")).toBe(false);
  });
});
