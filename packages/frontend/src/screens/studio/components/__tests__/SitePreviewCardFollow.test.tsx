// @vitest-environment jsdom
// Follow mode on upstream's "Ready to preview" card: who presents, and Follow in one press.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerSitePreview } from "../../../../services/runtimeController/previews";
import { ConversationPreviewContext, type ConversationPreviewOpener } from "../../../../workspace/ConversationPreviewContext";
import { SitePreviewCard } from "../SitePreviewCard";
import { applyFollowPresenceEvent, followEntry, publishFollowRole, resetFollowStoreForTests, setFollowAccount } from "../previewHost/followStore";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const kim = { id: "u-kim", name: "Kim", avatarUrl: null };
const mocks = vi.hoisted(() => ({ getSitePreview: vi.fn(), getFollowState: vi.fn() }));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  getSitePreview: mocks.getSitePreview,
}));
vi.mock("../../../../services/runtimeController/previewFollow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previewFollow")>()),
  getFollowState: mocks.getFollowState,
}));
vi.mock("../../../../runtime/RuntimeStateProvider", () => ({ useOptionalRuntimeState: () => ({ tunnelGrants: {}, runtimeStatuses: [] }) }));

function record(overrides: Partial<ControllerSitePreview> = {}): ControllerSitePreview {
  return {
    previewId: PREVIEW_ID, title: "Site preview", port: 4173, path: "/", runtimeId: "runtime-1", status: "active",
    health: { listening: true, status: 200 }, messageId: "card-1", createdAt: null, visibility: "private", ...overrides,
  };
}

describe("SitePreviewCard follow mode", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: ConversationPreviewOpener;
  async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
  async function render() {
    await act(async () => root.render(
      <ConversationPreviewContext.Provider value={opener}>
        <SitePreviewCard preview={{ previewId: PREVIEW_ID, title: "Site preview", port: 4173 }} projectId="project-1" />
      </ConversationPreviewContext.Provider>,
    ));
    await flush();
  }
  const q = (selector: string) => container.querySelector<HTMLElement>(selector);

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    Object.values(mocks).forEach(mock => { if (typeof mock === "function") mock.mockReset(); });
    mocks.getSitePreview.mockResolvedValue(record());
    mocks.getFollowState.mockResolvedValue({ presence: null, followers: [] });
    opener = { openPreview: vi.fn(), visiblePreviewId: null };
    resetFollowStoreForTests();
    setFollowAccount("u-lena");
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("asks once who presents a live site, says who, and Follow opens it already following", async () => {
    mocks.getFollowState.mockResolvedValue({ presence: { presentationId: "pres-kim", presenter: kim, state: "live", followers: 2 }, followers: [] });
    await render();
    expect(mocks.getFollowState).toHaveBeenCalledOnce();
    expect(q("[data-testid=preview-ready-follow-line]")!.textContent).toBe("Kim is presenting · 2 watching");
    expect(q("[data-testid=preview-ready-follow]")!.textContent).toBe("Follow Kim");
    await act(async () => q("[data-testid=preview-ready-follow]")!.click());
    await flush();
    expect(followEntry(PREVIEW_ID).followRequested).toBe(true);
    expect(opener.openPreview).toHaveBeenCalledExactlyOnceWith({ previewId: PREVIEW_ID, title: "Site preview" });
  });

  it("follows presence events, says away, and offers nothing to follow once it ends", async () => {
    await render();
    expect(q("[data-testid=preview-ready-follow-line]")).toBeNull();
    await act(async () => applyFollowPresenceEvent(PREVIEW_ID, "pres-kim", { presentationId: "pres-kim", presenter: kim, state: "away", followers: 0 }));
    expect(q("[data-testid=preview-ready-follow-line]")!.textContent).toBe("Kim is away");
    await act(async () => applyFollowPresenceEvent(PREVIEW_ID, "pres-kim", null));
    expect(q("[data-testid=preview-ready-follow-line]")).toBeNull();
    expect(q("[data-testid=preview-ready-follow]")).toBeNull();
  });

  it("never offers Follow for the person's own presentation or while this device already follows", async () => {
    await render();
    await act(async () => applyFollowPresenceEvent(PREVIEW_ID, "pres-me", { presentationId: "pres-me", presenter: { id: "u-lena", name: "Lena" }, state: "live", followers: 1 }));
    expect(q("[data-testid=preview-ready-follow-line]")!.textContent).toBe("You're presenting on another screen · 1 watching");
    expect(q("[data-testid=preview-ready-follow]")).toBeNull();
    await act(async () => applyFollowPresenceEvent(PREVIEW_ID, "pres-kim", { presentationId: "pres-kim", presenter: kim, state: "live", followers: 1 }));
    await act(async () => publishFollowRole(PREVIEW_ID, "following"));
    expect(q("[data-testid=preview-ready-follow]")).toBeNull();
  });

  it("offers nothing to follow on a site that stopped", async () => {
    mocks.getSitePreview.mockResolvedValue(record({ status: "revoked", health: null }));
    await render();
    await act(async () => applyFollowPresenceEvent(PREVIEW_ID, "pres-kim", { presentationId: "pres-kim", presenter: kim, state: "live", followers: 0 }));
    expect(q("[data-testid=preview-ready-status]")!.dataset.state).toBe("stopped");
    expect(q("[data-testid=preview-ready-follow-line]")).toBeNull();
    expect(q("[data-testid=preview-ready-follow]")).toBeNull();
  });
});
