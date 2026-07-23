import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { formatConversationTranscript, resolveCopyableMessageContent } from "../chatTranscriptCopy";

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
});
