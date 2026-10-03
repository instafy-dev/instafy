import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * How ChatPanel wires chat attachments into the composer, the send and the
 * merge notice. ChatPanel is wired to a dozen providers, so mounting it in
 * jsdom is not practical (see conversationRosterPlacement.test.ts). These
 * assertions read the source; what each piece does is covered by
 * useChatComposerAttachments, ChatComposerSurface, useChatSubmitDispatch,
 * workspaceFileStaleMerge and projectCapabilities tests.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function callArguments(source: string, callee: string): string {
  const start = source.indexOf(`${callee}({`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("});", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function jsxProps(source: string, component: string): string {
  const start = source.indexOf(`<${component}\n`);
  expect(start).toBeGreaterThan(-1);
  // The element closes on its own line, at the indentation it opened with.
  const indent = source.slice(source.lastIndexOf("\n", start) + 1, start);
  const end = source.indexOf(`\n${indent}/>`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ChatPanel chat attachments", () => {
  it("takes the space's attachments answer from GET /projects/:id through useProject", () => {
    expect(chatPanel).toMatch(/chatAttachments,\n\s*\} = useProject\(\);/);
    expect(chatPanel).toContain(
      "const chatAttachmentsUnavailableReason = resolveChatAttachmentsUnavailableReason(chatAttachments);",
    );
  });

  it("turns the image button, paste and drop off with the reason when the server says none", () => {
    expect(callArguments(chatPanel, "useChatComposerAttachments")).toContain(
      "unavailableReason: chatAttachmentsUnavailableReason",
    );
    expect(jsxProps(chatPanel, "ChatComposerSurface")).toContain(
      "imageUploadUnavailableReason={chatAttachmentsUnavailableReason}",
    );
  });

  it("tracks the images a send carries instead of clearing the whole tray", () => {
    const dispatch = callArguments(chatPanel, "useChatSubmitDispatch");
    expect(dispatch).toContain("markImageAttachmentsSending,");
    expect(dispatch).toContain("removeSentImageAttachments,");
    expect(chatPanel).not.toContain("clearImageAttachments");
  });

  it("sends a merge through the attachment-aware helper with the space's answer and the files it builds", () => {
    const merge = callArguments(chatPanel, "sendWorkspaceFileStaleMerge");
    expect(merge).toContain("notice,");
    expect(merge).toContain("chatAttachments,");
    // The helper's options (the snapshot files) reach the submit flow as they are.
    expect(merge).toContain("submit: (prompt, options) => onSubmit(conversationId, prompt, options),");
    expect(chatPanel).not.toContain("buildWorkspaceFileStaleMergeRequest");
  });

  it("gives a failed send's restored draft its reply context back", () => {
    const start = chatPanel.indexOf("const invokeSubmitMessage = useCallback<SubmitMessageFn>");
    const body = chatPanel.slice(start, chatPanel.indexOf("return submitted;", start));
    expect(body).toMatch(
      /!submitted &&\s*!automatic &&\s*pendingReplyContext &&\s*pendingReplyContextRef\.current === null &&\s*shouldAttachPendingReplyContext\(pendingReplyContext, latestInputValueRef\.current \?\? ""\)/,
    );
    expect(body).toContain("pendingReplyContextRef.current = pendingReplyContext;");
  });
});
