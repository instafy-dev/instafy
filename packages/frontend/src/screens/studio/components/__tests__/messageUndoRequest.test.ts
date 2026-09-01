import { describe, expect, it, vi } from "vitest";

import {
  buildUndoRequestSubmission,
  createMessageUndoRequestHandler,
  formatUndoTargetShortId,
  parseMessageUndoRequestDetail,
} from "../messageUndoRequest";

describe("parseMessageUndoRequestDetail", () => {
  it("accepts a message id and normalizes the timestamp", () => {
    expect(parseMessageUndoRequestDetail({ messageId: "msg-1", messageTimestamp: 123 })).toEqual({
      messageId: "msg-1",
      messageTimestamp: 123,
      onSettled: null,
    });
    expect(parseMessageUndoRequestDetail({ messageId: "msg-1", messageTimestamp: Number.NaN })).toEqual({
      messageId: "msg-1",
      messageTimestamp: null,
      onSettled: null,
    });
  });

  it("keeps a callable result callback and drops a non-callable one", () => {
    const onSettled = vi.fn();
    expect(parseMessageUndoRequestDetail({ messageId: "msg-1", onSettled })?.onSettled).toBe(onSettled);
    expect(
      parseMessageUndoRequestDetail({ messageId: "msg-1", onSettled: "nope" })?.onSettled,
    ).toBeNull();
  });

  it("rejects malformed details", () => {
    expect(parseMessageUndoRequestDetail(null)).toBeNull();
    expect(parseMessageUndoRequestDetail("msg-1")).toBeNull();
    expect(parseMessageUndoRequestDetail({ messageId: "" })).toBeNull();
    expect(parseMessageUndoRequestDetail({ messageId: "   " })).toBeNull();
    expect(parseMessageUndoRequestDetail({})).toBeNull();
  });
});

describe("buildUndoRequestSubmission", () => {
  it("composes an undo message that references the target agent message", () => {
    const submission = buildUndoRequestSubmission({
      messageId: "2ee0ad74-1111-2222-3333-444455556666",
      messageTimestamp: Date.UTC(2026, 7, 31, 14, 32),
    });

    // The text carries a compact human-readable reference...
    expect(submission.message).toContain("undo the change");
    expect(submission.message).toContain("(id 2ee0ad74)");
    expect(submission.message).toContain(" at ");
    // ...and the metadata carries the structured reference the backend
    // passes through with the created message.
    expect(submission.metadata).toEqual({
      undoTargetMessageId: "2ee0ad74-1111-2222-3333-444455556666",
    });
  });

  it("omits the time reference when no timestamp is known", () => {
    const submission = buildUndoRequestSubmission({ messageId: "abc123", messageTimestamp: null });
    expect(submission.message).toBe("Please undo the change from your message (id abc123).");
  });
});

describe("formatUndoTargetShortId", () => {
  it("compacts separators and truncates to eight characters", () => {
    expect(formatUndoTargetShortId("2ee0-ad74-99")).toBe("2ee0ad74");
    expect(formatUndoTargetShortId("abc")).toBe("abc");
  });
});

describe("createMessageUndoRequestHandler", () => {
  function undoEvent(detail: unknown): Event {
    return { detail } as unknown as Event;
  }

  async function flushChain(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("submits the composed undo request for a valid event", async () => {
    const submit = vi.fn().mockResolvedValue(true);
    const handler = createMessageUndoRequestHandler(submit);

    handler(undoEvent({ messageId: "msg-9", messageTimestamp: null }));
    await Promise.resolve();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      message: "Please undo the change from your message (id msg9).",
      metadata: { undoTargetMessageId: "msg-9" },
    });
  });

  it("serializes rapid requests so the second waits for the first (no dropped intent)", async () => {
    let resolveFirst: (value: boolean) => void = () => {};
    const submit = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue(true);
    const handler = createMessageUndoRequestHandler(submit);

    handler(undoEvent({ messageId: "first" }));
    handler(undoEvent({ messageId: "second" }));
    await Promise.resolve();

    // While the first submit is in flight, the second stays queued locally
    // instead of hitting submitMessage's in-flight guard and being dropped.
    expect(submit).toHaveBeenCalledTimes(1);

    resolveFirst(true);
    await flushChain();

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]?.metadata).toEqual({ undoTargetMessageId: "second" });
  });

  it("ignores malformed events and survives a failed submit", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(true);
    const handler = createMessageUndoRequestHandler(submit);

    handler(undoEvent(null));
    handler(undoEvent({ messageId: "" }));
    expect(submit).not.toHaveBeenCalled();

    handler(undoEvent({ messageId: "fails" }));
    await flushChain();

    handler(undoEvent({ messageId: "recovers" }));
    await flushChain();

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]?.metadata).toEqual({ undoTargetMessageId: "recovers" });
  });

  it("reports a refused or failed submit back to the dispatcher", async () => {
    // A submit that returns false was gated before it could send (busy lane,
    // credentials, credits). The chip must learn that so its click is not a
    // silent no-op that merely waits out the double-click cooldown.
    const submit = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(true);
    const handler = createMessageUndoRequestHandler(submit);

    const refused = vi.fn();
    handler(undoEvent({ messageId: "refused", onSettled: refused }));
    await flushChain();
    expect(refused).toHaveBeenCalledWith(false);

    const threw = vi.fn();
    handler(undoEvent({ messageId: "threw", onSettled: threw }));
    await flushChain();
    expect(threw).toHaveBeenCalledTimes(1);
    expect(threw).toHaveBeenCalledWith(false);

    const accepted = vi.fn();
    handler(undoEvent({ messageId: "accepted", onSettled: accepted }));
    await flushChain();
    expect(accepted).toHaveBeenCalledWith(true);
  });

  it("keeps serializing after a result callback throws", async () => {
    const submit = vi.fn().mockResolvedValue(true);
    const handler = createMessageUndoRequestHandler(submit);

    handler(
      undoEvent({
        messageId: "first",
        onSettled: () => {
          throw new Error("listener fault");
        },
      }),
    );
    await flushChain();

    handler(undoEvent({ messageId: "second" }));
    await flushChain();

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]?.metadata).toEqual({ undoTargetMessageId: "second" });
  });
});
