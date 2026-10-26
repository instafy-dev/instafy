import type { BuiltInAssistantHandle } from "@instafy/sdk/agents";
import { listEnabledCapabilityIds } from "@instafy/sdk/capabilities";
import { getEmbodiedAssistantCatalog } from "../agents/embodiedAssistantCatalog";
import {
  buildContractSkillRegistry,
  STOP_PROMPT_PATTERNS,
  type RobotBehaviorDefinition,
} from "./contractSkillRegistrations";
import { ROBOT_EMBODIMENT_CAPABILITY_ID } from "./robotCapabilityMetadata";

export type {
  ContractSkillRegistration,
  RobotBehaviorDefinition,
  RobotBehaviorId,
  RobotBehaviorStep,
  RobotCommand,
} from "./contractSkillRegistrations";

export type EmbodiedAgentHandle = BuiltInAssistantHandle;

export type EmbodiedAgentProfile = {
  handle: EmbodiedAgentHandle;
  displayName: string;
  summary: string;
  capabilityEnabled: boolean;
  capabilities: string[];
  defaultPrompt: string;
};

export type LearningSessionPlan = {
  mode: "coached_experiment";
  goal: string;
  diagnosticsLevel: "high";
  consolidation: "auto_draft";
};

export type ActiveRobotLearningSession = LearningSessionPlan & {
  agentHandle: EmbodiedAgentHandle;
  startedAtMs: number;
  sourcePrompt: string;
  state: "active";
};

export type ResolvedEmbodiedBehavior = {
  agent: EmbodiedAgentProfile;
  behavior: RobotBehaviorDefinition | null;
  coachingNote: string | null;
  detail: string;
  handleSource: "prompt" | "selected";
  learningSession: LearningSessionPlan | null;
  learningSessionSource: "explicit" | "active" | null;
  normalizedPrompt: string;
  status:
    | "ready"
    | "learning_ready"
    | "learning_correction"
    | "learning_complete"
    | "missing_capability"
    | "unknown_behavior";
};

function defaultPromptForAssistant(
  handle: BuiltInAssistantHandle,
  capabilityEnabled: boolean,
) {
  return capabilityEnabled
    ? `@${handle} wake up`
    : `@${handle} summarize this room log`;
}

export function createEmbodiedAgentProfile(
  handle: BuiltInAssistantHandle,
): EmbodiedAgentProfile | null {
  const catalog = getEmbodiedAssistantCatalog();
  const definition = catalog.getAssistantDefinition(handle);
  if (!definition) {
    return null;
  }
  const capabilityEnabled = catalog.assistantHasCapability(
    handle,
    ROBOT_EMBODIMENT_CAPABILITY_ID,
  );
  const enabledCapabilities = listEnabledCapabilityIds(
    definition.capabilityBindings,
  );
  return {
    handle,
    displayName: definition.mentionToken,
    summary: definition.summary,
    capabilityEnabled,
    capabilities: capabilityEnabled ? enabledCapabilities : [],
    defaultPrompt: defaultPromptForAssistant(handle, capabilityEnabled),
  };
}

export function listEmbodiedAgentProfiles(): EmbodiedAgentProfile[] {
  return getEmbodiedAssistantCatalog()
    .listAssistantDefinitions()
    .map((definition) => createEmbodiedAgentProfile(definition.handle))
    .filter((profile): profile is EmbodiedAgentProfile => profile !== null);
}

export function getEmbodiedAgentProfile(
  handle: BuiltInAssistantHandle,
): EmbodiedAgentProfile | null {
  return createEmbodiedAgentProfile(handle);
}

export function getPreferredEmbodiedAgentProfile(): EmbodiedAgentProfile | null {
  return (
    listEmbodiedAgentProfiles().find((profile) => profile.capabilityEnabled) ??
    listEmbodiedAgentProfiles()[0] ??
    null
  );
}

function getPreferredEmbodiedMentionToken() {
  return (
    getPreferredEmbodiedAgentProfile()?.displayName ??
    `@${getEmbodiedAssistantCatalog().getDefaultAssistantHandle()}`
  );
}

function buildPromptExamples(...examples: string[]) {
  const mentionToken = getPreferredEmbodiedMentionToken();
  return examples.map((example) => `${mentionToken} ${example}`);
}

export function getDefaultEmbodiedAgentHandle(): EmbodiedAgentHandle {
  return (
    getPreferredEmbodiedAgentProfile()?.handle ??
    getEmbodiedAssistantCatalog().getDefaultAssistantHandle()
  );
}

const contractSkillRegistry = buildContractSkillRegistry(buildPromptExamples);

// The executable behavior registry is generated from @knosh/contract. Instafy
// supplies only mention-aware examples and prompt routing metadata.
export const CONTRACT_SKILL_REGISTRATIONS =
  contractSkillRegistry.registrations;
export const ROBOT_BEHAVIORS = contractSkillRegistry.behaviors;

const LEARNING_INTENT_PATTERNS = [
  /\bi want to help you learn\b/i,
  /\bhelp you learn\b/i,
  /\bteach you\b/i,
  /\breteach you\b/i,
  /\bpractice\b/i,
  /\btrain\b/i,
  /\blearn how to\b/i,
  /\blearn to\b/i,
];

const LEARNING_EXIT_PATTERNS = [
  /\bstop learning\b/i,
  /\bend learning\b/i,
  /\bfinish learning\b/i,
  /\bwe(?:'| a)?re done\b/i,
  /\bthat(?:'| i)?s enough\b/i,
  /\bstop practicing\b/i,
  /\bend practice\b/i,
  /\bstop training\b/i,
];

function normalizePrompt(prompt: string) {
  return prompt.trim().replace(/\s+/g, " ");
}

function extractLeadingHandle(
  prompt: string,
): EmbodiedAgentHandle | null {
  const match = prompt.match(/^@([a-z0-9_-]+)\b/i);
  return getEmbodiedAssistantCatalog().resolveAssistantHandle(match?.[1] ?? "");
}

function stripLeadingHandle(prompt: string) {
  return normalizePrompt(prompt.replace(/^@[a-z0-9_-]+\b/i, "").trim());
}

function normalizeLearningGoal(value: string) {
  const goal = value.trim().replace(/[.?!,;:]+$/g, "");
  return goal.length > 0 ? goal : "this robot behavior";
}

function detectLearningSession(prompt: string): LearningSessionPlan | null {
  if (!LEARNING_INTENT_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return null;
  }

  const matchers = [
    /(?:help\s+you\s+learn|teach\s+you|reteach\s+you|train\s+you|practice)\s+(?:how\s+to\s+)?(.+)$/i,
    /learn\s+how\s+to\s+(.+)$/i,
    /learn\s+to\s+(.+)$/i,
  ];
  const goalMatch = matchers
    .map((pattern) => pattern.exec(prompt)?.[1] ?? null)
    .find((value): value is string =>
      Boolean(value && value.trim().length > 0),
    );

  return {
    mode: "coached_experiment",
    goal: normalizeLearningGoal(goalMatch ?? "this robot behavior"),
    diagnosticsLevel: "high",
    consolidation: "auto_draft",
  };
}

function detectLearningSessionExit(prompt: string) {
  return LEARNING_EXIT_PATTERNS.some((pattern) => pattern.test(prompt));
}

function resolveBehaviorFromPrompt(
  prompt: string,
): RobotBehaviorDefinition | null {
  for (const registration of CONTRACT_SKILL_REGISTRATIONS) {
    if (
      registration.behavior &&
      registration.promptPatterns.some((pattern) => pattern.test(prompt))
    ) {
      return registration.behavior;
    }
  }

  if (STOP_PROMPT_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return ROBOT_BEHAVIORS.stop ?? null;
  }

  const normalized = prompt.toLowerCase().replace(/[\s-]+/g, "_");
  const directBehavior = ROBOT_BEHAVIORS[normalized];
  if (directBehavior) {
    return directBehavior;
  }

  return (
    CONTRACT_SKILL_REGISTRATIONS.find(
      (registration) =>
        registration.skillId === normalized ||
        registration.behaviorId === normalized,
    )?.behavior ?? null
  );
}

export function createActiveRobotLearningSession(
  session: LearningSessionPlan,
  agentHandle: BuiltInAssistantHandle,
  sourcePrompt: string,
  existing: ActiveRobotLearningSession | null = null,
): ActiveRobotLearningSession {
  return {
    ...session,
    agentHandle,
    startedAtMs: existing?.startedAtMs ?? Date.now(),
    sourcePrompt: existing?.sourcePrompt ?? sourcePrompt,
    state: "active",
  };
}

export function resolveEmbodiedBehaviorPrompt(
  prompt: string,
  selectedHandle: BuiltInAssistantHandle,
  activeLearningSession: ActiveRobotLearningSession | null = null,
): ResolvedEmbodiedBehavior {
  const normalizedPrompt = normalizePrompt(prompt);
  const promptHandle = extractLeadingHandle(normalizedPrompt);
  const handle = promptHandle ?? selectedHandle;
  const agent =
    getEmbodiedAgentProfile(handle) ??
    createEmbodiedAgentProfile(getDefaultEmbodiedAgentHandle());
  if (!agent) {
    throw new Error(
      "No built-in assistant definitions are available for embodied prompt resolution.",
    );
  }
  const behaviorPrompt = stripLeadingHandle(normalizedPrompt);
  const behavior = resolveBehaviorFromPrompt(behaviorPrompt);
  const explicitLearningSession = detectLearningSession(behaviorPrompt);
  const continuedLearningSession =
    activeLearningSession && activeLearningSession.agentHandle === handle
      ? activeLearningSession
      : null;
  const learningSession = explicitLearningSession ?? continuedLearningSession;
  const learningSessionSource = explicitLearningSession
    ? "explicit"
    : continuedLearningSession
      ? "active"
      : null;
  const learningExitRequested = Boolean(
    continuedLearningSession && detectLearningSessionExit(behaviorPrompt),
  );
  const coachingNote =
    continuedLearningSession &&
    !explicitLearningSession &&
    !learningExitRequested &&
    !behavior
      ? behaviorPrompt
      : null;

  if (!agent.capabilityEnabled) {
    const suggestedEmbodiedMentionToken = getPreferredEmbodiedMentionToken();
    return {
      agent,
      behavior,
      coachingNote: null,
      detail: `${agent.displayName} does not have the robot embodiment capability. Use ${suggestedEmbodiedMentionToken} for physical actions and keep ${agent.displayName} for non-robotic help.`,
      handleSource: promptHandle ? "prompt" : "selected",
      learningSession,
      learningSessionSource,
      normalizedPrompt,
      status: "missing_capability",
    };
  }

  if (!behavior && explicitLearningSession) {
    return {
      agent,
      behavior: null,
      coachingNote: null,
      detail: `${agent.displayName} is ready to start a coached learning session for ${explicitLearningSession.goal}. I will capture richer diagnostics and refresh the robot learn draft automatically as we experiment.`,
      handleSource: promptHandle ? "prompt" : "selected",
      learningSession,
      learningSessionSource,
      normalizedPrompt,
      status: "learning_ready",
    };
  }

  if (learningExitRequested && learningSession) {
    return {
      agent,
      behavior: null,
      coachingNote: null,
      detail: `${agent.displayName} is wrapping up the coached learning session for ${learningSession.goal} and will consolidate the latest robot learn draft.`,
      handleSource: promptHandle ? "prompt" : "selected",
      learningSession,
      learningSessionSource,
      normalizedPrompt,
      status: "learning_complete",
    };
  }

  if (coachingNote && learningSession) {
    return {
      agent,
      behavior: null,
      coachingNote,
      detail: `${agent.displayName} logged a coaching note for ${learningSession.goal}: "${coachingNote}". I will keep the richer diagnostics running for this experiment.`,
      handleSource: promptHandle ? "prompt" : "selected",
      learningSession,
      learningSessionSource,
      normalizedPrompt,
      status: "learning_correction",
    };
  }

  if (!behavior) {
    return {
      agent,
      behavior: null,
      coachingNote: null,
      detail:
        "No contract-backed robot action matched that prompt. Try wake up, look at me, sleep, or stop.",
      handleSource: promptHandle ? "prompt" : "selected",
      learningSession,
      learningSessionSource,
      normalizedPrompt,
      status: "unknown_behavior",
    };
  }

  return {
    agent,
    behavior,
    coachingNote: null,
    detail: learningSession
      ? `${agent.displayName} will run ${behavior.title.toLowerCase()} as a coached experiment for ${learningSession.goal}, with richer diagnostics and automatic learn-draft refresh.`
      : `${agent.displayName} can execute ${behavior.title.toLowerCase()} through ${behavior.steps.length} transport step${behavior.steps.length === 1 ? "" : "s"}.`,
    handleSource: promptHandle ? "prompt" : "selected",
    learningSession,
    learningSessionSource,
    normalizedPrompt,
    status: "ready",
  };
}
