// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialRuntimeStoreState, runtimeReducer } from "../../../../runtime/runtimeStore";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import type { ControllerSitePreview } from "../../../../services/runtimeController/previews";
import { mapTunnelGrantFromPayload } from "../../../../services/runtimeController/runtimes";
import { ConversationPreviewContext, type ConversationPreviewOpener } from "../../../../workspace/ConversationPreviewContext";
import { SitePreviewCard, shareSitePreviewRecord } from "../SitePreviewCard";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const mocks = vi.hoisted(() => ({
  getSitePreview: vi.fn(),
  runtime: { tunnelGrants: {} as Record<string, unknown>, runtimeStatuses: [] as unknown[] } as Record<string, unknown> | null,
}));

vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  getSitePreview: mocks.getSitePreview,
}));
vi.mock("../../../../runtime/RuntimeStateProvider", () => ({ useOptionalRuntimeState: () => mocks.runtime }));

const preview = { previewId: PREVIEW_ID, title: "Site preview", port: 4173 };
function server(overrides: Partial<ControllerSitePreview> = {}): ControllerSitePreview {
  return {
    previewId: PREVIEW_ID, title: "Site preview", port: 4173, path: "/", runtimeId: "runtime-1", status: "active",
    health: { listening: true, status: 200 }, messageId: "card-1", createdAt: null, visibility: "private", ...overrides,
  };
}
const apiError = (status: number) => new ControllerApiError({ status, message: "error", code: null, details: null });

describe("SitePreviewCard", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: ConversationPreviewOpener | null;

  // One minute at a time, so each step's re-render sets the next timer.
  async function advanceMinutes(minutes: number) {
    for (let minute = 0; minute < minutes; minute += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    }
  }

  async function render(cards = 1) {
    await act(async () => root.render(
      <ConversationPreviewContext.Provider value={opener}>
        {Array.from({ length: cards }, (_, index) => <SitePreviewCard key={index} preview={preview} projectId="project-1" />)}
      </ConversationPreviewContext.Provider>,
    ));
    await act(async () => { await Promise.resolve(); });
  }
  const card = () => container.querySelector<HTMLElement>("[data-testid=preview-ready-card]")!;
  const status = () => container.querySelector<HTMLElement>("[data-testid=preview-ready-status]")!;
  const openButton = () => container.querySelector<HTMLButtonElement>("[data-testid=preview-ready-open]");

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.getSitePreview.mockReset();
    mocks.runtime = { tunnelGrants: {}, runtimeStatuses: [] };
    opener = { openPreview: vi.fn(), visiblePreviewId: null };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reads Checking until the controller answers, never Live from the message, and holds no link", async () => {
    mocks.getSitePreview.mockReturnValue(new Promise(() => {}));
    await render();
    expect(status().dataset.state).toBe("checking");
    expect(status().textContent).toBe("Checking…");
    expect(card().textContent).toContain("Ready to preview");
    expect(card().textContent).toContain("Site preview");
    // Who may open it is said only once the controller says so.
    expect(card().textContent).not.toContain("Only space members");
    expect(card().querySelector("a, [href], iframe")).toBeNull();
  });

  it("says Only space members only when the controller's record says the preview is private", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    expect(card().textContent).toContain("Only space members");

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.getSitePreview.mockResolvedValue(server({ visibility: null }));
    await render();
    expect(status().textContent).toBe("Live");
    expect(card().textContent).not.toContain("Only space members");
  });

  it("reads Live from the grant and the probe, with Open", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    expect(mocks.getSitePreview).toHaveBeenCalledWith("project-1", PREVIEW_ID, expect.any(AbortSignal));
    expect(status().dataset.state).toBe("live");
    expect(status().textContent).toBe("Live");
    expect(openButton()?.textContent).toBe("Open");
    expect(openButton()?.disabled).toBe(false);
  });

  it.each([
    ["nothing listens", { listening: false, status: null }],
    ["the site answers 502", { listening: true, status: 502 }],
  ])("reads Not responding on its port when %s, and still offers Open", async (_name, health) => {
    mocks.getSitePreview.mockResolvedValue(server({ health }));
    await render();
    expect(status().dataset.state).toBe("not_responding");
    expect(status().textContent).toBe("Not responding on port 4173");
    expect(openButton()?.disabled).toBe(false);
  });

  // Live needs proof: a probe that saw the site answer on an active tunnel.
  // The pane reads the same record as Checking too, so the two never disagree.
  it("reads Checking, never Live, when the broker could not probe the site, as the pane does", async () => {
    mocks.getSitePreview.mockResolvedValue(server({ health: null }));
    await render();
    expect(status().dataset.state).toBe("checking");
    expect(status().textContent).toBe("Checking…");
  });

  it("reads Checking, never Live, while the tunnel is not active yet", async () => {
    mocks.getSitePreview.mockResolvedValue(server({ status: "issuing" }));
    await render();
    expect(status().dataset.state).toBe("checking");
    expect(status().textContent).toBe("Checking…");
  });

  it.each([
    ["the preview is gone", () => mocks.getSitePreview.mockRejectedValue(apiError(404))],
    ["this viewer may not see it", () => mocks.getSitePreview.mockRejectedValue(apiError(403))],
    ["the controller says it stopped", () => mocks.getSitePreview.mockRejectedValue(apiError(409))],
    ["its grant is revoked on the controller", () => mocks.getSitePreview.mockResolvedValue(server({ status: "revoked" }))],
    ["a tunnel event revoked its grant", () => {
      mocks.getSitePreview.mockResolvedValue(server());
      mocks.runtime = { tunnelGrants: { [PREVIEW_ID]: { id: PREVIEW_ID, tunnelId: "tunnel-1", status: "revoked" } }, runtimeStatuses: [] };
    }],
    ["its runtime stopped", () => {
      mocks.getSitePreview.mockResolvedValue(server());
      mocks.runtime = { tunnelGrants: {}, runtimeStatuses: [{ runtimeId: "runtime-1", status: "stopped" }] };
    }],
  ])("reads Stopped and says to ask Octo, with no dead Open, when %s and nothing records how to start it", async (_name, arrange) => {
    arrange();
    await render();
    expect(status().dataset.state).toBe("stopped");
    expect(status().textContent).toBe("Stopped · ask Octo to start it again");
    expect(openButton()).toBeNull();
    // A stopped site's pane may still be selected; the card never says Showing for it.
    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render();
    expect(card().textContent).not.toContain("Showing");
  });

  it("reads Stopped with Open while the controller has not said whether it can start the site", async () => {
    mocks.getSitePreview.mockReturnValue(new Promise(() => {}));
    mocks.runtime = { tunnelGrants: { [PREVIEW_ID]: { id: PREVIEW_ID, tunnelId: "tunnel-1", status: "revoked" } }, runtimeStatuses: [] };
    await render();
    expect(status().textContent).toBe("Stopped");
    expect(openButton()?.disabled).toBe(true);
  });

  it("reads Stopped from a revoked tunnel event even when asking again fails", async () => {
    // The store as the real reducer leaves it: the preview's tunnel came up, then was revoked.
    const grant = mapTunnelGrantFromPayload({ id: "grant-1", tunnelId: PREVIEW_ID, projectId: "project-1", runtimeId: "runtime-1",
      provider: "self_hosted", status: "active", kind: "preview" })!;
    let store = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant });
    mocks.runtime = store as unknown as Record<string, unknown>;
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    expect(status().textContent).toBe("Live");

    store = runtimeReducer(store, { type: "upsertTunnelGrant", grant: { ...grant, status: "revoked" } });
    mocks.runtime = store as unknown as Record<string, unknown>;
    mocks.getSitePreview.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
    expect(status().dataset.state).toBe("stopped");
    // Its last record recorded no start command, so the card says how to get it back.
    expect(status().textContent).toBe("Stopped · ask Octo to start it again");
  });

  it("says Status unavailable after a failed check, and asks again", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockRejectedValueOnce(apiError(500));
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    expect(status().dataset.state).toBe("unavailable");
    expect(status().textContent).toBe("Status unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
    expect(status().textContent).toBe("Live");
  });

  it("stops asking after a few failed checks, until a press", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    await advanceMinutes(10);
    // The first check and four retries, then nothing for the rest of the ten minutes.
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(5);
    expect(status().textContent).toBe("Status unavailable");

    mocks.getSitePreview.mockResolvedValue(server());
    await act(async () => openButton()!.click());
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(6);
    expect(status().textContent).toBe("Live");
  });

  it.each([
    ["previews are not configured", 503],
    ["the session is gone", 401],
  ])("asks once and stops when %s", async (_name, code) => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockRejectedValue(apiError(code));
    await render();
    await advanceMinutes(10);
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe("Status unavailable");
  });

  it("waits for the page to be visible before it retries", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      mocks.getSitePreview.mockRejectedValueOnce(apiError(500));
      mocks.getSitePreview.mockResolvedValue(server());
      await render();
      await advanceMinutes(3);
      expect(mocks.getSitePreview).toHaveBeenCalledTimes(1);
      visibility = "visible";
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
      expect(status().textContent).toBe("Live");
    } finally {
      // Back to jsdom's own (visible) value.
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("follows a site that is not responding for a while, then stops until a tunnel event", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockResolvedValue(server({ health: { listening: false, status: null } }));
    await render();
    await advanceMinutes(60);
    // The first check and eight follow-ups, then nothing for the rest of the hour.
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(9);

    // A tunnel event for the preview asks again, and the site is back.
    mocks.getSitePreview.mockResolvedValue(server());
    mocks.runtime = { tunnelGrants: { [PREVIEW_ID]: { id: PREVIEW_ID, tunnelId: "tunnel-1", status: "issuing" } }, runtimeStatuses: [] };
    await render();
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(10);
    expect(status().textContent).toBe("Live");
  });

  it("reads Showing while its pane is on screen", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render();
    expect(openButton()?.textContent).toBe("Showing");
    expect(openButton()?.disabled).toBe(true);
  });

  // The pane checks its site every 15 s while it is on screen; the cards read
  // those checks instead of asking the controller the same thing again.
  it("keeps up with the site while its pane is on screen from the pane's own checks, asking nothing itself", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(1);

    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(1);
    await act(async () => shareSitePreviewRecord(PREVIEW_ID, server({ health: { listening: false, status: null } })));
    expect(status().textContent).toBe("Not responding on port 4173");
  });

  it("tells every card of a preview what its pane found, while none of them asks", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockResolvedValue(server());
    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render(3);
    // Each card checks once when it is drawn.
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(3);
    await advanceMinutes(1);
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(3);
    await act(async () => shareSitePreviewRecord(PREVIEW_ID, server({ health: { listening: false, status: null } })));
    const states = [...container.querySelectorAll<HTMLElement>("[data-testid=preview-ready-status]")].map((element) => element.textContent);
    expect(states).toEqual(Array(3).fill("Not responding on port 4173"));
  });

  it("follows a site that is not responding a bounded number of times for all its cards together", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockResolvedValue(server({ health: { listening: false, status: null } }));
    await render(3);
    await advanceMinutes(60);
    // Three first checks and eight follow-ups for the preview, not eight per card.
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(11);
  });

  it("opens nothing by itself, and on a press opens the preview it was drawn for", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(opener!.openPreview).not.toHaveBeenCalled();
    await act(async () => openButton()!.click());
    expect(opener!.openPreview).toHaveBeenCalledExactlyOnceWith({ previewId: PREVIEW_ID, title: "Site preview" });
    // A press also checks the site again, so the card is current beside the pane.
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
  });

  it("offers no Open where previews cannot open, and works without a runtime store", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    mocks.runtime = null;
    opener = null;
    await render();
    expect(status().textContent).toBe("Live");
    expect(openButton()).toBeNull();
  });
});
