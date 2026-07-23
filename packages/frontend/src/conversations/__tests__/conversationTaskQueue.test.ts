import { describe, expect, it } from "vitest";
import { createConversationTaskQueue } from "../conversationTaskQueue";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("conversationTaskQueue", () => {
  it("serializes tasks for the same conversation", async () => {
    const queue = createConversationTaskQueue();
    const first = createDeferred<string>();
    const events: string[] = [];

    const firstRun = queue.enqueue("conversation-1", async () => {
      events.push("first:start");
      const value = await first.promise;
      events.push(`first:end:${value}`);
      return value;
    });

    const secondRun = queue.enqueue("conversation-1", async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    first.resolve("first");
    await expect(firstRun).resolves.toBe("first");
    await expect(secondRun).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end:first", "second:start", "second:end"]);
  });

  it("does not block other conversations", async () => {
    const queue = createConversationTaskQueue();
    const first = createDeferred<string>();
    const events: string[] = [];

    const slowRun = queue.enqueue("conversation-1", async () => {
      events.push("slow:start");
      const value = await first.promise;
      events.push(`slow:end:${value}`);
      return value;
    });

    const parallelRun = queue.enqueue("conversation-2", async () => {
      events.push("parallel:start");
      events.push("parallel:end");
      return "parallel";
    });

    await expect(parallelRun).resolves.toBe("parallel");
    expect(events).toEqual(["slow:start", "parallel:start", "parallel:end"]);

    first.resolve("slow");
    await expect(slowRun).resolves.toBe("slow");
  });

  it("continues after a failed task", async () => {
    const queue = createConversationTaskQueue();
    const events: string[] = [];

    const failedRun = queue.enqueue("conversation-1", async () => {
      events.push("failed:start");
      throw new Error("boom");
    });

    const nextRun = queue.enqueue("conversation-1", async () => {
      events.push("next:start");
      events.push("next:end");
      return "next";
    });

    await expect(failedRun).rejects.toThrow("boom");
    await expect(nextRun).resolves.toBe("next");
    expect(events).toEqual(["failed:start", "next:start", "next:end"]);
  });
});
