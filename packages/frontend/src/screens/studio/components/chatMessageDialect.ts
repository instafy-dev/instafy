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

export type GitHubReferenceDescriptor = {
  url: string;
  owner: string;
  repo: string;
  number: number;
  kind: "pull" | "issue";
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
  | { type: "link"; value: UrlReferenceDescriptor }
  | { type: "github-reference"; value: GitHubReferenceDescriptor };

export type MessageListItem = {
  text: string;
  /** Nesting level: 0 for top-level items, 1 for their sublists, and so on. */
  depth: number;
  /** Marker style of THIS item's level (an ordered list may nest bullets). */
  ordered: boolean;
};

export type MessageContentBlock =
  | { kind: "paragraph"; line: string }
  | { kind: "list"; ordered: boolean; start?: number; items: MessageListItem[] }
  | { kind: "quote"; lines: string[] }
  | {
      kind: "code";
      language: string | null;
      lines: string[];
      /** Set when the fence opened inside a list item's content, so the renderer can keep the item's indent. */
      inListItem?: boolean;
    };

const WORKSPACE_FILE_REFERENCE_REGEX =
  /^((?:\/workspace\/[^/\s<>"'`()]+\/)?[0-9A-Za-z_.-]+(?:\/[0-9A-Za-z_.-]+)*\.(?:markdown|md|json|tsx?|jsx?|ya?ml|toml|py|rs|css|html|txt|sh|sql))(?:#L(\d+)|:(\d+))?/;
const URL_REFERENCE_REGEX = /^(https?:\/\/[^\s<>"'`]+)/i;
// Only the exact PR/issue page shape chips — deeper paths (files, comments,
// diffs) and other GitHub pages keep their full URL rendering.
const GITHUB_REFERENCE_URL_REGEX =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/(pull|issues)\/(\d+)$/i;
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

export function parseGitHubReferenceUrl(url: string): GitHubReferenceDescriptor | null {
  const match = url.match(GITHUB_REFERENCE_URL_REGEX);
  if (!match) {
    return null;
  }
  const owner = match[1] ?? "";
  const repo = match[2] ?? "";
  const number = Number.parseInt(match[4] ?? "", 10);
  if (!owner || !repo || !Number.isFinite(number) || number <= 0) {
    return null;
  }
  return {
    url,
    owner,
    repo,
    number,
    kind: (match[3] ?? "").toLowerCase() === "pull" ? "pull" : "issue",
  };
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
      const githubReference = parseGitHubReferenceUrl(urlMatch.reference.url);
      if (githubReference) {
        tokens.push({ type: "github-reference", value: githubReference });
      } else {
        tokens.push({ type: "link", value: urlMatch.reference });
      }
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

type PendingCodeFence = {
  block: Extract<MessageContentBlock, { kind: "code" }>;
  marker: "`" | "~";
  markerLength: number;
  indent: number;
};

// CommonMark: the info string of a backtick fence may not contain backticks —
// a line like "```echo `hi` done```" is an inline code span, not a fence.
function parseCodeFenceOpening(line: string): PendingCodeFence | null {
  const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }
  const marker = (match[2]?.charAt(0) ?? "`") as "`" | "~";
  const info = match[3] ?? "";
  if (marker === "`" && info.includes("`")) {
    return null;
  }
  const language = info.trim().split(/\s+/)[0] || null;
  return {
    block: { kind: "code", language, lines: [] },
    marker,
    markerLength: match[2]?.length ?? 3,
    indent: match[1]?.length ?? 0,
  };
}

function isCodeFenceClosing(line: string, fence: PendingCodeFence): boolean {
  const match = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  if (!match) {
    return false;
  }
  const run = match[1] ?? "";
  return run.charAt(0) === fence.marker && run.length >= fence.markerLength;
}

// CommonMark strips up to the opening fence's indentation from content lines,
// so a fence indented inside a list item still yields unindented code.
function stripCodeFenceIndent(line: string, indent: number): string {
  let removed = 0;
  while (removed < indent && line.charAt(removed) === " ") {
    removed += 1;
  }
  return line.slice(removed);
}

export function parseMessageContentBlocks(content: string): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [];
  let pendingList: Extract<MessageContentBlock, { kind: "list" }> | null = null;
  // Indentation of each open list level, innermost last; a deeper-indented
  // item opens a sublist, a shallower one returns to the matching ancestor.
  let pendingListIndentStack: number[] = [];
  // Flat-sublist leniency (#191). Real agent markdown writes
  //   "1. Persistent-context skills:" followed by UNINDENTED "- `autofix-x`: …"
  // bullets. CommonMark makes those a sibling bullet list, which renders as a
  // flat "1. • • • 2. • 3." sequence. A human reads them as the item's
  // sublist, so the parser does too, under one asymmetric, conservative rule:
  //   - a bullet item that directly follows an ORDERED item (no blank line)
  //     and is not indented enough to nest on its own becomes that item's
  //     sublist at depth + 1, whatever the item's trailing punctuation;
  //   - across exactly ONE blank line the same happens only when the ordered
  //     item ends with ":" (it announced a list), or a flat sublist is already
  //     open (a LOOSE flat sublist — blank lines between its own bullets —
  //     keeps nesting instead of splitting mid-list); without either, or after
  //     two blank lines, the bullets stay a sibling block as CommonMark says;
  //   - an ordered item after a bullet never nests this way, and the indented
  //     form keeps its existing, explicit nesting.
  // The virtual level lives on the indent stack like an indented one would, so
  // deeper indented bullets under a flat bullet still nest via indentation;
  // `flatSublistLevel` remembers its index so a following ordered item at the
  // parent's level can close it.
  let flatSublistLevel: number | null = null;
  let listSurvivesBlankLine = false;
  let pendingQuote: Extract<MessageContentBlock, { kind: "quote" }> | null = null;
  let pendingCode: PendingCodeFence | null = null;
  // CommonMark: consecutive non-blank paragraph lines are one paragraph — only
  // a blank line (or a line another block type claims) starts a new one.
  // Lines accumulate here and join with "\n" on flush; `whitespace-pre-wrap`
  // in the renderer turns that embedded newline back into a soft line break
  // inside the single <p>, so a hard-wrapped source (a runbook, pasted docs)
  // no longer gets a `<p>` + `mt-2` per source line (#210).
  let pendingParagraph: string[] | null = null;

  const flushList = () => {
    if (pendingList) {
      blocks.push(pendingList);
      pendingList = null;
      pendingListIndentStack = [];
    }
    flatSublistLevel = null;
    listSurvivesBlankLine = false;
  };
  const flushQuote = () => {
    if (pendingQuote) {
      blocks.push(pendingQuote);
      pendingQuote = null;
    }
  };
  const flushCode = () => {
    if (pendingCode) {
      blocks.push(pendingCode.block);
      pendingCode = null;
    }
  };
  const flushParagraph = () => {
    if (pendingParagraph) {
      blocks.push({ kind: "paragraph", line: pendingParagraph.join("\n") });
      pendingParagraph = null;
    }
  };

  for (const rawLine of content.split(/\n/)) {
    const line = rawLine.trimEnd();
    if (pendingCode) {
      if (isCodeFenceClosing(line, pendingCode)) {
        flushCode();
      } else {
        pendingCode.block.lines.push(stripCodeFenceIndent(line, pendingCode.indent));
      }
      continue;
    }

    if (!line.trim()) {
      const lastListItem = pendingList?.items[pendingList.items.length - 1];
      if (
        pendingList?.ordered &&
        !listSurvivesBlankLine &&
        ((lastListItem?.ordered && lastListItem.text.endsWith(":")) || flatSublistLevel !== null)
      ) {
        // The item announced a list, or a flat sublist is already open: hold
        // the flush for one blank line and let the next line decide (see the
        // leniency rule above). Holding while a flat sublist is open keeps a
        // LOOSE flat sublist — one with a blank line between its own bullets,
        // not just before its first one — from splitting into a separate
        // sibling list mid-way through.
        listSurvivesBlankLine = true;
      } else {
        flushList();
      }
      flushQuote();
      flushParagraph();
      continue;
    }

    if (listSurvivesBlankLine) {
      listSurvivesBlankLine = false;
      // Only a bullet line may continue the held list across the blank line;
      // anything else gets the flush the blank line would have done.
      if (!/^\s*[-*]\s+\S/.test(line)) {
        flushList();
      }
    }

    const fenceOpening = parseCodeFenceOpening(line);
    if (fenceOpening) {
      // A fence opened while a list is still pending (or indented like list
      // content) belongs to that item; the renderer keeps the item's indent.
      if (pendingList !== null || fenceOpening.indent >= 2) {
        fenceOpening.block.inListItem = true;
      }
      flushList();
      flushQuote();
      flushParagraph();
      pendingCode = fenceOpening;
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushList();
      flushParagraph();
      if (!pendingQuote) {
        pendingQuote = { kind: "quote", lines: [] };
      }
      pendingQuote.lines.push(quoteMatch[1] ?? "");
      continue;
    }

    const unorderedMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      flushQuote();
      flushParagraph();
      const ordered = Boolean(orderedMatch);
      const indent = (orderedMatch?.[1] ?? unorderedMatch?.[1] ?? "").length;
      const item = (orderedMatch?.[3] ?? unorderedMatch?.[2] ?? "").trim();
      const start = orderedMatch ? Number.parseInt(orderedMatch[2] ?? "1", 10) : undefined;
      // Indented items nest inside the pending list instead of starting a
      // sibling block, so "1. step" followed by "   - detail" renders as an
      // ordered item with a bulleted sublist.
      const nestsInPendingList =
        pendingList !== null &&
        pendingListIndentStack.length > 0 &&
        indent >= (pendingListIndentStack[0] ?? 0) + 2;
      // Flat-sublist leniency (#191): an unindented bullet after an ordered
      // item, or while such a flat sublist is already open, nests instead of
      // starting a sibling block. Ordered items never take this path.
      const lastListItem = pendingList?.items[pendingList.items.length - 1];
      const nestsAsFlatSublist =
        pendingList !== null &&
        pendingList.ordered &&
        !ordered &&
        !nestsInPendingList &&
        (flatSublistLevel !== null || lastListItem?.ordered === true);
      if (
        !pendingList ||
        (!nestsInPendingList && !nestsAsFlatSublist && pendingList.ordered !== ordered)
      ) {
        flushList();
        pendingList = {
          kind: "list",
          ordered,
          start: ordered ? start : undefined,
          items: [],
        };
        pendingListIndentStack = [indent];
      } else {
        if (
          flatSublistLevel !== null &&
          ordered &&
          indent < (pendingListIndentStack[flatSublistLevel] ?? 0) + 2
        ) {
          // An ordered item back at the parent's level closes the flat sublist.
          pendingListIndentStack.length = flatSublistLevel;
          flatSublistLevel = null;
        }
        // Bullets never dedent past an open flat sublist: its level is where
        // they belong even though their indentation is the parent's.
        const shallowestLevel = flatSublistLevel !== null && !ordered ? flatSublistLevel + 1 : 1;
        while (
          pendingListIndentStack.length > shallowestLevel &&
          indent < (pendingListIndentStack[pendingListIndentStack.length - 1] ?? 0)
        ) {
          pendingListIndentStack.pop();
        }
        if (nestsAsFlatSublist && flatSublistLevel === null) {
          flatSublistLevel = pendingListIndentStack.length;
          pendingListIndentStack.push(indent);
        } else if (indent >= (pendingListIndentStack[pendingListIndentStack.length - 1] ?? 0) + 2) {
          pendingListIndentStack.push(indent);
        }
      }
      pendingList.items.push({
        text: item,
        depth: pendingListIndentStack.length - 1,
        ordered,
      });
      continue;
    }

    flushList();
    flushQuote();
    // A team-flow status line (see parseTeamFlowLine) is a synthesized,
    // self-contained line: it must stay its own block even with no blank
    // line around it, so the renderer's per-block `parseTeamFlowLine` check
    // still finds it instead of a merged, unparseable paragraph.
    if (parseTeamFlowLine(line)) {
      flushParagraph();
      blocks.push({ kind: "paragraph", line });
      continue;
    }
    if (pendingParagraph) {
      pendingParagraph.push(line);
    } else {
      pendingParagraph = [line];
    }
  }

  flushList();
  flushQuote();
  flushParagraph();
  // An unclosed fence runs to the end of the message, per CommonMark.
  flushCode();
  return blocks.length > 0 ? blocks : [{ kind: "paragraph", line: "" }];
}
