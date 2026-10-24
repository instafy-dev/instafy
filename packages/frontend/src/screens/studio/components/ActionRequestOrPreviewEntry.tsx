import { useContext } from "react";
import type { ChatMessage } from "../types";
import { ActionRequestEntry } from "./ActionRequestEntry";
import { SitePreviewCard } from "./SitePreviewCard";
import { declaresSitePreview, sitePreviewFromMessage } from "./sitePreviewRequest";
import { isUUID } from "../../../utils/uuid";
import { ChatActionCard } from "./ChatActionCard";
import { UserInputRequestEntry } from "./UserInputRequestEntry";
import { MultiAgentRunsContext } from "./MultiAgentPlanEntry";
import { extractAgentJobId } from "./chatMessagePresentation";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function questionTaskLabel(message: ChatMessage, runs: React.ContextType<typeof MultiAgentRunsContext>["runs"]): string | undefined {
  const jobId = extractAgentJobId(message);
  if (!jobId) return undefined;
  const source = Object.values(runs).find(run => record(run.metadata)?.jobId === jobId);
  const metadata = record(source?.metadata);
  const handle = record(metadata?.agent)?.handle;
  const agents = record(metadata?.multiAgentPlan)?.agents;
  if (typeof handle !== "string" || !Array.isArray(agents)) return undefined;
  const normalize = (value: string) => value.replace(/^@/, "").trim().toLowerCase();
  const task = agents.map(record).find(agent => typeof agent?.handle === "string" && normalize(agent.handle) === normalize(handle));
  const label = task?.label ?? task?.title;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

/**
 * Draws a stored `action_request`: a controller-bound worker question, a site
 * preview, or the generic action card. Conversation rows and an
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
  const { runs } = useContext(MultiAgentRunsContext);
  if (details && Object.prototype.hasOwnProperty.call(details, "userInputRequestId")) {
    const requestId = details.userInputRequestId;
    // An invalid typed request must not fall back to arbitrary message-authored actions.
    return message.role === "assistant" && typeof requestId === "string" && isUUID(requestId) && isUUID(message.id)
      ? <UserInputRequestEntry requestId={requestId} messageId={message.id} taskLabel={questionTaskLabel(message, runs)} />
      : <ChatActionCard title="This question is unavailable." actions={[]} />;
  }
  const preview = sitePreviewFromMessage(message);
  if (preview) return <SitePreviewCard preview={preview} projectId={projectId} postedAt={message.timestamp} messageKey={message.id} />;
  if (declaresSitePreview(message)) {
    return <ActionRequestEntry message={message} details={details ? { ...details, actions: [] } : null} />;
  }
  return <ActionRequestEntry message={message} details={details} />;
}
