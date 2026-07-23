import { describe, expect, it } from "vitest";
import {
  activeGoalPromptMetadata,
  applyGoalActionMessage,
  applyGoalCommand,
  assessGoalStagnation,
  buildGoalContinuationPrompt,
  buildGoalReviewContext,
  buildGoalStartPrompt,
  buildGoalUnblockHelpPrompt,
  buildConversationGoalHealth,
  countGoalContinuationTurns,
  createConversationGoal,
  decideGoalContinuation,
  extractConversationGoalFromMetadata,
  hasNonRecoverableErrorForRun,
  isNonRecoverableRunErrorMessage,
  normalizeConversationGoalProgressSummaryForDisplay,
  parseGoalCommand,
  resolveNonRecoverableGoalErrorRunId,
  resolveGoalCommandDispatch,
  resolveGoalCommandDispatchInput,
  selectLatestSuccessfulGoalRuns,
  settleGoalAfterNonRecoverableRunError,
  settleGoalAfterTerminalRun,
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
    const dispatchInput = resolveGoalCommandDispatchInput(
      { kind: "set", objective: "count to 3" },
      started.goal,
    );
    expect(dispatchInput).toContain("Start the active goal: count to 3");
    expect(dispatchInput).toContain("gather relevant safe evidence before declaring it blocked");
    expect(dispatchInput).toContain("Automatic goal loops can call you again");
    expect(dispatchInput).toContain("do the next useful step in this turn and keep the goal active");
    expect(dispatchInput).toContain("Do not block only because no evidence has been gathered yet");

    const paused = applyGoalCommand(started.goal, { kind: "pause" }, "u1");
    expect(resolveGoalCommandDispatchInput({ kind: "pause" }, paused.goal)).toBeNull();
    expect(resolveGoalCommandDispatchInput({ kind: "complete", progressSummary: null }, started.goal)).toBeNull();
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

  it("extracts persisted goals and applies assistant goal updates", () => {
    const goal = extractConversationGoalFromMetadata({
      instafyGoal: {
        id: "goal-1",
        objective: "Finish the contract",
        status: "active",
      },
    });
    expect(goal?.objective).toBe("Finish the contract");

    const updated = applyGoalActionMessage(
      goal,
      {
        id: "msg-1",
        role: "assistant",
        content: "Goal blocked: waiting on hardware.",
        messageType: "goal_update",
        metadata: {
          messageType: "goal_update",
          details: {
            status: "blocked",
            progressSummary: "waiting on hardware",
          },
        },
        timestamp: Date.now(),
      },
      "u1",
    );

    expect(updated.changed).toBe(true);
    expect(updated.goal?.status).toBe("blocked");
    expect(updated.goal?.progressSummary).toBe("waiting on hardware");
  });

  it("unwraps runtime metadata envelopes for assistant goal updates", () => {
    const goal = createConversationGoal("count to 3", "u1");
    const updated = applyGoalActionMessage(
      goal,
      {
        id: "msg-1",
        role: "assistant",
        content: "Goal completed: Answered the counting request.",
        messageType: "goal_update",
        metadata: {
          messageType: "goal_update",
          details: {
            kind: "runtime_selection",
            runtimeId: "runtime-1",
            displayName: "Hosted Runtime",
            messageType: "goal_update",
            details: {
              status: "completed",
              objective: "count to 3",
              progressSummary: "Answered the counting request.",
            },
          },
        },
        timestamp: Date.now(),
      },
      "u1",
    );

    expect(updated.changed).toBe(true);
    expect(updated.goal?.status).toBe("completed");
    expect(updated.goal?.progressSummary).toBe("Answered the counting request.");
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

  it("blocks an active goal when its runtime run fails", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const result = settleGoalAfterTerminalRun(
      goal,
      { goal: { id: "goal-1", objective: "count to 3" } },
      "failed",
      "u1",
    );

    expect(result.changed).toBe(true);
    expect(result.goal?.status).toBe("blocked");
    expect(result.goal?.progressSummary).toBe("Run failed before the goal completed.");
  });

  it("does not block an active goal for a different runtime goal id", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const result = settleGoalAfterTerminalRun(
      goal,
      { goal: { id: "goal-2", objective: "other task" } },
      "failed",
      "u1",
    );

    expect(result.changed).toBe(false);
    expect(result.goal?.status).toBe("active");
  });

  it("does not block an active goal for runs without goal metadata", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const result = settleGoalAfterTerminalRun(goal, {}, "failed", "u1");

    expect(result.changed).toBe(false);
    expect(result.goal?.status).toBe("active");
  });

  it("blocks an active goal when its run receives a non-recoverable quota error", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const result = settleGoalAfterNonRecoverableRunError(
      goal,
      [
        {
          id: "user-1",
          role: "user",
          content: "/goal count to 3",
          timestamp: Date.now(),
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
      ],
      {
        id: "assistant-1",
        role: "assistant",
        content:
          "backend responded with 429 Too Many Requests: {\"error\":{\"type\":\"insufficient_quota\"}}",
        messageType: "error",
        timestamp: Date.now(),
        metadata: {
          runId: "run-1",
          messageType: "error",
        },
      },
      "u1",
    );

    expect(result.changed).toBe(true);
    expect(result.goal?.status).toBe("blocked");
    expect(result.goal?.progressSummary).toBe(
      "AI request is blocked by upstream provider quota or rate limits.",
    );
  });

  it("blocks an active goal when a non-recoverable quota error lacks a run id but follows its goal prompt", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const result = settleGoalAfterNonRecoverableRunError(
      goal,
      [
        {
          id: "user-1",
          role: "user",
          content: "/goal count to 3",
          timestamp: 1000,
          metadata: {
            prompt_metadata: {
              goal: {
                id: "goal-1",
                objective: "count to 3",
              },
            },
          },
        },
      ],
      {
        id: "assistant-1",
        role: "assistant",
        content: "Upstream 429 rejected the AI request (insufficient_quota).",
        messageType: "error",
        timestamp: 1001,
        metadata: {
          messageType: "error",
        },
      },
      "u1",
    );

    expect(result.changed).toBe(true);
    expect(result.goal?.status).toBe("blocked");
    expect(result.goal?.progressSummary).toBe(
      "AI request is blocked by upstream provider quota or rate limits.",
    );
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

  it("resolves the pending goal run id from non-recoverable quota errors", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const userMessage = {
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
    };

    expect(
      resolveNonRecoverableGoalErrorRunId(
        goal,
        [userMessage],
        {
          id: "assistant-1",
          role: "assistant",
          content: "Upstream 429 rejected the AI request (insufficient_quota).",
          messageType: "error",
          timestamp: 1001,
          metadata: {
            runId: "run-1",
            messageType: "error",
          },
        },
      ),
    ).toBe("run-1");
    expect(
      resolveNonRecoverableGoalErrorRunId(
        goal,
        [userMessage],
        {
          id: "assistant-2",
          role: "assistant",
          content: "Upstream 429 rejected the AI request (insufficient_quota).",
          messageType: "error",
          timestamp: 1001,
          metadata: {
            messageType: "error",
          },
        },
      ),
    ).toBe("run-1");
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
  });

  it("does not block an active goal for unrelated quota errors", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const result = settleGoalAfterNonRecoverableRunError(
      goal,
      [
        {
          id: "user-1",
          role: "user",
          content: "unrelated prompt",
          timestamp: Date.now(),
          metadata: {
            runId: "run-1",
          },
        },
      ],
      {
        id: "assistant-1",
        role: "assistant",
        content:
          "backend responded with 429 Too Many Requests: {\"error\":{\"type\":\"insufficient_quota\"}}",
        messageType: "error",
        timestamp: Date.now(),
        metadata: {
          runId: "run-1",
          messageType: "error",
        },
      },
      "u1",
    );

    expect(result.changed).toBe(false);
    expect(result.goal?.status).toBe("active");
  });

  it("does not block an active goal for runless quota errors after a newer unrelated user prompt", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const result = settleGoalAfterNonRecoverableRunError(
      goal,
      [
        {
          id: "user-1",
          role: "user",
          content: "/goal count to 3",
          timestamp: 1000,
          metadata: {
            prompt_metadata: {
              goal: {
                id: "goal-1",
                objective: "count to 3",
              },
            },
          },
        },
        {
          id: "user-2",
          role: "user",
          content: "What is 1+1?",
          timestamp: 1001,
          metadata: {},
        },
      ],
      {
        id: "assistant-1",
        role: "assistant",
        content: "Upstream 429 rejected the AI request (insufficient_quota).",
        messageType: "error",
        timestamp: 1002,
        metadata: {
          messageType: "error",
        },
      },
      "u1",
    );

    expect(result.changed).toBe(false);
    expect(result.goal?.status).toBe("active");
  });

  it("continues an active goal after a successful matching goal run", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-1",
        status: "success",
        metadata: {
          goal: {
            id: "goal-1",
            objective: "count to 50",
          },
        },
      },
      messages: [assistantRunMessage("run-1", "1")],
      pendingRuns: [],
    });

    expect(decision).toEqual({
      shouldContinue: true,
      nextTurn: 1,
      reason: "continue",
      stagnation: {
        level: "none",
        reason: "none",
        summary: null,
      },
    });
    expect(buildGoalContinuationPrompt({ goal, turn: decision.nextTurn })).toContain(
      "automatic goal continuation turn 1",
    );
  });

  it("continues after a successful run that created the active goal", () => {
    const goal = {
      ...createConversationGoal("Count to three, one number per turn", "u1"),
      id: "goal-1",
    };
    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-1",
        status: "success",
        metadata: {},
      },
      messages: [
        {
          id: "goal-update-1",
          role: "assistant",
          content: "Goal started.",
          timestamp: Date.now(),
          messageType: "goal_update",
          metadata: {
            runId: "run-1",
            messageType: "goal_update",
            details: {
              status: "active",
              objective: "Count to three, one number per turn",
            },
          },
        },
      ],
      pendingRuns: [],
    });

    expect(decision.shouldContinue).toBe(true);
    expect(decision.reason).toBe("continue");
    expect(decision.nextTurn).toBe(1);
  });

  it("does not continue a goal while another run for the same goal is pending", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-1",
        status: "success",
        metadata: {
          goal: {
            id: "goal-1",
          },
        },
      },
      messages: [assistantRunMessage("run-1", "1")],
      pendingRuns: [
        {
          id: "run-2",
          status: "in_progress",
          metadata: {
            goal: {
              id: "goal-1",
            },
          },
        },
      ],
    });

    expect(decision.shouldContinue).toBe(false);
    expect(decision.reason).toBe("goal_run_already_pending");
  });

  it("does not request duplicate continuation for the same terminal run", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-1",
        status: "success",
        metadata: {
          goal: {
            id: "goal-1",
          },
        },
      },
      messages: [
        {
          id: "user-2",
          role: "user",
          content: "Continue goal: count to 50",
          timestamp: Date.now(),
          metadata: {
            goal: {
              id: "goal-1",
            },
            goalContinuation: {
              triggerRunId: "run-1",
              turn: 1,
            },
          },
        },
      ],
      pendingRuns: [],
    });

    expect(decision.shouldContinue).toBe(false);
    expect(decision.reason).toBe("goal_continuation_already_requested");
  });

  it("waits for successful run messages before continuing a goal", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-1",
        status: "success",
        metadata: {
          goal: {
            id: "goal-1",
          },
        },
      },
      messages: [],
      pendingRuns: [],
    });

    expect(decision.shouldContinue).toBe(false);
    expect(decision.reason).toBe("run_messages_pending");
  });

  it("does not continue after the terminal run emitted a completed goal update", () => {
    const goal = {
      ...createConversationGoal("count to 3", "u1"),
      id: "goal-1",
    };
    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-3",
        status: "success",
        metadata: {
          goal: {
            id: "goal-1",
          },
        },
      },
      messages: [
        {
          id: "assistant-3",
          role: "assistant",
          content: "Goal completed.",
          timestamp: Date.now(),
          messageType: "goal_update",
          metadata: {
            runId: "run-3",
            messageType: "goal_update",
            details: {
              status: "completed",
              progressSummary: "counted to 3",
            },
          },
        },
      ],
      pendingRuns: [],
    });

    expect(decision.shouldContinue).toBe(false);
    expect(decision.reason).toBe("terminal_goal_update_observed");
  });

  it("selects only the latest successful run for each active goal", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const selected = selectLatestSuccessfulGoalRuns({
      conversations: [
        {
          localId: "conversation-1",
          controllerId: "controller-1",
          activeGoal: goal,
        },
      ],
      runs: [
        {
          id: "run-1",
          status: "success",
          conversationId: "controller-1",
          createdAt: "2026-05-26T00:00:01.000Z",
          updatedAt: "2026-05-26T00:00:02.000Z",
          metadata: {
            goal: {
              id: "goal-1",
            },
          },
        },
        {
          id: "run-2",
          status: "success",
          conversationId: "controller-1",
          createdAt: "2026-05-26T00:00:03.000Z",
          updatedAt: "2026-05-26T00:00:04.000Z",
          metadata: {
            goal: {
              id: "goal-1",
            },
          },
        },
      ],
    });

    expect(selected.map((run) => run.id)).toEqual(["run-2"]);
  });

  it("selects a successful run that produced the active goal update", () => {
    const goal = {
      ...createConversationGoal("Count to three, one number per turn", "u1"),
      id: "goal-1",
    };
    const selected = selectLatestSuccessfulGoalRuns({
      conversations: [
        {
          localId: "conversation-1",
          controllerId: "controller-1",
          activeGoal: goal,
          messages: [
            {
              id: "goal-update-1",
              role: "assistant",
              content: "Goal started.",
              timestamp: Date.now(),
              messageType: "goal_update",
              metadata: {
                runId: "run-1",
                messageType: "goal_update",
                details: {
                  status: "active",
                  objective: "Count to three, one number per turn",
                },
              },
            },
          ],
        },
      ],
      runs: [
        {
          id: "run-1",
          status: "success",
          conversationId: "controller-1",
          metadata: {},
        },
      ],
    });

    expect(selected.map((run) => run.id)).toEqual(["run-1"]);
  });

  it("ignores successful runs that do not belong to the active goal", () => {
    const goal = {
      ...createConversationGoal("count to 50", "u1"),
      id: "goal-1",
    };
    const selected = selectLatestSuccessfulGoalRuns({
      conversations: [
        {
          localId: "conversation-1",
          controllerId: "controller-1",
          activeGoal: goal,
        },
      ],
      runs: [
        {
          id: "run-1",
          status: "success",
          conversationId: "controller-1",
          metadata: {
            goal: {
              id: "goal-2",
            },
          },
        },
        {
          id: "run-2",
          status: "failed",
          conversationId: "controller-1",
          metadata: {
            goal: {
              id: "goal-1",
            },
          },
        },
      ],
    });

    expect(selected).toEqual([]);
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

  it("blocks automatic goal continuation after repeated stagnant outputs", () => {
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

    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-5",
        status: "success",
        metadata: {
          goal: {
            id: "goal-1",
          },
        },
      },
      messages,
      pendingRuns: [],
    });

    expect(decision.shouldContinue).toBe(false);
    expect(decision.reason).toBe("stagnation_detected");
    expect(decision.stagnation?.level).toBe("blocked");
  });

  it("uses continuation turn metadata to stop automatic goal loops", () => {
    const goal = {
      ...createConversationGoal("keep going", "u1"),
      id: "goal-1",
    };
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
    const decision = decideGoalContinuation({
      goal,
      terminalRun: {
        id: "run-3",
        status: "success",
        metadata: {
          goal: {
            id: "goal-1",
          },
        },
      },
      messages,
      pendingRuns: [],
      maxTurns: 2,
    });

    expect(decision.shouldContinue).toBe(false);
    expect(decision.nextTurn).toBe(3);
    expect(decision.reason).toBe("turn_limit_reached");
    expect(decision.stagnation).toBeNull();
  });
});
