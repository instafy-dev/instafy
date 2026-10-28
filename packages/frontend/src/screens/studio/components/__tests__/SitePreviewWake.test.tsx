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
  runtime: { tunnelGrants: {}, runtimeStatuses: [] } as Record<string, unknown>,
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  getSitePreview: mocks.getSitePreview,
  wakeSitePreview: mocks.wakeSitePreview,
  createSitePreviewViewer: mocks.createSitePreviewViewer,
  heartbeatSitePreviewViewer: mocks.heartbeatSitePreviewViewer,
  revokeSitePreviewViewer: mocks.revokeSitePreviewViewer,
}));
vi.mock("../../../../runtime/RuntimeStateProvider", () => ({ useOptionalRuntimeState: () => mocks.runtime }));

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
  [mocks.getSitePreview, mocks.wakeSitePreview, mocks.createSitePreviewViewer, mocks.heartbeatSitePreviewViewer, mocks.revokeSitePreviewViewer]
    .forEach(mock => mock.mockReset());
  mocks.runtime = { tunnelGrants: {}, runtimeStatuses: [] };
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
  // The whole card is its button; one that can do nothing is aria-disabled, never removed from the tab order.
  const disabled = () => open().getAttribute("aria-disabled") === "true";
  beforeEach(() => { opener = { openPreview: vi.fn(), visiblePreviewId: null }; });

  it("starts a stopped site it knows how to start, says so, and opens it once it answers", async () => {
    mocks.getSitePreview.mockResolvedValueOnce(stopped()).mockResolvedValueOnce(record({ wake: { state: "waking", startedAt: null, error: null }, status: "issuing", health: null }))
      .mockResolvedValue(record());
    mocks.wakeSitePreview.mockResolvedValue({ state: "waking" });
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · opening restarts it");
    expect(disabled()).toBe(false);
    // A press starts it, so the card keeps its chevron.
    expect(container.querySelector("[data-testid=preview-card-open-icon]")).not.toBeNull();
    await press("[data-testid=preview-ready-open]");
    expect(mocks.wakeSitePreview).toHaveBeenCalledWith("project-1", PREVIEW_ID, expect.anything());
    expect(text("[data-testid=preview-ready-status]")).toBe("Starting…");
    expect(open().getAttribute("aria-busy")).toBe("true");
    expect(disabled()).toBe(true);
    expect(container.querySelector("[data-testid=preview-card-open-icon]")).toBeNull();
    expect(opener.openPreview).not.toHaveBeenCalled();
    await advance(2_000); // still waking
    expect(opener.openPreview).not.toHaveBeenCalled();
    await advance(2_000); // answers
    expect(opener.openPreview).toHaveBeenCalledExactlyOnceWith({ previewId: PREVIEW_ID, title: "Site preview" });
    // Live is the normal state: nothing is said.
    expect(container.querySelector<HTMLElement>("[data-testid=preview-ready-status]")!.dataset.state).toBe("live");
    expect(text("[data-testid=preview-ready-status]")).toBe("");
  });

  it("reads Stopped with who can start it, and is not pressable, for a stopped site nobody recorded how to start", async () => {
    mocks.getSitePreview.mockResolvedValue(stopped({ restartable: false }));
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · ask Octo to start it again");
    expect(disabled()).toBe(true);
    expect(container.querySelector("[data-testid=preview-card-open-icon]")).toBeNull();
    await act(async () => open().click());
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
    expect(opener.openPreview).not.toHaveBeenCalled();
  });

  // Live test, Oct 27: "stop the preview server" stopped the site and closed
  // its preview; the card then read Stopped with Open disabled for good.
  it("starts a site someone stopped and closed again from Open, as it was started", async () => {
    mocks.getSitePreview.mockResolvedValueOnce(stopped({ status: "revoked", canStart: true }))
      .mockResolvedValue(record());
    mocks.wakeSitePreview.mockResolvedValue({ state: "live" });
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · opening restarts it");
    expect(disabled()).toBe(false);
    await press("[data-testid=preview-ready-open]");
    expect(mocks.wakeSitePreview).toHaveBeenCalledOnce();
    expect(opener.openPreview).toHaveBeenCalledExactlyOnceWith({ previewId: PREVIEW_ID, title: "Site preview" });
  });

  // A preview is keyed by its machine and port: the Lisbon map's card named
  // the same preview as the hello page Octo later served on that port.
  it("does not open or start another site that took this card's port, nor show its picture or facts", async () => {
    mocks.getSitePreview.mockResolvedValue(record({
      title: "Tiny Hello", summary: "A hello page", pageDescription: "Hello",
      thumbnail: { version: "0123456789abcdef", width: 640, height: 400, capturedAt: null },
    }));
    mocks.wakeSitePreview.mockResolvedValue({ state: "live" });
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · ask Octo to start it again");
    expect(disabled()).toBe(true);
    // The record is the newer site's now: its picture and facts are not this card's.
    expect(container.querySelector("[data-testid=preview-card-picture]")).toBeNull();
    expect(container.querySelector("[data-testid=preview-card-facts]")).toBeNull();
    await act(async () => open().click());
    await flush();
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
    expect(opener.openPreview).not.toHaveBeenCalled();
  });

  it("says why a wake was refused and opens nothing", async () => {
    mocks.getSitePreview.mockResolvedValue(stopped());
    mocks.wakeSitePreview.mockRejectedValue(apiError(403, "start_needs_builder"));
    await render();
    await press("[data-testid=preview-ready-open]");
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · only people who can edit this space can start it");
    expect(opener.openPreview).not.toHaveBeenCalled();
    // Pressing again cannot help this person.
    expect(disabled()).toBe(true);
  });

  it("tells a member who may not start the machine why, before they press Open", async () => {
    mocks.getSitePreview.mockResolvedValue(stopped({ canStart: false }));
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · only people who can edit this space can start it");
    expect(disabled()).toBe(true);
    expect(container.querySelector("[data-testid=preview-ready-card]")!.className).not.toContain("hover:shadow-md");
    expect(container.querySelector("[data-testid=preview-card-open-icon]")).toBeNull();
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
    expect(text("[data-testid=preview-ready-status]")).toBe("Couldn't start · The computer this space runs on is offline");
    expect(opener.openPreview).not.toHaveBeenCalled();
    // A press wakes it again.
    expect(disabled()).toBe(false);
  });

  it("says a start that failed on the machine in plain words, and a press tries again", async () => {
    mocks.getSitePreview.mockResolvedValueOnce(record({ health: { listening: false, status: null } }))
      .mockResolvedValue(record({ health: { listening: false, status: null },
        wake: { state: "failed", startedAt: null, error: "the start command exited (exit status: 1) before the site answered on port 4173" } }));
    mocks.wakeSitePreview.mockResolvedValue({ state: "waking" });
    await render();
    await press("[data-testid=preview-ready-open]");
    await advance(2_000);
    expect(text("[data-testid=preview-ready-status]")).toBe("Couldn't start · Ask Octo to start it again");
    expect(container.querySelector("[data-testid=preview-ready-card]")!.innerHTML).not.toMatch(/4173|exit status|start command/);
    expect(opener.openPreview).not.toHaveBeenCalled();
    expect(disabled()).toBe(false);
  });

  it("follows a wake someone else started", async () => {
    mocks.getSitePreview.mockResolvedValueOnce(stopped({ wake: { state: "waking", startedAt: null, error: null } }))
      .mockResolvedValue(record());
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Starting…");
    expect(disabled()).toBe(true);
    await advance(3_000);
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLElement>("[data-testid=preview-ready-status]")!.dataset.state).toBe("live");
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
  });

  // Local drive, Oct 28: after "stop the preview server" (Octo stopped the server by its process), pressing the card
  // opened a pane with the problem in it, and only that pane's Start again brought the site back.
  it("starts a site whose server stopped (nothing answers) on a press, then opens it", async () => {
    mocks.getSitePreview.mockResolvedValueOnce(record({ health: { listening: false, status: null } }))
      .mockResolvedValue(record());
    mocks.wakeSitePreview.mockResolvedValue({ state: "waking" });
    await render();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · opening restarts it");
    expect(container.querySelector("[data-testid=preview-card-open-icon]")).not.toBeNull();
    expect(container.querySelector("[data-testid=preview-ready-restart]")).toBeNull();
    await press("[data-testid=preview-ready-open]");
    expect(mocks.wakeSitePreview).toHaveBeenCalledOnce();
    expect(text("[data-testid=preview-ready-status]")).toBe("Starting…");
    expect(opener.openPreview).not.toHaveBeenCalled();
    await advance(2_000);
    expect(opener.openPreview).toHaveBeenCalledExactlyOnceWith({ previewId: PREVIEW_ID, title: "Site preview" });
    expect(text("[data-testid=preview-ready-status]")).toBe("");
  });
});

describe("a card beside its open pane", () => {
  // Live test, Oct 27: the card and the pane each asked the controller about
  // the same site every 15 s while the pane was on screen.
  it("reads the pane's checks of the site instead of asking the same thing again", async () => {
    mocks.createSitePreviewViewer.mockResolvedValue({ viewerUrl: VIEWER, idleTimeoutSeconds: 1800, expiresAt: null });
    mocks.getSitePreview.mockResolvedValue(record());
    const opener = { openPreview: vi.fn(), visiblePreviewId: PREVIEW_ID };
    await act(async () => root.render(
      <ConversationPreviewContext.Provider value={opener}>
        <SitePreviewCard preview={{ previewId: PREVIEW_ID, title: "Site preview", port: 4173 }} projectId="project-1" />
        <SitePreviewPane projectId="project-1" previewId={PREVIEW_ID} title="Site preview" visible />
      </ConversationPreviewContext.Provider>,
    ));
    await flush();
    mocks.getSitePreview.mockClear();
    mocks.getSitePreview.mockResolvedValue(record({ health: { listening: false, status: null } }));
    await advance(60_000);
    // The pane's four checks a minute, and nothing more from the card.
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(4);
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · opening restarts it");
  });

  it("has the pane check the site when a turn ends, so the pane and the card say Stopped at once", async () => {
    mocks.createSitePreviewViewer.mockResolvedValue({ viewerUrl: VIEWER, idleTimeoutSeconds: 1800, expiresAt: null });
    mocks.getSitePreview.mockResolvedValue(record());
    mocks.runtime = { tunnelGrants: {}, runtimeStatuses: [], runs: { "run-1": { id: "run-1", status: "in_progress" } } };
    const opener = { openPreview: vi.fn(), visiblePreviewId: PREVIEW_ID };
    const draw = async () => {
      await act(async () => root.render(
        <ConversationPreviewContext.Provider value={opener}>
          <SitePreviewCard preview={{ previewId: PREVIEW_ID, title: "Site preview", port: 4173 }} projectId="project-1" />
          <SitePreviewPane projectId="project-1" previewId={PREVIEW_ID} title="Site preview" visible />
        </ConversationPreviewContext.Provider>,
      ));
      await flush();
    };
    await draw();
    expect(container.querySelector("[data-testid=site-preview-frame]")).not.toBeNull();
    mocks.getSitePreview.mockClear();
    // Octo stopped the server in this turn; the turn ends.
    mocks.getSitePreview.mockResolvedValue(record({ health: { listening: false, status: null } }));
    mocks.runtime = { ...mocks.runtime, runs: { "run-1": { id: "run-1", status: "success" } } };
    await draw();
    expect(mocks.getSitePreview).toHaveBeenCalledExactlyOnceWith("project-1", PREVIEW_ID, undefined, { fresh: true });
    expect(container.querySelector<HTMLElement>("[data-testid=site-preview-pane]")!.dataset.state).toBe("not_responding");
    expect(text("[data-testid=site-preview-problem]")).toBe("This site is stopped.Start again");
    expect(container.querySelector("[data-testid=site-preview-frame]")).toBeNull();
    expect(text("[data-testid=preview-ready-status]")).toBe("Stopped · opening restarts it");
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
    // One line and one button: no Reload beside it, no pill above it saying the same.
    expect(container.querySelector("[data-testid=site-preview-problem] [role=status]")?.textContent).toBe("This site is stopped.");
    expect([...container.querySelectorAll("[data-testid=site-preview-problem] button")].map(button => button.textContent)).toEqual(["Start again"]);
    expect(container.querySelector("[data-testid=site-preview-status]")).toBeNull();
    await press("[data-testid=site-preview-wake]");
    expect(mocks.wakeSitePreview).toHaveBeenCalledOnce();
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(frame()?.getAttribute("src")).toContain("p-aaaa");
  });

  it("says a failed Start again in plain words, with no port or command", async () => {
    mocks.createSitePreviewViewer.mockRejectedValue(apiError(409));
    mocks.getSitePreview.mockResolvedValueOnce(stopped()).mockResolvedValue(stopped({
      wake: { state: "failed", startedAt: null, error: "the site did not answer on port 4173 within 60 s" },
    }));
    mocks.wakeSitePreview.mockResolvedValue({ state: "waking" });
    await render();
    await press("[data-testid=site-preview-wake]");
    await advance(2_000);
    expect(text("[data-testid=site-preview-feedback]")).toContain("Couldn't start it. Ask Octo to start it again.");
    expect(container.querySelector("[data-testid=site-preview-pane]")!.textContent).not.toContain("4173");
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

  it("says who can start it, with no button, to a member who may not start the machine", async () => {
    mocks.createSitePreviewViewer.mockRejectedValue(apiError(409));
    mocks.getSitePreview.mockResolvedValue(stopped({ canStart: false }));
    await render();
    expect(text("[data-testid=site-preview-problem]"))
      .toBe("This site is stopped. Only people who can edit this space can start it. Ask one of them to open it.");
    expect(container.querySelector("[data-testid=site-preview-wake]")).toBeNull();
    expect(mocks.wakeSitePreview).not.toHaveBeenCalled();
  });

  it("says only that the site is stopped until a record says whether Start again can work", async () => {
    mocks.createSitePreviewViewer.mockRejectedValue(apiError(409));
    mocks.getSitePreview.mockReturnValue(new Promise(() => {}));
    await render();
    expect(text("[data-testid=site-preview-problem]")).toBe("This site is stopped.");
    expect(container.querySelector("[data-testid=site-preview-problem] button")).toBeNull();
  });

  it("asks Octo, not the pane, for a site nobody recorded how to start", async () => {
    mocks.createSitePreviewViewer.mockRejectedValue(apiError(409));
    mocks.getSitePreview.mockResolvedValue(stopped({ restartable: false }));
    await render();
    expect(text("[data-testid=site-preview-problem]")).toBe("This site is stopped. Ask Octo to start it again.");
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
