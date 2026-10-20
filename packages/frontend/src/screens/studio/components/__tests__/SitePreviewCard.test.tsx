// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerApiError } from "../../../../services/runtimeController/core";
import type { ControllerSitePreview } from "../../../../services/runtimeController/previews";
import { ConversationPreviewContext, type ConversationPreviewOpener } from "../../../../workspace/ConversationPreviewContext";
import { SitePreviewCard } from "../SitePreviewCard";

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
    health: { listening: true, status: 200 }, messageId: "card-1", createdAt: null, ...overrides,
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

  async function render() {
    await act(async () => root.render(
      <ConversationPreviewContext.Provider value={opener}>
        <SitePreviewCard preview={preview} projectId="project-1" />
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
    expect(card().textContent).toContain("Only space members");
    expect(card().querySelector("a, [href], iframe")).toBeNull();
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
  it("says Status unavailable, never Live, when the broker could not probe the site", async () => {
    mocks.getSitePreview.mockResolvedValue(server({ health: null }));
    await render();
    expect(status().dataset.state).toBe("unavailable");
    expect(status().textContent).toBe("Status unavailable");
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
  ])("reads Stopped, with Open disabled, when %s", async (_name, arrange) => {
    arrange();
    await render();
    expect(status().dataset.state).toBe("stopped");
    expect(status().textContent).toBe("Stopped");
    expect(openButton()?.disabled).toBe(true);
    // A stopped site's pane may still be selected; the card never says Showing for it.
    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render();
    expect(openButton()?.textContent).toBe("Open");
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

  it("keeps up with the site while its pane is on screen, and only then", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(1);

    mocks.getSitePreview.mockResolvedValue(server({ health: { listening: false, status: null } }));
    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(status().textContent).toBe("Not responding on port 4173");
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
