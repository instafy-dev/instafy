// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { AgentJobThreadPreviewLayout } from "../AgentJobThreadPreviewLayout";
import { RunFailureRetryProvider } from "../RunFailureNotice";
import { useAgentJobThreadPreviewState } from "../useAgentJobThreadPreviewState";
import { useRunFailureRetryActions } from "../useRunFailureRetryActions";

// docs/Local-Engine-Turns.md 5.7: a Claude Code turn's row reads "Starting
// Claude Code on this computer…" until its first step arrives, on its
// sender's page. The sender's page knows it from the run's controller stamp;
// a teammate's page has no metadata for another person's run while it runs,
// and knows it from the stamped prompt. The turn starts on its sender's
// computer, so a teammate reads that computer's owner, by name.

const JOB_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CONTROLLER_ID = "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5";
const STARTING = "Starting Claude Code on this computer…";
const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
const SAM = "user-sam";
const ALEX = "user-alex";
const NAMES: ReadonlyMap<string, string> = new Map([
  [SAM, "Sam"],
  [ALEX, "Alex"],
]);

const live = vi.hoisted(() => ({
  runMetadata: null as Record<string, unknown> | null,
  conversationMessages: [] as ChatMessage[],
  viewerId: "user-sam",
}));

function inProgressRun(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: JOB_ID,
    projectId: "project-1",
    sessionId: null,
    conversationId: CONTROLLER_ID,
    promptId: null,
    runType: "prompt",
    status: "in_progress",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: live.runMetadata,
    createdAt: now,
    updatedAt: now,
  };
}

vi.mock("../../../../conversations/ConversationsProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../conversations/ConversationsProvider")>()),
  useConversations: () => ({
    activeConversation: {
      localId: "conversation-local",
      controllerId: CONTROLLER_ID,
      pendingRunIds: [JOB_ID],
      awaitingLeaseRunIds: [],
      pendingRunSubmittedAt: {},
      messages: live.conversationMessages,
    },
    conversations: [],
  }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ runs: { [JOB_ID]: inProgressRun() } }),
}));

function MessageContent({ content }: { content: string }) {
  return <div data-testid="message-content">{content}</div>;
}

function Row({ threadMessages }: { threadMessages: ChatMessage[] }) {
  const message: ChatMessage = {
    id: `agent-job-thread:${JOB_ID}`,
    role: "assistant",
    content: "",
    timestamp: threadMessages[0]?.timestamp ?? 0,
    messageType: "agent_job_thread",
    metadata: { messageType: "agent_job_thread", jobId: JOB_ID, threadMessages },
  };
  const state = useAgentJobThreadPreviewState({ message, projectId: "project-1" });
  return state ? (
    <AgentJobThreadPreviewLayout
      {...state}
      branchThreads={[]}
      onOpenBranchThread={() => {}}
      MessageContent={MessageContent}
      ChatFileChangeList={() => null}
    />
  ) : null;
}

/** The row in its chat, which tells who sent a turn as ChatPanel does (useRunFailureRetryActions). */
function Turn({ threadMessages }: { threadMessages: ChatMessage[] }) {
  const retry = useRunFailureRetryActions({
    messages: live.conversationMessages,
    conversationKey: "conversation-local",
    currentUserId: live.viewerId,
    chatClientSessionId: "session-1",
    isAssistantTyping: true,
    autoRetryEnabled: false,
    submit: async () => false,
    showStatus: () => {},
    humanLabelByUserId: NAMES,
  });
  return (
    <RunFailureRetryProvider value={retry}>
      <Row threadMessages={threadMessages} />
    </RunFailureRetryProvider>
  );
}

function prompt(metadata: Record<string, unknown>, at: number): ChatMessage {
  return {
    id: "prompt-1",
    role: "user",
    authorId: SAM,
    content: "@octo fix the failing login test",
    timestamp: at,
    files: null,
    metadata,
  };
}

function update(id: string, messageType: string, content: string, at: number, details: Record<string, unknown> = {}): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content,
    timestamp: at,
    files: null,
    messageType,
    metadata: { source: "agent", outcome: "in_progress", kind: "update", jobId: JOB_ID, messageType, details },
  };
}

describe("a turn row before its first step", () => {
  let container: HTMLDivElement;
  let root: Root;
  let base: number;

  async function render(promptMetadata: Record<string, unknown>, threadMessages: ChatMessage[]) {
    live.conversationMessages = [prompt(promptMetadata, base - 1_000), ...threadMessages];
    await act(async () => {
      root.render(<Turn threadMessages={threadMessages} />);
    });
  }

  const activityLine = () => container.querySelector<HTMLElement>('[data-testid="turn-activity-line"]')?.textContent;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    base = Date.now() - 5_000;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    live.runMetadata = null;
    live.conversationMessages = [];
    live.viewerId = SAM;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const firstNote = () => [update("status-1", "status", "Connecting", base)];

  it("reads the engine's words on the sender's page, from the run's stamp", async () => {
    live.viewerId = SAM;
    live.runMetadata = { jobId: JOB_ID, ...STAMP };
    // The sender's own copy of the message, before the controller's arrives.
    await render({ turnEngine: "claude-code" }, firstNote());
    expect(activityLine()).toBe(STARTING);
    // And from the controller's copy, after a reload.
    await render({ ...STAMP, runId: JOB_ID }, firstNote());
    expect(activityLine()).toBe(STARTING);
  });

  it("reads them on a teammate's page, from the stamped prompt, naming the sender's computer", async () => {
    // A teammate's page has no metadata for another person's run.
    live.viewerId = ALEX;
    live.runMetadata = null;
    await render({ ...STAMP, runId: JOB_ID }, firstNote());
    expect(activityLine()).toBe("Starting Claude Code on Sam's computer…");
  });

  it("names no computer where the chat can't tell who sent the turn", async () => {
    // The read-only run trace has no RunFailureRetryProvider.
    live.runMetadata = { jobId: JOB_ID, ...STAMP };
    live.conversationMessages = [prompt({ ...STAMP, runId: JOB_ID }, base - 1_000), ...firstNote()];
    await act(async () => {
      root.render(<Row threadMessages={firstNote()} />);
    });
    expect(activityLine()).toBe("Starting Claude Code…");
  });

  it("reads Starting… for any other turn", async () => {
    live.runMetadata = { jobId: JOB_ID, aiAccessMode: "managed" };
    await render({ ...STAMP, runId: JOB_ID }, firstNote());
    expect(activityLine()).toBe("Starting…");

    live.runMetadata = null;
    // A mode a client could record on a prompt never counts.
    await render({ aiAccessMode: "claude-code" }, firstNote());
    expect(activityLine()).toBe("Starting…");
  });

  it("follows the steps from the first one on", async () => {
    live.runMetadata = { jobId: JOB_ID, ...STAMP };
    await render({ turnEngine: "claude-code" }, [
      ...firstNote(),
      update("command-1", "command_execution", "ls", base + 1_000, { status: "completed", command: "ls" }),
    ]);
    expect(activityLine()).not.toBe(STARTING);
  });
});
