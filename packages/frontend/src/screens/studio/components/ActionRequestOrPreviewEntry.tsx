import type { ChatMessage } from "../types";
import { ActionRequestEntry } from "./ActionRequestEntry";
import { SitePreviewCard } from "./SitePreviewCard";
import { declaresSitePreview, sitePreviewFromMessage } from "./sitePreviewRequest";

/**
 * Draws a stored `action_request`: the "Ready to preview" card when it names
 * a site preview, the generic action card otherwise. Conversation rows and an
 * agent job's thread both draw cards through here, so a card posted from
 * inside a job looks and behaves like any other.
 *
 * A preview opens only through what the card names in `details.preview`. A
 * card that declares a preview the parser refuses (a URL where the id
 * belongs, say) is drawn as a generic card with none of its own actions, so
 * it offers no Open that could go anywhere else, or nowhere.
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
  if (preview) return <SitePreviewCard preview={preview} projectId={projectId} postedAt={message.timestamp} messageKey={message.id} />;
  if (declaresSitePreview(message)) {
    return <ActionRequestEntry message={message} details={details ? { ...details, actions: [] } : null} />;
  }
  return <ActionRequestEntry message={message} details={details} />;
}
