// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: "user-a", projectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
const updateMetadata = vi.hoisted(() => vi.fn());
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: session.userId } }) }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: session.projectId }) }));
vi.mock("../../runtime/useRuntime", () => ({ useRuntime: () => ({ runtime: {}, runs: [] }) }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { core: { enabled: true }, conversations: { updateMetadata } } }));
vi.mock("../useConversationProviderEffects", async () => ({
  useConversationControllerSync: () => ({ remoteConversationHistoryResolved: true }),
  useConversationRunEffects: vi.fn(), usePendingConversationEffects: vi.fn(),
  useConversationMetadataPersistence: (await import("../useConversationMetadataPersistence")).useConversationMetadataPersistence,
}));
import { ConversationsProvider, useConversations } from "../ConversationsProvider";
import { createConversationGoal } from "../conversationGoals";

let current: ReturnType<typeof useConversations>;
let root: Root;
let container: HTMLDivElement;
function Consumer() { current = useConversations(); return null; }
async function render() {
  await act(async () => root.render(<StrictMode><ConversationsProvider><Consumer /></ConversationsProvider></StrictMode>));
}
async function draft(value: string) {
  await act(async () => current.setConversationDraft(current.activeConversationId!, value));
}
beforeEach(() => {
  updateMetadata.mockReset().mockResolvedValue(true);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  session.userId = "user-a"; session.projectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  window.history.replaceState(null, "", `/?projectId=${session.projectId}&conversationId=draft-chat`);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); sessionStorage.clear();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("restores the mounted composer after reload and clears persisted text after sending", async () => {
  await render(); await draft("Keep this message");
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(current.activeConversation?.draft).toBe("Keep this message");
  await draft("");
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(current.activeConversation?.draft).toBe("");
});

it("isolates drafts through space changes and an A to B to A account switch", async () => {
  await render(); await draft("Space A, account A");
  session.projectId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"; await render();
  expect(current.conversations.every(c => !c.draft)).toBe(true);
  await draft("Space B, account A");
  session.userId = "user-b"; await render();
  expect(current.conversations.every(c => !c.draft)).toBe(true);
  await draft("Space B, account B");
  session.userId = "user-a"; await render();
  expect(current.conversations.map(c => c.draft)).toContain("Space B, account A");
  session.projectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; await render();
  expect(current.conversations.map(c => c.draft)).toContain("Space A, account A");
  expect(current.conversations.map(c => c.draft)).not.toContain("Space B, account B");
});

it("projects a local goal edit without racing the command's awaited controller write", async () => {
  await render();
  const id = current.activeConversationId!;
  await act(async () => current.setConversationControllerId(id, "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
  const goal = createConversationGoal("Verify the change", session.userId);
  await act(async () => current.setConversationGoal(id, goal));
  expect(current.activeConversation?.activeGoal).toEqual(goal);
  expect(updateMetadata).not.toHaveBeenCalled();
});
