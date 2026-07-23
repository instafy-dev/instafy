// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { useRunFailureAutoRetry } from "../useRunFailureAutoRetry";

const MISSING_FINAL_MESSAGE =
  "Codex completed without returning a final assistant message after retry. The run trace contains the raw Codex events for debugging.";
const NO_WORKSPACE_CHANGES =
  "Codex did not apply any workspace changes for a file-modifying request.";
const MISSING_COMMAND_OBSERVATION =
  "Codex did not execute the command observation required by runtime routing, even after retry.";
const GENERIC_FAILURE = "Codex run timed out.";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

function userMessage(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return createMessage({ id: `user-${content}`, role: "user", content, timestamp: 1, ...overrides });
}

function failureMessage(id: string, content: string, timestamp: number): ChatMessage {
  return createMessage({
    id,
    role: "assistant",
    content,
    timestamp,
    messageType: "error",
    metadata: {
      source: "agent",
      outcome: "failed",
      messageType: "error",
      errorMessage: content,
    },
  });
}

type HarnessProps = {
  messages: ChatMessage[];
  conversationKey: string | null;
  isBusy: boolean;
  autoRetry: (params: { failureMessage: ChatMessage; promptText: string }) => Promise<void>;
};

let latestAutoRetryingKey: string | null = null;

function Harness(props: HarnessProps) {
  const { autoRetryingKey } = useRunFailureAutoRetry(props);
  latestAutoRetryingKey = autoRetryingKey;
  return null;
}

describe("useRunFailureAutoRetry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    latestAutoRetryingKey = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: HarnessProps) {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
  }

  async function rerender(props: HarnessProps) {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
  }

  it("(a) auto-retries once for a transient failure that appears after mount", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    const prompt = userMessage("Build me a landing page");

    // Mount with only the prompt present (no failure yet -> empty baseline).
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });
    expect(autoRetry).not.toHaveBeenCalled();

    // A transient failure appears as the last message.
    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

    expect(autoRetry).toHaveBeenCalledTimes(1);
    expect(autoRetry.mock.calls[0]?.[0]).toMatchObject({
      promptText: "Build me a landing page",
      failureMessage: expect.objectContaining({ id: "failure-1" }),
    });
    // The indicator stays up for the whole retry RUN, not just the dispatch:
    // no message newer than the failure has settled yet.
    expect(latestAutoRetryingKey).toBe("failure-1");
  });

  it("holds the indicator through the retry run and clears on a terminal result", async () => {
    let resolveRetry: (() => void) | null = null;
    const autoRetry = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const prompt = userMessage("Build me a landing page");
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });
    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

    expect(latestAutoRetryingKey).toBe("failure-1");

    // Dispatch resolves (resend accepted) — the run is still executing, so the
    // indicator must persist rather than reverting to the manual card.
    await act(async () => {
      resolveRetry?.();
    });
    expect(latestAutoRetryingKey).toBe("failure-1");

    // The re-dispatched run streams an interim (non-terminal) message: still up.
    const thinking = createMessage({
      id: "thinking",
      role: "assistant",
      content: "Thinking…",
      timestamp: 3,
      metadata: { kind: "update", outcome: "in_progress" },
    });
    await rerender({
      messages: [prompt, failure, prompt, thinking],
      conversationKey: "conv-1",
      isBusy: true,
      autoRetry,
    });
    expect(latestAutoRetryingKey).toBe("failure-1");

    // The retry produces a terminal success result -> indicator clears.
    const success = createMessage({
      id: "success",
      role: "assistant",
      content: "Created the landing page.",
      timestamp: 4,
      metadata: { source: "agent", outcome: "succeeded" },
    });
    await rerender({
      messages: [prompt, failure, prompt, thinking, success],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
    });
    expect(latestAutoRetryingKey).toBeNull();
  });

  it("(b) does not auto-retry a failure present at mount (reload guard)", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    const prompt = userMessage("Build me a landing page");
    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);

    await render({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

    expect(autoRetry).not.toHaveBeenCalled();
    expect(latestAutoRetryingKey).toBeNull();
  });

  it("(c) does not auto-retry beyond MAX per origin (manual fallback)", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    const prompt = userMessage("Build me a landing page");

    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

    // First transient failure auto-retries.
    const firstFailure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({
      messages: [prompt, firstFailure],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
    });
    expect(autoRetry).toHaveBeenCalledTimes(1);

    // The resend produces the same prompt again, which fails again -> same origin.
    const secondFailure = failureMessage("failure-2", MISSING_FINAL_MESSAGE, 4);
    await rerender({
      messages: [prompt, firstFailure, prompt, secondFailure],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
    });

    // Origin budget exhausted: no second auto-retry, manual card stays.
    expect(autoRetry).toHaveBeenCalledTimes(1);
    expect(latestAutoRetryingKey).toBeNull();
  });

  it("(d) does not auto-retry non-eligible kinds", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    const prompt = userMessage("Build me a landing page");
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

    const verificationFailure = failureMessage("failure-v", MISSING_COMMAND_OBSERVATION, 2);
    await rerender({
      messages: [prompt, verificationFailure],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
    });
    expect(autoRetry).not.toHaveBeenCalled();

    const genericFailure = failureMessage("failure-g", GENERIC_FAILURE, 4);
    await rerender({
      messages: [prompt, verificationFailure, genericFailure],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
    });
    expect(autoRetry).not.toHaveBeenCalled();
  });

  it("(e) isBusy suppresses auto-retry until the run settles", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    const prompt = userMessage("Build me a landing page");
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: true, autoRetry });

    const failure = failureMessage("failure-1", NO_WORKSPACE_CHANGES, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: true, autoRetry });
    expect(autoRetry).not.toHaveBeenCalled();

    // Once no longer busy, the same last-message candidate auto-retries.
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
    expect(autoRetry).toHaveBeenCalledTimes(1);
  });

  it("(f) resets baseline and counters when the conversation key changes", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    const promptA = userMessage("Build me a landing page");
    await render({ messages: [promptA], conversationKey: "conv-1", isBusy: false, autoRetry });

    const failureA = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({
      messages: [promptA, failureA],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
    });
    expect(autoRetry).toHaveBeenCalledTimes(1);

    // Switch to a different conversation whose last message is already a failure.
    // Because it is in the NEW baseline, it must not auto-retry.
    const promptB = userMessage("Add a dark theme", { id: "user-B" });
    const failureB = failureMessage("failure-B", MISSING_FINAL_MESSAGE, 6);
    await rerender({
      messages: [promptB, failureB],
      conversationKey: "conv-2",
      isBusy: false,
      autoRetry,
    });
    expect(autoRetry).toHaveBeenCalledTimes(1);

    // A NEW failure appearing after the switch auto-retries (fresh per-origin budget).
    const failureB2 = failureMessage("failure-B2", MISSING_FINAL_MESSAGE, 8);
    await rerender({
      messages: [promptB, failureB, failureB2],
      conversationKey: "conv-2",
      isBusy: false,
      autoRetry,
    });
    expect(autoRetry).toHaveBeenCalledTimes(2);
    expect(autoRetry.mock.calls[1]?.[0]).toMatchObject({
      failureMessage: expect.objectContaining({ id: "failure-B2" }),
    });
  });

  it("(g) never fires twice for the same failure id", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    const prompt = userMessage("Build me a landing page");
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
    expect(autoRetry).toHaveBeenCalledTimes(1);

    // Re-render with the identical last message (e.g. an unrelated state update).
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
    expect(autoRetry).toHaveBeenCalledTimes(1);
  });

  it("does not auto-retry when the failure has no originating prompt", async () => {
    const autoRetry = vi.fn().mockResolvedValue(undefined);
    // Assistant-only conversation: no user prompt to resend.
    await render({ messages: [], conversationKey: "conv-1", isBusy: false, autoRetry });
    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [failure], conversationKey: "conv-1", isBusy: false, autoRetry });
    expect(autoRetry).not.toHaveBeenCalled();
    expect(latestAutoRetryingKey).toBeNull();
  });
});
