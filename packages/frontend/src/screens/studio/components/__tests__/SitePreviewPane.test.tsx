// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import { SITE_PREVIEW_HEALTH_POLL_MS, SITE_PREVIEW_HEARTBEAT_MS, SitePreviewPane, nextMountedSitePreviews } from "../SitePreviewPane";

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
  openExternalUrl: vi.fn(),
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
vi.mock("../../../../utils/openExternalUrl", () => ({ openExternalUrl: mocks.openExternalUrl }));

function record(overrides: Record<string, unknown> = {}) {
  return { previewId: PREVIEW_ID, title: "Docs site", port: 4173, path: "/", runtimeId: "runtime-1",
    status: "active", health: { listening: true, status: 200 }, messageId: null, createdAt: null, ...overrides };
}

const apiError = (status: number) => new ControllerApiError({ status, message: `failed (${status})`, code: null, details: null });

describe("SitePreviewPane", () => {
  let root: Root;
  let container: HTMLDivElement;

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
    mocks.openExternalUrl.mockResolvedValue(true);
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
    expect(iframe.getAttribute("src")).toBe(FIRST);
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
    expect(container.querySelector("[data-testid=site-preview-problem]")?.textContent).toContain("Not responding on port 4173");
  });

  it("re-mints once on a 401 from the frame, revoking the old session, then ends on a second", async () => {
    await render();
    await post({ type: "instafy-preview", status: 401 }, new URL(FIRST).origin, frame()!.contentWindow);
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledWith("project-1", PREVIEW_ID, FIRST);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()!.getAttribute("src")).toBe(SECOND);
    await post({ type: "instafy-preview", status: 401 }, new URL(SECOND).origin, frame()!.contentWindow);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledWith("project-1", PREVIEW_ID, SECOND);
    expect(pane().dataset.state).toBe("ended");
    expect(frame()).toBeNull();
    // Reload is the person's own request for a new session.
    await click("[data-testid=site-preview-reload]");
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(3);
    expect(frame()!.getAttribute("src")).toBe(THIRD);
  });

  it("sends the heartbeat about once a minute while on screen, and re-mints on 410", async () => {
    await render();
    expect(mocks.heartbeatSitePreviewViewer).not.toHaveBeenCalled();
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    expect(mocks.heartbeatSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, FIRST, expect.any(AbortSignal));
    mocks.heartbeatSitePreviewViewer.mockResolvedValueOnce("gone");
    await advance(SITE_PREVIEW_HEARTBEAT_MS);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()!.getAttribute("src")).toBe(SECOND);
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

  it("revokes its session when it unmounts (the tab's ×)", async () => {
    await render();
    expect(mocks.revokeSitePreviewViewer).not.toHaveBeenCalled();
    await act(async () => root.render(<></>));
    await flush();
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, FIRST);
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

  it.each([404, 503])("says previews are not available, with no frame, when /view answers %i", async (status) => {
    mocks.createSitePreviewViewer.mockRejectedValueOnce(apiError(status));
    await render();
    expect(pane().dataset.state).toBe("unavailable");
    expect(frame()).toBeNull();
    expect(container.querySelector("[data-testid=site-preview-problem]")?.textContent).toContain("Previews are not available here");
    // Nothing else is asked of a server without previews.
    await advance(SITE_PREVIEW_HEARTBEAT_MS * 2);
    expect(mocks.getSitePreview).not.toHaveBeenCalled();
    expect(mocks.heartbeatSitePreviewViewer).not.toHaveBeenCalled();
  });

  it("opens a separate tab session in a new tab", async () => {
    await render();
    await click("[data-testid=site-preview-open-tab]");
    expect(mocks.createSitePreviewViewer).toHaveBeenLastCalledWith("project-1", PREVIEW_ID, { tab: true });
    expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith(TAB);
    // The pane keeps its own session.
    expect(frame()!.getAttribute("src")).toBe(FIRST);
    expect(mocks.revokeSitePreviewViewer).not.toHaveBeenCalled();
  });
});

describe("nextMountedSitePreviews", () => {
  it("mounts a preview once shown, keeps it while its tab is open, and keeps identity when unchanged", () => {
    const none: readonly string[] = [];
    expect(nextMountedSitePreviews(none, ["a", "b"], null)).toBe(none);
    const one = nextMountedSitePreviews(none, ["a", "b"], "a");
    expect(one).toEqual(["a"]);
    expect(nextMountedSitePreviews(one, ["a", "b"], null)).toBe(one);
    const two = nextMountedSitePreviews(one, ["a", "b"], "b");
    expect(two).toEqual(["a", "b"]);
    expect(nextMountedSitePreviews(two, ["b"], "b")).toEqual(["b"]);
    expect(nextMountedSitePreviews(two, ["a", "b"], "gone")).toBe(two);
  });
});
