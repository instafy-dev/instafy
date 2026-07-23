function trimEdgePunctuation(value: string): string {
  return value.trim().replace(/[\s.!?]+$/g, "");
}

function capitalizeFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function finalizeSentence(value: string, terminal = "."): string {
  const core = trimEdgePunctuation(value);
  if (!core) {
    return "";
  }
  return `${capitalizeFirst(core)}${terminal}`;
}

const ASSISTANT_INTRO_PATTERNS = [
  /^let me know if you(?:'d| would)? like me to\s+/i,
  /^tell me if you(?:'d| would)? like me to\s+/i,
  /^if you(?:'d| would)? like me to\s+/i,
  /^would you like me to\s+/i,
  /^do you want me to\s+/i,
  /^want me to\s+/i,
] as const;

const ASSISTANT_DESIRE_PATTERNS = [
  /^let me know if you(?:'d| would)? like\s+/i,
  /^tell me if you(?:'d| would)? like\s+/i,
  /^if you(?:'d| would)? like\s+/i,
  /^let me know if you want\s+/i,
  /^tell me if you want\s+/i,
  /^if you want\s+/i,
] as const;

const PARTICIPLE_TO_IMPERATIVE: Record<string, string> = {
  explored: "Explore",
  updated: "Update",
  changed: "Change",
  added: "Add",
  removed: "Remove",
  deleted: "Delete",
  fixed: "Fix",
  refined: "Refine",
  polished: "Polish",
  improved: "Improve",
  wired: "Wire",
  integrated: "Integrate",
};

function tryImperativeFromParticiple(value: string): string | null {
  const match = trimEdgePunctuation(value).match(/^(.+?)\s+(\w+)$/i);
  if (!match) {
    return null;
  }
  const [, object, participleRaw] = match;
  const participle = participleRaw.toLowerCase();
  const verb = PARTICIPLE_TO_IMPERATIVE[participle];
  if (!verb) {
    return null;
  }
  const objectText = object.trim();
  if (!objectText) {
    return null;
  }
  return `${verb} ${objectText}.`;
}

function rewriteAssistantIntent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  for (const pattern of ASSISTANT_INTRO_PATTERNS) {
    if (!pattern.test(trimmed)) {
      continue;
    }
    const remainder = trimmed.replace(pattern, "").replace(/^to\s+/i, "");
    return finalizeSentence(remainder);
  }

  for (const pattern of ASSISTANT_DESIRE_PATTERNS) {
    if (!pattern.test(trimmed)) {
      continue;
    }
    const remainder = trimmed.replace(pattern, "").replace(/^to\s+/i, "");
    return tryImperativeFromParticiple(remainder) ?? finalizeSentence(remainder);
  }

  const firstPerson = trimmed.match(/^i\s+(?:can|could|will|would|['’]ll)\s+(.+)$/i);
  if (firstPerson) {
    const body = trimEdgePunctuation(firstPerson[1] ?? "");
    if (!body) {
      return "";
    }
    return `Can you ${body}?`;
  }

  return finalizeSentence(trimmed);
}

export function toUserPromptSuggestion(value: string): string {
  return rewriteAssistantIntent(value);
}
