import { describe, expect, it } from "vitest";

import {
  earlierTurnEndedAtMs,
  earlierTurnWaitingLine,
  MESSAGE_TURNS_KEY,
  waitsForEarlierTurn,
} from "../messageTurns";

const FIRST = "4e9f3c4a-6a47-4a0e-9d5f-2a1f0f7b9c11";
const SECOND = "7c2d1e0f-3b4a-4c5d-8e6f-9a0b1c2d3e4f";

function waitingRun(stamp: unknown = { version: 1, after: [{ runId: FIRST, agent: "a" }] }) {
  return { status: "queued" as const, metadata: { [MESSAGE_TURNS_KEY]: stamp } };
}

const twoEarlier = {
  version: 1,
  after: [
    { runId: FIRST, agent: "a" },
    { runId: SECOND, agent: "b" },
  ],
};

describe("earlierTurnWaitingLine", () => {
  it("names the agent whose turn a queued turn waits for", () => {
    for (const status of ["queued", "in_progress", "awaiting_approval"] as const) {
      expect(earlierTurnWaitingLine(waitingRun(), { [FIRST]: { status } })).toBe("Waiting for @a to finish…");
    }
  });

  it("names the latest earlier agent still running, so a stopped middle one is passed over", () => {
    const run = waitingRun(twoEarlier);
    expect(
      earlierTurnWaitingLine(run, { [FIRST]: { status: "in_progress" }, [SECOND]: { status: "queued" } }),
    ).toBe("Waiting for @b to finish…");
    expect(
      earlierTurnWaitingLine(run, { [FIRST]: { status: "in_progress" }, [SECOND]: { status: "canceled" } }),
    ).toBe("Waiting for @a to finish…");
  });

  it("says nothing once every earlier turn has ended, so the turn reads what it otherwise would", () => {
    for (const status of ["success", "failed", "canceled", "merged"] as const) {
      expect(earlierTurnWaitingLine(waitingRun(), { [FIRST]: { status } })).toBeNull();
    }
  });

  it("says nothing when the page does not have the earlier runs", () => {
    expect(earlierTurnWaitingLine(waitingRun(), {})).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun(), null)).toBeNull();
  });

  it("says nothing for a turn that started or waits for none", () => {
    const runs = { [FIRST]: { status: "in_progress" as const } };
    expect(earlierTurnWaitingLine({ ...waitingRun(), status: "in_progress" }, runs)).toBeNull();
    expect(earlierTurnWaitingLine({ status: "queued", metadata: {} }, runs)).toBeNull();
    expect(earlierTurnWaitingLine({ status: "queued", metadata: null }, runs)).toBeNull();
    expect(earlierTurnWaitingLine(null, runs)).toBeNull();
  });

  it("reads only the controller's version 1 stamp, with runs and agents", () => {
    const runs = { [FIRST]: { status: "in_progress" as const } };
    expect(earlierTurnWaitingLine(waitingRun({ version: 2, after: [{ runId: FIRST, agent: "a" }] }), runs)).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun({ version: 1, after: [{ runId: FIRST, agent: " " }] }), runs)).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun({ version: 1, after: [{ agent: "a" }] }), runs)).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun({ version: 1, afterRunId: FIRST, afterAgent: "a" }), runs)).toBeNull();
    expect(earlierTurnWaitingLine(waitingRun("a"), runs)).toBeNull();
  });
});

describe("waitsForEarlierTurn and earlierTurnEndedAtMs", () => {
  it("a turn waits while an earlier turn runs, and its own wait starts when the last one ended", () => {
    const run = waitingRun(twoEarlier);
    const running = {
      [FIRST]: { status: "success" as const, updatedAt: "2026-11-24T22:00:00.000Z" },
      [SECOND]: { status: "in_progress" as const, updatedAt: "2026-11-24T22:05:00.000Z" },
    };
    expect(waitsForEarlierTurn(run, running)).toBe(true);
    expect(earlierTurnEndedAtMs(run, running)).toBe(0);

    const ended = {
      [FIRST]: { status: "success" as const, updatedAt: "2026-11-24T22:00:00.000Z" },
      [SECOND]: { status: "failed" as const, updatedAt: "2026-11-24T22:05:00.000Z" },
    };
    expect(waitsForEarlierTurn(run, ended)).toBe(false);
    expect(earlierTurnEndedAtMs(run, ended)).toBe(Date.parse("2026-11-24T22:05:00.000Z"));
    expect(earlierTurnEndedAtMs(run, {})).toBe(0);
    expect(earlierTurnEndedAtMs({ status: "queued", metadata: {} }, ended)).toBe(0);
  });
});
