// @vitest-environment jsdom
// Live test, Oct 27: after Take over stopped a run ("Run stopped."), the run's
// thread read "Status unavailable", as if Studio had lost track of it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { AgentJobThreadPreviewLayout } from "../AgentJobThreadPreviewLayout";
import { useAgentJobThreadPreviewState } from "../useAgentJobThreadPreviewState";

const JOB_ID = "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10";
const RUN_ID = "7a1f0b52-3c5e-4f7a-9d4b-2e6c8a0b1c3d";

const live = vi.hoisted(() => ({
  activeConversation: null as { messages: unknown[] } | null,
  runs: {} as Record<string, unknown>,
}));
vi.mock("../../../../conversations/ConversationsProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../conversations/ConversationsProvider")>()),
  useConversations: () => ({ activeConversation: live.activeConversation, conversations: [] }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => ({ runs: live.runs }) }));

function commandUpdate(id: string, command: string, ageMs: number): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content: command,
    timestamp: Date.now() - ageMs,
    files: null,
    messageType: "command_execution",
    metadata: {
      jobId: JOB_ID,
      source: "agent",
      kind: "update",
      outcome: "in_progress",
      messageType: "command_execution",
      details: { command, status: "completed", aggregatedOutput: "ok" },
    },
  };
}

// The run's updates stopped coming more than the 45 s a live run is given ago.
function threadMessages(): ChatMessage[] {
  return [
    commandUpdate("00000000-0000-4000-8000-000000000001", "instafy browser tabs", 150_000),
    commandUpdate("00000000-0000-4000-8000-000000000002", "instafy browser navigate https://www.carris.pt", 120_000),
  ];
}

function threadCard(): ChatMessage {
  return {
    id: "agent-job-thread",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: Date.now() - 180_000,
    files: null,
    messageType: "agent_job_thread",
    metadata: {
      messageType: "agent_job_thread",
      jobId: JOB_ID,
      agent: { handle: "octo" },
      threadMessages: threadMessages(),
    },
  };
}

/** The controller's notice when a person stops a run (conversations.rs build_interruption_notice). */
function stopNotice(): ChatMessage {
  return {
    id: "stop-notice",
    role: "assistant",
    authorId: null,
    content: "Run stopped.",
    timestamp: Date.now() - 60_000,
    files: null,
    messageType: "run_cancellation",
    metadata: {
      source: "controller",
      kind: "run_cancellation",
      details: { reason: "Stopped by the person.", jobIds: [JOB_ID], runIds: [RUN_ID], runStatus: "canceled" },
    },
  };
}

function Thread({ message }: { message: ChatMessage }) {
  const state = useAgentJobThreadPreviewState({ message, projectId: "project-1" });
  if (!state) return null;
  return (
    <AgentJobThreadPreviewLayout
      {...state}
      branchThreads={[]}
      onOpenBranchThread={() => {}}
      MessageContent={({ content }: { content: string }) => <span>{content}</span>}
      ChatFileChangeList={() => null}
    />
  );
}

describe("a run a person stopped", () => {
  let root: Root;
  let container: HTMLDivElement;
  let clientWidth: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    live.activeConversation = null;
    live.runs = {};
    // A phone-width row uses the compact rail, where a stuck thread prints its status.
    clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clientWidth.mockRestore();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("still reads Status unavailable when nothing says what happened to it", async () => {
    await act(async () => root.render(<Thread message={threadCard()} />));
    expect(container.textContent).toContain("Status unavailable");
  });

  it("reads Stopped, not Status unavailable, when the conversation's stop notice names its job", async () => {
    live.activeConversation = { messages: [threadCard(), stopNotice()] };
    await act(async () => root.render(<Thread message={threadCard()} />));
    expect(container.textContent).not.toContain("Status unavailable");
    expect(container.textContent).toContain("Stopped");
  });

  it("reads Stopped, not Status unavailable, when its run record says it was canceled", async () => {
    live.runs = {
      [RUN_ID]: {
        id: RUN_ID, projectId: "project-1", sessionId: null, conversationId: null, promptId: null, runType: "prompt",
        status: "canceled", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
        metadata: { jobId: JOB_ID }, createdAt: null, updatedAt: null,
      },
    };
    await act(async () => root.render(<Thread message={threadCard()} />));
    expect(container.textContent).not.toContain("Status unavailable");
    expect(container.textContent).toContain("Stopped");
  });
});
