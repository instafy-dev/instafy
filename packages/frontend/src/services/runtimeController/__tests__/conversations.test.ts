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
  createBlankControllerConversation,
  fetchConversationMessagesFromController,
  fetchProjectConversationsFromController,
  recordControllerConversationMessage,
  resolveControllerConversationParticipation,
} from "../conversations";
import { readControllerError } from "../core";

describe("createBlankControllerConversation initial participants", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends participant IDs in the atomic private creation request", async () => {
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
    const proof = { conversationId: "conversation-created", initialParticipantUserIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(proof)));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      projectId: "project-1",
      metadata: { localId: "atomic-direct-local", visibility: "private", title: "Chat with teammate" },
      initialParticipantUserIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
    };
    await expect(createBlankControllerConversation(request)).resolves.toEqual(proof);
    await expect(createBlankControllerConversation(request)).resolves.toEqual(proof);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://controller.test/projects/project-1/conversations/blank");
    expect(JSON.parse(init.body)).toMatchObject({
      metadata: { visibility: "private" }, initialParticipantUserIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
    });
  });
});

describe("bounded project conversation discovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["credentials", "headers", "body"])("bounds stalled %s to ten seconds", async (stage) => {
    if (stage === "credentials") resolveControllerAccessTokenMock.mockReturnValue(new Promise(() => undefined));
    const fetchMock = vi.fn().mockImplementation(() => stage === "headers"
      ? new Promise(() => undefined)
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => undefined) }));
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchProjectConversationsFromController({ projectId: "project-1" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(request).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    if (stage === "credentials") expect(fetchMock).not.toHaveBeenCalled();
    else expect(fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it("forwards project-switch cancellation to the pending transport", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    const request = fetchProjectConversationsFromController({ projectId: "project-1", signal: caller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchConversationMessagesFromController", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
    vi.mocked(readControllerError).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("distinguishes explicit HTTP 403 denial from transient failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

    await expect(fetchConversationMessagesFromController({ conversationId: "conversation-1" }))
      .resolves.toBe("access_denied");
  });

  it("clears denied history from 403 headers without waiting for a stalled error body", async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelBody }), { status: 403 });
    const readBody = vi.spyOn(response, "text").mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(fetchConversationMessagesFromController({ conversationId: "conversation-1" }))
      .resolves.toBe("access_denied");

    expect(readControllerError).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps HTTP 401 retryable after the existing auth-recovery handler runs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = new Response(null, { status: 401 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(fetchConversationMessagesFromController({ conversationId: "conversation-1" }))
      .resolves.toBeNull();
    expect(readControllerError).toHaveBeenCalledWith(
      response,
      "fetch messages failed",
      expect.objectContaining({ accessToken: "token-123" }),
    );
  });

  it("keeps unavailable, missing, and genuinely empty history distinct", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], hasMore: false }))));

    const request = { conversationId: "conversation-1" };
    await expect(fetchConversationMessagesFromController(request)).resolves.toBeNull();
    await expect(fetchConversationMessagesFromController(request)).resolves.toBeNull();
    await expect(fetchConversationMessagesFromController(request)).resolves.toBe("not_found");
    await expect(fetchConversationMessagesFromController(request)).resolves.toEqual({
      messages: [], nextCursor: null, hasMore: false,
    });
  });

  it("does not start an already canceled history request", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationMessagesFromController({
      conversationId: "conversation-1", signal: abortController.signal,
    })).rejects.toBe(abortController.signal.reason);
    expect(resolveControllerAccessTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send a read canceled while authentication was resolving", async () => {
    vi.useFakeTimers();
    let resolveToken!: (token: string) => void;
    resolveControllerAccessTokenMock.mockReturnValue(new Promise<string>((resolve) => {
      resolveToken = resolve;
    }));
    const abortController = new AbortController();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchConversationMessagesFromController({
      conversationId: "conversation-1", signal: abortController.signal,
    });
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);

    abortController.abort();
    await rejection;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    resolveToken("token-123");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds credential resolution and consumes late authentication rejection", async () => {
    vi.useFakeTimers();
    let rejectToken!: (error: Error) => void;
    resolveControllerAccessTokenMock.mockReturnValue(new Promise<string>((_resolve, reject) => {
      rejectToken = reject;
    }));
    const abortController = new AbortController();
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchConversationMessagesFromController({
      conversationId: "conversation-1", signal: abortController.signal,
    });
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);

    rejectToken(new Error("Late authentication failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares one deadline across authentication and the HTTP request", async () => {
    vi.useFakeTimers();
    let resolveToken!: (token: string) => void;
    resolveControllerAccessTokenMock.mockReturnValue(new Promise<string>((resolve) => {
      resolveToken = resolve;
    }));
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchConversationMessagesFromController({ conversationId: "conversation-1" });
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).not.toHaveBeenCalled();
    resolveToken("token-123");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the deadline and caller listener when no credential is available", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolveControllerAccessTokenMock.mockResolvedValue(null);
    const abortController = new AbortController();
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationMessagesFromController({
      conversationId: "conversation-1", signal: abortController.signal,
    })).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an obsolete read without turning cancellation into a retryable failure", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abortController = new AbortController();
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }));
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchConversationMessagesFromController({
      conversationId: "conversation-1", signal: abortController.signal,
    });
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);

    abortController.abort();

    await rejection;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("bounds stalled history %s to ten seconds", async (stage) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const pending = new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
      return stage === "headers"
        ? pending
        : Promise.resolve({ ok: true, status: 200, json: () => pending });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchConversationMessagesFromController({ conversationId: "conversation-1" });
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds a stalled retryable error body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    vi.mocked(readControllerError).mockImplementationOnce(() => new Promise(() => undefined));
    const request = fetchConversationMessagesFromController({ conversationId: "conversation-1" });
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(readControllerError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up its deadline and caller listener after a successful read", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [], hasMore: false,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationMessagesFromController({
      conversationId: "conversation-1", cursor: "message-50", limit: 50,
      signal: abortController.signal,
    })).resolves.toEqual({ messages: [], nextCursor: null, hasMore: false });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://controller.test/conversations/conversation-1/messages?limit=50&cursor=message-50",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    abortController.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("re-resolves recovered authentication on the caller's next bounded attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abortController = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], hasMore: false })));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(readControllerError).mockImplementationOnce(async () => {
      resolveControllerAccessTokenMock.mockResolvedValue("recovered-token");
      return "Expired credential";
    });
    const request = { conversationId: "conversation-1", signal: abortController.signal };

    await expect(fetchConversationMessagesFromController(request)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await expect(fetchConversationMessagesFromController(request)).resolves.toEqual({
      messages: [], nextCursor: null, hasMore: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: "Bearer recovered-token" }, signal: expect.any(AbortSignal),
    });
    expect(abortController.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

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
