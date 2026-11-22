import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../core", () => ({
  readControllerError: vi.fn(async (_response: unknown, fallback: string) => fallback),
  readControllerApiError: vi.fn(async (response: Response, fallback: string) => {
    const body = JSON.parse(await response.text()) as { message?: string; code?: string };
    return {
      status: response.status,
      message: body.message ?? fallback,
      code: body.code ?? null,
      details: null,
    };
  }),
  resolveControllerRequestContext: async () => ({
    baseUrl: "http://controller.test",
    accessToken: "token-123",
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
}));

import {
  getDeviceAuthStatus,
  parseManagedAiAccess,
  parseSubscriptionUsage,
  renameMyCredential,
  startDeviceAuth,
} from "../credentials";

function answer(status: number, value: unknown) {
  return () => Promise.resolve(new Response(JSON.stringify(value), { status }));
}

function sent(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

describe("parseSubscriptionUsage (controller contract boundary)", () => {
  it("keeps a window that has no reset time (proxy omits resetAt)", () => {
    // The proxy emits windows without a resetAt when the upstream sends no
    // reset header. Such a window is still usable and must not be dropped.
    const usage = parseSubscriptionUsage({
      windows: [{ kind: "primary", usedPercent: 42, windowMinutes: 300 }],
      planName: "GPT-5.5-Codex",
      capturedAt: 1756377600,
    });
    expect(usage).not.toBeNull();
    expect(usage?.windows).toHaveLength(1);
    expect(usage?.windows[0]?.resetAt).toBe(0); // defaulted, not dropped
    expect(usage?.planName).toBe("GPT-5.5-Codex");
  });

  it("drops windows missing a numeric percent or length", () => {
    const usage = parseSubscriptionUsage({
      windows: [
        { kind: "primary", windowMinutes: 300 }, // no usedPercent
        { kind: "bogus", usedPercent: 5, windowMinutes: 300 }, // bad kind
        { kind: "secondary", usedPercent: 40, windowMinutes: 10080, resetAt: 123 },
      ],
      capturedAt: 1756377600,
    });
    expect(usage?.windows).toHaveLength(1);
    expect(usage?.windows[0]?.kind).toBe("secondary");
  });

  it("returns null for missing, malformed, or empty payloads", () => {
    expect(parseSubscriptionUsage(null)).toBeNull();
    expect(parseSubscriptionUsage(undefined)).toBeNull();
    expect(parseSubscriptionUsage({})).toBeNull();
    expect(parseSubscriptionUsage({ windows: [] })).toBeNull();
  });
});

describe("parseManagedAiAccess (controller contract boundary)", () => {
  const usedUp = {
    enabled: true,
    available: false,
    label: "Instafy AI",
    creditBurnAmount: 1,
    dailyPromptLimit: 20,
    dailyPromptsUsed: 20,
    remainingPrompts: 0,
  };

  it("keeps when the next hosted AI prompt frees up", () => {
    expect(
      parseManagedAiAccess({ ...usedUp, nextAvailableAt: "2026-10-27T08:00:00Z" })?.nextAvailableAt,
    ).toBe("2026-10-27T08:00:00Z");
  });

  it("reads an older controller without the time, or a malformed one, as unknown", () => {
    expect(parseManagedAiAccess(usedUp)).toMatchObject({ remainingPrompts: 0, nextAvailableAt: null });
    expect(parseManagedAiAccess({ ...usedUp, nextAvailableAt: "soon" })?.nextAvailableAt).toBeNull();
    expect(parseManagedAiAccess({ ...usedUp, nextAvailableAt: 1761552000 })?.nextAvailableAt).toBeNull();
  });

  it("keeps why hosted AI is unavailable, and drops reasons it does not know", () => {
    expect(
      parseManagedAiAccess({ ...usedUp, unavailableReason: "daily_limit_reached" })?.unavailableReason,
    ).toBe("daily_limit_reached");
    expect(parseManagedAiAccess({ ...usedUp, unavailableReason: "no_proxy" })?.unavailableReason).toBe(
      "no_proxy",
    );
    expect(parseManagedAiAccess({ ...usedUp, unavailableReason: "solar_flare" })?.unavailableReason).toBeNull();
    expect(parseManagedAiAccess(usedUp)?.unavailableReason).toBeNull();
  });

  it("returns null without a managedAi block", () => {
    expect(parseManagedAiAccess(undefined)).toBeNull();
    expect(parseManagedAiAccess(null)).toBeNull();
    expect(parseManagedAiAccess("managed")).toBeNull();
  });
});

describe("renameMyCredential", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const listed = {
    id: "cred-1",
    kind: "codex_auth_json",
    label: "Work plan",
    isDefault: false,
    metadata: { account_id: "acct_123456" },
    defaultModel: "gpt-5.5",
    subscriptionUsage: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-22T00:00:00Z",
  };

  it("sends the new name and reads the renamed connection as the list does", async () => {
    const fetchMock = vi.fn(answer(200, listed));
    vi.stubGlobal("fetch", fetchMock);
    const result = await renameMyCredential("cred-1", "Work plan");
    expect(sent(fetchMock)).toMatchObject({
      url: "http://controller.test/me/credentials/cred-1",
      method: "PATCH",
      body: { label: "Work plan" },
    });
    expect(result).toEqual({
      success: true,
      credential: {
        id: "cred-1",
        kind: "codex_auth_json",
        label: "Work plan",
        isDefault: false,
        metadata: { account_id: "acct_123456" },
        subscriptionUsage: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-22T00:00:00Z",
      },
    });
  });

  it("keeps a refusal's code and plain sentence", async () => {
    const refusal = "Leave the email address out of the name. Teammates see it on this connection's agent.";
    vi.stubGlobal(
      "fetch",
      vi.fn(answer(400, { message: refusal, code: "credential_label_has_email" })),
    );
    expect(await renameMyCredential("cred-1", "ann@example.com")).toEqual({
      success: false,
      error: refusal,
      code: "credential_label_has_email",
      status: 400,
    });
  });
});

describe("startDeviceAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the sign-in it replaces, and sends no body otherwise", async () => {
    const fetchMock = vi.fn(
      answer(200, {
        sessionId: "session-1",
        provider: "codex",
        verificationUrl: "https://auth.example.test/codex/device",
        userCode: "INERT-CODE",
        expiresAt: "2026-11-22T00:15:00Z",
        pollIntervalSeconds: 5,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await startDeviceAuth("codex", { replacesCredentialId: "old-chatgpt" })).toMatchObject({
      success: true,
      sessionId: "session-1",
    });
    expect(sent(fetchMock, 0)).toMatchObject({
      url: "http://controller.test/me/auth/device/codex/start",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { replacesCredentialId: "old-chatgpt" },
    });

    await startDeviceAuth("codex");
    const plain = sent(fetchMock, 1);
    expect(plain.body).toBeUndefined();
    expect(plain.headers).not.toHaveProperty("content-type");
  });
});

describe("getDeviceAuthStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads whether a finished sign-in replaced the one it was started to replace", async () => {
    const completed = { sessionId: "session-1", provider: "codex", status: "completed", credentialId: "cred-new" };
    const read = async (extra: Record<string, unknown>) => {
      vi.stubGlobal("fetch", vi.fn(answer(200, { ...completed, ...extra })));
      const status = await getDeviceAuthStatus("session-1");
      return [status.replaced, status.notReplacedReason];
    };
    expect(await read({ replaced: true })).toEqual([true, null]);
    expect(await read({ replaced: false, reason: "different_account" })).toEqual([false, "different_account"]);
    expect(await read({ replaced: false, reason: "gone" })).toEqual([false, "gone"]);
    // Nothing replaced, an older controller, or a reason it does not know.
    expect(await read({})).toEqual([null, null]);
    expect(await read({ replaced: false, reason: "solar_flare" })).toEqual([false, null]);
  });
});
