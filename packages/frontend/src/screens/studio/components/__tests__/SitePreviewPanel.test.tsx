// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSitePreviewView } from "../../../../workspace/conversationSurfaces";
import { SITE_PREVIEW_HEARTBEAT_MS } from "../SitePreviewPane";
import { SitePreviewPanel } from "../SitePreviewPanel";
import { withHostQuery } from "../previewHost/hostMessages";

const DOCS_ID = "11111111-1111-4111-8111-111111111111";
const SHOP_ID = "22222222-2222-4222-8222-222222222222";
const hex = (id: string) => id.replace(/-/g, "");
const viewer = (letter: string, previewId: string) => `https://p-${letter.repeat(26)}--${hex(previewId)}.preview.localhost/`;

const mocks = vi.hoisted(() => ({
  createSitePreviewViewer: vi.fn(),
  getSitePreview: vi.fn(),
  heartbeatSitePreviewViewer: vi.fn(),
  revokeSitePreviewViewer: vi.fn(),
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../services/runtimeController/previews")>();
  return { ...actual, ...mocks };
});
vi.mock("../../../../utils/openExternalUrl", () => ({ reserveExternalWindow: vi.fn() }));

const DOCS: ConversationSitePreviewView = { id: `preview:${DOCS_ID}`, previewId: DOCS_ID, title: "Docs site" };
const SHOP: ConversationSitePreviewView = { id: `preview:${SHOP_ID}`, previewId: SHOP_ID, title: "Shop" };

describe("SitePreviewPanel", () => {
  let root: Root;
  let container: HTMLDivElement;

  async function render(props: { scope: string; previews: ConversationSitePreviewView[]; visiblePreviewId: string | null }) {
    await act(async () => root.render(<SitePreviewPanel id="chat-preview" label="Preview" projectId="project-1" {...props} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
  const slots = () => [...container.querySelectorAll<HTMLElement>("[data-testid=site-preview-slot]")];
  const beatsFor = (previewId: string) => mocks.heartbeatSitePreviewViewer.mock.calls.filter(call => call[1] === previewId).length;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    Object.values(mocks).forEach(mock => mock.mockReset());
    let minted = 0;
    mocks.createSitePreviewViewer.mockImplementation(async (_project: string, previewId: string) => ({
      viewerUrl: viewer("abcdefgh"[minted++]!, previewId), idleTimeoutSeconds: 1800, expiresAt: null,
    }));
    mocks.getSitePreview.mockImplementation(async (_project: string, previewId: string) => ({
      previewId, title: "Site", port: 4173, path: "/", runtimeId: null, status: "active",
      health: { listening: true, status: 200 }, messageId: null, createdAt: null,
    }));
    mocks.heartbeatSitePreviewViewer.mockResolvedValue("live");
    mocks.revokeSitePreviewViewer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("is the tab panel the preview tabs point at", async () => {
    await render({ scope: "conversation-a", previews: [DOCS], visiblePreviewId: DOCS_ID });
    const panel = container.querySelector<HTMLElement>("#chat-preview");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.hidden).toBe(false);
  });

  it("keeps a pane mounted once shown, and only the pane on screen keeps its session alive", async () => {
    await render({ scope: "conversation-a", previews: [DOCS, SHOP], visiblePreviewId: DOCS_ID });
    // Shop has never been shown, so nothing is minted for it.
    expect(slots()).toHaveLength(1);
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(1);

    await render({ scope: "conversation-a", previews: [DOCS, SHOP], visiblePreviewId: SHOP_ID });
    expect(slots()).toHaveLength(2);
    expect(slots().map(slot => slot.hidden)).toEqual([true, false]);
    const docsBeats = beatsFor(DOCS_ID);
    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_PREVIEW_HEARTBEAT_MS * 3); });
    // The hidden Docs pane sends no heartbeat; the Shop pane on screen does.
    expect(beatsFor(DOCS_ID)).toBe(docsBeats);
    expect(beatsFor(SHOP_ID)).toBeGreaterThanOrEqual(3);
    // Switching back did not reload the site: still one session each, none revoked.
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(mocks.revokeSitePreviewViewer).not.toHaveBeenCalled();
  });

  it("hides the panel and stops every heartbeat when no preview is on screen", async () => {
    await render({ scope: "conversation-a", previews: [DOCS], visiblePreviewId: DOCS_ID });
    await render({ scope: "conversation-a", previews: [DOCS], visiblePreviewId: null });
    expect(container.querySelector<HTMLElement>("#chat-preview")?.hidden).toBe(true);
    const beats = mocks.heartbeatSitePreviewViewer.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(SITE_PREVIEW_HEARTBEAT_MS * 3); });
    expect(mocks.heartbeatSitePreviewViewer.mock.calls.length).toBe(beats);
    expect(mocks.revokeSitePreviewViewer).not.toHaveBeenCalled();
  });

  it("unmounts and revokes a pane when its tab closes", async () => {
    await render({ scope: "conversation-a", previews: [DOCS, SHOP], visiblePreviewId: DOCS_ID });
    await render({ scope: "conversation-a", previews: [SHOP], visiblePreviewId: null });
    expect(slots()).toHaveLength(0);
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", DOCS_ID, viewer("a", DOCS_ID));
  });

  it("unmounts and revokes the panes of a conversation that is left, even for the same preview", async () => {
    await render({ scope: "conversation-a", previews: [DOCS], visiblePreviewId: DOCS_ID });
    await render({ scope: "conversation-b", previews: [DOCS], visiblePreviewId: DOCS_ID });
    expect(mocks.revokeSitePreviewViewer).toHaveBeenCalledExactlyOnceWith("project-1", DOCS_ID, viewer("a", DOCS_ID));
    // The other conversation's pane is its own, with its own session.
    expect(mocks.createSitePreviewViewer).toHaveBeenCalledTimes(2);
    expect(slots()).toHaveLength(1);
    expect(container.querySelector("[data-testid=site-preview-frame]")?.getAttribute("src")).toBe(withHostQuery(viewer("b", DOCS_ID)));
  });
});
