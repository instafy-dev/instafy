import { getOrgDisambiguator, getOrgDisplayName, isPersonalOrgName } from "../../org/orgNaming";
import type { ConversationState } from "../../conversations/ConversationsProvider";
import type { HomeAttentionEntry } from "./homeAttention";
import type { ActivityItem } from "../../services/runtimeController/activity";

/**
 * Home as one cross-team feed. Everything here is pure so the shape of the
 * page — lanes, team chips, day groups, the "since you were here" cut — can
 * be tested without React. Sources are what the app already has today:
 * attention entries (running / queued / replies across every team the user
 * belongs to) and the recent-conversations fetch; Phase 2 replaces both with
 * a user-level activity feed from the controller.
 */

export type HomeFeedLane = "needs" | "activity";
export type HomeFeedKind = "running" | "queued" | "reply" | "conversation" | "run_finished" | "run_failed";

export interface HomeFeedTeam {
  /** Org id, or "personal" for spaces without an org. */
  key: string;
  name: string;
  /** The user's own team (a real "Personal" org, or the no-org bucket). */
  isPersonal: boolean;
  /** Needs-you items for this team, before any filter. */
  needsCount: number;
}

export interface HomeFeedActor {
  kind: "agent" | "assistant" | "user";
  handle: string | null;
  avatarSeed: string | null;
  displayName?: string | null;
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
    | { type: "recent"; recent: HomeFeedRecentConversation }
    | { type: "activity"; item: ActivityItem };
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
  slug?: string | null;
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
  /** Rows from the controller's activity ledger (GET /me/activity). */
  activity?: ActivityItem[];
  /** The server-side cut for ledger rows: ids above it are new. */
  serverLastSeenEventId?: string | null;
  /** Previous visit's cut (epoch ms) for device-local rows; null on a first visit. */
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
  if (event.source.type === "activity") {
    const item = event.source.item;
    return item.conversation?.id.toLowerCase() ?? (item.run ? `run:${item.run.id.toLowerCase()}` : event.key);
  }
  const local = event.source.localConversationId;
  return local.toLowerCase();
}

function kindForActivity(item: ActivityItem): HomeFeedKind | null {
  switch (item.kind) {
    case "conversation.reply":
      return "reply";
    case "conversation.created":
      return "conversation";
    case "run.started":
      return item.live ? "running" : null;
    case "run.finished":
      return "run_finished";
    case "run.failed":
      return "run_failed";
    default:
      return null;
  }
}

function actorForActivity(item: ActivityItem): HomeFeedActor | null {
  const actor = item.actor;
  if (actor.kind === "agent") {
    return { kind: "agent", handle: actor.handle, avatarSeed: actor.avatarSeed, displayName: actor.displayName };
  }
  if (actor.kind === "user") {
    return { kind: "user", handle: null, avatarSeed: null, displayName: actor.displayName };
  }
  return null;
}

function activityEventId(item: ActivityItem): number | null {
  const parsed = Number(item.id);
  return Number.isFinite(parsed) ? parsed : null;
}

// Work in flight sits at the top of Recent as a live group: running before
// queued, then newest first. "Needs you" is replies only, newest first — never
// "whichever space happens to be open" first.
const LIVE_KIND_RANK: Record<HomeFeedKind, number> = {
  running: 0,
  queued: 1,
  reply: 2,
  conversation: 3,
  run_finished: 3,
  run_failed: 3,
};
export const HOME_LIVE_DAY_KEY = "live";

export function buildHomeFeed({
  attentionEntries,
  recentConversations,
  organizations = [],
  activity: ledger = [],
  serverLastSeenEventId = null,
  projects,
  activeProject,
  conversations,
  teamFilter,
  lastSeenAt,
  now = Date.now(),
}: BuildHomeFeedOptions): HomeFeedModel {
  // The user's real Personal team is an org row like any other ("Personal
  // team" is minted on the first space). Spaces without an org are the
  // user's own too, so they fold into that org when it exists — otherwise
  // Home would show two "Personal" chips for one person.
  const personalOrgKey =
    organizations.find((organization) => isPersonalOrgName(organization.name))?.id.trim() ||
    projects.find((project) => project.orgId?.trim() && isPersonalOrgName(project.orgName))?.orgId?.trim() ||
    null;
  const resolveTeamKey = (orgId: string | null | undefined): string => {
    const key = teamKeyForOrgId(orgId);
    return key === HOME_PERSONAL_TEAM_KEY && personalOrgKey ? personalOrgKey : key;
  };

  const teamNames = new Map<string, { name: string; isPersonal: boolean }>();
  const rememberTeam = (orgId: string | null | undefined, orgName: string | null | undefined) => {
    const key = resolveTeamKey(orgId);
    if (!teamNames.has(key)) {
      const isPersonal = key === HOME_PERSONAL_TEAM_KEY || key === personalOrgKey || isPersonalOrgName(orgName);
      teamNames.set(key, {
        name: key === HOME_PERSONAL_TEAM_KEY ? "Personal" : getOrgDisplayName(orgName ?? null),
        isPersonal,
      });
    }
  };
  const teamNameFor = (key: string, fallback: string): string => teamNames.get(key)?.name ?? fallback;
  organizations.forEach((organization) => rememberTeam(organization.id, organization.name));
  projects.forEach((project) => rememberTeam(project.orgId, project.orgName));

  const conversationsByLocalId = new Map(conversations.map((conversation) => [conversation.localId, conversation]));
  const conversationsByControllerId = new Map(
    conversations
      .filter((conversation) => conversation.controllerId)
      .map((conversation) => [conversation.controllerId!.trim().toLowerCase(), conversation]),
  );
  // Local rows are keyed by their controller id when they have one, so a
  // ledger row for the same conversation dedupes against them.
  const canonicalKey = (event: HomeFeedEvent): string => {
    if (event.source.type === "conversation") {
      const local = conversationsByLocalId.get(event.source.localConversationId);
      const controllerId = local?.controllerId?.trim().toLowerCase();
      return controllerId || event.source.localConversationId.toLowerCase();
    }
    return dedupeKeyFor(event);
  };

  const attentionAll: HomeFeedEvent[] = attentionEntries.map((entry) => {
    if (entry.source === "inbox") {
      const item = entry.inboxItem;
      rememberTeam(item.orgId, item.orgName);
      const teamKey = resolveTeamKey(item.orgId);
      const local = conversationsByControllerId.get(item.conversationId.trim().toLowerCase()) ?? null;
      return {
        key: entry.key,
        lane: "needs",
        kind: entry.kind,
        title: entry.title,
        preview: entry.preview,
        at: parseTimestamp(item.lastMessageAt),
        project: { id: item.projectId, name: getSpaceLabel(item.projectName) },
        team: { key: teamKey, name: teamNameFor(teamKey, getOrgDisplayName(item.orgName ?? null)) },
        actor: local ? resolveConversationActor(local) : { kind: "assistant", handle: null, avatarSeed: null },
        isNew: false,
        testId: entry.testId,
        dismissible: entry.kind === "reply",
        source: { type: "inbox", entry },
      };
    }
    const local = conversationsByLocalId.get(entry.localConversationId) ?? null;
    const teamKey = resolveTeamKey(activeProject?.orgId ?? null);
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
      team: { key: teamKey, name: teamNameFor(teamKey, "Personal") },
      actor: local ? resolveConversationActor(local) : null,
      isNew: false,
      testId: entry.testId,
      dismissible: entry.kind === "reply",
      source: { type: "conversation", localConversationId: entry.localConversationId, entry },
    };
  });
  const needsAll: HomeFeedEvent[] = attentionAll
    .filter((event) => event.kind === "reply")
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const localLive: HomeFeedEvent[] = attentionAll
    .filter((event) => event.kind !== "reply")
    .map((event) => ({ ...event, lane: "activity" as const }));

  // Ledger rows from the controller: replies, new conversations and run
  // lifecycle across every team. Unknown kinds are skipped, not shown raw.
  const serverEvents: HomeFeedEvent[] = ledger.flatMap((item): HomeFeedEvent[] => {
    const projectId = item.project?.id ?? "";
    const kind = kindForActivity(item);
    if (!projectId || !kind) {
      return [];
    }
    rememberTeam(item.org?.id ?? null, item.org?.name ?? null);
    const teamKey = resolveTeamKey(item.org?.id ?? null);
    return [
      {
        key: `activity:${item.id}`,
        lane: "activity",
        kind,
        title: item.title ?? (kind === "conversation" ? "New conversation" : "Conversation"),
        preview: item.preview,
        at: parseTimestamp(item.at),
        project: { id: projectId, name: getSpaceLabel(item.project?.name) },
        team: { key: teamKey, name: teamNameFor(teamKey, getOrgDisplayName(item.org?.name ?? null)) },
        actor: actorForActivity(item),
        isNew: false,
        testId: `home-recent-item-${item.id}`,
        dismissible: false,
        source: { type: "activity", item },
      },
    ];
  });
  // The active space's own in-flight work is already known locally (and is
  // instant); a server row for the same conversation would double it.
  const localLiveKeys = new Set(localLive.map(canonicalKey));
  const liveAll: HomeFeedEvent[] = [
    ...localLive,
    ...serverEvents.filter((event) => event.kind === "running" && !localLiveKeys.has(dedupeKeyFor(event))),
  ].sort((a, b) => LIVE_KIND_RANK[a.kind] - LIVE_KIND_RANK[b.kind] || (b.at ?? 0) - (a.at ?? 0));
  const serverRecent = serverEvents.filter((event) => event.kind !== "running");

  const needsKeys = new Set([...needsAll, ...liveAll].map(canonicalKey));

  const recentEvents: HomeFeedEvent[] = recentConversations
    .map((recent): HomeFeedEvent => {
      rememberTeam(recent.orgId, recent.orgName);
      const teamKey = resolveTeamKey(recent.orgId);
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
        team: { key: teamKey, name: teamNameFor(teamKey, getOrgDisplayName(recent.orgName)) },
        actor: recent.actor ?? (local ? resolveConversationActor(local) : null),
        isNew: false,
        testId: `home-recent-item-${itemId}`,
        dismissible: false,
        source: { type: "recent", recent },
      };
    });
  const activityAll: HomeFeedEvent[] = [...recentEvents, ...serverRecent]
    // Something already waiting on you is not also "recent activity".
    .filter((event) => !needsKeys.has(dedupeKeyFor(event)))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // A filter bar must not reorder itself when the user opens another space,
  // so Home pins Personal (the rail pins the ACTIVE team — a navigation rule,
  // not a filter rule) and lists the rest by name.
  const sortedTeams: HomeFeedTeam[] = Array.from(teamNames.entries())
    .map(([key, team]) => ({
      key,
      name: team.name,
      isPersonal: team.isPersonal,
      needsCount: needsAll.filter((event) => event.team.key === key).length,
    }))
    .sort((a, b) => {
      if (a.isPersonal !== b.isPersonal) return a.isPersonal ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  // Two DIFFERENT teams sharing a display name (another person's "Personal")
  // get the rail's disambiguator so every chip has a distinct name.
  const nameCounts = new Map<string, number>();
  sortedTeams.forEach((team) => nameCounts.set(team.name, (nameCounts.get(team.name) ?? 0) + 1));
  const slugByKey = new Map(organizations.map((organization) => [organization.id, organization.slug ?? null]));
  const teams = sortedTeams.map((team) =>
    (nameCounts.get(team.name) ?? 0) > 1 && team.key !== HOME_PERSONAL_TEAM_KEY
      ? { ...team, name: `${team.name} • ${getOrgDisambiguator(slugByKey.get(team.key) ?? null, team.key)}` }
      : team,
  );

  const requestedRaw = teamFilter.trim() || HOME_TEAM_FILTER_ALL;
  // A Personal filter chosen before the membership list resolved keeps working
  // once the chip's key becomes the real org id.
  const requestedFilter = requestedRaw === HOME_PERSONAL_TEAM_KEY && personalOrgKey ? personalOrgKey : requestedRaw;
  const appliedFilter =
    requestedFilter !== HOME_TEAM_FILTER_ALL && teams.some((team) => team.key === requestedFilter)
      ? requestedFilter
      : HOME_TEAM_FILTER_ALL;
  const inFilter = (event: HomeFeedEvent) =>
    appliedFilter === HOME_TEAM_FILTER_ALL || event.team.key === appliedFilter;

  const needs = needsAll.filter(inFilter);
  const live = liveAll.filter(inFilter);
  // Ledger rows are new when their id is above the server-side cut (which
  // follows the user across devices); device-local rows fall back to the
  // local timestamp cut.
  const serverCut = serverLastSeenEventId !== null ? Number(serverLastSeenEventId) : null;
  const hasCut = lastSeenAt !== null || (serverCut !== null && Number.isFinite(serverCut));
  const activityFlat = activityAll.filter(inFilter).map((event) => {
    if (event.source.type === "activity") {
      const id = activityEventId(event.source.item);
      return {
        ...event,
        isNew: serverCut !== null && Number.isFinite(serverCut) && id !== null && id > serverCut,
      };
    }
    return {
      ...event,
      isNew: lastSeenAt !== null && event.at !== null && event.at > lastSeenAt,
    };
  });

  // The cut sits before the first item the user has already seen — only
  // meaningful when there is something on both sides of it. Live rows sit
  // above the dated groups, so the cut's flat index shifts past them.
  const firstSeenIndex = activityFlat.findIndex((event) => !event.isNew);
  const sinceCutIndex =
    hasCut && firstSeenIndex > 0 && firstSeenIndex < activityFlat.length
      ? live.length + firstSeenIndex
      : null;

  const activity: HomeFeedDay[] = live.length > 0 ? [{ key: HOME_LIVE_DAY_KEY, label: "In progress", events: live }] : [];
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
    isEmpty: needsAll.length === 0 && liveAll.length === 0 && activityAll.length === 0,
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
