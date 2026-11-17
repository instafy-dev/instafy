import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What ChatPanel wires for the typing row before a turn's first step.
 * ChatPanel is wired to a dozen providers, so mounting it in jsdom is not
 * practical (see chatPanelTurnEngineWiring.test.ts). These assertions read the
 * source; runtimeAlertPresentation.test.ts (resolveWorkspaceStarting, the
 * words), useConversationControllerDispatch.test.tsx (the mark of a send on
 * its way) and conversationDispatchMarks.test.ts cover what each piece does.
 *
 * A send that found the space's machine stopped showed nothing for 3 s, then
 * "Starting…", and every turn said "Starting…", also on a running machine.
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

describe("ChatPanel's typing row before a turn's first step", () => {
  it("shows from the press of Send, while the send is still on its way", () => {
    expect(chatPanel).toContain("const assistantTurnPending = isAssistantTyping || Boolean(isAssistantDispatching);");
    expect(between(chatPanel, "<ChatTypingRows", "/>")).toContain("isAssistantTyping={assistantTurnPending}");
    // Its words and state are worked out for that window too.
    expect(between(chatPanel, "const typingIndicatorFallback = useMemo", "const typingAgentIdentity")).not.toMatch(
      /!isAssistantTyping\b/,
    );
  });

  it("leaves everything that waits on a running turn on the run itself", () => {
    // The stale-start check and the job thread's cover read the turn's run, not a send on its way.
    expect(between(chatPanel, "resolveStaleStartingRecoveryKey({", "})")).toMatch(/\bisAssistantTyping,/);
    expect(between(chatPanel, "const jobThreadTypingCoverage = useMemo(", "const isAssistantTypingCoveredByJobThreadPreview"))
      .toMatch(/\bisAssistantTyping\b/);
  });

  it("says Starting… only while the space's machine starts, for the row and the turn's own line", () => {
    const starting = between(chatPanel, "const workspaceStarting = resolveWorkspaceStarting({", "});");
    expect(starting).toContain("runtimeReady,");
    expect(starting).toContain("activeRunStatus: activeConversationRun?.status ?? null,");
    expect(starting).toContain("turnPending: assistantTurnPending,");
    // The turn's own line reads the same start from the chat's runtime activity.
    expect(chatPanel).toContain("<ChatRuntimeActivityContext.Provider value={chatRuntimeActivityValue}>");
    expect(between(chatPanel, "const chatRuntimeActivityValue = useMemo(", ");")).toContain("workspaceStarting");
  });
});
