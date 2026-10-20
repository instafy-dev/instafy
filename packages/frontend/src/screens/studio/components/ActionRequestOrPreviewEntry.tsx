import type { ChatMessage } from "../types";
import { ActionRequestEntry } from "./ActionRequestEntry";
import { SitePreviewCard } from "./SitePreviewCard";
import { sitePreviewFromMessage } from "./sitePreviewRequest";

/**
 * Draws a stored `action_request`: the "Ready to preview" card when it names
 * a site preview, the generic action card otherwise. Conversation rows and an
 * agent job's thread both draw cards through here, so a card posted from
 * inside a job looks and behaves like any other.
 */
export function ActionRequestOrPreviewEntry({
  message,
  details,
  projectId,
}: {
  message: ChatMessage;
  details: Record<string, unknown> | null;
  projectId: string | null;
}) {
  const preview = sitePreviewFromMessage(message);
  if (preview) return <SitePreviewCard preview={preview} projectId={projectId} />;
  return <ActionRequestEntry message={message} details={details} />;
}
