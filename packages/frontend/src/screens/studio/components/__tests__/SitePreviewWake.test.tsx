// @vitest-environment jsdom
// Wake on Open: a site `instafy preview open` knows how to start comes back
// from upstream's card and pane without an Octo turn (unit 18).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import type { ControllerSitePreview } from "../../../../services/runtimeController/previews";
import { ConversationPreviewContext, type ConversationPreviewOpener } from "../../../../workspace/ConversationPreviewContext";
import { SitePreviewCard } from "../SitePreviewCard";
import { SitePreviewPane } from "../SitePreviewPane";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost/";
const mocks = vi.hoisted(() => ({
  getSitePreview: vi.fn(),
  wakeSitePreview: vi.fn(),
  createSitePreviewViewer: vi.fn(),
  heartbeatSitePreviewViewer: vi.fn(),
  revokeSitePreviewViewer: vi.fn(),
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  getSitePreview: mocks.getSitePreview,
  wakeSitePreview: mocks.wakeSitePreview,
  createSitePreviewViewer: mocks.createSitePreviewViewer,
  heartbeatSitePreviewViewer: mocks.heartbeatSitePreviewViewer,
  revokeSitePreviewViewer: mocks.revokeSitePreviewViewer,
}));
vi.mock("../../../../runtime/RuntimeStateProvider", () => ({ useOptionalRuntimeState: () => ({ tunnelGrants: {}, runtimeStatuses: [] }) }));

function record(overrides: Partial<ControllerSitePreview> = {}): ControllerSitePreview {
  return {
    previewId: PREVIEW_ID, title: "Site preview", port: 4173, path: "/", runtimeId: "runtime-1", status: "active",
    health: { listening: true, status: 200 }, messageId: "card-1", createdAt: null, visibility: "private",
    restartable: true, wake: { state: "idle", startedAt: null, error: null }, ...overrides,
  };
}
const stopped = (overrides: Partial<ControllerSitePreview> = {}) => record({ status: "closed", health: null, ...overrides });
const apiError = (status: number, code: string | null = null) => new ControllerApiError({ status, message: "error", code, details: null });

let root: Root;
let container: HTMLDivElement;
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function press(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  await act(async () => element!.click());
  await flush();
}
const text = (selector: string) => container.querySelector(selector)?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.heartbeatSitePreviewViewer.mockResolvedValue("live");
  mocks.revokeSitePreviewViewer.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("the card wakes a stopped site on Open", () => {
  let opener: ConversationPreviewOpener;
  async function render() {
    await act(async () => root.render(
      <ConversationPreviewContext.Provider value={opener}>
        <SitePreviewCard preview={{ previewId: PREVIEW_ID, title: "Site preview", port: 4173 }} projectId="project-1" />
      </ConversationPreviewContext.Provider>,
    ));
    await flush();
  }
  const open = () => container.querySelector<HTMLButtonElement>("[data-testid=preview-ready-open]")!;
  beforeEach(() => { opener = { openPreview: vi.fn(), visiblePreviewId: null }; });

  it("starts a stopped site it knows how to start, says so, and opens it once it answers", async () => {
    mocks.getSitePreview.mockResolvedValueOnce(stopped()).mockResolvedValueOnce(record({ wake: { state: "waking", startedAt: null, error: null }, status: "issuing", health: null }))
      .mockResolvedValue(record());
    mocks.wakeSitePreview.mockResolvedValue({ state: "waking" });
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped");
    expect(open().disabled).toBe(false);
    await press("[data-testid=preview-ready-open]");
    expect(mocks.wakeSitePreview).toHaveBeenCalledWith("project-1", PREVIEW_ID, expect.anything());
    expect(text("[data-testid=preview-ready-status]")).toBe("Starting…");
    expect(open().textContent).toContain("Starting…");
    expect(opener.openPreview).not.toHaveBeenCalled();
    await advance(2_000); // still waking
    expect(opener.openPreview).not.toHaveBeenCalled();
    await advance(2_000); // answers
    expect(opener.openPreview).toHaveBeenCalledExactlyOnceWith({ previewId: PREVIEW_ID, title: "Site preview" });
    expect(text("[data-testid=preview-ready-status]")).toBe("Live");
  });

  it("keeps Open off for a stopped site nobody recorded how to start", async () => {
    mocks.getSitePreview.mockResolvedValue(stopped({ restartable: false }));
    await render();
    expect(open().disabled).toBe(true);
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
  });

  it("says why a wake was refused and opens nothing", async () => {
    mocks.getSitePreview.mockResolvedValue(stopped());
    mocks.wakeSitePreview.mockRejectedValue(apiError(403, "start_needs_builder"));
    await render();
    await press("[data-testid=preview-ready-open]");
    expect(text("[data-testid=preview-ready-status]")).toBe("Only people who can edit this space can start it. Ask one of them to open it.");
    expect(opener.openPreview).not.toHaveBeenCalled();
    expect(open().disabled).toBe(false); // Open is the retry
  });

  it("tells a member who may not start the machine why, before they press Open", async () => {
    mocks.getSitePreview.mockResolvedValue(stopped({ canStart: false }));
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Only people who can edit this space can start it. Ask one of them to open it.");
    expect(open().disabled).toBe(true);
    await act(async () => open().click());
    await flush();
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
    expect(opener.openPreview).not.toHaveBeenCalled();
  });

  it("says plainly when the space's own computer is offline", async () => {
    mocks.getSitePreview.mockResolvedValue(stopped({ canStart: true }));
    mocks.wakeSitePreview.mockRejectedValue(apiError(409, "runtime_offline"));
    await render();
    await press("[data-testid=preview-ready-open]");
    expect(text("[data-testid=preview-ready-status]")).toBe("The computer this space runs on is offline.");
    expect(opener.openPreview).not.toHaveBeenCalled();
  });

  it("follows a wake someone else started, and offers Start again for a site that stopped answering", async () => {
    mocks.getSitePreview.mockResolvedValueOnce(stopped({ wake: { state: "waking", startedAt: null, error: null } }))
      .mockResolvedValueOnce(record({ health: { listening: false, status: null } }))
      .mockResolvedValue(record({ health: { listening: false, status: null } }));
    mocks.wakeSitePreview.mockResolvedValue({ state: "live" });
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Starting…");
    expect(open().disabled).toBe(true);
    await advance(3_000);
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
    expect(text("[data-testid=preview-ready-status]")).toBe("Not responding on port 4173");
    await press("[data-testid=preview-ready-restart]");
    expect(mocks.wakeSitePreview).toHaveBeenCalledOnce();
    // Start again does not pull the person into the site.
    expect(opener.openPreview).not.toHaveBeenCalled();
  });
});

describe("the pane starts a stopped site again", () => {
  async function render() {
    await act(async () => root.render(<SitePreviewPane projectId="project-1" previewId={PREVIEW_ID} title="Site preview" visible />));
    await flush();
  }
  const frame = () => container.querySelector<HTMLIFrameElement>("[data-testid=site-preview-frame]");

  it("offers Start again where the record knows how to start the site, then opens a new session", async () => {
    mocks.createSitePreviewViewer.mockRejectedValueOnce(apiError(409)).mockResolvedValue({ viewerUrl: VIEWER, idleTimeoutSeconds: 1800, expiresAt: null });
    mocks.getSitePreview.mockResolvedValueOnce(stopped()).mockResolvedValue(record());
    mocks.wakeSitePreview.mockResolvedValue({ state: "live" });
    await render();
    expect(text("[data-testid=site-preview-problem]")).toContain("Start it again to pick up where it was");
    await press("[data-testid=site-preview-wake]");
    expect(mocks.wakeSitePreview).toHaveBeenCalledOnce();
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()?.getAttribute("src")).toContain("p-aaaa");
  });

  it("stops following its wake when it closes", async () => {
    mocks.createSitePreviewViewer.mockRejectedValue(apiError(409));
    mocks.getSitePreview.mockResolvedValueOnce(stopped()).mockResolvedValue(stopped({ wake: { state: "waking", startedAt: null, error: null } }));
    mocks.wakeSitePreview.mockResolvedValue({ state: "waking" });
    await render();
    await press("[data-testid=site-preview-wake]");
    await advance(2_000);
    const polls = mocks.getSitePreview.mock.calls.length;
    expect(polls).toBeGreaterThan(1);
    await act(async () => root.render(<div />));
    await advance(20_000);
    expect(mocks.getSitePreview.mock.calls.length).toBe(polls);
  });

  it("keeps Start again off, with the reason, for a member who may not start the machine", async () => {
    mocks.createSitePreviewViewer.mockRejectedValue(apiError(409));
    mocks.getSitePreview.mockResolvedValue(stopped({ canStart: false }));
    await render();
    expect(text("[data-testid=site-preview-problem]")).toContain("Only people who can edit this space can start it.");
    expect(container.querySelector<HTMLButtonElement>("[data-testid=site-preview-wake]")?.disabled).toBe(true);
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
  });

  it("asks Octo, not the pane, for a site nobody recorded how to start", async () => {
    mocks.createSitePreviewViewer.mockRejectedValue(apiError(409));
    mocks.getSitePreview.mockResolvedValue(stopped({ restartable: false }));
    await render();
    expect(text("[data-testid=site-preview-problem]")).toContain("Ask Octo to start it again");
    expect(container.querySelector("[data-testid=site-preview-wake]")).toBeNull();
  });

  it("opens the site by itself once it answers again (someone else woke it), once", async () => {
    mocks.createSitePreviewViewer.mockRejectedValueOnce(apiError(409)).mockResolvedValue({ viewerUrl: VIEWER, idleTimeoutSeconds: 1800, expiresAt: null });
    mocks.getSitePreview.mockResolvedValueOnce(stopped()).mockResolvedValue(record());
    await render();
    expect(frame()).toBeNull();
    await advance(15_000);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()).not.toBeNull();
    await advance(60_000);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
  });
});
