import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSpaceRecommendations, prepareSpaceRecommendationConversation, prepareSpaceReviewConversation, setSpaceRecommendationOutcome, SpaceRecommendationOutcomeConflictError, type SpaceRecommendation } from "../spaceRecommendations";

const { resolveContext, readError } = vi.hoisted(() => ({ resolveContext: vi.fn(), readError: vi.fn() }));
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
  readControllerError: readError,
}));

function recommendation(overrides: Partial<SpaceRecommendation> = {}): SpaceRecommendation {
  return { id: "rec-1", projectId: "space-1", key: "weekly-review", title: "Prepare a weekly summary",
    reason: "Two chats repeat the same reporting task.", prompt: "Help me prepare a weekly summary.",
    evidence: [{ conversationId: "chat-1", messageId: "message-1" }], status: "proposed",
    acceptedConversationId: null, createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", ...overrides };
}

describe("space recommendation requests", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue({ baseUrl: "https://controller.test", accessToken: "test-token" });
    readError.mockResolvedValue("private response detail");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ recommendations: [recommendation()] }))));
  });
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

  it("loads through the authenticated controller binding and retains evidence", async () => {
    expect(await listSpaceRecommendations("space-1")).toEqual([recommendation()]);
    expect(fetch).toHaveBeenCalledWith("https://controller.test/projects/space-1/recommendations", expect.objectContaining({
      method: "GET", headers: { authorization: "Bearer test-token", accept: "application/json" }, signal: expect.any(AbortSignal),
    }));
  });

  it("saves only the explicit outcome and validates the returned scope and outcome", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(recommendation({ status: "accepted" }))));
    await expect(setSpaceRecommendationOutcome("space-1", "rec-1", { status: "accepted" })).resolves.toMatchObject({ status: "accepted" });
    expect(fetch).toHaveBeenLastCalledWith("https://controller.test/projects/space-1/recommendations/rec-1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ status: "accepted" }),
    }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(recommendation({ projectId: "other-space", status: "dismissed" }))));
    await expect(setSpaceRecommendationOutcome("space-1", "rec-1", { status: "dismissed" })).rejects.toThrow("Unable to confirm");
  });

  it("asks the controller to create or reuse the private review chat", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ conversationId: "review-chat-1" })));
    await expect(prepareSpaceReviewConversation("space-1")).resolves.toEqual({ conversationId: "review-chat-1" });
    expect(fetch).toHaveBeenLastCalledWith("https://controller.test/projects/space-1/recommendations/review-conversation", expect.objectContaining({ method: "POST" }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 409 }));
    await expect(prepareSpaceReviewConversation("space-1")).rejects.toThrow("sharing has changed");
  });

  it("returns the original accepted destination when another tab won acceptance", async () => {
    const original = recommendation({ status: "accepted", acceptedConversationId: "original-chat" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(original)));
    await expect(setSpaceRecommendationOutcome("space-1", "rec-1", {
      status: "accepted", acceptedConversationId: "extra-draft",
    })).resolves.toEqual(original);
  });

  it("prepares a controller-owned suggestion chat that can be reused across reloads", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ conversationId: "saved-private-draft" })));
    await expect(prepareSpaceRecommendationConversation("space/1", "rec/1")).resolves.toEqual({ conversationId: "saved-private-draft" });
    await expect(prepareSpaceRecommendationConversation("space/1", "rec/1")).resolves.toEqual({ conversationId: "saved-private-draft" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://controller.test/projects/space%2F1/recommendations/rec%2F1/prepare-conversation", expect.objectContaining({
      method: "POST", headers: { authorization: "Bearer test-token", accept: "application/json" }, signal: expect.any(AbortSignal),
    }));
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
  });

  it("classifies a decided suggestion during preparation as an outcome conflict", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 409 }));
    await expect(prepareSpaceRecommendationConversation("space-1", "rec-1")).rejects.toBeInstanceOf(SpaceRecommendationOutcomeConflictError);
    expect(readError).toHaveBeenCalledOnce();
  });

  it("rejects missing suggestion IDs and malformed preparation responses", async () => {
    await expect(prepareSpaceRecommendationConversation("space-1", " ")).rejects.toThrow("suggestion is unavailable");
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ conversationId: "" })));
    await expect(prepareSpaceRecommendationConversation("space-1", "rec-1")).rejects.toThrow("Unable to open");
  });

  it.each([
    recommendation({ projectId: "other-space" }),
    recommendation({ evidence: [] }),
    recommendation({ evidence: [{ conversationId: "" }] }),
  ])("rejects malformed or cross-space records", async (row) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ recommendations: [row] })));
    await expect(listSpaceRecommendations("space-1")).rejects.toThrow("Unable to read space suggestions");
  });

  it("reports conflicts and permissions without exposing server response detail", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("private detail", { status: 409 }));
    await expect(setSpaceRecommendationOutcome("space-1", "rec-1", { status: "accepted" })).rejects.toBeInstanceOf(SpaceRecommendationOutcomeConflictError);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("private detail", { status: 403 }));
    await expect(listSpaceRecommendations("space-1")).rejects.toThrow("no longer have permission");
    expect(readError).toHaveBeenCalledTimes(2);
  });

  it("does not request an old space after cancellation during session resolution", async () => {
    let resolve!: (value: { baseUrl: string; accessToken: string }) => void;
    resolveContext.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const pending = listSpaceRecommendations("space-1", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    resolve({ baseUrl: "https://controller.test", accessToken: "test-token" });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
});
