import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ChatBubble, GitBranch, QuoteMessage } from "iconoir-react";
import { requestAgentProfile } from "./agentProfileOpen";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useConversation } from "../../../conversations/useConversation";
import {
  getDefaultAssistantMentionToken,
  listBuiltInAssistantHandles,
} from "../../../assistants/localBuiltInAssistantCatalog";
import { Text } from "../../../components/Text";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import {
  addFloatingSurfaceViewportChangeListener,
  clampFloatingSurfacePositionToStudioViewport,
} from "../../../utils/floatingSurfacePosition";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { getAssistantMentionClass, resolveAssistantMentionToken } from "./assistantMentionUI";
import {
  parseMessageContentBlocks,
  parseTeamFlowLine,
  tokenizeChatLine,
  type ConversationReferenceDescriptor,
  type ChatLineTokenChunk,
  type MessageListItem,
  type WorkspaceFileReferenceDescriptor,
} from "./chatMessageDialect";
import { resolveProxyUpstreamErrorGuidance } from "./proxyError";

type WorkspaceFileReferencePresentation = {
  displayLabel: string;
  title: string;
  ariaLabel: string;
  previewHeaderLabel: string;
  previewHeaderContext: string | null;
};

type WorkspaceFilePreviewHeaderParts = {
  lead: string | null;
  tail: string;
};

type WorkspaceFilePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      content: string;
      size: number;
      mimeType: string | null;
      truncated: boolean;
      linePreview: WorkspaceFilePreviewLine[] | null;
    }
  | { status: "error"; message: string };

type WorkspaceFilePreviewLine = {
  lineNumber: number;
  text: string;
  highlighted: boolean;
};

type WorkspaceFilePreviewSyntaxLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "markdown"
  | "plaintext"
  | "python"
  | "rust"
  | "shell"
  | "typescript"
  | "yaml";

type WorkspaceFilePreviewSyntaxKind =
  | "comment"
  | "keyword"
  | "number"
  | "operator"
  | "plain"
  | "property"
  | "punctuation"
  | "string"
  | "type";

type WorkspaceFilePreviewSyntaxToken = {
  text: string;
  kind: WorkspaceFilePreviewSyntaxKind;
};

type WorkspaceFilePreviewPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
};

type WorkspaceFileActionMenuPosition = {
  left: number;
  top: number;
  maxHeight: number;
};

const WORKSPACE_FILE_PREVIEW_WIDTH_PX = 420;
const WORKSPACE_FILE_PREVIEW_MAX_HEIGHT_PX = 280;
const WORKSPACE_FILE_PREVIEW_MAX_CHARS = 3600;
const WORKSPACE_FILE_PREVIEW_CONTEXT_LINES = 5;
const WORKSPACE_FILE_PREVIEW_HOVER_DELAY_MS = 220;
const WORKSPACE_FILE_PREVIEW_TOUCH_DELAY_MS = 520;
const WORKSPACE_FILE_PREVIEW_TIMEOUT_MS = 5_000;
const WORKSPACE_FILE_PREVIEW_CACHE_TTL_MS = 30_000;
const WORKSPACE_FILE_ACTION_MENU_WIDTH_PX = 176;
const WORKSPACE_FILE_ACTION_MENU_HEIGHT_ESTIMATE_PX = 96;
const WORKSPACE_FILE_ACTION_MENU_PADDING_PX = 12;
const WORKSPACE_FILE_PREVIEW_INTENT_EVENT = "instafy:workspace-file-preview-intent";
// Punctuation that reads as part of the chip before it and must not wrap alone.
const CHIP_TRAILING_PUNCTUATION_REGEX = /^[:;,.!?)\]]+/;
const INLINE_CODE_TOKEN_CLASS = [
  "inline-flex items-center rounded-[0.34rem] bg-slate-950/[0.035] px-1.5 py-[0.08em] font-mono text-[0.92em] leading-[1.18] text-slate-700 ring-1 ring-inset ring-slate-900/10 shadow-[inset_0_-1px_0_rgba(15,23,42,0.07)] align-baseline",
  "dark:bg-white/[0.055] dark:text-slate-200 dark:ring-white/[0.08] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.045)]",
].join(" ");
const CODE_BLOCK_CLASS = [
  "block max-w-full overflow-x-auto whitespace-pre rounded-xl bg-slate-950/[0.035] px-3 py-2 font-mono text-[0.85em] leading-normal text-slate-700 ring-1 ring-inset ring-slate-900/10 shadow-[inset_0_-1px_0_rgba(15,23,42,0.07)]",
  "dark:bg-white/[0.055] dark:text-slate-200 dark:ring-white/[0.08] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.045)]",
].join(" ");
const GITHUB_REFERENCE_TOKEN_CLASS = [
  "inline-flex items-center gap-1 rounded-[0.34rem] bg-slate-950/[0.035] px-1.5 py-[0.08em] font-mono text-[0.92em] leading-[1.18] text-slate-700 no-underline ring-1 ring-inset ring-slate-900/10 shadow-[inset_0_-1px_0_rgba(15,23,42,0.07)] align-baseline transition hover:bg-slate-950/[0.06] hover:text-slate-900",
  "dark:bg-white/[0.055] dark:text-slate-200 dark:ring-white/[0.08] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.045)] dark:hover:bg-white/[0.09] dark:hover:text-slate-50",
].join(" ");
const WORKSPACE_FILE_REFERENCE_TOKEN_CLASS = [
  "inline-flex min-w-0 max-w-[14rem] items-center overflow-hidden rounded-[0.34rem] bg-primary-50/70 px-1.5 py-[0.08em] font-mono text-[0.92em] leading-[1.18] text-primary-700 ring-1 ring-inset ring-primary-200/80 shadow-[inset_0_-1px_0_rgba(0,122,204,0.08)] align-baseline sm:max-w-[24rem]",
  "dark:bg-primary-300/10 dark:text-primary-200 dark:ring-primary-300/20 dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.035)]",
].join(" ");

const QUOTE_SOURCE_BADGE_CLASS = [
  "absolute -top-2.5 right-3 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200/70 bg-white text-slate-400 shadow-[0_1px_2px_rgba(15,23,42,0.06)]",
  "dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-500 dark:shadow-none",
].join(" ");

type WorkspaceFilePreviewIntentEvent = CustomEvent<{ previewKey: string }>;

type WorkspaceFilePreviewCachedFile = {
  size: number;
  mimeType: string | null;
  contentText: string | null;
  isText: boolean;
};

type WorkspaceFilePreviewCacheEntry = {
  file: WorkspaceFilePreviewCachedFile;
  expiresAt: number;
};

type WorkspaceFilePreviewCacheRef = MutableRefObject<Map<string, WorkspaceFilePreviewCacheEntry>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractReplyContextSourceReference(
  metadata?: Record<string, unknown> | null,
): ConversationReferenceDescriptor | null {
  if (!metadata) {
    return null;
  }
  const promptMetadata = isRecord(metadata.promptMetadata)
    ? metadata.promptMetadata
    : isRecord(metadata.prompt_metadata)
      ? metadata.prompt_metadata
      : null;
  const replyContextValue =
    metadata.replyContext ??
    metadata.reply_context ??
    promptMetadata?.replyContext ??
    promptMetadata?.reply_context;
  if (!isRecord(replyContextValue) || replyContextValue.kind !== "message_selection") {
    return null;
  }

  const conversationId = readTrimmedString(replyContextValue.conversationId ?? replyContextValue.conversation_id);
  const messageId = readTrimmedString(replyContextValue.messageId ?? replyContextValue.message_id);
  if (!conversationId || !messageId) {
    return null;
  }

  return {
    kind: "message",
    raw: "",
    conversationId,
    messageId,
    label: "quoted source",
  };
}

const JAVASCRIPT_TYPESCRIPT_PREVIEW_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "let",
  "new",
  "of",
  "return",
  "throw",
  "try",
  "type",
  "typeof",
  "var",
  "while",
]);
const RUST_PREVIEW_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "const",
  "crate",
  "enum",
  "fn",
  "impl",
  "let",
  "match",
  "mod",
  "mut",
  "pub",
  "return",
  "self",
  "struct",
  "trait",
  "type",
  "use",
  "where",
]);
const PYTHON_PREVIEW_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "class",
  "def",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "if",
  "import",
  "in",
  "lambda",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
const PREVIEW_BUILTIN_TYPES = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Map",
  "Number",
  "Promise",
  "Record",
  "Set",
  "String",
  "Uint8Array",
  "bigint",
  "boolean",
  "number",
  "string",
  "unknown",
  "void",
]);

function parseImportedRepoWorkspacePath(path: string): { repoFolder: string; relativePath: string } | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "repos") {
    return null;
  }
  const repoFolder = segments[1]?.trim() ?? "";
  const relativePath = segments.slice(2).join("/");
  if (!repoFolder || !relativePath) {
    return null;
  }
  return { repoFolder, relativePath };
}

function formatWorkspaceFileReferencePresentation(
  reference: WorkspaceFileReferenceDescriptor,
): WorkspaceFileReferencePresentation {
  const rawLabel = reference.raw.trim() || reference.path;
  const path = reference.path.trim();
  if (!path) {
    return {
      displayLabel: rawLabel,
      title: rawLabel,
      ariaLabel: `Open workspace file: ${rawLabel}`,
      previewHeaderLabel: rawLabel,
      previewHeaderContext: null,
    };
  }

  const suffix = rawLabel.startsWith(path)
    ? rawLabel.slice(path.length)
    : rawLabel.match(/(?:#L\d+|:\d+)$/)?.[0] ?? "";
  const importedRepoPath = parseImportedRepoWorkspacePath(path);
  const userPath = importedRepoPath?.relativePath ?? path;
  const segments = userPath.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1]?.trim();
  const displayLabel = fileName ? `${fileName}${suffix}` : rawLabel;
  const previewHeaderLabel = `${userPath}${suffix}`;
  const previewHeaderContext = importedRepoPath
    ? `Imported repo: ${importedRepoPath.repoFolder}`
    : null;
  const normalizedLabel = `${path}${suffix}`;
  const title = importedRepoPath
    ? `${previewHeaderLabel} - ${previewHeaderContext}. Workspace path: ${normalizedLabel}`
    : rawLabel === normalizedLabel
      ? rawLabel
      : `${previewHeaderLabel} - Original path: ${rawLabel}`;
  const ariaLabel = importedRepoPath
    ? `Open workspace file: ${previewHeaderLabel} in imported repo ${importedRepoPath.repoFolder}`
    : `Open workspace file: ${previewHeaderLabel}`;

  return {
    displayLabel,
    title,
    ariaLabel,
    previewHeaderLabel,
    previewHeaderContext,
  };
}

function formatWorkspaceFilePreviewHeaderParts(label: string): WorkspaceFilePreviewHeaderParts {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return { lead: null, tail: label };
  }

  const suffixMatch = trimmedLabel.match(/(?:#L\d+|:\d+)$/);
  const suffix = suffixMatch?.[0] ?? "";
  const pathWithoutSuffix = suffix ? trimmedLabel.slice(0, -suffix.length) : trimmedLabel;
  const segments = pathWithoutSuffix.split("/").filter(Boolean);
  if (segments.length <= 5) {
    return { lead: null, tail: trimmedLabel };
  }

  return {
    lead: `${segments[0]}/…/`,
    tail: `${segments.slice(-4).join("/")}${suffix}`,
  };
}

function inferWorkspaceFilePreviewLanguage(
  path: string,
  mimeType?: string | null,
): WorkspaceFilePreviewSyntaxLanguage {
  const normalizedPath = path.trim().toLowerCase();
  const extension = normalizedPath.match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  switch (extension) {
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "ts":
    case "tsx":
      return "typescript";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      break;
  }

  const normalizedMimeType = (mimeType ?? "").trim().toLowerCase();
  if (normalizedMimeType.includes("typescript")) {
    return "typescript";
  }
  if (normalizedMimeType.includes("javascript")) {
    return "javascript";
  }
  if (normalizedMimeType.includes("json")) {
    return "json";
  }
  if (normalizedMimeType.includes("markdown")) {
    return "markdown";
  }
  if (normalizedMimeType.includes("css")) {
    return "css";
  }
  if (normalizedMimeType.includes("html")) {
    return "html";
  }
  return "plaintext";
}

function resolveWorkspaceFilePreviewKeywordKind(
  word: string,
  language: WorkspaceFilePreviewSyntaxLanguage,
  line: string,
  endIndex: number,
): WorkspaceFilePreviewSyntaxKind {
  if (PREVIEW_BUILTIN_TYPES.has(word)) {
    return "type";
  }
  if ((language === "javascript" || language === "typescript") && JAVASCRIPT_TYPESCRIPT_PREVIEW_KEYWORDS.has(word)) {
    return "keyword";
  }
  if (language === "rust" && RUST_PREVIEW_KEYWORDS.has(word)) {
    return "keyword";
  }
  if (language === "python" && PYTHON_PREVIEW_KEYWORDS.has(word)) {
    return "keyword";
  }
  if (language === "json") {
    const nextNonSpace = line.slice(endIndex).match(/\S/)?.[0] ?? "";
    if (nextNonSpace === ":") {
      return "property";
    }
  }
  return "plain";
}

function tokenizeWorkspaceFilePreviewLine(
  text: string,
  language: WorkspaceFilePreviewSyntaxLanguage,
): WorkspaceFilePreviewSyntaxToken[] {
  if (language === "markdown" || language === "plaintext") {
    return [{ text, kind: "plain" }];
  }

  const tokens: WorkspaceFilePreviewSyntaxToken[] = [];
  let index = 0;
  const pushToken = (tokenText: string, kind: WorkspaceFilePreviewSyntaxKind) => {
    if (tokenText.length > 0) {
      tokens.push({ text: tokenText, kind });
    }
  };

  while (index < text.length) {
    const char = text[index] ?? "";
    const rest = text.slice(index);

    if (/\s/.test(char)) {
      const match = rest.match(/^\s+/);
      const value = match?.[0] ?? char;
      pushToken(value, "plain");
      index += value.length;
      continue;
    }

    if (
      (["javascript", "typescript", "rust"].includes(language) && rest.startsWith("//")) ||
      (["python", "shell", "yaml"].includes(language) && rest.startsWith("#"))
    ) {
      pushToken(rest, "comment");
      break;
    }

    if (
      (["css", "javascript", "typescript", "rust"].includes(language) && rest.startsWith("/*")) ||
      (language === "html" && rest.startsWith("<!--"))
    ) {
      pushToken(rest, "comment");
      break;
    }

    if (char === "\"" || char === "'" || (char === "`" && ["javascript", "typescript", "shell"].includes(language))) {
      let cursor = index + 1;
      while (cursor < text.length) {
        const cursorChar = text[cursor];
        if (cursorChar === "\\") {
          cursor += 2;
          continue;
        }
        cursor += 1;
        if (cursorChar === char) {
          break;
        }
      }
      pushToken(text.slice(index, cursor), "string");
      index = cursor;
      continue;
    }

    const numberMatch = rest.match(/^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/);
    if (numberMatch) {
      pushToken(numberMatch[0], "number");
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = rest.match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (identifierMatch) {
      const word = identifierMatch[0];
      pushToken(
        word,
        resolveWorkspaceFilePreviewKeywordKind(word, language, text, index + word.length),
      );
      index += word.length;
      continue;
    }

    const operatorMatch = rest.match(/^(?:=>|===|!==|==|!=|<=|>=|\+\+|--|\|\||&&|[=+\-*/%<>!&|?:]+)/);
    if (operatorMatch) {
      pushToken(operatorMatch[0], "operator");
      index += operatorMatch[0].length;
      continue;
    }

    if (/^[()[\]{}.,;]/.test(char)) {
      pushToken(char, "punctuation");
      index += 1;
      continue;
    }

    pushToken(char, "plain");
    index += 1;
  }

  return tokens.length > 0 ? tokens : [{ text, kind: "plain" }];
}

function getWorkspaceFilePreviewSyntaxClass(kind: WorkspaceFilePreviewSyntaxKind): string {
  switch (kind) {
    case "comment":
      return "text-slate-400 italic dark:text-slate-500";
    case "keyword":
      return "font-semibold text-primary-700 dark:text-primary-300";
    case "number":
      return "text-amber-700 dark:text-amber-300";
    case "operator":
      return "text-slate-500 dark:text-slate-400";
    case "property":
      return "text-violet-700 dark:text-violet-300";
    case "punctuation":
      return "text-slate-500 dark:text-slate-400";
    case "string":
      return "text-emerald-700 dark:text-emerald-300";
    case "type":
      return "text-sky-700 dark:text-sky-300";
    case "plain":
    default:
      return "";
  }
}

function resolveWorkspaceFilePreviewPosition(anchor: HTMLElement): WorkspaceFilePreviewPosition {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = typeof window === "undefined" ? WORKSPACE_FILE_PREVIEW_WIDTH_PX : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 720 : window.innerHeight;
  const composerOverlay =
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLElement>('[data-testid="chat-composer-overlay"]');
  const composerTop = composerOverlay?.getBoundingClientRect().top;
  const lowerBoundary =
    typeof composerTop === "number" && Number.isFinite(composerTop) && composerTop > 0 && composerTop < viewportHeight - 8
      ? Math.max(120, composerTop - 12)
      : viewportHeight;
  const width = Math.min(WORKSPACE_FILE_PREVIEW_WIDTH_PX, Math.max(220, viewportWidth - 24));
  const left = Math.min(Math.max(12, rect.left), Math.max(12, viewportWidth - width - 12));
  const bottomTop = rect.bottom + 10;
  const availableBelow = lowerBoundary - bottomTop;
  const availableAbove = rect.top - 10;

  if (availableBelow >= WORKSPACE_FILE_PREVIEW_MAX_HEIGHT_PX || availableBelow >= availableAbove) {
    return { left, top: bottomTop, width };
  }

  return {
    bottom: Math.max(12, viewportHeight - rect.top + 10),
    left,
    width,
  };
}

function resolveWorkspaceFileActionMenuPosition(
  clientX: number,
  clientY: number,
): WorkspaceFileActionMenuPosition {
  const { x, y, maxHeight } = clampFloatingSurfacePositionToStudioViewport({
    clientX,
    clientY,
    surfaceWidth: WORKSPACE_FILE_ACTION_MENU_WIDTH_PX,
    surfaceHeight: WORKSPACE_FILE_ACTION_MENU_HEIGHT_ESTIMATE_PX,
    padding: WORKSPACE_FILE_ACTION_MENU_PADDING_PX,
  });
  return {
    left: x,
    top: y,
    maxHeight,
  };
}

function formatWorkspaceFilePreviewContent(
  content: string,
  targetLine?: number | null,
): { content: string; truncated: boolean; linePreview: WorkspaceFilePreviewLine[] | null } {
  const normalizedTargetLine =
    typeof targetLine === "number" && Number.isFinite(targetLine) && targetLine > 0
      ? Math.floor(targetLine)
      : null;
  if (normalizedTargetLine) {
    const lines = content.split(/\r\n|\n|\r/);
    const targetIndex = normalizedTargetLine - 1;
    if (targetIndex >= 0 && targetIndex < lines.length) {
      const startIndex = Math.max(0, targetIndex - WORKSPACE_FILE_PREVIEW_CONTEXT_LINES);
      const endIndex = Math.min(lines.length, targetIndex + WORKSPACE_FILE_PREVIEW_CONTEXT_LINES + 1);
      return {
        content: lines.slice(startIndex, endIndex).join("\n"),
        truncated: startIndex > 0 || endIndex < lines.length,
        linePreview: lines.slice(startIndex, endIndex).map((text, index) => {
          const lineNumber = startIndex + index + 1;
          return {
            lineNumber,
            text,
            highlighted: lineNumber === normalizedTargetLine,
          };
        }),
      };
    }
  }

  if (content.length <= WORKSPACE_FILE_PREVIEW_MAX_CHARS) {
    return { content, truncated: false, linePreview: null };
  }
  return {
    content: content.slice(0, WORKSPACE_FILE_PREVIEW_MAX_CHARS).trimEnd(),
    truncated: true,
    linePreview: null,
  };
}

function withWorkspaceFilePreviewTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = window.setTimeout(() => {
      reject(new Error("Preview is taking too long. Click the file to open it."));
    }, WORKSPACE_FILE_PREVIEW_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutHandle);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

function announceWorkspaceFilePreviewIntent(previewKey: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_FILE_PREVIEW_INTENT_EVENT, {
      detail: { previewKey },
    }),
  );
}

function getWorkspaceFilePreviewCacheKey(projectId: string, path: string): string {
  return `${projectId}:${path}`;
}

function resolveCachedWorkspaceFilePreviewState(
  cachedFile: WorkspaceFilePreviewCachedFile,
  targetLine?: number | null,
): WorkspaceFilePreviewState {
  if (!cachedFile.isText || cachedFile.contentText === null) {
    return { status: "error", message: "Preview is only available for text files." };
  }
  const preview = formatWorkspaceFilePreviewContent(cachedFile.contentText, targetLine ?? null);
  return {
    status: "ready",
    content: preview.content,
    size: cachedFile.size,
    mimeType: cachedFile.mimeType,
    truncated: preview.truncated,
    linePreview: preview.linePreview,
  };
}

function WorkspaceFileReferenceChip({
  reference,
  projectId,
  onOpen,
  previewCacheRef,
}: {
  reference: WorkspaceFileReferenceDescriptor;
  projectId?: string | null;
  onOpen: (reference: WorkspaceFileReferenceDescriptor) => void;
  previewCacheRef: WorkspaceFilePreviewCacheRef;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const previewRef = useRef<HTMLSpanElement | null>(null);
  const previewBodyRef = useRef<HTMLSpanElement | null>(null);
  const actionMenuRef = useRef<HTMLSpanElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const touchTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPosition, setPreviewPosition] = useState<WorkspaceFilePreviewPosition | null>(null);
  const [previewState, setPreviewState] = useState<WorkspaceFilePreviewState>({ status: "idle" });
  const previewLoadKeyRef = useRef<string | null>(null);
  const previewStateRef = useRef<WorkspaceFilePreviewState>({ status: "idle" });
  const [previewLoadNonce, setPreviewLoadNonce] = useState(0);
  const [actionMenuPosition, setActionMenuPosition] = useState<WorkspaceFileActionMenuPosition | null>(null);

  const canNavigate = Boolean(reference.path.trim().length > 0);
  const presentation = formatWorkspaceFileReferencePresentation(reference);
  const displayLabel = presentation.displayLabel;
  const previewHeaderParts = formatWorkspaceFilePreviewHeaderParts(presentation.previewHeaderLabel);
  const previewLanguage = inferWorkspaceFilePreviewLanguage(
    reference.path,
    previewState.status === "ready" ? previewState.mimeType : null,
  );
  const previewKey = `${projectId ?? ""}:${reference.path}:${reference.line ?? ""}`;
  const previewLineNumberColumnWidth =
    previewState.status === "ready" && previewState.linePreview
      ? `${Math.max(2, ...previewState.linePreview.map((line) => String(line.lineNumber).length))}ch`
      : "2ch";
  const renderPreviewSyntaxContent = (content: string, keyPrefix: string) =>
    content.split(/(\r\n|\n|\r)/).map((part, partIndex) => {
      if (part === "\r\n" || part === "\n" || part === "\r") {
        return part;
      }
      return tokenizeWorkspaceFilePreviewLine(part, previewLanguage).map((token, tokenIndex) => (
        <span
          key={`${keyPrefix}-${partIndex}-${tokenIndex}`}
          data-syntax-kind={token.kind === "plain" ? undefined : token.kind}
          className={getWorkspaceFilePreviewSyntaxClass(token.kind) || undefined}
        >
          {token.text}
        </span>
      ));
    });

  const clearTimer = useCallback((timerRef: MutableRefObject<number | null>) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    previewStateRef.current = previewState;
  }, [previewState]);

  const openPreview = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || !canNavigate) {
      return;
    }
    setPreviewPosition(resolveWorkspaceFilePreviewPosition(anchor));
    if (previewStateRef.current.status !== "ready") {
      previewLoadKeyRef.current = null;
      setPreviewState({ status: "idle" });
      setPreviewLoadNonce((current) => current + 1);
    }
    setPreviewOpen(true);
  }, [canNavigate]);

  const scheduleHidePreview = useCallback(() => {
    clearTimer(hideTimerRef);
    hideTimerRef.current = window.setTimeout(() => {
      setPreviewOpen(false);
    }, 120);
  }, [clearTimer]);

  const cancelHidePreview = useCallback(() => {
    clearTimer(hideTimerRef);
  }, [clearTimer]);

  useEffect(() => {
    setPreviewOpen(false);
    setPreviewPosition(null);
    setPreviewState({ status: "idle" });
    previewLoadKeyRef.current = null;
    setPreviewLoadNonce(0);
    setActionMenuPosition(null);
    suppressNextClickRef.current = false;
  }, [previewKey]);

  useEffect(() => {
    const handlePreviewIntent = (event: Event) => {
      const detail = (event as WorkspaceFilePreviewIntentEvent).detail;
      if (!detail || detail.previewKey === previewKey) {
        return;
      }
      clearTimer(hoverTimerRef);
      clearTimer(hideTimerRef);
      clearTimer(touchTimerRef);
      setPreviewOpen(false);
      setPreviewPosition(null);
      setActionMenuPosition(null);
      suppressNextClickRef.current = false;
    };
    window.addEventListener(WORKSPACE_FILE_PREVIEW_INTENT_EVENT, handlePreviewIntent);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_PREVIEW_INTENT_EVENT, handlePreviewIntent);
    };
  }, [clearTimer, previewKey]);

  useEffect(() => {
    if (!previewOpen) {
      return;
    }
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      setPreviewPosition(resolveWorkspaceFilePreviewPosition(anchor));
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [previewOpen]);

  useEffect(() => {
    if (!previewOpen) {
      return;
    }
    const handlePointerDownOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (anchorRef.current?.contains(target) || previewRef.current?.contains(target)) {
        return;
      }
      setPreviewOpen(false);
    };
    // Escape mirrors the action-menu sibling below — every dismissible
    // floating surface answers the keyboard.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDownOutside, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDownOutside, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [previewOpen]);

  useEffect(() => {
    if (!actionMenuPosition) {
      return;
    }
    const handlePointerDownOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (anchorRef.current?.contains(target) || actionMenuRef.current?.contains(target)) {
        return;
      }
      setActionMenuPosition(null);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setActionMenuPosition(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDownOutside, true);
    document.addEventListener("keydown", handleKeyDown);
    const removeViewportChangeListener = addFloatingSurfaceViewportChangeListener(() => {
      setActionMenuPosition(null);
    });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDownOutside, true);
      document.removeEventListener("keydown", handleKeyDown);
      removeViewportChangeListener();
    };
  }, [actionMenuPosition]);

  useEffect(() => {
    return () => {
      clearTimer(hoverTimerRef);
      clearTimer(hideTimerRef);
      clearTimer(touchTimerRef);
    };
  }, [clearTimer]);

  useEffect(() => {
    if (
      !previewOpen ||
      previewStateRef.current.status !== "idle" ||
      previewLoadKeyRef.current === previewKey
    ) {
      return;
    }
    previewLoadKeyRef.current = previewKey;
    const path = reference.path.trim();
    const activeProjectId = projectId?.trim() ?? "";
    if (!activeProjectId) {
      setPreviewState({ status: "error", message: "Pick a space before previewing files." });
      return;
    }
    if (!path) {
      setPreviewState({ status: "error", message: "Missing file path." });
      return;
    }
    const cache = previewCacheRef.current;
    const cacheKey = getWorkspaceFilePreviewCacheKey(activeProjectId, path);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setPreviewState(resolveCachedWorkspaceFilePreviewState(cached.file, reference.line ?? null));
      return;
    }
    if (cached) {
      cache.delete(cacheKey);
    }

    let cancelled = false;
    setPreviewState({ status: "loading" });
    void (async () => {
      try {
        const result = await withWorkspaceFilePreviewTimeout(
          controllerClient.workspace.files.read({
            projectId: activeProjectId,
            path,
            runtimeId: null,
            timeoutMs: WORKSPACE_FILE_PREVIEW_TIMEOUT_MS,
          }),
        );
        if (cancelled) {
          return;
        }
        if (!result) {
          setPreviewState({ status: "error", message: "Unable to load preview." });
          return;
        }
        cache.set(cacheKey, {
          file: {
            size: result.size,
            mimeType: result.mimeType,
            contentText: result.contentText,
            isText: result.isText,
          },
          expiresAt: Date.now() + WORKSPACE_FILE_PREVIEW_CACHE_TTL_MS,
        });
        if (!result.isText || result.contentText === null) {
          setPreviewState({ status: "error", message: "Preview is only available for text files." });
          return;
        }
        const preview = formatWorkspaceFilePreviewContent(result.contentText, reference.line ?? null);
        setPreviewState({
          status: "ready",
          content: preview.content,
          size: result.size,
          mimeType: result.mimeType,
          truncated: preview.truncated,
          linePreview: preview.linePreview,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "Unable to load preview.";
        setPreviewState({ status: "error", message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [previewCacheRef, previewOpen, previewLoadNonce, previewKey, projectId, reference.line, reference.path]);

  useEffect(() => {
    if (!previewOpen || previewState.status !== "ready" || !previewState.linePreview) {
      return;
    }
    const previewBody = previewBodyRef.current;
    const highlightedLine = previewBody?.querySelector<HTMLElement>('[data-preview-line-highlighted="true"]');
    if (!previewBody || !highlightedLine) {
      return;
    }
    previewBody.scrollTop = Math.max(0, highlightedLine.offsetTop - previewBody.clientHeight / 2);
  }, [previewOpen, previewState]);

  const handleMouseEnter = useCallback(() => {
    announceWorkspaceFilePreviewIntent(previewKey);
    clearTimer(hideTimerRef);
    clearTimer(hoverTimerRef);
    hoverTimerRef.current = window.setTimeout(openPreview, WORKSPACE_FILE_PREVIEW_HOVER_DELAY_MS);
  }, [clearTimer, openPreview, previewKey]);

  const handleMouseLeave = useCallback(() => {
    clearTimer(hoverTimerRef);
    scheduleHidePreview();
  }, [clearTimer, scheduleHidePreview]);

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      handleMouseEnter();
    },
    [handleMouseEnter],
  );

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      handleMouseLeave();
    },
    [handleMouseLeave],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse") {
        return;
      }
      announceWorkspaceFilePreviewIntent(previewKey);
      clearTimer(touchTimerRef);
      suppressNextClickRef.current = false;
      touchTimerRef.current = window.setTimeout(() => {
        suppressNextClickRef.current = true;
        openPreview();
      }, WORKSPACE_FILE_PREVIEW_TOUCH_DELAY_MS);
    },
    [clearTimer, openPreview, previewKey],
  );

  const handlePointerUp = useCallback(() => {
    clearTimer(touchTimerRef);
  }, [clearTimer]);

  const handlePointerCancel = useCallback(() => {
    clearTimer(touchTimerRef);
    suppressNextClickRef.current = false;
  }, [clearTimer]);

  const handleClick = useCallback(() => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    onOpen(reference);
  }, [onOpen, reference]);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!canNavigate) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      announceWorkspaceFilePreviewIntent(previewKey);
      clearTimer(hoverTimerRef);
      clearTimer(touchTimerRef);
      clearTimer(hideTimerRef);
      setPreviewOpen(false);
      setPreviewPosition(null);
      setActionMenuPosition(resolveWorkspaceFileActionMenuPosition(event.clientX, event.clientY));
    },
    [canNavigate, clearTimer, previewKey],
  );

  const handlePreviewFromMenu = useCallback(() => {
    setActionMenuPosition(null);
    openPreview();
  }, [openPreview]);

  const handleOpenFromMenu = useCallback(() => {
    setActionMenuPosition(null);
    onOpen(reference);
  }, [onOpen, reference]);

  return (
    <span
      className="relative inline-flex align-baseline"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <button
        ref={anchorRef}
        type="button"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        disabled={!canNavigate}
        data-testid="chat-message-file-reference-inline"
        data-workspace-path={reference.path}
        title={presentation.title}
        aria-label={presentation.ariaLabel}
        className={[
          WORKSPACE_FILE_REFERENCE_TOKEN_CLASS,
          canNavigate
            ? "cursor-pointer hover:bg-primary-100/80 hover:text-primary-800 dark:hover:bg-primary-300/15 dark:hover:text-primary-100"
            : "cursor-default opacity-60",
        ].join(" ")}
      >
        <span className="block min-w-0 max-w-full truncate">{displayLabel}</span>
      </button>
      {actionMenuPosition ? (
        <span
          ref={actionMenuRef}
          role="menu"
          aria-label={`File actions for ${displayLabel}`}
          data-testid="chat-message-file-reference-menu"
          className="fixed z-[80] block w-44 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1 text-left text-sm shadow-xl shadow-slate-950/15 ring-1 ring-slate-950/5 dark:border-[color:var(--color-studio-dark-floating-border)] dark:bg-[var(--color-studio-dark-floating)] dark:shadow-black/25 dark:ring-white/[0.08]"
          style={{
            left: actionMenuPosition.left,
            top: actionMenuPosition.top,
            maxHeight: actionMenuPosition.maxHeight,
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-xl px-3 py-2 text-left text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:text-slate-100 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
            onClick={handlePreviewFromMenu}
          >
            Preview
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-xl px-3 py-2 text-left text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:text-slate-100 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
            onClick={handleOpenFromMenu}
          >
            Open
          </button>
        </span>
      ) : null}
      {previewOpen && previewPosition ? (
        <span
          ref={previewRef}
          role="tooltip"
          data-testid="chat-message-file-reference-preview"
          className="fixed z-50 block overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-xl shadow-slate-950/15 ring-1 ring-slate-950/5 dark:border-[color:var(--color-studio-dark-floating-border)] dark:bg-[var(--color-studio-dark-floating)] dark:shadow-black/25 dark:ring-white/[0.08]"
          style={{
            bottom: previewPosition.bottom,
            left: previewPosition.left,
            top: previewPosition.top,
            width: previewPosition.width,
            maxHeight: WORKSPACE_FILE_PREVIEW_MAX_HEIGHT_PX,
          }}
          onMouseEnter={cancelHidePreview}
          onMouseLeave={scheduleHidePreview}
        >
          <span className="block border-b border-slate-200/70 px-3 py-2 dark:border-[color:var(--color-studio-dark-divider)]">
            <span
              className="block min-w-0 font-mono text-xs font-semibold text-slate-800 dark:text-slate-100"
              title={presentation.title}
              data-testid="chat-message-file-reference-preview-header"
            >
              {previewHeaderParts.lead ? (
                <span className="flex min-w-0 items-baseline">
                  <span className="min-w-0 truncate text-slate-500 dark:text-slate-400">
                    {previewHeaderParts.lead}
                  </span>
                  <span className="min-w-0 max-w-[86%] flex-none truncate">
                    {previewHeaderParts.tail}
                  </span>
                </span>
              ) : (
                <span className="block truncate">{previewHeaderParts.tail}</span>
              )}
            </span>
            {presentation.previewHeaderContext ? (
              <span className="mt-0.5 block truncate text-[0.68rem] text-slate-500 dark:text-slate-400">
                {presentation.previewHeaderContext}
              </span>
            ) : null}
          </span>
          <span
            ref={previewBodyRef}
            data-testid="chat-message-file-reference-preview-body"
            className="block max-h-[13rem] overflow-auto px-3 py-2"
          >
            {previewState.status === "loading" || previewState.status === "idle" ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">Loading preview…</span>
            ) : previewState.status === "error" ? (
              <span className="text-xs text-rose-600 dark:text-rose-300">{previewState.message}</span>
            ) : previewState.linePreview ? (
              <span className="block font-mono text-[0.72rem] leading-5 text-slate-700 dark:text-slate-200">
                {previewState.linePreview.map((line) => (
                  <span
                    key={line.lineNumber}
                    data-line-number={line.lineNumber}
                    data-preview-line-highlighted={line.highlighted ? "true" : undefined}
                    style={{ gridTemplateColumns: `${previewLineNumberColumnWidth} minmax(0, 1fr)` }}
                    className={[
                      "grid gap-2 rounded-md px-1",
                      line.highlighted
                        ? "bg-primary-50 text-primary-950 ring-1 ring-inset ring-primary-200 dark:bg-primary-400/15 dark:text-primary-50 dark:ring-primary-300/25"
                        : "",
                    ].join(" ")}
                  >
                    <span className="select-none text-right text-slate-400 dark:text-slate-500">
                      {line.lineNumber}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap break-words">
                      {line.text.length > 0 ? renderPreviewSyntaxContent(line.text, `line-${line.lineNumber}`) : " "}
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="block whitespace-pre-wrap break-words font-mono text-[0.72rem] leading-5 text-slate-700 dark:text-slate-200">
                {renderPreviewSyntaxContent(previewState.content, "content")}
              </span>
            )}
          </span>
        </span>
      ) : null}
    </span>
  );
}

// Octicon-style glyphs (git-pull-request / issue-opened) inlined so the chip
// needs no icon-font or remote asset; the paths inherit the chip's text color.
function GitHubReferenceGlyph({ kind }: { kind: "pull" | "issue" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-testid="chat-message-github-reference-glyph"
      className="h-[0.92em] w-[0.92em] flex-none fill-current opacity-75"
    >
      {kind === "pull" ? (
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      ) : (
        <>
          <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
        </>
      )}
    </svg>
  );
}

export type MessageContentProps = {
  content: string;
  className?: string;
  metadata?: Record<string, unknown> | null;
  projectId?: string | null;
  mentionableAgentHandles?: string[] | null;
};

export function MessageContent({
  content,
  className,
  metadata,
  projectId,
  mentionableAgentHandles,
}: MessageContentProps) {
  const upstreamGuidance = resolveProxyUpstreamErrorGuidance(content);
  const upstreamSummary = upstreamGuidance?.summary ?? null;
  const displayContent = upstreamSummary ?? content;
  const contentBlocks = useMemo(() => parseMessageContentBlocks(displayContent), [displayContent]);
  const firstQuoteBlockIndex = useMemo(
    () => contentBlocks.findIndex((block) => block.kind === "quote"),
    [contentBlocks],
  );
  const quoteSourceReference = useMemo(() => extractReplyContextSourceReference(metadata), [metadata]);
  const { agentHandles } = useConversation();
  const agentMentionHandles = useMemo(() => {
    const handles = new Set<string>(listBuiltInAssistantHandles());
    const mergedHandles = [...(agentHandles ?? []), ...(mentionableAgentHandles ?? [])];
    for (const handle of mergedHandles) {
      const trimmed = handle.trim();
      if (!trimmed) {
        continue;
      }
      const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
      const normalized = withoutAt.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      handles.add(normalized);
    }
    return handles;
  }, [agentHandles, mentionableAgentHandles]);
  const agentMentionClass = getAssistantMentionClass(resolveAssistantMentionToken(getDefaultAssistantMentionToken()));
  const { resolveConversationByController } = useConversations();
  const { openConversationTab, openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const { showStatus } = useStatus();
  const workspaceFilePreviewCacheRef = useRef<Map<string, WorkspaceFilePreviewCacheEntry>>(new Map());

  const handleProxyErrorAction = useCallback(() => {
    if (upstreamGuidance?.actionKind !== "open_ai_settings") {
      return;
    }
    requestUrlPush();
    openPanelTab("ai", { activate: true });
  }, [openPanelTab, requestUrlPush, upstreamGuidance?.actionKind]);

  const handleWorkspaceFileClick = useCallback(
    (reference: WorkspaceFileReferenceDescriptor) => {
      if (typeof window === "undefined") {
        return;
      }
      const trimmedPath = reference.path.trim();
      if (!trimmedPath) {
        return;
      }
      const detail: {
        path: string;
        projectId?: string | null;
        returnTarget?: "assistant";
        line?: number;
      } = { path: trimmedPath };
      detail.returnTarget = "assistant";
      if (projectId) {
        detail.projectId = projectId;
      }
      if (typeof reference.line === "number" && reference.line > 0) {
        detail.line = reference.line;
      }
      const runtimeWindow = window as typeof window & {
        __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
      };
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
      requestUrlPush();
      openPanelTab("code");
      window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
    },
    [openPanelTab, projectId, requestUrlPush],
  );

  const handleConversationReferenceClick = useCallback(
    (reference: ConversationReferenceDescriptor) => {
      const conversationId = reference.conversationId.trim();
      if (!conversationId) {
        return;
      }
      const localConversationId = resolveConversationByController(conversationId)?.localId?.trim() ?? "";
      if (!localConversationId) {
        const referenceKindLabel =
          reference.kind === "conversation" ? "conversation" : reference.kind === "thread" ? "thread" : "message";
        const label =
          reference.label?.trim() ||
          (reference.kind === "conversation"
            ? "referenced conversation"
            : reference.kind === "thread"
              ? "referenced thread"
              : "referenced message");
        showStatus(
          `That ${referenceKindLabel} reference is not available here: ${label}.`,
          "info",
          3500,
          { forceVisible: true },
        );
        return;
      }
      requestUrlPush();
      openConversationTab(localConversationId);
    },
    [openConversationTab, requestUrlPush, resolveConversationByController, showStatus],
  );

  const renderConversationReferenceButton = (
    reference: ConversationReferenceDescriptor,
    key: string,
    spacingClassName = "mx-0.5",
  ) => {
    const label =
      reference.label?.trim() ||
      (reference.kind === "conversation"
        ? "Referenced conversation"
        : reference.kind === "thread"
          ? "Referenced thread"
          : "Referenced message");
    const referenceKindLabel =
      reference.kind === "conversation" ? "conversation" : reference.kind === "thread" ? "thread" : "message";
    const canNavigate = Boolean(resolveConversationByController(reference.conversationId)?.localId?.trim());
    const stableTargetLabel =
      reference.kind === "message" && reference.messageId
        ? `${reference.conversationId}/${reference.messageId}`
        : reference.conversationId;
    const actionLabel = canNavigate
      ? `Open referenced ${referenceKindLabel}: ${label}`
      : `Referenced ${referenceKindLabel} is unavailable: ${label}`;
    const title = `${actionLabel}\nStable ${referenceKindLabel} id: ${stableTargetLabel}`;
    return (
      <button
        key={key}
        type="button"
        onClick={() => handleConversationReferenceClick(reference)}
        data-testid="chat-message-inline-reference"
        data-inline-ref-kind={reference.kind}
        data-conversation-id={reference.conversationId}
        data-message-id={reference.messageId ?? undefined}
        aria-label={actionLabel}
        className={[
          spacingClassName,
          "inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium align-middle ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:focus-visible:ring-primary-300",
          "bg-primary-500/10 text-primary-700 ring-primary-500/25 dark:bg-primary-500/15 dark:text-primary-100 dark:ring-primary-300/30",
          canNavigate
            ? "cursor-pointer hover:bg-primary-500/15 hover:ring-primary-500/40 dark:hover:bg-primary-500/25 dark:hover:ring-primary-300/50"
            : "cursor-pointer opacity-80 hover:bg-primary-500/15 hover:ring-primary-500/35 dark:hover:bg-primary-500/20 dark:hover:ring-primary-300/40",
        ]
          .filter(Boolean)
          .join(" ")}
        title={title}
      >
        <ChatBubble
          className="h-3.5 w-3.5 flex-none text-primary-600 dark:text-primary-200"
          aria-hidden="true"
          data-testid="chat-message-inline-reference-icon"
        />
        <span className="block min-w-0 max-w-[18rem] truncate sm:max-w-[24rem]">{label}</span>
      </button>
    );
  };

  const renderQuoteSourceBadge = (reference: ConversationReferenceDescriptor | null) => {
    if (!reference) {
      return (
        <span aria-hidden="true" className={QUOTE_SOURCE_BADGE_CLASS}>
          <QuoteMessage className="h-3.5 w-3.5" />
        </span>
      );
    }

    const canNavigate = Boolean(resolveConversationByController(reference.conversationId)?.localId?.trim());
    const actionLabel = canNavigate
      ? "Open quoted source"
      : "Quoted source is unavailable here";
    return (
      <button
        type="button"
        onClick={() => handleConversationReferenceClick(reference)}
        data-testid="chat-message-quote-source-reference"
        data-conversation-id={reference.conversationId}
        data-message-id={reference.messageId ?? undefined}
        aria-label={actionLabel}
        title={`${actionLabel}\nStable message id: ${reference.conversationId}/${reference.messageId ?? ""}`}
        className={[
          QUOTE_SOURCE_BADGE_CLASS,
          "transition hover:border-primary-200 hover:text-primary-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:hover:border-primary-300/35 dark:hover:text-primary-200 dark:focus-visible:ring-primary-300",
          canNavigate ? "cursor-pointer" : "cursor-pointer opacity-80",
        ].join(" ")}
      >
        <QuoteMessage className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  };

  const renderInlineToken = (
    token: ChatLineTokenChunk,
    tokenIndex: number,
    keyPrefix: string,
  ): ReactNode => {
      if (token.type === "text") {
        return token.value;
      }
      if (token.type === "strong") {
        return (
          <strong
            key={`${keyPrefix}-strong-${tokenIndex}`}
            className="font-semibold text-slate-900 dark:text-slate-50"
          >
            {renderInlineTokens(token.value, `${keyPrefix}-strong-${tokenIndex}`)}
          </strong>
        );
      }
      if (token.type === "inline-code") {
        return (
          <code
            key={`${keyPrefix}-inline-code-${tokenIndex}`}
            data-testid="chat-message-inline-code"
            className={INLINE_CODE_TOKEN_CLASS}
          >
            {token.value}
          </code>
        );
      }
      if (token.type === "github-reference") {
        const reference = token.value;
        const label = `${reference.owner}/${reference.repo}#${reference.number}`;
        return (
          <a
            key={`${keyPrefix}-${reference.url}-${tokenIndex}`}
            href={reference.url}
            target="_blank"
            rel="noopener noreferrer"
            title={reference.url}
            aria-label={`Open GitHub ${reference.kind === "pull" ? "pull request" : "issue"} ${label}`}
            data-testid="chat-message-github-reference"
            data-github-ref-kind={reference.kind}
            className={GITHUB_REFERENCE_TOKEN_CLASS}
          >
            <GitHubReferenceGlyph kind={reference.kind} />
            <span className="whitespace-nowrap">{label}</span>
          </a>
        );
      }
      if (token.type === "link") {
        const reference = token.value;
        return (
          <a
            key={`${keyPrefix}-${reference.url}-${tokenIndex}`}
            href={reference.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary-600 underline underline-offset-2 hover:text-primary-700 dark:text-primary-300 dark:hover:text-primary-200"
            title={reference.url}
            data-testid="chat-message-link"
          >
            {reference.label}
          </a>
        );
      }
      if (token.type === "assistant-mention" || token.type === "agent-mention") {
        // A mention is the agent's name — clicking it opens the agent's
        // profile (ChatPanel hosts the card for these anchor-less opens).
        const mentionClass =
          token.type === "assistant-mention"
            ? getAssistantMentionClass(token.value)
            : agentMentionClass;
        return (
          <button
            key={`${keyPrefix}-${token.value}-${tokenIndex}`}
            type="button"
            onClick={() => requestAgentProfile(token.value)}
            className={`${mentionClass} cursor-pointer text-left align-baseline [font:inherit] hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40`}
            title={`View profile for ${token.value}`}
            data-testid="chat-agent-mention"
          >
            {token.value}
          </button>
        );
      }
      if (token.type === "conversation-reference") {
        return renderConversationReferenceButton(
          token.value,
          `${keyPrefix}-${token.value.kind}:${token.value.conversationId}:${token.value.messageId ?? ""}:${tokenIndex}`,
        );
      }
      const reference = token.value;
      return (
        <WorkspaceFileReferenceChip
          key={`${keyPrefix}-${reference.path}-${tokenIndex}`}
          reference={reference}
          projectId={projectId}
          onOpen={handleWorkspaceFileClick}
          previewCacheRef={workspaceFilePreviewCacheRef}
        />
      );
  };

  // An inline chip and the punctuation right after it are one unit: "`AGENTS.md`:"
  // must never wrap with the ":" orphaned on the next line (#191). A chip token
  // followed by punctuation renders inside a no-break span with that punctuation.
  const renderInlineTokens = (line: string, keyPrefix: string): ReactNode[] => {
    const tokens = tokenizeChatLine(line, agentMentionHandles);
    const nodes: ReactNode[] = [];
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      if (!token) {
        continue;
      }
      const rendered = renderInlineToken(token, tokenIndex, keyPrefix);
      const nextToken = tokens[tokenIndex + 1];
      const gluedPunctuation =
        (token.type === "inline-code" || token.type === "workspace-file") && nextToken?.type === "text"
          ? (nextToken.value.match(CHIP_TRAILING_PUNCTUATION_REGEX)?.[0] ?? "")
          : "";
      if (!gluedPunctuation || nextToken?.type !== "text") {
        nodes.push(rendered);
        continue;
      }
      nodes.push(
        <span
          key={`${keyPrefix}-chip-glue-${tokenIndex}`}
          data-testid="chat-message-chip-glue"
          className="whitespace-nowrap"
        >
          {rendered}
          {gluedPunctuation}
        </span>,
      );
      const remainder = nextToken.value.slice(gluedPunctuation.length);
      if (remainder) {
        nodes.push(remainder);
      }
      tokenIndex += 1;
    }
    return nodes;
  };

  // One list grammar at every depth (#167): a fixed 1.25rem indent step,
  // ordered markers a shade darker than bullets (they carry sequence), bullet
  // glyphs stepping disc → circle → square so levels read distinctly, and the
  // sublist sitting on the same half-step rhythm as sibling items so the
  // indent, not extra air, does the grouping (#191).
  const renderListLevel = (
    items: MessageListItem[],
    depth: number,
    keyPrefix: string,
    start: number | undefined,
    spacingClassName: string,
  ): ReactNode => {
    const ordered = items[0]?.ordered ?? false;
    const ListElement = ordered ? "ol" : "ul";
    const renderedItems: ReactNode[] = [];
    let index = 0;
    while (index < items.length) {
      const item = items[index];
      if (!item || item.depth < depth) {
        break;
      }
      const itemKey = `${keyPrefix}-item-${index}`;
      let nextIndex = index + 1;
      while (nextIndex < items.length && (items[nextIndex]?.depth ?? 0) > depth) {
        nextIndex += 1;
      }
      const nestedItems = items.slice(index + 1, nextIndex);
      renderedItems.push(
        <li
          key={itemKey}
          className="pl-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
        >
          {renderInlineTokens(item.text, itemKey)}
          {nestedItems.length > 0
            ? renderListLevel(nestedItems, depth + 1, `${itemKey}-sub`, undefined, "mt-0.5")
            : null}
        </li>,
      );
      index = nextIndex;
    }
    const markerClassName = ordered
      ? "list-decimal marker:font-medium marker:text-slate-500 dark:marker:text-slate-400"
      : `${
          depth === 0
            ? "list-disc"
            : depth === 1
              ? "[list-style-type:circle]"
              : "[list-style-type:square]"
        } marker:text-slate-400 dark:marker:text-slate-500`;
    return (
      <ListElement
        key={keyPrefix}
        start={ordered ? start : undefined}
        data-testid={depth === 0 ? "chat-message-list" : "chat-message-sublist"}
        data-list-depth={depth}
        className={[spacingClassName, markerClassName, "space-y-0.5 pl-5"]
          .filter(Boolean)
          .join(" ")}
      >
        {renderedItems}
      </ListElement>
    );
  };

  return (
    <div className={className ?? "text-sm leading-relaxed break-words [overflow-wrap:anywhere]"}>
      {contentBlocks.map((block, blockIndex) => {
        const blockSpacingClassName = blockIndex > 0 ? "mt-2" : block.kind === "list" ? "mt-1" : "";
        const teamFlow = block.kind === "paragraph" ? parseTeamFlowLine(block.line) : null;
        if (teamFlow) {
          return (
            <div
              key={`team-flow-${blockIndex}`}
              data-testid="team-flow-inline-status"
              className={[
                blockSpacingClassName,
                "flex max-w-full flex-wrap items-center gap-1.5 text-xs",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={`Workstream references: ${teamFlow.references.length} lane${teamFlow.references.length === 1 ? "" : "s"}`}
            >
              <span
                className="inline-flex min-w-0 items-center gap-1 rounded-full bg-slate-50 px-2 py-1 font-medium text-slate-500 ring-1 ring-inset ring-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:ring-slate-700"
                title="Referenced workstreams"
                data-testid="team-flow-team-chip"
              >
                <GitBranch
                  aria-hidden="true"
                  className="h-3.5 w-3.5 flex-none -scale-x-100 text-primary-600 dark:text-primary-300"
                />
                <span>{teamFlow.label}</span>
              </span>
              {teamFlow.references.map((reference, referenceIndex) =>
                renderConversationReferenceButton(
                  reference,
                  `team-flow-${blockIndex}-${reference.kind}:${reference.conversationId}:${reference.messageId ?? ""}:${referenceIndex}`,
                  "",
                ),
              )}
            </div>
          );
        }
        if (block.kind === "quote") {
          const sourceReferenceForQuote =
            blockIndex === firstQuoteBlockIndex ? quoteSourceReference : null;
          return (
            <blockquote
              key={`quote-${blockIndex}`}
              className={[
                blockSpacingClassName,
                "relative rounded-xl border border-slate-200/70 bg-slate-100/70 px-3 pb-2 pt-3 text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/10 dark:bg-white/[0.055] dark:text-slate-200 dark:shadow-none",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {renderQuoteSourceBadge(sourceReferenceForQuote)}
              {block.lines.map((line, lineIndex) => (
                <p
                  key={`quote-${blockIndex}-line-${lineIndex}`}
                  className={lineIndex > 0 ? "mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"}
                >
                  {line ? renderInlineTokens(line, `quote-${blockIndex}-line-${lineIndex}`) : "\u00a0"}
                </p>
              ))}
            </blockquote>
          );
        }
        if (block.kind === "code") {
          // A fence that opened inside a list item keeps the item's content
          // indent and sits closer to the line that introduced it (#167).
          const codeSpacingClassName =
            blockIndex > 0 ? (block.inListItem ? "mt-1.5" : "mt-2") : "";
          return (
            <pre
              key={`code-${blockIndex}`}
              data-testid="chat-message-code-block"
              data-code-language={block.language ?? undefined}
              data-in-list-item={block.inListItem ? "true" : undefined}
              className={[
                codeSpacingClassName,
                block.inListItem ? "ml-5" : "",
                CODE_BLOCK_CLASS,
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <code>{block.lines.join("\n")}</code>
            </pre>
          );
        }
        if (block.kind === "list") {
          return renderListLevel(
            block.items,
            0,
            `list-${blockIndex}`,
            block.ordered ? block.start : undefined,
            blockSpacingClassName,
          );
        }

        return (
          <Text
            as="p"
            key={`paragraph-${blockIndex}`}
            variant="body"
            tone="inherit"
            className={[blockSpacingClassName, "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"]
              .filter(Boolean)
              .join(" ")}
          >
            {renderInlineTokens(block.line, `paragraph-${blockIndex}`)}
          </Text>
        );
      })}
      {upstreamGuidance?.detail || upstreamGuidance?.actionLabel ? (
        <div
          data-testid="chat-message-proxy-error-guidance"
          className="mt-3 flex max-w-xl flex-wrap items-center gap-2 rounded-xl border border-rose-200/80 bg-rose-50/70 px-3 py-2 text-xs text-rose-800 dark:border-rose-400/25 dark:bg-rose-500/10 dark:text-rose-100"
        >
          {upstreamGuidance.detail ? (
            <span className="min-w-0 flex-1">{upstreamGuidance.detail}</span>
          ) : null}
          {upstreamGuidance.actionLabel && upstreamGuidance.actionKind === "open_ai_settings" ? (
            <button
              type="button"
              data-testid="chat-message-proxy-error-action"
              onClick={handleProxyErrorAction}
              className="inline-flex flex-none items-center justify-center rounded-full border border-rose-300/80 bg-white/80 px-2.5 py-1 font-medium text-rose-700 shadow-sm shadow-rose-900/5 transition hover:border-rose-400 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 dark:border-rose-300/25 dark:bg-white/10 dark:text-rose-100 dark:hover:bg-white/15"
            >
              {upstreamGuidance.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
