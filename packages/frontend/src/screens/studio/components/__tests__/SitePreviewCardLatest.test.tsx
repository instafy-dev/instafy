// @vitest-environment jsdom
// Octo posts a "Ready to preview" card each time a run opens a site, so a conversation can hold several for one site.
// Only the latest posted card is drawn in full; an earlier one is a line that points to it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerSitePreview } from "../../../../services/runtimeController/previews";
import { ConversationPreviewContext, type ConversationPreviewOpener } from "../../../../workspace/ConversationPreviewContext";
import { SitePreviewCard } from "../SitePreviewCard";

const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
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

function record(previewId: string): ControllerSitePreview {
  return {
    previewId, title: "Hello", port: 4173, path: "/", runtimeId: "runtime-1", status: "active",
    health: { listening: true, status: 200 }, messageId: null, createdAt: null, visibility: "private",
  };
}

type Card = { previewId: string; messageKey: string; postedAt: number };

describe("SitePreviewCard: one card per site", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: ConversationPreviewOpener;
  async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
  async function render(cards: Card[]) {
    await act(async () => root.render(
      <ConversationPreviewContext.Provider value={opener}>
        {cards.map((card, index) => (
          <div key={`${card.messageKey}-${index}`} data-card={card.messageKey}>
            <SitePreviewCard preview={{ previewId: card.previewId, title: "Hello", port: 4173 }} projectId="project-1" postedAt={card.postedAt} messageKey={card.messageKey} />
          </div>
        ))}
      </ConversationPreviewContext.Provider>,
    ));
    await flush();
  }
  const full = (key: string) => container.querySelector(`[data-card="${key}"] [data-testid=preview-ready-card]`);
  const earlier = (key: string) => container.querySelector(`[data-card="${key}"] [data-testid=preview-ready-earlier]`);

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    mocks.getSitePreview.mockReset().mockImplementation(async (_project: string, previewId: string) => record(previewId));
    mocks.getFollowState.mockReset().mockResolvedValue({ presence: null, followers: [] });
    opener = { openPreview: vi.fn(), visiblePreviewId: null };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("draws only the latest card for a site in full, by when it was posted, not by when it appeared", async () => {
    // The later card first: history loaded upwards mounts the earlier card last.
    await render([
      { previewId: SITE, messageKey: "card-2", postedAt: 2_000 },
      { previewId: SITE, messageKey: "card-1", postedAt: 1_000 },
    ]);
    expect(full("card-2")).not.toBeNull();
    expect(full("card-1")).toBeNull();
    expect(earlier("card-1")!.textContent).toBe("Hello · opened again further down");
    expect(container.querySelectorAll("[data-testid=preview-ready-card]")).toHaveLength(1);
  });

  it("draws the earlier card in full again when the latest one is gone", async () => {
    await render([
      { previewId: SITE, messageKey: "card-1", postedAt: 1_000 },
      { previewId: SITE, messageKey: "card-2", postedAt: 2_000 },
    ]);
    expect(full("card-1")).toBeNull();
    await render([{ previewId: SITE, messageKey: "card-1", postedAt: 1_000 }]);
    expect(full("card-1")).not.toBeNull();
    expect(earlier("card-1")).toBeNull();
  });

  it("keeps a card for each other site, and a message drawn twice (chat and run thread) is one card", async () => {
    await render([
      { previewId: SITE, messageKey: "card-1", postedAt: 1_000 },
      { previewId: OTHER, messageKey: "card-9", postedAt: 500 },
      { previewId: SITE, messageKey: "card-1", postedAt: 1_000 },
    ]);
    expect(container.querySelectorAll("[data-testid=preview-ready-card]")).toHaveLength(3);
    expect(container.querySelector("[data-testid=preview-ready-earlier]")).toBeNull();
  });
});
