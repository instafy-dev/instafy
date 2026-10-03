import { describe, expect, it } from "vitest";
import { collectInternalConversationIds } from "../internalConversations";

describe("cached internal conversation ancestry", () => {
  it("terminates a cycle connected to an authoritative internal root and recognizes local parent aliases", () => {
    const internal = collectInternalConversationIds([
      { localId: "root-local", controllerId: "root", parentConversationId: "grandchild" },
      { localId: "child-local", controllerId: "child", parentConversationId: "root" },
      { localId: "grandchild-local", controllerId: "grandchild", parentConversationId: "child-local" },
      { localId: "ordinary", controllerId: "ordinary-controller", parentConversationId: null },
    ], ["root"]);
    expect([...internal].sort()).toEqual([
      "root", "root-local", "child", "child-local", "grandchild", "grandchild-local",
    ].sort());
  });
});
