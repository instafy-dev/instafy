import { describe, expect, it } from "vitest";

import { buildCollapsedQueuedMessageSummary } from "../chatSendQueueSummary";

describe("chatSendQueueSummary", () => {
  it("returns a preview for a single queued message", () => {
    expect(
      buildCollapsedQueuedMessageSummary(
        {
          id: "queued-1",
          message: "Hey!   Can you   summarize this  next?",
          targetHandles: ["octo"],
          browserTargetLabel: "BBC Home",
        },
        1,
      ),
    ).toEqual({
      message: "Hey! Can you summarize this next?",
    });
  });

  it("falls back to waiting text when the queued item has no typed message", () => {
    expect(
      buildCollapsedQueuedMessageSummary(
        {
          id: "queued-1",
          message: "   ",
          targetHandles: [],
          browserTargetLabel: null,
        },
        1,
      ),
    ).toEqual({
      message: "Waiting to send",
    });
  });

  it("returns null when there is more than one queued message", () => {
    expect(
      buildCollapsedQueuedMessageSummary(
        {
          id: "queued-1",
          message: "Hey",
          targetHandles: [],
          browserTargetLabel: null,
        },
        2,
      ),
    ).toBeNull();
  });

  it("does not include target or status metadata in the collapsed preview", () => {
    expect(
      buildCollapsedQueuedMessageSummary(
        {
          id: "queued-1",
          message: "Can you show me a good coffee place nearby?",
          targetHandles: ["octo"],
          browserTargetLabel: null,
        },
        1,
      ),
    ).toEqual({
      message: "Can you show me a good coffee place nearby?",
    });
  });
});
