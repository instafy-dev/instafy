import { describe, expect, it } from "vitest";

import { earlierTurnWaitingLine, MESSAGE_TURNS_KEY } from "../messageTurns";

const EARLIER = "4e9f3c4a-6a47-4a0e-9d5f-2a1f0f7b9c11";

function waitingRun(stamp: unknown = { version: 1, afterRunId: EARLIER, afterAgent: "a" }) {
  return { status: "queued" as const, metadata: { [MESSAGE_TURNS_KEY]: stamp } };
}

describe("earlierTurnWaitingLine", () => {
  it("names the agent whose turn a queued turn waits for", () => {
    for (const status of ["queued", "in_progress", "awaiting_approval"] as const) {
      expect(earlierTurnWaitingLine(waitingRun(), { [EARLIER]: { status } })).toBe(
        "Waiting for @a to finish…",
      );
    }
  });

  it("says nothing once that turn has ended, so the turn reads what it otherwise would", () => {
    for (const status of ["success", "failed", "canceled", "merged"] as const) {
      expect(earlierTurnWaitingLine(waitingRun(), { [EARLIER]: { status } })).toBeNull();
    }
  });

  it("says nothing when the page does not have the earlier run", () => {
    expect(earlierTurnWaitingLine(waitingRun(), {})).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun(), null)).toBeNull();
  });

  it("says nothing for a turn that started or waits for none", () => {
    const runs = { [EARLIER]: { status: "in_progress" as const } };
    expect(earlierTurnWaitingLine({ ...waitingRun(), status: "in_progress" }, runs)).toBeNull();
    expect(earlierTurnWaitingLine({ status: "queued", metadata: {} }, runs)).toBeNull();
    expect(earlierTurnWaitingLine({ status: "queued", metadata: null }, runs)).toBeNull();
    expect(earlierTurnWaitingLine(null, runs)).toBeNull();
  });

  it("reads only the controller's version 1 stamp, with a run and an agent", () => {
    const runs = { [EARLIER]: { status: "in_progress" as const } };
    expect(earlierTurnWaitingLine(waitingRun({ version: 2, afterRunId: EARLIER, afterAgent: "a" }), runs)).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun({ version: 1, afterRunId: EARLIER, afterAgent: " " }), runs)).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun({ version: 1, afterAgent: "a" }), runs)).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun("a"), runs)).toBeNull();
  });
});
