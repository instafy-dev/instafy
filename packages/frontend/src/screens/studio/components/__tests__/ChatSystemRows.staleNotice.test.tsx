import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatPostTranscriptAuxiliaryRows } from "../ChatSystemRows";
import type { WorkspaceFileStaleNotice } from "../workspaceFileStaleNoticeStore";

type RowProps = Parameters<typeof ChatPostTranscriptAuxiliaryRows>[0];

function renderStaleCard(notice: WorkspaceFileStaleNotice, busy: RowProps["workspaceFileStaleBusy"] = null) {
  const props = {
    jobThreadPresent: false,
    workspaceFileStaleNotice: notice,
    workspaceFileStaleBusy: busy,
    workspaceFileStaleError: null,
    onWorkspaceFileStaleMerge: vi.fn(),
    onWorkspaceFileStaleReload: vi.fn(),
    onWorkspaceFileStaleDismiss: vi.fn(),
    workspaceGitSyncConflictDetails: null,
    workspaceGitSyncConflictDetectedAt: null,
    credentialGateStateForBubble: null,
    aiOnboardingOpen: false,
    renderAssistantAvatar: () => null,
  } as unknown as RowProps;
  return renderToStaticMarkup(<ChatPostTranscriptAuxiliaryRows {...props} />);
}

const notice: WorkspaceFileStaleNotice = {
  projectId: "space-a",
  path: "README.md",
  label: "README.md",
  baseText: "a",
  localText: "b",
  detectedAt: 1,
};

describe("workspace file stale card", () => {
  it("keeps today's description for a save conflict on the space", () => {
    const markup = renderStaleCard(notice);
    expect(markup).toContain('data-testid="workspace-file-stale-card"');
    expect(markup).toContain("A newer version was saved while you were editing.");
  });

  it("explains that a Desktop save kept the user's version in the folder", () => {
    const markup = renderStaleCard({ ...notice, variant: "desktop", originId: "desk-1" });
    expect(markup).toContain(
      "It changed in the space while you edited. Your version is still in the folder on this computer. Merge keeps both; Reload uses the space&#x27;s version.",
    );
    expect(markup).not.toContain("—");
  });
});
