// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPromptsSentFromThisPageForTests,
  recordRunsStartedByPromptSentFromThisPage,
  recordSendFailedForPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../../types";
import type { ChatSubmitOverride } from "../chatSubmitPlanning";
import type { RunFailureRetryContextValue } from "../RunFailureNotice";
import { readChatSendQueue, writeChatSendQueue } from "../chatSendQueueStorage";
import {
  buildServerSendQueuePromptBody,
  mapServerSendQueueEntryToQueuedItem,
} from "../useChatServerSendQueue";
import {
  useRunFailureRetryActions,
  type RunFailureResendOptions,
} from "../useRunFailureRetryActions";

const MISSING_FINAL_MESSAGE =
  "Codex completed without returning a final assistant message after retry.";
// A short rate limit: the proxy's streamed form names its wait.
const PROVIDER_RATE_LIMITED =
  "stream disconnected before completion: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 20s.";
const CURRENT_USER_ID = "user-1";
const CHAT_CLIENT_SESSION_ID = "session-1";

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

// Sent by the signed-in person from this page, which started job PROMPT_JOB_ID
// for it (both recorded in beforeEach), so this page owns its retry.
const PROMPT_JOB_ID = "job-1";
const PROMPT = createMessage({
  id: "user-1",
  role: "user",
  authorId: CURRENT_USER_ID,
  content: "Build me a landing page",
  timestamp: 1,
  metadata: { client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID } },
});

/**
 * A failed run `offset` milliseconds after a minute ago (recent enough to
 * retry), of PROMPT's job unless `jobId` names another.
 */
function failure(
  id: string,
  content: string,
  offset: number,
  { jobId = PROMPT_JOB_ID, runId }: { jobId?: string; runId?: string } = {},
): ChatMessage {
  return createMessage({
    id,
    content,
    timestamp: Date.now() - 60_000 + offset,
    messageType: "error",
    metadata: {
      source: "agent",
      outcome: "failed",
      messageType: "error",
      jobId,
      ...(runId ? { runId } : {}),
    },
  });
}

type Submit = (override: ChatSubmitOverride, options?: RunFailureResendOptions) => Promise<boolean>;

type HarnessProps = {
  messages: ChatMessage[];
  queuedSends?: Array<{ metadata?: Record<string, unknown> | null }>;
  submit: Submit;
  showStatus?: (message: string) => void;
  isAssistantTyping?: boolean;
  autoRetryEnabled?: boolean;
};

let latest: RunFailureRetryContextValue | null = null;

function Harness({
  messages,
  queuedSends,
  submit,
  showStatus = vi.fn(),
  isAssistantTyping = false,
  autoRetryEnabled,
}: HarnessProps) {
  latest = useRunFailureRetryActions({
    messages,
    queuedSends,
    conversationKey: "conv-1",
    currentUserId: CURRENT_USER_ID,
    chatClientSessionId: CHAT_CLIENT_SESSION_ID,
    isAssistantTyping,
    autoRetryEnabled,
    submit,
    showStatus,
  });
  return null;
}

/** A submit that finds the agent busy and puts the message in the send queue. */
function queueingSubmit() {
  return vi.fn<Submit>(async (_override, options) => {
    options?.onQueued?.();
    return false;
  });
}

/**
 * A submit that sends the message the way the submit path does: it records
 * the prompt as sent from this page, and the job the controller started for
 * it. With `startsRun: false` the prompt starts no job, as when group
 * participation only records it. With `dispatchFails` the controller does not
 * take it: the submit path records the failure and still resolves `true`.
 * `onSend` gets the local copy the submit path appends.
 */
function sendingSubmit({
  startsRun = true,
  dispatchFails = false,
  onSend,
}: { startsRun?: boolean; dispatchFails?: boolean; onSend?: (localCopy: ChatMessage) => void } = {}) {
  let sends = 0;
  return vi.fn<Submit>(async (override) => {
    sends += 1;
    const metadata = { ...(override.metadata ?? {}), clientMessageId: `client-resend-${sends}` };
    const localCopy = createMessage({
      id: `resend-${sends}`,
      role: "user",
      authorId: CURRENT_USER_ID,
      content: override.message,
      timestamp: Date.now(),
      metadata,
    });
    rememberPromptSentFromThisPage(localCopy);
    onSend?.(localCopy);
    if (dispatchFails) {
      recordSendFailedForPromptSentFromThisPage({ metadata });
    } else if (startsRun) {
      recordRunsStartedByPromptSentFromThisPage({ metadata }, [`job-resend-${sends}`]);
    }
    return true;
  });
}

// The row sendPromptToController appends when the controller did not take a prompt.
function dispatchErrorRow(): ChatMessage {
  return createMessage({
    id: "dispatch-error",
    content: "Controller unavailable. Try again shortly.",
    timestamp: Date.now(),
    messageType: "error",
    metadata: { messageType: "error" },
  });
}

describe("useRunFailureRetryActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetPromptsSentFromThisPageForTests();
    rememberPromptSentFromThisPage(PROMPT);
    recordRunsStartedByPromptSentFromThisPage(PROMPT, [PROMPT_JOB_ID]);
    latest = null;
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

  it("resends the prompt with a link to the failure and retires the card once sent", async () => {
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    let resolveSubmit: ((sent: boolean) => void) | null = null;
    const submit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    // Loaded with the failure already there, so nothing is retried automatically.
    await render({ messages: [PROMPT, failed], submit });
    expect(latest?.isRetrySuperseded?.(failed)).toBe(false);

    await act(async () => {
      void latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      {
        message: "Build me a landing page",
        editorState: null,
        metadata: { retryOfMessageId: "failure-1" },
      },
      expect.objectContaining({ automatic: false }),
    );
    expect(latest?.pendingRetryKey).toBe("failure-1");

    // A second press before the pending state lands must not send again.
    await act(async () => {
      void latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSubmit?.(true);
    });
    expect(latest?.pendingRetryKey).toBeNull();
    // Accepted, though the resent message is not listed yet: no second Try again.
    expect(latest?.isRetrySuperseded?.(failed)).toBe(true);
  });

  it("retires the card when the resend was queued behind a busy agent", async () => {
    // The agent is still running another turn, so the submit path queues the
    // resend instead of sending it. It goes out later; a second press must not
    // queue a second copy.
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    const submit = queueingSubmit();
    await render({ messages: [PROMPT, failed], submit, isAssistantTyping: true });

    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(latest?.pendingRetryKey).toBeNull();
    expect(latest?.isRetrySuperseded?.(failed)).toBe(true);

    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps Try again when the resend was refused", async () => {
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    const submit = vi.fn().mockResolvedValue(false);
    await render({ messages: [PROMPT, failed], submit });

    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(latest?.pendingRetryKey).toBeNull();
    expect(latest?.isRetrySuperseded?.(failed)).toBe(false);
  });

  it("keeps Try again when the resend's dispatch failed", async () => {
    // The submit path appended the resend (with its link to the failure) and
    // an error row, and resolved: the prompt never went out.
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    const sent: ChatMessage[] = [];
    const submit = sendingSubmit({ dispatchFails: true, onSend: (localCopy) => sent.push(localCopy) });
    await render({ messages: [PROMPT, failed], submit });

    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(latest?.isRetrySuperseded?.(failed)).toBe(false);

    await render({ messages: [PROMPT, failed, ...sent, dispatchErrorRow()], submit });
    expect(latest?.isRetrySuperseded?.(failed)).toBe(false);
    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({
      message: "Build me a landing page",
      metadata: { retryOfMessageId: "failure-1" },
    });
  });

  it("does not read a resend whose dispatch failed as a retry after a remount", async () => {
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    const sent: ChatMessage[] = [];
    const submit = sendingSubmit({ dispatchFails: true, onSend: (localCopy) => sent.push(localCopy) });
    await render({ messages: [PROMPT, failed], submit });
    await act(async () => {
      await latest?.requestRetry(failed);
    });

    // Switching tabs remounts the panel; the local copy is still listed.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render({ messages: [PROMPT, failed, ...sent, dispatchErrorRow()], submit });
    expect(latest?.isRetrySuperseded?.(failed)).toBe(false);
  });

  it("makes the cards ask again once a resend's dispatch failed", async () => {
    // The cards memoize isRetrySuperseded's answer. The local copy shows up
    // while the dispatch is in flight; when it fails, the same error was
    // shown moments ago, so no new error row changes the message list.
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    let finishSubmit: (() => void) | null = null;
    const metadata = { retryOfMessageId: "failure-1", clientMessageId: "client-resend-1" };
    const localCopy = createMessage({
      id: "resend-1",
      role: "user",
      authorId: CURRENT_USER_ID,
      content: PROMPT.content,
      timestamp: Date.now(),
      metadata,
    });
    const submit = vi.fn<Submit>(
      () =>
        new Promise<boolean>((resolve) => {
          rememberPromptSentFromThisPage(localCopy);
          finishSubmit = () => {
            recordSendFailedForPromptSentFromThisPage({ metadata });
            resolve(true);
          };
        }),
    );
    await render({ messages: [PROMPT, failed], submit });
    await act(async () => {
      void latest?.requestRetry(failed);
    });
    await render({ messages: [PROMPT, failed, localCopy], submit });
    const whileInFlight = latest?.isRetrySuperseded;
    expect(whileInFlight?.(failed)).toBe(true);

    await act(async () => {
      finishSubmit?.();
    });
    expect(latest?.pendingRetryKey).toBeNull();
    expect(latest?.isRetrySuperseded).not.toBe(whileInFlight);
    expect(latest?.isRetrySuperseded?.(failed)).toBe(false);
  });

  it("does not also resend automatically a card retried by hand while the panel read busy", async () => {
    // The failure lands before the run update clears the typing state, so
    // the person's Try again goes into the busy agent's send queue and is not
    // in the message list. Then the panel reads idle.
    const queued = queueingSubmit();
    await render({ messages: [PROMPT], submit: queued, isAssistantTyping: true });
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    await render({ messages: [PROMPT, failed], submit: queued, isAssistantTyping: true });
    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(queued).toHaveBeenCalledTimes(1);

    const submit = sendingSubmit();
    await render({ messages: [PROMPT, failed], submit, isAssistantTyping: false });
    expect(submit).not.toHaveBeenCalled();
    expect(latest?.autoRetryingKey).toBeNull();
    expect(latest?.isRetrySuperseded?.(failed)).toBe(true);
  });

  it("does not resend automatically after a remount a card retried by hand whose queued copy has not loaded", async () => {
    const queued = queueingSubmit();
    await render({ messages: [PROMPT], submit: queued, isAssistantTyping: true });
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    await render({ messages: [PROMPT, failed], submit: queued, isAssistantTyping: true });
    await act(async () => {
      await latest?.requestRetry(failed);
    });

    // Switching tabs remounts the panel: its history loads after mount and
    // the send queue has not loaded yet.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    const submit = sendingSubmit();
    await render({ messages: [], submit, queuedSends: [] });
    await render({ messages: [PROMPT, failed], submit, queuedSends: [] });
    expect(submit).not.toHaveBeenCalled();
    expect(latest?.autoRetryingKey).toBeNull();
  });

  it("resends the prompt that started a steered run, not the steer", async () => {
    // The controller stores a steer with the steered run's id, after the
    // prompt that started the run.
    const client = { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID };
    const prompt = createMessage({
      id: "prompt-stored",
      role: "user",
      authorId: CURRENT_USER_ID,
      content: "Build the pricing page",
      timestamp: Date.now() - 60_000,
      metadata: { runId: "run-1", prompt_metadata: { clientMessageId: "cm-a", client } },
    });
    const steer = createMessage({
      id: "steer-1",
      role: "user",
      authorId: CURRENT_USER_ID,
      content: "Also make the header blue",
      timestamp: Date.now() - 30_000,
      metadata: {
        runId: "run-1",
        clientMessageId: "cm-steer",
        sendIntent: { mode: "steer", jobId: "job-1", state: "applied" },
      },
    });
    const failed = failure("failure-1", PROVIDER_RATE_LIMITED, 59_000, { runId: "run-1" });
    const submit = vi.fn<Submit>().mockResolvedValue(true);
    await render({ messages: [prompt, steer, failed], submit });

    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0].message).toBe("Build the pricing page");
  });

  it("says so instead of sending when the original prompt is gone", async () => {
    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    const submit = vi.fn().mockResolvedValue(true);
    const showStatus = vi.fn();
    await render({ messages: [failed], submit, showStatus });

    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith(
      "Couldn't find the original message to send again.",
      "info",
      4000,
    );
  });

  it("reads a retry stored before a reload", async () => {
    const failed = failure("failure-1", PROVIDER_RATE_LIMITED, 2);
    const resend = createMessage({
      id: "user-2",
      role: "user",
      content: "Build me a landing page",
      timestamp: 3,
      metadata: { retryOfMessageId: "failure-1" },
    });
    await render({ messages: [PROMPT, failed, resend], submit: vi.fn().mockResolvedValue(true) });

    expect(latest?.isRetrySuperseded?.(failed)).toBe(true);
  });

  it("reads a resend still waiting in a send queue after a reload", async () => {
    // The resend was queued behind a busy agent, then the page reloaded: the
    // message list does not have it yet, but both queues keep the metadata it
    // was queued with.
    const queuedMetadata = {
      retryOfMessageId: "failure-1",
      agentSelection: { active: ["octo"], mentions: [] },
    };
    const serverItem = mapServerSendQueueEntryToQueuedItem({
      id: "entry-1",
      conversationId: "controller-conversation-1",
      status: "queued",
      queuePosition: 1,
      targetAgentHandles: ["octo"],
      message: buildServerSendQueuePromptBody({
        message: "Build me a landing page",
        targetAgentHandles: ["octo"],
        metadata: queuedMetadata,
      }),
      errorMessage: null,
      createdAt: "2026-10-01T12:00:00.000Z",
      dispatchedAt: null,
    });
    writeChatSendQueue("retry-queue-test", [
      {
        id: "local-1",
        message: "Build me a landing page",
        editorState: null,
        createdAt: Date.now(),
        targetAgentHandles: ["octo"],
        browserPageTarget: null,
        browserLaunchMode: null,
        metadata: queuedMetadata,
      },
    ]);
    const localItems = readChatSendQueue("retry-queue-test");
    window.localStorage.removeItem("retry-queue-test");

    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    for (const queuedSends of [[serverItem!], localItems]) {
      const submit = vi.fn().mockResolvedValue(true);
      await render({ messages: [PROMPT, failed], queuedSends, submit });

      expect(latest?.isRetrySuperseded?.(failed)).toBe(true);
      await act(async () => {
        await latest?.requestRetry(failed);
      });
      expect(submit).not.toHaveBeenCalled();
    }
    // A queued send for something else does not count.
    await render({
      messages: [PROMPT, failed],
      queuedSends: [{ metadata: { agentSelection: { active: ["octo"], mentions: [] } } }],
      submit: vi.fn().mockResolvedValue(true),
    });
    expect(latest?.isRetrySuperseded?.(failed)).toBe(false);
  });

  it("links an automatic resend to its failure too", async () => {
    const submit = sendingSubmit();
    await render({ messages: [PROMPT], submit });

    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    await render({ messages: [PROMPT, failed], submit });

    // Sent as an automatic send, which leaves the composer and browser alone.
    expect(submit).toHaveBeenCalledWith(
      {
        message: "Build me a landing page",
        editorState: null,
        metadata: { retryOfMessageId: "failure-1" },
      },
      expect.objectContaining({ automatic: true }),
    );
    expect(latest?.autoRetryingKey).toBe("failure-1");
    expect(latest?.isRetrySuperseded?.(failed)).toBe(true);
  });

  it("keeps the automatic indicator when the automatic resend was queued", async () => {
    const submit = queueingSubmit();
    await render({ messages: [PROMPT], submit });

    const failed = failure("failure-1", MISSING_FINAL_MESSAGE, 2);
    await render({ messages: [PROMPT, failed], submit });

    expect(submit).toHaveBeenCalledTimes(1);
    // A copy waits in the queue: no manual Try again next to it.
    expect(latest?.autoRetryingKey).toBe("failure-1");
    expect(latest?.isRetrySuperseded?.(failed)).toBe(true);
  });

  it("exposes the rate limit countdown and its Cancel", async () => {
    const submit = vi.fn().mockResolvedValue(true);
    await render({ messages: [PROMPT], submit });

    const failed = failure("failure-1", PROVIDER_RATE_LIMITED, 2);
    await render({ messages: [PROMPT, failed], submit });
    expect(latest?.scheduledAutoRetry?.key).toBe("failure-1");

    await act(async () => {
      latest?.cancelAutoRetry?.("failure-1");
    });
    expect(latest?.scheduledAutoRetry).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  describe("with a countdown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    it("sends once under StrictMode, through re-renders and the resend's echo", async () => {
      let resolveSubmit: ((sent: boolean) => void) | null = null;
      const submit = vi.fn<Submit>(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSubmit = resolve;
          }),
      );
      const renderStrict = async (messages: ChatMessage[]) => {
        await act(async () => {
          root.render(
            <StrictMode>
              <Harness messages={messages} submit={submit} />
            </StrictMode>,
          );
        });
      };
      await renderStrict([PROMPT]);
      const failed = failure("failure-1", PROVIDER_RATE_LIMITED, 2);
      await renderStrict([PROMPT, failed]);
      await renderStrict([PROMPT, failed]);
      await advance(20_000);
      expect(submit).toHaveBeenCalledTimes(1);

      await renderStrict([PROMPT, failed]);
      await act(async () => {
        resolveSubmit?.(true);
      });
      const echoed = createMessage({
        id: "user-echo",
        role: "user",
        authorId: CURRENT_USER_ID,
        content: "Build me a landing page",
        timestamp: Date.now(),
        metadata: { prompt_metadata: { retryOfMessageId: "failure-1" } },
      });
      // The resend fails the same way: no second automatic send.
      await renderStrict([PROMPT, failed, echoed, failure("failure-2", PROVIDER_RATE_LIMITED, 30_000)]);
      await advance(60_000);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    for (const [kind, text] of [
      ["a rate limit", PROVIDER_RATE_LIMITED],
      ["a missing reply", MISSING_FINAL_MESSAGE],
    ] as const) {
      describe(`when ${kind} fails a run while a note was sent`, () => {
        // "Build the pricing page" started a run. While it ran, the person
        // wrote to a teammate in the shared chat; group participation kept
        // the agents silent, so the note was only recorded and started no
        // run. Then the pricing page's run failed.
        const PRICING_JOB_ID = "job-pricing";
        const PRICING_RUN_ID = "run-pricing";
        const client = { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID };
        const agentSelection = { active: ["octo"], mentions: [] };

        function sentHere(message: ChatMessage, runIds: string[]) {
          rememberPromptSentFromThisPage(message);
          recordRunsStartedByPromptSentFromThisPage(message, runIds);
          return message;
        }

        async function failWhileNoteWasSent(submit: Submit, { stored }: { stored: boolean }) {
          const localPricing = sentHere(
            createMessage({
              id: "p1",
              role: "user",
              authorId: CURRENT_USER_ID,
              content: "Build the pricing page",
              timestamp: Date.now() - 60_000,
              metadata: { client, clientMessageId: "cm-p1", agentSelection },
            }),
            [PRICING_RUN_ID, PRICING_JOB_ID],
          );
          // The controller's copy names the run the prompt started.
          const pricing = stored
            ? createMessage({
                ...localPricing,
                id: "p1-stored",
                metadata: {
                  runId: PRICING_RUN_ID,
                  prompt_metadata: { client, clientMessageId: "cm-p1", agentSelection },
                },
              })
            : localPricing;
          const note = sentHere(
            createMessage({
              id: "p2",
              role: "user",
              authorId: CURRENT_USER_ID,
              content: "Sam, the staging link is in the doc",
              timestamp: Date.now() - 30_000,
              metadata: {
                client,
                clientMessageId: "cm-p2",
                agentSelection,
                groupParticipation: { decision: "silent" },
                groupParticipationPreflight: { status: "resolved" },
              },
            }),
            [],
          );
          await render({ messages: [pricing], submit });
          await render({ messages: [pricing], submit, isAssistantTyping: true });
          await render({ messages: [pricing, note], submit, isAssistantTyping: true });
          const failed = failure("f1", text, 59_000, {
            jobId: PRICING_JOB_ID,
            runId: PRICING_RUN_ID,
          });
          await render({ messages: [pricing, note, failed], submit });
          await advance(25_000);
          return failed;
        }

        it("never resends the note in place of the prompt", async () => {
          const submit = sendingSubmit();
          // The pricing page's stored copy has not arrived, so the nearest
          // user message before the failure is the note, which started no run.
          const failed = await failWhileNoteWasSent(submit, { stored: false });

          expect(submit).not.toHaveBeenCalled();
          expect(latest?.scheduledAutoRetry).toBeNull();
          expect(latest?.autoRetryingKey).toBeNull();
          // Nothing was resent, so the card keeps its Try again.
          expect(latest?.isRetrySuperseded?.(failed)).toBe(false);
        });

        it("resends the prompt whose run failed", async () => {
          const submit = sendingSubmit();
          await failWhileNoteWasSent(submit, { stored: true });

          expect(submit).toHaveBeenCalledTimes(1);
          expect(submit).toHaveBeenCalledWith(
            {
              message: "Build the pricing page",
              editorState: null,
              metadata: { retryOfMessageId: "f1" },
            },
            expect.objectContaining({ automatic: true }),
          );
        });
      });

      it(`clears the automatic state when the resend of ${kind} started no run`, async () => {
        // Group participation only recorded the resend: no run will finish to
        // settle "Trying again automatically".
        const submit = sendingSubmit({ startsRun: false });
        await render({ messages: [PROMPT], submit });
        const failed = failure("failure-1", text, 2);
        await render({ messages: [PROMPT, failed], submit });
        await advance(25_000);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(latest?.autoRetryingKey).toBeNull();
        // The prompt was sent again, so the card reads Retried.
        expect(latest?.isRetrySuperseded?.(failed)).toBe(true);

        const resent = createMessage({
          id: "resend-1",
          role: "user",
          authorId: CURRENT_USER_ID,
          content: PROMPT.content,
          timestamp: Date.now(),
          metadata: { retryOfMessageId: "failure-1", groupParticipation: { decision: "silent" } },
        });
        await render({ messages: [PROMPT, failed, resent], submit });
        await advance(30 * 60_000);
        expect(latest?.autoRetryingKey).toBeNull();
        expect(submit).toHaveBeenCalledTimes(1);
      });

      it(`keeps Try again when the automatic resend of ${kind} failed to dispatch`, async () => {
        const submit = sendingSubmit({ dispatchFails: true });
        await render({ messages: [PROMPT], submit });
        const failed = failure("failure-1", text, 2);
        await render({ messages: [PROMPT, failed], submit });
        await advance(25_000);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(latest?.autoRetryingKey).toBeNull();
        // The prompt never went out, so the card offers Try again, not Retried.
        expect(latest?.isRetrySuperseded?.(failed)).toBe(false);
      });

      it(`never resends ${kind} where the cards cannot show it, such as the read-only run trace`, async () => {
        const submit = sendingSubmit();
        await render({ messages: [PROMPT], submit, autoRetryEnabled: false });
        const failed = failure("failure-1", text, 2);
        await render({ messages: [PROMPT, failed], submit, autoRetryEnabled: false });
        expect(latest?.scheduledAutoRetry).toBeNull();
        await advance(60_000);
        expect(submit).not.toHaveBeenCalled();
        expect(latest?.autoRetryingKey).toBeNull();
      });
    }

    it("drops a running countdown when the panel switches to the run trace", async () => {
      const submit = sendingSubmit();
      await render({ messages: [PROMPT], submit });
      const failed = failure("failure-1", PROVIDER_RATE_LIMITED, 2);
      await render({ messages: [PROMPT, failed], submit });
      expect(latest?.scheduledAutoRetry?.key).toBe("failure-1");

      // The same panel now shows the run trace, which has no countdown or Cancel.
      await render({ messages: [PROMPT, failed], submit, autoRetryEnabled: false });
      expect(latest?.scheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(submit).not.toHaveBeenCalled();

      // Back in the chat, the countdown does not start again; Try again stays.
      await render({ messages: [PROMPT, failed], submit });
      expect(latest?.scheduledAutoRetry).toBeNull();
      await advance(60_000);
      expect(submit).not.toHaveBeenCalled();
      await act(async () => {
        await latest?.requestRetry(failed);
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.[1]).toMatchObject({ automatic: false });
    });

    it("after Cancel, the manual Try again sends exactly once", async () => {
      const submit = vi.fn<Submit>().mockResolvedValue(true);
      await render({ messages: [PROMPT], submit });
      const failed = failure("failure-1", PROVIDER_RATE_LIMITED, 2);
      await render({ messages: [PROMPT, failed], submit });
      expect(latest?.scheduledAutoRetry?.key).toBe("failure-1");

      await act(async () => {
        latest?.cancelAutoRetry?.("failure-1");
      });
      await advance(60_000);
      expect(submit).not.toHaveBeenCalled();

      await act(async () => {
        await latest?.requestRetry(failed);
      });
      await act(async () => {
        await latest?.requestRetry(failed);
      });
      await advance(60_000);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.[1]).toMatchObject({ automatic: false });
    });
  });
});
