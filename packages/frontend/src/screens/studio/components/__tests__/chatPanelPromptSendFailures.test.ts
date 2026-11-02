import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A browser card leaves the chat once a continuation for it is in the chat,
 * and comes back with its button when the controller did not take that
 * continuation. A send the controller did not take may add no message,
 * though: the chat does not add an error again when it repeats the chat's
 * last one within 15 s. So ChatPanel works out again, when the sent-prompt
 * registry says a send failed, everything it reads about whether a prompt
 * went out: the transcript, the cards' host (cards continued, and cards
 * still opening by themselves) and the sites of the cards the person
 * pressed (only a press that went out is their OK for its site). ChatPanel
 * is wired to a dozen providers, so mounting it in jsdom is not practical
 * (see chatPanelSharedBrowserLateAttach.test.ts): this reads the source, and
 * chatBrowserCardSendFailure.test.tsx draws a chat memoized the same way.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function block(startText: string, endText: string): string {
  const start = chatPanel.indexOf(startText);
  expect(start).toBeGreaterThan(-1);
  const end = chatPanel.indexOf(endText, start);
  expect(end).toBeGreaterThan(start);
  return chatPanel.slice(start, end + endText.length);
}

/** A memo's dependency list: what follows its callback's last `}, [`. */
function dependencies(memo: string): string[] {
  const list = memo.slice(memo.lastIndexOf("}, [") + "}, [".length, memo.lastIndexOf("]);"));
  return list.split(",").map((entry) => entry.trim()).filter(Boolean);
}

// Each of these reads the registry (didSendFailForPromptSentFromThisPage)
// through the messages it is given.
const MEMOS = [
  ["the transcript", "const groupedMessages = useMemo(() => {", "synthesizeAgentJobThreadMessages("],
  ["the cards a continuation was sent for", "const browserRequestContinued = useMemo(() => {", "browserRequestContinuedKeys("],
  ["the cards still opening by themselves", "const routedBrowserWaiting = useMemo(() => {", "routedBrowserWaitingKeys("],
  ["the sites of the cards the person pressed", "const pressedCardSites = useMemo(() => {", "pressedBrowserCardSites("],
] as const;

describe("ChatPanel after a send the controller did not take", () => {
  it("reads the registry's failures before it works out the transcript", () => {
    const declared = chatPanel.indexOf("const promptSendFailures = usePromptSendFailureVersion();");
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(chatPanel.indexOf("const groupedMessages = useMemo("));
  });

  // Each is the only place ChatPanel calls what it reads, so a new place
  // that reads whether a prompt went out is looked at here too.
  it.each(MEMOS)("works out %s again", (_name, startText, reads) => {
    const memo = block(startText, "]);\n");
    expect(memo).toContain(reads);
    expect(chatPanel.split(reads).length - 1).toBe(1);
    expect(memo).toContain("void promptSendFailures;");
    expect(dependencies(memo)).toContain("promptSendFailures");
  });
});
