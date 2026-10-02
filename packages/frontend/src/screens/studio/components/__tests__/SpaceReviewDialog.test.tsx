// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import type { SpaceRecommendationsProps } from "../SpaceRecommendations";
import { SPACE_REVIEW_PROMPT, SpaceReviewDialog } from "../SpaceReviewDialog";

const mocks = vi.hoisted(() => ({
  conversations: [] as unknown[], create: vi.fn(), draft: vi.fn(), prepare: vi.fn(), blank: vi.fn(),
  open: vi.fn(), push: vi.fn(), navigate: vi.fn(), status: vi.fn(), close: vi.fn(), lifecycle: vi.fn(),
}));
let panel: SpaceRecommendationsProps;
vi.mock("../SpaceRecommendations", () => ({ SpaceRecommendations: (props: SpaceRecommendationsProps) => {
  panel = props; return <div>Recommendations</div>;
} }));
vi.mock("../../../../components/aria/StudioModal", () => ({ StudioDialogModal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../../../components/aria/StudioDialogLayout", () => ({ StudioDialogHeader: () => null }));
vi.mock("../../../../conversations/ConversationsProvider", () => ({ useConversations: () => ({
  conversations: mocks.conversations, createConversation: mocks.create, setConversationDraft: mocks.draft,
  setConversationLifecycleStatus: mocks.lifecycle,
}) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => ({ openConversationTab: mocks.open, requestUrlPush: mocks.push }) }));
vi.mock("../../../../navigation/useStudioNavigation", () => ({ useStudioNavigation: () => mocks.navigate }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.status }) }));
vi.mock("../../../../services/runtimeController/spaceRecommendations", () => ({
  prepareSpaceReviewConversation: mocks.prepare, prepareSpaceRecommendationConversation: mocks.blank,
}));

describe("SpaceReviewDialog handoff", () => {
  let container: HTMLDivElement;
  let root: Root;
  let unmounted: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversations = [];
    mocks.prepare.mockResolvedValue({ conversationId: "review-id" });
    mocks.blank.mockResolvedValue({ conversationId: "action-id" });
    mocks.create.mockImplementation((options) => ({ ...options, draft: "" } as ConversationState));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container); unmounted = false;
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(canWrite = true) {
    await act(async () => root.render(<SpaceReviewDialog projectId="project-id" canWrite={canWrite} onClose={mocks.close} />));
  }

  it("stages the persistent review as a private draft, then opens it only on handoff", async () => {
    await render();
    expect(await panel.onReview()).toBe(true);
    expect(mocks.prepare).toHaveBeenCalledWith("project-id");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ controllerId: "review-id", visibility: "private", select: false }));
    expect(mocks.draft).toHaveBeenCalledWith("review-id", SPACE_REVIEW_PROMPT);
    expect(mocks.open).not.toHaveBeenCalled();
    panel.onHandoffComplete?.();
    expect(mocks.open).toHaveBeenCalledWith("review-id", expect.objectContaining({
      fallbackConversation: expect.objectContaining({ draft: SPACE_REVIEW_PROMPT }),
    }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("reuses the review chat without replacing an unrelated unsent draft", async () => {
    mocks.conversations = [{ localId: "existing", controllerId: "review-id", draft: "My unfinished question" }];
    await render();
    await expect(panel.onReview()).rejects.toThrow("unsent draft");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("restores an archived review chat when the user prepares another review", async () => {
    mocks.conversations = [{ localId: "archived-review", controllerId: "review-id", draft: "", lifecycleStatus: "archived" }];
    await render();
    expect(await panel.onReview()).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.lifecycle).toHaveBeenCalledWith("archived-review", "active");
    panel.onHandoffComplete?.();
    expect(mocks.open).toHaveBeenCalledWith("archived-review", expect.objectContaining({
      fallbackConversation: expect.objectContaining({ lifecycleStatus: "active", draft: SPACE_REVIEW_PROMPT }),
    }));
  });

  it("prepares private follow-up with durable identity and source references without touching the current draft", async () => {
    mocks.conversations = [{ localId: "current", controllerId: "current-id", draft: "Keep this" }];
    await render();
    const recommendation = {
      id: "recommendation-id", projectId: "project-id", key: "verify", title: "Verify the flow",
      reason: "Verification is still open", prompt: "Check the mobile flow", evidence: [{ conversationId: "source-id", messageId: "message-id" }],
      status: "proposed" as const, acceptedConversationId: null, createdAt: "2026-10-02", updatedAt: "2026-10-02",
    };
    expect(await panel.onUseRecommendation(recommendation)).toEqual({ acceptedConversationId: "action-id" });
    expect(mocks.blank).toHaveBeenCalledWith("project-id", "recommendation-id");
    const localId = "action-id";
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ localId, controllerId: "action-id" }));
    expect(mocks.draft).toHaveBeenCalledWith(localId, expect.stringContaining("[[message:source-id/message-id|Source message]]"));
    expect(mocks.draft).not.toHaveBeenCalledWith("current", expect.anything());
    expect(mocks.open).not.toHaveBeenCalled();
    await panel.onUseRecommendation(recommendation);
    expect(mocks.blank).toHaveBeenCalledOnce();
    panel.onHandoffComplete?.();
    expect(mocks.open).toHaveBeenCalledWith(localId, expect.objectContaining({
      fallbackConversation: expect.objectContaining({ draft: expect.stringContaining("Check the mobile flow") }),
    }));

    // No outcome was saved by this dialog fixture. Reopening must recover the
    // controller's same prepared chat, including edits made in the meantime.
    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.conversations = [{ localId, controllerId: "action-id", draft: "My edited follow-up", lifecycleStatus: "active" }];
    mocks.create.mockClear();
    mocks.draft.mockClear();
    await render();
    expect(await panel.onUseRecommendation(recommendation)).toEqual({ acceptedConversationId: "action-id" });
    expect(mocks.blank).toHaveBeenCalledTimes(2);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
    panel.onHandoffComplete?.();
    expect(mocks.open).toHaveBeenLastCalledWith(localId, expect.objectContaining({
      fallbackConversation: expect.objectContaining({ draft: "My edited follow-up" }),
    }));
  });

  it("does not stage work after leaving the dialog", async () => {
    let resolve!: (value: { conversationId: string }) => void;
    mocks.prepare.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    const pending = panel.onReview();
    await act(async () => root.unmount()); unmounted = true;
    resolve({ conversationId: "late" });
    expect(await pending).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it("does not prepare work for read-only members", async () => {
    await render(false);
    expect(await panel.onReview()).toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("opens exact evidence through normal Studio navigation", async () => {
    await render();
    panel.onOpenEvidence({ conversationId: "source-id", messageId: "message-id" });
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: "conversation", projectId: "project-id", conversationControllerId: "source-id", messageId: "message-id" });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
