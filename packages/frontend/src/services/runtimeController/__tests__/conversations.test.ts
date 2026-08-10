import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  readControllerError: vi.fn(),
  resolveControllerRequestContext: async (desired: string | null) => ({
    baseUrl: "http://controller.test",
    accessToken: await resolveControllerAccessTokenMock(desired),
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
  safeJson: (value: unknown) => value,
}));

import {
  recordControllerConversationMessage,
  resolveControllerConversationParticipation,
} from "../conversations";

describe("recordControllerConversationMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries transient failures with the same client message id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue("temporarily unavailable"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: "11111111-1111-1111-1111-111111111111",
          conversationId: "22222222-2222-2222-2222-222222222222",
          projectId: "33333333-3333-3333-3333-333333333333",
          sessionId: null,
          createdBy: null,
          promptId: null,
          runId: null,
          role: "user",
          content: "hello",
          metadata: {
            clientMessageId: "client-message-1",
          },
          createdAt: "2026-03-31T10:00:00.000Z",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const promise = recordControllerConversationMessage({
      conversationId: "22222222-2222-2222-2222-222222222222",
      projectId: "33333333-3333-3333-3333-333333333333",
      content: "hello",
      clientMessageId: "client-message-1",
      metadata: {
        displayContent: "hello",
      },
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      metadata: {
        clientMessageId: "client-message-1",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    const secondRequest = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(firstRequest.clientMessageId).toBe("client-message-1");
    expect(secondRequest.clientMessageId).toBe("client-message-1");
    expect(firstRequest.projectId).toBe("33333333-3333-3333-3333-333333333333");
    expect(secondRequest.projectId).toBe("33333333-3333-3333-3333-333333333333");
    expect(firstRequest.metadata).toMatchObject({
      displayContent: "hello",
      clientMessageId: "client-message-1",
    });
    expect(secondRequest.metadata).toEqual(firstRequest.metadata);
  });

  it("does not retry non-transient failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("bad request"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recordControllerConversationMessage({
        conversationId: "22222222-2222-2222-2222-222222222222",
        projectId: "33333333-3333-3333-3333-333333333333",
        content: "hello",
      }),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveControllerConversationParticipation", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts the ambient turn and returns the typed skill decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        decision: "respond",
        domain: "technical",
        reason: "Octo should answer this technical question immediately.",
        confidence: 98,
        participantCount: 2,
        targetMessageId: null,
        policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveControllerConversationParticipation({
        conversationId: "22222222-2222-2222-2222-222222222222",
        content: "What does this TypeScript error mean?",
        metadata: { clientMessageId: "client-message-1" },
        explicitOcto: false,
        replyToOcto: false,
        replyToHuman: false,
      }),
    ).resolves.toMatchObject({
      decision: "respond",
      domain: "technical",
      confidence: 98,
      participantCount: 2,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://controller.test/conversations/22222222-2222-2222-2222-222222222222/participation/resolve",
      expect.objectContaining({ method: "POST" }),
    );
    const request = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(request).toEqual({
      content: "What does this TypeScript error mean?",
      metadata: { clientMessageId: "client-message-1" },
      explicitOcto: false,
      replyToOcto: false,
      replyToHuman: false,
    });
  });

  it("preserves authoritative active-Octo coverage fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          decision: "silent",
          domain: "arithmetic",
          reason: "incorrect_arithmetic_follow_up_covered_by_active_octo",
          confidence: 100,
          participantCount: 2,
          targetMessageId: "message-1",
          coveredRunId: "run-1",
          coveredJobId: "job-1",
          coverage: "await_active_octo",
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        }),
      }),
    );

    await expect(
      resolveControllerConversationParticipation({
        conversationId: "22222222-2222-2222-2222-222222222222",
        content: "1 + 1 = 3",
      }),
    ).resolves.toMatchObject({
      decision: "silent",
      coveredRunId: "run-1",
      coveredJobId: "job-1",
      coverage: "await_active_octo",
    });
  });

  it("preserves completed-Octo coverage without treating it as a future action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          decision: "silent",
          domain: "arithmetic",
          reason: "incorrect_arithmetic_follow_up_covered_by_completed_octo",
          confidence: 100,
          participantCount: 2,
          targetMessageId: "message-1",
          coveredRunId: "run-1",
          coveredJobId: "job-1",
          coverage: "reuse_completed_octo",
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        }),
      }),
    );

    await expect(
      resolveControllerConversationParticipation({
        conversationId: "22222222-2222-2222-2222-222222222222",
        content: "1 + 1 = 3",
      }),
    ).resolves.toMatchObject({
      decision: "silent",
      coveredRunId: "run-1",
      coveredJobId: "job-1",
      coverage: "reuse_completed_octo",
    });
  });

  it("treats an unknown or incomplete coverage action as unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const coveragePayload of [
      {
        coveredRunId: "run-1",
        coveredJobId: "job-1",
        coverage: "future_action",
      },
      {
        coveredRunId: "run-1",
        coverage: "await_active_octo",
      },
    ]) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          decision: "silent",
          domain: "arithmetic",
          reason: "covered_follow_up",
          confidence: 100,
          participantCount: 2,
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
          ...coveragePayload,
        }),
      });

      await expect(
        resolveControllerConversationParticipation({
          conversationId: "22222222-2222-2222-2222-222222222222",
          content: "3",
        }),
      ).resolves.toBeNull();
    }

    warnSpy.mockRestore();
  });

  it.each([
    { status: 404, text: "" },
    { status: 404, text: "Not Found" },
    { status: 405, text: "" },
  ])(
    "reports unsupported for a missing resolver route ($status, '$text')",
    async ({ status, text }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status,
          text: vi.fn().mockResolvedValue(text),
        }),
      );

      await expect(
        resolveControllerConversationParticipation({
          conversationId: "22222222-2222-2222-2222-222222222222",
          content: "hello",
        }),
      ).resolves.toBe("unsupported");
    },
  );

  it("keeps a structured conversation 404 conservative", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue('{"message":"conversation not found"}'),
      }),
    );

    await expect(
      resolveControllerConversationParticipation({
        conversationId: "22222222-2222-2222-2222-222222222222",
        content: "hello",
      }),
    ).resolves.toBeNull();
    warnSpy.mockRestore();
  });

  it("keeps a server failure distinct from an unsupported rollout", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(
      resolveControllerConversationParticipation({
        conversationId: "22222222-2222-2222-2222-222222222222",
        content: "hello",
      }),
    ).resolves.toBeNull();
    warnSpy.mockRestore();
  });

  it("accepts every newer controller domain used by participation policy", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const domain of ["human_directed", "preference", "safety"] as const) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          decision: domain === "safety" ? "respond" : "silent",
          domain,
          reason: `test_${domain}`,
          confidence: 99,
          participantCount: 2,
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        }),
      });

      await expect(
        resolveControllerConversationParticipation({
          conversationId: "22222222-2222-2222-2222-222222222222",
          content: "test",
        }),
      ).resolves.toMatchObject({ domain });
    }
  });

  it("keeps an unknown response domain conservative", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          decision: "respond",
          domain: "future_unknown_domain",
          reason: "test_unknown",
          confidence: 99,
          participantCount: 2,
          policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
        }),
      }),
    );

    await expect(
      resolveControllerConversationParticipation({
        conversationId: "22222222-2222-2222-2222-222222222222",
        content: "test",
      }),
    ).resolves.toBeNull();
    warnSpy.mockRestore();
  });

  it("aborts a slow resolver after two seconds for a conservative caller fallback", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resolution = resolveControllerConversationParticipation({
      conversationId: "22222222-2222-2222-2222-222222222222",
      content: "Should Octo join this turn?",
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(resolution).resolves.toBeNull();
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    expect(signal?.aborted).toBe(true);
    warnSpy.mockRestore();
  });
});
