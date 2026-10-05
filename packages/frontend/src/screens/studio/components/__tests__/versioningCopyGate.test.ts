import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The em-dash gate for the surfaces that save, review and undo versions of a
// space's files: Save in Files, History with its Unsaved work and Desktop
// line, the chat change card, the diff and review panels, and the Studio
// chrome around them. No U+2014 anywhere in these files, comments included,
// and no "please" in their strings. Extend the list with every file the
// versioning UI adds or changes.

const here = dirname(fileURLToPath(import.meta.url));
const components = resolve(here, "..");
const frontend = resolve(components, "../../../..");
const src = resolve(frontend, "src");
const repo = resolve(frontend, "../..");

const GATED_FILES = [
  // The copy every versioning surface draws on.
  resolve(components, "versioningCopy.ts"),
  // The chat change card.
  resolve(components, "ChatFileChangeList.tsx"),
  resolve(src, "conversations/conversationMessageUtils.ts"),
  // Files: the one Save, reads at pinned revisions, the footer and the
  // stale card in the chat.
  resolve(components, "FilesPanel.tsx"),
  resolve(components, "FilesExplorerTree.tsx"),
  resolve(components, "filesViewerFooter.ts"),
  resolve(components, "filesVersioning.ts"),
  resolve(components, "useFilesPanelCreateEntries.ts"),
  resolve(components, "useFilesPanelSave.ts"),
  resolve(components, "useFilesPanelViewerState.ts"),
  resolve(components, "useFilesPanelWorkspaceTree.tsx"),
  resolve(components, "workspaceFileStaleNoticeStore.ts"),
  resolve(components, "workspaceFileStaleReload.ts"),
  resolve(components, "ChatSystemRows.tsx"),
  resolve(components, "ChatPanel.tsx"),
  // Skills saved as one version.
  resolve(components, "SkillsPanel.tsx"),
  resolve(components, "skillsWorkspaceWrites.ts"),
  // History, Unsaved work and the Desktop line, and the Changes drawer they
  // replace in the new modes.
  resolve(components, "SourceControlDrawer.tsx"),
  resolve(components, "HistoryDrawer.tsx"),
  resolve(components, "HistoryConfirmDialog.tsx"),
  resolve(components, "UnsavedWorkSection.tsx"),
  resolve(components, "DesktopChangesLine.tsx"),
  resolve(components, "LegacyChangesDrawer.tsx"),
  resolve(components, "unsavedWorkPathChecks.ts"),
  resolve(components, "historyFocus.ts"),
  resolve(components, "useUnsavedWorkNotice.ts"),
  resolve(src, "components/DrawerHeader.tsx"),
  // Diff and review panels.
  resolve(components, "GitReviewView.tsx"),
  resolve(components, "WorkspaceGitDiffPanel.tsx"),
  resolve(components, "WorkspaceGitRollingDiffPanel.tsx"),
  resolve(src, "services/runtimeController/workspaceGit.ts"),
  // The origin answers the copy is chosen by (the gateway's 503 codes).
  resolve(src, "services/runtimeController/originErrors.ts"),
  // Studio chrome: the History or Changes label and its badge, unsaved
  // edits as drafts, and the review tabs.
  resolve(src, "screens/StudioLayout.tsx"),
  resolve(src, "screens/studio/StudioLazyPanels.tsx"),
  resolve(src, "screens/useStudioGitStatusBadge.ts"),
  resolve(src, "screens/useWorkspaceVersioningBadge.ts"),
  resolve(src, "navigation/StudioDraftNavigationGuard.tsx"),
  resolve(src, "workspace/StudioDrafts.tsx"),
  resolve(src, "workspace/StudioFileBufferDrafts.tsx"),
  resolve(src, "workspace/WorkspaceTabsProvider.tsx"),
  resolve(src, "workspace/useWorkspaceTabOpeners.ts"),
  resolve(src, "workspace/gitReviewTypes.ts"),
  resolve(src, "workspace/unsavedWorkSeen.ts"),
  resolve(src, "workspace/unsavedWorkSignals.ts"),
  resolve(src, "workspace/unsavedWorkStore.ts"),
  resolve(src, "workspace/useActiveWorkspaceVersioning.ts"),
  // Tests that spell out the copy.
  resolve(components, "__tests__/ChatFileChangeList.test.ts"),
  resolve(components, "__tests__/ChatFileChangeUnsavedEntry.test.tsx"),
  resolve(components, "__tests__/versioningCopy.chatChange.test.ts"),
  resolve(components, "__tests__/versioningCopy.save.test.ts"),
  resolve(components, "__tests__/versioningCopy.shared.test.ts"),
  resolve(components, "__tests__/filesViewerFooter.test.ts"),
  resolve(components, "__tests__/useFilesPanelSave.test.tsx"),
  resolve(components, "__tests__/FilesPanel.save.test.tsx"),
  // Docs.
  // Settings categories and the chat runtime-switch notes this work touched.
  resolve(components, "SettingsPanel.tsx"),
  resolve(src, "conversations/useConversationSubmitFlow.ts"),
  resolve(repo, "docs/Git-Service.md"),
  resolve(repo, "docs/Notifications.md"),
  resolve(repo, "docs/Settings-UI.md"),
  resolve(repo, "docs/Testing.md"),
];

// Lines that are agent prompts, not labels: the assistant is asked politely
// on purpose. Everything else with "please" is a UI string and fails.
const PROMPT_LINE_ALLOWLIST = [
  /get the project back to a clean state/i,
  /instafy-git-canonical-conflicts\/SKILL\.md` as the default procedure/i,
];

describe("versioning copy gate", () => {
  it.each(GATED_FILES.map((file) => [file.slice(repo.length + 1), file]))(
    "%s carries no em-dash",
    (_label, file) => {
      expect(existsSync(file), file).toBe(true);
      const source = readFileSync(file, "utf8");
      const offenders = source
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => line.includes("\u2014"));
      expect(offenders, offenders.map(([line, text]) => `${line}: ${text.trim()}`).join("\n")).toEqual([]);
    },
  );

  it.each(GATED_FILES.map((file) => [file.slice(repo.length + 1), file]))(
    "%s says no please to the user",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      const offenders = source
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => /\bplease\b/i.test(line))
        .filter(([, line]) => !PROMPT_LINE_ALLOWLIST.some((pattern) => pattern.test(line)));
      expect(offenders, offenders.map(([line, text]) => `${line}: ${text.trim()}`).join("\n")).toEqual([]);
    },
  );

  // The gate keeps its own rule: it names the dash by escape, so a scan that
  // covers test files never trips over the gate itself.
  it("names the dash by escape in its own source", () => {
    const offenders = readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => line.includes("\u2014"));
    expect(offenders, offenders.map(([line, text]) => `${line}: ${text.trim()}`).join("\n")).toEqual([]);
  });
});
