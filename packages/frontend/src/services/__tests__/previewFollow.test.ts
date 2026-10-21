import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtimeController/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtimeController/core")>();
  return {
    ...actual,
    runtimeControllerEnabled: true,
    resolveControllerRequestContext: vi.fn(async () => ({ baseUrl: "https://controller.test", accessToken: "token-1", credentialSource: "ambient" })),
    emitControllerAuthErrorForRequest: vi.fn(async () => true),
  };
});

import {
  FollowRateLimitedError,
  FollowReplacedError,
  getFollowState,
  mapFollowPresenceEvent,
  openFollowStream,
  parseFollowStreamEvent,
  sendFollowView,
  startPresenting,
  stopPresenting,
  type FollowStreamEvent,
} from "../runtimeController/previewFollow";

const PATH = "https://controller.test/projects/project-1/previews/preview-1/follow";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("follow relay client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("presents, sends views and heartbeats, and stops with keepalive", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { presentationId: "pres-1", presenter: { id: "u-kim", name: "Kim  Lee" }, startedAt: "2026-10-14T10:00:00Z" }));
    expect(await startPresenting("project-1", "preview-1")).toEqual({
      presentationId: "pres-1", presenter: { id: "u-kim", name: "Kim Lee", avatarUrl: null }, startedAt: "2026-10-14T10:00:00Z", replaced: null,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(PATH);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ op: "present" });
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer token-1");

    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await sendFollowView("project-1", "preview-1", { presentationId: "pres-1", seq: 1, payloadJson: '{"tab":"plan"}' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ op: "view", presentationId: "pres-1", seq: 1, payload: { tab: "plan" } });
    // No payload: a heartbeat.
    await sendFollowView("project-1", "preview-1", { presentationId: "pres-1", seq: 2 });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ op: "view", presentationId: "pres-1", seq: 2 });
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await stopPresenting("project-1", "preview-1", "pres-1", { keepalive: true });
    expect(fetchMock.mock.calls[3][1].keepalive).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ op: "stop", presentationId: "pres-1" });
  });

  it("turns 409 into who replaced us and 429 into when to retry", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { state: "replaced", presenter: { id: "u-lena", name: "Lena" } }));
    const replaced = await sendFollowView("project-1", "preview-1", { presentationId: "p", seq: 1 }).catch(error => error);
    expect(replaced).toBeInstanceOf(FollowReplacedError);
    expect(replaced.presenter).toEqual({ id: "u-lena", name: "Lena", avatarUrl: null });
    // Ended rather than replaced: the presentation is gone.
    fetchMock.mockResolvedValueOnce(json(409, { state: "ended", presenter: null, code: "presentation_ended" }));
    const ended = await sendFollowView("project-1", "preview-1", { presentationId: "p", seq: 1 }).catch(error => error);
    expect(ended).not.toBeInstanceOf(FollowReplacedError);
    expect(ended.status).toBe(410);
    const before = Date.now();
    fetchMock.mockResolvedValueOnce(json(429, { message: "slow down" }, { "retry-after": "2" }));
    const limited = await sendFollowView("project-1", "preview-1", { presentationId: "p", seq: 1 }).catch(error => error);
    expect(limited).toBeInstanceOf(FollowRateLimitedError);
    expect(limited.retryAt).toBeGreaterThanOrEqual(before + 2_000);
  });

  it("reads GET follow and the presence event", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {
      presentation: { presentationId: "pres-1", presenter: { id: "u-kim", name: "Kim" }, startedAt: "x", state: "away", seq: 4, payload: { a: 1 } },
      followers: [{ id: "u-mira", name: "Mira" }, { id: "u-lena", name: "Lena" }],
    }));
    const snapshot = await getFollowState("project-1", "preview-1");
    expect(snapshot.presence).toMatchObject({ presentationId: "pres-1", state: "away", followers: 2 });
    expect(snapshot.followers.map(person => person.name)).toEqual(["Mira", "Lena"]);
    fetchMock.mockResolvedValueOnce(json(200, { presentation: null, followers: [] }));
    expect((await getFollowState("project-1", "preview-1")).presence).toBeNull();

    expect(mapFollowPresenceEvent({ previewId: "preview-1", presentationId: "pres-1", state: "live", presenter: { id: "u-kim", name: "Kim" }, followers: 3 }))
      .toEqual({ previewId: "preview-1", presentationId: "pres-1", presence: { presentationId: "pres-1", presenter: { id: "u-kim", name: "Kim", avatarUrl: null }, state: "live", followers: 3 }, reason: null });
    expect(mapFollowPresenceEvent({ previewId: "preview-1", presentationId: "pres-1", state: "ended", presenter: { id: "u-kim", name: "Kim" }, followers: 0 })?.presence).toBeNull();
    // why it ended, when the controller says ("timeout": the presenter's screen went away)
    expect(mapFollowPresenceEvent({ previewId: "preview-1", presentationId: "pres-1", state: "ended", presenter: { id: "u-kim", name: "Kim" }, reason: "timeout" })?.reason).toBe("timeout");
    expect(mapFollowPresenceEvent({ previewId: "preview-1", presentationId: "pres-1", state: "ended", presenter: { id: "u-kim", name: "Kim" }, reason: "nonsense" })?.reason).toBeNull();
    expect(mapFollowPresenceEvent({ presentationId: "pres-1" })).toBeNull();
  });

  it("parses the stream's state, view, tap and end events", () => {
    expect(parseFollowStreamEvent("view", '{"seq":3,"payload":{"tab":"plan"},"at":1700}')).toEqual({ type: "view", seq: 3, payload: { tab: "plan" }, at: 1700 });
    expect(parseFollowStreamEvent("tap", '{"seq":4,"payload":{"x":0.5,"y":0.5}}')).toMatchObject({ type: "tap", seq: 4 });
    expect(parseFollowStreamEvent("end", '{"reason":"timeout"}')).toEqual({ type: "end", reason: "timeout" });
    expect(parseFollowStreamEvent("end", '{"reason":"weird"}')).toEqual({ type: "end", reason: "stopped" });
    expect(parseFollowStreamEvent("view", '{"payload":1}')).toBeNull();
    expect(parseFollowStreamEvent("view", "not json")).toBeNull();
    expect(parseFollowStreamEvent("other", "{}")).toBeNull();
  });

  it("follows over SSE with the bearer token and ends on end", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: state\ndata: {"presentation":{"presentationId":"pres-1","presenter":{"id":"u-kim","name":"Kim"},"state":"live"},"followers":[{"id":"u-mira","name":"Mira"}]}\n\n',
      'id: 5\nevent: view\ndata: {"seq":5,"payload":{"tab":"plan"}}\n\n',
      'event: end\ndata: {"reason":"stopped"}\n\n',
    ];
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const events: FollowStreamEvent[] = [];
    const onOpen = vi.fn();
    const handle = openFollowStream("project-1", "preview-1", { onEvent: event => events.push(event), onOpen });
    await vi.waitFor(() => expect(events.map(event => event.type)).toEqual(["state", "view", "end"]));
    expect(fetchMock.mock.calls[0][0]).toBe(`${PATH}/stream`);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ accept: "text/event-stream", authorization: "Bearer token-1" });
    expect(onOpen).toHaveBeenCalledOnce();
    // Ended: no reconnect.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledOnce();
    handle.close();
  });

  it("reconnects with Last-Event-ID, and gives up on 404", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('id: 9\nevent: view\ndata: {"seq":9,"payload":1}\n\n')); controller.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const onGone = vi.fn();
    const handle = openFollowStream("project-1", "preview-1", { onEvent: vi.fn(), onGone });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers["last-event-id"]).toBe("9");
    expect(onGone).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    handle.close();
  });
});
