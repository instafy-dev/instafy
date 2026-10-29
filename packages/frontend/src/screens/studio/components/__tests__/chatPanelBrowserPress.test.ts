import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Which machine a press on a card opens Instafy's browser on. ChatPanel is
 * wired to a dozen providers, so mounting it in jsdom is not practical (see
 * conversationRosterPlacement.test.ts). These assertions read the source;
 * browserAutoStart.test.ts covers which machine is the conversation's own,
 * and BrowserSessionModal.resume.test.tsx what the view does with a named one.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function pressBranch(): string {
  const start = chatPanel.indexOf("// A press is the person's own: the browser may start the machine.");
  expect(start).toBeGreaterThan(-1);
  const end = chatPanel.indexOf('setBrowserSubtab("browser");', start);
  expect(end).toBeGreaterThan(start);
  return chatPanel.slice(start, end);
}

describe("a press on a card in Instafy's browser", () => {
  it("opens the conversation's own machine by name, as Studio opening it by itself does", () => {
    const press = pressBranch();
    expect(press).toMatch(
      /if \(transport === "shared" && conversationBrowserHostRuntimeId && !exactBrowserRuntimeId\) \{\n\s*resumeBrowserSession\(conversationBrowserHostRuntimeId\);\n\s*\} else \{\n\s*openBrowserSession\(transport === "shared" \? resolvedBrowserRuntimeId : null\);\n\s*\}/,
    );
    // The same machine the automatic open attaches to.
    expect(chatPanel).toContain("resumeBrowserSession(plan.runtimeId, { show: false });");
  });
});
