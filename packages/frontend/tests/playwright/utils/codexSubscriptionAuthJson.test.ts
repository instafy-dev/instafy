import { describe, expect, it } from "vitest";
import {
  buildCodexCredentialCleanupFilter,
  sanitizeCodexSubscriptionAuthJson,
} from "./codexSubscriptionAuthJson.js";

describe("sanitizeCodexSubscriptionAuthJson", () => {
  it("keeps subscription tokens while stripping paid API keys and unknown fields", () => {
    const sanitized = sanitizeCodexSubscriptionAuthJson({
      auth_mode: "api-key",
      OPENAI_API_KEY: "paid-api-key-must-not-upload",
      last_refresh: " 2026-07-14T10:00:00Z ",
      unexpected: { retained: false },
      tokens: {
        access_token: " subscription-access ",
        account_id: " account-1 ",
        id_token: " identity-token ",
        refresh_token: " refresh-token ",
        unknown_token: "strip-me",
      },
    });

    expect(sanitized).toEqual({
      auth_mode: "chatgpt",
      last_refresh: "2026-07-14T10:00:00Z",
      tokens: {
        access_token: "subscription-access",
        account_id: "account-1",
        id_token: "identity-token",
        refresh_token: "refresh-token",
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain("paid-api-key-must-not-upload");
    expect(JSON.stringify(sanitized)).not.toContain("strip-me");
  });

  it("fails closed without a subscription access token", () => {
    expect(() =>
      sanitizeCodexSubscriptionAuthJson({ OPENAI_API_KEY: "paid-api-key-only" }),
    ).toThrow("The local Codex login is not usable.");
    expect(() => sanitizeCodexSubscriptionAuthJson({ tokens: {} })).toThrow(
      "The local Codex login is not usable.",
    );
  });
});

describe("buildCodexCredentialCleanupFilter", () => {
  it("scopes service-role cleanup to one user and the canonical Codex source", () => {
    const filter = buildCodexCredentialCleanupFilter({
      userId: "d0cf3e70-38c3-4ff1-a8a2-5fce057f9d32",
      label: "Playwright canonical local Codex auth",
    });

    expect(filter.get("user_id")).toBe(
      "eq.d0cf3e70-38c3-4ff1-a8a2-5fce057f9d32",
    );
    expect(filter.get("label")).toBe("eq.Playwright canonical local Codex auth");
    expect(filter.get("kind")).toBe("eq.codex_auth_json");
    expect(filter.get("metadata->>source")).toBe("eq.codex_cli");
  });

  it("refuses cleanup without a concrete Supabase user id", () => {
    expect(() =>
      buildCodexCredentialCleanupFilter({
        userId: "",
        label: "Playwright canonical local Codex auth",
      }),
    ).toThrow("A canonical test user and credential label are required for cleanup.");
  });
});
