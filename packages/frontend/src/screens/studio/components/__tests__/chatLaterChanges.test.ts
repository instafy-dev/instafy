import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { conversationLaterChanges, readChangeUndone } from "../chatLaterChanges";

function filesMessage(id: string, timestamp: number, jobId: string, paths: string[]): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp,
    files: paths.map((path) => ({ path, workspacePath: path, label: path, changeType: "changed" as const, lineRanges: [] })),
    metadata: { jobId },
  };
}

describe("conversationLaterChanges", () => {
  const stopped = filesMessage("stopped", 1_000, "job-stopped", ["sites/a/app.js", "sites/a/style.css"]);

  it("names a later turn's change to the same file, and nothing else", () => {
    const later = filesMessage("later", 2_000, "job-later", ["./sites/a/app.js"]);
    const earlier = filesMessage("earlier", 500, "job-earlier", ["sites/a/style.css"]);
    const elsewhere = filesMessage("elsewhere", 3_000, "job-elsewhere", ["sites/b/app.js"]);
    const changed = conversationLaterChanges([earlier, stopped, later, elsewhere]);
    expect(changed("stopped", ["sites/a/app.js"])).toBe(true);
    // An earlier turn, or another file, is not a later change to it.
    expect(changed("stopped", ["sites/a/style.css"])).toBe(false);
    expect(changed("later", ["sites/a/app.js"])).toBe(false);
    expect(changed("unknown", ["sites/a/app.js"])).toBe(false);
  });

  // The line an Undo leaves in the chat (hidden) marks that change undone, for
  // the row after a reload.
  it("says which changes the person undid", () => {
    const undoLine: ChatMessage = {
      id: "undo-line",
      role: "assistant",
      content: "The person undid the change from “Add a section.”",
      timestamp: 3_000,
      metadata: { source: "controller", kind: "change_undone", presentation: { hidden: true }, undoneMessageId: "stopped", undoneRunId: "run-1" },
    };
    expect(readChangeUndone(undoLine)).toEqual({ messageId: "stopped", runId: "run-1" });
    expect(readChangeUndone(stopped)).toBeNull();
    const chat = conversationLaterChanges([stopped, undoLine]);
    expect(chat.undone?.("stopped")).toBe(true);
    expect(chat.undone?.("later")).toBe(false);
    expect(conversationLaterChanges([stopped]).undone?.("stopped")).toBe(false);
  });

  it("counts a turn's own later rows as its own, inside a job thread too", () => {
    // The stopped turn's own report lands after its row: still that turn.
    const ownReport = filesMessage("own-report", 1_500, "job-stopped", ["sites/a/app.js"]);
    expect(conversationLaterChanges([stopped, ownReport])("stopped", ["sites/a/app.js"])).toBe(false);
    const thread: ChatMessage = {
      id: "thread-row",
      role: "assistant",
      content: "",
      timestamp: 900,
      messageType: "agent_job_thread",
      metadata: { messageType: "agent_job_thread", jobId: "job-stopped", threadMessages: [stopped, ownReport] },
    };
    const later = filesMessage("later", 2_000, "job-later", ["sites/a/app.js"]);
    expect(conversationLaterChanges([thread])("stopped", ["sites/a/app.js"])).toBe(false);
    expect(conversationLaterChanges([thread, later])("stopped", ["sites/a/app.js"])).toBe(true);
  });
});
