// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceRecommendations } from "../SpaceRecommendations";
import { listSpaceRecommendations, setSpaceRecommendationOutcome, SpaceRecommendationOutcomeConflictError, type SpaceRecommendation } from "../../../../services/runtimeController/spaceRecommendations";

vi.mock("../../../../services/runtimeController/spaceRecommendations", () => ({
  listSpaceRecommendations: vi.fn(), setSpaceRecommendationOutcome: vi.fn(),
  SpaceRecommendationOutcomeConflictError: class extends Error {},
}));
type Props = ComponentProps<typeof SpaceRecommendations>;
function recommendation(overrides: Partial<SpaceRecommendation> = {}): SpaceRecommendation {
  return { id: "rec-1", projectId: "space-1", key: "weekly-review", title: "Prepare a weekly summary",
    reason: "Two chats repeat the same reporting task.", prompt: "Help me prepare a weekly summary.",
    evidence: [{ conversationId: "chat-1", messageId: "message-1" }], status: "proposed",
    acceptedConversationId: null, createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SpaceRecommendations", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: Props;
  const render = async (overrides: Partial<Props> = {}) => {
    props = { ...props, ...overrides };
    await act(async () => root.render(<SpaceRecommendations {...props} />));
  };
  const button = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  const click = async (id: string) => { await act(async () => button(id).click()); };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    props = { projectId: "space-1", canWrite: true, onReview: vi.fn().mockResolvedValue(true),
      onUseRecommendation: vi.fn().mockResolvedValue(true), onOpenEvidence: vi.fn(), onHandoffComplete: vi.fn() };
    vi.mocked(listSpaceRecommendations).mockResolvedValue([recommendation()]);
    vi.mocked(setSpaceRecommendationOutcome).mockImplementation(async (_projectId, _id, outcome) => recommendation(outcome));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.resetAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows at most three pending suggestions with evidence and no handled suggestions", async () => {
    vi.mocked(listSpaceRecommendations).mockResolvedValue([
      recommendation({ id: "accepted", title: "Already chosen", status: "accepted" }),
      ...[1, 2, 3, 4].map((id) => recommendation({ id: `rec-${id}` })),
    ]);
    await render();
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.textContent).not.toContain("Already chosen");
    expect(button("space-recommendation-use-rec-1").textContent).toBe("Add to new chat");
    await act(async () => Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Source chat")!.click());
    expect(props.onOpenEvidence).toHaveBeenCalledWith({ conversationId: "chat-1", messageId: "message-1" });
  });

  it("waits for successful draft handoff and outcome persistence before navigating", async () => {
    const handoff = deferred<boolean>();
    const saved = deferred<SpaceRecommendation>();
    props.onUseRecommendation = vi.fn(() => handoff.promise);
    vi.mocked(setSpaceRecommendationOutcome).mockReturnValueOnce(saved.promise);
    await render(); await click("space-recommendation-use-rec-1");
    expect(setSpaceRecommendationOutcome).not.toHaveBeenCalled();
    await act(async () => handoff.resolve(true));
    expect(setSpaceRecommendationOutcome).toHaveBeenCalledWith("space-1", "rec-1", { status: "accepted" });
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    await act(async () => saved.resolve(recommendation({ status: "accepted" })));
    expect(props.onHandoffComplete).toHaveBeenCalledOnce();
    expect(container.querySelector("li")).toBeNull();
  });

  it("keeps a suggestion proposed when the draft handoff fails", async () => {
    props.onUseRecommendation = vi.fn().mockResolvedValue(false);
    await render(); await click("space-recommendation-use-rec-1");
    expect(setSpaceRecommendationOutcome).not.toHaveBeenCalled();
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not added");
    expect(container.querySelector("li")).not.toBeNull();
  });

  it("retries a failed outcome save without staging a duplicate draft", async () => {
    props.onUseRecommendation = vi.fn().mockResolvedValue({ acceptedConversationId: "private-draft-1" });
    vi.mocked(setSpaceRecommendationOutcome).mockRejectedValueOnce(new Error("offline"));
    await render(); await click("space-recommendation-use-rec-1");
    expect(button("space-recommendation-use-rec-1").textContent).toBe("Save choice");
    expect(button("space-recommendation-dismiss-rec-1").disabled).toBe(true);
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    await click("space-recommendation-use-rec-1");
    expect(props.onUseRecommendation).toHaveBeenCalledOnce();
    expect(setSpaceRecommendationOutcome).toHaveBeenCalledTimes(2);
    expect(setSpaceRecommendationOutcome).toHaveBeenLastCalledWith("space-1", "rec-1", {
      status: "accepted", acceptedConversationId: "private-draft-1",
    });
    expect(props.onHandoffComplete).toHaveBeenCalledOnce();
  });

  it("persists dismissal, keeping the row available when saving fails", async () => {
    vi.mocked(setSpaceRecommendationOutcome).mockRejectedValueOnce(new Error("Unable to save your choice. Try again."));
    await render(); await click("space-recommendation-dismiss-rec-1");
    expect(container.querySelector("li")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to save");
    await click("space-recommendation-dismiss-rec-1");
    expect(setSpaceRecommendationOutcome).toHaveBeenLastCalledWith("space-1", "rec-1", { status: "dismissed" });
    expect(props.onUseRecommendation).not.toHaveBeenCalled();
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    expect(container.querySelector("li")).toBeNull();
  });

  it("opens the server's chosen chat only on request when another tab accepted first", async () => {
    props.onUseRecommendation = vi.fn().mockResolvedValue({ acceptedConversationId: "extra-draft" });
    vi.mocked(setSpaceRecommendationOutcome).mockResolvedValueOnce(recommendation({
      status: "accepted", acceptedConversationId: "original-chat",
    }));
    await render(); await click("space-recommendation-use-rec-1");
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    expect(container.querySelector("li")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("already added to another chat");
    expect(container.textContent).toContain("extra draft remains unsent");
    await click("space-recommendation-open-chosen");
    expect(props.onOpenEvidence).toHaveBeenCalledWith({ conversationId: "original-chat" });
  });

  it("reconciles a successful acceptance after a lost response without retrying or opening another draft", async () => {
    props.onUseRecommendation = vi.fn().mockResolvedValue({ acceptedConversationId: "prepared-draft" });
    vi.mocked(setSpaceRecommendationOutcome).mockRejectedValueOnce(new Error("Response lost"));
    await render(); await click("space-recommendation-use-rec-1");
    expect(button("space-recommendation-use-rec-1").textContent).toBe("Save choice");
    vi.mocked(listSpaceRecommendations).mockResolvedValueOnce([recommendation({
      status: "accepted", acceptedConversationId: "prepared-draft",
    })]);
    await click("space-review-reload");
    expect(container.querySelector("li")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Your choice was saved");
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    expect(props.onUseRecommendation).toHaveBeenCalledOnce();
    expect(setSpaceRecommendationOutcome).toHaveBeenCalledOnce();
    await click("space-recommendation-open-chosen");
    expect(props.onOpenEvidence).toHaveBeenCalledWith({ conversationId: "prepared-draft" });
  });

  it("reloads a conflicting terminal dismissal once instead of offering an endless save retry", async () => {
    props.onUseRecommendation = vi.fn().mockResolvedValue({ acceptedConversationId: "extra-draft" });
    vi.mocked(setSpaceRecommendationOutcome).mockRejectedValueOnce(new SpaceRecommendationOutcomeConflictError());
    vi.mocked(listSpaceRecommendations).mockResolvedValueOnce([recommendation()])
      .mockResolvedValueOnce([recommendation({ status: "dismissed" })]);
    await render(); await click("space-recommendation-use-rec-1");
    expect(listSpaceRecommendations).toHaveBeenCalledTimes(2);
    expect(setSpaceRecommendationOutcome).toHaveBeenCalledOnce();
    expect(container.querySelector("li")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("already dismissed");
    expect(container.textContent).not.toContain("Save choice");
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="space-recommendation-open-chosen"]')).toBeNull();
  });

  it("prepares a review draft without marking any recommendation accepted", async () => {
    await render(); await click("space-review-start");
    expect(props.onReview).toHaveBeenCalledOnce();
    expect(props.onHandoffComplete).toHaveBeenCalledOnce();
    expect(setSpaceRecommendationOutcome).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Send it to start the review");
  });

  it("keeps an actionable review preparation failure visible without navigating", async () => {
    props.onReview = vi.fn().mockRejectedValue(new Error("The review chat’s sharing has changed."));
    await render(); await click("space-review-start");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The review chat’s sharing has changed.");
    expect(props.onHandoffComplete).not.toHaveBeenCalled();
    expect(setSpaceRecommendationOutcome).not.toHaveBeenCalled();
  });

  it("makes read failures retryable without pretending the space has no suggestions", async () => {
    vi.mocked(listSpaceRecommendations).mockRejectedValueOnce(new Error("Unable to load suggestions. Try again."));
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="space-recommendations-empty"]')).toBeNull();
    await click("space-review-reload");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("li")).not.toBeNull();
  });

  it("cancels old-space loads and never shows their late results in a new space", async () => {
    const old = deferred<SpaceRecommendation[]>();
    vi.mocked(listSpaceRecommendations).mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    await render();
    const oldSignal = vi.mocked(listSpaceRecommendations).mock.calls[0][1];
    await render({ projectId: "space-2" });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => old.resolve([recommendation()]));
    expect(container.textContent).not.toContain("Prepare a weekly summary");
    expect(container.querySelector('[data-testid="space-recommendations-empty"]')).not.toBeNull();
  });

  it("does not revive a saved dismissal when an earlier refresh finishes late", async () => {
    const saved = deferred<SpaceRecommendation>();
    const refresh = deferred<SpaceRecommendation[]>();
    vi.mocked(setSpaceRecommendationOutcome).mockReturnValueOnce(saved.promise);
    await render(); await click("space-recommendation-dismiss-rec-1");
    vi.mocked(listSpaceRecommendations).mockReturnValueOnce(refresh.promise);
    await render({ refreshKey: "run-completed" });
    await act(async () => saved.resolve(recommendation({ status: "dismissed" })));
    await act(async () => refresh.resolve([recommendation()]));
    expect(container.querySelector("li")).toBeNull();
  });

  it("refreshes on completion and prevents viewer mutation controls", async () => {
    await render({ canWrite: false });
    expect(container.querySelector('[data-testid="space-review-start"]')).toBeNull();
    expect(container.querySelector('[data-testid="space-recommendation-use-rec-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="space-recommendation-dismiss-rec-1"]')).toBeNull();
    await render({ refreshKey: "review-completed" });
    expect(listSpaceRecommendations).toHaveBeenCalledTimes(2);
  });
});
