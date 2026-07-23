import {
  resolveBuiltInAssistantHandle,
  resolveBuiltInAssistantMentionToken,
  type BuiltInAssistantMentionToken,
} from "../../../assistants/localBuiltInAssistantCatalog";

export type WorkspaceFileReferenceDescriptor = {
  path: string;
  raw: string;
  line?: number | null;
};

export type UrlReferenceDescriptor = {
  url: string;
  label: string;
};

export type ConversationReferenceDescriptor = {
  kind: "conversation" | "thread" | "message";
  raw: string;
  conversationId: string;
  messageId?: string | null;
  label?: string | null;
};

export type TeamFlowLineDescriptor = {
  label: "Workstreams";
  references: ConversationReferenceDescriptor[];
};

export type ChatLineTokenChunk =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "inline-code"; value: string }
  | { type: "assistant-mention"; value: BuiltInAssistantMentionToken }
  | { type: "agent-mention"; value: string }
  | { type: "workspace-file"; value: WorkspaceFileReferenceDescriptor }
  | { type: "conversation-reference"; value: ConversationReferenceDescriptor }
  | { type: "link"; value: UrlReferenceDescriptor };

export type MessageContentBlock =
  | { kind: "paragraph"; line: string }
  | { kind: "list"; ordered: boolean; start?: number; items: string[] }
  | { kind: "quote"; lines: string[] };

const WORKSPACE_FILE_REFERENCE_REGEX =
  /^((?:\/workspace\/[^/\s<>"'`()]+\/)?[0-9A-Za-z_.-]+(?:\/[0-9A-Za-z_.-]+)*\.(?:markdown|md|json|tsx?|jsx?|ya?ml|toml|py|rs|css|html|txt|sh|sql))(?:#L(\d+)|:(\d+))?/;
const URL_REFERENCE_REGEX = /^(https?:\/\/[^\s<>"'`]+)/i;
const URL_TRAILING_PUNCTUATION_REGEX = /[)\]}>.,!?;:'"`]+$/;
const TEAM_FLOW_LINE_PREFIX_REGEX =
  /^\s*(?:workstreams?|workstream refs?|lanes?|team|team flow|coordination|coordination flow|recovered team|existing team)\s*:\s*/i;
const TEAM_FLOW_SEPARATOR_TEXT_REGEX = /^[\s,;:·|/\\()[\]{}-]*$/;

function isChatTokenBoundaryChar(char: string | undefined): boolean {
  if (!char) {
    return true;
  }
  return !/[0-9A-Za-z_]/.test(char);
}

function normalizeWorkspaceFileReferencePath(candidate: string): string {
  const absoluteWorkspaceMatch = candidate.match(/^\/workspace\/[^/]+\/(.+)$/);
  if (absoluteWorkspaceMatch) {
    return absoluteWorkspaceMatch[1] ?? candidate;
  }
  return candidate;
}

function findAgentMentionAt(
  text: string,
  index: number,
  agentMentionHandles?: ReadonlySet<string> | null,
):
  | { type: "assistant-mention"; token: BuiltInAssistantMentionToken; end: number }
  | { type: "agent-mention"; token: string; end: number }
  | null {
  if (text[index] !== "@") {
    return null;
  }
  if (!isChatTokenBoundaryChar(text[index - 1])) {
    return null;
  }
  const match = text.slice(index).match(/^@([a-z0-9][a-z0-9_-]{0,19})/i);
  if (!match) {
    return null;
  }
  const normalizedHandle = (match[1] ?? "").trim().toLowerCase();
  if (!normalizedHandle) {
    return null;
  }
  const end = index + normalizedHandle.length + 1;
  if (!isChatTokenBoundaryChar(text[end])) {
    return null;
  }
  if (resolveBuiltInAssistantHandle(normalizedHandle)) {
    return {
      type: "assistant-mention",
      token: resolveBuiltInAssistantMentionToken(`@${normalizedHandle}`),
      end,
    };
  }
  if (agentMentionHandles && !agentMentionHandles.has(normalizedHandle)) {
    return null;
  }
  return { type: "agent-mention", token: `@${normalizedHandle}`, end };
}

export function findWorkspaceFileReferenceAt(
  text: string,
  index: number,
): { reference: WorkspaceFileReferenceDescriptor; end: number } | null {
  if (!isChatTokenBoundaryChar(text[index - 1])) {
    return null;
  }
  const slice = text.slice(index);
  const match = slice.match(WORKSPACE_FILE_REFERENCE_REGEX);
  if (!match) {
    return null;
  }
  const raw = match[0];
  const path = normalizeWorkspaceFileReferencePath(match[1] ?? "");
  if (!path) {
    return null;
  }
  const lineCandidate = match[2] ?? match[3] ?? "";
  const lineValue = lineCandidate ? Number.parseInt(lineCandidate, 10) : Number.NaN;
  const line = Number.isFinite(lineValue) && lineValue > 0 ? lineValue : null;
  const end = index + raw.length;
  if (!isChatTokenBoundaryChar(text[end])) {
    return null;
  }
  return { reference: { path, raw, line }, end };
}

function sanitizeUrlCandidate(raw: string): string {
  let value = raw.trim();
  while (value) {
    const next = value.replace(URL_TRAILING_PUNCTUATION_REGEX, "");
    if (next === value) {
      break;
    }
    value = next;
  }
  return value;
}

function findUrlAt(text: string, index: number): { reference: UrlReferenceDescriptor; end: number } | null {
  if (!isChatTokenBoundaryChar(text[index - 1])) {
    return null;
  }
  const prefix = text.slice(index, index + 8).toLowerCase();
  if (!prefix.startsWith("http://") && !prefix.startsWith("https://")) {
    return null;
  }
  const match = text.slice(index).match(URL_REFERENCE_REGEX);
  if (!match) {
    return null;
  }
  const raw = match[1] ?? "";
  const url = sanitizeUrlCandidate(raw);
  if (!url) {
    return null;
  }
  return { reference: { url, label: url }, end: index + url.length };
}

function findMarkdownLinkAt(text: string, index: number): { reference: UrlReferenceDescriptor; end: number } | null {
  if (text[index] !== "[" || text[index + 1] === "[" || text[index - 1] === "!") {
    return null;
  }
  const labelEnd = text.indexOf("](", index + 1);
  if (labelEnd <= index + 1) {
    return null;
  }
  const label = text.slice(index + 1, labelEnd).trim();
  if (!label || label.includes("\n")) {
    return null;
  }
  const urlStart = labelEnd + 2;
  const urlEnd = text.indexOf(")", urlStart);
  if (urlEnd <= urlStart) {
    return null;
  }
  const rawUrl = text.slice(urlStart, urlEnd).trim();
  const normalizedPrefix = rawUrl.slice(0, 8).toLowerCase();
  if (!normalizedPrefix.startsWith("http://") && !normalizedPrefix.startsWith("https://")) {
    return null;
  }
  const url = sanitizeUrlCandidate(rawUrl);
  if (!url) {
    return null;
  }
  return { reference: { url, label }, end: urlEnd + 1 };
}

function findInlineCodeAt(text: string, index: number): { value: string; end: number } | null {
  if (text[index] !== "`") {
    return null;
  }
  const markerMatch = text.slice(index).match(/^`+/);
  const marker = markerMatch?.[0] ?? "";
  if (!marker) {
    return null;
  }
  const contentStart = index + marker.length;
  const contentEnd = text.indexOf(marker, contentStart);
  if (contentEnd < 0) {
    return null;
  }
  return {
    value: text.slice(contentStart, contentEnd),
    end: contentEnd + marker.length,
  };
}

function inlineCodeSpanLooksMalformed(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/\b(?:inspected paths|likely impact|scheduling):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.length >= 80 && /\b(?:evidence|runtime|source):/i.test(trimmed)) {
    return true;
  }
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount >= 10 && /[.!?]\s+\S/.test(trimmed);
}

function findStrongEmphasisAt(text: string, index: number): { value: string; end: number } | null {
  if (text[index] !== "*" || text[index + 1] !== "*") {
    return null;
  }
  const contentStart = index + 2;
  const contentEnd = text.indexOf("**", contentStart);
  if (contentEnd < 0) {
    return null;
  }
  const value = text.slice(contentStart, contentEnd);
  if (!value.trim() || /^\s/.test(value) || /\s$/.test(value)) {
    return null;
  }
  return {
    value,
    end: contentEnd + 2,
  };
}

function findConversationReferenceAt(
  text: string,
  index: number,
): { reference: ConversationReferenceDescriptor; end: number } | null {
  if (text[index] !== "[" || text[index + 1] !== "[") {
    return null;
  }

  const end = text.indexOf("]]", index + 2);
  if (end < 0) {
    return null;
  }

  const raw = text.slice(index, end + 2);
  const inner = text.slice(index + 2, end).trim();
  const separatorIndex = inner.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const kind = inner.slice(0, separatorIndex).trim().toLowerCase();
  if (kind !== "conversation" && kind !== "thread" && kind !== "message") {
    return null;
  }

  const rest = inner.slice(separatorIndex + 1);
  const labelSeparatorIndex = rest.indexOf("|");
  const target = (labelSeparatorIndex >= 0 ? rest.slice(0, labelSeparatorIndex) : rest).trim();
  const label =
    labelSeparatorIndex >= 0
      ? (() => {
          const next = rest.slice(labelSeparatorIndex + 1).trim();
          return next.length > 0 ? next : null;
        })()
      : null;
  if (!target) {
    return null;
  }

  if (kind === "conversation" || kind === "thread") {
    return {
      reference: {
        kind,
        raw,
        conversationId: target,
        label,
      },
      end: end + 2,
    };
  }

  const messageSeparatorIndex = target.indexOf("/");
  if (messageSeparatorIndex <= 0 || messageSeparatorIndex >= target.length - 1) {
    return null;
  }

  const conversationId = target.slice(0, messageSeparatorIndex).trim();
  const messageId = target.slice(messageSeparatorIndex + 1).trim();
  if (!conversationId || !messageId) {
    return null;
  }

  return {
    reference: {
      kind,
      raw,
      conversationId,
      messageId,
      label,
    },
    end: end + 2,
  };
}

export function tokenizeChatLine(
  text: string,
  agentMentionHandles?: ReadonlySet<string> | null,
): ChatLineTokenChunk[] {
  if (!text) {
    return [];
  }
  const tokens: ChatLineTokenChunk[] = [];
  let cursor = 0;
  let index = 0;

  while (index < text.length) {
    const inlineCodeMatch = findInlineCodeAt(text, index);
    if (inlineCodeMatch) {
      if (inlineCodeSpanLooksMalformed(inlineCodeMatch.value)) {
        if (index > cursor) {
          tokens.push({ type: "text", value: text.slice(cursor, index) });
        }
        index += 1;
        cursor = index;
        continue;
      }
      if (index > cursor) {
        tokens.push({ type: "text", value: text.slice(cursor, index) });
      }
      const inlineCodeValue = inlineCodeMatch.value.trim();
      const fileMatch = findWorkspaceFileReferenceAt(inlineCodeValue, 0);
      if (fileMatch && fileMatch.end === inlineCodeValue.length) {
        tokens.push({ type: "workspace-file", value: fileMatch.reference });
      } else {
        tokens.push({ type: "inline-code", value: inlineCodeMatch.value });
      }
      index = inlineCodeMatch.end;
      cursor = index;
      continue;
    }

    const strongMatch = findStrongEmphasisAt(text, index);
    if (strongMatch) {
      if (index > cursor) {
        tokens.push({ type: "text", value: text.slice(cursor, index) });
      }
      tokens.push({ type: "strong", value: strongMatch.value });
      index = strongMatch.end;
      cursor = index;
      continue;
    }

    const conversationReferenceMatch = findConversationReferenceAt(text, index);
    if (conversationReferenceMatch) {
      if (index > cursor) {
        tokens.push({ type: "text", value: text.slice(cursor, index) });
      }
      tokens.push({ type: "conversation-reference", value: conversationReferenceMatch.reference });
      index = conversationReferenceMatch.end;
      cursor = index;
      continue;
    }

    const markdownLinkMatch = findMarkdownLinkAt(text, index);
    if (markdownLinkMatch) {
      if (index > cursor) {
        tokens.push({ type: "text", value: text.slice(cursor, index) });
      }
      tokens.push({ type: "link", value: markdownLinkMatch.reference });
      index = markdownLinkMatch.end;
      cursor = index;
      continue;
    }

    const urlMatch = findUrlAt(text, index);
    if (urlMatch) {
      if (index > cursor) {
        tokens.push({ type: "text", value: text.slice(cursor, index) });
      }
      tokens.push({ type: "link", value: urlMatch.reference });
      index = urlMatch.end;
      cursor = index;
      continue;
    }

    const fileMatch = findWorkspaceFileReferenceAt(text, index);
    if (fileMatch) {
      if (index > cursor) {
        tokens.push({ type: "text", value: text.slice(cursor, index) });
      }
      tokens.push({ type: "workspace-file", value: fileMatch.reference });
      index = fileMatch.end;
      cursor = index;
      continue;
    }

    if (text[index] === "@") {
      const mention = findAgentMentionAt(text, index, agentMentionHandles);
      if (mention) {
        if (index > cursor) {
          tokens.push({ type: "text", value: text.slice(cursor, index) });
        }
        if (mention.type === "assistant-mention") {
          tokens.push({ type: "assistant-mention", value: mention.token });
        } else {
          tokens.push({ type: "agent-mention", value: mention.token });
        }
        index = mention.end;
        cursor = index;
        continue;
      }
    }

    index += 1;
  }

  if (cursor < text.length) {
    tokens.push({ type: "text", value: text.slice(cursor) });
  }

  return tokens;
}

export function parseTeamFlowLine(line: string): TeamFlowLineDescriptor | null {
  const prefixMatch = line.match(TEAM_FLOW_LINE_PREFIX_REGEX);
  if (!prefixMatch) {
    return null;
  }
  const body = line.slice(prefixMatch[0].length);
  if (!body.trim()) {
    return null;
  }

  const tokens = tokenizeChatLine(body);
  const references: ConversationReferenceDescriptor[] = [];
  let separatorText = "";
  for (const token of tokens) {
    if (token.type === "conversation-reference") {
      references.push(token.value);
      continue;
    }
    if (token.type === "text") {
      separatorText += token.value;
      continue;
    }
    return null;
  }

  if (references.length < 2 || !TEAM_FLOW_SEPARATOR_TEXT_REGEX.test(separatorText)) {
    return null;
  }

  return { label: "Workstreams", references };
}

export function parseMessageContentBlocks(content: string): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [];
  let pendingList: Extract<MessageContentBlock, { kind: "list" }> | null = null;
  let pendingQuote: Extract<MessageContentBlock, { kind: "quote" }> | null = null;

  const flushList = () => {
    if (pendingList) {
      blocks.push(pendingList);
      pendingList = null;
    }
  };
  const flushQuote = () => {
    if (pendingQuote) {
      blocks.push(pendingQuote);
      pendingQuote = null;
    }
  };

  for (const rawLine of content.split(/\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushList();
      flushQuote();
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushList();
      if (!pendingQuote) {
        pendingQuote = { kind: "quote", lines: [] };
      }
      pendingQuote.lines.push(quoteMatch[1] ?? "");
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      flushQuote();
      const ordered = Boolean(orderedMatch);
      const item = (orderedMatch?.[2] ?? unorderedMatch?.[1] ?? "").trim();
      const start = orderedMatch ? Number.parseInt(orderedMatch[1] ?? "1", 10) : undefined;
      if (!pendingList || pendingList.ordered !== ordered) {
        flushList();
        pendingList = {
          kind: "list",
          ordered,
          start: ordered ? start : undefined,
          items: [],
        };
      }
      pendingList.items.push(item);
      continue;
    }

    flushList();
    flushQuote();
    blocks.push({ kind: "paragraph", line });
  }

  flushList();
  flushQuote();
  return blocks.length > 0 ? blocks : [{ kind: "paragraph", line: "" }];
}
