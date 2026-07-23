import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import {
  collapseLifecycleMessages,
  shouldDisplayChatMessage,
  shouldDisplayJobThreadMessage,
  synthesizeAgentJobThreadMessages,
} from "../chatMessagePresentation";

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

describe("chatMessagePresentation", () => {
  it("hides messages explicitly marked as presentation-hidden", () => {
    const message = createMessage({
      content: "Goal updated: Count to 50",
      messageType: "goal_update",
      metadata: {
        messageType: "goal_update",
        presentation: { hidden: true },
      },
    });

    expect(shouldDisplayChatMessage(message)).toBe(false);
  });

  it("hides messages with nested runtime presentation metadata", () => {
    const message = createMessage({
      content: "Goal updated: Count to 50",
      messageType: "goal_update",
      metadata: {
        messageType: "goal_update",
        details: {
          messageType: "goal_update",
          presentation: { hidden: true },
        },
      },
    });

    expect(shouldDisplayChatMessage(message)).toBe(false);
  });

  it("shows runtime-wrapped goal state action messages unless presentation hides them", () => {
    const message = createMessage({
      content: "Goal completed: Counted to 50.",
      messageType: "goal_update",
      metadata: {
        messageType: "goal_update",
        details: {
          kind: "runtime_selection",
          messageType: "goal_update",
          details: {
            status: "completed",
            objective: "Count to 50",
            progressSummary: "Counted to 50.",
          },
        },
      },
    });

    expect(shouldDisplayChatMessage(message)).toBe(true);
  });

  it("keeps hidden early job updates inside the synthesized run thread", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "thinking",
        content: "Creating files",
        timestamp: 100,
        messageType: "reasoning",
        metadata: { jobId: "job-1", messageType: "reasoning" },
      }),
      createMessage({
        id: "status",
        content: "Applying changes to workspace...",
        timestamp: 200,
        messageType: "status",
        metadata: { jobId: "job-1", messageType: "status", outcome: "in_progress" },
      }),
      createMessage({
        id: "final",
        content: "I wrote three poems.",
        timestamp: 300,
        files: [
          {
            path: "poem-1.txt",
            workspacePath: "poem-1.txt",
            label: "poem-1.txt",
            changeType: "created",
            lineRanges: [],
            rawChange: null,
          },
        ],
        metadata: { jobId: "job-1", outcome: "succeeded" },
      }),
    ];

    const collapsedAll = collapseLifecycleMessages(messages);
    const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
    const synthesized = synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible);

    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]?.messageType).toBe("agent_job_thread");
    expect((synthesized[0]?.metadata as Record<string, unknown>)?.jobId).toBe("job-1");
    expect(
      ((synthesized[0]?.metadata as Record<string, unknown>)?.threadMessages as ChatMessage[]).map(
        (message) => message.id,
      ),
    ).toEqual(["thinking", "status", "final"]);
  });

  it("removes a stale runtime alert once the same run later produces agent output", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "runtime-alert",
        content: "Runtime is still connecting.",
        timestamp: 100,
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          runId: "run-1",
          details: {
            reason: "runtime_not_ready",
            detail: "status=starting, lastSeen=unknown",
          },
        },
      }),
      createMessage({
        id: "agent-result",
        content: "runtime-ready",
        timestamp: 200,
        metadata: {
          source: "agent",
          kind: "result",
          runId: "run-1",
          outcome: "success",
        },
      }),
    ];

    expect(collapseLifecycleMessages(messages).map((message) => message.id)).toEqual(["agent-result"]);
  });

  it("synthesizes failed agent errors into a run trace preview", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "progress",
        content: "Inspecting files...",
        timestamp: 100,
        messageType: "status",
        metadata: { jobId: "job-1", messageType: "status", outcome: "in_progress" },
      }),
      createMessage({
        id: "error",
        content: "Codex returned assistant text instead of the required final JSON after retry.",
        timestamp: 200,
        messageType: "error",
        metadata: {
          jobId: "job-1",
          messageType: "error",
          outcome: "failed",
          artifacts: [
            {
              kind: "codex/run-log",
              events: [{ type: "turn.completed" }],
            },
          ],
        },
      }),
    ];

    const collapsedAll = collapseLifecycleMessages(messages);
    const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
    const synthesized = synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible);

    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]?.messageType).toBe("agent_job_thread");
    expect(
      ((synthesized[0]?.metadata as Record<string, unknown>)?.threadMessages as ChatMessage[]).map(
        (message) => message.id,
      ),
    ).toEqual(["progress", "error"]);
  });

  it("does not synthesize standalone run previews for failed multi-agent workers", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "worker-command",
        content: "Running command...",
        timestamp: 100,
        messageType: "command_execution",
        metadata: { jobId: "worker-job-1", messageType: "command_execution" },
      }),
      createMessage({
        id: "worker-error",
        content: "Worker failed before producing evidence.",
        timestamp: 200,
        messageType: "error",
        metadata: {
          jobId: "worker-job-1",
          messageType: "error",
          outcome: "failed",
          multiAgentPlan: {
            role: "worker",
            parentJobId: "plan-job-1",
            groupId: "group-1",
          },
        },
      }),
    ];

    const collapsedAll = collapseLifecycleMessages(messages);
    const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
    const synthesized = synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible);

    expect(synthesized).toEqual([]);
  });

  it("removes a recoverable runtime-start alert even before agent output", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "runtime-alert",
        content: "Runtime is still connecting.",
        timestamp: 100,
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          runId: "run-1",
          details: {
            reason: "runtime_not_ready",
          },
        },
      }),
    ];

    expect(collapseLifecycleMessages(messages)).toEqual([]);
  });

  it("keeps a terminal runtime-start failure actionable", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "runtime-alert",
        content: "Octo couldn't start its workspace.",
        timestamp: 100,
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          runId: "run-1",
          details: {
            reason: "runtime_not_ready",
            reconnect: { status: "failed" },
          },
        },
      }),
    ];

    expect(collapseLifecycleMessages(messages).map((message) => message.id)).toEqual(["runtime-alert"]);
  });

  it("keeps a stopped runtime alert actionable when reconnect metadata is absent", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "runtime-alert",
        content: "Octo couldn't start its workspace.",
        timestamp: 100,
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          runId: "run-1",
          details: {
            reason: "runtime_not_ready",
            detail: "status=stopped, lastSeen=unknown",
          },
        },
      }),
    ];

    expect(collapseLifecycleMessages(messages).map((message) => message.id)).toEqual(["runtime-alert"]);
  });

  it("hides redundant setup summaries when the same job emitted a multi-agent plan", () => {
    const setupSummary = createMessage({
      id: "setup-summary",
      content: "I am setting up four sibling lanes and then I will synthesize the result.",
      metadata: {
        source: "agent",
        outcome: "succeeded",
        jobId: "plan-job-1",
      },
    });
    const planCard = createMessage({
      id: "plan-card",
      content: "I'm splitting this into workstreams.",
      messageType: "multi_agent_plan",
      metadata: {
        source: "agent",
        outcome: "succeeded",
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          mode: "read_only",
          agents: [{ handle: "front", prompt: "Inspect frontend." }],
        },
      },
    });

    expect(collapseLifecycleMessages([setupSummary, planCard]).map((message) => message.id)).toEqual([
      "plan-card",
    ]);
  });

  it("uses the team plan as the anchor when planning also ran prep commands", () => {
    const command = createMessage({
      id: "prep-command",
      content: "git clone https://github.com/example/repo sources/example",
      timestamp: 100,
      messageType: "command_execution",
      metadata: {
        jobId: "plan-job-1",
        messageType: "command_execution",
      },
    });
    const progress = createMessage({
      id: "prep-status",
      content: "Preparing shared source checkout...",
      timestamp: 200,
      metadata: {
        kind: "update",
        source: "agent",
        outcome: "in_progress",
        jobId: "plan-job-1",
      },
    });
    const planCard = createMessage({
      id: "plan-card",
      content: "I'm splitting this into workstreams.",
      timestamp: 300,
      messageType: "multi_agent_plan",
      metadata: {
        source: "agent",
        outcome: "succeeded",
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          mode: "read_only",
          agents: [{ handle: "binary", prompt: "Inspect binary codecs." }],
        },
      },
    });
    const setupSummary = createMessage({
      id: "setup-summary",
      content: "Using the prepared checkout, I started the workstreams.",
      timestamp: 400,
      metadata: {
        source: "agent",
        outcome: "succeeded",
        jobId: "plan-job-1",
      },
    });

    const collapsedAll = collapseLifecycleMessages([command, progress, planCard, setupSummary]);
    const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
    const synthesized = synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible);

    expect(collapsedAll.map((message) => message.id)).toEqual(["plan-card"]);
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]?.id).toBe("plan-card");
    expect(synthesized[0]?.messageType).toBe("multi_agent_plan");
  });

  it("hides successful multi-agent worker evidence from the root transcript", () => {
    const workerResult = createMessage({
      id: "worker-result",
      content: "Detailed worker evidence that belongs behind the workstream refs.",
      metadata: {
        source: "agent",
        outcome: "succeeded",
        agent: { handle: "front" },
        jobId: "worker-job-1",
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    });

    expect(shouldDisplayChatMessage(workerResult)).toBe(false);
  });

  it("keeps successful multi-agent worker evidence available inside run traces", () => {
    const workerResult = createMessage({
      id: "worker-result",
      content: "Detailed worker evidence that belongs behind the workstream refs.",
      metadata: {
        source: "agent",
        outcome: "succeeded",
        agent: { handle: "front" },
        jobId: "worker-job-1",
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    });

    expect(shouldDisplayChatMessage(workerResult)).toBe(false);
    expect(shouldDisplayJobThreadMessage(workerResult)).toBe(true);
  });

  it("keeps failed multi-agent worker messages under the plan instead of flooding root chat", () => {
    const workerFailure = createMessage({
      id: "worker-failure",
      content: "Worker failed before producing evidence.",
      messageType: "error",
      metadata: {
        source: "agent",
        outcome: "failed",
        messageType: "error",
        agent: { handle: "api" },
        jobId: "worker-job-2",
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    });

    expect(shouldDisplayChatMessage(workerFailure)).toBe(false);
    expect(shouldDisplayJobThreadMessage(workerFailure)).toBe(true);
  });

  it("keeps lead continuation replies visible in the root transcript", () => {
    const leadReply = createMessage({
      id: "lead-reply",
      content: "Here is the final severity-ranked report.",
      metadata: {
        source: "agent",
        outcome: "succeeded",
        agent: { handle: "octo" },
        jobId: "lead-job-1",
        multiAgentPlan: {
          role: "lead_continuation",
          groupId: "group-1",
        },
      },
    });

    expect(shouldDisplayChatMessage(leadReply)).toBe(true);
  });
});
