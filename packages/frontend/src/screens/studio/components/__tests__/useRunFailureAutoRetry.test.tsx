// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPromptsSentFromThisPageForTests,
  recordRunsStartedByPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../../types";
import { useRunFailureAutoRetry, type ScheduledRunFailureAutoRetry } from "../useRunFailureAutoRetry";

const MISSING_FINAL_MESSAGE =
  "Codex completed without returning a final assistant message after retry. The run trace contains the raw Codex events for debugging.";
const NO_WORKSPACE_CHANGES =
  "Codex did not apply any workspace changes for a file-modifying request.";
const MISSING_COMMAND_OBSERVATION =
  "Codex did not execute the command observation required by runtime routing, even after retry.";
const GENERIC_FAILURE = "Codex run timed out.";
// Codex's wording once its in-turn retries of a 429 ran out; names no wait,
// and a spent plan window reads the same.
const PROVIDER_RATE_LIMITED = "exceeded retry limit, last status: 429 Too Many Requests";
// The proxy's error body for a short rate limit; names no wait.
const PROVIDER_RATE_LIMITED_RETRYABLE =
  '{"error":{"message":"The upstream provider rate limit was reached.","type":"upstream_error","code":"upstream_rate_limit","retryable":true}}';
const PROVIDER_USAGE_LIMIT_REACHED =
  'backend responded with 429 Too Many Requests: {"error":{"type":"usage_limit_reached"}}';

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

const CURRENT_USER_ID = "user-1";
const CHAT_CLIENT_SESSION_ID = "session-1";

/**
 * A time a minute ago plus `offset` milliseconds: recent enough for an
 * automatic retry, in the same order as the offsets.
 */
function recent(offset: number): number {
  return Date.now() - 60_000 + offset;
}

/**
 * The job of the prompt {@link userMessage} made last: a failure made after it
 * is a failure of that job unless it names another.
 */
let lastPromptJobId = "job-none";

/**
 * A prompt the signed-in person sent from this tab, unless overridden. It is
 * recorded as sent from this page with the job the controller started for
 * it, as the submit path does, unless `sentHere` is false (sent before a
 * reload, or from another tab).
 */
function userMessage(
  content: string,
  overrides: Partial<ChatMessage> = {},
  { sentHere = true }: { sentHere?: boolean } = {},
): ChatMessage {
  const message = createMessage({
    id: `user-${content}`,
    role: "user",
    authorId: CURRENT_USER_ID,
    content,
    timestamp: recent(1),
    metadata: { client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID } },
    ...overrides,
  });
  lastPromptJobId = `job-${message.id}`;
  if (sentHere) {
    rememberPromptSentFromThisPage(message);
    recordRunsStartedByPromptSentFromThisPage(message, [lastPromptJobId]);
  }
  return message;
}

/**
 * A failed run `offset` milliseconds after {@link recent}'s base time, of the
 * job of the last prompt made unless `jobId` names another.
 */
function failureMessage(
  id: string,
  content: string,
  offset: number,
  { jobId = lastPromptJobId }: { jobId?: string } = {},
): ChatMessage {
  return createMessage({
    id,
    role: "assistant",
    content,
    timestamp: recent(offset),
    messageType: "error",
    metadata: {
      source: "agent",
      outcome: "failed",
      messageType: "error",
      errorMessage: content,
      jobId,
    },
  });
}

type HarnessProps = {
  messages: ChatMessage[];
  conversationKey: string | null;
  isBusy: boolean;
  autoRetry: (params: { failureMessage: ChatMessage; promptText: string }) => Promise<boolean | void>;
  currentUserId?: string | null;
  chatClientSessionId?: string | null;
  isRetrySuperseded?: (failureMessage: ChatMessage) => boolean;
};

let latestAutoRetryingKey: string | null = null;
let latestScheduledAutoRetry: ScheduledRunFailureAutoRetry | null = null;
let latestCancel: ((failureMessageId: string) => void) | null = null;

function Harness({
  currentUserId = CURRENT_USER_ID,
  chatClientSessionId = CHAT_CLIENT_SESSION_ID,
  ...props
}: HarnessProps) {
  const { autoRetryingKey, scheduledAutoRetry, cancelScheduledAutoRetry } =
    useRunFailureAutoRetry({ ...props, currentUserId, chatClientSessionId });
  latestAutoRetryingKey = autoRetryingKey;
  latestScheduledAutoRetry = scheduledAutoRetry;
  latestCancel = cancelScheduledAutoRetry;
  return null;
}

describe("useRunFailureAutoRetry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetPromptsSentFromThisPageForTests();
    lastPromptJobId = "job-none";
    latestAutoRetryingKey = null;
    latestScheduledAutoRetry = null;
    latestCancel = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
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
      timestamp: recent(3),
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
      timestamp: recent(4),
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

  it("clears the indicator when the resend was refused before anything was sent", async () => {
    const autoRetry = vi.fn().mockResolvedValue(false);
    const prompt = userMessage("Build me a landing page");
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

    expect(autoRetry).toHaveBeenCalledTimes(1);
    // No run will ever settle a refused resend, so the card goes back to manual.
    expect(latestAutoRetryingKey).toBeNull();
  });

  it("leaves another person's failed prompt to them", async () => {
    // Group conversation: a teammate's prompt failed. Their client owns the
    // retry; resending from here would send it a second time under this name.
    const autoRetry = vi.fn().mockResolvedValue(true);
    const prompt = userMessage("Build me a landing page", {
      authorId: "user-2",
      metadata: { prompt_metadata: { client: { sessionId: "session-9", userId: "user-2" } } },
    });
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

    expect(autoRetry).not.toHaveBeenCalled();
    expect(latestAutoRetryingKey).toBeNull();
  });

  it("leaves a prompt sent from another tab or device to that client", async () => {
    const autoRetry = vi.fn().mockResolvedValue(true);
    const prompt = userMessage("Build me a landing page", {
      metadata: { prompt_metadata: { client: { sessionId: "session-2", userId: CURRENT_USER_ID } } },
    });
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

    expect(autoRetry).not.toHaveBeenCalled();
  });

  it("never resends a failure that was retried by hand while the panel read busy", async () => {
    // The failure lands before the run update clears the busy state. The
    // person presses Try again, which the busy agent's send queue takes, so
    // the failure stays the last message.
    const autoRetry = vi.fn().mockResolvedValue(true);
    const prompt = userMessage("Build me a landing page");
    await render({ messages: [prompt], conversationKey: "conv-1", isBusy: true, autoRetry });
    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
    await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: true, autoRetry });

    const retriedByHand = (message: ChatMessage) => message.id === "failure-1";
    await rerender({
      messages: [prompt, failure],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
      isRetrySuperseded: retriedByHand,
    });

    expect(autoRetry).not.toHaveBeenCalled();
    expect(latestAutoRetryingKey).toBeNull();
  });

  it("leaves a steered run manual, since resending its prompt would drop the steer", async () => {
    const autoRetry = vi.fn().mockResolvedValue(true);
    const prompt = userMessage("Build me a landing page");
    // The controller stores a steer with the steered job's id.
    const steer = createMessage({
      id: "steer-1",
      role: "user",
      authorId: CURRENT_USER_ID,
      content: "Make the header blue too",
      timestamp: recent(2),
      metadata: {
        clientMessageId: "steer-client-1",
        sendIntent: { mode: "steer", jobId: lastPromptJobId, state: "applied" },
      },
    });
    await render({ messages: [prompt, steer], conversationKey: "conv-1", isBusy: false, autoRetry });
    const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 3);
    await rerender({
      messages: [prompt, steer, failure],
      conversationKey: "conv-1",
      isBusy: false,
      autoRetry,
    });

    expect(autoRetry).not.toHaveBeenCalled();
  });

  describe("rate-limited runs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    });

    async function advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    it("sends the prompt again once, after a 20 second countdown", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      // Not at once: the card counts down first.
      expect(autoRetry).not.toHaveBeenCalled();
      expect(latestAutoRetryingKey).toBeNull();
      expect(latestScheduledAutoRetry).toEqual({ key: "failure-1", dueAt: Date.now() + 20_000 });

      await advance(19_000);
      expect(autoRetry).not.toHaveBeenCalled();

      await advance(1_000);
      expect(autoRetry).toHaveBeenCalledTimes(1);
      expect(autoRetry.mock.calls[0]?.[0]).toMatchObject({
        promptText: "Build me a landing page",
        failureMessage: expect.objectContaining({ id: "failure-1" }),
      });
      expect(latestScheduledAutoRetry).toBeNull();
      expect(latestAutoRetryingKey).toBe("failure-1");

      // The resend fails the same way: the budget for this prompt is spent.
      const secondFailure = failureMessage("failure-2", PROVIDER_RATE_LIMITED_RETRYABLE, 4);
      await rerender({
        messages: [prompt, failure, prompt, secondFailure],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });
      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).toHaveBeenCalledTimes(1);
    });

    it("drops the countdown once the prompt was sent again by hand", async () => {
      // A second panel of this page, or a send queue that loaded late, shows
      // that the person already retried this card.
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });
      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry?.key).toBe("failure-1");

      await advance(10_000);
      await rerender({
        messages: [prompt, failure],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
        isRetrySuperseded: (message) => message.id === "failure-1",
      });
      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("waits as long as the failure asks, up to 60 seconds", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage(
        "failure-1",
        "stream disconnected before completion: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 90s.",
        2,
      );
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry?.dueAt).toBe(Date.now() + 60_000);

      await advance(59_999);
      expect(autoRetry).not.toHaveBeenCalled();
      await advance(1);
      expect(autoRetry).toHaveBeenCalledTimes(1);
    });

    it("Cancel stops the countdown for good and leaves the manual card", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry?.key).toBe("failure-1");

      await act(async () => {
        latestCancel?.("failure-1");
      });
      expect(latestScheduledAutoRetry).toBeNull();

      await advance(60_000);
      // An unrelated re-render must not restart it.
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
      expect(latestScheduledAutoRetry).toBeNull();
      expect(latestAutoRetryingKey).toBeNull();
    });

    it("drops the countdown when someone sends a message after the failure", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry?.key).toBe("failure-1");

      const followUp = userMessage("Use a darker theme instead", { timestamp: recent(3) });
      await rerender({
        messages: [prompt, failure, followUp],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });
      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("drops the countdown when another run starts", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: true, autoRetry });
      expect(latestScheduledAutoRetry).toBeNull();

      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("drops the countdown when the conversation changes", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry?.key).toBe("failure-1");

      await rerender({ messages: [], conversationKey: "conv-2", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("does not count down for a rate limit already there on load", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await render({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("leaves Codex's bare 429 manual, since a spent plan window reads the same", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("never counts down for someone else's prompt", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page", {
        authorId: "user-2",
        metadata: { prompt_metadata: { client: { sessionId: "session-9", userId: "user-2" } } },
      });
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("never counts down for a spent plan limit or a prompt that drove a browser page", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const usageLimit = failureMessage("failure-usage", PROVIDER_USAGE_LIMIT_REACHED, 2);
      await rerender({ messages: [prompt, usageLimit], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry).toBeNull();

      const browserPrompt = userMessage("Click the sign up button", {
        id: "user-browser",
        timestamp: recent(3),
        metadata: {
          browserTransport: "shared",
          browserPageId: "page-1",
          client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID },
        },
      });
      const browserFailure = failureMessage("failure-browser", PROVIDER_RATE_LIMITED_RETRYABLE, 4);
      await rerender({
        messages: [prompt, usageLimit, browserPrompt, browserFailure],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });
      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });
  });

  describe("only a recent prompt this page sent", () => {
    const HOUR = 60 * 60 * 1000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    });

    async function advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    /** A failed run of one agent's job, for the multi-agent cases. */
    function agentFailure(id: string, content: string, offset: number, extra: Record<string, unknown>) {
      const message = failureMessage(id, content, offset);
      return { ...message, metadata: { ...(message.metadata as Record<string, unknown>), ...extra } };
    }

    it("never resends a failure whose prompt was sent before a reload, when history loads after mount", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      // The panel mounts while the conversation's history is still loading.
      await render({ messages: [], conversationKey: "conv-1", isBusy: false, autoRetry });

      // History arrives: a prompt from this tab's session (sessionStorage
      // survives a reload) and its recent failure. This page did not send it.
      const prompt = userMessage("Build me a landing page", {}, { sentHere: false });
      const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
      const rateLimited = failureMessage("failure-2", PROVIDER_RATE_LIMITED_RETRYABLE, 3);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      await rerender({
        messages: [prompt, failure, rateLimited],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
      expect(latestAutoRetryingKey).toBeNull();
    });

    it("never resends an old failure, even of a prompt this page sent", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      await render({ messages: [], conversationKey: "conv-1", isBusy: false, autoRetry });

      const prompt = userMessage("Build me a landing page", { timestamp: Date.now() - 26 * HOUR });
      const failure = {
        ...failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 0),
        timestamp: Date.now() - 26 * HOUR + 5_000,
      };
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry).toBeNull();

      // Just past the ten minute window, for a kind that resends at once.
      const elevenMinutesAgo = {
        ...failureMessage("failure-2", MISSING_FINAL_MESSAGE, 0),
        timestamp: Date.now() - 11 * 60_000,
      };
      await rerender({
        messages: [prompt, failure, elevenMinutesAgo],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });

      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("never resends a failure without a timestamp", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = { ...failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2), timestamp: 0 };
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("drops a countdown that ends after the ten minute window, as when the page slept", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry?.key).toBe("failure-1");

      // The clock jumps on while timers were paused, then the timer fires.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await advance(20_000);

      expect(autoRetry).not.toHaveBeenCalled();
      expect(latestScheduledAutoRetry).toBeNull();
      expect(latestAutoRetryingKey).toBeNull();
    });

    it("drops a countdown on reload and does not start it again", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });
      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(latestScheduledAutoRetry?.key).toBe("failure-1");

      // Reload: the page and its in-memory record start over, and history
      // loads after the panel mounts.
      await act(async () => {
        root.unmount();
      });
      forgetPromptsSentFromThisPageForTests();
      root = createRoot(container);
      await render({ messages: [], conversationKey: "conv-1", isBusy: false, autoRetry });
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("never resends a prompt that was itself a retry", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const resend = userMessage("Build me a landing page", {
        id: "user-resend",
        metadata: {
          retryOfMessageId: "failure-0",
          client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID },
        },
      });
      await render({ messages: [resend], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
      await rerender({ messages: [resend, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      expect(autoRetry).not.toHaveBeenCalled();

      // The link stored by the controller, under prompt_metadata.
      const storedResend = userMessage("Add a dark theme", {
        id: "user-stored-resend",
        metadata: {
          prompt_metadata: {
            retryOfMessageId: "failure-1",
            client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID },
          },
        },
      });
      const rateLimited = failureMessage("failure-2", PROVIDER_RATE_LIMITED_RETRYABLE, 4);
      await rerender({
        messages: [resend, failure, storedResend, rateLimited],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });
      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("leaves a prompt sent to several agents manual", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Update the copy and the styles", {
        metadata: {
          client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID },
          agentSelection: { active: ["octo", "writer"], mentions: [] },
        },
      });
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("leaves a prompt manual when another agent's run for it succeeded", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Update the copy and the styles");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const writerDone = createMessage({
        id: "writer-done",
        content: "Updated the copy.",
        timestamp: recent(2),
        metadata: { source: "agent", outcome: "succeeded", jobId: "job-a", agentHandle: "writer" },
      });
      const failure = agentFailure("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 3, { jobId: "job-b" });
      await rerender({
        messages: [prompt, writerDone, failure],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("leaves a prompt manual when more than one agent answered it", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Update the copy and the styles");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const writerUpdate = createMessage({
        id: "writer-update",
        content: "Working on the copy.",
        timestamp: recent(2),
        metadata: { kind: "update", agent: { handle: "@writer" } },
      });
      const failure = agentFailure("failure-1", MISSING_FINAL_MESSAGE, 3, { agentHandle: "octo" });
      await rerender({
        messages: [prompt, writerUpdate, failure],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });

      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("still resends when the other replies belong to the failed run itself", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      const jobId = lastPromptJobId;
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const command = createMessage({
        id: "command",
        content: "npm run build",
        timestamp: recent(2),
        messageType: "command_execution",
        metadata: { status: "completed", outcome: "succeeded", jobId, agentHandle: "octo" },
      });
      const failure = agentFailure("failure-1", MISSING_FINAL_MESSAGE, 3, {
        jobId,
        agentHandle: "octo",
      });
      await rerender({
        messages: [prompt, command, failure],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });

      expect(autoRetry).toHaveBeenCalledTimes(1);
    });

    it("leaves a prompt from a duplicated tab to the tab that sent it", async () => {
      // A duplicated tab copies sessionStorage, so the prompt names this tab's
      // client session, but this page never sent it.
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page", {}, { sentHere: false });
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });

      const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      const rateLimited = failureMessage("failure-2", PROVIDER_RATE_LIMITED_RETRYABLE, 3);
      await rerender({
        messages: [prompt, failure, rateLimited],
        conversationKey: "conv-1",
        isBusy: false,
        autoRetry,
      });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });

    it("resends once when two panels of this page show the same failure", async () => {
      const autoRetryA = vi.fn().mockResolvedValue(true);
      const autoRetryB = vi.fn().mockResolvedValue(true);
      const containerB = document.createElement("div");
      document.body.appendChild(containerB);
      const rootB = createRoot(containerB);
      try {
        const prompt = userMessage("Build me a landing page");
        const failure = failureMessage("failure-1", MISSING_FINAL_MESSAGE, 2);
        await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry: autoRetryA });
        await act(async () => {
          rootB.render(
            <Harness messages={[prompt]} conversationKey="conv-1" isBusy={false} autoRetry={autoRetryB} />,
          );
        });
        await rerender({
          messages: [prompt, failure],
          conversationKey: "conv-1",
          isBusy: false,
          autoRetry: autoRetryA,
        });
        await act(async () => {
          rootB.render(
            <Harness
              messages={[prompt, failure]}
              conversationKey="conv-1"
              isBusy={false}
              autoRetry={autoRetryB}
            />,
          );
        });

        expect(autoRetryA.mock.calls.length + autoRetryB.mock.calls.length).toBe(1);
      } finally {
        await act(async () => {
          rootB.unmount();
        });
        containerB.remove();
      }
    });

    it("does not start a cancelled countdown again after the panel remounts", async () => {
      const autoRetry = vi.fn().mockResolvedValue(true);
      const prompt = userMessage("Build me a landing page");
      await render({ messages: [prompt], conversationKey: "conv-1", isBusy: false, autoRetry });
      const failure = failureMessage("failure-1", PROVIDER_RATE_LIMITED_RETRYABLE, 2);
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });
      await act(async () => {
        latestCancel?.("failure-1");
      });

      // Switching tabs remounts the panel, and its history loads again.
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      await render({ messages: [], conversationKey: "conv-1", isBusy: false, autoRetry });
      await rerender({ messages: [prompt, failure], conversationKey: "conv-1", isBusy: false, autoRetry });

      expect(latestScheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(autoRetry).not.toHaveBeenCalled();
    });
  });
});
