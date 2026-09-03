import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChatLines, Check, Clock, Group, Plus, User, WarningTriangle } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Button, IconButton } from "../../../components/Button";
import { FeedRow } from "../../../components/FeedRow";
import { Heading } from "../../../components/Heading";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { DRAWER_ICON_BUTTON_TONE_CLASS } from "../../../components/listRowStyles";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useProjects } from "../../../projects/useProjects";
import { useAuth } from "../../../providers/AuthProvider";
import { controllerClient, type NotificationInboxItem } from "../../../sdk/instafy";
import type { ActivityItem } from "../../../services/runtimeController/activity";
import { useStatus } from "../../../status/useStatus";
import { DARK_DIVIDER_BORDER_CLASS, DARK_RAIL_HOVER_CLASS } from "../../../theme/darkSurfaces";
import { isUUID } from "../../../utils/uuid";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { buildHomeAttentionEntries, type HomeAttentionEntry } from "../homeAttention";
import {
  HOME_PERSONAL_TEAM_KEY,
  HOME_TEAM_FILTER_ALL,
  buildHomeFeed,
  formatRelativeTimestamp,
  getSpaceLabel,
  teamKeyForOrgId,
  type HomeFeedEvent,
  type HomeFeedOrganizationRef,
} from "../homeFeed";
import { useWorkspaceControls } from "../workspaceControls";
import { CHAT_COLUMN_CLASS_NAME } from "./ChatColumn";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { SettingsShell } from "./SettingsShell";
import { resolveHomeRecentConversationNavigationTarget } from "./homeRecentConversationNavigation";

// Flat rows separated by a hairline: Home is a plain panel, so a lane is a
// section with rows, never a card inside it (darkSurfaces rule 5). The hover
// tint lives on the wrapper so it runs edge to edge, dismiss column included.
const ROW_DIVIDER_CLASS = `border-t border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`;
const ROW_HOVER_CLASS = `group/row transition-colors hover:bg-slate-100 ${DARK_RAIL_HOVER_CLASS}`;
// 28px = ChatMessageAvatar xs, so a face fills its shell with no slack.
const ROW_ICON_CLASS = "h-7 w-7 rounded-full";
// Labels share the rows' 12px inner inset (EntityRow compact px-3).
const LANE_INSET_CLASS = "px-3";
// The row action must still lift on top of the row's hover band.
const ROW_ACTION_CLASS =
  "text-slate-500 hover:bg-slate-200/70 data-[hovered]:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)]";
// Recent renders a page at a time; "Show more" reveals what is already in
// memory first, then asks the controller for the next page of the ledger.
const RECENT_LIMIT = 24;
// Needs you folds after this many rows so a busy inbox cannot push Recent off
// the screen; "Show N more" opens the rest in place.
const NEEDS_PREVIEW_LIMIT = 8;
// The ledger is polled at the inbox's cadence until the live stream lands.
const ACTIVITY_POLL_MS = 20_000;
// A poll that finds more than one page of new activity bridges the gap, but
// never walks history forever on a device that has been closed for weeks.
const CATCH_UP_MAX_PAGES = 3;

// Bare run counters ("3") leak in as previews; they say nothing on a row.
function usablePreview(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return /^\d{1,3}$/.test(trimmed) ? null : trimmed;
}

function buildRouteToConversation(projectId: string, conversationControllerId: string | null): string {
  try {
    const url = new URL(window.location.href);
    url.pathname = "/studio";
    url.searchParams.set("projectId", projectId);
    if (conversationControllerId) {
      url.searchParams.set("conversationControllerId", conversationControllerId);
    } else {
      url.searchParams.delete("conversationControllerId");
    }
    url.searchParams.delete("conversationId");
    url.searchParams.set("panel", "chat");
    const search = url.searchParams.toString();
    return `${url.pathname}${search ? `?${search}` : ""}`;
  } catch {
    return `/studio?projectId=${encodeURIComponent(projectId)}${
      conversationControllerId ? `&conversationControllerId=${encodeURIComponent(conversationControllerId)}` : ""
    }&panel=chat`;
  }
}

function initialsFor(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  return initials || "?";
}

function TeamChip({
  label,
  count,
  selected,
  onPress,
  testId,
}: {
  label: string;
  count: number;
  selected: boolean;
  onPress: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={count > 0 ? `${label}, ${count} need you` : undefined}
      data-testid={testId}
      onClick={onPress}
      className={[
        // 28px on pointers; the top bar's own pill height on touch.
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/60 pointer-coarse:h-10 pointer-coarse:px-3",
        selected
          ? "border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/40 dark:bg-primary-500/10 dark:text-primary-200"
          : "border-slate-200/70 text-slate-600 hover:bg-slate-100 dark:border-[color:var(--color-studio-dark-divider)] dark:text-slate-300 dark:hover:bg-[var(--color-studio-dark-active)]",
      ].join(" ")}
    >
      {label}
      <AttentionBadge count={count} aria-hidden className="shrink-0" />
    </button>
  );
}

function LaneHeader({ label, action }: { label: string; action?: ReactNode }) {
  // Margin, not padding, so the box is 24px with or without an action.
  return (
    <div className={`mb-1.5 flex min-h-6 items-center justify-between gap-3 pointer-coarse:min-h-11 ${LANE_INSET_CLASS}`}>
      <Text as="h2" variant="overline" tone="subtle">
        {label}
      </Text>
      {action}
    </div>
  );
}

function CaughtUpCut() {
  return (
    <div
      role="separator"
      aria-label="You're caught up"
      data-testid="home-since-cut"
      className={`flex items-center gap-3 py-1.5 ${LANE_INSET_CLASS}`}
    >
      <span className="h-px flex-1 bg-primary-400/40" />
      <Text as="span" variant="overline" tone="accent">
        You're caught up
      </Text>
      <span className="h-px flex-1 bg-primary-400/40" />
    </div>
  );
}

function LaneMore({ label, onPress, testId }: { label: string; onPress: () => void; testId: string }) {
  // Sits on the rows' text inset; the button's own padding is pulled back so
  // its label lines up with the lane label above it.
  return (
    <div className={`pt-1 ${LANE_INSET_CLASS}`}>
      <Button type="button" variant="ghost" size="xs" radius="full" className="-ml-2" onPress={onPress} data-testid={testId}>
        {label}
      </Button>
    </div>
  );
}

function EventIcon({ event }: { event: HomeFeedEvent }) {
  // Identity when it is real (a named agent or a person); state only when
  // non-default. An unread reply gets no marker: inside "Needs you" every
  // row is unread, and the lane heading plus the mark-as-read control say so.
  if (event.actor?.handle) {
    return (
      <ChatMessageAvatar
        kind="assistant"
        agent={{ handle: event.actor.handle, avatarSeed: event.actor.avatarSeed }}
        size="xs"
      />
    );
  }
  if (event.actor?.kind === "user") {
    // A person: their initials, or a plain figure when no name is on file.
    const initials = initialsFor(event.actor.displayName);
    return (
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xxs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200"
        aria-hidden="true"
      >
        {initials === "?" ? <User className="h-4 w-4" aria-hidden="true" /> : initials}
      </span>
    );
  }
  if (event.kind === "running") {
    return <Spinner size="xs" />;
  }
  if (event.kind === "queued") {
    return <Clock className="h-4 w-4 text-amber-600 dark:text-amber-300" aria-hidden="true" />;
  }
  if (event.kind === "run_failed") {
    return <WarningTriangle className="h-4 w-4 text-rose-600 dark:text-rose-300" aria-hidden="true" />;
  }
  if (event.kind === "run_finished") {
    return <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />;
  }
  return <ChatLines className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />;
}

function statusSubtitle(event: HomeFeedEvent, viewerUserId: string | null): string | null {
  switch (event.kind) {
    case "running":
      return "Run in progress";
    case "queued":
      return "Waiting for a runtime";
    case "run_finished":
      return "Run finished";
    case "run_failed":
      return "Run failed";
    case "conversation": {
      if (event.source.type !== "activity") {
        return null;
      }
      if (event.source.item.data.threadKind === "automation") {
        return "Scheduled conversation";
      }
      const actorId = event.source.item.actor.userId;
      return actorId && actorId === viewerUserId ? "You started a conversation" : "Started a conversation";
    }
    default:
      return null;
  }
}

function newestActivityId(items: ActivityItem[]): string | null {
  let newest: bigint | null = null;
  for (const item of items) {
    try {
      const id = BigInt(item.id);
      if (newest === null || id > newest) {
        newest = id;
      }
    } catch {
      // Not a numeric cursor; skip it.
    }
  }
  return newest === null ? null : newest.toString();
}

function mergeActivity(current: ActivityItem[], incoming: ActivityItem[]): ActivityItem[] {
  const seen = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged.sort((a, b) => {
    try {
      const left = BigInt(a.id);
      const right = BigInt(b.id);
      return left === right ? 0 : left > right ? -1 : 1;
    } catch {
      return 0;
    }
  });
}

interface HomePanelProps {
  inboxItems?: NotificationInboxItem[];
  refreshInbox?: (options?: { force?: boolean }) => Promise<NotificationInboxItem[]>;
}

export function HomePanel({ inboxItems: sharedInboxItems = [], refreshInbox }: HomePanelProps = {}) {
  const { projectList, activeProjectId } = useProjects();
  const {
    conversations,
    createConversation,
    markConversationRead,
    setConversationControllerId,
  } = useConversations();
  const { showStatus } = useStatus();
  const { requestUrlPush, openConversationTab } = useWorkspaceTabs();
  const { userEmail, onStartNewProject, onStartNewConversation, onOpenOrgSettings } = useWorkspaceControls();
  const { user: authUser } = useAuth();
  const viewerUserId = authUser?.id ?? null;
  const navigate = useNavigate();
  const [locallyDismissedKeys, setLocallyDismissedKeys] = useState<string[]>([]);
  const [teamFilter, setTeamFilter] = useState(HOME_TEAM_FILTER_ALL);
  const [needsExpanded, setNeedsExpanded] = useState(false);
  const [recentLimit, setRecentLimit] = useState(RECENT_LIMIT);
  useEffect(() => {
    // A new filter is a new page: fold both lanes again.
    setNeedsExpanded(false);
    setRecentLimit(RECENT_LIMIT);
  }, [teamFilter]);

  // The ledger: what happened across every team, from the controller.
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityNextBefore, setActivityNextBefore] = useState<string | null>(null);
  const [activityHasMore, setActivityHasMore] = useState(false);
  // The cut is where the previous visit ended; it is read once per visit and
  // then advanced on the server so the next visit (on any device) starts here.
  const [serverLastSeenEventId, setServerLastSeenEventId] = useState<string | null>(null);
  const cutCapturedRef = useRef(false);
  const seenAdvancedToRef = useRef<string | null>(null);

  const advanceSeen = useCallback((items: ActivityItem[]) => {
    const newest = newestActivityId(items);
    if (!newest || seenAdvancedToRef.current === newest) {
      return;
    }
    seenAdvancedToRef.current = newest;
    void controllerClient.activity.markSeen({ lastSeenEventId: newest });
  }, []);

  useEffect(() => {
    let cancelled = false;
    cutCapturedRef.current = false;
    seenAdvancedToRef.current = null;
    setActivityItems([]);
    setActivityLoading(true);
    const loadFirstPage = async () => {
      const result = await controllerClient.activity.list({ limit: RECENT_LIMIT * 2 });
      if (cancelled) return;
      setActivityLoading(false);
      if (!result.success) {
        return;
      }
      const items = result.items ?? [];
      setActivityItems(items);
      setActivityNextBefore(result.nextBefore ?? null);
      setActivityHasMore(result.hasMore === true);
      if (!cutCapturedRef.current) {
        cutCapturedRef.current = true;
        setServerLastSeenEventId(result.lastSeenEventId ?? null);
      }
      advanceSeen(items);
    };
    void loadFirstPage();
    const timer = window.setInterval(() => {
      void (async () => {
        // Catch up from the newest row we hold. Pages come back newest-first,
        // so the first one always carries the new activity; if it says there
        // is more, walk back a bounded number of pages to close the gap
        // rather than leaving a hole in Recent. Rows dedupe by id.
        const since = newestActivityId(activityItemsRef.current);
        let result = await controllerClient.activity.list(
          since ? { since, limit: 200 } : { limit: RECENT_LIMIT * 2 },
        );
        if (cancelled || !result.success) return;
        const items = result.items ?? [];
        if (items.length === 0) return;
        setActivityItems((current) => mergeActivity(current, items));
        advanceSeen(items);
        for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
          if (!result.hasMore || !result.nextBefore) return;
          result = await controllerClient.activity.list({ before: result.nextBefore, limit: 200 });
          if (cancelled || !result.success) return;
          const older = result.items ?? [];
          if (older.length === 0) return;
          setActivityItems((current) => mergeActivity(current, older));
        }
      })();
    }, ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [advanceSeen, userEmail]);
  const activityItemsRef = useRef<ActivityItem[]>([]);
  useEffect(() => {
    activityItemsRef.current = activityItems;
  }, [activityItems]);

  const loadMoreActivity = useCallback(async () => {
    if (!activityNextBefore) return;
    const result = await controllerClient.activity.list({ before: activityNextBefore, limit: RECENT_LIMIT });
    if (!result.success) return;
    setActivityItems((current) => mergeActivity(current, result.items ?? []));
    setActivityNextBefore(result.nextBefore ?? null);
    setActivityHasMore(result.hasMore === true);
  }, [activityNextBefore]);

  // Membership, not spaces, decides which teams get a chip: a team you just
  // joined (or created) has no space yet but still belongs on Home.
  const [organizations, setOrganizations] = useState<HomeFeedOrganizationRef[]>([]);
  const [orgsEpoch, setOrgsEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    controllerClient.organizations
      .list()
      .then((orgs) => {
        if (!cancelled) {
          setOrganizations(orgs.map((org) => ({ id: org.id, name: org.name, slug: org.slug ?? null })));
        }
      })
      .catch(() => {
        // Keep the previous list; a failed refresh must not drop chips.
      });
    return () => {
      cancelled = true;
    };
  }, [orgsEpoch, userEmail]);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const bump = () => setOrgsEpoch((epoch) => epoch + 1);
    window.addEventListener("instafy:orgs-updated", bump);
    return () => window.removeEventListener("instafy:orgs-updated", bump);
  }, []);

  const currentProject = useMemo(
    () => projectList.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projectList],
  );
  const currentSpaceName = currentProject ? getSpaceLabel(currentProject.name) : "Choose a Space";

  useEffect(() => {
    if (!refreshInbox || typeof window === "undefined") {
      return;
    }
    void refreshInbox();
    const timer = window.setInterval(() => {
      void refreshInbox();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [refreshInbox]);

  const attentionEntries = useMemo(
    () => buildHomeAttentionEntries({ conversations, inboxItems: sharedInboxItems, currentSpaceName }),
    [conversations, currentSpaceName, sharedInboxItems],
  );
  useEffect(() => {
    setLocallyDismissedKeys((current) => {
      if (current.length === 0) return current;
      const live = new Set(attentionEntries.map((entry) => entry.key));
      const next = current.filter((key) => live.has(key));
      return next.length === current.length ? current : next;
    });
  }, [attentionEntries]);
  const visibleAttentionEntries = useMemo(
    () => attentionEntries.filter((entry) => !locallyDismissedKeys.includes(entry.key)),
    [attentionEntries, locallyDismissedKeys],
  );

  const feed = useMemo(
    () =>
      buildHomeFeed({
        attentionEntries: visibleAttentionEntries,
        recentConversations: [],
        activity: activityItems,
        serverLastSeenEventId,
        organizations,
        projects: projectList,
        activeProject: currentProject,
        conversations,
        teamFilter,
        lastSeenAt: null,
      }),
    [activityItems, conversations, currentProject, organizations, projectList, serverLastSeenEventId, teamFilter, visibleAttentionEntries],
  );
  const activityTotal = useMemo(() => feed.activity.reduce((count, day) => count + day.events.length, 0), [feed.activity]);
  const activityEvents = useMemo(
    () => feed.activity.flatMap((day) => day.events).slice(0, recentLimit),
    [feed.activity, recentLimit],
  );

  const acknowledgeInbox = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const result = await controllerClient.notifications.acknowledgeInboxItem({ conversationId });
      if (!result.success) {
        showStatus(result.error ?? "Unable to mark this as read.", "error", 4000);
        return false;
      }
      return true;
    },
    [showStatus],
  );

  const openConversationById = useCallback(
    (projectId: string, conversationId: string | null) => {
      if (conversationId && projectId === activeProjectId) {
        const local = conversations.find((conversation) => (conversation.controllerId ?? "").trim() === conversationId);
        if (local) {
          openConversationTab(local.localId);
          return;
        }
      }
      navigate(buildRouteToConversation(projectId, conversationId));
    },
    [activeProjectId, conversations, navigate, openConversationTab],
  );

  const openEvent = useCallback(
    (event: HomeFeedEvent) => {
      requestUrlPush();
      if (event.source.type === "conversation") {
        openConversationTab(event.source.localConversationId);
        return;
      }
      if (event.source.type === "inbox" && event.source.entry.source === "inbox") {
        const item = event.source.entry.inboxItem;
        const projectId = item.projectId.trim();
        const conversationId = item.conversationId.trim();
        if (!projectId || !conversationId) return;
        void acknowledgeInbox(conversationId).then((ok) => {
          if (ok) void refreshInbox?.({ force: true });
        });
        openConversationById(projectId, conversationId);
        return;
      }
      if (event.source.type === "activity") {
        const item = event.source.item;
        const projectId = item.project?.id;
        if (!projectId) return;
        openConversationById(projectId, item.conversation?.id ?? null);
        return;
      }
      if (event.source.type === "recent") {
        const target = resolveHomeRecentConversationNavigationTarget({
          activeProjectId,
          conversations,
          entry: event.source.recent,
        });
        if (target.kind === "local") {
          openConversationTab(target.localConversationId);
          return;
        }
        navigate(buildRouteToConversation(target.projectId, target.conversationControllerId));
      }
    },
    [acknowledgeInbox, activeProjectId, conversations, navigate, openConversationById, openConversationTab, refreshInbox, requestUrlPush],
  );

  const dismissEvent = useCallback(
    async (event: HomeFeedEvent): Promise<boolean> => {
      if (event.source.type === "recent" || event.source.type === "activity") return false;
      const entry: HomeAttentionEntry = event.source.entry;
      setLocallyDismissedKeys((current) => (current.includes(entry.key) ? current : [...current, entry.key]));
      if (entry.source === "conversation") {
        markConversationRead(entry.localConversationId);
        return true;
      }
      const conversationId = entry.inboxItem.conversationId.trim();
      if (!conversationId) return true;
      const ok = await acknowledgeInbox(conversationId);
      if (!ok) {
        setLocallyDismissedKeys((current) => current.filter((key) => key !== entry.key));
      }
      return ok;
    },
    [acknowledgeInbox, markConversationRead],
  );

  const dismissibleNeeds = useMemo(() => feed.needs.filter((event) => event.dismissible), [feed.needs]);
  const handleMarkAllRead = useCallback(() => {
    void (async () => {
      const results = await Promise.all(dismissibleNeeds.map((event) => dismissEvent(event)));
      if (results.some(Boolean)) {
        await refreshInbox?.({ force: true });
      }
    })();
  }, [dismissEvent, dismissibleNeeds, refreshInbox]);

  // A fresh, empty chat — for a new user this lands on the guided
  // getting-started card, which is where starter prompts live.
  const handleStartChat = useCallback(() => {
    const conversation = createConversation({ title: "New chat", select: true });
    markConversationRead(conversation.localId);
    requestUrlPush();
    openConversationTab(conversation.localId, { fallbackConversation: conversation });
    if (activeProjectId && isUUID(activeProjectId)) {
      void controllerClient.conversations
        .createBlank({ projectId: activeProjectId, metadata: { title: "New chat", localId: conversation.localId } })
        .then((response) => {
          if (response?.conversationId) {
            setConversationControllerId(conversation.localId, response.conversationId);
          }
        });
    }
  }, [activeProjectId, createConversation, markConversationRead, openConversationTab, requestUrlPush, setConversationControllerId]);
  // The top bar's (+) 58px above this one on phones creates the same kind of
  // conversation; two adjacent pluses must not mean two different things.
  const startChat = onStartNewConversation ?? handleStartChat;

  const showTeamChips = feed.teams.length > 1;
  // Team on a row only when it is not the default: multi-team, unfiltered.
  // Personal rows never carry it — everything here is yours already.
  const showTeamOnRows = showTeamChips && feed.teamFilter === HOME_TEAM_FILTER_ALL;
  const personalTeamKeys = useMemo(
    () => new Set(feed.teams.filter((team) => team.isPersonal).map((team) => team.key)),
    [feed.teams],
  );
  // Name the space only when the visible feed spans more than one — by name,
  // since two "Untitled Space"s cannot be told apart by a label anyway.
  const spansSpaces = useMemo(
    () => new Set([...feed.needs, ...activityEvents].map((event) => event.project.name)).size > 1,
    [activityEvents, feed.needs],
  );
  // "New space" lands in the team being looked at, else the current one.
  const newSpaceOrgId =
    feed.teamFilter === HOME_TEAM_FILTER_ALL
      ? (currentProject?.orgId ?? null)
      : feed.teamFilter === HOME_PERSONAL_TEAM_KEY
        ? null
        : feed.teamFilter;
  const newSpaceTeam = showTeamChips
    ? (feed.teams.find((team) => team.key === teamKeyForOrgId(newSpaceOrgId)) ?? null)
    : null;
  const visibleNeeds = needsExpanded ? feed.needs : feed.needs.slice(0, NEEDS_PREVIEW_LIMIT);
  const hiddenNeeds = feed.needs.length - visibleNeeds.length;
  const filteredTeam = feed.teams.find((team) => team.key === feed.teamFilter) ?? null;
  const lanesEmpty = feed.needs.length === 0 && activityEvents.length === 0 && !activityLoading;
  const filteredTeamHasSpaces =
    filteredTeam !== null && projectList.some((project) => teamKeyForOrgId(project.orgId) === filteredTeam.key);
  const canShowMoreRecent = activityTotal > recentLimit || activityHasMore;
  const handleShowMoreRecent = useCallback(() => {
    if (activityTotal > recentLimit) {
      setRecentLimit((limit) => limit + RECENT_LIMIT);
      return;
    }
    void loadMoreActivity().then(() => setRecentLimit((limit) => limit + RECENT_LIMIT));
  }, [activityTotal, loadMoreActivity, recentLimit]);

  const renderRow = (event: HomeFeedEvent, options: { divider: boolean }) => {
    const when = formatRelativeTimestamp(event.at);
    const teamSuffix = showTeamOnRows && !personalTeamKeys.has(event.team.key) ? ` · ${event.team.name}` : "";
    const where = spansSpaces ? `${event.project.name}${teamSuffix}` : null;
    // A folded thread says how much is behind its newest state.
    const updates =
      event.group && event.group.count > 1
        ? event.group.newCount > 0
          ? `${event.group.newCount} new of ${event.group.count} updates`
          : `${event.group.count} updates`
        : null;
    // A scheduled conversation says so once, ahead of its state.
    const scheduled =
      event.source.type === "activity" &&
      event.source.item.conversation?.threadKind === "automation" &&
      event.kind !== "conversation"
        ? "Scheduled"
        : null;
    const rest =
      [scheduled, updates, statusSubtitle(event, viewerUserId), usablePreview(event.preview)].filter(Boolean).join(" · ") ||
      null;
    return (
      <div key={event.key} className={[ROW_HOVER_CLASS, options.divider ? ROW_DIVIDER_CLASS : ""].filter(Boolean).join(" ")}>
        <FeedRow
          title={event.title}
          meta={when ?? undefined}
          metaPlacement="end"
          // Same 20px line box as the title so the two baselines meet.
          titleEndClassName="whitespace-nowrap tabular-nums [&>span]:leading-5"
          subtitle={
            where || rest ? (
              <>
                {where ? <span className="text-slate-600 dark:text-slate-300">{where}</span> : null}
                {where && rest ? " · " : null}
                {rest}
              </>
            ) : undefined
          }
          icon={<EventIcon event={event} />}
          iconClassName={ROW_ICON_CLASS}
          onPress={() => openEvent(event)}
          density="compact"
          verticalAlign="center"
          surface="plain"
          // The wrapper owns the tint; a uniform 56px pitch on every pointer.
          className="min-h-14 !rounded-none !bg-transparent pointer-coarse:min-h-14"
          // One straight time column across both lanes. Below sm the column
          // goes away: opening a row or "Mark all read" is how phones dismiss.
          reserveTrailingAction
          trailingActionClassName="w-8 justify-center transition-opacity max-sm:hidden pointer-coarse:w-11 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
          trailingAction={
            event.dismissible ? (
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                radius="full"
                title="Mark as read"
                aria-label={`Mark ${event.title} as read`}
                data-testid={`${event.testId}-dismiss`}
                onPress={() => void dismissEvent(event)}
                className={ROW_ACTION_CLASS}
              >
                <Check className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null
          }
          data-testid={event.testId}
        />
      </div>
    );
  };

  return (
    <SettingsShell title="Home" hideTitle testId="home-panel">
      <div className={`${CHAT_COLUMN_CLASS_NAME} min-w-0 space-y-4`}>
        <header className="flex items-center justify-between gap-2">
          {showTeamChips ? (
            <div
              role="group"
              aria-label="Filter by team"
              data-testid="home-team-filters"
              // Scrolls on phones (many teams must not stack above the feed),
              // wraps from sm up. The negative margins let the strip bleed to
              // the shell's edge without clipping chip focus rings.
              className="no-scrollbar -my-1 -ml-3 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 pl-3 sm:ml-0 sm:flex-initial sm:flex-wrap sm:overflow-visible sm:pl-0"
            >
              <TeamChip
                label="All"
                count={0}
                selected={feed.teamFilter === HOME_TEAM_FILTER_ALL}
                onPress={() => setTeamFilter(HOME_TEAM_FILTER_ALL)}
                testId="home-team-chip-all"
              />
              {feed.teams.map((team) => (
                <TeamChip
                  key={team.key}
                  label={team.name}
                  count={team.needsCount}
                  selected={feed.teamFilter === team.key}
                  onPress={() => setTeamFilter(team.key)}
                  testId={`home-team-chip-${team.key}`}
                />
              ))}
            </div>
          ) : (
            <Heading level={2} variant="subtitle">
              Home
            </Heading>
          )}
          <MenuTrigger>
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              radius="full"
              title="New"
              aria-label="New chat or space"
              data-testid="home-create"
              className={`ml-auto shrink-0 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <StudioPopover placement="bottom end" offset={6} className="w-64 p-1">
              <StudioMenu
                aria-label="Create"
                onAction={(key) => {
                  if (key === "chat") {
                    startChat();
                  } else if (key === "space") {
                    onStartNewProject?.(newSpaceOrgId);
                  }
                }}
              >
                <StudioMenuItem id="chat" data-testid="home-new-chat">
                  <MenuItemContent start={<ChatLines aria-hidden="true" />}>
                    {currentProject ? `New chat in ${currentSpaceName}` : "New chat"}
                  </MenuItemContent>
                </StudioMenuItem>
                {onStartNewProject ? (
                  <StudioMenuItem id="space" data-testid="home-new-space">
                    <MenuItemContent start={<Plus aria-hidden="true" />}>
                      {newSpaceTeam ? `New space in ${newSpaceTeam.name}` : "New space"}
                    </MenuItemContent>
                  </StudioMenuItem>
                ) : null}
              </StudioMenu>
            </StudioPopover>
          </MenuTrigger>
        </header>

        {feed.isEmpty && !activityLoading ? (
          <section className="space-y-3" data-testid="home-empty">
            <Heading level={2} variant="subtitle">
              Nothing here yet
            </Heading>
            <Text as="p" variant="body" tone="muted" className="max-w-prose">
              Replies, runs and changes from every space you belong to show up here.
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" radius="xl" className="gap-2" onPress={startChat} data-testid="home-start-first-chat">
                <ChatLines className="h-4 w-4" aria-hidden="true" />
                Start a chat
              </Button>
              {onStartNewProject ? (
                <Button variant="outline" size="sm" radius="xl" className="gap-2" onPress={() => onStartNewProject(newSpaceOrgId)}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New space
                </Button>
              ) : null}
              {onOpenOrgSettings ? (
                <Button variant="outline" size="sm" radius="xl" className="gap-2" onPress={onOpenOrgSettings}>
                  <Group className="h-4 w-4" aria-hidden="true" />
                  Invite people
                </Button>
              ) : null}
            </div>
          </section>
        ) : filteredTeam && lanesEmpty ? (
          // A team with nothing in it yet is an invitation, not two empty lanes.
          <section className={`space-y-2 py-4 ${LANE_INSET_CLASS}`} data-testid="home-filter-empty">
            <Text as="p" variant="body" tone="muted">
              {filteredTeamHasSpaces ? `Quiet in ${filteredTeam.name} so far.` : `No spaces in ${filteredTeam.name} yet.`}
            </Text>
            {!filteredTeamHasSpaces && onStartNewProject ? (
              <Button
                variant="outline"
                size="sm"
                radius="xl"
                className="gap-2"
                data-testid="home-filter-empty-new-space"
                onPress={() => onStartNewProject(newSpaceOrgId)}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                New space
              </Button>
            ) : null}
          </section>
        ) : (
          <div className="space-y-8">
            {feed.needs.length > 0 ? (
              <section data-testid="home-attention-section">
                <LaneHeader
                  label="Needs you"
                  action={
                    dismissibleNeeds.length > 0 ? (
                      <Button type="button" variant="ghost" size="xs" radius="full" onPress={handleMarkAllRead}>
                        Mark all read
                      </Button>
                    ) : null
                  }
                />
                <div className="min-w-0">
                  {visibleNeeds.map((event, index) => renderRow(event, { divider: index > 0 }))}
                </div>
                {hiddenNeeds > 0 ? (
                  <LaneMore
                    label={`Show ${hiddenNeeds} more`}
                    onPress={() => setNeedsExpanded(true)}
                    testId="home-attention-show-all"
                  />
                ) : null}
              </section>
            ) : null}

            <section data-testid="home-recent-section">
              <LaneHeader label="Recent" action={activityLoading ? <Spinner size="xs" /> : null} />
              {activityEvents.length === 0 && !activityLoading ? (
                <Text as="p" variant="body" tone="muted" className={`py-2 ${LANE_INSET_CLASS}`} data-testid="home-recent-empty">
                  Quiet so far.
                </Text>
              ) : null}
              {(() => {
                let flatIndex = 0;
                return feed.activity.map((day, dayIndex) => {
                  const dayStart = flatIndex;
                  if (dayStart >= recentLimit) return null;
                  const cutAtDayStart = feed.sinceCutIndex === dayStart;
                  return (
                    <div key={day.key} className="min-w-0">
                      {cutAtDayStart ? <CaughtUpCut /> : null}
                      {feed.activity.length > 1 ? (
                        // A sub-group label: a caption under the lane overline,
                        // and silent altogether when everything is one day.
                        <Text
                          as="p"
                          variant="caption"
                          tone="subtle"
                          className={[
                            `pb-1 pt-2.5 text-xxs font-medium ${LANE_INSET_CLASS}`,
                            dayIndex > 0 && !cutAtDayStart ? ROW_DIVIDER_CLASS : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {day.label}
                        </Text>
                      ) : null}
                      {day.events.map((event) => {
                        const index = flatIndex;
                        flatIndex += 1;
                        if (index >= recentLimit) return null;
                        const cutHere = feed.sinceCutIndex === index && index !== dayStart;
                        return (
                          <Fragment key={event.key}>
                            {cutHere ? <CaughtUpCut /> : null}
                            {renderRow(event, { divider: index !== dayStart && !cutHere })}
                          </Fragment>
                        );
                      })}
                    </div>
                  );
                });
              })()}
              {canShowMoreRecent ? (
                <LaneMore label="Show more" onPress={handleShowMoreRecent} testId="home-recent-show-more" />
              ) : null}
            </section>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}
