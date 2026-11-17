import { describe, expect, it } from "vitest";
import {
  activeGoalPromptMetadata,
  applyGoalCommand,
  assessGoalStagnation,
  buildGoalContinuationPrompt,
  buildGoalReviewContext,
  buildGoalStartPrompt,
  buildGoalUnblockHelpPrompt,
  buildConversationGoalHealth,
  countGoalContinuationTurns,
  createConversationGoal,
  extractConversationGoalFromMetadata,
  hasNonRecoverableErrorForRun,
  isNonRecoverableRunErrorMessage,
  normalizeConversationGoalProgressSummaryForDisplay,
  parseGoalCommand,
  resolveGoalCommandDispatch,
  shouldApplyConversationGoalSnapshot,
} from "../conversationGoals";

const assistantRunMessage = (runId: string, content = "run finished") => ({
  id: `assistant-${runId}`,
  role: "assistant" as const,
  content,
  timestamp: Date.now(),
  metadata: {
    runId,
  },
});

describe("conversationGoals", () => {
  it("parses goal commands without treating normal prompts as goals", () => {
    expect(parseGoalCommand("1+1?")).toBeNull();
    expect(parseGoalCommand("/goal finish the ESP32 check")).toEqual({
      kind: "set",
      objective: "finish the ESP32 check",
    });
    expect(parseGoalCommand("/goal pause")).toEqual({ kind: "pause" });
  });

  it("applies goal lifecycle commands", () => {
    const started = applyGoalCommand(null, { kind: "set", objective: "Ship goal state" }, "u1");
    expect(started.changed).toBe(true);
    expect(started.goal?.status).toBe("active");

    const paused = applyGoalCommand(started.goal, { kind: "pause" }, "u1");
    expect(paused.goal?.status).toBe("paused");

    const resumed = applyGoalCommand(paused.goal, { kind: "resume" }, "u1");
    expect(resumed.goal?.status).toBe("active");

    const completed = applyGoalCommand(
      resumed.goal,
      { kind: "complete", progressSummary: "validated" },
      "u1",
    );
    expect(completed.goal?.status).toBe("completed");
    expect(completed.goal?.progressSummary).toBe("validated");
  });

  it("only sends active goals to the runtime prompt", () => {
    const goal = createConversationGoal("Keep working until validated", "u1");
    expect(activeGoalPromptMetadata(goal)?.objective).toBe("Keep working until validated");

    const paused = applyGoalCommand(goal, { kind: "pause" }, "u1").goal;
    expect(activeGoalPromptMetadata(paused)).toBeNull();
  });

  it("normalizes legacy provider quota blocker summaries for display", () => {
    expect(
      normalizeConversationGoalProgressSummaryForDisplay(
        "AI request failed because credits or provider quota are unavailable.",
      ),
    ).toBe("AI request is blocked by upstream provider quota or rate limits.");
    expect(normalizeConversationGoalProgressSummaryForDisplay("waiting on hardware")).toBe(
      "waiting on hardware",
    );
  });

  it("dispatches only active goal start commands to the assistant", () => {
    const started = applyGoalCommand(null, { kind: "set", objective: "count to 3" }, "u1");
    const dispatchInput =
      resolveGoalCommandDispatch({
        command: { kind: "set", objective: "count to 3" },
        goal: started.goal,
      })?.input ?? null;
    expect(dispatchInput).toContain("Start the active goal: count to 3");
    expect(dispatchInput).toContain("gather relevant safe evidence before declaring it blocked");
    expect(dispatchInput).toContain("Automatic goal loops can call you again");
    expect(dispatchInput).toContain("do the next useful step in this turn and keep the goal active");
    expect(dispatchInput).toContain("Do not block only because no evidence has been gathered yet");

    const paused = applyGoalCommand(started.goal, { kind: "pause" }, "u1");
    expect(resolveGoalCommandDispatch({ command: { kind: "pause" }, goal: paused.goal })).toBeNull();
    expect(
      resolveGoalCommandDispatch({
        command: { kind: "complete", progressSummary: null },
        goal: started.goal,
      }),
    ).toBeNull();
  });

  it("dispatches resumed goals as continuation turns", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const dispatch = resolveGoalCommandDispatch({
      command: { kind: "resume" },
      goal,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Continue goal: count to 3",
          timestamp: Date.now(),
          metadata: {
            goal: { id: "goal-1" },
            goalContinuation: { turn: 1 },
          },
        },
      ],
    });

    expect(dispatch?.continuationTurn).toBe(2);
    expect(dispatch?.input).toContain("Continue the active goal: count to 3");
    expect(dispatch?.input).toContain("automatic goal continuation turn 2");
    expect(dispatch?.input).toContain("Automatic goal loops can call you again");
    expect(dispatch?.input).toContain("do the next useful step in this turn and keep the goal active");
    expect(dispatch?.input).toContain("Do not block only because no evidence has been gathered yet");
  });

  it("extracts persisted goals", () => {
    const goal = extractConversationGoalFromMetadata({
      instafyGoal: {
        id: "goal-1",
        objective: "Finish the contract",
        status: "active",
      },
    });
    expect(goal?.objective).toBe("Finish the contract");
  });

  it("does not let stale active metadata reopen a completed goal", () => {
    const activeGoal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
      createdAt: "2026-05-27T10:00:00.000Z",
      updatedAt: "2026-05-27T10:00:00.000Z",
    };
    const completedGoal = {
      ...activeGoal,
      status: "completed" as const,
      progressSummary: "answered with 1, 2, 3",
      updatedAt: "2026-05-27T10:00:05.000Z",
    };

    expect(shouldApplyConversationGoalSnapshot(completedGoal, activeGoal)).toBe(false);
    expect(
      shouldApplyConversationGoalSnapshot(completedGoal, {
        ...activeGoal,
        status: "active",
        updatedAt: "2026-05-27T10:00:10.000Z",
      }),
    ).toBe(true);
  });

  it("identifies non-recoverable quota error messages by run", () => {
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "Upstream 429 rejected the AI request (insufficient_quota).",
      messageType: "error",
      timestamp: Date.now(),
      metadata: {
        runId: "run-1",
        messageType: "error",
      },
    };

    expect(isNonRecoverableRunErrorMessage(message, "run-1")).toBe(true);
    expect(isNonRecoverableRunErrorMessage(message, "run-2")).toBe(false);
  });

  it("matches runless quota errors back to the pending goal run", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "/goal count to 3",
        timestamp: 1000,
        metadata: {
          runId: "run-1",
          prompt_metadata: {
            goal: {
              id: "goal-1",
              objective: "count to 3",
            },
          },
        },
      },
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Upstream 429 rejected the AI request (insufficient_quota).",
        messageType: "error",
        timestamp: 1001,
        metadata: {
          messageType: "error",
        },
      },
    ];

    expect(hasNonRecoverableErrorForRun(messages, "run-1", goal)).toBe(true);
    expect(hasNonRecoverableErrorForRun(messages, "run-2", goal)).toBe(false);

    // A newer prompt that is not the goal's stands between the goal run and the error.
    const withNewerUnrelatedPrompt = [
      messages[0],
      {
        id: "user-2",
        role: "user" as const,
        content: "What is 1+1?",
        timestamp: 1001,
        metadata: {},
      },
      { ...messages[1], timestamp: 1002 },
    ];
    expect(hasNonRecoverableErrorForRun(withNewerUnrelatedPrompt, "run-1", goal)).toBe(false);
  });

  it("reports no stagnation for a goal that has not continued yet", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };

    expect(assessGoalStagnation({ goal, messages: [] })).toEqual({
      level: "none",
      reason: "none",
      summary: null,
    });
  });

  it("warns when automatic goal continuations repeat assistant output", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const messages = [1, 2, 3].flatMap((turn) => [
      {
        id: `user-${turn}`,
        role: "user" as const,
        content: "Continue goal: count to 50",
        timestamp: Date.now(),
        metadata: {
          runId: `run-${turn}`,
          goal: {
            id: "goal-1",
          },
          goalContinuation: {
            turn,
          },
        },
      },
      {
        id: `assistant-${turn}`,
        role: "assistant" as const,
        content: turn === 1 ? "1, 2, 3" : "Still counting.",
        timestamp: Date.now(),
        metadata: {
          runId: `run-${turn}`,
        },
      },
    ]);

    expect(assessGoalStagnation({ goal, messages })).toEqual({
      level: "warning",
      reason: "repeated_assistant_output",
      summary:
        "Recent automatic goal turns look repetitive. The next turn should complete, block, or change strategy.",
    });
    expect(buildConversationGoalHealth({ goal, messages })?.tone).toBe("warning");
    expect(
      buildGoalContinuationPrompt({
        goal,
        turn: 4,
        stagnation: assessGoalStagnation({ goal, messages }),
      }),
    ).toContain("Goal health warning");
  });

  it("adds recent loop evidence and review instructions to continuation prompts", () => {
    const goal = {
      ...createConversationGoal("find the next useful device check", "u1"),
      id: "goal-1",
    };
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "Continue goal: find the next useful device check",
        timestamp: Date.now(),
        metadata: {
          runId: "run-1",
          goal: {
            id: "goal-1",
          },
          goalContinuation: {
            turn: 1,
          },
        },
      },
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "I will keep looking for the next check.",
        timestamp: Date.now(),
        metadata: {
          runId: "run-1",
        },
      },
      {
        id: "user-2",
        role: "user" as const,
        content: "Continue goal: find the next useful device check",
        timestamp: Date.now(),
        metadata: {
          runId: "run-2",
          goal: {
            id: "goal-1",
          },
          goalContinuation: {
            turn: 2,
          },
        },
      },
      {
        id: "assistant-2-command",
        role: "assistant" as const,
        content: "rg -n check_real_ble_status",
        messageType: "command_execution",
        timestamp: Date.now(),
        metadata: {
          runId: "run-2",
          messageType: "command_execution",
        },
      },
      {
        id: "assistant-2",
        role: "assistant" as const,
        content: "The next check is the BLE status preflight.",
        timestamp: Date.now(),
        metadata: {
          runId: "run-2",
        },
      },
    ];

    const reviewContext = buildGoalReviewContext({ goal, messages });
    expect(reviewContext).toContain("turn 1: no tool/file activity observed");
    expect(reviewContext).toContain("turn 2: tool/file activity observed");
    expect(reviewContext).toContain("The next check is the BLE status preflight.");

    const prompt = buildGoalContinuationPrompt({
      goal,
      turn: 3,
      messages,
    });
    expect(prompt).toContain("Recent automatic goal-loop evidence");
    expect(prompt).toContain("Before doing more work, review whether the last automatic turns materially advanced the goal.");
    expect(prompt).toContain("emit a blocked goal_update with the concrete blocker");
  });

  it("builds evidence-first prompts for newly started goals", () => {
    const goal = createConversationGoal("inspect the workspace and choose the next task", "u1");
    const prompt = buildGoalStartPrompt({ goal });

    expect(prompt).toContain(
      "Start the active goal: inspect the workspace and choose the next task",
    );
    expect(prompt).toContain("Use available tools or project context");
    expect(prompt).toContain("Do not block only because no evidence has been gathered yet");
    expect(prompt).toContain("emit a goal_update with status completed");
  });

  it("builds an auditable same-chat unblock prompt for blocked goals", () => {
    const goal = createConversationGoal("verify the ESP32 board is connected", "u1");
    const prompt = buildGoalUnblockHelpPrompt({
      goal,
      blocker: "No live serial evidence is available.",
    });

    expect(prompt).toContain("Help me unblock this goal.");
    expect(prompt).toContain("Goal: verify the ESP32 board is connected");
    expect(prompt).toContain("Blocked because: No live serial evidence is available.");
    expect(prompt).toContain("Do not resume or change the goal automatically unless I ask.");
  });

  it("assesses repeated stagnant outputs as blocked", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const messages = [1, 2, 3, 4, 5].flatMap((turn) => [
      {
        id: `user-${turn}`,
        role: "user" as const,
        content: "Continue goal: count to 50",
        timestamp: Date.now(),
        metadata: {
          runId: `run-${turn}`,
          goal: {
            id: "goal-1",
          },
          goalContinuation: {
            turn,
          },
        },
      },
      {
        id: `assistant-${turn}`,
        role: "assistant" as const,
        content: turn <= 2 ? `Counting pass ${turn}.` : "Still counting.",
        timestamp: Date.now(),
        metadata: {
          runId: `run-${turn}`,
        },
      },
    ]);

    expect(assessGoalStagnation({ goal, messages }).level).toBe("blocked");
  });

  it("counts automatic goal turns from continuation turn metadata", () => {
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "Continue goal: keep going",
        timestamp: Date.now(),
        metadata: {
          prompt_metadata: {
            goal: {
              id: "goal-1",
            },
            goalContinuation: {
              turn: 2,
            },
          },
        },
      },
      {
        id: "user-2",
        role: "user" as const,
        content: "Continue goal: keep going",
        timestamp: Date.now(),
        metadata: {
          goal: {
            id: "goal-1",
          },
          goalContinuation: {
            turn: 1,
          },
        },
      },
      assistantRunMessage("run-3", "still going"),
    ];

    expect(countGoalContinuationTurns(messages, "goal-1")).toBe(2);
  });
});
