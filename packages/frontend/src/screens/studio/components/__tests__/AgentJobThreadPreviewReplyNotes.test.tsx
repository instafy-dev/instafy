// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { AgentJobThreadPreviewLayout } from "../AgentJobThreadPreviewLayout";
import { isTurnReplyNote } from "../chatMessageMetadata";
import {
  collapseLifecycleMessages,
  shouldDisplayChatMessage,
  synthesizeAgentJobThreadMessages,
} from "../chatMessagePresentation";
import { useAgentJobThreadPreviewState } from "../useAgentJobThreadPreviewState";

// A runtime places a note of the turn under its reply with
// `presentation.placement: "reply_note"` (docs/Local-Engine-Turns.md 3.7, 5.7):
// changes that stayed on the computer and weren't saved, steps that needed
// someone's OK. The controller stores a runtime step's metadata under
// `details`. Such a note shows under the reply once the turn is done, with
// Details closed, and is neither in Details nor a note the line counts.

const JOB_ID = "4b6f0a1c-2d3e-4f50-8a1b-2c3d4e5f6a7b";
const RUNTIME_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
const NOT_SAVED = "Claude Code's changes stayed on this computer and weren't saved to the space.";
const DENIALS =
  "Claude Code skipped 2 steps that need your OK, since nobody can give it here. You can allow them in your own Claude Code settings.";

vi.mock("../../../../conversations/ConversationsProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../conversations/ConversationsProvider")>()),
  useConversations: () => ({ activeConversation: null, conversations: [] }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ runs: {} }),
}));

function MessageContent({ content }: { content: string }) {
  return <div data-testid="message-content">{content}</div>;
}

/** A turn's row, as the chat built it. */
function Row({ message }: { message: ChatMessage }) {
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

function Turn({ threadMessages }: { threadMessages: ChatMessage[] }) {
  const message: ChatMessage = {
    id: `agent-job-thread:${JOB_ID}`,
    role: "assistant",
    content: "",
    timestamp: threadMessages[0]?.timestamp ?? 0,
    messageType: "agent_job_thread",
    metadata: { messageType: "agent_job_thread", jobId: JOB_ID, agent: { handle: "octo" }, threadMessages },
  };
  return <Row message={message} />;
}

/** The chat's rows from its messages, as ChatPanel builds them. */
function chatRows(messages: ChatMessage[]): ChatMessage[] {
  const collapsed = collapseLifecycleMessages(messages);
  return synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage));
}

/** A status step of the runtime's, as the controller stores it. */
function status(id: string, content: string, at: number, details: Record<string, unknown>): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content,
    timestamp: at,
    files: null,
    messageType: "status",
    metadata: {
      source: "agent",
      outcome: "in_progress",
      kind: "update",
      jobId: JOB_ID,
      messageType: "status",
      details: { ...details, runtimeId: RUNTIME_ID, runtime_id: RUNTIME_ID },
    },
  };
}

function replyNote(id: string, content: string, at: number, details: Record<string, unknown>): ChatMessage {
  return status(id, content, at, { ...details, presentation: { placement: "reply_note" } });
}

function command(id: string, at: number): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content: "/bin/zsh -lc 'npm test'",
    timestamp: at,
    files: null,
    messageType: "command_execution",
    metadata: {
      source: "agent",
      outcome: "in_progress",
      kind: "update",
      jobId: JOB_ID,
      messageType: "command_execution",
      details: { kind: "command_execution", command: "npm test", status: "completed", exitCode: 0 },
    },
  };
}

function reply(at: number): ChatMessage {
  return {
    id: "reply",
    role: "assistant",
    authorId: null,
    content: "I renamed the project in README.md.",
    timestamp: at,
    files: null,
    metadata: { jobId: JOB_ID, source: "agent", kind: "result", outcome: "succeeded" },
  };
}

// The controller's stamps on a Claude Code turn's messages (docs/Local-Engine-Turns.md 2.1).
const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };

/** The person's message, as the controller stored and stamped it. */
function stampedPrompt(at: number): ChatMessage {
  return {
    id: "prompt",
    role: "user",
    authorId: "user-sam",
    content: "@octo did my last change get saved?",
    timestamp: at,
    files: null,
    metadata: { ...STAMP, runId: JOB_ID },
  };
}

/** The turn's reply, as the controller stamped it. */
function stampedReply(at: number): ChatMessage {
  const plain = reply(at);
  return { ...plain, metadata: { ...plain.metadata, ...STAMP } };
}

describe("a turn's notes under its reply", () => {
  let container: HTMLDivElement;
  let root: Root;
  let base: number;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    base = Date.now() - 10_000;
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

  async function render(threadMessages: ChatMessage[]) {
    await act(async () => {
      root.render(<Turn threadMessages={threadMessages} />);
    });
  }

  const notes = () =>
    [...container.querySelectorAll('[data-testid="turn-reply-note"]')].map((note) => note.textContent);
  const line = () => container.querySelector<HTMLButtonElement>('[data-testid="turn-activity-line"]');

  it("are read by the generic placement hint, and stay out of the chat's flat list", () => {
    const note = replyNote("note", NOT_SAVED, base, { kind: "claude_code_changes_not_saved", reason: "save_failed" });
    expect(isTurnReplyNote(note)).toBe(true);
    expect(shouldDisplayChatMessage(note)).toBe(false);
    // Any other status, or a hint on anything but a status, is no such note.
    expect(isTurnReplyNote(status("plain", "Looked at the config", base, { kind: "agent_note" }))).toBe(false);
    expect(
      isTurnReplyNote({ ...note, messageType: "command_execution", metadata: { ...note.metadata, messageType: "command_execution" } }),
    ).toBe(false);
    expect(isTurnReplyNote(replyNote("empty", "   ", base, {}))).toBe(false);
  });

  it("show under the reply with Details closed, and Details doesn't list them", async () => {
    await render([
      command("step", base),
      replyNote("note-not-saved", NOT_SAVED, base + 1_000, {
        kind: "claude_code_changes_not_saved",
        reason: "status_unreadable",
      }),
      replyNote("note-denials", DENIALS, base + 2_000, {
        kind: "claude_code_permission_denials",
        count: 2,
        tools: ["Bash"],
      }),
      reply(base + 3_000),
    ]);
    expect(line()?.getAttribute("aria-expanded")).toBe("false");
    expect(line()?.textContent).toBe("Ran a command");
    expect(notes()).toEqual([NOT_SAVED, DENIALS]);
    // Under the reply.
    const replyContent = container.querySelector('[data-testid="message-content"]');
    const notesBlock = container.querySelector('[data-testid="turn-reply-notes"]');
    expect(replyContent?.textContent).toBe("I renamed the project in README.md.");
    expect(replyContent && notesBlock ? replyContent.compareDocumentPosition(notesBlock) : 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await act(async () => {
      line()?.click();
    });
    const details = container.querySelector('[data-testid="turn-activity-details"]');
    expect(details).not.toBeNull();
    expect(details?.textContent).not.toContain("weren't saved");
    expect(details?.textContent).not.toContain("need your OK");
    // Still shown once, under the reply.
    expect(notes()).toEqual([NOT_SAVED, DENIALS]);
  });

  it("never make a turn read \"Wrote a note\"", async () => {
    await render([
      replyNote("note-not-saved", NOT_SAVED, base + 1_000, { kind: "claude_code_changes_not_saved", reason: "save_failed" }),
      reply(base + 2_000),
    ]);
    expect(container.textContent).not.toMatch(/wrote a note/i);
    expect(notes()).toEqual([NOT_SAVED]);

    // A note without the hint is listed in Details as before.
    await render([status("plain", "Looked at the config first.", base + 1_000, { kind: "agent_note" }), reply(base + 2_000)]);
    expect(line()?.textContent).toBe("Wrote a note");
    expect(notes()).toEqual([]);
  });

  it("show only once the turn is done", async () => {
    await render([
      command("step", base),
      replyNote("note-not-saved", NOT_SAVED, base + 1_000, { kind: "claude_code_changes_not_saved", reason: "save_failed" }),
    ]);
    expect(notes()).toEqual([]);
    expect(container.textContent).not.toContain("weren't saved");
  });

  // A turn that took no step (Claude Code answered without a tool) has no
  // row for its steps, and the chat's flat list shows no status. A note of
  // its runtime makes it a row, so the note shows under its reply.
  describe("of a turn that took no step", () => {
    // The pre-turn refresh couldn't save earlier work (claude_code_turn.rs).
    const EARLIER_NOT_SAVED = "Not saved: .env (ignored by .gitignore).";

    it("make it a row in the chat, which shows them under its reply", async () => {
      const note = replyNote("note-earlier", EARLIER_NOT_SAVED, base + 1_000, { kind: "claude_code_save_not_saved" });
      const rows = chatRows([stampedPrompt(base), note, stampedReply(base + 2_000)]);
      // The reply is the row's, never a message of its own beside it.
      expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${JOB_ID}`]);
      const row = rows[1]!;
      const threadMessages = (row.metadata?.threadMessages ?? []) as ChatMessage[];
      expect(threadMessages.map((message) => message.id)).toEqual(["note-earlier", "reply"]);

      await act(async () => {
        root.render(<Row message={row} />);
      });
      // Details closed, and the reply shows once, with its note under it.
      expect(container.querySelector('[data-testid="turn-activity-details"]')).toBeNull();
      expect(notes()).toEqual([EARLIER_NOT_SAVED]);
      const replies = [...container.querySelectorAll('[data-testid="message-content"]')];
      expect(replies.map((node) => node.textContent)).toEqual(["I renamed the project in README.md."]);
      const notesBlock = container.querySelector('[data-testid="turn-reply-notes"]');
      expect(notesBlock ? replies[0]?.compareDocumentPosition(notesBlock) : 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(container.textContent).not.toMatch(/wrote a note/i);
      // The row still says whose own Claude Code ran the turn, as the reply would.
      expect(container.querySelector('[data-testid="turn-engine-speaker-line"]')?.textContent).toBe(
        "Ran on the sender's own Claude Code, on their computer",
      );
    });

    it("leave a turn without one as it was: its reply alone, with no row", () => {
      expect(chatRows([stampedPrompt(base), stampedReply(base + 2_000)]).map((row) => row.id)).toEqual([
        "prompt",
        "reply",
      ]);
      // A status without the hint is no such note.
      expect(
        chatRows([
          stampedPrompt(base),
          status("plain", "Looked at the config first.", base + 1_000, { kind: "agent_note" }),
          stampedReply(base + 2_000),
        ]).map((row) => row.id),
      ).toEqual(["prompt", "reply"]);
    });
  });
});
