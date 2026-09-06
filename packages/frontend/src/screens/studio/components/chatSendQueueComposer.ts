import { $getRoot, createEditor } from "lexical";
import { AssistantMentionNode } from "./chat-input/AssistantMentionNode";
import { AgentMentionNode } from "./chat-input/AgentMentionNode";
import { UserMentionNode } from "./chat-input/UserMentionNode";
import {
  buildBrowserSessionTargetedMessage,
  buildNewBrowserSessionMessage,
  type BrowserSessionPageTarget,
} from "./browserSessionPages";

const QUEUED_COMPOSER_KEY = "queuedComposer";
export const MAX_QUEUED_COMPOSER_BYTES = 128 * 1024;

export type QueuedComposer = {
  version: 1;
  message: string;
  editorState: string;
  browserPageTarget: BrowserSessionPageTarget | null;
  browserLaunchMode: "new_page" | null;
};

/** Reuse the exact wrappers that were applied when this queue item was created. */
export function queuedComposerDispatchMessage(composer: {
  message: string;
  browserPageTarget: BrowserSessionPageTarget | null;
  browserLaunchMode: "new_page" | null;
}): string {
  return composer.browserLaunchMode === "new_page"
    ? buildNewBrowserSessionMessage(composer.message)
    : composer.browserPageTarget
      ? buildBrowserSessionTargetedMessage(composer.message, composer.browserPageTarget)
      : composer.message.trim();
}

function validComposer(value: unknown, dispatchMessage: string): QueuedComposer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as QueuedComposer;
  if (candidate.version !== 1 || typeof candidate.message !== "string" ||
      typeof candidate.editorState !== "string" || !candidate.editorState ||
      (candidate.browserLaunchMode !== null && candidate.browserLaunchMode !== "new_page")) return null;
  if (candidate.browserPageTarget !== null) {
    const target = candidate.browserPageTarget;
    if (!target || typeof target !== "object" ||
        ![target.id, target.url, target.host, target.label].every((field) => typeof field === "string" && field.length > 0)) return null;
  }
  const serialized = JSON.stringify(candidate);
  if (serialized.length > MAX_QUEUED_COMPOSER_BYTES || new TextEncoder().encode(serialized).length > MAX_QUEUED_COMPOSER_BYTES) return null;
  if (queuedComposerDispatchMessage(candidate) !== dispatchMessage) return null;
  try {
    // Use the composer's registered node types and text semantics. A sidecar
    // must never replace an authoritative queued prompt with unrelated text.
    const editor = createEditor({
      namespace: "queued-composer-validation",
      nodes: [AssistantMentionNode, AgentMentionNode, UserMentionNode],
      onError: (error) => { throw error; },
    });
    const state = editor.parseEditorState(candidate.editorState);
    if (state.read(() => $getRoot().getTextContent()).trim() !== candidate.message.trim()) return null;
    return candidate;
  } catch {
    return null;
  }
}

export function withQueuedComposerMetadata(payload: {
  message: string;
  composerMessage?: string;
  editorState?: string | null;
  browserPageTarget?: BrowserSessionPageTarget | null;
  browserLaunchMode?: "new_page" | null;
  metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const metadata = { ...payload.metadata };
  delete metadata[QUEUED_COMPOSER_KEY];
  if (!payload.editorState) return metadata;
  const composer: QueuedComposer = {
    version: 1,
    message: payload.composerMessage ?? payload.message,
    editorState: payload.editorState,
    browserPageTarget: payload.browserPageTarget ?? null,
    browserLaunchMode: payload.browserLaunchMode ?? null,
  };
  if (!validComposer(composer, payload.message)) {
    throw new Error("Unable to preserve this draft in the server queue. Keep it locally or shorten the message.");
  }
  metadata[QUEUED_COMPOSER_KEY] = composer;
  return metadata;
}

export function readQueuedComposerMetadata(metadata: Record<string, unknown> | null, dispatchMessage: string): {
  composer: QueuedComposer | null;
  metadata: Record<string, unknown> | null;
} {
  if (!metadata) return { composer: null, metadata: null };
  const composer = validComposer(metadata[QUEUED_COMPOSER_KEY], dispatchMessage);
  const remaining = { ...metadata };
  delete remaining[QUEUED_COMPOSER_KEY];
  return { composer, metadata: remaining };
}
