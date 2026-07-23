import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MANAGED_AI_MODEL_LABEL } from "../../ai/modelDefaults";

const resolveTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../../sdk/instafy", () => ({
  controllerBaseUrl: "http://controller.test",
  runtimeControllerEnabled: true,
  resolveControllerAccessToken: resolveTokenMock
}));

import { fetchCreditLedger, fetchCreditPolicy, fetchCreditSnapshot } from "../creditService";

describe("creditService", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resolveTokenMock.mockReset();
    resolveTokenMock.mockResolvedValue("session-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("requests credit status with projectId and parses controller response", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/credits/status");
      expect(url.searchParams.get("projectId")).toBe("project-123");
      expect(url.searchParams.get("project_id")).toBeNull();
      expect((init?.headers as Record<string, string>)?.authorization).toBe(
        "Bearer session-token"
      );

      return {
        ok: true,
        json: async () => ({
          balance: 7,
          creditLimit: 25,
          lastBurnAt: "2025-01-01T00:00:00Z",
          lastRefillAt: "2025-01-01T00:00:00Z"
        })
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchCreditSnapshot(" project-123 ");
    expect(result.success).toBe(true);
    expect(result.snapshot).toEqual({
      balance: 7,
      creditLimit: 25,
      lastBurnAt: "2025-01-01T00:00:00Z",
      lastRefillAt: "2025-01-01T00:00:00Z",
      subscription: null
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses subscription details when present", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          balance: 10,
          creditLimit: 200,
          lastBurnAt: null,
          lastRefillAt: null,
          subscription: { planId: "starter", status: "active", processor: "dev" }
        })
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchCreditSnapshot("project-subscription");
    expect(result.success).toBe(true);
    expect(result.snapshot).toEqual({
      balance: 10,
      creditLimit: 200,
      lastBurnAt: null,
      lastRefillAt: null,
      subscription: {
        planId: "starter",
        status: "active",
        processor: "dev",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null
      }
    });
  });

  it("accepts legacy snake_case payload fields", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          balance: 3,
          credit_limit: 11,
          last_burn_at: null,
          last_refill_at: "2025-02-02T00:00:00Z"
        })
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchCreditSnapshot("project-legacy");
    expect(result.success).toBe(true);
    expect(result.snapshot).toEqual({
      balance: 3,
      creditLimit: 11,
      lastBurnAt: null,
      lastRefillAt: "2025-02-02T00:00:00Z",
      subscription: null
    });
  });

  it("requests credit ledger with projectId, clamps limit, and parses createdAt", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/credits/ledger");
      expect(url.searchParams.get("projectId")).toBe("project-ledger");
      expect(url.searchParams.get("project_id")).toBeNull();
      expect(url.searchParams.get("limit")).toBe("100");

      return {
        ok: true,
        json: async () => ({
          entries: [
            {
              delta: -2,
              reason: "burn",
              metadata: null,
              createdAt: "2025-03-03T00:00:00Z"
            },
            {
              delta: 4,
              reason: "refill",
              metadata: null,
              created_at: "2025-03-04T00:00:00Z"
            }
          ]
        })
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchCreditLedger("project-ledger", 999);
    expect(result.success).toBe(true);
    expect(result.entries).toEqual([
      {
        delta: -2,
        reason: "burn",
        metadata: null,
        createdAt: "2025-03-03T00:00:00Z"
      },
      {
        delta: 4,
        reason: "refill",
        metadata: null,
        createdAt: "2025-03-04T00:00:00Z"
      }
    ]);
  });

  it("parses credit policy display and managed ai pricing details", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/credits/policy");
      expect(url.searchParams.get("projectId")).toBe("project-policy");

      return {
        ok: true,
        json: async () => ({
          display: {
            unitLabel: "credits",
            currency: "USD",
            unitsPerUsd: 1000
          },
          refill: {
            kind: "daily",
            timezone: "UTC"
          },
          plans: [],
          usage: {
            tunnel: {
              reason: "tunnel_grant",
              enabled: true,
              amount: 10,
              intervalSeconds: 480,
              creditsPerMinute: 1.25
            },
            hostedRuntime: {
              reason: "hosted_runtime",
              enabled: true,
              amount: 90,
              intervalSeconds: 480,
              creditsPerMinute: 11.25
            },
            hostedRuntimeProviders: [],
            managedAi: {
              reason: "managed_ai_prompt",
              enabled: true,
              label: "Instafy AI",
              provider: "openai",
              creditsPerPrompt: 1,
              dailyPromptLimit: 20,
              modelLabel: DEFAULT_MANAGED_AI_MODEL_LABEL,
              inputUsdMicrosPer1k: 250,
              cachedInputUsdMicrosPer1k: 25,
              outputUsdMicrosPer1k: 2000
            }
          }
        })
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchCreditPolicy("project-policy");
    expect(result.success).toBe(true);
    expect(result.policy?.display).toEqual({
      unitLabel: "credits",
      currency: "USD",
      unitsPerUsd: 1000
    });
    expect(result.policy?.usage.managedAi).toEqual({
      reason: "managed_ai_prompt",
      enabled: true,
      label: "Instafy AI",
      provider: "openai",
      creditsPerPrompt: 1,
      dailyPromptLimit: 20,
      modelLabel: DEFAULT_MANAGED_AI_MODEL_LABEL,
      inputUsdMicrosPer1k: 250,
      cachedInputUsdMicrosPer1k: 25,
      outputUsdMicrosPer1k: 2000
    });
  });
});
