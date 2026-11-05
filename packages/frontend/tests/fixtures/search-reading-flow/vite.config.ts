import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

const config = createStyleReviewConfig({
  name: "search-reading-flow", port: 5400, optimize: ["react-resizable-panels"],
  stubs: {
    ...RUN_STOP_FIXTURE_STUBS,
    "/src/lib/supabaseClient.ts": `
      import { downloadFixtureAttachment } from "/tests/fixtures/search-reading-flow/scenario.ts";
      export const hasSupabaseConfig = true;
      export const supabase = { auth: { onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } }, storage: { from(bucket) {
        if (bucket !== "chat-attachments") throw new Error("Unexpected fixture storage bucket");
        return { download: downloadFixtureAttachment };
      } } };
    `,
    "/src/conversations/ConversationsProvider.tsx": "export const useConversations = () => ({ conversations: [], activeConversation: null });",
    "/src/projects/useProject.ts": 'export const useProject = () => ({ activeProjectId: "review-project" });',
    "/src/runtime/useRuntimeMenu.ts": "export const useRuntimeMenuOptions = () => ({runtime: {effectiveRuntimeId: null, preferredRuntimeId: null}});",
    "/src/runtime/useRuntime.tsx": "export const useRuntime = () => ({runs: []});",
    "/src/conversations/useConversation.tsx": "export const useConversation = () => ({activeConversationId: 'review-conversation', agentHandles: []});",
  },
});

export default { ...config, define: { ...config.define,
  __SEARCH_READING_BASELINE__: JSON.stringify(Boolean(process.env.INSTAFY_REVIEW_BASELINE_SRC)),
} };
