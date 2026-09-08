import { getStudioVisitKey } from "../../../navigation/studioVisit";

export type ChatScrollHistoryVisit = {
  key: string;
  userId: string;
  projectId: string;
  conversationId: string;
  jobId?: string | null;
};

export function chatScrollSnapshotKey(visit: ChatScrollHistoryVisit | null): string | null {
  if (!visit) return null;
  return JSON.stringify([visit.userId, visit.projectId, visit.conversationId, visit.jobId ?? null, visit.key]);
}

/** A route may be ahead of (or behind) the hydrated project/conversation providers. */
export function resolveChatScrollHistoryVisit({
  location,
  userId,
  projectId,
  conversationsProjectKey,
  conversationId,
  conversationControllerId,
  jobThread,
}: {
  location: { key: string; state?: unknown; search: string };
  userId: string | null;
  projectId: string | null;
  conversationsProjectKey: string | null;
  conversationId: string | null;
  conversationControllerId: string | null;
  jobThread?: { conversationId: string; jobId: string } | null;
}): ChatScrollHistoryVisit | null {
  if (!userId || !projectId || !conversationId || conversationsProjectKey !== projectId) return null;
  const params = new URLSearchParams(location.search);
  const panel = params.get("panel");
  if (panel && panel !== "chat") return null;
  if (params.get("projectId") !== projectId) return null;
  const controllerId = params.get("conversationControllerId")?.trim();
  if (controllerId ? controllerId !== conversationControllerId : params.get("conversationId") !== conversationId) return null;
  const jobId = jobThread?.jobId.trim() || null;
  if ((params.get("jobId")?.trim() || null) !== jobId ||
      (jobThread && jobThread.conversationId !== conversationId)) return null;
  return { key: getStudioVisitKey(location), userId, projectId, conversationId, jobId };
}
