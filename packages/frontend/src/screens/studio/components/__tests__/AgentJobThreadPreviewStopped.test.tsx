// @vitest-environment jsdom
// Live test, Oct 27: after Take over stopped a run ("Run stopped."), the run's
// thread read "Status unavailable", as if Studio had lost track of it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapControllerMessageToChat } from "../../../../conversations/conversationMessageUtils";
import type { ChatMessage } from "../../types";
import { AgentJobThreadPreviewLayout, type ChatFileChangeListProps } from "../AgentJobThreadPreviewLayout";
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

function fileChangeUpdate(id: string, paths: string[], ageMs: number): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content: `Applied file changes: ${paths.join(", ")}`,
    timestamp: Date.now() - ageMs,
    files: null,
    messageType: "file_change",
    metadata: {
      jobId: JOB_ID,
      source: "agent",
      kind: "update",
      outcome: "in_progress",
      messageType: "file_change",
      details: { kind: "codex_file_change", itemId: `item-${id}`, status: "completed", paths },
    },
  };
}

function threadCard(extra: ChatMessage[] = []): ChatMessage {
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
      threadMessages: [...threadMessages(), ...extra],
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

/** What the turn's file list was given, the last time it rendered. */
let fileList: ChatFileChangeListProps | null = null;

function Thread({ message }: { message: ChatMessage }) {
  const state = useAgentJobThreadPreviewState({ message, projectId: "project-1" });
  if (!state) return null;
  return (
    <AgentJobThreadPreviewLayout
      {...state}
      branchThreads={[]}
      onOpenBranchThread={() => {}}
      MessageContent={({ content }: { content: string }) => <span>{content}</span>}
      ChatFileChangeList={(props: ChatFileChangeListProps) => {
        fileList = props;
        return null;
      }}
    />
  );
}

const EDIT_LABEL = {
  v: 1,
  key: "builtin/edit",
  role: "content",
  live: "Editing files",
  done: { one: "edited a file", other: "edited {n} files", some: "edited files" },
};

/**
 * A file-change step as the controller stores it (`build_agent_update_metadata`,
 * its label lifted out of its details) and Studio maps it: one the runtime
 * streamed while the turn ran, or the stopped turn's end report, which carries
 * the turn's files and keeps the step that names them out of progress.
 */
function editStep(
  id: string,
  itemId: string,
  paths: string[],
  ageMs: number,
  report?: { artifacts: unknown[] },
): ChatMessage {
  return mapControllerMessageToChat({
    id,
    conversationId: "conversation-1",
    projectId: "project-1",
    sessionId: null,
    promptId: null,
    runId: RUN_ID,
    role: "assistant",
    content: `Applied file changes: ${paths.join(", ")}`,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    metadata: {
      source: "agent",
      kind: "update",
      outcome: report ? "canceled" : "in_progress",
      jobId: JOB_ID,
      messageType: "file_change",
      details: { kind: "codex_file_change", itemId, eventType: "item.completed", status: "completed", paths },
      activity: { ...EDIT_LABEL, count: paths.length },
      ...(report ? { artifacts: report.artifacts } : {}),
    },
  });
}

const PAGE = "/workspace/project-1/sites/porto/app.js";

function filesArtifact(stoppedBeforeSave: boolean) {
  return {
    kind: "apply/files",
    files: [{ path: "sites/porto/app.js", workspacePath: "sites/porto/app.js", changeType: "changed", source: "workspace" }],
    metadata: { provider: "codex-embedded", ...(stoppedBeforeSave ? { stoppedBeforeSave: true } : {}) },
  };
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
    fileList = null;
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

  // A stopped turn has no reply. With nothing else to show, its body fell back
  // to the newest update that was not a command, a file change's raw
  // "Applied file changes: <paths>".
  it("never shows a file change's raw text as the body of a turn without a reply", async () => {
    const card = threadCard([fileChangeUpdate("00000000-0000-4000-8000-000000000003", ["/workspace/src/secret-plan.ts"], 90_000)]);
    live.activeConversation = { messages: [card, stopNotice()] };
    await act(async () => root.render(<Thread message={card} />));
    expect(container.querySelector('[data-testid="turn-activity-line"]')?.textContent).toBe(
      "Stopped · ran 2 commands, edited a file",
    );
    expect(container.textContent).not.toContain("Applied file changes");
    expect(container.textContent).not.toContain("secret-plan.ts");
  });

  // A local test: "keep going" answered, the runtime asked again for a
  // look it wanted, and the person stopped the retry. The answer the retry
  // replaced stayed in Details as a step of its own.
  it("lists no answer a retry replaced, though the retry never answered", async () => {
    const firstAnswer = "The page is still open. If you want, I can check the hours again.";
    const status = (id: string, content: string, ageMs: number, details: Record<string, unknown>): ChatMessage => ({
      id,
      role: "assistant",
      authorId: null,
      content,
      timestamp: Date.now() - ageMs,
      files: null,
      messageType: "status",
      metadata: { jobId: JOB_ID, source: "agent", kind: "update", outcome: "in_progress", messageType: "status", details },
    });
    const card = threadCard([
      status("00000000-0000-4000-8000-000000000004", firstAnswer, 100_000, {
        kind: "agent_message",
        event: { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: firstAnswer, phase: "final_answer" } },
      }),
      status("00000000-0000-4000-8000-000000000005", "Retrying: accepted execution evidence is still missing.", 99_000, {
        kind: "codex_retry",
        reason: "missing_command_observation",
        attempt: 2,
      }),
      commandUpdate("00000000-0000-4000-8000-000000000006", "instafy web read https://shop.example", 90_000),
    ]);
    live.activeConversation = { messages: [card, stopNotice()] };
    await act(async () => root.render(<Thread message={card} />));
    const line = container.querySelector<HTMLElement>('[data-testid="turn-activity-line"]');
    expect(line?.textContent).toBe("Stopped · ran 3 commands");
    await act(async () => line?.click());
    expect(container.querySelector('[data-testid="turn-activity-details"]')).not.toBeNull();
    expect(container.textContent).not.toContain(firstAnswer);
  });

  // Live test, Nov 2: a Stop let an edit the model sent after the press land.
  // Its own step was refused, so the stopped turn's end report is the only
  // record of it: its line names the edit, and its files show with Review
  // changes and Undo, Not saved, since the turn never saved them.
  it("names an edit only its end report records, with its files, not saved", async () => {
    const report = editStep("00000000-0000-4000-8000-000000000004", "stopped-turn-files", [PAGE], 30_000, {
      artifacts: [filesArtifact(true)],
    });
    const card = threadCard([report]);
    live.activeConversation = { messages: [card, stopNotice()] };
    await act(async () => root.render(<Thread message={card} />));
    expect(container.querySelector('[data-testid="turn-activity-line"]')?.textContent).toBe(
      "Stopped · edited a file",
    );
    expect(fileList?.files.map((file) => file.workspacePath)).toEqual(["sites/porto/app.js"]);
    expect(fileList?.unsavedReason).toBe("stopped_before_save");
    expect(fileList?.messageId).toBe(report.id);
  });

  // The usual Stop: the edit's own step was recorded before the press. The
  // report restates that step with the turn's files, so the line still counts
  // one file and Details keeps one row for the edit.
  it("counts an edit its own step already showed once, and shows its files", async () => {
    const streamed = editStep("00000000-0000-4000-8000-000000000003", "call_edit", [PAGE], 90_000);
    const report = editStep("00000000-0000-4000-8000-000000000004", "call_edit", [PAGE], 30_000, {
      artifacts: [filesArtifact(true)],
    });
    const card = threadCard([streamed, report]);
    live.activeConversation = { messages: [card, stopNotice()] };
    await act(async () => root.render(<Thread message={card} />));
    const line = container.querySelector('[data-testid="turn-activity-line"]');
    expect(line?.textContent).toBe("Stopped · edited a file");
    await act(async () => (line as HTMLElement).click());
    expect(container.querySelectorAll('[data-testid="turn-activity-edit"]')).toHaveLength(1);
    expect(fileList?.files.map((file) => file.workspacePath)).toEqual(["sites/porto/app.js"]);
    expect(fileList?.messageId).toBe(report.id);
  });

  // A Stop that came while the turn saved: the report carries the turn's own
  // save, so its files read as that save left them, with its versions.
  it("shows the save a turn stopped while saving made", async () => {
    const streamed = editStep("00000000-0000-4000-8000-000000000003", "call_edit", [PAGE], 90_000);
    const report = editStep("00000000-0000-4000-8000-000000000004", "call_edit", [PAGE], 30_000, {
      artifacts: [
        filesArtifact(false),
        { kind: "origin/apply", metadata: { gitSyncStatus: "synced", gitRev: "abc1234", gitBaseRev: "def5678" } },
      ],
    });
    const card = threadCard([streamed, report]);
    live.activeConversation = { messages: [card, stopNotice()] };
    await act(async () => root.render(<Thread message={card} />));
    expect(fileList?.unsavedReason).toBeNull();
    expect(fileList?.commitRange).toMatchObject({ base: "def5678", head: "abc1234" });
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

  // A local test, Nov 5: the person pressed Stop as the line went to "Thinking…", and the line
  // said "Stopped" 1.4 s later: a running label holds before the next one, and the done line
  // waited out the hold. A Stop's line comes at once.
  it("says Stopped as soon as the turn is stopped, not after the running line's hold", async () => {
    const run = (status: string) => ({
      [RUN_ID]: {
        id: RUN_ID, projectId: "project-1", sessionId: null, conversationId: null, promptId: null, runType: "prompt",
        status, progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
        metadata: { jobId: JOB_ID }, createdAt: null, updatedAt: null,
      },
    });
    const card: ChatMessage = {
      ...threadCard(),
      metadata: {
        messageType: "agent_job_thread",
        jobId: JOB_ID,
        agent: { handle: "octo" },
        threadMessages: [commandUpdate("00000000-0000-4000-8000-000000000007", "sed -n '1,220p' sites/porto/app.js", 3_000)],
      },
    };
    live.runs = run("in_progress");
    await act(async () => root.render(<Thread message={card} />));
    const line = () => container.querySelector('[data-testid="turn-activity-line"]')?.textContent;
    expect(line()).toBe("Thinking…");
    live.runs = run("canceled");
    await act(async () => root.render(<Thread message={{ ...card }} />));
    expect(line()).toBe("Stopped · ran a command");
  });
});
