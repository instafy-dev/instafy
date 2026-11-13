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
import type { ChatSubmitOverride } from "../chatSubmitPlanning";
import type { RunFailureRetryContextValue } from "../RunFailureNotice";
import { useRunFailureRetryActions, type RunFailureResendOptions } from "../useRunFailureRetryActions";

const CURRENT_USER_ID = "user-1";
const TEAMMATE_ID = "user-2";
const CHAT_CLIENT_SESSION_ID = "session-1";
// Text the runtime engine's own patterns would resend automatically.
const MISSING_FINAL_MESSAGE = "Codex completed without returning a final assistant message after retry.";

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

// The sender's own copy of a send that claimed Claude Code (5.2).
const LANE_PROMPT = createMessage({
  id: "prompt-lane",
  role: "user",
  authorId: CURRENT_USER_ID,
  content: "Fix the failing login test",
  timestamp: 1,
  metadata: {
    turnEngine: "claude-code",
    clientMessageId: "client-lane",
    client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID },
  },
});

// A teammate's prompt as the controller stored and stamped it.
const TEAMMATE_PROMPT = createMessage({
  id: "prompt-teammate",
  role: "user",
  authorId: TEAMMATE_ID,
  content: "Tidy the README",
  timestamp: 1,
  metadata: {
    aiAccessMode: "claude-code",
    claudeCode: { version: 1 },
    prompt_metadata: { aiAccessMode: "claude-code", claudeCode: { version: 1 } },
  },
});

function laneFailure(id: string, content: string, offset: number): ChatMessage {
  return createMessage({
    id,
    content,
    timestamp: Date.now() - 60_000 + offset,
    messageType: "error",
    metadata: {
      source: "agent",
      outcome: "failed",
      messageType: "error",
      jobId: "job-lane",
      aiAccessMode: "claude-code",
      claudeCode: { version: 1 },
      claudeCodeFailure: "crashed",
    },
  });
}

type Submit = (override: ChatSubmitOverride, options?: RunFailureResendOptions) => Promise<boolean>;
type HarnessProps = {
  messages: ChatMessage[];
  submit: Submit;
  refillComposerWithTurnEngine?: (input: { text: string; turnEngine: string }) => void;
  humanLabelByUserId?: ReadonlyMap<string, string>;
};

let latest: RunFailureRetryContextValue | null = null;

function Harness({ messages, submit, refillComposerWithTurnEngine, humanLabelByUserId }: HarnessProps) {
  latest = useRunFailureRetryActions({
    messages,
    conversationKey: "conv-1",
    currentUserId: CURRENT_USER_ID,
    chatClientSessionId: CHAT_CLIENT_SESSION_ID,
    isAssistantTyping: false,
    submit,
    showStatus: vi.fn(),
    refillComposerWithTurnEngine,
    humanLabelByUserId,
  });
  return null;
}

describe("useRunFailureRetryActions for a turn-engine turn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetPromptsSentFromThisPageForTests();
    // Sent from this page, which started the failed job: the one case an
    // ordinary failure would be resent automatically.
    rememberPromptSentFromThisPage(LANE_PROMPT);
    recordRunsStartedByPromptSentFromThisPage(LANE_PROMPT, ["job-lane"]);
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

  it("never sends it again automatically", async () => {
    const submit = vi.fn<Submit>(async () => true);
    await render({ messages: [LANE_PROMPT], submit });
    const failed = laneFailure("failure-lane", MISSING_FINAL_MESSAGE, 2);
    await render({ messages: [LANE_PROMPT, failed], submit });
    expect(submit).not.toHaveBeenCalled();
    expect(latest?.autoRetryingKey).toBeNull();
    expect(latest?.scheduledAutoRetry ?? null).toBeNull();
  });

  it("still sends an ordinary turn's dropped reply again automatically, as before", async () => {
    // The same page and prompt shape without the claim: the control for the case above.
    const ordinary = createMessage({
      ...LANE_PROMPT,
      id: "prompt-ordinary",
      metadata: { clientMessageId: "client-ordinary", client: { sessionId: CHAT_CLIENT_SESSION_ID, userId: CURRENT_USER_ID } },
    });
    rememberPromptSentFromThisPage(ordinary);
    recordRunsStartedByPromptSentFromThisPage(ordinary, ["job-ordinary"]);
    const submit = vi.fn<Submit>(async () => true);
    await render({ messages: [ordinary], submit });
    const failed = createMessage({
      id: "failure-ordinary",
      content: MISSING_FINAL_MESSAGE,
      timestamp: Date.now() - 60_000 + 2,
      messageType: "error",
      metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: "job-ordinary" },
    });
    await render({ messages: [ordinary, failed], submit });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("never sends it again from its card", async () => {
    const submit = vi.fn<Submit>(async () => true);
    const failed = laneFailure("failure-lane", "claude exited with code 1", 2);
    await render({ messages: [LANE_PROMPT, failed], submit });
    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).not.toHaveBeenCalled();
    expect(latest?.pendingRetryKey).toBeNull();
  });

  it("tells who sent the turn: the viewer, or a teammate by the name the chat shows", async () => {
    const mine = laneFailure("failure-mine", "claude exited", 2);
    await render({ messages: [LANE_PROMPT, mine], submit: vi.fn<Submit>() });
    expect(latest?.turnEngineOwnerOf?.(mine)).toEqual({ isViewer: true, name: null });

    const theirs = laneFailure("failure-theirs", "claude exited", 2);
    await render({
      messages: [TEAMMATE_PROMPT, theirs],
      submit: vi.fn<Submit>(),
      humanLabelByUserId: new Map([[TEAMMATE_ID, "Sam"]]),
    });
    expect(latest?.turnEngineOwnerOf?.(theirs)).toEqual({ isViewer: false, name: "Sam" });

    // The prompt before the failure is no turn-engine prompt: nobody is named.
    const ordinary = createMessage({ ...LANE_PROMPT, id: "prompt-ordinary", metadata: null });
    await render({ messages: [ordinary, theirs], submit: vi.fn<Submit>() });
    expect(latest?.turnEngineOwnerOf?.(theirs)).toBeNull();
  });

  it("puts its sender's message back in the composer with the engine chosen, and nobody else's", async () => {
    const submit = vi.fn<Submit>(async () => true);
    const failed = laneFailure("failure-lane", "claude exited", 2);
    await render({ messages: [LANE_PROMPT, failed], submit });
    // Without a composer to fill, there is nothing to offer.
    expect(latest?.resendWithTurnEngine).toBeUndefined();

    const refill = vi.fn();
    await render({ messages: [LANE_PROMPT, failed], submit, refillComposerWithTurnEngine: refill });
    act(() => {
      latest?.resendWithTurnEngine?.(failed);
    });
    expect(refill).toHaveBeenCalledExactlyOnceWith({ text: "Fix the failing login test", turnEngine: "claude-code" });

    refill.mockClear();
    const theirs = laneFailure("failure-theirs", "claude exited", 2);
    await render({ messages: [TEAMMATE_PROMPT, theirs], submit, refillComposerWithTurnEngine: refill });
    act(() => {
      latest?.resendWithTurnEngine?.(theirs);
    });
    expect(refill).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
