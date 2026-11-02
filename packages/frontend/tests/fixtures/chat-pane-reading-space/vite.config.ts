import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

export default createStyleReviewConfig({
  name: "chat-pane-reading-space", port: 5372,
  optimize: ["react-resizable-panels"],
  stubs: {
    ...RUN_STOP_FIXTURE_STUBS,
    "/src/conversations/ConversationsProvider.tsx": "export const useConversations = () => ({ conversations: [], activeConversation: null });",
    "/src/projects/useProject.ts": 'export const useProject = () => ({ activeProjectId: "review-project" });',
    "/src/runtime/useRuntimeMenu.ts": "export const useRuntimeMenuOptions = () => ({runtime: {effectiveRuntimeId: null, preferredRuntimeId: null}});",
    "/src/runtime/useRuntime.tsx": "export const useRuntime = () => ({runs: []});",
    "/src/conversations/useConversation.tsx": "export const useConversation = () => ({activeConversationId: 'review-conversation', agentHandles: []});",
  },
});
