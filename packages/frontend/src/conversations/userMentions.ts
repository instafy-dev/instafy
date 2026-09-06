import { isUUID } from "../utils/uuid";

export const MAX_MENTIONED_USERS = 32;

/** Only picker-backed editor nodes identify people; plain @text never does. */
export function withUserMentionMetadata(
  metadata: Record<string, unknown> | null | undefined,
  editorState: string | null | undefined,
): Record<string, unknown> {
  const mentionedUserIds = [...new Set(
    extractUserMentionTokensFromEditorState(editorState ?? null)
      .map((token) => token.userId.toLowerCase())
      .filter(isUUID),
  )];
  if (mentionedUserIds.length > MAX_MENTIONED_USERS) {
    throw new Error(`Mention up to ${MAX_MENTIONED_USERS} people in one message.`);
  }
  const result = { ...metadata };
  // Recompute this field for the submitted editor state, including when the
  // private-chat invite prompt removed a structured mention.
  delete result.mentionedUserIds;
  if (mentionedUserIds.length > 0) result.mentionedUserIds = mentionedUserIds;
  return result;
}

export type UserMentionToken = {
  userId: string;
  handle: string;
  displayName: string;
};

type LexicalSerializedNode = {
  type?: unknown;
  children?: unknown;
  text?: unknown;
  userId?: unknown;
  handle?: unknown;
  displayName?: unknown;
};

function walkLexicalNodes(node: unknown, onNode: (node: LexicalSerializedNode) => void) {
  if (!node || typeof node !== "object") {
    return;
  }
  const typed = node as LexicalSerializedNode;
  onNode(typed);
  const children = typed.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      walkLexicalNodes(child, onNode);
    }
  }
}

function extractLexicalText(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const typed = node as LexicalSerializedNode;
  if (typeof typed.text === "string") {
    return typed.text;
  }
  const children = typed.children;
  if (!Array.isArray(children)) {
    return "";
  }
  return children.map(extractLexicalText).join("");
}

function extractPlainTextFromEditorState(parsed: unknown): string {
  const root = (parsed as { root?: unknown } | null)?.root ?? parsed;
  if (!root || typeof root !== "object") {
    return "";
  }
  const typedRoot = root as LexicalSerializedNode;
  const children = typedRoot.children;
  if (Array.isArray(children)) {
    return children.map(extractLexicalText).join("\n");
  }
  return extractLexicalText(root);
}

export function extractUserMentionTokensFromEditorState(editorState: string | null): UserMentionToken[] {
  if (!editorState) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(editorState);
  } catch (_error) {
    return [];
  }

  const root = (parsed as { root?: unknown } | null)?.root ?? parsed;
  const tokens: UserMentionToken[] = [];
  const seenUserIds = new Set<string>();

  walkLexicalNodes(root, (node) => {
    if (node.type !== "user-mention") {
      return;
    }
    const userId = typeof node.userId === "string" ? node.userId.trim() : "";
    if (!userId || seenUserIds.has(userId)) {
      return;
    }
    const handle = typeof node.handle === "string" ? node.handle.trim() : "";
    const displayName = typeof node.displayName === "string" ? node.displayName.trim() : "";
    if (!handle && !displayName) {
      return;
    }
    seenUserIds.add(userId);
    tokens.push({
      userId,
      handle,
      displayName,
    });
  });

  return tokens;
}

export function replaceUserMentionsWithPlainText(
  editorState: string | null,
  options?: { includeUserIds?: Set<string> | null },
): { editorState: string | null; text: string } {
  if (!editorState) {
    return { editorState, text: "" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(editorState);
  } catch (_error) {
    return { editorState, text: "" };
  }

  const includeUserIds = options?.includeUserIds ?? null;
  const root = (parsed as { root?: unknown } | null)?.root ?? parsed;

  walkLexicalNodes(root, (node) => {
    if (node.type !== "user-mention") {
      return;
    }
    const userId = typeof node.userId === "string" ? node.userId.trim() : "";
    if (includeUserIds && (!userId || !includeUserIds.has(userId))) {
      return;
    }
    const displayName = typeof node.displayName === "string" ? node.displayName.trim() : "";
    const handle = typeof node.handle === "string" ? node.handle.trim() : "";
    const replacement = displayName || handle || "";
    node.type = "text";
    node.text = replacement;
    delete node.userId;
    delete node.handle;
    delete node.displayName;
  });

  const text = extractPlainTextFromEditorState(parsed);
  try {
    return { editorState: JSON.stringify(parsed), text };
  } catch (_error) {
    return { editorState, text };
  }
}
