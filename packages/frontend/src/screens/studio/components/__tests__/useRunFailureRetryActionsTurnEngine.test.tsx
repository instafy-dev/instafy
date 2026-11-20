// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Registers the application's turn engines, as the application does when it
// builds its feature composition at startup (features/turnEngineRegistry.ts).
import "../../../../features/applicationFrontendFeatureComposition";
import {
  forgetPromptsSentFromThisPageForTests,
  recordRunsStartedByPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { RunRecord } from "../../../../types";
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

// The person's own message to an agent whose AI is Claude Code, as the
// controller stored and stamped it (docs/Local-Engine-Turns.md 2.1, 11.3).
const LANE_PROMPT = createMessage({
  id: "prompt-lane",
  role: "user",
  authorId: CURRENT_USER_ID,
  content: "Fix the failing login test",
  timestamp: 1,
  metadata: {
    aiAccessMode: "claude-code",
    claudeCode: { version: 1 },
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

function laneFailure(id: string, content: string, offset: number, runId?: string): ChatMessage {
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
      ...(runId ? { runId } : {}),
      aiAccessMode: "claude-code",
      claudeCode: { version: 1 },
      claudeCodeFailure: "crashed",
    },
  });
}

/** A run as the controller serves it: its job's person is its `initiatingUserId`. */
function laneRun(id: string, initiatingUserId: string): RunRecord {
  return {
    id,
    projectId: null,
    sessionId: null,
    conversationId: "conv-1",
    promptId: null,
    runType: "prompt",
    status: "failed",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: { aiAccessMode: "claude-code", claudeCode: { version: 1 }, initiatingUserId },
    createdAt: null,
    updatedAt: null,
  } as RunRecord;
}

type Submit = (override: ChatSubmitOverride, options?: RunFailureResendOptions) => Promise<boolean>;
type HarnessProps = {
  messages: ChatMessage[];
  submit: Submit;
  humanLabelByUserId?: ReadonlyMap<string, string>;
  runs?: Record<string, RunRecord>;
};

let latest: RunFailureRetryContextValue | null = null;

function Harness({ messages, submit, humanLabelByUserId, runs }: HarnessProps) {
  latest = useRunFailureRetryActions({
    messages,
    conversationKey: "conv-1",
    currentUserId: CURRENT_USER_ID,
    chatClientSessionId: CHAT_CLIENT_SESSION_ID,
    isAssistantTyping: false,
    submit,
    showStatus: vi.fn(),
    humanLabelByUserId,
    runs,
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

  // docs/Local-Engine-Turns.md 11.14: none of a lane failure's codes clears
  // by itself within seconds, so Studio's automatic resend passes it over.
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
    // The same page and prompt shape without the stamp: the control for the case above.
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

  // 11.14: Try again sends the prompt again as for any failure, to the same
  // agent and so to Claude Code again, and names the failure it retries.
  it("sends it again from its card, as any failure", async () => {
    const submit = vi.fn<Submit>(async () => true);
    const failed = laneFailure("failure-lane", "claude exited with code 1", 2);
    await render({ messages: [LANE_PROMPT, failed], submit });
    await act(async () => {
      await latest?.requestRetry(failed);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const [override, options] = submit.mock.calls[0] ?? [];
    expect(override).toMatchObject({ message: "Fix the failing login test", editorState: null });
    expect(override?.metadata).toMatchObject({ retryOfMessageId: "failure-lane" });
    expect(override?.metadata).not.toHaveProperty("turnEngine");
    expect(options).toMatchObject({ automatic: false });
  });

  it("tells whose turn it was: the person its run names, else its prompt's author", async () => {
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

    // An automation's turn: no person wrote its prompt, but its run names its person.
    const automated = laneFailure("failure-automation", "claude exited", 2, "run-automation");
    const automationPrompt = createMessage({ ...TEAMMATE_PROMPT, id: "prompt-automation", authorId: null });
    await render({
      messages: [automationPrompt, automated],
      submit: vi.fn<Submit>(),
      runs: { "run-automation": laneRun("run-automation", CURRENT_USER_ID) },
    });
    expect(latest?.turnEngineOwnerOf?.(automated)).toEqual({ isViewer: true, name: null });
    await render({ messages: [automationPrompt, automated], submit: vi.fn<Submit>() });
    expect(latest?.turnEngineOwnerOf?.(automated)).toBeNull();
  });
});
