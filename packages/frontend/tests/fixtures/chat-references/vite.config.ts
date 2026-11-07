import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

export default createStyleReviewConfig({ name: "chat-references", port: 5420, stubs: {
  // The old source has no message-route context; this fixture-only inert provider
  // keeps the same fixture renderable without changing the baseline's behavior.
  ...(process.env.INSTAFY_REVIEW_BASELINE_SRC ? {
    "/src/workspace/ConversationMessageContext.ts": `
      import { createContext } from "react";
      export const ConversationMessageContext = createContext(null);
      export const openConversationMessageReference = () => false;
    `,
  } : {}),
  "/src/features/applicationFrontendFeatureComposition.ts": RUN_STOP_FIXTURE_STUBS["/src/features/applicationFrontendFeatureComposition.ts"],
  "/src/assistants/localBuiltInAssistantCatalog.ts": RUN_STOP_FIXTURE_STUBS["/src/assistants/localBuiltInAssistantCatalog.ts"],
  "/src/lib/supabaseClient.ts": RUN_STOP_FIXTURE_STUBS["/src/lib/supabaseClient.ts"],
  "/src/workspace/WorkspaceTabsProvider.tsx": `
    const action = detail => window.dispatchEvent(new CustomEvent("reference-review:action", { detail }));
    export const useWorkspaceTabs = () => ({ openConversationTab(id) { action("Opened conversation: " + id); }, openPanelTab(id) { action("Opened panel: " + id); }, requestUrlPush() {} });
  `,
  "/src/status/useStatus.tsx": `export const useStatus = () => ({ showStatus(message) { window.dispatchEvent(new CustomEvent("reference-review:action", { detail: message })); } });`,
  "/src/sdk/instafy.ts": `
    let reads = 0;
    export const controllerClient = { workspace: { files: { read: async ({ path }) => {
      reads += 1;
      window.__REFERENCE_REVIEW_READS__ = reads;
      const state = new URLSearchParams(location.search).get("state");
      await new Promise(resolve => setTimeout(resolve, state === "loading" ? 10000 : 160));
      if (state === "error" && reads === 1) throw new Error("The workspace is temporarily unavailable.");
      const contentText = Array.from({ length: 40 }, (_, index) => {
        if (index === 17) return '  return <History onReturnToLatest={returnToLatest} />;';
        if (index === 15) return 'export function ConversationHistoryPanel() {';
        if (index === 16) return '  const returnToLatest = useHistoryNavigation();';
        if (index === 18) return '}';
        return '// Keep navigation and draft state consistent: line ' + (index + 1);
      }).join('\\n');
      return { path, contentText, size: contentText.length, mimeType: "text/typescript", isText: true };
    } } } };
  `,
} });
