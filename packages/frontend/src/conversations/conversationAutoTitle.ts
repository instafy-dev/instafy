import type { ConversationState } from "./ConversationsProvider";
import type { ChatMessage } from "../screens/studio/types";
import { findConnectorForSkillImport } from "../screens/studio/components/connectors";
import {
  deriveSkillSourceLabel,
  humanizeSkillName,
  normalizeSkillName,
  parseSkillImportMessage,
} from "./skillCommands";

const DEFAULT_CONVERSATION_TITLE_PATTERN = /^Conversation\s+\d+$/i;
// The controller's sanitizer caps model titles at the same length.
const FALLBACK_TITLE_MAX_CHARS = 48;
const FALLBACK_TITLE_MAX_WORDS = 6;
// One word ("Hi", "Test", "Yes") tells chats apart worse than their numbers.
const FALLBACK_TITLE_MIN_WORDS = 2;
// Where a clause of the opening message ends: at the end of a sentence, or
// where something that is never echoed (a link, an address, a mention, a
// path, a code block) was taken out.
const SENTENCE_END = "\uE000";
const REMOVED = "\uE001";
const CLAUSE_BOUNDARY_PATTERN = /([\uE000\uE001])/;
const FENCED_CODE_PATTERN = /```[\s\S]*?(?:```|$)/g;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const MENTION_PATTERN = /(^|\s)@[\w.-]+/g;
const PATH_PATTERN = /(^|\s)(?:~?\.{0,2}\/(?=\S)|[^\s/]+\/[^\s/]+\/)\S*/g;
// The only words a title holds: letters in any script, with apostrophes and
// hyphens inside, and ending punctuation after.
const PLAIN_WORD_PATTERN = /^[\p{L}\p{M}'\u2019-]*\p{L}[\p{L}\p{M}'\u2019-]*[.,?!:]*$/u;
const PLAIN_WORD_MAX_CHARS = 20;
// Punctuation standing alone between words ("-", "..."), skipped, not a word.
const SEPARATOR_PATTERN = /^[-'\u2019.,?!:]+$/;
// A message that mentions a secret can hold one in words no pattern tells
// apart from ordinary ones ("my password is sonnenblume"), so it gets no title.
const SENSITIVE_TOPIC_PATTERN =
  /(?<![\p{L}\p{N}_])(?:passwords?|passw(?:ort(?:e|es|s)?|örter|oerter)|passwd|pwd?|passphrases?|passcodes?|pass|pins?|logins?|credentials?|zugangsdaten|kennw(?:ort(?:e|es|s)?|örter|oerter)|secrets?|tokens?|api[\s_-]?keys?|private[\s_-]?keys?)(?![\p{L}\p{N}_])/iu;
// "github_p(?:at)_" is GitHub's fine-grained token prefix, split so the public
// boundary gate does not read this pattern as a token.
const CREDENTIAL_PREFIX_PATTERN = /^(?:(?:sk|pk|rk)[-_]|gh[pousr]_|github_p(?:at)_|glpat-|xox[a-z]-|AKIA|ASIA|AIza|eyJ)/;
const LEADING_FILLER_PATTERNS = [
  /^(?:hi|hey|hello|hiya|howdy|yo|hej|hallo|ok|okay|so|please|pls|bitte|thanks|thank you)(?:\s+there)?\b[\s,;:!.-]*/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i,
  /^help\s+me\s+(?:to\s+|with\s+)?/i,
  /^i\s+(?:want|need|would\s+like|['\u2019]d\s+like)\s+(?:you\s+)?to\s+/i,
  /^let['\u2019]?s\s+/i,
];
const TRAILING_SMALL_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "with", "to", "of", "in", "on", "at", "by",
  "from", "about", "into", "my", "our", "your", "their",
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und",
  "oder", "für", "mit", "von", "zu", "zum", "zur", "im", "am", "auf", "aus", "bei",
  "mein", "meine", "unser", "unsere",
  "is", "are", "was", "were", "ist", "sind",
]);
const REUSABLE_BLANK_ASSISTANT_PROMPTS = new Set([
  "How can I help with your space?",
  "How can I help with your project?",
]);

export function isDefaultConversationTitle(title: string | null | undefined): boolean {
  return DEFAULT_CONVERSATION_TITLE_PATTERN.test((title ?? "").trim());
}

function isReusableBlankAssistantMessage(
  conversation: ConversationState,
): boolean {
  if (conversation.messages.length !== 1) {
    return false;
  }
  const [message] = conversation.messages;
  if (!message || message.role !== "assistant") {
    return false;
  }
  if ((message.files?.length ?? 0) > 0) {
    return false;
  }
  if ((message.messageType ?? "").trim().toLowerCase() !== "status") {
    return false;
  }
  return REUSABLE_BLANK_ASSISTANT_PROMPTS.has(message.content.trim());
}

export function isReusableBlankConversation(
  conversation: ConversationState | null | undefined,
): boolean {
  if (!conversation) {
    return false;
  }
  if (conversation.lifecycleStatus !== "active" || conversation.visibility !== "public") {
    return false;
  }
  if (conversation.parentConversationId || conversation.threadKind) {
    return false;
  }
  if (!isDefaultConversationTitle(conversation.title)) {
    return false;
  }
  if (conversation.draft.trim().length > 0 || conversation.draftEditorState !== null) {
    return false;
  }
  if (conversation.pendingRunIds.length > 0 || conversation.awaitingLeaseRunIds.length > 0) {
    return false;
  }
  if (conversation.messages.length === 0) {
    return true;
  }
  return isReusableBlankAssistantMessage(conversation);
}

export function findReusableBlankConversation(
  conversations: ConversationState[],
): ConversationState | null {
  let candidate: ConversationState | null = null;
  for (const conversation of conversations) {
    if (!isReusableBlankConversation(conversation)) {
      continue;
    }
    if (!candidate || conversation.createdAt >= candidate.createdAt) {
      candidate = conversation;
    }
  }
  return candidate;
}

export function shouldAutoTitleConversation(
  conversation: ConversationState | null | undefined,
  firstUserMessage: string,
): boolean {
  if (!conversation) {
    return false;
  }
  if (conversation.parentConversationId || conversation.threadKind) {
    return false;
  }
  if (!isDefaultConversationTitle(conversation.title)) {
    return false;
  }
  if (firstUserMessage.trim().length === 0) {
    return false;
  }
  return !conversation.messages.some((message) => message.role === "user");
}

export function getConversationAutoTitleSeed(
  conversation: ConversationState | null | undefined,
): string | null {
  if (!conversation) {
    return null;
  }
  if (conversation.parentConversationId || conversation.threadKind) {
    return null;
  }
  if (!isDefaultConversationTitle(conversation.title)) {
    return null;
  }
  const userMessages = conversation.messages.filter(
    (message) => {
      if (message.role !== "user" || message.content.trim().length === 0) {
        return false;
      }
      const metadata = readRecord(message.metadata);
      const groupParticipation = readRecord(metadata?.groupParticipation);
      const participationPreflight = readRecord(metadata?.groupParticipationPreflight);
      const preflightStatus = participationPreflight?.status;
      if (groupParticipation?.decision === "silent") {
        return false;
      }
      if (
        (preflightStatus === "controller_deferred" ||
          preflightStatus === "controller_coverage") &&
        !groupParticipation?.decision
      ) {
        return false;
      }
      return true;
    },
  );
  return userMessages.at(-1)?.content.trim() ?? null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function getStructuredConversationTitle(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const metadata = readRecord(message?.metadata);
    const githubImport = readRecord(metadata?.githubImport);
    const repo = readNonEmptyString(githubImport?.repo);
    if (repo) {
      return `Import ${repo}`;
    }
    const skillImportTitle = message?.role === "user" ? getSkillImportConversationTitle(message.content) : null;
    if (skillImportTitle) {
      return skillImportTitle;
    }
  }
  return null;
}

export interface SkillImportDescription {
  /** True when the line installs a first-party connector from connectors.ts. */
  firstParty: boolean;
  /** The connector's name ("FreeFinance"), else the humanized pack or skill ("Bookkeeping"). */
  label: string;
}

/** What a `/skills import` line sets up, in words a person reads. */
export function describeSkillImport(message: string): SkillImportDescription | null {
  const parsed = parseSkillImportMessage(message);
  if (!parsed) {
    return null;
  }
  const connector = findConnectorForSkillImport(parsed.source);
  if (connector) {
    return { firstParty: true, label: connector.name };
  }
  // The source label reads past `.agents/skills` and SKILL.md to the pack or
  // folder name; it echoes the whole source back when nothing better exists.
  const sourceLabel = deriveSkillSourceLabel(parsed.source);
  const slug = parsed.skillName
    ?? (sourceLabel && sourceLabel !== parsed.source.trim() ? normalizeSkillName(sourceLabel) : "");
  return slug ? { firstParty: false, label: humanizeSkillName(slug) } : null;
}

export function getSkillImportConversationTitle(message: string): string | null {
  const description = describeSkillImport(message);
  if (!description) {
    return null;
  }
  return description.firstParty ? `Connect ${description.label}` : `Set up ${description.label}`;
}

function stripLeadingFiller(text: string): string {
  let current = text.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const pattern of LEADING_FILLER_PATTERNS) {
      const next = current.replace(pattern, "").trim();
      if (next !== current) {
        current = next;
        changed = true;
      }
    }
  }
  return current;
}

function bareWord(word: string): string {
  return word.replace(/^["'`([{<]+|["'`)\]}>.,;:!?]+$/g, "");
}

// Known key and token prefixes, and long runs that mix letters and digits.
function looksLikeCredential(word: string): boolean {
  const bare = bareWord(word);
  if (bare.length >= 16 && CREDENTIAL_PREFIX_PATTERN.test(bare)) {
    return true;
  }
  return bare.length >= 20 && /\p{L}/u.test(bare) && /\p{N}/u.test(bare);
}

/** True for a word such as "the", "for" or "is" that a cut text should not end on. */
export function isTrailingSmallWord(word: string): boolean {
  return TRAILING_SMALL_WORDS.has(bareWord(word).toLowerCase());
}

function isPlainWord(word: string): boolean {
  return PLAIN_WORD_PATTERN.test(word) &&
    [...word.replace(/[.,?!:]+$/, "")].length <= PLAIN_WORD_MAX_CHARS;
}

/**
 * A title from the opening message alone, for when the controller has none to
 * give (its model path needs the person's own credential). A `/skills import`
 * line gets its structured title; any other slash command gets none.
 *
 * Links, addresses, mentions, paths and code are taken out first. The title is
 * then the first clause that says something, at most six words and 48
 * characters, made of plain words only: letters in any script, with
 * apostrophes and hyphens inside a word and . , ? ! : after it. It ends before
 * the first word with a digit or any other character, or longer than 20
 * characters, and when that leaves fewer than two words there is no title.
 * A message that mentions a password, PIN, login, secret, token or key, or
 * holds a known key prefix or a long run of mixed letters and digits, gets no
 * title at all.
 */
export function getFallbackConversationTitle(message: string): string | null {
  const trimmed = message.trim();
  if (trimmed.startsWith("/")) {
    return getSkillImportConversationTitle(trimmed);
  }
  if (SENSITIVE_TOPIC_PATTERN.test(trimmed)) {
    return null;
  }
  const marked = trimmed
    .replace(FENCED_CODE_PATTERN, ` ${REMOVED} `)
    .replace(URL_PATTERN, ` ${REMOVED} `)
    .replace(EMAIL_PATTERN, ` ${REMOVED} `)
    .replace(MENTION_PATTERN, `$1${REMOVED} `)
    .replace(PATH_PATTERN, `$1${REMOVED} `)
    .replace(/[`*]/g, "")
    .replace(/\s*\n\s*/g, SENTENCE_END)
    // A list marker ("1.", "2)") starts an item, it does not end a sentence.
    .replace(/(^|\s)\d{1,3}[.)](?=\s)/g, `$1${SENTENCE_END}`)
    .replace(/[.!?]+(?=\s|$)/g, SENTENCE_END);
  if (marked.split(/\s+/).some(looksLikeCredential)) {
    return null;
  }
  const parts = marked.split(CLAUSE_BOUNDARY_PATTERN);
  for (let index = 0; index < parts.length; index += 2) {
    const words: string[] = [];
    let endsAtOtherWord = false;
    let cut = false;
    for (const word of stripLeadingFiller(parts[index] ?? "").split(/\s+/)) {
      if (word.length === 0 || SEPARATOR_PATTERN.test(word)) {
        continue;
      }
      if (!isPlainWord(word)) {
        endsAtOtherWord = true;
        break;
      }
      if (words.length === FALLBACK_TITLE_MAX_WORDS || [...words, word].join(" ").length > FALLBACK_TITLE_MAX_CHARS) {
        cut = true;
        break;
      }
      words.push(word);
    }
    if (words.length === 0 && !endsAtOtherWord) {
      continue;
    }
    const endsAtRemoval = parts[index + 1] === REMOVED;
    // A cut can end mid-phrase ("Plan our spring launch with the"); drop the
    // dangling small words so the title reads as finished.
    if (cut || endsAtOtherWord || endsAtRemoval) {
      while (words.length > 1 && isTrailingSmallWord(words[words.length - 1])) {
        words.pop();
      }
    }
    if (words.length < FALLBACK_TITLE_MIN_WORDS) {
      // A short sentence ("Thanks!") gives way to the next one, but the rest
      // of a sentence cut by a removed link or a word that is not plain is
      // only a fragment.
      if (endsAtRemoval || endsAtOtherWord) {
        return null;
      }
      continue;
    }
    const title = words.join(" ").replace(/[.!?:;,]+$/, "").trim();
    const sentenceCase = title.charAt(0).toUpperCase() + title.slice(1);
    return isDefaultConversationTitle(sentenceCase) ? null : sentenceCase;
  }
  return null;
}

/** The first non-empty thing a person wrote, and who wrote it. */
export interface OpeningUserMessage {
  content: string;
  authorId: string | null;
}

/** The first non-empty user message in these messages. */
export function getFirstUserMessage(messages: readonly ChatMessage[]): OpeningUserMessage | null {
  const first = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  return first ? { content: first.content.trim(), authorId: first.authorId ?? null } : null;
}

/**
 * The conversation's opening user message when its local list holds the
 * whole conversation, else null. A chat loaded from the controller keeps its
 * history in the message query, so its local list holds only what arrived
 * here, and its first entry there may be a later reply. The same holds for a
 * chat rebuilt from a message or a draft until the chat list confirms it.
 */
export function getOpeningUserMessage(conversation: ConversationState): OpeningUserMessage | null {
  return conversation.hasRemoteMessages || conversation.remoteSummaryPending
    ? null
    : getFirstUserMessage(conversation.messages);
}
