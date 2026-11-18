import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The actions of ChatPanel's merge-conflict card, raised by a legacy Save
 * version conflict. ChatPanel is wired to a dozen providers, so mounting it in
 * jsdom is not practical (see chatPanelTurnEngineWiring.test.ts). These
 * assertions read the source.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ChatPanel's merge-conflict card", () => {
  it("offers Resolve with Assistant and Dismiss, and no way into the source-control drawer", () => {
    const card = between(chatPanel, "const workspaceGitSyncConflictDetails = useMemo", "}, [workspaceGitSyncConflict]);");
    expect(Array.from(card.matchAll(/testId: "([^"]+)"/g), (match) => match[1])).toEqual([
      "workspace-git-conflict-card",
      "workspace-git-conflict-resolve",
      "workspace-git-conflict-dismiss",
    ]);
    expect(Array.from(card.matchAll(/event: "([^"]+)"/g), (match) => match[1])).toEqual([
      "instafy:workspace-git-conflict-resolve",
      "instafy:workspace-git-conflict-dismiss",
    ]);
    expect(card).not.toContain("instafy:open-source-control");
  });
});
