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

describe("proxyError", () => {
  it("detects expired credential proxy responses", () => {
    expect(isExpiredCredentialProxyError(TOKEN_EXPIRED_ERROR)).toBe(true);
    expect(formatProxyUpstreamErrorSummary(TOKEN_EXPIRED_ERROR)).toContain(
      "Reconnect AI credentials",
    );
  });

  it("detects reused ChatGPT refresh tokens as reconnectable credentials", () => {
    expect(isExpiredCredentialProxyError(REFRESH_TOKEN_REUSED_ERROR)).toBe(true);
    expect(formatProxyUpstreamErrorSummary(REFRESH_TOKEN_REUSED_ERROR)).toBe(
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    );
  });

  it("detects controller credential refresh failures as reconnectable credentials", () => {
    expect(isExpiredCredentialProxyError(CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR)).toBe(
      true,
    );
    expect(formatProxyUpstreamErrorSummary(CONTROLLER_CREDENTIAL_REFRESH_TOKEN_REUSED_ERROR)).toBe(
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    );
  });

  it("detects ended ChatGPT sessions after forced refresh as reconnectable credentials", () => {
    expect(isExpiredCredentialProxyError(CONTROLLER_CREDENTIAL_SESSION_ENDED_ERROR)).toBe(true);
    expect(formatProxyUpstreamErrorSummary(CONTROLLER_CREDENTIAL_SESSION_ENDED_ERROR)).toBe(
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    );
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
    expect(guidance?.summary).toBe("Upstream 429 rejected the AI request (insufficient_quota).");
    expect(guidance?.detail).toContain("upstream AI credential/account");
    expect(guidance?.detail).toContain("separate from Instafy workspace credits");
    expect(guidance?.actionKind).toBe("open_ai_settings");
    expect(formatProxyUpstreamErrorSummary(INSUFFICIENT_QUOTA_ERROR)).toBe(guidance?.summary);
  });

  it("recognizes already summarized insufficient quota messages", () => {
    const guidance = resolveProxyUpstreamErrorGuidance(
      "Upstream 429 rejected the AI request (insufficient_quota). Retry later or switch credentials.",
    );
    expect(guidance?.summary).toBe("Upstream 429 rejected the AI request (insufficient_quota).");
    expect(guidance?.detail).toContain("separate from Instafy workspace credits");
    expect(guidance?.actionLabel).toBe("Manage AI");
  });

  it("recognizes already summarized reconnectable credential messages", () => {
    const guidance = resolveProxyUpstreamErrorGuidance(
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    );
    expect(guidance?.summary).toBe(
      "ChatGPT login needs reconnecting. Reconnect AI credentials, then retry the message.",
    );
    expect(guidance?.detail).toContain("login/token is stale");
    expect(guidance?.actionLabel).toBe("Reconnect AI");
    expect(guidance?.actionKind).toBe("open_ai_settings");
  });

  it("returns null for unrelated content", () => {
    expect(parseProxyUpstreamError("hello world")).toBeNull();
    expect(formatProxyUpstreamErrorSummary("hello world")).toBeNull();
    expect(isExpiredCredentialProxyError("hello world")).toBe(false);
  });
});
