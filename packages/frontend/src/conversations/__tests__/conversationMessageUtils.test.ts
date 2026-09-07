import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../screens/studio/types";
import {
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

    expect(range).toEqual({ base, head });
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

    expect(range).toEqual({ base, head });
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

    expect(range).toEqual({ base: newerBase, head: newerHead });

    expect(
      extractWorkspaceCommitRangeFromMetadata({
        artifacts: [{ kind: "origin/apply", metadata: { gitRev: head, gitBaseRev: head } }],
      }),
    ).toBeNull();
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

    expect(mapped.commitRange).toEqual({ base, head });
  });
});
