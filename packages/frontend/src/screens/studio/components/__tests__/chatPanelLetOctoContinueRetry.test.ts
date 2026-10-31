import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Try again on a turn that a press of Let Octo continue started. The chat
 * shows that press as the button's words, so resending what the chat shows
 * sent Octo "Let Octo continue" alone, as a chat turn with no page. ChatPanel
 * is wired to a dozen providers, so mounting it in jsdom is not practical (see
 * chatPanelSharedBrowserLateAttach.test.ts): this reads the source, and
 * useRunFailureRetryActions.test.tsx and useChatBrowserHandoff.test.tsx cover
 * what the hooks send.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

describe("ChatPanel's Try again for a browser turn", () => {
  it("presses Let Octo continue again with its whole prompt, and sends a card's task again", () => {
    const start = chatPanel.indexOf("browserRequestRetryRef.current = async (promptMessage, retryMetadata) => {");
    expect(start).toBeGreaterThan(-1);
    const end = chatPanel.indexOf("\n  };\n", start);
    expect(end).toBeGreaterThan(start);
    const retry = chatPanel.slice(start, end);
    expect(retry).toContain("if (!isLetOctoContinuePrompt(promptMessage)) {");
    expect(retry).toContain("return browserRequestState.retryContinuation(promptMessage, retryMetadata);");
    expect(retry).toContain("browserHandoff.retryContinue(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT, retryMetadata)");
  });
});
