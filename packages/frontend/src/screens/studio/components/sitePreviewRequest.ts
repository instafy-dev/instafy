import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";

export type SitePreviewRequest = {
  previewId: string;
  title: string;
  port: number;
};

// Controller tunnel ids (a uuid or plain hex). Anything shaped like a URL or a host is refused.
const SITE_PREVIEW_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function isSitePreviewId(value: unknown): value is string {
  return typeof value === "string" && SITE_PREVIEW_ID_PATTERN.test(value);
}

/**
 * A "Ready to preview" card: an assistant `action_request` whose details name
 * a preview by id. The card carries ids only. A url or href in the message is
 * never read, so a look-alike card can at most ask the controller about a
 * preview this viewer may already open.
 */
/**
 * Whether a stored card declares a site preview at all (its details carry a
 * `preview`), whether or not `sitePreviewFromMessage` accepts what it names.
 */
export function declaresSitePreview(message: ChatMessage): boolean {
  if (getMessageType(message) !== "action_request") return false;
  const value = extractMessageDetails(message.metadata)?.preview;
  return value !== undefined && value !== null;
}

export function sitePreviewFromMessage(message: ChatMessage): SitePreviewRequest | null {
  if (message.role !== "assistant") return null;
  if (getMessageType(message) !== "action_request") return null;
  const details = extractMessageDetails(message.metadata);
  const value = details?.preview;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isSitePreviewId(record.previewId)) return null;
  const port = record.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const title = typeof details?.title === "string" ? details.title.trim().slice(0, 120) : "";
  return { previewId: record.previewId, title: title || "Preview", port };
}
