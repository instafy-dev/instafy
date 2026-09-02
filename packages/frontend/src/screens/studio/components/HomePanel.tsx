import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChatLines, Clock, Group, Plus, Xmark } from "iconoir-react";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { FeedRow } from "../../../components/FeedRow";
import { Heading } from "../../../components/Heading";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  useConversations,
  type ConversationState,
} from "../../../conversations/ConversationsProvider";
import { useProjects } from "../../../projects/useProjects";
import {
  controllerClient,
  type ControllerProjectConversation,
  type NotificationInboxItem,
} from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { isUUID } from "../../../utils/uuid";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { buildHomeAttentionEntries, type HomeAttentionEntry } from "../homeAttention";
import {
  HOME_PERSONAL_TEAM_KEY,
  HOME_TEAM_FILTER_ALL,
  buildHomeFeed,
  formatRelativeTimestamp,
  getSpaceLabel,
  readHomeLastSeen,
  resolveConversationActor,
  writeHomeLastSeen,
  type HomeFeedEvent,
  type HomeFeedOrganizationRef,
  type HomeFeedRecentConversation,
} from "../homeFeed";
import { useWorkspaceControls } from "../workspaceControls";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { SettingsShell } from "./SettingsShell";
import { resolveHomeRecentConversationNavigationTarget } from "./homeRecentConversationNavigation";

// Flat rows separated by a hairline: Home is a plain panel, so a lane is a
// section with rows, never a card inside it (darkSurfaces rule 5).
const ROW_SEPARATOR_CLASS = `border-t border-slate-200/70 first:border-t-0 ${DARK_DIVIDER_BORDER_CLASS}`;
const ROW_ICON_CLASS = "h-8 w-8 rounded-full bg-transparent";
const RECENT_SPACE_FAN_OUT = 8;
const RECENT_PER_SPACE = 3;
const RECENT_LIMIT = 24;

function extractConversationTitle(conversation: ControllerProjectConversation): string {
  const metadata =
    conversation.metadata && typeof conversation.metadata === "object"
      ? (conversation.metadata as Record<string, unknown>)
      : null;
  const rawTitle = metadata?.title;
  if (typeof rawTitle === "string" && rawTitle.trim().length > 0) {
    return rawTitle.trim();
  }
  const preview = conversation.lastMessagePreview?.trim() ?? "";
  if (preview.length > 0) {
    return preview.length > 72 ? `${preview.slice(0, 71)}…` : preview;
  }
  return "Conversation";
}

function getConversationPreview(conversation: ConversationState): string | null {
  const candidate = [...conversation.messages].reverse().find((message) => message.content.trim().length > 0);
  return candidate?.content.trim() ?? null;
}

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
      data-testid={testId}
      onClick={onPress}
      className={[
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/60",
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
  return (
    <div className="flex items-center justify-between gap-3 px-1 pb-1.5">
      <Text as="h2" variant="overline" tone="subtle">
        {label}
      </Text>
      {action}
    </div>
  );
}

function EventIcon({ event }: { event: HomeFeedEvent }) {
  if (event.actor?.handle) {
    return (
      <ChatMessageAvatar
        kind="assistant"
        agent={{ handle: event.actor.handle, avatarSeed: event.actor.avatarSeed }}
        size="xs"
      />
    );
  }
  if (event.kind === "running") {
    return <Spinner size="xs" />;
  }
  if (event.kind === "queued") {
    return <Clock className="h-4 w-4 text-amber-600 dark:text-amber-300" aria-hidden="true" />;
  }
  if (event.kind === "reply") {
    return <span className="block h-2 w-2 rounded-full bg-rose-500 dark:bg-rose-300" aria-hidden="true" />;
  }
  return <ChatLines className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />;
}

function statusSubtitle(event: HomeFeedEvent): string | null {
  if (event.kind === "running") {
    return "Run in progress";
  }
  if (event.kind === "queued") {
    return "Waiting for a runtime";
  }
  return null;
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
  const { userEmail, onStartNewProject, onOpenOrgSettings } = useWorkspaceControls();
  const navigate = useNavigate();
  const [recentConversations, setRecentConversations] = useState<HomeFeedRecentConversation[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [locallyDismissedKeys, setLocallyDismissedKeys] = useState<string[]>([]);
  const [teamFilter, setTeamFilter] = useState(HOME_TEAM_FILTER_ALL);
  // The cut is where the previous visit ended; this visit becomes the next cut.
  const [lastSeenAt] = useState(() => readHomeLastSeen(userEmail));
  useEffect(() => {
    writeHomeLastSeen(userEmail, Date.now());
  }, [userEmail]);

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
          setOrganizations(orgs.map((org) => ({ id: org.id, name: org.name })));
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

  // The active space's conversations are already in memory; every other space
  // is fetched (a bounded fan-out — Phase 2 replaces this with a user-level
  // activity feed so nothing depends on which spaces this device has opened).
  const localRecentConversations = useMemo<HomeFeedRecentConversation[]>(() => {
    if (!activeProjectId || !currentProject) {
      return [];
    }
    return conversations
      .filter((conversation) => conversation.lifecycleStatus === "active")
      .map((conversation) => ({
        projectId: activeProjectId,
        projectName: getSpaceLabel(currentProject.name),
        orgId: currentProject.orgId,
        orgName: currentProject.orgName || "",
        conversationId: conversation.controllerId ?? null,
        localConversationId: conversation.localId,
        title: conversation.title || "Conversation",
        preview: usablePreview(getConversationPreview(conversation)),
        updatedAt: new Date(conversation.messages.at(-1)?.timestamp ?? conversation.createdAt).toISOString(),
        actor: resolveConversationActor(conversation),
      }));
  }, [activeProjectId, conversations, currentProject]);

  useEffect(() => {
    if (projectList.length === 0) {
      setRecentConversations([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setRecentLoading(true);
      try {
        const prioritized = [...projectList].sort((a, b) => {
          if (a.id === activeProjectId) return -1;
          if (b.id === activeProjectId) return 1;
          return getSpaceLabel(a.name).localeCompare(getSpaceLabel(b.name));
        });
        const perSpace = await Promise.all(
          prioritized.slice(0, RECENT_SPACE_FAN_OUT).map(async (project) => {
            const rows =
              (await controllerClient.conversations.listForProject({
                projectId: project.id,
                rootsOnly: true,
                limit: RECENT_PER_SPACE,
              })) ?? [];
            return rows.map<HomeFeedRecentConversation>((conversation) => ({
              projectId: project.id,
              projectName: getSpaceLabel(project.name),
              orgId: project.orgId,
              orgName: project.orgName,
              conversationId: conversation.id,
              localConversationId: null,
              title: extractConversationTitle(conversation),
              preview: usablePreview(conversation.lastMessagePreview),
              updatedAt: conversation.updatedAt || conversation.lastMessageAt || conversation.createdAt,
            }));
          }),
        );
        const seen = new Set<string>();
        const merged = [...perSpace.flat(), ...localRecentConversations].filter((entry) => {
          const key = entry.conversationId?.trim().toLowerCase() || `${entry.projectId}:${entry.localConversationId ?? entry.title}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!cancelled) {
          setRecentConversations(merged.slice(0, RECENT_LIMIT * 2));
        }
      } finally {
        if (!cancelled) {
          setRecentLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, localRecentConversations, projectList]);

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
        recentConversations,
        organizations,
        projects: projectList,
        activeProject: currentProject,
        conversations,
        teamFilter,
        lastSeenAt,
      }),
    [conversations, currentProject, lastSeenAt, organizations, projectList, recentConversations, teamFilter, visibleAttentionEntries],
  );
  const activityEvents = useMemo(() => feed.activity.flatMap((day) => day.events).slice(0, RECENT_LIMIT), [feed.activity]);

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
        if (projectId === activeProjectId) {
          const local = conversations.find((conversation) => (conversation.controllerId ?? "").trim() === conversationId);
          if (local) {
            openConversationTab(local.localId);
            return;
          }
        }
        navigate(buildRouteToConversation(projectId, conversationId));
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
    [acknowledgeInbox, activeProjectId, conversations, navigate, openConversationTab, refreshInbox, requestUrlPush],
  );

  const dismissEvent = useCallback(
    async (event: HomeFeedEvent): Promise<boolean> => {
      if (event.source.type === "recent") return false;
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

  const showTeamChips = feed.teams.length > 1;
  const showTeamOnRows = feed.teams.length > 1;
  // "New space" lands in the team being looked at, else the current one.
  const newSpaceOrgId =
    feed.teamFilter !== HOME_TEAM_FILTER_ALL && feed.teamFilter !== HOME_PERSONAL_TEAM_KEY
      ? feed.teamFilter
      : (currentProject?.orgId ?? null);

  const renderRow = (event: HomeFeedEvent, options: { lane: "needs" | "activity" }) => {
    const when = formatRelativeTimestamp(event.at);
    const subtitleText = statusSubtitle(event) ?? usablePreview(event.preview);
    const where = showTeamOnRows ? event.team.name : event.project.name;
    return (
      <div key={event.key} className={ROW_SEPARATOR_CLASS}>
        <FeedRow
          title={event.title}
          subtitle={
            // Narrow screens have no room for a trailing cluster: where and
            // when drop to a second line under the preview instead.
            <>
              {subtitleText ? <span className="block truncate">{subtitleText}</span> : null}
              <span className="block truncate sm:hidden">{when ? `${where} · ${when}` : where}</span>
            </>
          }
          icon={<EventIcon event={event} />}
          iconClassName={ROW_ICON_CLASS}
          end={
            // One trailing cluster, vertically centred with the row: where it
            // happened, then when. The time column is fixed so rows line up.
            <span className="hidden shrink-0 items-center gap-2 sm:flex">
              {showTeamOnRows ? (
                <Badge size="xs" tone="neutral" className="max-w-[10rem] truncate" title={`${event.project.name} · ${event.team.name}`}>
                  {event.team.name}
                </Badge>
              ) : (
                <Text as="span" variant="caption" tone="subtle" className="max-w-[12rem] truncate">
                  {event.project.name}
                </Text>
              )}
              {when ? (
                <Text as="span" variant="caption" tone="muted" className="min-w-[2.5rem] text-right tabular-nums">
                  {when}
                </Text>
              ) : null}
            </span>
          }
          onPress={() => openEvent(event)}
          density="compact"
          verticalAlign="center"
          surface="interactive"
          className="rounded-none px-2"
          reserveTrailingAction={options.lane === "needs"}
          trailingActionClassName="items-center pr-1"
          trailingAction={
            event.dismissible ? (
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                radius="full"
                aria-label={`Mark ${event.title} as read`}
                data-testid={`${event.testId}-dismiss`}
                onPress={() => void dismissEvent(event)}
                className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              >
                <Xmark className="h-4 w-4" aria-hidden="true" />
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
      <div className="min-w-0 space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="home-team-filters">
            {showTeamChips ? (
              <>
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
              </>
            ) : (
              <Heading level={2} variant="subtitle">
                Home
              </Heading>
            )}
          </div>
          {onStartNewProject ? (
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="New space"
              data-testid="home-new-space"
              onPress={() => onStartNewProject(newSpaceOrgId)}
              className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </header>

        {feed.isEmpty && !recentLoading ? (
          <section className="space-y-3" data-testid="home-empty">
            <Heading level={2} variant="subtitle">
              Nothing here yet
            </Heading>
            <Text as="p" variant="body" tone="muted" className="max-w-prose">
              Replies, runs and changes from every space you belong to show up here.
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" radius="xl" className="gap-2" onPress={handleStartChat} data-testid="home-start-first-chat">
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
        ) : (
          <>
            <section data-testid="home-attention-section">
              <LaneHeader
                label={feed.needs.length > 0 ? `Needs you · ${feed.needs.length}` : "Needs you"}
                action={
                  dismissibleNeeds.length > 0 ? (
                    <Button type="button" variant="ghost" size="xs" radius="full" onPress={handleMarkAllRead}>
                      Mark all read
                    </Button>
                  ) : null
                }
              />
              {feed.needs.length === 0 ? (
                <Text as="p" variant="caption" tone="muted" className="px-2 py-1.5" data-testid="home-attention-empty">
                  Nothing needs you right now.
                </Text>
              ) : (
                <div className="min-w-0">{feed.needs.map((event) => renderRow(event, { lane: "needs" }))}</div>
              )}
            </section>

            <section data-testid="home-recent-section">
              <LaneHeader label="Activity" action={recentLoading ? <Spinner size="xs" /> : null} />
              {activityEvents.length === 0 && !recentLoading ? (
                <Text as="p" variant="caption" tone="muted" className="px-2 py-1.5" data-testid="home-recent-empty">
                  Quiet so far.
                </Text>
              ) : null}
              {(() => {
                let flatIndex = 0;
                return feed.activity.map((day) => (
                  <div key={day.key} className="min-w-0">
                    <Text as="p" variant="overline" tone="subtle" className="px-2 pb-1 pt-3">
                      {day.label}
                    </Text>
                    <div className="min-w-0">
                      {day.events.map((event) => {
                        const index = flatIndex;
                        flatIndex += 1;
                        if (index >= RECENT_LIMIT) return null;
                        return (
                          <div key={event.key}>
                            {feed.sinceCutIndex === index ? (
                              <div className="flex items-center gap-3 px-2 py-1.5" data-testid="home-since-cut" aria-hidden="true">
                                <span className="h-px flex-1 bg-primary-400/40" />
                                <Text as="span" variant="overline" tone="accent">
                                  You're caught up
                                </Text>
                                <span className="h-px flex-1 bg-primary-400/40" />
                              </div>
                            ) : null}
                            {renderRow(event, { lane: "activity" })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ));
              })()}
            </section>
          </>
        )}
      </div>
    </SettingsShell>
  );
}
