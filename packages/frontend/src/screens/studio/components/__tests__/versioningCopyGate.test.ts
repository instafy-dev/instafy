import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The em-dash gate for the surfaces that save, review and undo versions of a
// space's files: the chat change card, Files and the diff and review panels.
// No U+2014 anywhere in these files, comments included, and no "please" in
// their strings. Extend the list with every file the versioning UI adds.

const here = dirname(fileURLToPath(import.meta.url));
const components = resolve(here, "..");
const frontend = resolve(components, "../../../..");
const repo = resolve(frontend, "../..");

const GATED_FILES = [
  resolve(components, "ChatFileChangeList.tsx"),
  resolve(components, "versioningCopy.ts"),
  resolve(components, "FilesPanel.tsx"),
  resolve(components, "filesViewerFooter.ts"),
  resolve(components, "useFilesPanelWorkspaceTree.tsx"),
  resolve(components, "WorkspaceGitDiffPanel.tsx"),
  resolve(components, "GitReviewView.tsx"),
  resolve(frontend, "src/conversations/conversationMessageUtils.ts"),
  resolve(components, "__tests__/ChatFileChangeList.test.ts"),
  resolve(components, "__tests__/ChatFileChangeUnsavedEntry.test.tsx"),
  resolve(components, "__tests__/versioningCopy.chatChange.test.ts"),
  resolve(components, "__tests__/filesViewerFooter.test.ts"),
  resolve(repo, "docs/Settings-UI.md"),
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
        .filter(([, line]) => /\bplease\b/i.test(line));
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
