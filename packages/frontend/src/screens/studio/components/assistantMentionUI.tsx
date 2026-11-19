import { MENTION_CLASSES } from "../../../components/mentionStyles";
import type { AssistantMentionToken } from "../../../conversations/assistantMentions";
import {
  getBuiltInAssistantMentionPatternSource,
  listBuiltInAssistantMentionTokens,
  resolveBuiltInAssistantMentionToken,
} from "../../../assistants/localBuiltInAssistantCatalog";

const ASSISTANT_MENTION_STYLES = Object.fromEntries(
  listBuiltInAssistantMentionTokens().map((token) => [token, MENTION_CLASSES.agent]),
) as Record<AssistantMentionToken, string>;

const ASSISTANT_MENTION_REGEX = new RegExp(
  `(?:${getBuiltInAssistantMentionPatternSource()})\\b`,
  "gi",
);

export type AssistantMentionChunk =
  | { type: "text"; value: string }
  | { type: "mention"; value: AssistantMentionToken };

export function resolveAssistantMentionToken(rawToken: string): AssistantMentionToken {
  return resolveBuiltInAssistantMentionToken(rawToken);
}

export function getAssistantMentionClass(token: AssistantMentionToken): string {
  return ASSISTANT_MENTION_STYLES[token];
}

export function parseAssistantMentions(text: string): AssistantMentionChunk[] {
  if (!text) {
    return [];
  }
  const regex = new RegExp(ASSISTANT_MENTION_REGEX);
  const matches = Array.from(text.matchAll(regex));
  if (matches.length === 0) {
    return [{ type: "text", value: text }];
  }
  const chunks: AssistantMentionChunk[] = [];
  let cursor = 0;
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      chunks.push({ type: "text", value: text.slice(cursor, matchIndex) });
    }
    const rawToken = match[0];
    chunks.push({ type: "mention", value: resolveAssistantMentionToken(rawToken) });
    cursor = matchIndex + rawToken.length;
  }
  if (cursor < text.length) {
    chunks.push({ type: "text", value: text.slice(cursor) });
  }
  return chunks;
}
