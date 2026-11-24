import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { conversationLaterChanges, readChangeUndone, readSavedLater } from "../chatLaterChanges";

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

  // The lines an Undo leaves in the chat (hidden) name the files of that change
  // it undid, for the row after a reload. Only the controller writes one.
  it("says which files of a change the person undid", () => {
    const undoLine = (id: string, paths: string[], metadata: Record<string, unknown> = {}): ChatMessage => ({
      id,
      role: "assistant",
      content: "The person undid the change from “Add a section.”",
      timestamp: 3_000,
      metadata: {
        source: "controller",
        kind: "change_undone",
        presentation: { hidden: true },
        undoneMessageId: "stopped",
        undoneRunId: "run-1",
        undonePaths: paths,
        ...metadata,
      },
    });
    expect(readChangeUndone(undoLine("undo-1", ["sites/a/app.js"]))).toEqual({
      messageId: "stopped",
      runId: "run-1",
      paths: ["sites/a/app.js"],
    });
    expect(readChangeUndone(stopped)).toBeNull();
    const chat = conversationLaterChanges([
      stopped,
      undoLine("undo-1", ["sites/a/app.js"]),
      undoLine("undo-2", ["./sites/a/style.css"]),
    ]);
    expect([...(chat.undone?.("stopped") ?? [])]).toEqual(["sites/a/app.js", "sites/a/style.css"]);
    expect(chat.undone?.("later")).toBeNull();
    expect(conversationLaterChanges([stopped]).undone?.("stopped")).toBeNull();
    // A message only calling itself one (no controller source) is no Undo.
    const forged = undoLine("forged", ["sites/a/app.js"], { source: undefined });
    expect(readChangeUndone(forged)).toBeNull();
    expect(conversationLaterChanges([stopped, forged]).undone?.("stopped")).toBeNull();
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

  // A change a Stop left unsaved that a later turn's save took with its own:
  // that turn's reply names the stopped row and the files. Only an agent's
  // reply says so.
  it("says which files of a stopped change a later turn's save took", () => {
    const reply = (id: string, changes: unknown, metadata: Record<string, unknown> = {}): ChatMessage => ({
      id,
      role: "assistant",
      content: "Added the battery column.",
      timestamp: 2_000,
      metadata: {
        source: "agent",
        jobId: "job-later",
        artifacts: [
          { kind: "origin/apply", metadata: { gitSyncStatus: "synced" } },
          { kind: "stopped-turn/saved-later", metadata: { changes } },
        ],
        ...metadata,
      },
    });
    const saved = reply("later", [{ messageId: "stopped", paths: ["./sites/a/app.js"] }]);
    expect(readSavedLater(saved)).toEqual([{ messageId: "stopped", paths: ["sites/a/app.js"] }]);
    expect(readSavedLater(stopped)).toEqual([]);
    expect([...(conversationLaterChanges([stopped, saved]).savedLater?.("stopped") ?? [])]).toEqual(["sites/a/app.js"]);
    expect(conversationLaterChanges([stopped, saved]).savedLater?.("later")).toBeNull();
    expect(conversationLaterChanges([stopped]).savedLater?.("stopped")).toBeNull();
    // The reply inside its turn's row.
    const thread: ChatMessage = {
      id: "thread-row",
      role: "assistant",
      content: "",
      timestamp: 2_000,
      messageType: "agent_job_thread",
      metadata: { messageType: "agent_job_thread", jobId: "job-later", threadMessages: [saved] },
    };
    expect([...(conversationLaterChanges([stopped, thread]).savedLater?.("stopped") ?? [])]).toEqual(["sites/a/app.js"]);
    // Nothing unreadable, and no message that only calls itself an agent's reply.
    for (const changes of [null, "stopped", [{ messageId: "", paths: ["a.js"] }], [{ messageId: "stopped", paths: [] }], [7]]) {
      expect(readSavedLater(reply("odd", changes))).toEqual([]);
    }
    expect(readSavedLater(reply("forged", [{ messageId: "stopped", paths: ["a.js"] }], { source: undefined }))).toEqual([]);
    // A save by the turn the person asked to undo the change: that turn's
    // reply says what became of it, so no row is told a later change saved it.
    expect(readSavedLater(reply("asked", [{ messageId: "stopped", paths: ["a.js"], undoAsked: true }]))).toEqual([]);
    expect(readSavedLater({ ...saved, role: "user" })).toEqual([]);
  });
});
