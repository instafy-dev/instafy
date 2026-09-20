import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { revealCanonicalMessageTarget } from "../messageContextPresentation";
const message = (id: string, timestamp: number, content = id): ChatMessage => ({ id, timestamp, content, role: "assistant" });

describe("canonical message targets", () => {
  it("reveals a hidden match in its chronological position without changing surrounding rows", () => {
    const before = message("before", 1), target = message("matched-status", 2, "Stored runtime output"), after = message("after", 3);
    const result = revealCanonicalMessageTarget([before, after], [before, target, after], target.id);
    expect(result).toEqual([before, target, after]);
    expect(result[0]).toBe(before); expect(result[2]).toBe(after);
  });
  it("replaces a synthesized row with the actual matching source without duplicating its ID", () => {
    const target = message("run-start", 2, "Exact command output");
    const synthetic = { ...target, content: "Run summary", messageType: "agent_job_thread" };
    expect(revealCanonicalMessageTarget([synthetic], [target], target.id)).toEqual([target]);
  });
  it("does not invent a row for an unavailable target or change ordinary transcripts", () => {
    const rows = [message("a", 1)];
    expect(revealCanonicalMessageTarget(rows, rows, "missing")).toBe(rows);
    expect(revealCanonicalMessageTarget(rows, rows, null)).toBe(rows);
  });
});
