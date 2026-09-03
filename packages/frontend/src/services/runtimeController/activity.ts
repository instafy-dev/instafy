import {
  controllerBaseUrl,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

/**
 * Home's activity feed: the controller's ledger of what happened across every
 * team the user belongs to (GET /me/activity). Rows are keyset-paged on their
 * id; `before` walks history newest-first, `since` catches up oldest-first.
 */

export type ActivityActorKind = "user" | "agent" | "automation" | "system";

export interface ActivityActor {
  kind: ActivityActorKind;
  userId: string | null;
  displayName: string | null;
  handle: string | null;
  avatarSeed: string | null;
}

export interface ActivityRef {
  id: string;
  name: string | null;
}

export interface ActivityConversationRef {
  id: string;
  title: string | null;
  visibility: string | null;
  /** "automation" for a scheduled conversation; null for an ordinary one. */
  threadKind: string | null;
}

export interface ActivityRunRef {
  id: string;
  status: string | null;
  promptId: string | null;
}

export interface ActivityItem {
  /** The cursor; a decimal string so JavaScript never rounds it. */
  id: string;
  kind: string;
  at: string;
  project: ActivityRef | null;
  org: ActivityRef | null;
  conversation: ActivityConversationRef | null;
  run: ActivityRunRef | null;
  actor: ActivityActor;
  title: string | null;
  preview: string | null;
  needsYou: boolean;
  /** Work still in flight (a started run that is queued or running). */
  live: boolean;
  seen: boolean;
  data: Record<string, unknown>;
}

export interface ListMyActivityParams {
  before?: string | null;
  since?: string | null;
  limit?: number;
  lane?: "all" | "needs" | "activity";
  accessToken?: string | null;
}

export interface ListMyActivityResult {
  success: boolean;
  items?: ActivityItem[];
  nextBefore?: string | null;
  hasMore?: boolean;
  lastSeenEventId?: string | null;
  serverTime?: string | null;
  error?: string;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRef(value: unknown): ActivityRef | null {
  const record = asRecord(value);
  const id = asString(record?.id);
  if (!record || !id) {
    return null;
  }
  return { id, name: asString(record.name) };
}

function normalizeActor(value: unknown): ActivityActor {
  const record = asRecord(value);
  const rawKind = asString(record?.kind);
  const kind: ActivityActorKind =
    rawKind === "user" || rawKind === "agent" || rawKind === "automation" ? rawKind : "system";
  return {
    kind,
    userId: asString(record?.userId),
    displayName: asString(record?.displayName),
    handle: asString(record?.handle)?.replace(/^@/, "").toLowerCase() ?? null,
    avatarSeed: asString(record?.avatarSeed),
  };
}

export function normalizeActivityItem(value: unknown): ActivityItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = asString(record.id) ?? (typeof record.id === "number" ? String(record.id) : null);
  const kind = asString(record.kind);
  const at = asString(record.at);
  if (!id || !kind || !at) {
    return null;
  }
  const conversation = asRecord(record.conversation);
  const conversationId = asString(conversation?.id);
  const run = asRecord(record.run);
  const runId = asString(run?.id);
  return {
    id,
    kind,
    at,
    project: normalizeRef(record.project),
    org: normalizeRef(record.org),
    conversation:
      conversation && conversationId
        ? {
            id: conversationId,
            title: asString(conversation.title),
            visibility: asString(conversation.visibility),
            threadKind: asString(conversation.threadKind),
          }
        : null,
    run:
      run && runId
        ? { id: runId, status: asString(run.status), promptId: asString(run.promptId) }
        : null,
    actor: normalizeActor(record.actor),
    title: asString(record.title),
    preview: asString(record.preview),
    needsYou: record.needsYou === true,
    live: record.live === true,
    seen: record.seen === true,
    data: asRecord(record.data) ?? {},
  };
}

export async function listMyActivity(
  params: ListMyActivityParams = {},
): Promise<ListMyActivityResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const url = new URL(`${requestContext.baseUrl}/me/activity`);
    const before = asString(params.before);
    const since = asString(params.since);
    if (before) {
      url.searchParams.set("before", before);
    } else if (since) {
      url.searchParams.set("since", since);
    }
    if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
      url.searchParams.set("limit", String(Math.max(1, Math.min(200, Math.floor(params.limit)))));
    }
    if (params.lane && params.lane !== "all") {
      url.searchParams.set("lane", params.lane);
    }
    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      const errorMessage = await readControllerError(response, "Unable to load activity", requestContext);
      return { success: false, error: errorMessage };
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const items = rawItems
      .map(normalizeActivityItem)
      .filter((item): item is ActivityItem => item !== null);
    return {
      success: true,
      items,
      nextBefore: asString(payload?.nextBefore),
      hasMore: payload?.hasMore === true,
      lastSeenEventId: asString(payload?.lastSeenEventId),
      serverTime: asString(payload?.serverTime),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to load activity: ${message}` };
  }
}

export interface MarkMyActivitySeenParams {
  lastSeenEventId: string;
  accessToken?: string | null;
}

export interface MarkMyActivitySeenResult {
  success: boolean;
  lastSeenEventId?: string | null;
  error?: string;
}

export async function markMyActivitySeen(
  params: MarkMyActivitySeenParams,
): Promise<MarkMyActivitySeenResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }
  const lastSeenEventId = asString(params.lastSeenEventId);
  if (!lastSeenEventId) {
    return { success: false, error: "lastSeenEventId is required." };
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/activity/seen`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ lastSeenEventId }),
    });
    if (!response.ok) {
      const errorMessage = await readControllerError(response, "Unable to record activity cut", requestContext);
      return { success: false, error: errorMessage };
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { success: true, lastSeenEventId: asString(payload?.lastSeenEventId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to record activity cut: ${message}` };
  }
}
