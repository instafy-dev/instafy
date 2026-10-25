import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * How ChatPanel joins Instafy's browser view to useSharedBrowserAutoAttach so
 * that the view attaches once by itself when the machine a press gave up on
 * comes up a little later. ChatPanel is wired to a dozen providers, so
 * mounting it in jsdom is not practical (see conversationRosterPlacement.test.ts).
 * These assertions read the source; useSharedBrowserAutoAttach.test.tsx covers
 * what the hook and sharedBrowserLateAttachInputs decide, and
 * BrowserSessionModal.slowStart.test.tsx what the view does when asked.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function callArguments(source: string, callee: string): string {
  const start = source.indexOf(`${callee}({`);
  expect(start).toBeGreaterThan(-1);
  expect(source.indexOf(`${callee}({`, start + 1)).toBe(-1);
  const end = source.indexOf("});", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ChatPanel's attach after a machine that came up late", () => {
  it("hands the hook what the view shows and the conversation's live host", () => {
    const autoAttach = callArguments(chatPanel, "useSharedBrowserAutoAttach");
    expect(autoAttach).toContain("...sharedBrowserLateAttachInputs({");
    expect(autoAttach).toContain("transport: browserTransport,");
    expect(autoAttach).toContain("kind: sharedBrowserViewKind,");
    expect(autoAttach).toContain("error: sharedBrowserViewError,");
    expect(autoAttach).toContain("hostRuntimeId: conversationBrowserHostRuntimeId,");
    // Nothing after the inputs overrides them.
    expect(autoAttach.slice(autoAttach.indexOf("...sharedBrowserLateAttachInputs({"))).not.toMatch(/\n\s{4}(view|hostRuntimeId):/);
  });

  it("takes the view's kind and error from the view, and the live host from runtime status", () => {
    expect(chatPanel).toContain("onViewStateChange={setSharedBrowserViewKind}");
    expect(chatPanel).toContain("onConnectionErrorChange={handleSharedBrowserConnectionErrorChange}");
    expect(callArguments(chatPanel, "conversationBrowserHostId")).toContain("runtimes: runtimeStatuses ?? null,");
  });

  it("hands the view the hook's request", () => {
    expect(chatPanel).toMatch(/autoAttachToken: sharedBrowserAutoAttachToken,\n\s*requestAutoAttach: requestSharedBrowserAutoAttach,\n\s*\} = useSharedBrowserAutoAttach\(\{/);
    expect(chatPanel).toContain("autoAttachToken={sharedBrowserAutoAttachToken}");
  });
});
