/**
 * Words no Claude Code surface may use. docs/Chat-Activity.md keeps the
 * plumbing out of what a person reads ("upstream", "provider", "credential",
 * "runtime", "switch", "Codex", "workspace", "request"), and
 * docs/Local-Engine-Turns.md 5.4 keeps a lane surface from promising anything
 * about price ("included", "free", "unlimited", credits).
 */
export const CLAUDE_CODE_BANNED_WORDS = [
  "upstream",
  "provider",
  "credential",
  "runtime",
  "switch",
  "codex",
  "workspace",
  "request",
  "included",
  "free",
  "unlimited",
  "credit",
] as const;

/** The first banned word a sentence uses, or null. */
export function bannedWordIn(sentence: string): string | null {
  const lower = sentence.toLowerCase();
  return CLAUDE_CODE_BANNED_WORDS.find((word) => new RegExp(`\\b${word}`, "u").test(lower)) ?? null;
}

/** Every string inside a value: an object's, an array's or its own. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}
