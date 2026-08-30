import { getDefaultAssistantHandle } from "../../../assistants/localBuiltInAssistantCatalog";
import type { ConversationState } from "../../../conversations/conversationState";
import { isRunActivelyProgressing } from "../../../conversations/runLiveness";
import type { RunRecord } from "../../../types";
import { extractAgentHandleFromMetadata } from "./chatAssistantIdentity";

/**
 * Where one agent interacts, derived ONLY from data the viewer already holds:
 * the project conversation list and the project-wide runs feed. Both are
 * filtered server-side to what the requesting user may see (private
 * conversations are withheld per subscriber), so a profile built from them is
 * scoped to the viewer's visibility by construction — no extra gating here.
 *
 * Participation signals, in the order they were persisted: a live or recent
 * run attributed to the agent (`run.metadata.agent`), a thread it owns, an
 * invitation from the current user (extra handles / the default assistant
 * toggle), or a thread it delegated.
 */

export interface AgentConversationActivityEntry {
  localId: string;
  title: string;
  isPrivate: boolean;
  /** An actively-progressing run by this agent in that conversation. */
  workingNow: boolean;
}

export interface AgentConversationActivity {
  entries: AgentConversationActivityEntry[];
  /** Qualifying conversations beyond the row cap. */
  overflowCount: number;
}

export const AGENT_ACTIVITY_MAX_ROWS = 5;

/** Lifecycles the viewer has hidden or deleted stay off their profile view. */
const LISTABLE_LIFECYCLES = new Set(["active", "archived"]);

function normalizeHandle(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt.toLowerCase();
}

function parseTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deriveAgentConversationActivity({
  agentHandle,
  agentId,
  conversations,
  runs,
  now = Date.now(),
}: {
  agentHandle: string;
  agentId?: string | null;
  conversations: ConversationState[];
  runs: Record<string, RunRecord>;
  now?: number;
}): AgentConversationActivity {
  const handle = normalizeHandle(agentHandle);
  if (!handle) {
    return { entries: [], overflowCount: 0 };
  }

  const runActivityByConversationId = new Map<
    string,
    { active: boolean; lastAt: number }
  >();
  for (const run of Object.values(runs)) {
    if (!run.conversationId) continue;
    if (extractAgentHandleFromMetadata(run.metadata) !== handle) continue;
    const lastAt =
      parseTimestamp(run.updatedAt) || parseTimestamp(run.createdAt);
    const active = isRunActivelyProgressing(run, now);
    const existing = runActivityByConversationId.get(run.conversationId);
    if (existing) {
      existing.active = existing.active || active;
      existing.lastAt = Math.max(existing.lastAt, lastAt);
    } else {
      runActivityByConversationId.set(run.conversationId, { active, lastAt });
    }
  }

  const isDefaultAssistant = handle === getDefaultAssistantHandle();
  const candidates: Array<AgentConversationActivityEntry & { sortAt: number }> =
    [];
  for (const conversation of conversations) {
    if (!LISTABLE_LIFECYCLES.has(conversation.lifecycleStatus)) continue;
    const runActivity = conversation.controllerId
      ? (runActivityByConversationId.get(conversation.controllerId) ?? null)
      : null;
    const participates =
      runActivity !== null ||
      normalizeHandle(conversation.ownerAgent?.handle) === handle ||
      conversation.extraAgentHandles.some(
        (entry) => normalizeHandle(entry) === handle,
      ) ||
      (isDefaultAssistant && conversation.assistantEnabled) ||
      (agentId != null && conversation.delegatedByAgentId === agentId);
    if (!participates) continue;
    candidates.push({
      localId: conversation.localId,
      title: conversation.title.trim() || "New conversation",
      isPrivate: conversation.visibility === "private",
      workingNow: runActivity?.active ?? false,
      sortAt: Math.max(runActivity?.lastAt ?? 0, conversation.createdAt || 0),
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.workingNow) - Number(a.workingNow) || b.sortAt - a.sortAt,
  );
  const entries = candidates
    .slice(0, AGENT_ACTIVITY_MAX_ROWS)
    .map(({ localId, title, isPrivate, workingNow }) => ({
      localId,
      title,
      isPrivate,
      workingNow,
    }));
  return {
    entries,
    overflowCount: Math.max(0, candidates.length - entries.length),
  };
}
