import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../screens/studio/types";
import { shouldDisplayChatMessage } from "../../screens/studio/components/chatMessagePresentation";
import { resolveThreadRunStatusFromMessages } from "../../screens/studio/components/threadPreviewHelpers";
import {
  attachUnsavedPathsToFileChanges,
  extractUnsavedPathsFromMetadata,
  extractUnsavedReasonFromMetadata,
  extractWorkspaceCommitRangeFromMetadata,
  mapControllerMessageToChat,
  mergeAndSortMessages,
} from "../conversationMessageUtils";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "local",
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

describe("mergeAndSortMessages", () => {
  it("updates identity indexes when a controller copy changes role, client id, and server id", () => {
    const serverId = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    const messages = [
      createMessage({ id: serverId(1), role: "user", content: "Original", timestamp: 1, metadata: { clientMessageId: "old" } }),
      createMessage({ id: serverId(2), content: "Separate answer", timestamp: 2, metadata: { clientMessageId: "shared" } }),
      createMessage({ id: serverId(1), content: "Reclassified answer", timestamp: 3, metadata: { client_message_id: "shared", clientMessageId: null } }),
      createMessage({ id: serverId(3), content: "Hydrated answer", timestamp: 4, metadata: { clientMessageId: "shared" } }),
      createMessage({ id: serverId(1), content: "Reused former id", timestamp: 5, metadata: { clientMessageId: "fresh" } }),
      createMessage({ id: serverId(4), role: "user", content: "Another turn", timestamp: 6, metadata: { clientMessageId: "old" } }),
      createMessage({ id: serverId(5), content: "Final answer", timestamp: 7, metadata: { clientMessageId: "shared" } }),
    ];

    const merged = mergeAndSortMessages(messages);

    expect(merged.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: serverId(2), content: "Separate answer" },
      { id: serverId(1), content: "Reused former id" },
      { id: serverId(4), content: "Another turn" },
      { id: serverId(5), content: "Final answer" },
    ]);
  });

  it("preserves first-match precedence after content changes and terminal copies move to the end", () => {
    const serverId = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    const message = (id: number, timestamp: number, jobId: string, content = "Repeated") =>
      createMessage({ id: serverId(id), timestamp, content, metadata: { jobId } });

    const merged = mergeAndSortMessages([
      message(1, 1, "job-1", "Original"),
      message(2, 2, "job-2"),
      message(1, 3, "job-1"),
      message(3, 4, "job-2"),
      message(4, 5, "job-1"),
      message(5, 6, "job-2"),
    ]);

    expect(merged.map(({ id }) => id)).toEqual([serverId(3), serverId(4), serverId(5)]);
  });

  it("matches file changes as part of content identity after a same-id refresh", () => {
    const files = (path: string): NonNullable<ChatMessage["files"]> => [
      { path, workspacePath: path, label: path, changeType: "changed", lineRanges: [{ from: 1, to: 2 }] },
    ];
    const merged = mergeAndSortMessages([
      createMessage({ id: "local-1", content: "Updated", timestamp: 1, files: files("before.ts") }),
      createMessage({ id: "local-1", content: "Updated", timestamp: 2, files: files("after.ts") }),
      createMessage({ id: "30000000-0000-4000-8000-000000000001", content: "Updated", timestamp: 3, files: files("before.ts") }),
      createMessage({ id: "30000000-0000-4000-8000-000000000002", content: "Updated", timestamp: 4, files: files("after.ts") }),
    ]);

    expect(merged.map(({ id, files }) => ({ id, path: files?.[0]?.path }))).toEqual([
      { id: "30000000-0000-4000-8000-000000000001", path: "before.ts" },
      { id: "30000000-0000-4000-8000-000000000002", path: "after.ts" },
    ]);
  });

  it("hydrates a large history without repeatedly inspecting every earlier message", () => {
    let identityReads = 0;
    const history = Array.from({ length: 2_000 }, (_, index) => {
      const message = createMessage({
        content: `Saved message ${index}`,
        timestamp: index,
        metadata: { clientMessageId: `client-${index}` },
      });
      Object.defineProperty(message, "id", {
        get: () => {
          identityReads += 1;
          return `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        },
        enumerable: true,
      });
      return message;
    });

    expect(mergeAndSortMessages(history)).toHaveLength(history.length);
    expect(identityReads).toBeLessThan(history.length * 10);
  });

  it("keeps repeated identical server messages from different jobs", () => {
    const first = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: "Hello World\n",
      timestamp: 1,
      metadata: { jobId: "job-1" },
    });
    const second = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: "Hello World\n",
      timestamp: 2,
      metadata: { jobId: "job-2" },
    });

    const merged = mergeAndSortMessages([first, second]);

    expect(merged).toHaveLength(2);
    expect(merged.map((message) => message.id)).toEqual([first.id, second.id]);
  });

  it("dedupes identical server messages emitted from the same job and keeps the latest copy", () => {
    const first = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: "Hello World\n",
      timestamp: 1,
      metadata: { jobId: "job-1" },
    });
    const duplicate = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: "Hello World\n",
      timestamp: 2,
      metadata: { jobId: "job-1" },
    });

    const merged = mergeAndSortMessages([first, duplicate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(duplicate.id);
  });

  it("dedupes identical agent error updates from the same job and keeps the terminal outcome", () => {
    const errorText = "unexpected status 424 Failed Dependency: upstream request failed";
    const progress = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: errorText,
      timestamp: 1,
      messageType: "error",
      metadata: {
        jobId: "job-1",
        source: "agent",
        kind: "update",
        messageType: "error",
        outcome: "in_progress",
      },
    });
    const terminal = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: errorText,
      timestamp: 2,
      messageType: "error",
      metadata: {
        jobId: "job-1",
        source: "agent",
        messageType: "error",
        outcome: "failed",
      },
    });

    const merged = mergeAndSortMessages([progress, terminal]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(terminal.id);
    expect(merged[0]?.metadata).toMatchObject({
      jobId: "job-1",
      outcome: "failed",
      messageType: "error",
    });
  });

  describe("a model error reported as both a progress update and the job failure", () => {
    // The production pair from a run that stopped on a provider 429: the runtime
    // streams the Codex error as a progress update, then fails the job with the
    // same text. The controller stores both under one jobId.
    const errorText = "exceeded retry limit, last status: 429 Too Many Requests";
    const commandUpdate = createMessage({
      id: "00000000-0000-0000-0000-000000000000",
      content: "instafy conversation show --include-threads --json",
      timestamp: 0,
      messageType: "command_execution",
      metadata: {
        jobId: "job-1",
        source: "agent",
        kind: "update",
        outcome: "in_progress",
        messageType: "command_execution",
      },
    });
    const progress = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: errorText,
      timestamp: 1,
      messageType: "error",
      metadata: {
        jobId: "job-1",
        source: "agent",
        kind: "update",
        outcome: "in_progress",
        messageType: "error",
        details: { kind: "agent_error", event: { type: "error", message: errorText } },
      },
    });
    const failure = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: errorText,
      timestamp: 2,
      messageType: "error",
      metadata: {
        jobId: "job-1",
        source: "agent",
        outcome: "failed",
        messageType: "error",
        errorMessage: errorText,
      },
    });

    it("keeps only the job failure's own metadata", () => {
      const merged = mergeAndSortMessages([progress, failure]);

      expect(merged).toHaveLength(1);
      expect(merged[0]?.id).toBe(failure.id);
      expect(merged[0]?.messageType).toBe("error");
      expect(merged[0]?.metadata).toEqual(failure.metadata);
      expect(merged[0]?.metadata).not.toHaveProperty("kind");
      expect(merged[0]?.metadata).not.toHaveProperty("details");
      // Replaying the older update, in either order, cannot reattach its markers.
      expect(mergeAndSortMessages([...merged, progress])).toEqual(merged);
      expect(mergeAndSortMessages([failure, { ...progress, timestamp: 3 }])).toEqual([failure]);
    });

    it("lets the job thread resolve as a failed, finished run", () => {
      const merged = mergeAndSortMessages([commandUpdate, progress, failure]);

      expect(merged.map((message) => message.id)).toEqual([commandUpdate.id, failure.id]);
      expect(resolveThreadRunStatusFromMessages(merged)).toEqual({
        phase: "completed",
        status: "failed",
      });
    });
  });

  it("keeps an ordinary successful run's update and final answer merge as before", () => {
    // The common success path streams the answer as a status update first. That
    // pair already drops the update's markers; the failure rule must not alter it.
    const progress = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: "Saved the profile.",
      timestamp: 1,
      messageType: "status",
      metadata: {
        jobId: "job-1",
        source: "agent",
        kind: "update",
        outcome: "in_progress",
        messageType: "status",
        details: { kind: "agent_message" },
      },
    });
    const answer = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: progress.content,
      timestamp: 2,
      metadata: { jobId: "job-1", source: "agent", outcome: "succeeded" },
    });
    // Two progress updates with the same text stay last-write-wins and keep
    // their update markers, because neither one closes the run.
    const repeatedProgress = createMessage({
      ...progress,
      id: "33333333-3333-3333-3333-333333333333",
      timestamp: 3,
      messageType: "error",
      metadata: { ...progress.metadata, messageType: "error" },
    });
    const firstProgress = createMessage({
      ...repeatedProgress,
      id: "44444444-4444-4444-4444-444444444444",
      timestamp: 0,
    });

    const merged = mergeAndSortMessages([progress, answer]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(answer.id);
    expect(merged[0]?.messageType).toBeNull();
    expect(merged[0]?.metadata).toEqual(answer.metadata);
    expect(resolveThreadRunStatusFromMessages(merged)).toEqual({
      phase: "completed",
      status: "succeeded",
    });

    const progressOnly = mergeAndSortMessages([firstProgress, repeatedProgress]);
    expect(progressOnly).toHaveLength(1);
    expect(progressOnly[0]?.id).toBe(repeatedProgress.id);
    expect(progressOnly[0]?.metadata).toEqual(repeatedProgress.metadata);
  });

  it("keeps a final answer visible when replacing an identical status update", () => {
    const messageType = "status";
    const progress = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: "11",
      timestamp: 1,
      messageType,
      metadata: {
        jobId: "job-1", source: "agent", kind: "update", outcome: "in_progress",
        messageType, message_type: messageType,
        presentation: { hidden: true },
        details: { kind: "agent_message", messageType, presentation: { hidden: true } },
        agent: { displayName: "Octo" },
      },
    });
    const answer = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: progress.content,
      timestamp: 2,
      metadata: { jobId: "job-1", source: "agent", outcome: "succeeded" },
    });

    const merged = mergeAndSortMessages([progress, answer]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(answer.id);
    expect(merged[0]?.messageType).toBeNull();
    expect(merged[0]?.metadata).toEqual({ ...answer.metadata, agent: { displayName: "Octo" } });
    expect(shouldDisplayChatMessage(merged[0]!)).toBe(true);
    // An older update arriving again cannot hide the accepted final answer.
    expect(mergeAndSortMessages([...merged, progress])).toEqual(merged);
    expect(mergeAndSortMessages([...merged, { ...progress, timestamp: 3 }])).toEqual(merged);
  });

  it.each([
    { presentation: { hidden: true } },
    { details: { presentation: { hidden: true } } },
  ])("preserves a selected final answer's explicit visibility metadata: %j", (visibility) => {
    const progress = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: "Internal answer", timestamp: 1, messageType: "status",
      metadata: { jobId: "job-1", messageType: "status", kind: "update" },
    });
    const answer = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: progress.content, timestamp: 2,
      metadata: { jobId: "job-1", outcome: "succeeded", ...visibility },
    });

    const merged = mergeAndSortMessages([progress, answer]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.messageType).toBeNull();
    expect(merged[0]?.metadata).toEqual(answer.metadata);
    expect(shouldDisplayChatMessage(merged[0]!)).toBe(false);
  });

  it("shows a terminal goal update after the same run's assistant answer", () => {
    const goalUpdate = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      content: "Goal completed: counted to 3.",
      timestamp: 1,
      messageType: "goal_update",
      metadata: {
        messageType: "goal_update",
        runId: "run-1",
      },
    });
    const assistantAnswer = createMessage({
      id: "22222222-2222-2222-2222-222222222222",
      content: "3",
      timestamp: 2,
      metadata: {
        runId: "run-1",
      },
    });

    const merged = mergeAndSortMessages([goalUpdate, assistantAnswer]);

    expect(merged.map((message) => message.id)).toEqual([
      assistantAnswer.id,
      goalUpdate.id,
    ]);
  });

  it("replaces a local user placeholder with the controller copy when display content matches", () => {
    const local = createMessage({
      id: "local-user-placeholder",
      role: "user",
      content: "I see this window kind of?",
      timestamp: 1,
    });
    const server = mapControllerMessageToChat({
      id: "abababab-abab-abab-abab-abababababab",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "user",
      content: [
        'Use the existing "Crude Oil Futures Price Today (WTI)" page in the current shared browser session for this request.',
        "",
        "I see this window kind of?",
      ].join("\n"),
      metadata: {
        displayContent: "I see this window kind of?",
      },
      createdAt: "2026-03-11T00:00:01.000Z",
    });

    const merged = mergeAndSortMessages([local, server]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(server.id);
    expect(merged[0]?.content).toBe("I see this window kind of?");
  });

  it("reconciles a local placeholder with the controller copy by client message id", () => {
    const local = createMessage({
      id: "local-user-placeholder",
      role: "user",
      content: "Local optimistic copy",
      timestamp: 1,
      metadata: {
        clientMessageId: "client-message-1",
      },
    });
    const server = mapControllerMessageToChat({
      id: "abababab-abab-abab-abab-abababababab",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "user",
      content: "Persisted controller copy",
      metadata: {
        clientMessageId: "client-message-1",
        displayContent: "Persisted controller copy",
      },
      createdAt: "2026-03-11T00:00:01.000Z",
    });

    const merged = mergeAndSortMessages([local, server]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(server.id);
    expect(merged[0]?.content).toBe("Persisted controller copy");
    expect(merged[0]?.metadata).toMatchObject({
      clientMessageId: "client-message-1",
    });
  });

  it("keeps repeated identical optimistic user messages when client ids differ", () => {
    const first = createMessage({
      id: "local-user-placeholder-1",
      role: "user",
      content: "@demo stop",
      timestamp: 1,
      metadata: {
        clientMessageId: "client-message-1",
      },
    });
    const second = createMessage({
      id: "local-user-placeholder-2",
      role: "user",
      content: "@demo stop",
      timestamp: 2,
      metadata: {
        clientMessageId: "client-message-2",
      },
    });

    const merged = mergeAndSortMessages([first, second]);

    expect(merged).toHaveLength(2);
    expect(merged.map((message) => message.id)).toEqual([first.id, second.id]);
  });

  it("reconciles a local capability assistant placeholder with the controller copy by client message id", () => {
    const local = createMessage({
      id: "local-assistant-placeholder",
      role: "assistant",
      content: "Demo executed stop on the robot transport.",
      timestamp: 1,
      messageType: "status",
      metadata: {
        clientMessageId: "assistant-client-message-1",
        kind: "local_capability_result",
        messageType: "status",
        localCapability: {
          id: "robot_embodiment",
          status: "completed",
        },
        robotLearning: {
          learnDraft: {
            session_path: "/tmp/instafy_chat.ndjson",
          },
        },
      },
    });
    const server = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      role: "assistant",
      content: "Demo executed stop on the robot transport.",
      timestamp: 2,
      metadata: {
        clientMessageId: "assistant-client-message-1",
        kind: "local_capability_result",
      },
    });

    const merged = mergeAndSortMessages([local, server]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(server.id);
    expect(merged[0]?.messageType).toBe("status");
    expect(merged[0]?.metadata).toMatchObject({
      clientMessageId: "assistant-client-message-1",
      localCapability: {
        id: "robot_embodiment",
        status: "completed",
      },
      robotLearning: {
        learnDraft: {
          session_path: "/tmp/instafy_chat.ndjson",
        },
      },
    });
  });

  it("preserves richer local capability metadata when hydrating the controller copy", () => {
    const local = createMessage({
      id: "local-assistant-placeholder",
      role: "assistant",
      content: "Demo executed stop on the robot transport.",
      timestamp: 1,
      messageType: "status",
      metadata: {
        kind: "local_capability_result",
        messageType: "status",
        robotLearning: {
          learnDraft: {
            session_path: "/tmp/instafy_chat.ndjson",
            profile_path: "/tmp/profile.yaml",
            robot_id: "demo_v1",
            project_memory_candidate: {
              block_id: "robot.behavior.demo",
              title: "Demo robot learn draft",
              suggested_block_path: ".agents/skills/instafy-learned/blocks/robot/SKILL.md",
              tags: ["robot"],
              markdown: "Robot memory candidate",
            },
            session_summary: {
              telemetry_count: 1,
              command_telemetry_count: 1,
              preference_update_count: 0,
              user_feedback_count: 0,
              adaptation_update_count: 0,
              user_feedback_signals: [],
              adaptation_modes: [],
            },
          },
        },
      },
    });
    const server = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      role: "assistant",
      content: "Demo executed stop on the robot transport.",
      timestamp: 2,
      metadata: {
        kind: "local_capability_result",
      },
    });

    const merged = mergeAndSortMessages([local, server]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(server.id);
    expect(merged[0]?.messageType).toBe("status");
    expect(
      ((merged[0]?.metadata?.robotLearning as Record<string, unknown>)?.learnDraft as Record<string, unknown>)
        ?.project_memory_candidate,
    ).toMatchObject({
      suggested_block_path: ".agents/skills/instafy-learned/blocks/robot/SKILL.md",
    });
  });

  it("keeps repeated identical local capability placeholders when they represent distinct turns", () => {
    const first = createMessage({
      id: "local-assistant-placeholder-1",
      role: "assistant",
      content: "Demo cannot use Demo in this project yet.",
      timestamp: 1,
      messageType: "error",
      metadata: {
        clientMessageId: "assistant-client-message-1",
        kind: "local_capability_result",
      },
    });
    const second = createMessage({
      id: "local-assistant-placeholder-2",
      role: "assistant",
      content: "Demo cannot use Demo in this project yet.",
      timestamp: 2,
      messageType: "error",
      metadata: {
        clientMessageId: "assistant-client-message-2",
        kind: "local_capability_result",
      },
    });

    const merged = mergeAndSortMessages([first, second]);

    expect(merged).toHaveLength(2);
    expect(merged.map((message) => message.id)).toEqual([first.id, second.id]);
  });

  it("preserves richer local capability metadata when a same-id controller refresh arrives", () => {
    const initial = createMessage({
      id: "11111111-1111-1111-1111-111111111111",
      role: "assistant",
      content: "Demo executed stop on the robot transport.",
      timestamp: 1,
      messageType: "status",
      metadata: {
        kind: "local_capability_result",
        messageType: "status",
        localCapability: {
          id: "robot_embodiment",
          status: "completed",
        },
        robotLearning: {
          learnDraft: {
            session_path: "/tmp/instafy_chat.ndjson",
            profile_path: "/tmp/profile.yaml",
            robot_id: "demo_v1",
            project_memory_candidate: {
              block_id: "robot.behavior.demo",
              title: "Demo robot learn draft",
              suggested_block_path: ".agents/skills/instafy-learned/blocks/robot/SKILL.md",
              tags: ["robot"],
              markdown: "Robot memory candidate",
            },
            session_summary: {
              telemetry_count: 1,
              command_telemetry_count: 1,
              preference_update_count: 0,
              user_feedback_count: 0,
              adaptation_update_count: 0,
              user_feedback_signals: [],
              adaptation_modes: [],
            },
          },
        },
      },
    });
    const refreshed = createMessage({
      id: initial.id,
      role: "assistant",
      content: initial.content,
      timestamp: 2,
      metadata: {
        kind: "local_capability_result",
      },
    });

    const merged = mergeAndSortMessages([initial, refreshed]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(initial.id);
    expect(merged[0]?.messageType).toBe("status");
    expect(
      ((merged[0]?.metadata?.robotLearning as Record<string, unknown>)?.learnDraft as Record<string, unknown>)
        ?.project_memory_candidate,
    ).toMatchObject({
      suggested_block_path: ".agents/skills/instafy-learned/blocks/robot/SKILL.md",
    });
  });
});

describe("mapControllerMessageToChat", () => {
  it("prefers stored display content for user prompts when controller content is augmented", () => {
    const mapped = mapControllerMessageToChat({
      id: "12121212-1212-1212-1212-121212121212",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "user",
      content: [
        'Use the existing "Crude Oil Futures Price Today (WTI)" page in the current shared browser session for this request.',
        "That page is https://www.investing.com/commodities/crude-oil. Treat it as a page/tab inside the current browser session.",
        "",
        "I see this window kind of?",
      ].join("\n"),
      metadata: {
        displayContent: "I see this window kind of?",
        dispatchContent: "augmented browser prompt",
      },
      createdAt: "2026-03-11T00:00:00.000Z",
    });

    expect(mapped.content).toBe("I see this window kind of?");
    expect(mapped.metadata?.["dispatchContent"]).toBe("augmented browser prompt");
  });

  it("strips the known browser-session dispatch prelude for older user messages", () => {
    const mapped = mapControllerMessageToChat({
      id: "34343434-3434-3434-3434-343434343434",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "user",
      content: [
        'Use the existing "Crude Oil Futures Price Today (WTI)" page in the current shared browser session for this request.',
        "That page is https://www.investing.com/commodities/crude-oil. Treat it as a page/tab inside the current browser session, not as a new isolated session or a new runtime-backed browser session unless I explicitly ask for that.",
        "Keep any other open browser pages available unless I explicitly ask you to close or replace them.",
        "",
        "I see this window kind of?",
      ].join("\n"),
      metadata: {},
      createdAt: "2026-03-11T00:00:00.000Z",
    });

    expect(mapped.content).toBe("I see this window kind of?");
  });

  it("normalizes command execution metadata into canonical shape", () => {
    const mapped = mapControllerMessageToChat({
      id: "33333333-3333-3333-3333-333333333333",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "assistant",
      content: "Command completed in terminal session `abc`: `pwd`.\n\n/workspace/project",
      metadata: {
        details: {
          kind: "codex_command_execution",
          event: {
            status: "completed",
            item_id: "terminal:run-1:abc",
            aggregated_output: "/workspace/project\n",
          },
        },
      },
      createdAt: "2026-02-16T00:00:00.000Z",
    });

    expect(mapped.messageType).toBe("command_execution");
    expect(mapped.metadata?.["messageType"]).toBe("command_execution");
    expect((mapped.metadata?.["details"] as Record<string, unknown>)?.["messageType"]).toBe("command_execution");
    expect((mapped.metadata?.["details"] as Record<string, unknown>)?.["status"]).toBe("completed");
    expect((mapped.metadata?.["details"] as Record<string, unknown>)?.["itemId"]).toBe("terminal:run-1:abc");
    expect((mapped.metadata?.["details"] as Record<string, unknown>)?.["aggregatedOutput"]).toBe(
      "/workspace/project\n",
    );
  });

  it("resolves integration request message type from nested runtime-selection details", () => {
    const mapped = mapControllerMessageToChat({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      projectId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "assistant",
      content: "Connect your Discord account so I can continue.",
      metadata: {
        kind: "update",
        source: "agent",
        outcome: "in_progress",
        details: {
          kind: "runtime_selection",
          runtimeId: "runtime-1",
          displayName: "Hosted Runtime",
          details: {
            provider: "discord",
            description: "Connect Discord for channel read access.",
            messageType: "integration_request",
            capabilities: ["read_channels", "list_guilds"],
          },
        },
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    });

    expect(mapped.messageType).toBe("integration_request");
    expect(mapped.metadata?.["messageType"]).toBe("integration_request");
  });
});

describe("extractWorkspaceCommitRangeFromMetadata", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);

  it("reads the git sync pair from the origin/apply artifact", () => {
    const range = extractWorkspaceCommitRangeFromMetadata({
      artifacts: [
        {
          kind: "origin/apply",
          metadata: { rev: base, baseRev: null, gitRev: head, gitBaseRev: base },
        },
      ],
    });

    // The canonical pair is the only one a saved-version revert may use.
    expect(range).toEqual({ base, head, source: "git" });
  });

  it("falls back to the apply pair but never mixes pairs", () => {
    const range = extractWorkspaceCommitRangeFromMetadata({
      artifacts: [
        {
          kind: "origin/apply",
          // gitRev without gitBaseRev must not pair with the apply baseRev.
          metadata: { rev: head, baseRev: base, gitRev: "c".repeat(40) },
        },
      ],
    });

    // The apply pair can be a runtime checkout's own commits, so it is
    // marked as such and never offered as a revert.
    expect(range).toEqual({ base, head, source: "apply" });
  });

  it("rejects non-commit revs such as apply timestamps", () => {
    const range = extractWorkspaceCommitRangeFromMetadata({
      artifacts: [
        {
          kind: "origin/apply",
          metadata: { rev: "2026-07-07T09:00:00.000Z", baseRev: base },
        },
      ],
    });

    expect(range).toBeNull();
  });

  it("prefers the newest apply artifact and requires distinct commits", () => {
    const newerBase = "d".repeat(40);
    const newerHead = "e".repeat(40);
    const range = extractWorkspaceCommitRangeFromMetadata({
      artifacts: [
        { kind: "origin/apply", metadata: { gitRev: head, gitBaseRev: base } },
        { kind: "origin/apply", metadata: { gitRev: newerHead, gitBaseRev: newerBase } },
      ],
    });

    expect(range).toEqual({ base: newerBase, head: newerHead, source: "git" });

    expect(
      extractWorkspaceCommitRangeFromMetadata({
        artifacts: [{ kind: "origin/apply", metadata: { gitRev: head, gitBaseRev: head } }],
      }),
    ).toBeNull();
  });

  it("ignores a command lane's save when the turn's own save made no commit", () => {
    const range = extractWorkspaceCommitRangeFromMetadata({
      artifacts: [
        // `/skills import --start` saves the skill files before the model turn.
        {
          kind: "origin/apply",
          metadata: { gitRev: head, gitBaseRev: base, lane: "skills/import" },
        },
        { kind: "origin/apply", metadata: { gitRev: head, gitBaseRev: head } },
      ],
    });

    expect(range).toBeNull();
  });

  it("stays paired with the files list that wins a duplicate-message merge", () => {
    const file = {
      path: "notes.txt",
      workspacePath: "notes.txt",
      label: "notes.txt",
      changeType: "changed" as const,
      lineRanges: [],
    };
    const existing = createMessage({
      id: "m",
      timestamp: 1,
      files: [file],
      commitRange: { base, head },
    });

    // Incoming update carries fresh files but no extractable revs: the stale
    // range must not pin the new files to the old run's commits.
    const incomingWithFiles = createMessage({
      id: "m",
      timestamp: 2,
      files: [{ ...file, path: "other.txt", workspacePath: "other.txt", label: "other.txt" }],
      commitRange: null,
    });
    expect(mergeAndSortMessages([existing, incomingWithFiles])[0]?.commitRange).toBeNull();

    // Incoming update without files keeps the existing files+range pair.
    const incomingWithoutFiles = createMessage({ id: "m", timestamp: 2, files: null, commitRange: null });
    expect(mergeAndSortMessages([existing, incomingWithoutFiles])[0]?.commitRange).toEqual({ base, head });
  });

  it("is attached to mapped chat messages alongside files", () => {
    const mapped = mapControllerMessageToChat({
      id: "12121212-1212-1212-1212-121212121212",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "assistant",
      content: "Edited notes.txt",
      metadata: {
        artifacts: [
          {
            kind: "apply/files",
            files: [{ path: "notes.txt", change: { type: "changed" } }],
          },
          {
            kind: "origin/apply",
            metadata: { gitRev: head, gitBaseRev: base },
          },
        ],
      },
      createdAt: "2026-07-07T00:00:00.000Z",
    });

    expect(mapped.commitRange).toEqual({ base, head, source: "git" });
  });
});

describe("extractUnsavedReasonFromMetadata", () => {
  // Shape the runtime writes after /apply + /git/sync
  // (runtime-agent jobs/mod.rs, workspace_commit_git_sync_status).
  function originApply(gitSyncStatus: string, extra: Record<string, unknown> = {}) {
    return {
      kind: "origin/apply",
      metadata: {
        originId: "origin-1",
        rev: null,
        baseRev: null,
        gitRev: null,
        gitBaseRev: null,
        gitSyncStatus,
        gitSyncAttempted: gitSyncStatus !== "disabled",
        gitSyncError: gitSyncStatus === "failed" ? "git remote is not configured for this project" : null,
        paths: [],
        ...extra,
      },
    };
  }

  it("reports a failed save", () => {
    expect(extractUnsavedReasonFromMetadata({ artifacts: [originApply("failed")] })).toBe("save_failed");
  });

  it("reports auto-save being off, the runtime's manual_required outcome", () => {
    expect(extractUnsavedReasonFromMetadata({ artifacts: [originApply("disabled")] })).toBe("auto_save_off");
  });

  // The runtime's gitSyncError when the origin refuses paths kept out of
  // history (origin-http-server commit_and_push_paths).
  function historyExclusionError(...paths: string[]) {
    return `origin git sync failed (400 Bad Request): {"error":"path is excluded from space history: ${paths.join(", ")}"}`;
  }

  it("stays quiet for saved runs, intentional history exclusions and runs that never saved", () => {
    expect(extractUnsavedReasonFromMetadata({ artifacts: [originApply("synced")] })).toBeNull();
    expect(
      extractUnsavedReasonFromMetadata({
        artifacts: [
          originApply("skipped", {
            gitSyncError: historyExclusionError("tmp/scratch.md", "node_modules/.cache/x.json"),
            paths: ["node_modules/.cache/x.json", "tmp/scratch.md"],
          }),
        ],
      }),
    ).toBeNull();
    expect(
      extractUnsavedReasonFromMetadata({
        artifacts: [{ kind: "origin/apply-skipped", metadata: { reason: "missing_controller_token" } }],
      }),
    ).toBeNull();
    expect(
      extractUnsavedReasonFromMetadata({
        artifacts: [{ kind: "apply/files", files: [{ path: "notes.txt" }] }],
      }),
    ).toBeNull();
    expect(extractUnsavedReasonFromMetadata({})).toBeNull();
    expect(extractUnsavedReasonFromMetadata(null)).toBeNull();
  });

  it("reports a skipped save as failed when real files rode in the refused request", () => {
    // The origin refuses the whole /git/sync when any path is excluded from
    // history, so profile.json was never saved even though the runtime calls
    // the outcome "skipped".
    expect(
      extractUnsavedReasonFromMetadata({
        artifacts: [
          originApply("skipped", {
            gitSyncError: historyExclusionError("tmp/scratch.md"),
            paths: ["bookkeeping/profile.json", "tmp/scratch.md"],
          }),
        ],
      }),
    ).toBe("save_failed");
    // A real file whose name ends like an excluded one is still a real file.
    expect(
      extractUnsavedReasonFromMetadata({
        artifacts: [
          originApply("skipped", {
            gitSyncError: historyExclusionError("tmp/notes.md"),
            paths: ["notes.md", "tmp/notes.md"],
          }),
        ],
      }),
    ).toBe("save_failed");
    // Without the origin's list there is no evidence against the runtime's label.
    expect(
      extractUnsavedReasonFromMetadata({
        artifacts: [originApply("skipped", { gitSyncError: null, paths: ["bookkeeping/profile.json"] })],
      }),
    ).toBeNull();
  });

  it("treats hosted and EFS origins as at risk but not a Desktop folder", () => {
    expect(
      extractUnsavedReasonFromMetadata({ artifacts: [originApply("failed", { mode: "hosted" })] }),
    ).toBe("save_failed");
    expect(
      extractUnsavedReasonFromMetadata({ artifacts: [originApply("disabled", { mode: "efs" })] }),
    ).toBe("auto_save_off");
    expect(
      extractUnsavedReasonFromMetadata({ artifacts: [originApply("failed", { mode: "desktop" })] }),
    ).toBeNull();
  });

  it("does not mark the whole message unsaved for a partial save", () => {
    // A partial save published most files; the ones it left out are marked
    // one by one from conflictedPaths and rejectedPaths instead.
    expect(
      extractUnsavedReasonFromMetadata({
        artifacts: [originApply("partial", { conflictedPaths: ["notes.md"] })],
      }),
    ).toBeNull();
  });

  it("follows the newest apply artifact when a retried run appends another", () => {
    expect(
      extractUnsavedReasonFromMetadata({ artifacts: [originApply("failed"), originApply("synced")] }),
    ).toBeNull();
    expect(
      extractUnsavedReasonFromMetadata({ artifacts: [originApply("synced"), originApply("failed")] }),
    ).toBe("save_failed");
  });

  it("is attached to mapped chat messages alongside files", () => {
    const mapped = mapControllerMessageToChat({
      id: "13131313-1313-1313-1313-131313131313",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "assistant",
      content: "Saved your profile.",
      metadata: {
        artifacts: [
          {
            kind: "apply/files",
            files: [{ path: "bookkeeping/profile.json", change: { type: "changed" } }],
          },
          originApply("failed"),
        ],
      },
      createdAt: "2026-09-26T16:00:00.000Z",
    });

    expect(mapped.files?.map((file) => file.path)).toEqual(["bookkeeping/profile.json"]);
    expect(mapped.unsavedReason).toBe("save_failed");
  });

  it("stays paired with the files list that wins a duplicate-message merge", () => {
    const file = {
      path: "notes.txt",
      workspacePath: "notes.txt",
      label: "notes.txt",
      changeType: "changed" as const,
      lineRanges: [],
    };
    const existing = createMessage({ id: "m", timestamp: 1, files: [file], unsavedReason: "save_failed" });

    // A later copy with its own files describes its own save.
    const incomingWithFiles = createMessage({ id: "m", timestamp: 2, files: [file], unsavedReason: null });
    expect(mergeAndSortMessages([existing, incomingWithFiles])[0]?.unsavedReason).toBeNull();

    // A copy without files keeps the existing files and their save state.
    const incomingWithoutFiles = createMessage({ id: "m", timestamp: 2, files: null, unsavedReason: null });
    expect(mergeAndSortMessages([existing, incomingWithoutFiles])[0]?.unsavedReason).toBe("save_failed");
  });
});

describe("extractUnsavedPathsFromMetadata", () => {
  // The per-path fields of the runtime's origin/apply artifact
  // (runtime-agent jobs/mod.rs, origin_apply_artifact; save_report.rs).
  function originApply(extra: Record<string, unknown>) {
    return {
      kind: "origin/apply",
      metadata: { originId: "origin-1", gitSyncStatus: "partial", conflictedPaths: [], rejectedPaths: [], ...extra },
    };
  }

  it("reads conflicted paths and rejected paths with their reasons", () => {
    expect(
      extractUnsavedPathsFromMetadata({
        artifacts: [
          originApply({
            conflictedPaths: ["src/app.ts"],
            rejectedPaths: [
              { path: ".env", reason: "secret", keptSavedVersion: false },
              { path: "assets/video.mp4", reason: "too_large", keptSavedVersion: true },
              { path: "dist/out.js", reason: "excluded", keptSavedVersion: false },
              { path: "debug.log", reason: "ignored", keptSavedVersion: false },
              { path: "chat/upload.png", reason: "attachment", keptSavedVersion: false },
              { path: "rules.bin", reason: "policy", keptSavedVersion: false },
              { path: "vendor/lib", reason: "unsupported", keptSavedVersion: false },
            ],
          }),
        ],
      }),
    ).toEqual([
      { path: "src/app.ts", reason: "conflicted", keptSavedVersion: true },
      { path: ".env", reason: "secret", keptSavedVersion: false },
      { path: "assets/video.mp4", reason: "too_large", keptSavedVersion: true },
      { path: "dist/out.js", reason: "excluded", keptSavedVersion: false },
      { path: "debug.log", reason: "ignored", keptSavedVersion: false },
      { path: "chat/upload.png", reason: "attachment", keptSavedVersion: false },
      { path: "rules.bin", reason: "policy", keptSavedVersion: false },
      { path: "vendor/lib", reason: "unsupported", keptSavedVersion: false },
    ]);
  });

  it("keeps a rejected path whose origin gave no reason, and one entry per path", () => {
    expect(
      extractUnsavedPathsFromMetadata({
        artifacts: [
          originApply({
            conflictedPaths: ["./notes.md", "notes.md"],
            rejectedPaths: [
              { path: "notes.md", reason: "secret" },
              { path: "/data/raw.csv", reason: "" },
              { path: "odd.bin", reason: "something-new", kept_saved_version: true },
              "plain.txt",
              { reason: "secret" },
            ],
          }),
        ],
      }),
    ).toEqual([
      { path: "notes.md", reason: "conflicted", keptSavedVersion: true },
      { path: "data/raw.csv", reason: "unknown", keptSavedVersion: false },
      { path: "odd.bin", reason: "unknown", keptSavedVersion: true },
      { path: "plain.txt", reason: "unknown", keptSavedVersion: false },
    ]);
  });

  it("reads the turn's own save, not a command lane's or an older one", () => {
    expect(
      extractUnsavedPathsFromMetadata({
        artifacts: [
          originApply({ conflictedPaths: ["old.md"] }),
          originApply({ conflictedPaths: ["new.md"] }),
          originApply({ conflictedPaths: ["skills/x/SKILL.md"], lane: "skills/import" }),
        ],
      }).map((entry) => entry.path),
    ).toEqual(["new.md"]);
    expect(extractUnsavedPathsFromMetadata({ artifacts: [{ kind: "apply/files", files: [] }] })).toEqual([]);
    expect(extractUnsavedPathsFromMetadata(null)).toEqual([]);
  });

  it("marks only the matching file changes", () => {
    const file = (path: string) => ({
      path,
      workspacePath: path,
      label: path,
      changeType: "changed" as const,
      lineRanges: [],
    });
    const files = [file("src/app.ts"), { ...file("./README.md"), workspacePath: "README.md" }];
    const marked = attachUnsavedPathsToFileChanges(files, [
      { path: "README.md", reason: "ignored", keptSavedVersion: false },
      { path: "elsewhere.md", reason: "conflicted", keptSavedVersion: true },
    ]);
    expect(marked[0]).toBe(files[0]);
    expect(marked[1]?.notSaved).toEqual({ reason: "ignored", keptSavedVersion: false });
    expect(attachUnsavedPathsToFileChanges(files, [])).toBe(files);
  });

  it("is attached to the files of mapped chat messages", () => {
    const mapped = mapControllerMessageToChat({
      id: "15151515-1515-1515-1515-151515151515",
      conversationId: "44444444-4444-4444-4444-444444444444",
      projectId: "55555555-5555-5555-5555-555555555555",
      sessionId: null,
      createdBy: null,
      promptId: null,
      runId: null,
      role: "assistant",
      content: "Edited two files.",
      metadata: {
        artifacts: [
          {
            kind: "apply/files",
            files: [
              { path: "src/app.ts", change: { type: "changed" } },
              { path: ".env", change: { type: "created" } },
            ],
          },
          originApply({ rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }] }),
        ],
      },
      createdAt: "2026-10-04T10:00:00.000Z",
    });

    expect(mapped.unsavedReason).toBeNull();
    expect(mapped.files?.map((entry) => [entry.path, entry.notSaved ?? null])).toEqual([
      ["src/app.ts", null],
      [".env", { reason: "secret", keptSavedVersion: false }],
    ]);
  });
});
