// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SitePreviewPane } from "../SitePreviewPane";
import { useSiteHost } from "../previewHost/useSiteHost";
import { applyFollowPresenceEvent, endOwnPresentation, followEntry, requestFollow, resetFollowStoreForTests } from "../previewHost/followStore";
import type { FollowStreamEvent } from "../../../../services/runtimeController/previewFollow";

// docs/Follow-Mode.md (Studio): follow mode in the site preview pane.

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const FIRST = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--0123456789abcdef0123456789abcdef.preview.localhost/";
const ORIGIN = new URL(FIRST).origin;
const kim = { id: "u-kim", name: "Kim", avatarUrl: null };
const lena = { id: "u-lena", name: "Lena", avatarUrl: null };

const mocks = vi.hoisted(() => ({
  createSitePreviewViewer: vi.fn(),
  getSitePreview: vi.fn(),
  heartbeatSitePreviewViewer: vi.fn(),
  revokeSitePreviewViewer: vi.fn(),
  getFollowState: vi.fn(),
  startPresenting: vi.fn(),
  sendFollowView: vi.fn(),
  sendFollowTap: vi.fn(),
  stopPresenting: vi.fn(),
  openFollowStream: vi.fn(),
  selfId: null as string | null,
}));
vi.mock("../../../../providers/AuthProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../providers/AuthProvider")>()),
  useOptionalUserId: () => mocks.selfId,
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  createSitePreviewViewer: mocks.createSitePreviewViewer,
  getSitePreview: mocks.getSitePreview,
  heartbeatSitePreviewViewer: mocks.heartbeatSitePreviewViewer,
  revokeSitePreviewViewer: mocks.revokeSitePreviewViewer,
}));
vi.mock("../../../../services/runtimeController/previewFollow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../services/runtimeController/previewFollow")>();
  return {
    ...actual,
    getFollowState: mocks.getFollowState,
    startPresenting: mocks.startPresenting,
    sendFollowView: mocks.sendFollowView,
    sendFollowTap: mocks.sendFollowTap,
    stopPresenting: mocks.stopPresenting,
    openFollowStream: mocks.openFollowStream,
  };
});

function record() {
  return { previewId: PREVIEW_ID, title: "Site preview", port: 4173, path: "/", runtimeId: "runtime-1",
    status: "active", health: { listening: true, status: 200 }, messageId: null, createdAt: null };
}

describe("SitePreviewPane follow mode", () => {
  let root: Root;
  let container: HTMLDivElement;
  const server: { presence: unknown } = { presence: null };
  let stream: { handlers: { onEvent: (event: FollowStreamEvent) => void; onOpen?: () => void; onGone?: () => void } | null; close: ReturnType<typeof vi.fn>; opened: number };

  async function render() {
    await act(async () => root.render(<SitePreviewPane projectId="project-1" previewId={PREVIEW_ID} title="Site preview" visible />));
    await flush();
  }
  async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
  async function wait(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  const q = (selector: string) => container.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
  async function click(selector: string) {
    const element = q(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => element!.click());
    await flush();
  }
  const present = () => click("[data-testid=follow-present]");
  const frame = () => container.querySelector<HTMLIFrameElement>("[data-testid=site-preview-frame]")!;
  async function fromSite(type: string, extra: Record<string, unknown> = {}) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { source: "site-kit", v: 1, type, ...extra }, origin: ORIGIN, source: frame().contentWindow }));
    });
    await flush();
  }
  const ack = (supports: string[]) => fromSite("layout-ack", { payload: { v: 1, supports } });
  let sent: { mock: { calls: unknown[][] } };
  const toSite = (type: string) => sent.mock.calls.map(call => call[0] as Record<string, unknown>).filter(message => message.type === type);
  async function streamEvent(event: FollowStreamEvent) {
    await act(async () => stream.handlers!.onEvent(event));
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    Object.values(mocks).forEach(mock => { if (typeof mock === "function" && "mockReset" in mock) mock.mockReset(); });
    mocks.selfId = null;
    mocks.createSitePreviewViewer.mockResolvedValue({ viewerUrl: FIRST, idleTimeoutSeconds: 1800, expiresAt: null });
    mocks.getSitePreview.mockResolvedValue(record());
    mocks.heartbeatSitePreviewViewer.mockResolvedValue("live");
    mocks.revokeSitePreviewViewer.mockResolvedValue(undefined);
    // The relay's view of the preview: GET follow answers from it, Present and Stop change it.
    server.presence = null;
    mocks.getFollowState.mockImplementation(async () => ({ presence: server.presence, followers: [] }));
    mocks.startPresenting.mockImplementation(async () => {
      server.presence = { presentationId: "pres-me", presenter: lena, state: "live", followers: 0 };
      return { presentationId: "pres-me", presenter: lena, startedAt: null, replaced: null };
    });
    mocks.sendFollowView.mockResolvedValue(undefined);
    mocks.sendFollowTap.mockResolvedValue(undefined);
    mocks.stopPresenting.mockImplementation(async () => { server.presence = null; });
    stream = { handlers: null, close: vi.fn(), opened: 0 };
    mocks.openFollowStream.mockImplementation((_project: string, _preview: string, handlers: typeof stream.handlers) => {
      stream.handlers = handlers; stream.opened += 1;
      return { close: stream.close };
    });
    localStorage.clear();
    resetFollowStoreForTests();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
    resetFollowStoreForTests();
  });

  async function renderAcked(supports = ["view"]) {
    await render();
    sent = vi.spyOn(frame().contentWindow!, "postMessage").mockImplementation(() => undefined);
    await ack(supports);
  }

  describe("presenting", () => {
    it("offers Present only for a site whose ack lists view, and tells that site it presents", async () => {
      await render();
      sent = vi.spyOn(frame().contentWindow!, "postMessage").mockImplementation(() => undefined);
      // A site that never said it can share its view gets no Present at all.
      expect(q("[data-testid=follow-present]")).toBeNull();
      await ack(["tap"]);
      expect(q("[data-testid=follow-present]")).toBeNull();
      await ack(["view", "tap"]);
      // A second ack without the list (another script on the page) keeps "view".
      await ack([]);
      expect(q("[data-testid=follow-present]")!.getAttribute("aria-label")).toBe("Present to the space");
      await present();
      expect(mocks.startPresenting).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID);
      expect(toSite("present")).toEqual([{ source: "instafy-host", v: 1, type: "present", on: true, share: { location: false } }]);
      expect(sent.mock.calls.every(call => call[1] === ORIGIN)).toBe(true);
      expect(q("[data-testid=follow-bar-chip]")!.dataset.role).toBe("presenting");
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Presenting");
      expect(followEntry(PREVIEW_ID)).toMatchObject({ role: "presenting", presence: { presentationId: "pres-me" } });
    });

    it("forwards views coalesced to 10 a second, latest winning, and keeps them out of chat", async () => {
      await renderAcked();
      await present();
      for (let i = 0; i < 30; i += 1) {
        await fromSite("view", { seq: i, payload: { i } });
        await wait(10);
      }
      await wait(500);
      const views = mocks.sendFollowView.mock.calls.map(call => call[2] as { seq: number; payloadJson?: string });
      expect(views[0]).toMatchObject({ presentationId: "pres-me", seq: 1, payloadJson: '{"i":0}' });
      expect(views.length).toBeLessThanOrEqual(5);
      expect(views.at(-1)!.payloadJson).toBe('{"i":29}');
      // Studio's own seq, increasing.
      expect(views.map(view => view.seq)).toEqual(views.map((_, index) => index + 1));
      // Oversize or not plain JSON: dropped.
      const before = mocks.sendFollowView.mock.calls.length;
      await fromSite("view", { payload: { s: "x".repeat(2100) } });
      await wait(200);
      expect(mocks.sendFollowView.mock.calls.length).toBe(before);
      // Quiet for 5 s: an empty view says the presenter is still there.
      await wait(5_000);
      const heartbeat = mocks.sendFollowView.mock.calls.at(-1)![2] as { payloadJson?: string };
      expect(heartbeat.payloadJson).toBeUndefined();
    });

    it("never forwards views before Present, nor taps beyond 5 a second", async () => {
      await renderAcked(["view", "tap"]);
      await fromSite("view", { payload: { i: 1 } });
      await wait(200);
      expect(mocks.sendFollowView).not.toHaveBeenCalled();
      await present();
      for (let i = 0; i < 8; i += 1) await fromSite("tap", { payload: { x: 0.1 * i, y: 0.5 } });
      expect(mocks.sendFollowTap).toHaveBeenCalledTimes(5);
      expect(mocks.sendFollowTap.mock.calls[0][2]).toMatchObject({ presentationId: "pres-me", payloadJson: '{"x":0,"y":0.5}' });
    });

    it("Stop ends it for everyone and tells the site", async () => {
      await renderAcked();
      await present();
      await click("[data-testid=follow-action]");
      expect(mocks.stopPresenting).toHaveBeenCalledWith("project-1", PREVIEW_ID, "pres-me");
      expect(toSite("present").at(-1)).toMatchObject({ on: false });
      expect(q("[data-testid=follow-bar-chip]")).toBeNull();
      expect(followEntry(PREVIEW_ID).presence).toBeNull();
    });

    it("stops with keepalive when the page goes away", async () => {
      await renderAcked();
      await present();
      await act(async () => { window.dispatchEvent(new Event("pagehide")); });
      expect(mocks.stopPresenting).toHaveBeenCalledWith("project-1", PREVIEW_ID, "pres-me", { keepalive: true });
    });

    it("keeps presenting when the pane goes away without its tab closing (a run tab), and picks it up again", async () => {
      // Opening a run tab unmounts the pane: the presentation must not end for everyone without a word.
      await renderAcked();
      await present();
      await fromSite("view", { payload: { tab: "plan" } });
      await wait(200);
      await fromSite("view", { payload: { tab: "places" } });
      await wait(200);
      const seqs = () => mocks.sendFollowView.mock.calls.map(call => (call[2] as { seq: number }).seq);
      const lastSeqBefore = Math.max(...seqs());
      expect(lastSeqBefore).toBeGreaterThanOrEqual(2);
      await act(async () => root.unmount());
      root = createRoot(container);
      expect(mocks.stopPresenting).not.toHaveBeenCalled();
      // Back in the conversation: the pane presents again, at once, with no second Present.
      mocks.sendFollowView.mockClear();
      await renderAcked();
      await wait(0);
      expect(mocks.startPresenting).toHaveBeenCalledOnce();
      expect(mocks.sendFollowView).toHaveBeenCalledWith("project-1", PREVIEW_ID, expect.objectContaining({ presentationId: "pres-me" }));
      // It carries on from the last seq the old pane sent: the relay drops anything not above it.
      await fromSite("view", { payload: { tab: "map" } });
      await wait(200);
      expect(Math.min(...seqs())).toBeGreaterThan(lastSeqBefore);
      expect(seqs()).toEqual([...seqs()].sort((a, b) => a - b));
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Presenting");
      expect(toSite("present").at(-1)).toMatchObject({ on: true });
      // Closing the preview's tab is what ends it.
      await act(async () => root.unmount());
      root = createRoot(container);
      endOwnPresentation(PREVIEW_ID);
      expect(mocks.stopPresenting).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, "pres-me", { keepalive: true });
      expect(followEntry(PREVIEW_ID).presence).toBeNull();
    });

    it("says so when the presentation ended while its pane was away", async () => {
      const { ControllerApiError } = await import("../../../../services/runtimeController/core");
      await renderAcked();
      await present();
      await act(async () => root.unmount());
      root = createRoot(container);
      // The relay timed it out meanwhile.
      server.presence = null;
      mocks.sendFollowView.mockRejectedValueOnce(new ControllerApiError({ status: 410, message: "This presentation has ended.", code: "presentation_ended", details: null }));
      await renderAcked();
      await flush();
      expect(q("[data-testid=follow-note]")!.textContent).toBe("Your presentation ended while you were away");
      expect(q("[data-testid=follow-bar-chip]")).toBeNull();
      // Forgotten: a later pane does not try again.
      await act(async () => root.unmount());
      root = createRoot(container);
      mocks.sendFollowView.mockClear();
      await renderAcked();
      await wait(2_000);
      expect(mocks.sendFollowView).not.toHaveBeenCalled();
    });

    it("after a 429 sends the newest view, not the one that was refused", async () => {
      const { FollowRateLimitedError } = await import("../../../../services/runtimeController/previewFollow");
      await renderAcked();
      await present();
      let refuse: (cause: unknown) => void = () => undefined;
      mocks.sendFollowView.mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
      await fromSite("view", { payload: { i: 1 } });
      await wait(150);
      await fromSite("view", { payload: { i: 2 } });
      await wait(150);
      await act(async () => refuse(new FollowRateLimitedError(Date.now() + 1_000)));
      await wait(1_200);
      const payloads = mocks.sendFollowView.mock.calls.map(call => (call[2] as { payloadJson?: string }).payloadJson);
      expect(payloads.at(-1)).toBe('{"i":2}');
      expect(payloads.filter(payload => payload === '{"i":1}')).toHaveLength(1);
    });

    it("tells a presenter whose page comes back after the relay ended it (the phone was on the call screen)", async () => {
      const { ControllerApiError } = await import("../../../../services/runtimeController/core");
      await renderAcked();
      await present();
      mocks.sendFollowView.mockRejectedValueOnce(new ControllerApiError({ status: 410, message: "This presentation has ended.", code: "presentation_ended", details: null }));
      await fromSite("view", { payload: { i: 1 } });
      await flush();
      expect(toSite("present").at(-1)).toMatchObject({ on: false });
      expect(q("[data-testid=follow-note]")!.textContent).toBe("Your presentation ended while you were away");
      expect(q("[data-testid=follow-bar-chip]")).toBeNull();
    });

    it("offers the person's own presentation from another screen as Stop, never as someone to follow", async () => {
      mocks.selfId = "u-lena";
      server.presence = { presentationId: "pres-other", presenter: lena, state: "live", followers: 1 };
      applyFollowPresenceEvent(PREVIEW_ID, "pres-other", { presentationId: "pres-other", presenter: lena, state: "live", followers: 1 });
      await renderAcked();
      expect(q("[data-testid=follow-status]")!.textContent).toBe("You're presenting on another screen");
      expect(q("[data-testid=follow-action]")!.textContent).toBe("Stop");
      expect(q("[data-testid=follow-present]")!.getAttribute("aria-label")).toBe("Present from here");
      await click("[data-testid=follow-action]");
      expect(mocks.stopPresenting).toHaveBeenCalledWith("project-1", PREVIEW_ID, "pres-other");
      expect(mocks.openFollowStream).not.toHaveBeenCalled();
      expect(q("[data-testid=follow-bar-chip]")).toBeNull();
      expect(q("[data-testid=follow-note]")).toBeNull();
    });

    it("hands over when someone else presents: the next view gets 409 and the pill says who", async () => {
      const { FollowReplacedError } = await import("../../../../services/runtimeController/previewFollow");
      await renderAcked();
      await present();
      mocks.sendFollowView.mockRejectedValueOnce(new FollowReplacedError(kim));
      server.presence = { presentationId: "pres-kim", presenter: kim, state: "live", followers: 0 };
      await fromSite("view", { payload: { i: 1 } });
      await flush();
      expect(toSite("present").at(-1)).toMatchObject({ on: false });
      expect(q("[data-testid=follow-note]")!.textContent).toBe("Kim is presenting now");
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Kim is presenting");
      expect(q("[data-testid=follow-action]")!.textContent).toBe("Follow");
    });
  });

  describe("following", () => {
    async function offered(supports = ["view"]) {
      server.presence = { presentationId: "pres-kim", presenter: kim, state: "live", followers: 1 };
      applyFollowPresenceEvent(PREVIEW_ID, "pres-kim", { presentationId: "pres-kim", presenter: kim, state: "live", followers: 1 });
      await renderAcked(supports);
    }
    async function following(supports = ["view"]) {
      await offered(supports);
      await click("[data-testid=follow-action]");
      expect(stream.opened).toBe(1);
    }

    it("shows who presents and follows with one tap: a jump first, then smooth moves", async () => {
      await offered();
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Kim is presenting");
      expect(q("[data-testid=follow-action]")!.textContent).toBe("Follow");
      expect(q("[data-testid=follow-ring]")).toBeNull();
      await click("[data-testid=follow-action]");
      expect(mocks.openFollowStream).toHaveBeenCalledWith("project-1", PREVIEW_ID, expect.anything());
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Following Kim");
      expect(q("[data-testid=follow-ring]")).not.toBeNull();
      await streamEvent({ type: "view", seq: 3, payload: { tab: "plan" }, at: null });
      await streamEvent({ type: "view", seq: 4, payload: { tab: "plan", day: 3 }, at: null });
      expect(toSite("apply-view")).toEqual([
        { source: "instafy-host", v: 1, type: "apply-view", seq: 3, payload: { tab: "plan" }, from: { id: "u-kim", name: "Kim" }, smooth: false },
        { source: "instafy-host", v: 1, type: "apply-view", seq: 4, payload: { tab: "plan", day: 3 }, from: { id: "u-kim", name: "Kim" }, smooth: true },
      ]);
      // A reconnect jumps again.
      await act(async () => stream.handlers!.onOpen!());
      await streamEvent({ type: "view", seq: 5, payload: { tab: "places" }, at: null });
      expect(toSite("apply-view").at(-1)).toMatchObject({ seq: 5, smooth: false });
    });

    it("sends apply-view only to a site whose ack lists view, catching it up once it does", async () => {
      await following([]);
      await streamEvent({ type: "view", seq: 1, payload: { tab: "plan" }, at: null });
      expect(toSite("apply-view")).toEqual([]);
      await ack(["view"]);
      expect(toSite("apply-view")).toEqual([expect.objectContaining({ seq: 1, smooth: false })]);
    });

    it("stops on the person's own gesture, not on the apply's echo, and Follow again catches up", async () => {
      await following();
      await streamEvent({ type: "view", seq: 1, payload: { a: 1 }, at: null });
      await wait(100);
      await fromSite("interact");
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Following Kim");
      await wait(300);
      await fromSite("interact");
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Kim is presenting");
      expect(q("[data-testid=follow-action]")!.textContent).toBe("Follow again");
      expect(stream.close).toHaveBeenCalled();
      expect(q("[data-testid=follow-ring]")).toBeNull();
      await click("[data-testid=follow-action]");
      expect(stream.opened).toBe(2);
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Following Kim");
    });

    it("stops when the person clicks into the frame, but not for Studio's own chrome", async () => {
      await following();
      // Studio chrome: Reload in the bar, focus moving to the composer.
      await click("[data-testid=site-preview-reload]");
      const composer = document.createElement("textarea");
      document.body.appendChild(composer);
      composer.focus();
      await act(async () => { window.dispatchEvent(new Event("blur")); });
      await wait(10);
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Following Kim");
      // The person taps the site itself: focus moves into the frame.
      frame().focus();
      await act(async () => { window.dispatchEvent(new Event("blur")); });
      await wait(10);
      expect(q("[data-testid=follow-action]")!.textContent).toBe("Follow again");
      composer.remove();
    });

    it("draws the presenter's taps with their name for a site that does not, and leaves them to one that does", async () => {
      await following();
      await streamEvent({ type: "tap", seq: 2, payload: { x: 0.25, y: 0.5 }, at: null });
      const ripple = q("[data-testid=follow-ripple]")!;
      expect(ripple.style.left).toBe("25%");
      expect(ripple.style.top).toBe("50%");
      expect(ripple.textContent).toBe("Kim");
      await wait(1_200);
      expect(q("[data-testid=follow-ripple]")).toBeNull();
      expect(toSite("apply-tap")).toEqual([]);
      await ack(["view", "tap"]);
      await streamEvent({ type: "tap", seq: 3, payload: { x: 0.1, y: 0.2, at: { id: "stop-3" } }, at: null });
      expect(q("[data-testid=follow-ripple]")).toBeNull();
      expect(toSite("apply-tap")).toEqual([{ source: "instafy-host", v: 1, type: "apply-tap", payload: { x: 0.1, y: 0.2, at: { id: "stop-3" } }, from: { id: "u-kim", name: "Kim" } }]);
    });

    it("follows the preview through a takeover, shows away, and says when it ended", async () => {
      await following();
      await streamEvent({ type: "state", snapshot: { presence: { presentationId: "pres-kim", presenter: kim, state: "away", followers: 1 }, followers: [] } });
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Kim is away");
      await streamEvent({ type: "state", snapshot: { presence: { presentationId: "pres-lena", presenter: lena, state: "live", followers: 1 }, followers: [] } });
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Following Lena");
      expect(q("[data-testid=follow-note]")!.textContent).toBe("Lena took over from Kim");
      await wait(3_000);
      expect(q("[data-testid=follow-note]")).toBeNull();
      await streamEvent({ type: "end", reason: "stopped" });
      expect(q("[data-testid=follow-note]")!.textContent).toBe("Lena stopped presenting");
      expect(q("[data-testid=follow-bar-chip]")).toBeNull();
      await wait(4_000);
      expect(q("[data-testid=follow-note]")).toBeNull();
    });

    it("says Kim went away (not that she stopped), and follows her again when she presents again", async () => {
      await following();
      await streamEvent({ type: "end", reason: "timeout" });
      expect(q("[data-testid=follow-note]")!.textContent).toBe("Kim went away, so following stopped");
      expect(stream.close).toHaveBeenCalled();
      await act(async () => applyFollowPresenceEvent(PREVIEW_ID, "pres-kim-2", { presentationId: "pres-kim-2", presenter: kim, state: "live", followers: 0 }));
      await flush();
      expect(stream.opened).toBe(2);
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Following Kim");
      expect(q("[data-testid=follow-note]")!.textContent).toBe("Kim is back: following again");
    });

    it("keeps the screen awake while following (no prompt), and lets it sleep after", async () => {
      const release = vi.fn(async () => undefined);
      const request = vi.fn(async () => ({ release }));
      Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
      try {
        await offered();
        expect(request).not.toHaveBeenCalled();
        await click("[data-testid=follow-action]");
        expect(request).toHaveBeenCalledExactlyOnceWith("screen");
        await click("[data-testid=follow-action]");
        expect(release).toHaveBeenCalledOnce();
      } finally {
        Reflect.deleteProperty(navigator, "wakeLock");
      }
    });

    it("follows on its own when the card's Follow opened it", async () => {
      requestFollow(PREVIEW_ID);
      server.presence = { presentationId: "pres-kim", presenter: kim, state: "live", followers: 0 };
      await renderAcked();
      expect(stream.opened).toBe(1);
      expect(q("[data-testid=follow-status]")!.textContent).toBe("Following Kim");
      expect(followEntry(PREVIEW_ID)).toMatchObject({ role: "following", followRequested: false });
    });
  });

  describe("the location guard", () => {
    type Host = ReturnType<typeof useSiteHost>;
    function Harness({ positions, onHost }: { positions: { latitude: number; longitude: number }[]; onHost: (host: Host) => void }) {
      const ref = useRef<HTMLIFrameElement>(null);
      onHost(useSiteHost({ frame: ref, viewerUrl: FIRST, frameKey: 0, projectId: "project-1", previewId: PREVIEW_ID,
        frameOnScreen: true, guardPositions: () => positions, onError: () => undefined }));
      return <iframe ref={ref} title="site" />;
    }

    it("never sends a view or tap holding a position the frame was given, and says it was left out", async () => {
      let host: Host | null = null;
      await act(async () => root.render(<Harness positions={[{ latitude: 25.05, longitude: 121.53 }]} onHost={next => { host = next; }} />));
      await flush();
      const fromFrame = async (type: string, extra: Record<string, unknown>) => {
        await act(async () => { host!.handleSiteMessage({ data: { source: "site-kit", v: 1, type, ...extra }, origin: ORIGIN, source: null }); });
        await flush();
      };
      await fromFrame("layout-ack", { payload: { supports: ["view", "tap"] } });
      await act(async () => { await host!.follow.present(); });
      await flush();
      expect(host!.follow.state.role).toBe("presenting");
      await fromFrame("view", { payload: { cam: "25.0500,121.5300,15", tab: "plan" } });
      await fromFrame("tap", { payload: { x: 0.5, y: 0.5, at: { lat: 25.05, lng: 121.53 } } });
      await wait(200);
      expect(mocks.sendFollowView).not.toHaveBeenCalled();
      expect(mocks.sendFollowTap).not.toHaveBeenCalled();
      expect(host!.follow.locationLeftOut).toBe(true);
      // 0.001° away is someone else's place: it goes.
      await fromFrame("view", { payload: { cam: "25.0510,121.5310,15" } });
      await wait(200);
      expect(mocks.sendFollowView).toHaveBeenCalledTimes(1);
    });
  });
});
