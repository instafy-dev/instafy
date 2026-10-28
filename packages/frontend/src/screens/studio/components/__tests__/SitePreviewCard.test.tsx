// @vitest-environment jsdom
import { NavArrowRight, OpenNewWindow } from "iconoir-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
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
  getSitePreviewThumbnail: vi.fn(),
  runtime: { tunnelGrants: {} as Record<string, unknown>, runtimeStatuses: [] as unknown[] } as Record<string, unknown> | null,
}));

vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  getSitePreview: mocks.getSitePreview,
  getSitePreviewThumbnail: mocks.getSitePreviewThumbnail,
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
  // The card's own button: its area is the whole card.
  const openButton = () => container.querySelector<HTMLButtonElement>("[data-testid=preview-ready-open]");
  const disabled = () => openButton()?.getAttribute("aria-disabled") === "true";

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.getSitePreview.mockReset();
    mocks.getSitePreviewThumbnail.mockReset();
    mocks.runtime = { tunnelGrants: {}, runtimeStatuses: [] };
    opener = { openPreview: vi.fn(), visiblePreviewId: null };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reads Checking until the controller answers, says so only after 3 s, never Live from the message, and holds no link", async () => {
    vi.useFakeTimers();
    mocks.getSitePreview.mockReturnValue(new Promise(() => {}));
    await render();
    expect(status().dataset.state).toBe("checking");
    // Most checks answer at once: nothing is said for the first 3 s.
    expect(status().textContent).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(status().textContent).toBe("Checking the site…");
    expect(card().textContent).toContain("Site preview");
    // Who may open it is shown only once the controller says so.
    expect(container.querySelector("[data-testid=preview-card-private]")).toBeNull();
    expect(card().querySelector("a, [href], iframe")).toBeNull();
  });

  it("has no Ready to preview text, and the whole card is one button named Open {title}", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    expect(card().textContent).not.toMatch(/ready to preview/i);
    const buttons = card().querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toBe(openButton());
    expect(openButton()?.getAttribute("aria-label")).toBe("Open Site preview");
    // Its area is the whole card.
    expect(openButton()?.className).toContain("after:inset-0");
    expect(card().className).toContain("relative");
  });

  it("shows a chevron in the title row to open it beside the chat, not the open-in-a-new-tab icon", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    const icon = container.querySelector("[data-testid=preview-card-open-icon]")!;
    expect(icon).not.toBeNull();
    expect(icon.parentElement).toBe(openButton()!.parentElement);
    // iconoir draws its icons without a name: compare the drawing. The pane's "Open in new tab" icon would say the
    // site opens elsewhere; the card opens it beside the chat.
    const drawing = (markup: string) => new DOMParser().parseFromString(markup, "text/html").body.querySelector("svg")!.innerHTML;
    expect(icon.innerHTML).toBe(drawing(renderToStaticMarkup(<NavArrowRight />)));
    expect(icon.innerHTML).not.toBe(drawing(renderToStaticMarkup(<OpenNewWindow />)));
    expect(container.querySelector("[data-testid=preview-ready-follow], [data-testid=preview-ready-restart]")).toBeNull();
  });

  it("says Only space members by a lock with a name, not in visible text, and only when the record says private", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    const lock = container.querySelector<HTMLElement>("[data-testid=preview-card-private]")!;
    expect(lock.getAttribute("role")).toBe("img");
    expect(lock.getAttribute("aria-label")).toBe("Only space members can open this");
    expect(lock.getAttribute("title")).toBe("Only space members can open this");
    expect(card().textContent).not.toContain("Only space members");

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.getSitePreview.mockResolvedValue(server({ visibility: null }));
    await render();
    expect(status().dataset.state).toBe("live");
    expect(container.querySelector("[data-testid=preview-card-private]")).toBeNull();
  });

  it("says nothing about a site that is simply live, and opens on a press", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    expect(mocks.getSitePreview).toHaveBeenCalledWith("project-1", PREVIEW_ID, expect.any(AbortSignal));
    expect(status().dataset.state).toBe("live");
    expect(status().textContent).toBe("");
    expect(card().textContent).not.toMatch(/\bLive\b/);
    expect(disabled()).toBe(false);
    expect(card().className).toContain("hover:shadow-md");
  });

  it.each([
    ["nothing listens", { listening: false, status: null }],
    ["the site answers 502", { listening: true, status: 502 }],
  ])("reads Not responding when %s, with the port on hover, and still opens", async (_name, health) => {
    mocks.getSitePreview.mockResolvedValue(server({ health }));
    await render();
    expect(status().dataset.state).toBe("not_responding");
    expect(status().textContent).toBe("Not responding");
    expect(status().getAttribute("title")).toBe("Nothing answers on port 4173");
    expect(disabled()).toBe(false);
    expect(openButton()?.getAttribute("aria-label")).toBe("Open Site preview, not responding");
  });

  // Live needs proof: a probe that saw the site answer on an active tunnel.
  // The pane reads the same record as Checking too, so the two never disagree.
  it("reads Checking, never Live, when the broker could not probe the site, as the pane does", async () => {
    mocks.getSitePreview.mockResolvedValue(server({ health: null }));
    await render();
    expect(status().dataset.state).toBe("checking");
    expect(status().textContent).toBe("");
  });

  it("reads Checking, never Live, while the tunnel is not active yet", async () => {
    mocks.getSitePreview.mockResolvedValue(server({ status: "issuing" }));
    await render();
    expect(status().dataset.state).toBe("checking");
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
  ])("reads Stopped with who can start it, and does not look pressable, when %s and nothing records how to start it", async (_name, arrange) => {
    arrange();
    await render();
    expect(status().dataset.state).toBe("stopped");
    // Nothing on the card can start it: the line says who can, as the pane does.
    expect(status().textContent).toBe("Stopped · ask Octo to start it again");
    expect(disabled()).toBe(true);
    expect(card().className).not.toContain("hover:shadow-md");
    expect(openButton()?.className).toContain("cursor-default");
    // No chevron: it would promise a press that does nothing.
    expect(container.querySelector("[data-testid=preview-card-open-icon]")).toBeNull();
    expect(openButton()?.getAttribute("aria-label")).toBe("Open Site preview, stopped, ask Octo to start it again");
    await act(async () => openButton()!.click());
    expect(opener!.openPreview).not.toHaveBeenCalled();
    // A stopped site's pane may still be selected; the card never says Showing for it.
    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render();
    expect(card().textContent).not.toContain("Showing");
  });

  it("reads Stopped, not pressable, while the controller has not said whether it can start the site", async () => {
    mocks.getSitePreview.mockReturnValue(new Promise(() => {}));
    mocks.runtime = { tunnelGrants: { [PREVIEW_ID]: { id: PREVIEW_ID, tunnelId: "tunnel-1", status: "revoked" } }, runtimeStatuses: [] };
    await render();
    expect(status().textContent).toBe("Stopped · ask Octo to start it again");
    expect(disabled()).toBe(true);
    expect(container.querySelector("[data-testid=preview-card-open-icon]")).toBeNull();
  });

  it("reads Stopped from a revoked tunnel event even when asking again fails", async () => {
    // The store as the real reducer leaves it: the preview's tunnel came up, then was revoked.
    const grant = mapTunnelGrantFromPayload({ id: "grant-1", tunnelId: PREVIEW_ID, projectId: "project-1", runtimeId: "runtime-1",
      provider: "self_hosted", status: "active", kind: "preview" })!;
    let store = runtimeReducer(createInitialRuntimeStoreState(), { type: "upsertTunnelGrant", grant });
    mocks.runtime = store as unknown as Record<string, unknown>;
    mocks.getSitePreview.mockResolvedValue(server());
    await render();
    expect(status().dataset.state).toBe("live");

    store = runtimeReducer(store, { type: "upsertTunnelGrant", grant: { ...grant, status: "revoked" } });
    mocks.runtime = store as unknown as Record<string, unknown>;
    mocks.getSitePreview.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
    expect(status().dataset.state).toBe("stopped");
    // Its last record recorded no start command: Stopped, and nothing to press.
    expect(status().textContent).toBe("Stopped · ask Octo to start it again");
    expect(disabled()).toBe(true);
  });

  it("shows the site's picture when the record has one, fetched with the person's session and never framed", async () => {
    const createObjectURL = vi.fn(() => "blob:picture-1");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    mocks.getSitePreview.mockResolvedValue(server({ thumbnail: { version: "0123456789abcdef", width: 640, height: 400, capturedAt: null } }));
    mocks.getSitePreviewThumbnail.mockResolvedValue({ ok: true, blob: new Blob(["x"], { type: "image/jpeg" }) });
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.getSitePreviewThumbnail).toHaveBeenCalledWith("project-1", PREVIEW_ID, "0123456789abcdef");
    const picture = container.querySelector<HTMLElement>("[data-testid=preview-card-picture]")!;
    expect(picture).not.toBeNull();
    const image = picture.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("blob:picture-1");
    // Decorative: the title names the site.
    expect(image.getAttribute("alt")).toBe("");
    // The picture sits above the title, and the plain-card icon is gone.
    expect(card().firstElementChild).toBe(picture);
    expect(card().querySelector("iframe")).toBeNull();
    await act(async () => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:picture-1");
    root = createRoot(container);
  });

  it("has no picture area and shows the site icon when the record has no picture", async () => {
    mocks.getSitePreview.mockResolvedValue(server({ thumbnail: null }));
    await render();
    expect(container.querySelector("[data-testid=preview-card-picture]")).toBeNull();
    expect(openButton()!.parentElement!.querySelector("svg")).not.toBeNull();
    expect(mocks.getSitePreviewThumbnail).not.toHaveBeenCalled();
  });

  it("shows one line of facts: the skill's summary, else the page's own description, as plain text", async () => {
    mocks.getSitePreview.mockResolvedValue(server({ summary: "Trip · 3 days · 14 places", pageDescription: "A map of Lisbon" }));
    await render();
    expect(container.querySelector("[data-testid=preview-card-facts]")?.textContent).toBe("Trip · 3 days · 14 places");

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.getSitePreview.mockResolvedValue(server({ summary: null, pageDescription: "[A map](https://example.com) of Lisbon" }));
    await render();
    const facts = container.querySelector("[data-testid=preview-card-facts]")!;
    expect(facts.textContent).toBe("[A map](https://example.com) of Lisbon");
    expect(facts.querySelector("a")).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.getSitePreview.mockResolvedValue(server({ summary: null, pageDescription: null }));
    await render();
    expect(container.querySelector("[data-testid=preview-card-facts]")).toBeNull();
  });

  it("asks again when the preview gets a new picture, from the latest card only", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    // Two cards Octo posted for the site, in two runs.
    await act(async () => root.render(
      <ConversationPreviewContext.Provider value={opener}>
        <SitePreviewCard preview={preview} projectId="project-1" postedAt={1} messageKey="card-1" />
        <SitePreviewCard preview={preview} projectId="project-1" postedAt={2} messageKey="card-2" />
      </ConversationPreviewContext.Provider>,
    ));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:preview-thumbnail-updated", { detail: { previewId: PREVIEW_ID, version: "0123456789abcdef" } }));
    });
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(3);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:preview-thumbnail-updated", { detail: { previewId: "another", version: "0123456789abcdef" } }));
    });
    expect(mocks.getSitePreview).toHaveBeenCalledTimes(3);
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
    expect(status().dataset.state).toBe("live");
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
    expect(status().dataset.state).toBe("live");
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
      expect(status().dataset.state).toBe("live");
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
    expect(status().dataset.state).toBe("live");
  });

  it("focuses the pane's view on a press when the site is already beside the chat", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    opener = { ...opener!, visiblePreviewId: PREVIEW_ID };
    await render();
    expect(disabled()).toBe(false);
    await act(async () => openButton()!.click());
    expect(opener!.openPreview).toHaveBeenCalledExactlyOnceWith({ previewId: PREVIEW_ID, title: "Site preview" });
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
    expect(status().textContent).toBe("Not responding");
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
    expect(states).toEqual(Array(3).fill("Not responding"));
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

  it("does not look pressable where previews cannot open, and works without a runtime store", async () => {
    mocks.getSitePreview.mockResolvedValue(server());
    mocks.runtime = null;
    opener = null;
    await render();
    expect(status().dataset.state).toBe("live");
    expect(disabled()).toBe(true);
  });
});
