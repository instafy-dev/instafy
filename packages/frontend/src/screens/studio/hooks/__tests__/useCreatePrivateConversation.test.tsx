/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../../../../conversations/conversationState";

const createBlank = vi.hoisted(() => vi.fn());
const addParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { conversations: { createBlank, addParticipant } } }));
import { useCreatePrivateConversation } from "../useCreatePrivateConversation";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const TARGET_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONTROLLER_ID = "99999999-8888-4777-8666-555555555555";
const target = { userId: TARGET_ID, displayName: "Teammate" };
const createConversation = vi.fn((options) => options as ConversationState);
const onCreated = vi.fn();
const showStatus = vi.fn();
let start: ReturnType<typeof useCreatePrivateConversation>;
function Harness({ userId = "user-A", projectId = PROJECT_ID }: { userId?: string; projectId?: string }) {
  start = useCreatePrivateConversation({ projectId, userId, accessToken: `token-${userId}`, createConversation, onCreated, showStatus });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("private chat creation readiness", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the new composer unavailable during delayed atomic creation and gates repeated clicks", async () => {
    const request = deferred<{ conversationId: string; initialParticipantUserIds?: string[] }>();
    createBlank.mockReturnValue(request.promise);
    const first = start(target);
    await start(target);
    expect(createBlank).toHaveBeenCalledTimes(1);
    expect(createBlank).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID, accessToken: "token-user-A",
      initialParticipantUserIds: [TARGET_ID], metadata: expect.objectContaining({ visibility: "private" }),
    }));
    // With no newly selected local conversation, send cannot create a fallback chat.
    expect(createConversation).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    request.resolve({ conversationId: CONTROLLER_ID, initialParticipantUserIds: [TARGET_ID] });
    await first;
    expect(createConversation).toHaveBeenCalledWith(expect.objectContaining({ controllerId: CONTROLLER_ID, visibility: "private", select: true }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ controllerId: CONTROLLER_ID }));
    expect(addParticipant).not.toHaveBeenCalled();
  });

  it("preserves the existing chat on failure and allows an explicit retry", async () => {
    createBlank.mockResolvedValueOnce(null).mockResolvedValueOnce({ conversationId: CONTROLLER_ID, initialParticipantUserIds: [TARGET_ID] });
    await start(target);
    expect(createConversation).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Can't start private chat"), "error", 4500);
    await start(target);
    expect(createBlank).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it.each(["account", "project"])("does not open a delayed result after a %s switch", async (change) => {
    const request = deferred<{ conversationId: string; initialParticipantUserIds?: string[] }>();
    createBlank.mockReturnValue(request.promise);
    const first = start(target);
    await act(async () => root.render(change === "account" ? <Harness userId="user-B" /> : <Harness projectId={TARGET_ID} />));
    request.resolve({ conversationId: CONTROLLER_ID, initialParticipantUserIds: [TARGET_ID] });
    await first;
    expect(createConversation).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ["bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"]])("fails closed when a server does not prove the requested participant was created: %j", async (initialParticipantUserIds) => {
    createBlank.mockResolvedValue({ conversationId: CONTROLLER_ID, initialParticipantUserIds });
    await start(target);
    expect(createConversation).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining("did not confirm"), "error", 4500);
  });

  it("does not open a delayed result after leaving Studio", async () => {
    const request = deferred<{ conversationId: string; initialParticipantUserIds?: string[] }>();
    createBlank.mockReturnValue(request.promise);
    const first = start(target);
    await act(async () => root.render(null));
    request.resolve({ conversationId: CONTROLLER_ID, initialParticipantUserIds: [TARGET_ID] });
    await first;
    expect(createConversation).not.toHaveBeenCalled();
  });
});
