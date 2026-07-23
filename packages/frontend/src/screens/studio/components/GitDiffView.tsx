import { useCallback } from "react";
import { useProject } from "../../../projects/useProject";
import { useRuntime } from "../../../runtime/useRuntime";
import { useStatus } from "../../../status/useStatus";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { WorkspaceGitDiffPanel } from "./WorkspaceGitDiffPanel";
import type { ChatMessageCommitRange } from "../types";

export function GitDiffView({
  path,
  commitRange = null,
}: {
  path: string;
  commitRange?: ChatMessageCommitRange | null;
}) {
  const { activeProjectId } = useProject();
  const { effectiveRuntimeId } = useRuntime();
  const { showStatus } = useStatus();
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();

  const handleOpenFile = useCallback(
    (normalizedPath: string) => {
      if (!activeProjectId) {
        showStatus("Select a space before opening files.", "error", 4000);
        return;
      }
      if (typeof window === "undefined") {
        return;
      }

      const detail: { path: string; projectId?: string | null } = { path: normalizedPath };
      detail.projectId = activeProjectId;
      const runtimeWindow = window as typeof window & {
        __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
      };
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
      requestUrlPush();
      openPanelTab("code");
      window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
    },
    [activeProjectId, openPanelTab, requestUrlPush, showStatus],
  );

  return (
    <WorkspaceGitDiffPanel
      path={path}
      projectId={activeProjectId}
      runtimeId={effectiveRuntimeId ?? null}
      base={commitRange?.base ?? null}
      commit={commitRange?.head ?? null}
      onOpenFile={handleOpenFile}
      dataTestId="git-diff-view"
    />
  );
}
