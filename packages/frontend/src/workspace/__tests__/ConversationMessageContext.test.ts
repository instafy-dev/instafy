import { describe, expect, it, vi } from "vitest";
import { buildStudioDestinationSearch } from "../../navigation/studioNavigation";
import { openConversationMessageReference } from "../ConversationMessageContext";

const reference = { projectId: "space-a", conversationControllerId: "controller-a", messageId: "source-message" };
const scope = {
  activeProjectId: "space-a",
  conversationsProjectKey: "space-a",
  resolveConversationLocalId: (id: string) => id === "controller-a" ? "local-a" : null,
};

describe("conversation message reference navigation", () => {
  it("opens the exact message as a new history visit through the shared route builder", () => {
    const navigate = vi.fn();
    expect(openConversationMessageReference(reference, scope, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith({
      kind: "conversation", projectId: "space-a", conversationId: "local-a",
      conversationControllerId: "controller-a", messageId: "source-message",
    }, { forceNewVisit: true });
    const destination = navigate.mock.calls[0][0];
    const params = new URLSearchParams(buildStudioDestinationSearch(
      "?projectId=space-a&conversationId=other&messageId=old&jobId=job&chatView=browser&panel=code",
      destination,
    ));
    expect(params.get("messageId")).toBe("source-message");
    expect(params.get("conversationId")).toBe("local-a");
    for (const key of ["jobId", "chatView", "panel"]) expect(params.has(key)).toBe(false);
  });

  it.each([
    { ...scope, activeProjectId: null },
    { ...scope, activeProjectId: "space-b" },
    { ...scope, conversationsProjectKey: "space-b" },
    { ...scope, resolveConversationLocalId: () => null },
  ])("refuses a stale or unavailable conversation scope", (currentScope) => {
    const navigate = vi.fn();
    expect(openConversationMessageReference(reference, currentScope, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    { ...reference, projectId: null },
    { ...reference, projectId: "space-b" },
    { ...reference, conversationControllerId: "missing" },
    { ...reference, messageId: " " },
  ])("does not turn an invalid message reference into a latest-chat visit", (target) => {
    const navigate = vi.fn();
    expect(openConversationMessageReference(target, scope, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
