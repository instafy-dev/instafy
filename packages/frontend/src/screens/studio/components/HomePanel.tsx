import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  ChatLines,
  Clock,
  NavArrowRight,
  Sparks,
  Xmark,
} from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { FeedRow } from "../../../components/FeedRow";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  useConversations,
  type ConversationState,
} from "../../../conversations/ConversationsProvider";
import { getOrgDisplayName } from "../../../org/orgNaming";
import { useProjects } from "../../../projects/useProjects";
import {
  controllerClient,
  type ControllerAutomation,
  type ControllerProjectConversation,
  type NotificationInboxItem,
} from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { isUUID } from "../../../utils/uuid";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { buildHomeAttentionEntries, type HomeAttentionEntry } from "../homeAttention";
import { HOME_STARTERS, type PromptOnboardingAction } from "./onboardingPlaybook";
import { SettingsShell } from "./SettingsShell";
import {
  StudioListGroupHeader,
  StudioListRow,
  StudioListSection,
  StudioListSurface,
} from "./StudioListSection";
import { resolveHomeRecentConversationNavigationTarget } from "./homeRecentConversationNavigation";

const HOME_SUGGESTIONS = HOME_STARTERS.slice(0, 4);
const HOME_ROW_CLASS_NAME =
  "rounded-none border-0 px-3 py-3 hover:bg-slate-50 dark:hover:bg-slate-900/45";
// One icon shell for every Home row; status/tone comes from the icon color,
// not from per-row shell sizes or tinted backgrounds.
const HOME_ROW_ICON_CLASS_NAME =
  "h-8 w-8 rounded-lg bg-transparent text-slate-400 dark:text-slate-500";
const HOME_SUGGESTION_ICON_CLASS_NAME =
  "h-8 w-8 rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300";

function formatCountSummary(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function formatRelativeTimestamp(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const timestamp = new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatNextAutomationLabel(automation: ControllerAutomation | null): string | null {
  if (!automation) {
    return null;
  }
  const source = automation.nextRunAt ?? automation.runAt ?? null;
  if (!source) {
    return null;
  }
  try {
    const date = new Date(source);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return null;
  }
}

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

function getSpaceLabel(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Untitled Space";
}

function getProjectGroupLabel(projectName: string | null | undefined, orgName: string | null | undefined): string {
  const normalizedProjectName = getSpaceLabel(projectName);
  const orgLabel = getOrgDisplayName(orgName ?? null);
  return [normalizedProjectName, orgLabel].filter(Boolean).join(" · ");
}

function getConversationPreview(conversation: ConversationState): string | null {
  const candidate = [...conversation.messages]
    .reverse()
    .find((message) => message.content.trim().length > 0);
  return candidate?.content.trim() ?? null;
}

function findConversationByAnyId(conversations: ConversationState[], id: string): ConversationState | null {
  return conversations.find((conversation) => conversation.localId === id || conversation.controllerId === id) ?? null;
}

function buildConversationPathLabel(
  conversation: ConversationState,
  conversations: ConversationState[],
): string | null {
  const labels: string[] = [];
  const seenIds = new Set<string>([conversation.localId]);
  let parentId = conversation.parentConversationId?.trim() ?? "";

  while (parentId && !seenIds.has(parentId)) {
    seenIds.add(parentId);
    const parent = findConversationByAnyId(conversations, parentId);
    if (!parent) {
      break;
    }
    labels.unshift(parent.title || "Conversation");
    parentId = parent.parentConversationId?.trim() ?? "";
  }

  return labels.length > 0 ? labels.join(" / ") : null;
}

function getHomeRowPreview(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return /^\d{1,3}$/.test(trimmed) ? null : trimmed;
}

interface HomeRecentConversation {
  projectId: string;
  projectName: string;
  orgName: string;
  conversationId: string | null;
  localConversationId: string | null;
  title: string;
  preview: string | null;
  threadPath: string | null;
  updatedAt: string;
}

interface HomeRecentConversationGroup {
  key: string;
  label: string;
  entries: HomeRecentConversation[];
}

interface HomeAttentionItem {
  key: string;
  title: string;
  subtitle: string;
  groupLabel: string;
  meta: string | null;
  preview: string | null;
  kind: "running" | "queued" | "reply";
  onPress: () => void;
  onDismiss?: () => void;
  testId: string;
}

interface HomeAttentionItemGroup {
  key: string;
  label: string;
  entries: HomeAttentionItem[];
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
    setConversationDraft,
  } = useConversations();
  const { showStatus } = useStatus();
  const { requestUrlPush, openConversationTab } = useWorkspaceTabs();
  const navigate = useNavigate();
  const [automations, setAutomations] = useState<ControllerAutomation[]>([]);
  const [recentConversations, setRecentConversations] = useState<HomeRecentConversation[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [pendingStarterConversationId, setPendingStarterConversationId] = useState<string | null>(null);
  const [locallyDismissedAttentionKeys, setLocallyDismissedAttentionKeys] = useState<string[]>([]);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<string[]>([]);

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

  useEffect(() => {
    if (!activeProjectId) {
      setAutomations([]);
      return;
    }
    let cancelled = false;
    controllerClient.automations.listForProject({ projectId: activeProjectId })
      .then((items) => {
        if (!cancelled) {
          setAutomations(items ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAutomations([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const localRecentConversations = useMemo<HomeRecentConversation[]>(() => {
    if (!activeProjectId || !currentProject) {
      return [];
    }
    return [...conversations]
      .sort((a, b) => {
        const aTimestamp = a.messages.at(-1)?.timestamp ?? a.createdAt;
        const bTimestamp = b.messages.at(-1)?.timestamp ?? b.createdAt;
        return bTimestamp - aTimestamp;
      })
      .slice(0, 5)
      .map((conversation) => ({
        projectId: activeProjectId,
        projectName: getSpaceLabel(currentProject.name),
        orgName: currentProject.orgName || "",
        conversationId: conversation.controllerId ?? null,
        localConversationId: conversation.localId,
        title: conversation.title || "Conversation",
        preview: getHomeRowPreview(getConversationPreview(conversation)),
        threadPath: buildConversationPathLabel(conversation, conversations),
        updatedAt: new Date(conversation.messages.at(-1)?.timestamp ?? conversation.createdAt).toISOString(),
      }));
  }, [activeProjectId, conversations, currentProject]);

  useEffect(() => {
    if (projectList.length === 0) {
      setRecentConversations([]);
      return;
    }
    let cancelled = false;
    const loadRecentConversations = async () => {
      setRecentLoading(true);
      try {
        const prioritizedProjects = [...projectList].sort((a, b) => {
          if (a.id === activeProjectId) {
            return -1;
          }
          if (b.id === activeProjectId) {
            return 1;
          }
          return getSpaceLabel(a.name).localeCompare(getSpaceLabel(b.name));
        });
        const perProject = await Promise.all(
          prioritizedProjects.slice(0, 8).map(async (project) => {
            const conversationsForProject =
              (await controllerClient.conversations.listForProject({
                projectId: project.id,
                rootsOnly: true,
                limit: 3,
              })) ?? [];
            return conversationsForProject.map((conversation) => ({
              projectId: project.id,
              projectName: getSpaceLabel(project.name),
              orgName: project.orgName,
              conversationId: conversation.id,
              localConversationId: null,
              title: extractConversationTitle(conversation),
              preview: getHomeRowPreview(conversation.lastMessagePreview?.trim() || null),
              threadPath: null,
              updatedAt:
                conversation.updatedAt || conversation.lastMessageAt || conversation.createdAt,
            }));
          }),
        );
        const merged = [...perProject.flat(), ...localRecentConversations]
          .filter((entry, index, entries) => {
            const dedupeKey =
              entry.conversationId?.trim() ||
              `${entry.projectId}:${entry.localConversationId?.trim() || entry.title}`;
            return (
              entries.findIndex((candidate) => {
                const candidateKey =
                  candidate.conversationId?.trim() ||
                  `${candidate.projectId}:${candidate.localConversationId?.trim() || candidate.title}`;
                return candidateKey === dedupeKey;
              }) === index
            );
          })
          .sort((a, b) => {
            const aTime = Date.parse(a.updatedAt);
            const bTime = Date.parse(b.updatedAt);
            return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
          })
          .slice(0, 8);
        if (!cancelled) {
          setRecentConversations(merged);
        }
      } finally {
        if (!cancelled) {
          setRecentLoading(false);
        }
      }
    };
    void loadRecentConversations();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, localRecentConversations, projectList]);

  const nextAutomation = useMemo(() => {
    return [...automations]
      .filter((entry) => entry.status === "active")
      .sort((a, b) => (a.nextRunAt ?? a.runAt ?? "").localeCompare(b.nextRunAt ?? b.runAt ?? ""))[0] ?? null;
  }, [automations]);

  const latestInboxItem = sharedInboxItems[0] ?? null;

  const handleOpenInboxItem = useCallback(
    (item: NotificationInboxItem) => {
      const projectId = item.projectId.trim();
      const conversationId = item.conversationId.trim();
      if (!projectId || !conversationId) {
        return;
      }
      requestUrlPush();
      if (projectId === activeProjectId) {
        const localMatch =
          conversations.find(
            (conversation) => (conversation.controllerId ?? "").trim() === conversationId,
          ) ?? null;
        if (localMatch) {
          openConversationTab(localMatch.localId);
          void controllerClient.notifications
            .acknowledgeInboxItem({ conversationId })
            .then((result) => {
            if (!result.success) {
              showStatus(result.error ?? "Unable to acknowledge inbox item.", "error", 4000);
              return;
            }
            void refreshInbox?.({ force: true });
          });
          return;
        }
      }
      void controllerClient.notifications
        .acknowledgeInboxItem({ conversationId })
        .then((result) => {
        if (!result.success) {
          showStatus(result.error ?? "Unable to acknowledge inbox item.", "error", 4000);
          return;
        }
        void refreshInbox?.({ force: true });
      });
      try {
        const url = new URL(window.location.href);
        url.pathname = "/studio";
        url.searchParams.set("projectId", projectId);
        url.searchParams.set("conversationControllerId", conversationId);
        url.searchParams.delete("conversationId");
        url.searchParams.set("panel", "chat");
        const search = url.searchParams.toString();
        navigate(`${url.pathname}${search ? `?${search}` : ""}`);
      } catch {
        navigate(
          `/studio?projectId=${encodeURIComponent(projectId)}&conversationControllerId=${encodeURIComponent(conversationId)}&panel=chat`,
        );
      }
    },
    [activeProjectId, conversations, navigate, openConversationTab, refreshInbox, requestUrlPush, showStatus],
  );

  const handleOpenConversation = useCallback(
    (entry: HomeRecentConversation) => {
      const navigationTarget = resolveHomeRecentConversationNavigationTarget({
        activeProjectId,
        conversations,
        entry,
      });

      requestUrlPush();
      if (navigationTarget.kind === "local") {
        openConversationTab(navigationTarget.localConversationId);
        return;
      }
      try {
        const url = new URL(window.location.href);
        url.pathname = "/studio";
        url.searchParams.set("projectId", navigationTarget.projectId);
        if (navigationTarget.conversationControllerId) {
          url.searchParams.set("conversationControllerId", navigationTarget.conversationControllerId);
        } else {
          url.searchParams.delete("conversationControllerId");
        }
        url.searchParams.delete("conversationId");
        url.searchParams.set("panel", "chat");
        const search = url.searchParams.toString();
        navigate(`${url.pathname}${search ? `?${search}` : ""}`);
      } catch {
        navigate(
          `/studio?projectId=${encodeURIComponent(navigationTarget.projectId)}${
            navigationTarget.conversationControllerId
              ? `&conversationControllerId=${encodeURIComponent(navigationTarget.conversationControllerId)}`
              : ""
          }&panel=chat`,
        );
      }
    },
    [activeProjectId, conversations, navigate, openConversationTab, requestUrlPush],
  );

  const handleOpenLocalConversation = useCallback(
    (conversationId: string) => {
      requestUrlPush();
      openConversationTab(conversationId);
    },
    [openConversationTab, requestUrlPush],
  );

  const handleDismissAttentionItem = useCallback(
    (entry: HomeAttentionEntry) => {
      setLocallyDismissedAttentionKeys((current) =>
        current.includes(entry.key) ? current : [...current, entry.key],
      );
      if (entry.source === "conversation") {
        markConversationRead(entry.localConversationId);
        return;
      }
      const conversationId = entry.inboxItem.conversationId.trim();
      if (!conversationId) {
        return;
      }
      void controllerClient.notifications
        .acknowledgeInboxItem({ conversationId })
        .then((result) => {
        if (!result.success) {
          setLocallyDismissedAttentionKeys((current) => current.filter((key) => key !== entry.key));
          showStatus(result.error ?? "Unable to clear attention item.", "error", 4000);
          return;
        }
        void refreshInbox?.({ force: true });
      });
    },
    [markConversationRead, refreshInbox, showStatus],
  );

  const clearAttentionEntry = useCallback(
    async (entry: HomeAttentionEntry): Promise<boolean> => {
      setLocallyDismissedAttentionKeys((current) =>
        current.includes(entry.key) ? current : [...current, entry.key],
      );
      if (entry.source === "conversation") {
        markConversationRead(entry.localConversationId);
        return true;
      }
      const conversationId = entry.inboxItem.conversationId.trim();
      if (!conversationId) {
        return true;
      }
      const result = await controllerClient.notifications.acknowledgeInboxItem({
        conversationId,
      });
      if (!result.success) {
        setLocallyDismissedAttentionKeys((current) => current.filter((key) => key !== entry.key));
        showStatus(result.error ?? "Unable to clear attention item.", "error", 4000);
        return false;
      }
      return true;
    },
    [markConversationRead, showStatus],
  );

  const handleStartStarterConversation = useCallback(
    (starter: PromptOnboardingAction) => {
      const conversation = createConversation({
        title: starter.title,
        select: true,
      });
      markConversationRead(conversation.localId);
      setConversationDraft(conversation.localId, starter.prompt);
      setPendingStarterConversationId(conversation.localId);
      requestUrlPush();
      openConversationTab(conversation.localId, { fallbackConversation: conversation });
      if (activeProjectId && isUUID(activeProjectId)) {
        void controllerClient.conversations.createBlank({
          projectId: activeProjectId,
          metadata: { title: starter.title, localId: conversation.localId },
        }).then((response) => {
          if (!response?.conversationId) {
            return;
          }
          setConversationControllerId(conversation.localId, response.conversationId);
        });
      }
    },
    [
      activeProjectId,
      createConversation,
      markConversationRead,
      openConversationTab,
      requestUrlPush,
      setConversationControllerId,
      setConversationDraft,
    ],
  );

  // Start a fresh, empty chat — for a new user this lands on the guided
  // getting-started card (it shows on an empty conversation).
  const handleStartBlankChat = useCallback(() => {
    const conversation = createConversation({ title: "New chat", select: true });
    markConversationRead(conversation.localId);
    requestUrlPush();
    openConversationTab(conversation.localId, { fallbackConversation: conversation });
    if (activeProjectId && isUUID(activeProjectId)) {
      void controllerClient.conversations
        .createBlank({
          projectId: activeProjectId,
          metadata: { title: "New chat", localId: conversation.localId },
        })
        .then((response) => {
          if (response?.conversationId) {
            setConversationControllerId(conversation.localId, response.conversationId);
          }
        });
    }
  }, [
    activeProjectId,
    createConversation,
    markConversationRead,
    openConversationTab,
    requestUrlPush,
    setConversationControllerId,
  ]);

  useEffect(() => {
    if (!pendingStarterConversationId) {
      return;
    }
    const match =
      conversations.find((conversation) => conversation.localId === pendingStarterConversationId) ?? null;
    if (!match || match.lifecycleStatus === "deleted") {
      return;
    }
    setPendingStarterConversationId(null);
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        document.getElementById("studio-chat-input")?.focus();
      });
    }
  }, [conversations, pendingStarterConversationId]);

  const attentionEntries = useMemo(
    () =>
      buildHomeAttentionEntries({
        conversations,
        inboxItems: sharedInboxItems,
        currentSpaceName,
      }),
    [conversations, currentSpaceName, sharedInboxItems],
  );
  useEffect(() => {
    setLocallyDismissedAttentionKeys((current) => {
      if (current.length === 0) {
        return current;
      }
      const availableKeys = new Set(attentionEntries.map((entry) => entry.key));
      const next = current.filter((key) => availableKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [attentionEntries]);
  const visibleAttentionEntries = useMemo(
    () => attentionEntries.filter((entry) => !locallyDismissedAttentionKeys.includes(entry.key)),
    [attentionEntries, locallyDismissedAttentionKeys],
  );
  const recentConversationGroups = useMemo<HomeRecentConversationGroup[]>(() => {
    const groups: HomeRecentConversationGroup[] = [];
    const groupByKey = new Map<string, HomeRecentConversationGroup>();

    recentConversations.forEach((entry) => {
      const key = `${entry.projectId}:${entry.orgName || ""}`;
      let group = groupByKey.get(key);
      if (!group) {
        group = {
          key,
          label: getProjectGroupLabel(entry.projectName, entry.orgName),
          entries: [],
        };
        groupByKey.set(key, group);
        groups.push(group);
      }
      group.entries.push(entry);
    });

    return groups;
  }, [recentConversations]);

  const attentionItems = useMemo<HomeAttentionItem[]>(
    () =>
      visibleAttentionEntries.map((entry: HomeAttentionEntry) => ({
        key: entry.key,
        title: entry.title,
        subtitle:
          entry.kind === "running"
            ? "Run in progress"
            : entry.kind === "queued"
              ? "Waiting for a runtime"
              : "",
        groupLabel:
          entry.source === "inbox"
            ? getProjectGroupLabel(entry.inboxItem.projectName, entry.inboxItem.orgName)
            : getProjectGroupLabel(currentSpaceName, currentProject?.orgName ?? null),
        meta: entry.meta,
        preview: getHomeRowPreview(entry.preview),
        kind: entry.kind,
        testId: entry.testId,
        onPress:
          entry.source === "conversation"
            ? () => handleOpenLocalConversation(entry.localConversationId)
            : () => handleOpenInboxItem(entry.inboxItem),
        onDismiss: entry.kind === "reply" ? () => handleDismissAttentionItem(entry) : undefined,
      })),
    [
      currentProject?.orgName,
      currentSpaceName,
      handleDismissAttentionItem,
      handleOpenInboxItem,
      handleOpenLocalConversation,
      visibleAttentionEntries,
    ],
  );
  const attentionItemGroups = useMemo<HomeAttentionItemGroup[]>(() => {
    const groups: HomeAttentionItemGroup[] = [];
    const groupByKey = new Map<string, HomeAttentionItemGroup>();

    attentionItems.forEach((entry) => {
      const key = entry.groupLabel;
      let group = groupByKey.get(key);
      if (!group) {
        group = {
          key,
          label: entry.groupLabel,
          entries: [],
        };
        groupByKey.set(key, group);
        groups.push(group);
      }
      group.entries.push(entry);
    });

    return groups;
  }, [attentionItems]);
  const dismissibleAttentionEntries = useMemo(
    () => visibleAttentionEntries.filter((entry) => entry.kind === "reply"),
    [visibleAttentionEntries],
  );
  const handleClearAllAttention = useCallback(() => {
    void (async () => {
      const results = await Promise.all(dismissibleAttentionEntries.map((entry) => clearAttentionEntry(entry)));
      if (results.some(Boolean)) {
        await refreshInbox?.({ force: true });
      }
    })();
  }, [clearAttentionEntry, dismissibleAttentionEntries, refreshInbox]);
  const handleToggleGroup = useCallback((key: string) => {
    setCollapsedGroupKeys((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  }, []);

  return (
    <SettingsShell
      title="Home"
      hideTitle
      testId="home-panel"
    >
      <div className="min-w-0 space-y-4 overflow-x-hidden">
        {nextAutomation ? (
          <section className="space-y-1" data-testid="home-automation-summary">
            <Text variant="caption" tone="muted">
              Next automation: {nextAutomation.name} · {formatNextAutomationLabel(nextAutomation) ?? "scheduled soon"}
            </Text>
          </section>
        ) : null}

        <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] xl:items-start">
          <StudioListSection
            title="Needs attention"
            description={formatCountSummary(attentionItems.length, "item requiring review", "items requiring review")}
            tone="attention"
            icon={<Bell className="h-5 w-5" aria-hidden={true} />}
            className="xl:col-start-1 xl:row-start-1"
            data-testid="home-attention-section"
            actions={
              dismissibleAttentionEntries.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  radius="full"
                  onPress={handleClearAllAttention}
                >
                  Clear all
                </Button>
              ) : null
            }
          >
            <div className="min-w-0 space-y-3">
              {attentionItems.length === 0 ? (
                <Text variant="caption" tone="muted" data-testid="home-attention-empty">
                  Nothing is waiting right now.
                </Text>
              ) : null}
              {attentionItemGroups.map((group) => {
                const groupKey = `attention:${group.key}`;
                const isCollapsed = collapsedGroupKeys.includes(groupKey);
                return (
                  <StudioListSurface key={group.key}>
                    <StudioListGroupHeader
                      label={group.label}
                      count={group.entries.length}
                      collapsed={isCollapsed}
                      onPress={() => handleToggleGroup(groupKey)}
                      testId="home-attention-group-toggle"
                    />
                    {!isCollapsed ? (
                      <div className="min-w-0">
                        {group.entries.map((item) => {
                          const iconClassName =
                            item.kind === "running"
                              ? "text-emerald-600 dark:text-emerald-300"
                              : item.kind === "queued"
                                ? "text-amber-600 dark:text-amber-300"
                                : "text-rose-500 dark:text-rose-300";
                          const inlineIcon =
                            item.kind === "running" ? (
                              <Spinner size="xs" />
                            ) : item.kind === "queued" ? (
                              <Clock className={["h-4 w-4", iconClassName].join(" ")} aria-hidden="true" />
                            ) : (
                              <span className="block h-2 w-2 rounded-full bg-current" aria-hidden={true} />
                            );
                          return (
                            <StudioListRow key={item.key}>
                              <FeedRow
                                title={item.title}
                                meta={item.meta}
                                metaPlacement="end"
                                subtitle={item.subtitle || undefined}
                                preview={item.preview}
                                icon={inlineIcon}
                                iconClassName={[HOME_ROW_ICON_CLASS_NAME, iconClassName].join(" ")}
                                onPress={item.onPress}
                                density="compact"
                                verticalAlign="center"
                                surface="plain"
                                className={HOME_ROW_CLASS_NAME}
                                titleEndClassName="pt-0.5"
                                trailingActionClassName="items-center pr-2"
                                trailingAction={
                                  item.onDismiss ? (
                                    <IconButton
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      radius="full"
                                      aria-label={`Dismiss ${item.title}`}
                                      data-testid={`${item.testId}-dismiss`}
                                      onPress={item.onDismiss}
                                      className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                                    >
                                      <Xmark className="h-4 w-4" aria-hidden="true" />
                                    </IconButton>
                                  ) : null
                                }
                                reserveTrailingAction
                                data-testid={item.testId}
                              />
                            </StudioListRow>
                          );
                        })}
                      </div>
                    ) : null}
                  </StudioListSurface>
                );
              })}
            </div>
          </StudioListSection>

          <StudioListSection
            title="Recently active"
            description={formatCountSummary(recentConversations.length, "recent conversation", "recent conversations")}
            tone="activity"
            icon={<ChatLines className="h-5 w-5" aria-hidden={true} />}
            className="xl:col-start-2 xl:row-span-2 xl:min-h-0"
            data-testid="home-recent-section"
          >
            <div
              className="min-w-0 space-y-3 overflow-x-hidden xl:max-h-[min(44rem,calc(100vh-14rem))] xl:overflow-y-auto xl:overscroll-contain xl:pr-2"
              data-testid="home-recent-list"
            >
              {recentLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300">
                  <Spinner size="xs" />
                  Loading recent chats…
                </div>
              ) : null}
              {!recentLoading && recentConversations.length === 0 ? (
                <div className="space-y-2" data-testid="home-recent-empty">
                  <Text variant="caption" tone="muted">
                    No recent chats yet.
                  </Text>
                  <Button
                    variant="outline"
                    size="sm"
                    radius="xl"
                    className="gap-2"
                    onPress={handleStartBlankChat}
                    data-testid="home-start-first-chat"
                  >
                    <ChatLines className="h-4 w-4" aria-hidden="true" />
                    Start your first chat
                  </Button>
                </div>
              ) : null}
              {recentConversationGroups.map((group) => {
                const groupKey = `recent:${group.key}`;
                const isCollapsed = collapsedGroupKeys.includes(groupKey);
                return (
                  <StudioListSurface key={group.key} data-testid={`home-recent-group-${group.key}`}>
                    <StudioListGroupHeader
                      label={group.label}
                      count={group.entries.length}
                      collapsed={isCollapsed}
                      onPress={() => handleToggleGroup(groupKey)}
                      testId="home-recent-group-toggle"
                    />
                    {!isCollapsed ? (
                      <div className="min-w-0">
                        {group.entries.map((entry, index) => {
                          const itemId = entry.conversationId ?? entry.localConversationId ?? `${index}`;
                          return (
                            <StudioListRow key={`${entry.projectId}:${itemId}`}>
                              <FeedRow
                                title={entry.title}
                                meta={formatRelativeTimestamp(entry.updatedAt)}
                                metaPlacement="end"
                                subtitle={entry.threadPath ? `In ${entry.threadPath}` : undefined}
                                preview={entry.preview}
                                icon={<ChatLines className="h-4 w-4" aria-hidden={true} />}
                                iconClassName={HOME_ROW_ICON_CLASS_NAME}
                                onPress={() => handleOpenConversation(entry)}
                                density="compact"
                                verticalAlign="center"
                                surface="plain"
                                className={HOME_ROW_CLASS_NAME}
                                titleEndClassName="pt-0.5"
                                data-testid={`home-recent-item-${itemId}`}
                              />
                            </StudioListRow>
                          );
                        })}
                      </div>
                    ) : null}
                  </StudioListSurface>
                );
              })}
            </div>
          </StudioListSection>

          <StudioListSection
            title="Suggestions"
            description="Quick ways to open a focused chat."
            tone="suggestion"
            icon={<Sparks className="h-5 w-5" aria-hidden={true} />}
            className="xl:col-start-1 xl:row-start-2"
            data-testid="home-suggestions-section"
          >
            <StudioListSurface data-testid="home-suggestions-list">
              {HOME_SUGGESTIONS.map((starter, index) => {
                const Icon = starter.icon;
                return (
                  <StudioListRow key={starter.id} separated={index > 0}>
                    <FeedRow
                      title={starter.title}
                      subtitle={starter.description}
                      icon={<Icon className="h-[18px] w-[18px]" aria-hidden={true} />}
                      iconClassName={HOME_SUGGESTION_ICON_CLASS_NAME}
                      end={<NavArrowRight className="h-5 w-5" aria-hidden={true} />}
                      endClassName="text-slate-400 dark:text-slate-500"
                      density="compact"
                      verticalAlign="center"
                      surface="plain"
                      className={HOME_ROW_CLASS_NAME}
                      onPress={() => handleStartStarterConversation(starter)}
                      data-testid={`home-starter-${starter.id}`}
                    />
                  </StudioListRow>
                );
              })}
            </StudioListSurface>
            {latestInboxItem && attentionItems.length === 0 ? (
              <Button
                variant="ghost"
                size="sm"
                radius="xl"
                className="mt-3 justify-start gap-2 px-0 text-left"
                onPress={() => handleOpenInboxItem(latestInboxItem)}
                data-testid="home-latest-reply-fallback"
              >
                <Bell className="h-4 w-4" aria-hidden="true" />
                Latest reply: {latestInboxItem.conversationTitle?.trim() || "Open reply"}
              </Button>
            ) : null}
          </StudioListSection>
        </div>
      </div>
    </SettingsShell>
  );
}
