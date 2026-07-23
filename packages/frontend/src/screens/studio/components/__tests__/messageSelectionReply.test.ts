// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  buildMessageSelectionReplyContext,
  formatSelectionReplyComposerText,
  getCurrentSelectedTextForMessage,
  normalizeSelectedMessageText,
  shouldStageSelectionReplyDraft,
} from "../messageSelectionReply";

function message(content: string): ChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content,
    timestamp: 1,
  };
}

describe("messageSelectionReply", () => {
  it("records exact offsets when the selected text matches canonical content", () => {
    const context = buildMessageSelectionReplyContext({
      action: "summarize",
      conversationId: "conversation-1",
      message: message("First sentence. Second sentence."),
      selectedText: "Second sentence.",
    });

    expect(context).toMatchObject({
      kind: "message_selection",
      conversationId: "conversation-1",
      messageId: "assistant-1",
      action: "summarize",
      selectedText: "Second sentence.",
      textStart: 16,
      textEnd: 32,
    });
    expect(context?.selectionHash).toMatch(/^[0-9a-f]{8}$/);
    expect(context?.sourceContentHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("collapses soft line breaks introduced by inline rendered chips", () => {
    expect(
      normalizeSelectedMessageText(
        "The build shells out to npx json in\npackage.json:28\nand\npackage.json:28\n, but the root tool list in\npackage.json:16\ndoes not declare json.",
      ),
    ).toBe(
      "The build shells out to npx json in package.json:28 and package.json:28, but the root tool list in package.json:16 does not declare json.",
    );
  });

  it("keeps selected text but leaves offsets unknown when exact recovery is not possible", () => {
    const context = buildMessageSelectionReplyContext({
      action: "explain_more",
      conversationId: "conversation-1",
      message: message("Inspect `bigint.ts:15` first."),
      selectedText: "bigint.ts line 15",
    });

    expect(context).toMatchObject({
      selectedText: "bigint.ts line 15",
      textStart: null,
      textEnd: null,
    });
  });

  it("formats selected text as a composer quote with an optional instruction", () => {
    const output = formatSelectionReplyComposerText({
      context: { selectedText: "Line one\nLine two" },
      instruction: "Explain more",
    });

    expect(output).toBe("> Line one\n> Line two\n\nExplain more");
  });

  it("stages only manual selection replies in the composer", () => {
    expect(shouldStageSelectionReplyDraft("reply")).toBe(true);
    expect(shouldStageSelectionReplyDraft("summarize")).toBe(false);
    expect(shouldStageSelectionReplyDraft("explain_more")).toBe(false);
  });

  it("returns selected text only when the selection belongs to the target message", () => {
    document.body.innerHTML = `
      <div data-chat-message-id="first">First selectable message text.</div>
      <div data-chat-message-id="second">Second message text.</div>
    `;
    const first = document.querySelector('[data-chat-message-id="first"]');
    const second = document.querySelector('[data-chat-message-id="second"]');
    expect(first?.firstChild).toBeTruthy();
    expect(second?.firstChild).toBeTruthy();

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(first?.firstChild ?? document.body, 6);
    range.setEnd(first?.firstChild ?? document.body, 16);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(getCurrentSelectedTextForMessage("first")).toBe("selectable");
    expect(getCurrentSelectedTextForMessage("second")).toBeNull();

    selection?.removeAllRanges();
    document.body.innerHTML = "";
  });
});
