import { getOrgDisplayName } from "../../org/orgNaming";
import type { ConversationState } from "../../conversations/ConversationsProvider";
import type { HomeAttentionEntry } from "./homeAttention";

/**
 * Home as one cross-team feed. Everything here is pure so the shape of the
 * page — lanes, team chips, day groups, the "since you were here" cut — can
 * be tested without React. Sources are what the app already has today:
 * attention entries (running / queued / replies across every team the user
 * belongs to) and the recent-conversations fetch; Phase 2 replaces both with
 * a user-level activity feed from the controller.
 */

export type HomeFeedLane = "needs" | "activity";
export type HomeFeedKind = "running" | "queued" | "reply" | "conversation";

export interface HomeFeedTeam {
  /** Org id, or "personal" for spaces without an org. */
  key: string;
  name: string;
  /** Needs-you items for this team, before any filter. */
  needsCount: number;
}

export interface HomeFeedActor {
  kind: "agent" | "assistant";
  handle: string | null;
  avatarSeed: string | null;
}

export interface HomeFeedEvent {
  key: string;
  lane: HomeFeedLane;
  kind: HomeFeedKind;
  title: string;
  preview: string | null;
  /** Epoch ms; null when the source has no usable timestamp. */
  at: number | null;
  project: { id: string; name: string };
  team: { key: string; name: string };
  actor: HomeFeedActor | null;
  /** Newer than the previous visit's cut. Always false without a cut. */
  isNew: boolean;
  testId: string;
  dismissible: boolean;
  source:
    | { type: "conversation"; localConversationId: string; entry: HomeAttentionEntry }
    | { type: "inbox"; entry: HomeAttentionEntry }
    | { type: "recent"; recent: HomeFeedRecentConversation };
}

export interface HomeFeedDay {
  key: string;
  label: string;
  events: HomeFeedEvent[];
}

export interface HomeFeedModel {
  teams: HomeFeedTeam[];
  /** The team filter actually applied ("all" when the requested one has no rows). */
  teamFilter: string;
  needs: HomeFeedEvent[];
  activity: HomeFeedDay[];
  /** Position in the flat activity list before which everything is new. */
  sinceCutIndex: number | null;
  isEmpty: boolean;
}

/** A recent conversation from the per-space fetch (or the active space's local state). */
export interface HomeFeedRecentConversation {
  projectId: string;
  projectName: string;
  orgId: string | null;
  orgName: string;
  conversationId: string | null;
  localConversationId: string | null;
  title: string;
  preview: string | null;
  updatedAt: string;
  actor?: HomeFeedActor | null;
}

export interface HomeFeedProjectRef {
  id: string;
  name: string;
  orgId: string | null;
  orgName: string;
}

export interface HomeFeedOrganizationRef {
  id: string;
  name: string | null;
}

interface BuildHomeFeedOptions {
  attentionEntries: HomeAttentionEntry[];
  recentConversations: HomeFeedRecentConversation[];
  /** Teams the user belongs to — a team with no spaces yet still gets a chip. */
  organizations?: HomeFeedOrganizationRef[];
  /** Every space the user has on this device; supplies team names and membership. */
  projects: HomeFeedProjectRef[];
  /** The space open in chat — local attention entries belong to it. */
  activeProject: HomeFeedProjectRef | null;
  /** Local conversations, to attach actors to active-space entries. */
  conversations: ConversationState[];
  teamFilter: string;
  /** Previous visit's cut (epoch ms); null on a first visit. */
  lastSeenAt: number | null;
  now?: number;
}

export const HOME_TEAM_FILTER_ALL = "all";
export const HOME_PERSONAL_TEAM_KEY = "personal";

export function teamKeyForOrgId(orgId: string | null | undefined): string {
  const trimmed = orgId?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : HOME_PERSONAL_TEAM_KEY;
}

export function getSpaceLabel(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Untitled Space";
}

export function formatRelativeTimestamp(at: number | null, now = Date.now()): string | null {
  if (at === null || !Number.isFinite(at)) {
    return null;
  }
  const diffMinutes = Math.max(0, Math.round((now - at) / 60000));
  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d`;
}

function parseTimestamp(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayLabelFor(at: number | null, now: number): { key: string; label: string } {
  if (at === null) {
    return { key: "undated", label: "Earlier" };
  }
  const today = startOfDay(now);
  const day = startOfDay(at);
  const dayMs = 24 * 60 * 60 * 1000;
  if (day >= today) {
    return { key: "today", label: "Today" };
  }
  if (day >= today - dayMs) {
    return { key: "yesterday", label: "Yesterday" };
  }
  if (day >= today - 6 * dayMs) {
    return {
      key: `d-${day}`,
      label: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(at)),
    };
  }
  return {
    key: `d-${day}`,
    label: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(at)),
  };
}

/** The agent behind a local conversation's latest assistant message, if any. */
export function resolveConversationActor(conversation: ConversationState): HomeFeedActor | null {
  const lastAssistant = [...conversation.messages].reverse().find((message) => message.role === "assistant");
  const metadata = lastAssistant?.metadata as { agent?: { handle?: unknown; avatarSeed?: unknown } } | null | undefined;
  const rawHandle =
    typeof metadata?.agent?.handle === "string"
      ? metadata.agent.handle
      : typeof conversation.ownerAgent?.handle === "string"
        ? conversation.ownerAgent.handle
        : null;
  const handle = rawHandle?.trim().replace(/^@/, "").toLowerCase() || null;
  const avatarSeed = typeof metadata?.agent?.avatarSeed === "string" ? metadata.agent.avatarSeed : null;
  if (!handle && !lastAssistant) {
    return null;
  }
  return { kind: handle ? "agent" : "assistant", handle, avatarSeed };
}

function conversationTimestamp(conversation: ConversationState): number {
  return conversation.messages.at(-1)?.timestamp ?? conversation.createdAt;
}

function dedupeKeyFor(event: HomeFeedEvent): string {
  if (event.source.type === "recent") {
    return (
      event.source.recent.conversationId?.trim().toLowerCase() ||
      `${event.project.id}:${event.source.recent.localConversationId ?? event.title}`
    );
  }
  if (event.source.type === "inbox") {
    return event.source.entry.source === "inbox"
      ? event.source.entry.inboxItem.conversationId.trim().toLowerCase()
      : event.key;
  }
  const local = event.source.localConversationId;
  return local.toLowerCase();
}

export function buildHomeFeed({
  attentionEntries,
  recentConversations,
  organizations = [],
  projects,
  activeProject,
  conversations,
  teamFilter,
  lastSeenAt,
  now = Date.now(),
}: BuildHomeFeedOptions): HomeFeedModel {
  const teamNames = new Map<string, string>();
  const rememberTeam = (orgId: string | null | undefined, orgName: string | null | undefined) => {
    const key = teamKeyForOrgId(orgId);
    if (!teamNames.has(key)) {
      teamNames.set(key, key === HOME_PERSONAL_TEAM_KEY ? "Personal" : getOrgDisplayName(orgName ?? null));
    }
  };
  organizations.forEach((organization) => rememberTeam(organization.id, organization.name));
  projects.forEach((project) => rememberTeam(project.orgId, project.orgName));

  const conversationsByLocalId = new Map(conversations.map((conversation) => [conversation.localId, conversation]));
  const conversationsByControllerId = new Map(
    conversations
      .filter((conversation) => conversation.controllerId)
      .map((conversation) => [conversation.controllerId!.trim().toLowerCase(), conversation]),
  );

  const needsAll: HomeFeedEvent[] = attentionEntries.map((entry) => {
    if (entry.source === "inbox") {
      const item = entry.inboxItem;
      rememberTeam(item.orgId, item.orgName);
      const teamKey = teamKeyForOrgId(item.orgId);
      const local = conversationsByControllerId.get(item.conversationId.trim().toLowerCase()) ?? null;
      return {
        key: entry.key,
        lane: "needs",
        kind: entry.kind,
        title: entry.title,
        preview: entry.preview,
        at: parseTimestamp(item.lastMessageAt),
        project: { id: item.projectId, name: getSpaceLabel(item.projectName) },
        team: { key: teamKey, name: teamNames.get(teamKey) ?? getOrgDisplayName(item.orgName ?? null) },
        actor: local ? resolveConversationActor(local) : { kind: "assistant", handle: null, avatarSeed: null },
        isNew: false,
        testId: entry.testId,
        dismissible: entry.kind === "reply",
        source: { type: "inbox", entry },
      };
    }
    const local = conversationsByLocalId.get(entry.localConversationId) ?? null;
    const teamKey = teamKeyForOrgId(activeProject?.orgId ?? null);
    if (activeProject) {
      rememberTeam(activeProject.orgId, activeProject.orgName);
    }
    return {
      key: entry.key,
      lane: "needs",
      kind: entry.kind,
      title: entry.title,
      preview: entry.preview,
      at: local ? conversationTimestamp(local) : null,
      project: { id: activeProject?.id ?? "", name: getSpaceLabel(activeProject?.name) },
      team: { key: teamKey, name: teamNames.get(teamKey) ?? "Personal" },
      actor: local ? resolveConversationActor(local) : null,
      isNew: false,
      testId: entry.testId,
      dismissible: entry.kind === "reply",
      source: { type: "conversation", localConversationId: entry.localConversationId, entry },
    };
  });

  const needsKeys = new Set(needsAll.map(dedupeKeyFor));

  const activityAll: HomeFeedEvent[] = recentConversations
    .map((recent): HomeFeedEvent => {
      rememberTeam(recent.orgId, recent.orgName);
      const teamKey = teamKeyForOrgId(recent.orgId);
      const local = recent.localConversationId
        ? (conversationsByLocalId.get(recent.localConversationId) ?? null)
        : recent.conversationId
          ? (conversationsByControllerId.get(recent.conversationId.trim().toLowerCase()) ?? null)
          : null;
      const itemId = recent.conversationId ?? recent.localConversationId ?? recent.title;
      return {
        key: `recent:${recent.projectId}:${itemId}`,
        lane: "activity",
        kind: "conversation",
        title: recent.title,
        preview: recent.preview,
        at: parseTimestamp(recent.updatedAt),
        project: { id: recent.projectId, name: getSpaceLabel(recent.projectName) },
        team: { key: teamKey, name: teamNames.get(teamKey) ?? getOrgDisplayName(recent.orgName) },
        actor: recent.actor ?? (local ? resolveConversationActor(local) : null),
        isNew: false,
        testId: `home-recent-item-${itemId}`,
        dismissible: false,
        source: { type: "recent", recent },
      };
    })
    // Something already waiting on you is not also "recent activity".
    .filter((event) => !needsKeys.has(dedupeKeyFor(event)))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const teams: HomeFeedTeam[] = Array.from(teamNames.entries())
    .map(([key, name]) => ({
      key,
      name,
      needsCount: needsAll.filter((event) => event.team.key === key).length,
    }))
    .sort((a, b) => {
      if (a.key === HOME_PERSONAL_TEAM_KEY) return -1;
      if (b.key === HOME_PERSONAL_TEAM_KEY) return 1;
      return a.name.localeCompare(b.name);
    });

  const requestedFilter = teamFilter.trim() || HOME_TEAM_FILTER_ALL;
  const appliedFilter =
    requestedFilter !== HOME_TEAM_FILTER_ALL && teams.some((team) => team.key === requestedFilter)
      ? requestedFilter
      : HOME_TEAM_FILTER_ALL;
  const inFilter = (event: HomeFeedEvent) =>
    appliedFilter === HOME_TEAM_FILTER_ALL || event.team.key === appliedFilter;

  const needs = needsAll.filter(inFilter);
  const activityFlat = activityAll.filter(inFilter).map((event) => ({
    ...event,
    isNew: lastSeenAt !== null && event.at !== null && event.at > lastSeenAt,
  }));

  // The cut sits before the first item the user has already seen — only
  // meaningful when there is something on both sides of it.
  const firstSeenIndex = activityFlat.findIndex((event) => !event.isNew);
  const sinceCutIndex =
    lastSeenAt !== null && firstSeenIndex > 0 && firstSeenIndex < activityFlat.length ? firstSeenIndex : null;

  const activity: HomeFeedDay[] = [];
  activityFlat.forEach((event) => {
    const day = dayLabelFor(event.at, now);
    const last = activity.at(-1);
    if (last && last.key === day.key) {
      last.events.push(event);
    } else {
      activity.push({ key: day.key, label: day.label, events: [event] });
    }
  });

  return {
    teams,
    teamFilter: appliedFilter,
    needs,
    activity,
    sinceCutIndex,
    isEmpty: needsAll.length === 0 && activityAll.length === 0,
  };
}

const HOME_LAST_SEEN_STORAGE_PREFIX = "instafy.home.lastSeen.v1";

function lastSeenStorageKey(userKey: string | null | undefined): string {
  const user = userKey?.trim().toLowerCase() || "anonymous";
  return `${HOME_LAST_SEEN_STORAGE_PREFIX}:${user}`;
}

export function readHomeLastSeen(userKey: string | null | undefined): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(lastSeenStorageKey(userKey));
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeHomeLastSeen(userKey: string | null | undefined, at: number): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(lastSeenStorageKey(userKey), String(Math.round(at)));
  } catch {
    // Storage unavailable: the cut just won't persist across visits.
  }
}
