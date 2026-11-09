import { describe, expect, it } from "vitest";

import { mapControllerMessageToChat } from "../../../../conversations/conversationMessageUtils";
import type { ChatMessage } from "../../types";
import { collapseLifecycleMessages, shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { formatConversationTranscript, resolveCopyableMessageContent } from "../chatTranscriptCopy";
import { revealCanonicalMessageTarget } from "../messageContextPresentation";

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

describe("chatTranscriptCopy", () => {
  it("formats normal user and assistant messages into a transcript", () => {
    const transcript = formatConversationTranscript([
      createMessage({
        id: "user-1",
        role: "user",
        content: "Help me build something in this space.",
      }),
      createMessage({
        id: "assistant-1",
        role: "assistant",
        content: "What do you want to ship first?",
      }),
    ]);

    expect(transcript).toBe(
      "User: Help me build something in this space.\n\nAssistant: What do you want to ship first?",
    );
  });

  it("copies the visible assistant summary from synthesized run-thread messages", () => {
    const content = resolveCopyableMessageContent(
      createMessage({
        id: "thread-1",
        role: "assistant",
        messageType: "agent_job_thread",
        metadata: {
          messageType: "agent_job_thread",
          jobId: "run-123",
          threadMessages: [
            createMessage({
              id: "status-1",
              role: "assistant",
              content: "Drafting response…",
              messageType: "status",
              metadata: {
                messageType: "status",
                outcome: "in_progress",
              },
            }),
            createMessage({
              id: "assistant-summary",
              role: "assistant",
              content:
                "I created `BUILD_PLAN.md` to capture the discovery questions you asked for, so we can begin scoping the project together.",
              timestamp: 10,
              files: [
              {
                path: "BUILD_PLAN.md",
                workspacePath: "BUILD_PLAN.md",
                label: "BUILD_PLAN.md",
                changeType: "created",
                lineRanges: [],
              },
            ],
          }),
          ],
        },
      }),
    );

    expect(content).toBe(
      "I created `BUILD_PLAN.md` to capture the discovery questions you asked for, so we can begin scoping the project together.",
    );
  });

  // A local test, Nov 9: Copy conversation ended a comparison's reply with
  // "Updated data.json.", a file's name the reply never used.
  it("copies a reply's words and nothing after them", () => {
    const dataFile = {
      path: "sites/framework-laptops-compare/data.json",
      workspacePath: "sites/framework-laptops-compare/data.json",
      label: "data.json",
      changeType: "changed" as const,
      lineRanges: [],
    };
    const reply = "Added a warranty column to the comparison with each laptop’s warranty from its own specs page.";
    const transcript = formatConversationTranscript([
      createMessage({ id: "user-1", role: "user", content: "Add each laptop's warranty." }),
      createMessage({
        id: "thread-1",
        role: "assistant",
        messageType: "agent_job_thread",
        metadata: {
          messageType: "agent_job_thread",
          threadMessages: [
            createMessage({ id: "edit", role: "assistant", messageType: "file_change", timestamp: 5, files: [dataFile] }),
            createMessage({ id: "reply", role: "assistant", content: reply, timestamp: 10, files: [dataFile] }),
          ],
        },
      }),
    ]);

    expect(transcript).toBe(`User: Add each laptop's warranty.\n\nAssistant: ${reply}`);
  });

  it("falls back to a file summary when a run-thread only contains file changes", () => {
    const transcript = formatConversationTranscript([
      createMessage({
        id: "user-1",
        role: "user",
        content: "Create a build plan.",
      }),
      createMessage({
        id: "thread-1",
        role: "assistant",
        messageType: "agent_job_thread",
        metadata: {
          messageType: "agent_job_thread",
          threadMessages: [
            createMessage({
              id: "file-change-1",
              role: "assistant",
              messageType: "file_change",
              files: [
              {
                path: "BUILD_PLAN.md",
                workspacePath: "BUILD_PLAN.md",
                label: "BUILD_PLAN.md",
                changeType: "created",
                lineRanges: [],
              },
            ],
          }),
          ],
        },
      }),
    ]);

    expect(transcript).toBe("User: Create a build plan.\n\nAssistant: Created BUILD_PLAN.md.");
  });

  it("adds no file summary for a turn that only read a file", () => {
    const answer = mapControllerMessageToChat({
      id: "17171717-1717-1717-1717-171717171717",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "assistant",
      content: "The notes list three open tasks.",
      metadata: {
        artifacts: [
          {
            kind: "apply/files",
            files: [
              {
                path: "notes/a.md",
                workspacePath: "notes/a.md",
                change: "read",
                changeType: "read",
                source: "workspace",
              },
            ],
          },
        ],
      },
      createdAt: "2026-10-02T09:00:00.000Z",
    });

    const transcript = formatConversationTranscript([
      createMessage({
        id: "user-1",
        role: "user",
        content: "Read my notes back to me.",
      }),
      createMessage({
        id: "thread-1",
        role: "assistant",
        messageType: "agent_job_thread",
        metadata: {
          messageType: "agent_job_thread",
          threadMessages: [answer],
        },
      }),
    ]);

    expect(transcript).toBe("User: Read my notes back to me.\n\nAssistant: The notes list three open tasks.");
  });

  // A stopped turn is one row, which holds the notice of its Stop: the copy
  // still says the turn was stopped, as when the notice had a row of its own.
  it("says a stopped turn was stopped", () => {
    const messages = [
      createMessage({ id: "user-1", role: "user", content: "Plan 3 days in Seville.", timestamp: 1 }),
      createMessage({
        id: "step-1",
        content: "/bin/bash -lc ls",
        timestamp: 2,
        messageType: "command_execution",
        metadata: {
          jobId: "job-1", runId: "run-1", kind: "update", outcome: "in_progress", messageType: "command_execution",
          details: { kind: "codex_command_execution", status: "completed", itemId: "exec-1" },
        },
      }),
      createMessage({
        id: "stop-1",
        content: "Stopped this run.",
        timestamp: 3,
        metadata: {
          source: "controller", kind: "run_cancellation", runId: "run-1",
          details: { stopRequested: true, actorUserId: "person-1", agentHandles: ["octo"], jobIds: ["job-1"], runIds: ["run-1"] },
        },
      }),
    ];
    const collapsed = collapseLifecycleMessages(messages);
    const rows = synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage));
    expect(rows.map((row) => row.id)).toEqual(["user-1", "agent-job-thread:job-1"]);
    expect(formatConversationTranscript(rows)).toBe("User: Plan 3 days in Seville.\n\nAssistant: Stopped this run.");
    // Opened at that notice (a search result), the chat lists it beside its row: copied once.
    const opened = revealCanonicalMessageTarget(rows, collapsed, "stop-1");
    expect(formatConversationTranscript(opened)).toBe("User: Plan 3 days in Seville.\n\nAssistant: Stopped this run.");
  });
});
