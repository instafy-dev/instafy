import { DEFAULT_HOME_LIST_STATE, useStudioListState, useStudioRecentChatKeys } from "../../../navigation/StudioListNavigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { HomeNotifications } from "../../../notifications/useNotificationCenter";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { ChatLines, Check, Clock, Group, Plus, WarningTriangle } from "iconoir-react";
import { HumanAvatar } from "../../../components/HumanAvatar";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Button, IconButton } from "../../../components/Button";
import { FeedRow } from "../../../components/FeedRow";
import { Heading } from "../../../components/Heading";
import { usePageTitleInNavigation } from "../../../components/PageTitleContext";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useProjects } from "../../../projects/useProjects";
import { useAuth } from "../../../providers/AuthProvider";
import { controllerClient, type NotificationInboxItem } from "../../../sdk/instafy";
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
import { getHomeNotificationTarget } from "../homeNotifications";
import type { HomeSupportReport } from "../homeSupportReports";
import { useHomeActivity } from "../useHomeActivity";
import { homeRecentChats } from "../homeRecentChats";
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
// Keep recent activity within reach on phones, while wider panels show more.
const UNREAD_PREVIEW_LIMIT = 8;
const COMPACT_UNREAD_PREVIEW_LIMIT = 4;

// Bare run counters ("3") leak in as previews; they say nothing on a row.
function usablePreview(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return /^\d{1,3}$/.test(trimmed) ? null : trimmed;
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
      aria-label={count > 0 ? `${label}, ${count} unread` : undefined}
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
      <Text as="h2" variant="bodyStrong" tone="secondary">
        {label}
      </Text>
      {action}
    </div>
  );
}

function EarlierActivityCut() {
  return (
    <div
      role="separator"
      aria-label="Earlier activity"
      data-testid="home-since-cut"
      className={`flex items-center gap-3 py-1.5 ${LANE_INSET_CLASS}`}
    >
      <span className="h-px flex-1 bg-slate-200/70 dark:bg-[var(--color-studio-dark-divider)]" />
      <Text as="span" variant="caption" tone="muted">
        Earlier activity
      </Text>
      <span className="h-px flex-1 bg-slate-200/70 dark:bg-[var(--color-studio-dark-divider)]" />
    </div>
  );
}

function LaneMore({ label, onPress, testId, disabled = false, className }: {
  label: string;
  onPress: () => void;
  testId: string;
  disabled?: boolean;
  className?: string;
}) {
  // Sits on the rows' text inset; the button's own padding is pulled back so
  // its label lines up with the lane label above it.
  return (
    <div className={[`pt-1 ${LANE_INSET_CLASS}`, className].filter(Boolean).join(" ")}>
      <Button type="button" variant="ghost" size="xs" radius="full" className="-ml-2" onPress={onPress} data-testid={testId} isDisabled={disabled}>
        {label}
      </Button>
    </div>
  );
}

function EventIcon({ event }: { event: HomeFeedEvent }) {
  if (event.kind === "run_failed" || event.kind === "automation_failed") {
    return <WarningTriangle className="h-4 w-4 text-rose-600 dark:text-rose-300" aria-hidden="true" />;
  }
  // Identity when it is real (a named agent or a person); state only when
  // non-default. An unread reply gets no marker: inside "Unread" every
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
    const actor = event.source.type === "activity" ? event.source.item.actor : null;
    return (
      <HumanAvatar userId={actor?.kind === "user" ? actor.userId : null}
        displayName={event.actor.displayName} className="h-7 w-7 text-xxs" />
    );
  }
  if (event.kind === "running") {
    return <Spinner size="xs" />;
  }
  if (event.kind === "queued") {
    return <Clock className="h-4 w-4 text-amber-600 dark:text-amber-300" aria-hidden="true" />;
  }
  if (event.kind === "run_finished" || event.kind === "automation_completed" || event.kind === "support_resolved") {
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
    case "support_reply":
    case "support_resolved":
      return null;
    case "automation_completed":
      return event.source.type === "notification" ? null : "Automation finished";
    case "automation_failed":
      return event.source.type === "notification" ? null : "Automation failed";
    case "run_failed":
      return event.statusLabel ?? "Run failed";
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

interface HomePanelProps {
  notifications?: HomeNotifications;
  supportReports?: HomeSupportReport[];
  supportLoading?: boolean;
  supportError?: string | null;
  refreshSupport?: () => Promise<void>;
  onOpenSupport?: (reportId: string) => void;
  inboxItems?: NotificationInboxItem[];
  refreshInbox?: (options?: { force?: boolean }) => Promise<NotificationInboxItem[]>;
}

export function HomePanel({ inboxItems: sharedInboxItems = [], refreshInbox, notifications, supportReports, supportLoading = false, supportError, refreshSupport, onOpenSupport }: HomePanelProps = {}) {
  const titleInNavigation = usePageTitleInNavigation();
  const { projectList, activeProjectId } = useProjects();
  const {
    conversations,
    createConversation,
    markConversationRead,
    setConversationControllerId,
  } = useConversations();
  const { showStatus } = useStatus();
  const { openConversationTab } = useWorkspaceTabs();
  const { userEmail, onStartNewProject, onStartNewConversation, onOpenOrgSettings } = useWorkspaceControls();
  const { user: authUser, session: authSession } = useAuth();
  const authIdentity = useRef({ userId: authUser?.id, token: authSession?.access_token });
  if (authIdentity.current.userId !== authUser?.id || authIdentity.current.token !== authSession?.access_token) authIdentity.current = { userId: authUser?.id, token: authSession?.access_token };
  const authVisit = authIdentity.current;
  const viewerUserId = authUser?.id ?? null;
  const navigateTo = useStudioNavigation();
  const navigate = useNavigate();
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const [homeState, setHomeState] = useStudioListState("home", DEFAULT_HOME_LIST_STATE);
  const { teamFilter, needsExpanded, recentLimit } = homeState;
  const setTeamFilter = (teamFilter: string) => setHomeState(previous => ({ ...previous, teamFilter, needsExpanded: false, recentLimit: RECENT_LIMIT }));
  const setNeedsExpanded = (needsExpanded: boolean) => setHomeState(previous => ({ ...previous, needsExpanded }));
  const setRecentLimit = useCallback((update: (limit: number) => number) => setHomeState(previous => ({ ...previous, recentLimit: update(previous.recentLimit) })), [setHomeState]);
  const restoreActivityPages = useRef(homeState.activityPages).current;

  const {
    activityItems,
    activityLoading,
    activityLoadingMore,
    activityHasMore,
    activityError,
    activityPages,
    serverLastSeenEventId,
    loadMoreActivity,
    retryActivity,
  } = useHomeActivity(viewerUserId, RECENT_LIMIT, true, restoreActivityPages);
  useEffect(() => {
    if (activityPages > homeState.activityPages) setHomeState(previous => ({ ...previous, activityPages }));
  }, [activityPages, homeState.activityPages, setHomeState]);

  // Membership, not spaces, decides which teams get a chip: a team you just
  // joined (or created) has no space yet but still belongs on Home.
  const [membership, setMembership] = useState<{ userId: string; organizations: HomeFeedOrganizationRef[] } | null>(null);
  const organizations = useMemo(() => membership?.userId === viewerUserId ? membership.organizations : [], [membership, viewerUserId]);
  const membershipsReady = membership !== null && membership.userId === viewerUserId;
  const homeProjects = useMemo(() => membershipsReady
    ? projectList.filter(project => !project.orgId || organizations.some(org => org.id === project.orgId))
    : projectList, [membershipsReady, organizations, projectList]);
  const [orgsEpoch, setOrgsEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!viewerUserId) return;
    controllerClient.organizations
      .list()
      .then((orgs) => {
        if (!cancelled) {
          setMembership({ userId: viewerUserId, organizations: orgs.map((org) => ({ id: org.id, name: org.name, slug: org.slug ?? null })) });
        }
      })
      .catch(() => {
        // Keep the previous list; a failed refresh must not drop chips.
      });
    return () => {
      cancelled = true;
    };
  }, [orgsEpoch, userEmail, viewerUserId]);
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

  // One read on mount; the studio layout owns the inbox timer.
  useEffect(() => {
    if (!refreshInbox) {
      return;
    }
    void refreshInbox();
  }, [refreshInbox]);

  const attentionEntries = useMemo(
    () => buildHomeAttentionEntries({ conversations, inboxItems: sharedInboxItems, currentSpaceName }),
    [conversations, currentSpaceName, sharedInboxItems],
  );
  const visibleAttentionEntries = attentionEntries;

  const feed = useMemo(
    () =>
      buildHomeFeed({
        attentionEntries: visibleAttentionEntries,
        recentConversations: [],
        activity: activityItems,
        notifications: notifications?.page.items,
        supportReports,
        serverLastSeenEventId,
        organizations,
        projects: homeProjects,
        activeProject: currentProject,
        conversations,
        teamFilter,
        lastSeenAt: null,
      }),
    [activityItems, conversations, currentProject, notifications?.page.items, organizations, homeProjects, serverLastSeenEventId, teamFilter, visibleAttentionEntries, supportReports],
  );
  const activityTotal = useMemo(() => feed.activity.reduce((count, day) => count + day.events.length, 0), [feed.activity]);
  useEffect(() => {
    // Keep search and the displayed filter in agreement after membership or
    // Personal-team resolution changes. Fresh activity can also supply a team.
    if (membershipsReady && !activityLoading && teamFilter !== feed.teamFilter) {
      setHomeState(previous => ({ ...previous, teamFilter: feed.teamFilter }));
    }
  }, [activityLoading, feed.teamFilter, membershipsReady, setHomeState, teamFilter]);
  const recentChatKeys = useStudioRecentChatKeys();
  const recentChats = useMemo(() => homeRecentChats([...feed.needs, ...feed.activity.flatMap(day => day.events)], recentChatKeys), [feed, recentChatKeys]);
  const activityEvents = useMemo(
    () => feed.activity.flatMap((day) => day.events).slice(0, recentLimit),
    [feed.activity, recentLimit],
  );

  const acknowledgeInbox = useCallback(
    async (event: HomeFeedEvent): Promise<boolean> => {
      if (authIdentity.current !== authVisit) return false;
      const localId = event.source.type === "conversation" ? event.source.localConversationId : null;
      const local = conversations.find(item => item.localId === localId);
      const targetConversationId = local?.controllerId ?? event.notifications?.map(getHomeNotificationTarget).find(target => target?.conversationId)?.conversationId;
      const persistedLast = local?.messages.findLast(message => isUUID(message.id));
      const item = event.source.type === "inbox" && event.source.entry.source === "inbox"
        ? event.source.entry.inboxItem
        : sharedInboxItems.find(item => item.conversationId === targetConversationId) ??
          (local?.controllerId && isUUID(local.controllerId) && persistedLast ? { conversationId: local.controllerId, lastMessageId: persistedLast.id } : null);
      if (!item) return event.notifications?.length ? (await notifications?.markRead(event.notifications)) === true : true;
      const ids = [...new Set((event.notifications ?? []).filter(item => !item.readAt && !item.archivedAt).map(item => item.id))];
      let inboxAcknowledged = false;
      // Keep requests bounded while acknowledging exactly this row's snapshot.
      for (let offset = 0; offset < Math.max(1, ids.length); offset += 100) {
        if (authIdentity.current !== authVisit) return false;
        const chunk = ids.slice(offset, offset + 100);
        const result = await controllerClient.notifications.acknowledgeInboxItem({
          conversationId: item.conversationId,
          expectedLastMessageId: offset === 0 ? item.lastMessageId : undefined,
          notificationIds: chunk, accessToken: authVisit.token,
          expectedUserId: authVisit.userId,
          isCurrent: () => authIdentity.current === authVisit,
        });
        if (authIdentity.current !== authVisit) return false;
        if (!result.success || result.inboxAcknowledged === undefined ||
          !chunk.every(id => result.acknowledgedNotificationIds?.includes(id))) {
          showStatus(result.error ?? "Unable to mark this update as read. Please refresh and try again.", "error", 4000);
          return false;
        }
        if (offset === 0) inboxAcknowledged = result.inboxAcknowledged;
      }
      await Promise.all([refreshInbox?.({ force: true }), notifications?.refresh({ force: true })]);
      // A concurrent reply leaves the server inbox unread; never hide its row.
      return inboxAcknowledged;
    },
    [authVisit, conversations, notifications, refreshInbox, sharedInboxItems, showStatus],
  );

  const openConversationById = useCallback(
    (projectId: string, conversationId: string | null) => {
      const local = projectId === activeProjectId && conversationId
        ? conversations.find((conversation) => conversation.controllerId === conversationId) : null;
      navigateTo({ kind: "conversation", projectId, conversationId: local?.localId, conversationControllerId: conversationId });
    },
    [activeProjectId, conversations, navigateTo],
  );

  const openLocalConversation = useCallback((conversationId: string) => {
    if (!activeProjectId) return;
    navigateTo({ kind: "conversation", projectId: activeProjectId, conversationId,
      conversationControllerId: conversations.find((conversation) => conversation.localId === conversationId)?.controllerId });
  }, [activeProjectId, conversations, navigateTo]);

  const openEvent = useCallback(
    (event: HomeFeedEvent) => {
      if (event.source.type === "support") {
        if (onOpenSupport) onOpenSupport(event.source.report.id);
        else navigate(`/studio?supportReportId=${event.source.report.id}`);
        return;
      }
      if (event.source.type === "notification") {
        void notifications?.markRead(event.notifications ?? [event.source.item]);
        const supportId = getHomeNotificationTarget(event.source.item)?.supportReportId;
        if (supportId && onOpenSupport) onOpenSupport(supportId);
        else navigate(event.source.item.url);
        return;
      }
      if (event.source.type === "conversation") {
        void acknowledgeInbox(event);
        openLocalConversation(event.source.localConversationId);
        return;
      }
      if (event.source.type === "inbox" && event.source.entry.source === "inbox") {
        const item = event.source.entry.inboxItem;
        const projectId = item.projectId.trim();
        const conversationId = item.conversationId.trim();
        if (!projectId || !conversationId) return;
        void acknowledgeInbox(event);
        openConversationById(projectId, conversationId);
        return;
      }
      if (event.source.type === "activity") {
        if (event.notifications?.length) void notifications?.markRead(event.notifications);
        const destination = event.notifications?.map(getHomeNotificationTarget).find(target => target?.kind === "automation");
        if (destination) { navigate(destination.url); return; }
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
          openLocalConversation(target.localConversationId);
          return;
        }
        openConversationById(target.projectId, target.conversationControllerId);
      }
    },
    [acknowledgeInbox, activeProjectId, conversations, navigate, notifications, onOpenSupport, openConversationById, openLocalConversation],
  );

  const dismissEvent = useCallback(
    async (event: HomeFeedEvent): Promise<boolean> => {
      if (event.source.type === "support") return false;
      if (event.source.type === "notification" || event.source.type === "activity" || event.source.type === "recent") {
        return event.notifications?.length ? acknowledgeInbox(event) : false;
      }
      const entry: HomeAttentionEntry = event.source.entry;
      if (entry.source === "inbox") return acknowledgeInbox(event);
      const before = conversationsRef.current.find(item => item.localId === entry.localConversationId);
      if (!before || !(await acknowledgeInbox(event)) || authIdentity.current !== authVisit) return false;
      const after = conversationsRef.current.find(item => item.localId === entry.localConversationId);
      // Reducer MARK_READ clears current state. Only invoke it if the displayed
      // conversation has not changed while its server acknowledgement was pending.
      if (after !== before) return false;
      markConversationRead(entry.localConversationId);
      return true;
    },
    [acknowledgeInbox, authVisit, markConversationRead],
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
    if (!activeProjectId) return;
    const conversation = createConversation({ title: "New chat", select: false });
    markConversationRead(conversation.localId);
    openConversationTab(conversation.localId, { activate: false, fallbackConversation: conversation });
    navigateTo({ kind: "conversation", projectId: activeProjectId, conversationId: conversation.localId });
    if (activeProjectId && isUUID(activeProjectId)) {
      void controllerClient.conversations
        .createBlank({ projectId: activeProjectId, metadata: { title: "New chat", localId: conversation.localId } })
        .then((response) => {
          if (response?.conversationId) {
            setConversationControllerId(conversation.localId, response.conversationId);
          }
        });
    }
  }, [activeProjectId, createConversation, markConversationRead, navigateTo, openConversationTab, setConversationControllerId]);
  // Empty-state creation uses the same conversation action as the top bar.
  const startChat = onStartNewConversation ?? handleStartChat;

  const showTeamChips = feed.teams.length > 1;
  // All is cross-team even when the loaded page contains only one team's
  // activity. Keep the team and space together so each row identifies its scope.
  const showTeamOnRows = showTeamChips && feed.teamFilter === HOME_TEAM_FILTER_ALL;
  // Within one team, repeat space context only when multiple spaces are shown.
  // Names can repeat across spaces; their identities determine provenance.
  const spansSpaces = useMemo(() => {
    const events = [...feed.needs, ...feed.activity.flatMap((day) => day.events)];
    return new Set(events.map((event) => event.project.id).filter(Boolean)).size > 1;
  }, [feed.activity, feed.needs]);
  // "New space" lands in the team being looked at, else the current one.
  const newSpaceOrgId =
    feed.teamFilter === HOME_TEAM_FILTER_ALL
      ? (currentProject?.orgId ?? null)
      : feed.teamFilter === HOME_PERSONAL_TEAM_KEY
        ? null
        : feed.teamFilter;
  const visibleNeeds = needsExpanded ? feed.needs : feed.needs.slice(0, UNREAD_PREVIEW_LIMIT);
  const canExpandUnread = !needsExpanded && feed.needs.length > COMPACT_UNREAD_PREVIEW_LIMIT;
  const filteredTeam = feed.teams.find((team) => team.key === feed.teamFilter) ?? null;
  const feedLoading = activityLoading || notifications?.loading === true || supportLoading;
  const feedError = activityError || notifications?.error || supportError;
  const moreHistory = activityHasMore || Boolean(notifications?.page.nextCursor);
  const lanesEmpty = feed.needs.length === 0 && activityEvents.length === 0 && !feedLoading;
  const filteredTeamHasSpaces =
    filteredTeam !== null && homeProjects.some((project) => teamKeyForOrgId(project.orgId) === filteredTeam.key);
  const canShowMoreRecent = activityTotal > recentLimit || moreHistory;
  const handleShowMoreRecent = useCallback(() => {
    if (activityTotal > recentLimit) {
      setRecentLimit((limit) => limit + RECENT_LIMIT);
      return;
    }
    if (activityLoadingMore || notifications?.loading) return;
    void Promise.all([
      activityHasMore ? loadMoreActivity() : Promise.resolve(false),
      notifications?.page.nextCursor ? notifications.loadMore().then(() => true) : Promise.resolve(false),
    ]).then(results => { if (results.some(Boolean)) setRecentLimit(limit => limit + RECENT_LIMIT); });
  }, [activityHasMore, activityLoadingMore, activityTotal, loadMoreActivity, notifications, recentLimit, setRecentLimit]);

  const renderRow = (event: HomeFeedEvent, options: { divider: boolean }) => {
    const when = formatRelativeTimestamp(event.at);
    const where = [showTeamOnRows ? event.team.name : null, showTeamOnRows || spansSpaces ? event.project.name : null].filter(Boolean).join(" · ") || null;
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
      [scheduled, updates, statusSubtitle(event, viewerUserId), event.kind === "run_failed" || event.source.type === "notification" ? null : usablePreview(event.preview)].filter(Boolean).join(" · ") ||
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
          subtitleClassName="!line-clamp-2 !whitespace-normal @min-[40rem]/home:!line-clamp-1"
          icon={<EventIcon event={event} />}
          iconClassName={ROW_ICON_CLASS}
          onPress={() => openEvent(event)}
          density="compact"
          verticalAlign="center"
          surface="plain"
          // The wrapper owns the tint; previews can wrap in a narrow panel.
          className="min-h-14 !rounded-none !bg-transparent pointer-coarse:min-h-14"
          // One straight time column across both lanes. Narrow panels omit
          // the read-action column; opening a row still marks it read.
          reserveTrailingAction
          trailingActionClassName="w-8 justify-center transition-opacity hidden @min-[40rem]/home:flex pointer-coarse:w-11 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
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
      <div className={`${CHAT_COLUMN_CLASS_NAME} @container/home min-w-0 space-y-4`}>
        {supportError ? <div role="alert" className="flex flex-wrap items-center gap-2 px-3 text-sm text-rose-600 dark:text-rose-300">
          <span>{supportError}</span><Button variant="ghost" size="sm" onPress={() => void refreshSupport?.()} isDisabled={supportLoading}>Retry support updates</Button>
        </div> : null}
        {notifications?.error ? <div role="alert" className="flex flex-wrap items-center gap-2 px-3 text-sm text-rose-600 dark:text-rose-300">
          <span>{notifications.error}</span>
          <Button variant="ghost" size="sm" onPress={() => void notifications.refresh()} isDisabled={notifications.loading}>Retry notifications</Button>
        </div> : null}
        {showTeamChips || !titleInNavigation ? <header className="flex items-center justify-between gap-2">
          {showTeamChips ? (
            <div
              role="group"
              aria-label="Filter by team"
              data-testid="home-team-filters"
              // Scrolls on phones (many teams must not stack above the feed),
              // wraps in wide panels. The negative margins let the strip bleed to
              // the shell's edge without clipping chip focus rings.
              className="no-scrollbar -my-1 -ml-3 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 pl-3 @min-[40rem]/home:ml-0 @min-[40rem]/home:flex-wrap @min-[40rem]/home:overflow-visible @min-[40rem]/home:pl-0"
            >
              <TeamChip
                label="All teams"
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
        </header> : null}

        {activityError ? (
          <div role="alert" className={`flex flex-wrap items-center gap-2 ${LANE_INSET_CLASS}`}>
            <Text variant="caption" tone="danger">
              {activityItems.length > 0 ? "Activity couldn’t be refreshed. Loaded items are still shown." : "Activity couldn’t be loaded."}
            </Text>
            <Button variant="ghost" size="xs" onPress={() => void retryActivity()} isDisabled={activityLoading || activityLoadingMore} data-testid="home-activity-retry">
              Retry
            </Button>
          </div>
        ) : null}

        {feed.isEmpty && !feedLoading && !moreHistory && !feedError ? (
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
                <Button variant="outline" size="sm" radius="xl" className="gap-2" data-testid="home-invite-people" onPress={() => onOpenOrgSettings(newSpaceOrgId, "members")}>
                  <Group className="h-4 w-4" aria-hidden="true" />
                  Invite people
                </Button>
              ) : null}
            </div>
          </section>
        ) : filteredTeam && lanesEmpty && !feedError ? (
          // A team with nothing in it yet is an invitation, not two empty lanes.
          <section className={`space-y-2 py-4 ${LANE_INSET_CLASS}`} data-testid="home-filter-empty">
            <Text as="p" variant="body" tone="muted">
              {moreHistory ? `No activity from ${filteredTeam.name} in the loaded history.` : filteredTeamHasSpaces ? `Quiet in ${filteredTeam.name} so far.` : `No spaces in ${filteredTeam.name} yet.`}
            </Text>
            {moreHistory ? (
              <LaneMore label={activityLoadingMore || notifications?.loading ? "Loading…" : "Load older activity"} onPress={handleShowMoreRecent} disabled={activityLoadingMore || notifications?.loading} testId="home-recent-load-older" className="-mx-3" />
            ) : null}
            {!moreHistory && !filteredTeamHasSpaces && onStartNewProject ? (
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
                  label="Unread"
                  action={
                    dismissibleNeeds.length > 0 ? (
                      <Button type="button" variant="ghost" size="xs" radius="full" onPress={handleMarkAllRead}>
                        Mark all read
                      </Button>
                    ) : null
                  }
                />
                <div className="min-w-0">
                  {visibleNeeds.map((event, index) => (
                    <div key={event.key} className={!needsExpanded && index >= COMPACT_UNREAD_PREVIEW_LIMIT ? "hidden @min-[40rem]/home:block" : undefined}>
                      {renderRow(event, { divider: index > 0 })}
                    </div>
                  ))}
                </div>
                {canExpandUnread ? (
                  <LaneMore
                    label={`View all ${feed.needs.length}`}
                    className={feed.needs.length <= UNREAD_PREVIEW_LIMIT ? "@min-[40rem]/home:hidden" : undefined}
                    onPress={() => setNeedsExpanded(true)}
                    testId="home-attention-show-all"
                  />
                ) : null}
              </section>
            ) : null}

            {recentChats.length > 0 ? (
              <section data-testid="home-recent-chats">
                <LaneHeader label="Recent chats" />
                {recentChats.map((event, index) => (
                  <div key={event.key} className={[ROW_HOVER_CLASS, index > 0 ? ROW_DIVIDER_CLASS : ""].join(" ")}>
                    <FeedRow title={event.title} subtitle={`${event.team.name} · ${event.project.name}`}
                      icon={<ChatLines className="h-4 w-4" aria-hidden="true" />} iconClassName={ROW_ICON_CLASS}
                      trailingAction={event.lane === "needs" ? <Text variant="caption" tone="accent">Unread</Text> : undefined}
                      density="compact" surface="plain" verticalAlign="center"
                      className="min-h-14 !rounded-none !bg-transparent"
                      onPress={() => openEvent(event)} data-testid={`home-chat-${event.key}`} />
                  </div>
                ))}
              </section>
            ) : null}

            <section data-testid="home-recent-section">
              <LaneHeader label="Recent activity" action={feedLoading ? <span role="status" aria-label="Loading activity"><Spinner size="xs" /></span> : null} />
              {activityEvents.length === 0 && !feedLoading && !feedError ? (
                <Text as="p" variant="body" tone="muted" className={`py-2 ${LANE_INSET_CLASS}`} data-testid="home-recent-empty">
                  {moreHistory ? "No recent activity in the loaded history." : "Quiet so far."}
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
                      {cutAtDayStart ? <EarlierActivityCut /> : null}
                      {feed.activity.length > 1 ? (
                        // A sub-group label: a caption under the lane heading,
                        // and silent altogether when everything is one day.
                        <Text
                          as="p"
                          variant="caption"
                          tone="muted"
                          className={[
                            `pb-1 pt-2.5 font-medium ${LANE_INSET_CLASS}`,
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
                            {cutHere ? <EarlierActivityCut /> : null}
                            {renderRow(event, { divider: index !== dayStart && !cutHere })}
                          </Fragment>
                        );
                      })}
                    </div>
                  );
                });
              })()}
              {canShowMoreRecent ? (
                <LaneMore label={activityLoadingMore || notifications?.loading ? "Loading…" : activityEvents.length === 0 ? "Load older activity" : "Show more"} onPress={handleShowMoreRecent} disabled={activityLoadingMore || notifications?.loading} testId={activityEvents.length === 0 ? "home-recent-load-older" : "home-recent-show-more"} />
              ) : null}
            </section>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}
