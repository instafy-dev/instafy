import { describe, expect, it } from "vitest";
import type { ChatSubmitOverride } from "../chatSubmitPlanning";
import { composerTurnEngineFor } from "../composerTurnEngine";

// docs/Local-Engine-Turns.md 5.2: only the composer's own Send of the draft it
// shows carries the engine chosen for the next message. Nothing downstream can
// tell words Instafy wrote from the person's own once they carry a claim.
const ENGINE = "fixture-engine";

describe("the engine a chat panel send carries", () => {
  it("is the chosen one on the composer's own Send, also of a restored stash's draft", () => {
    // Enter, the send button, and a restored stash all reach the panel's
    // submit without an override of the caller's.
    expect(composerTurnEngineFor({ override: undefined, automatic: false, pendingEngineId: ENGINE })).toBe(ENGINE);
    expect(composerTurnEngineFor({ override: null, automatic: false, pendingEngineId: ENGINE })).toBe(ENGINE);
  });

  it("is none when nothing is chosen", () => {
    expect(composerTurnEngineFor({ override: undefined, automatic: false, pendingEngineId: null })).toBeNull();
  });

  it("is none for every caller that passes words of its own", () => {
    const callers: Array<[string, ChatSubmitOverride]> = [
      ["an undo", { message: "Undo the last change", editorState: null, metadata: { undoTargetMessageId: "m-1" } }],
      ["the goal's help prompt", { message: "Help me get unstuck on the goal: …", editorState: null }],
      ["a Summarize selection reply", { message: "> quoted\n\nSummarize", editorState: null, metadata: { replyContext: { messageId: "m-2" } } }],
      ["an Explain more selection reply", { message: "> quoted\n\nExplain more", editorState: null, metadata: { replyContext: { messageId: "m-3" } } }],
      ["a dictated voice turn", { message: "fix the failing login test", editorState: null }],
      ["a goal command", { message: "/goal pause", editorState: null }],
    ];
    for (const [caller, override] of callers) {
      expect(composerTurnEngineFor({ override, automatic: false, pendingEngineId: ENGINE }), caller).toBeNull();
    }
  });

  it("is none for every automatic send, with or without words of its own", () => {
    // Try again's automatic resend and Continue pass the prompt's words; a
    // site's ask passes its own words and targets.
    const callers: Array<[string, ChatSubmitOverride | undefined]> = [
      ["an automatic Try again", { message: "Fix the failing login test", editorState: null, metadata: { retryOfMessageId: "m-4" } }],
      ["a site's ask", { message: "What's on this map?", editorState: null, targetAgentHandles: ["octo"] }],
      ["Continue after a Stop", { message: "Continue", editorState: null }],
      ["an automatic send of the draft", undefined],
    ];
    for (const [caller, override] of callers) {
      expect(composerTurnEngineFor({ override, automatic: true, pendingEngineId: ENGINE }), caller).toBeNull();
    }
  });
});
