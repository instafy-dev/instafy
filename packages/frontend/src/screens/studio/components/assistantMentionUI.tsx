import type { ReactNode } from "react";
import type { AssistantMentionToken } from "../../../conversations/assistantMentions";
import {
  getBuiltInAssistantMentionPatternSource,
  listBuiltInAssistantMentionTokens,
  resolveBuiltInAssistantMentionToken,
} from "../../../assistants/localBuiltInAssistantCatalog";

const ASSISTANT_MENTION_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 font-semibold leading-none ring-1 align-baseline";
const ASSISTANT_MENTION_STYLE =
  `${ASSISTANT_MENTION_BASE} bg-secondary-50 text-secondary-700 ring-secondary-200 dark:bg-secondary-500/15 dark:text-secondary-200 dark:ring-secondary-500/30`;
const ASSISTANT_MENTION_STYLES = Object.fromEntries(
  listBuiltInAssistantMentionTokens().map((token) => [token, ASSISTANT_MENTION_STYLE]),
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

export function renderAssistantMentionTokens(text: string): ReactNode {
  if (!text) {
    return "";
  }
  const chunks = parseAssistantMentions(text);
  if (chunks.length === 1 && chunks[0]?.type === "text") {
    return chunks[0].value;
  }
  return chunks.map((chunk, index) =>
    chunk.type === "text" ? (
      chunk.value
    ) : (
      <span key={`${chunk.value}-${index}`} className={getAssistantMentionClass(chunk.value)}>
        {chunk.value}
      </span>
    )
  );
}
