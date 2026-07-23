export const GLOBAL_AGENT_COLLABORATION_SKILL_PATH =
  ".agents/skills/instafy-agent-collaboration/SKILL.md";

export type AgentCollaborationMode = "inline" | "thread";

export type AdvisoryScopeClaim = {
  kind: "task";
  label: string;
  scope: string;
  advisory: true;
  source: "prompt";
};

function stripLeadingMentions(input: string): string {
  return input.replace(/^(?:\s*@[\w-]+\s*)+/, "").trim();
}

const AT_MENTION_PATTERN = /@([a-z0-9][a-z0-9_-]{0,19})\b/gi;

function buildPromptSegmentsByHandle(prompt: string, explicitHandles: string[]): Map<string, string> {
  const allowedHandles = new Set(explicitHandles.map((handle) => handle.toLowerCase()));
  const mentions: Array<{ handle: string; index: number }> = [];
  for (const match of prompt.matchAll(AT_MENTION_PATTERN)) {
    const handle = (match[1] ?? "").toLowerCase();
    if (!allowedHandles.has(handle)) {
      continue;
    }
    if (mentions.some((entry) => entry.handle === handle)) {
      continue;
    }
    mentions.push({ handle, index: match.index ?? 0 });
  }

  const segments = new Map<string, string>();
  for (let index = 0; index < mentions.length; index += 1) {
    const mention = mentions[index];
    if (!mention) {
      continue;
    }
    const nextMention = mentions[index + 1] ?? null;
    const rawSegment = prompt
      .slice(mention.index, nextMention?.index ?? prompt.length)
      .trim();
    const segmentWithoutMention = stripLeadingMentions(rawSegment);
    segments.set(mention.handle, segmentWithoutMention ? rawSegment : prompt);
  }
  return segments;
}

export function decideTopLevelAgentCollaborationMode(input: {
  prompt: string;
  explicitHandles: string[];
  hasAttachments: boolean;
  hasTerminalIntent: boolean;
}): AgentCollaborationMode {
  // Do not infer collaboration mode from natural-language phrases here.
  // Skills/model output should request threads explicitly via structured actions.
  void input;
  return "inline";
}

export function decideTopLevelAgentCollaborationModes(input: {
  prompt: string;
  explicitHandles: string[];
  hasAttachments: boolean;
  hasTerminalIntent: boolean;
}): Record<string, AgentCollaborationMode> {
  const segmentsByHandle = buildPromptSegmentsByHandle(input.prompt, input.explicitHandles);
  const decisions: Record<string, AgentCollaborationMode> = {};
  for (const handle of input.explicitHandles) {
    const normalizedHandle = handle.toLowerCase();
    decisions[normalizedHandle] = decideTopLevelAgentCollaborationMode({
      ...input,
      prompt: segmentsByHandle.get(normalizedHandle) ?? input.prompt,
      explicitHandles: [normalizedHandle],
    });
  }
  return decisions;
}

export function buildPromptAdvisoryScopeClaims(
  prompt: string,
): AdvisoryScopeClaim[] {
  const stripped = stripLeadingMentions(prompt);
  if (!stripped) {
    return [];
  }
  const firstLine = stripped.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) {
    return [];
  }
  const label =
    compact.length > 96 ? `${compact.slice(0, 93).trimEnd()}...` : compact;
  return [
    {
      kind: "task",
      label,
      scope: label,
      advisory: true,
      source: "prompt",
    },
  ];
}
