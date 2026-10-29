// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import { NO_MOUNTED_SITE_PREVIEWS, SITE_PREVIEW_HEALTH_POLL_MS, SITE_PREVIEW_HEARTBEAT_MS, SitePreviewPane, nextMountedSitePreviews } from "../SitePreviewPane";
import { withHostQuery } from "../previewHost/hostMessages";
import { waitForSitePreviewPage } from "../SitePreviewCard";
import { resetFollowStoreForTests, setFollowPresence } from "../previewHost/followStore";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const FIRST = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost/";
const SECOND = "https://p-bbbbbbbbbbbbbbbbbbbbbbbbbb--11111111111141118111111111111111.preview.localhost/";
const THIRD = "https://p-cccccccccccccccccccccccccc--11111111111141118111111111111111.preview.localhost/";
const TAB = "https://p-dddddddddddddddddddddddddd--11111111111141118111111111111111.preview.localhost/";

const mocks = vi.hoisted(() => ({
  createSitePreviewViewer: vi.fn(),
  getSitePreview: vi.fn(),
  heartbeatSitePreviewViewer: vi.fn(),
  revokeSitePreviewViewer: vi.fn(),
  reserveExternalWindow: vi.fn(),
  openReserved: vi.fn(),
  cancelReserved: vi.fn(),
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../services/runtimeController/previews")>();
  return {
    ...actual,
    createSitePreviewViewer: mocks.createSitePreviewViewer,
    getSitePreview: mocks.getSitePreview,
    heartbeatSitePreviewViewer: mocks.heartbeatSitePreviewViewer,
    revokeSitePreviewViewer: mocks.revokeSitePreviewViewer,
  };
});
vi.mock("../../../../utils/openExternalUrl", () => ({ reserveExternalWindow: mocks.reserveExternalWindow }));

function record(overrides: Record<string, unknown> = {}) {
  return { previewId: PREVIEW_ID, title: "Docs site", port: 4173, path: "/", runtimeId: "runtime-1",
    status: "active", health: { listening: true, status: 200 }, messageId: null, createdAt: null, ...overrides };
}

const apiError = (status: number, code: string | null = null) => new ControllerApiError({ status, message: `failed (${status})`, code, details: null });

describe("SitePreviewPane", () => {
  let root: Root;
  let container: HTMLDivElement;

  const problemText = () => container.querySelector("[data-testid=site-preview-problem]")?.textContent ?? "";
  async function render(visible = true) {
    await act(async () => root.render(<SitePreviewPane projectId="project-1" previewId={PREVIEW_ID} title="Docs site" visible={visible} />));
    await flush();
  }
  async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  async function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => element!.click());
    await flush();
  }
  const frame = () => container.querySelector<HTMLIFrameElement>("[data-testid=site-preview-frame]");
  const pane = () => container.querySelector<HTMLElement>("[data-testid=site-preview-pane]")!;
  async function post(data: unknown, origin: string, source: MessageEventSource | null) {
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { data, origin, source })); });
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    Object.values(mocks).forEach(mock => mock.mockReset());
    const urls = [FIRST, SECOND, THIRD];
    mocks.createSitePreviewViewer.mockImplementation(async (_project: string, _preview: string, options?: { tab?: boolean }) => ({
      viewerUrl: options?.tab ? TAB : urls.shift(), idleTimeoutSeconds: 1800, expiresAt: null,
    }));
    mocks.getSitePreview.mockResolvedValue(record());
    mocks.heartbeatSitePreviewViewer.mockResolvedValue("live");
    mocks.revokeSitePreviewViewer.mockResolvedValue(undefined);
    mocks.openReserved.mockResolvedValue(true);
    mocks.reserveExternalWindow.mockImplementation(() => ({ blocked: false, open: mocks.openReserved, cancel: mocks.cancelReserved }));
    sessionStorage.clear(); localStorage.clear();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("mints on mount into a sandboxed frame inside the browser bar, and never shows or stores the address", async () => {
    await render();
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID);
    const iframe = frame()!;
    expect(iframe.getAttribute("src")).toBe(withHostQuery(FIRST));
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads");
    expect(iframe.getAttribute("allow")).toBe("fullscreen; clipboard-write");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    const bar = container.querySelector("[data-testid=site-preview-chrome]")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(container.querySelector("[data-testid=site-preview-title]")?.textContent).toBe("Docs site");
    expect(bar.innerHTML).not.toContain("p-aaaa");
    expect(bar.querySelector('[aria-label="Reload"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label="Open in new tab"]')).not.toBeNull();
    // The tab's × closes the pane; the bar has no second close.
    expect(bar.querySelector('[aria-label*="Close"]')).toBeNull();
    expect(pane().dataset.state).toBe("live");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("p-aaaa");
    expect(JSON.stringify({ ...localStorage })).not.toContain("p-aaaa");
  });

  it("is one row on a phone: Present and Open in new tab sit beside the title, never on a row of their own", async () => {
    const bar = () => container.querySelector<HTMLElement>("[data-testid=site-preview-chrome]")!;
    const contextRow = () => bar().querySelector<HTMLElement>("[data-testid=browser-chrome-context-row]")!;
    const viewport = (wide: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({
      matches: wide, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    try {
      // a phone (narrower than 640 px): the bar never wraps its controls onto a second row
      viewport(false);
      await render();
      expect(bar().className).not.toContain("flex-wrap");
      expect(contextRow().className).not.toContain("basis-full");
      expect(contextRow().querySelector('[aria-label="Open in new tab"]')).not.toBeNull();
      // a wider screen keeps the bar it had
      await act(async () => root.unmount());
      root = createRoot(container);
      viewport(true);
      await render();
      expect(bar().className).toContain("max-[540px]:flex-wrap");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a phone's follow chip on a row of its own: beside the title it squeezed the title out and pushed Open in new tab off a narrow screen", async () => {
    const contextRow = () => container.querySelector<HTMLElement>("[data-testid=site-preview-chrome] [data-testid=browser-chrome-context-row]")!;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    try {
      // Kim presents this site: the bar shows "Kim is presenting · Follow" and "Present instead"
      setFollowPresence(PREVIEW_ID, { presentationId: "presentation-1", presenter: { id: "kim", name: "Kim" }, state: "live", followers: 0 });
      await render();
      expect(container.querySelector("[data-testid=follow-bar-chip]")?.textContent).toContain("Kim is presenting");
      expect(contextRow().className).toContain("max-[540px]:basis-full");
      expect(contextRow().querySelector('[aria-label="Open in new tab"]')).not.toBeNull();
      // nobody presents any more: one row again
      await act(async () => setFollowPresence(PREVIEW_ID, null));
      await flush();
      expect(container.querySelector("[data-testid=follow-bar-chip]")).toBeNull();
      expect(contextRow().className).not.toContain("basis-full");
    } finally {
      vi.unstubAllGlobals();
      resetFollowStoreForTests();
    }
  });

  it("shows one loading signal while opening: the line in the pane, its pill for screen readers only", async () => {
    mocks.createSitePreviewViewer.mockImplementation(() => new Promise(() => {}));
    await render();
    expect(pane().dataset.state).toBe("opening");
    expect(container.querySelector("[data-testid=site-preview-progress]")?.textContent).toContain("Opening Docs site…");
    const pill = container.querySelector<HTMLElement>("[data-testid=site-preview-status]")!;
    expect(pill.classList.contains("sr-only")).toBe(true);
    expect(pill.getAttribute("role")).toBe("status");
    expect(pill.textContent).toBe("Starting…");
  });

  // A local test: a restarted site's pane was blank for 16 to 26 s, and the
  // map's for 5 to 18 s, with nothing said.
  it("says Loading… over a frame whose page has not loaded, and tells the cards once it has", async () => {
    const shown = vi.fn();
    const stop = waitForSitePreviewPage(PREVIEW_ID, shown);
    await render();
    expect(pane().dataset.state).toBe("live");
    expect(frame()).not.toBeNull();
    expect(container.querySelector("[data-testid=site-preview-progress]")?.textContent).toContain("Loading…");
    await act(async () => frame()!.dispatchEvent(new Event("load")));
    expect(container.querySelector("[data-testid=site-preview-progress]")).toBeNull();
    expect(shown).toHaveBeenCalledOnce();
    // Reload loads a new frame: blank again until its page loads.
    await click("[data-testid=site-preview-reload]");
    expect(container.querySelector("[data-testid=site-preview-progress]")?.textContent).toContain("Loading…");
    await act(async () => frame()!.dispatchEvent(new Event("load")));
    expect(container.querySelector("[data-testid=site-preview-progress]")).toBeNull();
    stop();
  });

  // The frame of a site that stopped answering goes, and a new one loads when
  // it answers again: at the same address, so the page that loaded in the
  // frame before is no sign this one has.
  it("says Loading… over the new frame of a site that answers again, until its page loads", async () => {
    await render();
    await act(async () => frame()!.dispatchEvent(new Event("load")));
    expect(container.querySelector("[data-testid=site-preview-progress]")).toBeNull();
    mocks.getSitePreview.mockResolvedValue(record({ health: { listening: false, status: null } }));
    await advance(SITE_PREVIEW_HEALTH_POLL_MS);
    expect(frame()).toBeNull();
    mocks.getSitePreview.mockResolvedValue(record());
    await advance(SITE_PREVIEW_HEALTH_POLL_MS);
    expect(frame()?.getAttribute("src")).toBe(withHostQuery(FIRST));
    expect(container.querySelector("[data-testid=site-preview-progress]")?.textContent).toContain("Loading…");
    await act(async () => frame()!.dispatchEvent(new Event("load")));
    expect(container.querySelector("[data-testid=site-preview-progress]")).toBeNull();
  });

  // A card that started the site waits for its page in a pane: a pane that
  // shows it already, or closes before it loads, ends that wait.
  it("tells the cards when it already shows the page, and when it closes before the page loads", async () => {
    await render();
    await act(async () => frame()!.dispatchEvent(new Event("load")));
    const shownAlready = vi.fn();
    const stopShownAlready = waitForSitePreviewPage(PREVIEW_ID, shownAlready);
    expect(shownAlready).toHaveBeenCalledOnce();
    stopShownAlready();
    await click("[data-testid=site-preview-reload]");
    const closed = vi.fn();
    const stopClosed = waitForSitePreviewPage(PREVIEW_ID, closed);
    expect(closed).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(closed).toHaveBeenCalledOnce();
    stopClosed();
    root = createRoot(container);
  });

  it("reads only the broker's status message, only from its own frame and origin", async () => {
    await render();
    const target = frame()!.contentWindow!;
    const origin = new URL(FIRST).origin;
    // Another window at the right origin, the right window at another origin, and other shapes are ignored.
    await post({ type: "instafy-preview", status: 502 }, origin, window);
    await post({ type: "instafy-preview", status: 502 }, "https://attacker.example", target);
    await post({ type: "instafy-preview", status: "502" }, origin, target);
    await post({ type: "something-else", status: 502 }, origin, target);
    await post({ type: "instafy-preview", status: 401 }, "https://attacker.example", target);
    expect(pane().dataset.state).toBe("live");
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(1);
    await post({ type: "instafy-preview", status: 502 }, origin, target);
    expect(pane().dataset.state).toBe("not_responding");
  });

  // Local drive, Oct 28: the stopped pane said "Not responding on port 4173", the broker's own error page showed
  // through its message ("This p… …nding."), and a red Unavailable pill said it a third time.
  it("says a site that stopped answering is stopped, once: no port, no frame behind it, no pill", async () => {
    await render();
    await post({ type: "instafy-preview", status: 502 }, new URL(FIRST).origin, frame()!.contentWindow);
    expect(pane().dataset.state).toBe("not_responding");
    expect(problemText()).toBe("This site is stopped. Ask Octo to start it again.");
    expect(frame()).toBeNull();
    expect(container.querySelector("[data-testid=site-preview-status]")).toBeNull();
    expect(pane().textContent).not.toContain("4173");
    expect(pane().textContent).not.toMatch(/not responding|unavailable/i);
    // Its message is the status a screen reader hears.
    expect(container.querySelector("[data-testid=site-preview-problem] [role=status]")?.textContent).toBe(problemText());
    // The toolbar's Reload stays; the message has no second one.
    expect(container.querySelector("[data-testid=site-preview-problem] button")).toBeNull();
  });

  it("loads the site again, in a new frame, once it answers again", async () => {
    await render();
    mocks.getSitePreview.mockResolvedValue(record({ health: { listening: false, status: null } }));
    await advance(SITE_PREVIEW_HEALTH_POLL_MS);
    expect(pane().dataset.state).toBe("not_responding");
    expect(frame()).toBeNull();
    mocks.getSitePreview.mockResolvedValue(record());
    await advance(SITE_PREVIEW_HEALTH_POLL_MS);
    expect(pane().dataset.state).toBe("live");
    expect(frame()?.getAttribute("src")).toBe(withHostQuery(FIRST));
    expect(problemText()).toBe("");
  });

  it("re-mints once on a 401 from the frame, revoking the old session, then ends on a second", async () => {
    await render();
    await post({ type: "instafy-preview", status: 401 }, new URL(FIRST).origin, frame()!.contentWindow);
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledWith("project-1", PREVIEW_ID, FIRST);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()!.getAttribute("src")).toBe(withHostQuery(SECOND));
    await post({ type: "instafy-preview", status: 401 }, new URL(SECOND).origin, frame()!.contentWindow);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledWith("project-1", PREVIEW_ID, SECOND);
    expect(pane().dataset.state).toBe("ended");
    expect(frame()).toBeNull();
    // Reload is the person's own request for a new session.
    await click("[data-testid=site-preview-reload]");
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(3);
    expect(frame()!.getAttribute("src")).toBe(withHostQuery(THIRD));
  });

  it("sends the heartbeat about once a minute while on screen, and re-mints on 410", async () => {
    await render();
    expect(mocks.heartbeatSitePreviewViewer).not.toHaveBeenCalled();
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    expect(mocks.heartbeatSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, FIRST, expect.any(AbortSignal));
    mocks.heartbeatSitePreviewViewer.mockResolvedValueOnce("gone");
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()!.getAttribute("src")).toBe(withHostQuery(SECOND));
    // A live beat after the new session clears the once-guard: a later 410 re-mints again.
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    mocks.heartbeatSitePreviewViewer.mockResolvedValueOnce("gone");
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(3);
    // Off screen: no heartbeat and no health polls.
    await render(false);
    const beats = mocks.heartbeatSitePreviewViewer.mock.calls.length;
    const polls = mocks.getSitePreview.mock.calls.length;
    await advance(SITE_PREVIEW_HEARTBEAT_MS * 3);
    expect(mocks.heartbeatSitePreviewViewer).toHaveBeenCalledTimes(beats);
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(polls);
  });

  it("re-mints on a 410 heartbeat only once in a row", async () => {
    mocks.heartbeatSitePreviewViewer.mockResolvedValue("gone");
    await render();
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(pane().dataset.state).toBe("ended");
  });

  it("polls health every 15 seconds while on screen", async () => {
    await render();
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(1);
    mocks.getSitePreview.mockResolvedValue(record({ health: { listening: false, status: null } }));
    await advance(SITE_PREVIEW_HEALTH_POLL_MS);
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
    expect(pane().dataset.state).toBe("not_responding");
    mocks.getSitePreview.mockResolvedValue(record({ status: "revoked" }));
    await advance(SITE_PREVIEW_HEALTH_POLL_MS);
    expect(pane().dataset.state).toBe("stopped");
    expect(frame()).toBeNull();
  });

  it.each([
    ["the broker could not probe the site", { health: null }],
    ["the tunnel is not active yet", { status: "issuing" }],
  ])("reads Checking, never Live, while %s, and keeps the frame", async (_name, overrides) => {
    mocks.getSitePreview.mockResolvedValue(record(overrides));
    await render();
    expect(pane().dataset.state).toBe("checking");
    expect(frame()).not.toBeNull();
  });

  it("revokes its session when it unmounts (the tab's ×)", async () => {
    await render();
    expect(mocks.revokeSitePreviewViewer).not.toHaveBeenCalled();
    await act(async () => root.render(<></>));
    await flush();
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, FIRST);
  });

  it("revokes its session, in a request that outlives the page, when Studio is closed or reloaded", async () => {
    await render();
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await flush();
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, FIRST, { keepalive: true });
    // The pane is still mounted; unmounting later does not revoke the same session twice.
    await act(async () => root.render(<></>));
    await flush();
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledTimes(1);
  });

  it("opens a new session when the page comes back from the back-forward cache", async () => {
    await render();
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    // A page shown normally (not restored) asks for nothing.
    await act(async () => { window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false })); });
    await flush();
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })); });
    await flush();
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()?.getAttribute("src")).toBe(withHostQuery(SECOND));
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledTimes(1);
  });

  it("says too many previews were opened on a 429, and Reload asks again", async () => {
    mocks.createSitePreviewViewer.mockRejectedValueOnce(apiError(429));
    await render();
    expect(pane().dataset.state).toBe("busy");
    expect(frame()).toBeNull();
    expect(problemText()).toContain("Too many previews opened");
    expect(problemText()).not.toContain("session ended");
    await click("[data-testid=site-preview-problem] button");
    expect(pane().dataset.state).toBe("live");
    expect(frame()?.getAttribute("src")).toBe(withHostQuery(FIRST));
  });

  // Live test, Oct 27: the open tab of a site Octo then stopped (and closed)
  // said "Too many previews opened" after a single open. The frame's 401 asked
  // for one new session, the controller said the site had stopped, and the
  // pane took its last Live health as the site being back, so it asked again
  // and again until the controller's 20-a-minute limit answered 429.
  it("asks for one new session when a stopped site's frame loses its session, not one per answer", async () => {
    await render();
    expect(pane().dataset.state).toBe("live");
    // Octo stops the site and closes its preview: sessions end, mints are refused.
    let refusals = 0;
    mocks.createSitePreviewViewer.mockImplementation(async () => {
      refusals += 1;
      throw apiError(refusals > 20 ? 429 : 409);
    });
    mocks.getSitePreview.mockResolvedValue(record({ status: "revoked", health: null }));
    await post({ type: "instafy-preview", status: 401 }, new URL(FIRST).origin, frame()!.contentWindow);
    await advance(1_000);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(pane().dataset.state).toBe("stopped");
    expect(problemText()).not.toContain("Too many previews opened");
    // It keeps checking the record, slowly, and asks for nothing more while the site is down.
    await advance(SITE_PREVIEW_HEALTH_POLL_MS * 4);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(pane().dataset.state).toBe("stopped");
  });

  it("revokes a session that arrives after the pane unmounted", async () => {
    let resolve!: (value: unknown) => void;
    mocks.createSitePreviewViewer.mockImplementationOnce(() => new Promise(next => { resolve = next; }));
    await render();
    await act(async () => root.render(<></>));
    await act(async () => resolve({ viewerUrl: FIRST, idleTimeoutSeconds: null, expiresAt: null }));
    await flush();
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledWith("project-1", PREVIEW_ID, FIRST);
  });

  it.each([
    ["503 previews_unavailable", apiError(503, "previews_unavailable")],
    ["a controller without preview routes", apiError(404, "preview_routes_missing")],
  ])("says previews are not available, with no frame, on %s", async (_name, error) => {
    mocks.createSitePreviewViewer.mockRejectedValueOnce(error);
    await render();
    expect(pane().dataset.state).toBe("unavailable");
    expect(frame()).toBeNull();
    expect(problemText()).toContain("Previews are not available here");
    // Nothing else is asked of a server without previews.
    await advance(SITE_PREVIEW_HEARTBEAT_MS * 2);
    expect(mocks.getSitePreview).not.toHaveBeenCalled();
    expect(mocks.heartbeatSitePreviewViewer).not.toHaveBeenCalled();
  });

  it("says a preview that no longer exists is closed, not that the server has no previews", async () => {
    mocks.createSitePreviewViewer.mockRejectedValueOnce(apiError(404));
    await render();
    expect(pane().dataset.state).toBe("missing");
    expect(problemText()).toContain("This preview no longer exists");
    expect(problemText()).not.toContain("not available");
    expect(container.querySelector("[data-testid=site-preview-problem] button")).toBeNull();
  });

  it("tells a person who lost access so, with no Reload and no frame", async () => {
    mocks.createSitePreviewViewer.mockRejectedValueOnce(apiError(403));
    await render();
    expect(pane().dataset.state).toBe("no_access");
    expect(problemText()).toContain("You can't open this preview");
    expect(problemText()).not.toContain("Ask Octo to start it");
    expect(container.querySelector("[data-testid=site-preview-problem] button")).toBeNull();
    expect(frame()).toBeNull();
  });

  it("stops the heartbeat and polls once health says the preview is gone or forbidden", async () => {
    await render();
    mocks.getSitePreview.mockRejectedValue(apiError(403));
    await advance(SITE_PREVIEW_HEALTH_POLL_MS);
    expect(pane().dataset.state).toBe("no_access");
    expect(frame()).toBeNull();
    const polls = mocks.getSitePreview.mock.calls.length;
    await advance(SITE_PREVIEW_HEARTBEAT_MS * 3);
    expect(mocks.heartbeatSitePreviewViewer).not.toHaveBeenCalled();
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(polls);
  });

  it("keeps no heartbeat for a stopped site whose frame is hidden", async () => {
    mocks.getSitePreview.mockResolvedValue(record({ status: "revoked" }));
    await render();
    expect(pane().dataset.state).toBe("stopped");
    await advance(SITE_PREVIEW_HEARTBEAT_MS * 2);
    expect(mocks.heartbeatSitePreviewViewer).not.toHaveBeenCalled();
  });

  it("checks the session as soon as it is shown again, and may re-mint once more", async () => {
    await render();
    // Re-mint, then hide before a live beat clears the once-guard.
    await post({ type: "instafy-preview", status: 401 }, new URL(FIRST).origin, frame()!.contentWindow);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    await render(false);
    await advance(31 * 60_000);
    expect(mocks.heartbeatSitePreviewViewer).not.toHaveBeenCalled();
    mocks.heartbeatSitePreviewViewer.mockResolvedValueOnce("gone");
    await render(true);
    // At once, not a minute later: the idled-out session is noticed on show.
    expect(mocks.heartbeatSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, SECOND, expect.any(AbortSignal));
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(3);
    expect(pane().dataset.state).toBe("live");
    expect(frame()!.getAttribute("src")).toBe(withHostQuery(THIRD));
  });

  it("opens the new tab during the press, then fills it with a separate tab session", async () => {
    const order: string[] = [];
    mocks.reserveExternalWindow.mockImplementation(() => { order.push("reserve"); return { blocked: false, open: mocks.openReserved, cancel: mocks.cancelReserved }; });
    await render();
    const mint = mocks.createSitePreviewViewer.getMockImplementation()!;
    mocks.createSitePreviewViewer.mockImplementation(async (...args: unknown[]) => { order.push("mint"); return mint(...(args as [string, string])); });
    await click("[data-testid=site-preview-open-tab]");
    expect(order).toEqual(["reserve", "mint"]);
    expect(mocks.createSitePreviewViewer).toHaveBeenLastCalledWith("project-1", PREVIEW_ID, { tab: true });
    expect(mocks.openReserved).toHaveBeenCalledExactlyOnceWith(TAB);
    // The pane keeps its own session.
    expect(frame()!.getAttribute("src")).toBe(withHostQuery(FIRST));
    expect(mocks.revokeSitePreviewViewer).not.toHaveBeenCalled();
  });

  it("mints nothing when the browser blocks the new tab, and says so", async () => {
    mocks.reserveExternalWindow.mockReturnValue({ blocked: true, open: mocks.openReserved, cancel: mocks.cancelReserved });
    await render();
    await click("[data-testid=site-preview-open-tab]");
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid=site-preview-feedback]")?.textContent).toContain("blocked the new tab");
  });

  it("revokes the tab session when the reserved tab cannot show it", async () => {
    mocks.openReserved.mockResolvedValue(false);
    await render();
    await click("[data-testid=site-preview-open-tab]");
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, TAB);
    expect(container.querySelector("[data-testid=site-preview-feedback]")?.textContent).toContain("blocked the new tab");
  });

  it("closes the reserved tab when the mint fails", async () => {
    await render();
    mocks.createSitePreviewViewer.mockRejectedValueOnce(apiError(409));
    await click("[data-testid=site-preview-open-tab]");
    expect(mocks.cancelReserved).toHaveBeenCalledOnce();
    expect(mocks.openReserved).not.toHaveBeenCalled();
  });
});

describe("nextMountedSitePreviews", () => {
  it("mounts a preview once shown, keeps it while its tab is open, and keeps identity when unchanged", () => {
    const none = nextMountedSitePreviews(NO_MOUNTED_SITE_PREVIEWS, "scope-1", ["a", "b"], null);
    expect(none).toEqual({ scope: "scope-1", ids: [] });
    expect(nextMountedSitePreviews(none, "scope-1", ["a", "b"], null)).toBe(none);
    const one = nextMountedSitePreviews(none, "scope-1", ["a", "b"], "a");
    expect(one.ids).toEqual(["a"]);
    expect(nextMountedSitePreviews(one, "scope-1", ["a", "b"], null)).toBe(one);
    const two = nextMountedSitePreviews(one, "scope-1", ["a", "b"], "b");
    expect(two.ids).toEqual(["a", "b"]);
    expect(nextMountedSitePreviews(two, "scope-1", ["b"], "b").ids).toEqual(["b"]);
    expect(nextMountedSitePreviews(two, "scope-1", ["a", "b"], "gone")).toBe(two);
  });

  it("carries no pane over into another conversation's scope", () => {
    const mounted = nextMountedSitePreviews(NO_MOUNTED_SITE_PREVIEWS, "scope-1", ["a", "b"], "a");
    const other = nextMountedSitePreviews(mounted, "scope-2", ["a", "b"], null);
    expect(other).toEqual({ scope: "scope-2", ids: [] });
    expect(nextMountedSitePreviews(other, "scope-2", ["a", "b"], "b")).toEqual({ scope: "scope-2", ids: ["b"] });
  });
});
