import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import {
  agentJobThreadAcknowledgementIds,
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

  // A local test: the card of a turn that ran one `instafy preview open`
  // arrived as its own "octo" message above that turn.
  it("draws a card posted before the run's first visible step inside the run's turn, once", () => {
    const card = createMessage({
      id: "card",
      content: "Ready to preview",
      timestamp: 150,
      messageType: "action_request",
      metadata: {
        jobId: "job-1",
        messageType: "action_request",
        details: { messageType: "action_request", details: { testId: "preview-ready-card" } },
      },
    });
    const messages: ChatMessage[] = [
      createMessage({
        id: "patch",
        content: "Applying changes to workspace...",
        timestamp: 50,
        messageType: "file_change",
        metadata: { jobId: "job-1", messageType: "file_change" },
      }),
      createMessage({
        id: "command-started",
        content: "instafy preview open",
        timestamp: 100,
        messageType: "command_execution",
        metadata: { jobId: "job-1", messageType: "command_execution", details: { itemId: "item-1" } },
      }),
      // The card is posted while the command that opens it is still running.
      card,
      createMessage({
        id: "command-done",
        content: "instafy preview open",
        timestamp: 200,
        messageType: "command_execution",
        metadata: { jobId: "job-1", messageType: "command_execution", details: { itemId: "item-1" } },
      }),
      createMessage({ id: "final", content: "Your site is ready.", timestamp: 300, metadata: { jobId: "job-1" } }),
    ];

    const collapsedAll = collapseLifecycleMessages(messages);
    const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
    const synthesized = synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible);

    expect(synthesized.map((message) => message.id)).toEqual(["agent-job-thread:job-1"]);
    const thread = synthesized[0]!;
    const nested = (thread.metadata as Record<string, unknown>).threadMessages as ChatMessage[];
    expect(nested.map((message) => message.id)).toEqual(["patch", "card", "command-done", "final"]);
    // The run still starts when its first update did.
    expect(thread.timestamp).toBe(50);
  });

  it("leaves a card of a run with no step as its own message", () => {
    const messages: ChatMessage[] = [
      createMessage({
        id: "browser-card",
        content: "Continue this task in Instafy's browser.",
        timestamp: 100,
        messageType: "action_request",
        metadata: { jobId: "job-2", messageType: "action_request", details: { testId: "browser-request-card" } },
      }),
      createMessage({ id: "reply", content: "The browser will open the site.", timestamp: 200, metadata: { jobId: "job-2" } }),
    ];
    const collapsedAll = collapseLifecycleMessages(messages);
    const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
    expect(synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible).map((message) => message.id)).toEqual([
      "browser-card",
      "reply",
    ]);
  });

  it("lists the replies a synthesized job thread row presents, newest first, for read acknowledgement", () => {
    const collapsedAll: ChatMessage[] = [
      createMessage({ id: "command", content: "ls", messageType: "command_execution", metadata: { jobId: "job-1", messageType: "command_execution" } }),
      createMessage({ id: "interim", content: "Looking at the files.", metadata: { jobId: "job-1" } }),
      createMessage({ id: "empty", content: "  ", metadata: { jobId: "job-1" } }),
      createMessage({ id: "final", content: "Done: mango added.", metadata: { jobId: "job-1" } }),
    ];
    const [thread] = synthesizeAgentJobThreadMessages(collapsedAll, collapsedAll);
    expect(thread?.id).toBe("agent-job-thread:job-1");
    expect(agentJobThreadAcknowledgementIds(thread!)).toEqual(["final", "interim"]);
    expect(agentJobThreadAcknowledgementIds(createMessage({ id: "plain", content: "hi" }))).toEqual([]);
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

  it("keeps the cards a multi-agent worker lane posts for the person in the main transcript", () => {
    const workerJob = { jobId: "builder-job-1" };
    const card = (id: string, messageType: string, details: Record<string, unknown>) => createMessage({
      id,
      content: "The lane needs you.",
      timestamp: 150,
      metadata: {
        ...workerJob,
        source: "agent",
        messageType,
        details: { messageType, details },
      },
    });
    const messages: ChatMessage[] = [
      createMessage({
        id: "builder-command",
        content: "Running command...",
        timestamp: 100,
        messageType: "command_execution",
        metadata: { ...workerJob, messageType: "command_execution" },
      }),
      card("builder-preview", "action_request", {
        title: "Site preview",
        preview: { previewId: "11111111-1111-4111-8111-111111111111", port: 4173, path: "/" },
      }),
      // Every card that asks the person for something stays, whatever it asks.
      card("builder-question", "action_request", { title: "Which colour?", inputPlaceholder: "Colour" }),
      card("builder-secret", "secret_request", { secretName: "SHOP_TOKEN" }),
      // The lane's other output stays behind the plan with the rest of its work.
      createMessage({
        id: "builder-status",
        content: "Wrote the page.",
        timestamp: 160,
        messageType: "status",
        metadata: { ...workerJob, messageType: "status" },
      }),
      createMessage({
        id: "builder-result",
        content: "Built the site from five handoff files.",
        timestamp: 200,
        metadata: {
          ...workerJob,
          multiAgentPlan: { role: "worker", parentJobId: "plan-job-1", groupId: "group-1" },
        },
      }),
    ];

    const collapsedAll = collapseLifecycleMessages(messages);
    const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
    const rows = synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible);

    expect(rows.map((message) => message.id)).toEqual(["builder-preview", "builder-question", "builder-secret"]);
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

  describe("private runtime refusals written by the controller", () => {
    const refusal = "Instafy AI runs on Instafy-hosted runtimes. Connect your own AI to use this runtime.";

    function presentRootTranscript(messages: ChatMessage[]): ChatMessage[] {
      const collapsedAll = collapseLifecycleMessages(messages);
      const collapsedVisible = collapsedAll.filter((message) => shouldDisplayChatMessage(message));
      return synthesizeAgentJobThreadMessages(collapsedAll, collapsedVisible);
    }

    function threadMessageIds(message: ChatMessage | undefined): string[] {
      const threadMessages = (message?.metadata as Record<string, unknown> | null | undefined)?.threadMessages;
      return Array.isArray(threadMessages) ? (threadMessages as ChatMessage[]).map((entry) => entry.id) : [];
    }

    const userMessage = createMessage({
      id: "user-request",
      role: "user",
      content: "Split this review across a team.",
      timestamp: 100,
      metadata: { clientMessageId: "client-1" },
    });
    // The planning agent's plan, as /agent/message records it.
    const planAnnouncement = createMessage({
      id: "plan-announcement",
      content: "Two scouts will read the README and the docs.",
      timestamp: 200,
      messageType: "multi_agent_plan",
      metadata: {
        source: "agent",
        outcome: "in_progress",
        kind: "update",
        jobId: "plan-job-1",
        messageType: "multi_agent_plan",
        multiAgentPlan: {
          mode: "read_only",
          agents: [
            { handle: "scout-a", prompt: "Read the README." },
            { handle: "scout-b", prompt: "Read the docs folder." },
          ],
        },
        details: {
          mode: "read_only",
          agents: [
            { handle: "scout-a", prompt: "Read the README." },
            { handle: "scout-b", prompt: "Read the docs folder." },
          ],
        },
      },
    });

    it("shows a refused plan's announcement and the refusal", () => {
      const planRefusal = createMessage({
        id: "plan-refusal",
        content: `The plan's agents could not start. ${refusal}`,
        timestamp: 300,
        messageType: "error",
        metadata: {
          source: "controller",
          kind: "managed_ai_hosted_runtime_required",
          outcome: "failed",
          messageType: "error",
          jobId: "plan-job-1",
          runId: "plan-run-1",
          errorMessage: `The plan's agents could not start. ${refusal}`,
          agent: { handle: "planner" },
          multiAgentPlan: { groupId: "group-1" },
        },
      });

      const transcript = presentRootTranscript([userMessage, planAnnouncement, planRefusal]);

      expect(transcript.map((message) => message.id)).toEqual([
        "user-request",
        "plan-announcement",
        "agent-job-thread:plan-job-1",
      ]);
      expect(transcript[1]?.messageType).toBe("multi_agent_plan");
      // The planning job's failed run, ending on the refusal.
      expect(threadMessageIds(transcript[2])).toEqual(["plan-announcement", "plan-refusal"]);
    });

    it("shows a refused lead checkpoint in the root transcript", () => {
      const workerResult = createMessage({
        id: "worker-result",
        content: "Read the README.",
        timestamp: 300,
        metadata: {
          source: "agent",
          outcome: "succeeded",
          agent: { handle: "scout-a" },
          jobId: "worker-job-1",
          multiAgentPlan: { role: "worker", parentJobId: "plan-job-1", groupId: "group-1" },
        },
      });
      const leadRefusal = createMessage({
        id: "lead-refusal",
        content: `@octo could not continue the plan. ${refusal}`,
        timestamp: 400,
        messageType: "error",
        metadata: {
          source: "controller",
          kind: "managed_ai_hosted_runtime_required",
          outcome: "failed",
          messageType: "error",
          errorMessage: `@octo could not continue the plan. ${refusal}`,
          multiAgentPlan: {
            groupId: "group-1",
            role: "lead_continuation",
            checkpointKind: "final",
            triggerJobId: "worker-job-1",
          },
        },
      });

      const transcript = presentRootTranscript([userMessage, planAnnouncement, workerResult, leadRefusal]);

      expect(transcript.map((message) => message.id)).toEqual([
        "user-request",
        "plan-announcement",
        "lead-refusal",
      ]);
    });

    it("shows the idle sweep's failure of a job no hosted runtime could take", () => {
      // A plan worker that never started, failed by the sweep.
      const sweepFailure = createMessage({
        id: "sweep-failure",
        content: refusal,
        timestamp: 300,
        messageType: "error",
        metadata: {
          source: "controller",
          kind: "managed_ai_hosted_runtime_required",
          outcome: "failed",
          messageType: "error",
          jobId: "worker-job-2",
          runId: "worker-run-2",
          errorMessage: refusal,
          agent: { handle: "scout-b" },
        },
      });

      const transcript = presentRootTranscript([userMessage, planAnnouncement, sweepFailure]);

      expect(transcript.map((message) => message.id)).toEqual([
        "user-request",
        "plan-announcement",
        "agent-job-thread:worker-job-2",
      ]);
      expect(threadMessageIds(transcript[2])).toEqual(["sweep-failure"]);
    });
  });
});
