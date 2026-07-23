import { describe, expect, it } from "vitest";
import {
  buildGroupParticipationMetadata,
  buildUnavailableGroupParticipationMetadata,
  hasVisibleAssistantMessageForRun,
  isSkillModeAmbientDispatchMetadata,
  markPendingAgentEvaluationRun,
  readGroupParticipationAgentEvaluation,
  resolveGroupParticipationReplyTargets,
  shouldResolveAmbientGroupParticipation,
  shouldSuppressAgentEvaluationRunPresence,
  type AmbientGroupParticipationEligibility,
} from "../groupParticipation";

const BASE_ELIGIBILITY: AmbientGroupParticipationEligibility = {
  assistantEnabled: true,
  usesDefaultAssistantOnly: true,
  activeHandles: ["octo"],
  targetHandles: ["octo"],
  explicitMentionedHandles: [],
  defaultAssistantHandle: "octo",
  threadKind: null,
  ownerAgentHandle: null,
  hasTerminalCommand: false,
  hasBrowserTask: false,
  hasExplicitAssistantOverride: false,
  replyToOcto: false,
  isAmbientTurn: true,
};

describe("ambient group participation eligibility", () => {
  it("preflights only implicit default-Octo ambient turns", () => {
    const scenarios: Array<{
      label: string;
      patch: Partial<AmbientGroupParticipationEligibility>;
      expected: boolean;
    }> = [
      { label: "plain ambient turn", patch: {}, expected: true },
      {
        label: "explicit @octo mention",
        patch: { explicitMentionedHandles: ["octo"] },
        expected: false,
      },
      {
        label: "assistant-name override",
        patch: { hasExplicitAssistantOverride: true },
        expected: false,
      },
      {
        label: "reply to Octo",
        patch: { replyToOcto: true },
        expected: false,
      },
      {
        label: "terminal command",
        patch: { hasTerminalCommand: true },
        expected: false,
      },
      {
        label: "browser-routed task",
        patch: { hasBrowserTask: true },
        expected: false,
      },
      {
        label: "agent-owned thread",
        patch: { threadKind: "agent", ownerAgentHandle: "octo" },
        expected: false,
      },
      {
        label: "custom agent is active",
        patch: {
          usesDefaultAssistantOnly: false,
          activeHandles: ["octo", "reviewer"],
          targetHandles: ["octo", "reviewer"],
        },
        expected: false,
      },
      {
        label: "sticky custom-agent target",
        patch: { targetHandles: ["reviewer"] },
        expected: false,
      },
      {
        label: "assistant disabled",
        patch: { assistantEnabled: false, activeHandles: [], targetHandles: [] },
        expected: false,
      },
      {
        label: "special child turn",
        patch: { isAmbientTurn: false },
        expected: false,
      },
    ];

    for (const scenario of scenarios) {
      expect(
        shouldResolveAmbientGroupParticipation({
          ...BASE_ELIGIBILITY,
          ...scenario.patch,
        }),
        scenario.label,
      ).toBe(scenario.expected);
    }
  });

  it("distinguishes a reply to Octo from a reply to a human", () => {
    const messages = [
      {
        id: "human-message",
        role: "user" as const,
        content: "I prefer option A",
        timestamp: 1,
      },
      {
        id: "octo-message",
        role: "assistant" as const,
        content: "Option A has the lower migration risk.",
        timestamp: 2,
      },
    ];

    expect(
      resolveGroupParticipationReplyTargets(
        { replyContext: { messageId: "human-message" } },
        messages,
        "octo",
      ),
    ).toEqual({ replyToOcto: false, replyToHuman: true });
    expect(
      shouldResolveAmbientGroupParticipation({
        ...BASE_ELIGIBILITY,
        replyToOcto: false,
      }),
    ).toBe(true);

    expect(
      resolveGroupParticipationReplyTargets(
        { replyContext: { messageId: "octo-message" } },
        messages,
        "octo",
      ),
    ).toEqual({ replyToOcto: true, replyToHuman: false });
    expect(
      shouldResolveAmbientGroupParticipation({
        ...BASE_ELIGIBILITY,
        replyToOcto: true,
      }),
    ).toBe(false);
  });

  it("does not mistake custom agents or controller notices for Octo", () => {
    const messages = [
      {
        id: "custom-agent-message",
        role: "assistant" as const,
        content: "Review complete.",
        timestamp: 1,
        metadata: { agent: { handle: "reviewer" } },
      },
      {
        id: "runtime-notice",
        role: "assistant" as const,
        content: "Runtime is starting.",
        timestamp: 2,
        messageType: "runtime_alert",
      },
    ];

    expect(
      resolveGroupParticipationReplyTargets(
        { replyContext: { messageId: "custom-agent-message" } },
        messages,
        "octo",
      ),
    ).toEqual({ replyToOcto: false, replyToHuman: false });
    expect(
      resolveGroupParticipationReplyTargets(
        { replyContext: { messageId: "runtime-notice" } },
        messages,
        "octo",
      ),
    ).toEqual({ replyToOcto: false, replyToHuman: false });
  });

  it("preserves the skill decision as dispatch metadata", () => {
    expect(
      buildGroupParticipationMetadata({
        decision: "correct",
        domain: "factual",
        reason: "A recent human answer is objectively incorrect.",
        confidence: 97,
        participantCount: 2,
        targetMessageId: "message-2",
        policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
      }),
    ).toEqual({
      decision: "correct",
      domain: "factual",
      reason: "A recent human answer is objectively incorrect.",
      confidence: 97,
      participantCount: 2,
      targetMessageId: "message-2",
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });
  });

  it("preserves authoritative arithmetic coverage metadata", () => {
    expect(
      buildGroupParticipationMetadata({
        decision: "silent",
        domain: "arithmetic",
        reason: "correct_arithmetic_follow_up_covered_by_human",
        confidence: 100,
        participantCount: 2,
        targetMessageId: "message-1",
        coveredRunId: "run-1",
        coveredJobId: "job-1",
        coverage: "cancel_active_octo",
        policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
      }),
    ).toMatchObject({
      decision: "silent",
      targetMessageId: "message-1",
      coveredRunId: "run-1",
      coveredJobId: "job-1",
      coverage: "cancel_active_octo",
    });
  });

  it("builds a conservative record-only fallback when the resolver is unavailable", () => {
    expect(buildUnavailableGroupParticipationMetadata()).toEqual({
      decision: "silent",
      domain: "ambiguous",
      reason: "participation_resolver_unavailable",
      confidence: 0,
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });
  });
});

const AGENT_EVALUATION_RUN_METADATA = {
  groupParticipation: {
    decision: "agent_evaluation",
    reason: "skill_mode_ambient",
    enforcedBy: "runtime-controller",
  },
};

describe("skill-mode agent evaluation markers", () => {
  it("reads the server-stamped agent_evaluation run marker", () => {
    expect(
      readGroupParticipationAgentEvaluation(AGENT_EVALUATION_RUN_METADATA),
    ).toEqual({ reason: "skill_mode_ambient", enforcedBy: "runtime-controller" });
    expect(
      readGroupParticipationAgentEvaluation({
        groupParticipation: { decision: "respond", reason: "skill_mode_ambient" },
      }),
    ).toBeNull();
    expect(readGroupParticipationAgentEvaluation(null)).toBeNull();
    expect(readGroupParticipationAgentEvaluation({})).toBeNull();
  });

  it("recognizes a skill-mode ambient dispatch from the resolver metadata", () => {
    expect(
      isSkillModeAmbientDispatchMetadata({
        groupParticipation: { decision: "respond", reason: "skill_mode_ambient" },
      }),
    ).toBe(true);
    expect(isSkillModeAmbientDispatchMetadata(AGENT_EVALUATION_RUN_METADATA)).toBe(
      true,
    );
    expect(
      isSkillModeAmbientDispatchMetadata({
        groupParticipation: { decision: "respond", reason: "direct_mention" },
      }),
    ).toBe(false);
    expect(
      isSkillModeAmbientDispatchMetadata({
        groupParticipation: { decision: "silent", reason: "skill_mode_ambient" },
      }),
    ).toBe(false);
    expect(isSkillModeAmbientDispatchMetadata(null)).toBe(false);
  });
});

describe("agent evaluation presence suppression", () => {
  const runId = "run-eval-1";

  it("suppresses typing for an agent_evaluation run with no visible output", () => {
    expect(
      shouldSuppressAgentEvaluationRunPresence({
        runId,
        runMetadata: AGENT_EVALUATION_RUN_METADATA,
        messages: [],
      }),
    ).toBe(true);
  });

  it("keeps typing for direct runs that never carry the marker", () => {
    expect(
      shouldSuppressAgentEvaluationRunPresence({
        runId,
        runMetadata: {
          agentSelection: { active: ["octo"], mentions: ["octo"] },
        },
        messages: [],
      }),
    ).toBe(false);
    expect(
      shouldSuppressAgentEvaluationRunPresence({
        runId,
        runMetadata: null,
        pendingAgentEvaluationRunIds: new Set(["some-other-run"]),
        messages: [],
      }),
    ).toBe(false);
  });

  it("restores presence once the run streams a visible assistant message", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Here is the answer.",
        timestamp: 3,
        metadata: { runId },
      },
    ];
    expect(hasVisibleAssistantMessageForRun(messages, runId)).toBe(true);
    expect(
      shouldSuppressAgentEvaluationRunPresence({
        runId,
        runMetadata: AGENT_EVALUATION_RUN_METADATA,
        messages,
      }),
    ).toBe(false);
  });

  it("does not treat timeline notices or other runs' bubbles as visible output", () => {
    const messages = [
      {
        id: "notice-1",
        role: "assistant" as const,
        content: "Runtime is starting.",
        timestamp: 1,
        messageType: "runtime_alert",
        metadata: { runId },
      },
      {
        id: "assistant-other-run",
        role: "assistant" as const,
        content: "Unrelated reply.",
        timestamp: 2,
        metadata: { runId: "run-other" },
      },
    ];
    expect(hasVisibleAssistantMessageForRun(messages, runId)).toBe(false);
    expect(
      shouldSuppressAgentEvaluationRunPresence({
        runId,
        runMetadata: AGENT_EVALUATION_RUN_METADATA,
        messages,
      }),
    ).toBe(true);
  });

  it("suppresses the submitter's awaiting-lease window via local marks", () => {
    const marks = new Set<string>();
    markPendingAgentEvaluationRun(marks, runId);
    // No run record yet (awaiting lease): only the local mark exists.
    expect(
      shouldSuppressAgentEvaluationRunPresence({
        runId,
        pendingAgentEvaluationRunIds: marks,
        messages: [],
      }),
    ).toBe(true);
    // A direct dispatch in the same session is never marked.
    expect(
      shouldSuppressAgentEvaluationRunPresence({
        runId: "run-direct",
        pendingAgentEvaluationRunIds: marks,
        messages: [],
      }),
    ).toBe(false);
  });

  it("caps the local mark set by evicting the oldest run id", () => {
    const marks = new Set<string>();
    for (let index = 0; index < 201; index += 1) {
      markPendingAgentEvaluationRun(marks, `run-${index}`);
    }
    expect(marks.size).toBe(200);
    expect(marks.has("run-0")).toBe(false);
    expect(marks.has("run-200")).toBe(true);
  });
});
