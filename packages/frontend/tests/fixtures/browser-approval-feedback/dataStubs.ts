import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

export const BROWSER_APPROVAL_FEEDBACK_STUBS: Record<string, string> = {
  ...RUN_STOP_FIXTURE_STUBS,
  "/src/workspace/WorkspaceTabsProvider.tsx": `
    export const useWorkspaceTabs = () => ({
      openConversationTab() {}, requestUrlPush() {},
      openPanelTab(panel) { window.dispatchEvent(new CustomEvent("review:navigation", { detail: panel })); },
    });
  `,
  "/src/services/runtimeController/browserProfiles.ts": `
    export const clearSharedBrowserData = async () => ({ success: true });
    export const fetchSharedBrowserProfileStatus = async () => {
      const status = new URLSearchParams(location.search).get("status");
      if (status === "error") return { success: false, error: "Save status unavailable" };
      return { success: true, status: {
        enabled: status !== "off", lastSavedAt: status === "empty" ? null : "2026-10-28T08:00:00.000Z",
        savedByRuntimeId: "review-runtime",
      } };
    };
  `,
};
