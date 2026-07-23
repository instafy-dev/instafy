import {
  getBuiltInAssistantMentionPatternSource,
  getDefaultAssistantHandle,
  listBuiltInAssistantHandles,
  normalizeAgentHandle,
  resolveBuiltInAssistantHandle,
  resolveBuiltInAssistantMentionToken,
  type BuiltInAssistantMentionToken,
} from "../assistants/localBuiltInAssistantCatalog";

export type AssistantMentionToken = BuiltInAssistantMentionToken;

const ASSISTANT_MENTION_PATTERN = new RegExp(
  `^(?:${getBuiltInAssistantMentionPatternSource()})\\b`,
  "i",
);
const AT_MENTION_PATTERN = /@([a-z0-9][a-z0-9_-]{0,19})\b/gi;
const DELEGATED_MESSAGE_PREFIX_PATTERN =
  /\b(?:post|send|write|message|ask|tell|reply)\b[^.!?\n]{0,96}:\s*$/i;
const CHILD_THREAD_DELEGATION_PREFIX_PATTERN =
  /\b(?:that|child|linked|agent|work)\s+(?:thread|conversation|chat)\b[^.!?\n]{0,120}\b(?:post|send|message|ask|tell|address(?:ed)?|mention)\b/i;

export function extractAssistantMentionToken(input: string): AssistantMentionToken | null {
  const match = input.trim().match(ASSISTANT_MENTION_PATTERN);
  if (!match) {
    return null;
  }
  return resolveBuiltInAssistantMentionToken(match[0] ?? "");
}

export function startsWithAssistantMention(input: string): boolean {
  return extractAssistantMentionToken(input) !== null;
}

export function extractAtMentionHandles(input: string, allowedHandles?: Iterable<string> | null): string[] {
  if (!input) {
    return [];
  }
  let allowed: Set<string> | null = null;
  if (allowedHandles != null) {
    allowed = new Set<string>();
    for (const handle of allowedHandles) {
      const normalized = normalizeAgentHandle(handle);
      if (normalized) {
        allowed.add(normalized);
      }
    }
  }
  const handles = new Set<string>();
  for (const match of input.matchAll(AT_MENTION_PATTERN)) {
    if (!shouldRouteAtMention(input, match.index ?? 0)) {
      continue;
    }
    const normalized =
      resolveBuiltInAssistantHandle(match[1] ?? "") ?? normalizeAgentHandle(match[1] ?? "");
    if (!normalized) {
      continue;
    }
    if (allowed && !allowed.has(normalized)) {
      continue;
    }
    handles.add(normalized);
  }
  return Array.from(handles);
}

function isInsideBacktickSpan(input: string, index: number): boolean {
  const prefix = input.slice(0, index);
  return (prefix.match(/`/g)?.length ?? 0) % 2 === 1;
}

function shouldRouteAtMention(input: string, mentionIndex: number): boolean {
  if (isInsideBacktickSpan(input, mentionIndex)) {
    return false;
  }

  const sentenceStart = Math.max(
    input.lastIndexOf(".", mentionIndex),
    input.lastIndexOf("!", mentionIndex),
    input.lastIndexOf("?", mentionIndex),
    input.lastIndexOf("\n", mentionIndex),
  ) + 1;
  const sentencePrefix = input.slice(sentenceStart, mentionIndex);
  const nearbyPrefix = input.slice(Math.max(0, mentionIndex - 140), mentionIndex);

  if (DELEGATED_MESSAGE_PREFIX_PATTERN.test(nearbyPrefix)) {
    return false;
  }
  if (CHILD_THREAD_DELEGATION_PREFIX_PATTERN.test(sentencePrefix)) {
    return false;
  }

  return true;
}

function normalizeAgentHandles(handles: Iterable<string>): string[] {
  const normalizedHandles: string[] = [];
  const seen = new Set<string>();
  for (const rawHandle of handles) {
    const normalized = resolveBuiltInAssistantHandle(rawHandle) ?? normalizeAgentHandle(rawHandle);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedHandles.push(normalized);
  }
  return normalizedHandles;
}

export type ResolvedPromptAgentSelection = {
  activeHandles: string[];
  explicitMentionedHandles: string[];
  mentionedHandles: string[];
  targetHandles: string[];
  nextStickyMentionedAgent: string | null;
  usesDefaultAssistantOnly: boolean;
};

export function resolvePromptAgentSelection(input: {
  prompt: string;
  assistantEnabled: boolean;
  extraAgentHandles: Iterable<string>;
  configuredAgentHandles?: Iterable<string> | null;
  stickyMentionedAgent?: string | null;
}): ResolvedPromptAgentSelection {
  const defaultAssistantHandle = getDefaultAssistantHandle();
  const activeHandles = normalizeAgentHandles([
    ...(input.assistantEnabled ? [defaultAssistantHandle] : []),
    ...input.extraAgentHandles,
  ]);

  const allowedMentionHandles = new Set<string>([
    ...listBuiltInAssistantHandles(),
    ...activeHandles,
  ]);
  if (input.configuredAgentHandles) {
    for (const handle of input.configuredAgentHandles) {
      const normalized = resolveBuiltInAssistantHandle(handle) ?? normalizeAgentHandle(handle);
      if (!normalized) {
        continue;
      }
      allowedMentionHandles.add(normalized);
    }
  }

  const explicitMentionedHandles = normalizeAgentHandles(
    extractAtMentionHandles(input.prompt, allowedMentionHandles),
  );
  let mentionedHandles = explicitMentionedHandles;

  const usesDefaultAssistantOnly =
    input.assistantEnabled && activeHandles.length === 1 && activeHandles[0] === defaultAssistantHandle;
  const stickyCandidateRaw =
    resolveBuiltInAssistantHandle(input.stickyMentionedAgent ?? "") ??
    normalizeAgentHandle(input.stickyMentionedAgent ?? "");
  const stickyCandidate = stickyCandidateRaw && allowedMentionHandles.has(stickyCandidateRaw)
    ? stickyCandidateRaw
    : null;
  const explicitCustomMentions = explicitMentionedHandles.filter((handle) => handle !== defaultAssistantHandle);
  const explicitAssistantMention = explicitMentionedHandles.some((handle) => handle === defaultAssistantHandle);

  let nextStickyMentionedAgent: string | null = stickyCandidate;
  if (explicitCustomMentions.length > 0) {
    nextStickyMentionedAgent = explicitCustomMentions[explicitCustomMentions.length - 1] ?? null;
  } else if (explicitAssistantMention) {
    nextStickyMentionedAgent = null;
  }
  if (explicitMentionedHandles.length === 0 && nextStickyMentionedAgent) {
    mentionedHandles = [nextStickyMentionedAgent];
  }

  const targetHandles = mentionedHandles.length > 0 ? mentionedHandles : activeHandles;
  return {
    activeHandles,
    explicitMentionedHandles,
    mentionedHandles,
    targetHandles,
    nextStickyMentionedAgent,
    usesDefaultAssistantOnly,
  };
}
