// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

interface StreamingRequest {
  url: string;
  init: RequestInit;
  readonly cancelled: boolean;
  write: (chunk: string) => void;
  close: () => void;
}

const streamingRequests: StreamingRequest[] = [];
const encoder = new TextEncoder();

function installStreamingFetch(
  contentType = "Text/Event-Stream; charset=utf-8",
) {
  fetchMock.mockImplementation(
    (input: RequestInfo | URL, init: RequestInit = {}) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        },
      });
      const request: StreamingRequest = {
        url: String(input),
        init,
        get cancelled() {
          return cancelled;
        },
        write: (chunk) => streamController.enqueue(encoder.encode(chunk)),
        close: () => streamController.close(),
      };
      streamingRequests.push(request);
      return Promise.resolve({
        body,
        headers: new Headers({ "content-type": contentType }),
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        url: request.url,
      } as Response);
    },
  );
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function futureJwt(): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: "00000000-0000-4000-8000-000000000001",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

describe("runtime controller run event streaming", () => {
  beforeEach(() => {
    vi.resetModules();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
    });
    fetchMock.mockReset();
    streamingRequests.length = 0;
    installStreamingFetch();
    vi.stubEnv("VITE_CONTROLLER_URL", "https://controller.example.test");
    window.history.replaceState(null, "", "/studio");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    window.sessionStorage.clear();
  });

  it("does not open an authenticated event stream without a controller token", async () => {
    vi.useFakeTimers();
    getSessionMock.mockResolvedValueOnce({ data: { session: null } });
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );

    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();
    expect(fetchMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  it.each([
    { status: 401, statusText: "Unauthorized" },
    { status: 403, statusText: "Forbidden" },
  ])(
    "does not reconnect after a fixed credential is rejected with $status",
    async ({ status, statusText }) => {
      vi.useFakeTimers();
      const responseMessage = `fixed credential rejected (${status})`;
      fetchMock.mockImplementationOnce((input: RequestInfo | URL) =>
        Promise.resolve({
          body: null,
          headers: new Headers({ "content-type": "application/json" }),
          ok: false,
          status,
          statusText,
          text: async () => JSON.stringify({ message: responseMessage }),
          url: String(input),
        } as Response),
      );
      const controllerAuthError = vi.fn();
      window.addEventListener(
        "instafy:controller-auth-error",
        controllerAuthError,
      );

      const { subscribeToRunsFromController } = await import(
        "../runtimeController/runs"
      );
      const onError = vi.fn();
      const onAccessDenied = vi.fn();
      const unsubscribe = subscribeToRunsFromController({
        projectId: "11111111-1111-4111-8111-111111111111",
        accessToken: "caller-supplied-fixed-token",
        quietErrors: true,
        onRun: vi.fn(),
        onAccessDenied,
        onError,
      });

      await vi.advanceTimersByTimeAsync(0);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"),
      ).toBe("Bearer caller-supplied-fixed-token");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(responseMessage);
      expect(onAccessDenied).toHaveBeenCalledOnce();
      expect(onAccessDenied).toHaveBeenCalledWith({
        status,
        message: responseMessage,
      });

      if (status === 401) {
        // A one-off fixed credential is not the active ambient binding, so
        // rejecting it must not even consult or invalidate that session.
        expect(getSessionMock).not.toHaveBeenCalled();
      }
      expect(controllerAuthError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      unsubscribe();
      window.removeEventListener(
        "instafy:controller-auth-error",
        controllerAuthError,
      );
    },
  );

  it.each([
    { status: 401, statusText: "Unauthorized" },
    { status: 403, statusText: "Forbidden" },
  ])(
    "does not reconnect after the current ambient credential is rejected with $status",
    async ({ status, statusText }) => {
      vi.useFakeTimers();
      const responseMessage = `ambient credential rejected (${status})`;
      fetchMock.mockImplementationOnce((input: RequestInfo | URL) =>
        Promise.resolve({
          body: null,
          headers: new Headers({ "content-type": "application/json" }),
          ok: false,
          status,
          statusText,
          text: async () => JSON.stringify({ message: responseMessage }),
          url: String(input),
        } as Response),
      );
      const controllerAuthError = vi.fn();
      window.addEventListener(
        "instafy:controller-auth-error",
        controllerAuthError,
      );

      const { subscribeToRunsFromController } = await import(
        "../runtimeController/runs"
      );
      const onError = vi.fn();
      const onAccessDenied = vi.fn();
      const unsubscribe = subscribeToRunsFromController({
        projectId: "11111111-1111-4111-8111-111111111111",
        quietErrors: true,
        onRun: vi.fn(),
        onAccessDenied,
        onError,
      });

      await vi.advanceTimersByTimeAsync(0);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"),
      ).toBe("Bearer test-access-token");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(responseMessage);
      expect(onAccessDenied).toHaveBeenCalledOnce();
      expect(onAccessDenied).toHaveBeenCalledWith({
        status,
        message: responseMessage,
      });
      expect(getSessionMock).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
      expect(controllerAuthError).toHaveBeenCalledTimes(status === 401 ? 1 : 0);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      unsubscribe();
      window.removeEventListener(
        "instafy:controller-auth-error",
        controllerAuthError,
      );
    },
  );

  it("reconnects a stale ambient 401 with the refreshed session token", async () => {
    vi.useFakeTimers();
    getSessionMock
      .mockResolvedValueOnce({
        data: { session: { access_token: "stale-session-token" } },
      })
      .mockResolvedValue({
        data: { session: { access_token: "refreshed-session-token" } },
      });
    fetchMock.mockImplementationOnce((input: RequestInfo | URL) =>
      Promise.resolve({
        body: null,
        headers: new Headers({ "content-type": "application/json" }),
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => JSON.stringify({ message: "stale token rejected" }),
        url: String(input),
      } as Response),
    );
    const controllerAuthError = vi.fn();
    window.addEventListener(
      "instafy:controller-auth-error",
      controllerAuthError,
    );

    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onOpen = vi.fn();
    const onAccessDenied = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onAccessDenied,
      onError,
      onOpen,
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("Bearer stale-session-token");
    expect(onError).toHaveBeenCalledWith("stale token rejected");
    expect(onAccessDenied).not.toHaveBeenCalled();
    expect(controllerAuthError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization"),
    ).toBe("Bearer refreshed-session-token");
    expect(onOpen).toHaveBeenCalledOnce();
    expect(getSessionMock).toHaveBeenCalledTimes(4);
    expect(controllerAuthError).not.toHaveBeenCalled();

    unsubscribe();
    window.removeEventListener(
      "instafy:controller-auth-error",
      controllerAuthError,
    );
  });

  it("signals terminal access denial when an ambient 401 finds no replacement session", async () => {
    vi.useFakeTimers();
    getSessionMock
      .mockResolvedValueOnce({
        data: { session: { access_token: "expired-session-token" } },
      })
      .mockResolvedValue({ data: { session: null } });
    fetchMock.mockImplementationOnce((input: RequestInfo | URL) =>
      Promise.resolve({
        body: null,
        headers: new Headers({ "content-type": "application/json" }),
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => JSON.stringify({ message: "session expired" }),
        url: String(input),
      } as Response),
    );

    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onAccessDenied = vi.fn();
    const onError = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onAccessDenied,
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAccessDenied).toHaveBeenCalledWith({
      status: 401,
      message: "session expired",
    });
    expect(onError).toHaveBeenCalledWith("session expired");
    expect(getSessionMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("treats HTTP 204 as a clean terminal response", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((input: RequestInfo | URL) =>
      Promise.resolve({
        body: null,
        headers: new Headers(),
        ok: true,
        status: 204,
        statusText: "No Content",
        text: async () => "",
        url: String(input),
      } as Response),
    );

    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onOpen = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onOpen,
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("authenticates with a header and parses chunked multiline CRLF events", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onEvent,
      onOpen,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    const request = streamingRequests[0];
    const url = new URL(request.url);
    const headers = new Headers(request.init.headers);
    expect(url.searchParams.get("projectId")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(url.searchParams.getAll("kinds[]")).toContain(
      "project.access_changed",
    );
    expect(url.searchParams.has("accessToken")).toBe(false);
    expect(request.url).not.toContain("test-access-token");
    expect(headers.get("authorization")).toBe("Bearer test-access-token");
    expect(headers.get("accept")).toBe("text/event-stream");

    request.write(": keep-alive\r");
    request.write(
      '\nevent: controller\r\nid: event-1\r\nretry: 25\r\ndata: {\r\ndata:   "kind": "project.access_changed",\r\ndata:   "project_id": "11111111-1111-4111-8111-111111111111",\r\ndata:   "data": {"reason":"membership_changed"}\r\ndata: }\r\n\r\n',
    );

    const event = {
      kind: "project.access_changed",
      project_id: "11111111-1111-4111-8111-111111111111",
      data: { reason: "membership_changed" },
    };
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(event));

    request.write(
      `data: ${JSON.stringify({ ...event, data: { reason: "buffered" } })}`,
    );
    unsubscribe();
    await flushAsyncWork();
    expect((request.init.signal as AbortSignal).aborted).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("discards a pending event when the stream ends without a blank line", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    vi.useFakeTimers();
    const request = streamingRequests[0];
    request.write(
      `data: ${JSON.stringify({
        kind: "project.access_changed",
        project_id: "11111111-1111-4111-8111-111111111111",
        data: { reason: "incomplete" },
      })}\n`,
    );
    request.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("event stream error");

    unsubscribe();
  });

  it("does not acknowledge an id from an incomplete block when reconnecting", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    vi.useFakeTimers();
    streamingRequests[0].write(
      `id: incomplete-event\ndata: ${JSON.stringify({
        kind: "project.access_changed",
        project_id: "11111111-1111-4111-8111-111111111111",
        data: { reason: "incomplete" },
      })}\n`,
    );
    streamingRequests[0].close();
    await vi.advanceTimersByTimeAsync(0);

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("event stream error");

    await vi.advanceTimersByTimeAsync(2999);
    expect(streamingRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(streamingRequests).toHaveLength(2);
    const reconnectHeaders = new Headers(streamingRequests[1].init.headers);
    expect(reconnectHeaders.get("last-event-id")).toBeNull();

    unsubscribe();
  });

  it("acknowledges an id-only completed block without dispatching data", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    vi.useFakeTimers();
    streamingRequests[0].write("id: completed-id-only-block\n\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).not.toHaveBeenCalled();

    streamingRequests[0].close();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith("event stream error");

    await vi.advanceTimersByTimeAsync(2999);
    expect(streamingRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(streamingRequests).toHaveLength(2);
    const reconnectHeaders = new Headers(streamingRequests[1].init.headers);
    expect(reconnectHeaders.get("last-event-id")).toBe(
      "completed-id-only-block",
    );
    expect(onEvent).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("uses SSE retry and Last-Event-ID values when reconnecting", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
      onOpen,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    streamingRequests[0].write(
      `id: event-7\nretry: 25\ndata: ${JSON.stringify({
        kind: "project.access_changed",
        project_id: "11111111-1111-4111-8111-111111111111",
        data: { reason: "membership_changed" },
      })}\n\n`,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).toHaveBeenCalledOnce();

    streamingRequests[0].close();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith("event stream error");
    expect(streamingRequests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(24);
    expect(streamingRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(streamingRequests).toHaveLength(2);
    expect(onOpen).toHaveBeenCalledTimes(2);
    const reconnectHeaders = new Headers(streamingRequests[1].init.headers);
    expect(reconnectHeaders.get("last-event-id")).toBe("event-7");
    expect(reconnectHeaders.get("authorization")).toBe(
      "Bearer test-access-token",
    );

    unsubscribe();
  });

  it("rejects a non-SSE Content-Type before opening and reconnects safely", async () => {
    fetchMock.mockReset();
    installStreamingFetch("application/json; charset=utf-8");
    vi.useFakeTimers();

    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
      onOpen,
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    expect(streamingRequests).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'event stream protocol error: expected Content-Type text/event-stream; received Content-Type "application/json; charset=utf-8"',
    );
    expect(streamingRequests[0].cancelled).toBe(true);
    expect(
      (streamingRequests[0].init.signal as AbortSignal).aborted,
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(2999);
    expect(streamingRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(streamingRequests).toHaveLength(2);

    unsubscribe();
  });

  it("dispatches a valid Axum-style single-line event larger than 64 KiB", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    const event = {
      kind: "project.access_changed",
      project_id: "11111111-1111-4111-8111-111111111111",
      data: { reason: "x".repeat(70 * 1024) },
    };
    const eventLine = `data: ${JSON.stringify(event)}\n\n`;
    expect(encoder.encode(eventLine).byteLength).toBeGreaterThan(64 * 1024);

    streamingRequests[0].write(eventLine);

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(event));
    expect(onError).not.toHaveBeenCalled();
    expect(streamingRequests[0].cancelled).toBe(false);

    unsubscribe();
  });

  it("cancels a stream when an individual SSE line exceeds the event-data ceiling", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    vi.useFakeTimers();
    const request = streamingRequests[0];
    request.write(`retry: 0\ndata: ${"x".repeat(1024 * 1024 + 16)}`);
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "event stream protocol error: line exceeds 1048585-byte limit",
    );
    expect(request.cancelled).toBe(true);
    expect((request.init.signal as AbortSignal).aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(2999);
    expect(streamingRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(streamingRequests).toHaveLength(2);

    unsubscribe();
  });

  it("cancels a stream when one event accumulates more than 1 MiB of data", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
      onEvent,
    });

    await vi.waitFor(() => expect(streamingRequests).toHaveLength(1));
    const request = streamingRequests[0];
    const boundedDataLine = `data: ${"x".repeat(60 * 1024)}\n`;
    request.write(boundedDataLine.repeat(18));

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "event stream protocol error: event data exceeds 1048576-byte limit",
      ),
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(request.cancelled).toBe(true);
    expect((request.init.signal as AbortSignal).aborted).toBe(true);

    unsubscribe();
  });

  it("stops a rejected custom-controller stream at the reload boundary", async () => {
    const overrideToken = futureJwt();
    window.sessionStorage.setItem(
      "instafy.controllerBinding",
      JSON.stringify({
        version: 1,
        token: overrideToken,
        baseUrl: "https://override-controller.example.test",
      }),
    );
    fetchMock.mockImplementationOnce((input: RequestInfo | URL) =>
      Promise.resolve({
        body: null,
        headers: new Headers({ "content-type": "application/json" }),
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => JSON.stringify({ message: "expired override" }),
        url: String(input),
      } as Response),
    );
    vi.useFakeTimers();

    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onError = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    const firstHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(new URL(firstUrl).origin).toBe(
      "https://override-controller.example.test",
    );
    expect(firstUrl).not.toContain(overrideToken);
    expect(new URL(firstUrl).searchParams.has("accessToken")).toBe(false);
    expect(firstHeaders.get("authorization")).toBe(`Bearer ${overrideToken}`);
    expect(onError).not.toHaveBeenCalled();

    const core = await import("../runtimeController/core");
    expect(core.isControllerDocumentReloadPending()).toBe(true);
    expect(window.sessionStorage.getItem("instafy.controllerBaseUrl")).toBeNull();
    expect(window.sessionStorage.getItem("instafy.controllerAccessToken")).toBeNull();

    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamingRequests).toHaveLength(0);

    unsubscribe();
  });

  it("does not fetch when unsubscribed before token resolution", async () => {
    let resolveSession!: (value: {
      data: { session: { access_token: string } };
    }) => void;
    getSessionMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
    });

    unsubscribe();
    resolveSession({
      data: { session: { access_token: "too-late-token" } },
    });
    await flushAsyncWork();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
