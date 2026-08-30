import { useContext, useMemo } from "react";
import { Lock, Settings } from "iconoir-react";
import {
  Button as AriaButton,
  DialogTrigger,
  OverlayTriggerStateContext,
  type PopoverProps,
} from "react-aria-components";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useRuntime } from "../../../runtime/useRuntime";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import {
  deriveAgentConversationActivity,
  type AgentConversationActivityEntry,
} from "./agentConversationActivity";
import { setPendingAgentProfileTarget } from "./agentProfileDeepLink";
import type { AssistantAvatarMotion } from "./chatAssistantIdentity";

/**
 * The agent's profile card: identity, where it interacts (the conversations
 * the viewer can see, with a live pulse where it is working right now), and
 * the machine it replies from. One card, opened from every clickable agent —
 * transcript avatars, the participants drawer, and Machines-page chips.
 */

export interface AgentProfileCardProps {
  agentAvatarSeed: string;
  agentHandle: string;
  agentId?: string | null;
  displayName: string;
  metadata?: Record<string, unknown> | null;
  /** Falls back to the agent-settings deep link when not provided. */
  onOpenSettings?: (handle: string) => void;
  pinnedRuntimeId: string | null;
  resourcesSummary: string | null;
  runtimeLabel: string;
  runtimeState: string;
}

function ActivityRow({
  entry,
  onOpen,
}: {
  entry: AgentConversationActivityEntry;
  onOpen: (localId: string) => void;
}) {
  return (
    <AriaButton
      onPress={() => onOpen(entry.localId)}
      className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:hover:bg-white/[0.06]"
      data-testid={`agent-profile-conversation-${entry.localId}`}
    >
      {entry.workingNow ? (
        <span className="relative flex h-2 w-2 flex-none" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-30 [animation-duration:2.5s]" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
      ) : (
        <span
          className="mx-0.5 h-1 w-1 flex-none rounded-full bg-slate-300 dark:bg-slate-600"
          aria-hidden="true"
        />
      )}
      <Text
        as="span"
        variant="caption"
        tone="secondary"
        className="min-w-0 flex-1 truncate text-xs"
      >
        {entry.title}
      </Text>
      {entry.isPrivate ? (
        <Lock
          className="h-3 w-3 flex-none text-slate-400 dark:text-slate-500"
          aria-hidden="true"
        />
      ) : null}
      {entry.workingNow ? (
        <Text
          as="span"
          variant="caption"
          tone="inherit"
          className="flex-none text-xxs font-medium text-emerald-600 dark:text-emerald-400"
        >
          now
        </Text>
      ) : null}
    </AriaButton>
  );
}

function AgentProfileCardContent({
  agentAvatarSeed,
  agentHandle,
  agentId = null,
  displayName,
  metadata,
  onOpenSettings,
  pinnedRuntimeId,
  resourcesSummary,
  runtimeLabel,
  runtimeState,
}: AgentProfileCardProps) {
  const { conversations } = useConversations();
  const { runs } = useRuntime();
  const { openConversationTab, openPanelTab, requestUrlPush } =
    useWorkspaceTabs();
  const overlayState = useContext(OverlayTriggerStateContext);

  const activity = useMemo(
    () =>
      deriveAgentConversationActivity({
        agentHandle,
        agentId,
        conversations,
        runs,
      }),
    [agentHandle, agentId, conversations, runs],
  );

  const openConversation = (localId: string) => {
    // Same recipe as the history tab: the URL push keeps the panel/URL sync
    // from snapping the workspace back to the panel named in the query string.
    requestUrlPush();
    openConversationTab(localId);
    overlayState?.close();
  };
  const openSettings = () => {
    if (onOpenSettings) {
      onOpenSettings(agentHandle);
    } else {
      setPendingAgentProfileTarget(agentHandle);
      openPanelTab("ai", { activate: true });
    }
    overlayState?.close();
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <ChatMessageAvatar
          kind="assistant"
          metadata={metadata ?? null}
          agent={{ handle: agentHandle, avatarSeed: agentAvatarSeed }}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Text
                as="div"
                variant="bodyStrong"
                tone="inherit"
                className="truncate text-sm"
              >
                {displayName}
              </Text>
              <Text
                as="div"
                variant="caption"
                tone="muted"
                className="truncate text-xs"
              >
                @{agentHandle}
              </Text>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {pinnedRuntimeId ? (
                <Badge size="xs" className="shrink-0 text-slate-600">
                  Pinned
                </Badge>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                radius="full"
                onPress={openSettings}
                className="gap-1.5 px-2.5 text-slate-600 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10 dark:data-[hovered]:bg-white/10"
              >
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                Settings
              </Button>
            </div>
          </div>
          <Text
            as="div"
            variant="caption"
            tone="secondary"
            className="mt-1 text-xs leading-5"
          >
            {pinnedRuntimeId
              ? "Replies with the runtime pinned to this agent."
              : "Replies with the best available runtime in this space."}
          </Text>
        </div>
      </div>
      <div className="space-y-1" data-testid="agent-profile-activity">
        <Text as="div" variant="label" tone="subtle">
          Active in
        </Text>
        {activity.entries.length === 0 ? (
          <Text as="div" variant="caption" tone="muted" className="text-xs">
            No conversations you can see yet.
          </Text>
        ) : (
          <div className="-mx-1.5 flex flex-col">
            {activity.entries.map((entry) => (
              <ActivityRow
                key={entry.localId}
                entry={entry}
                onOpen={openConversation}
              />
            ))}
            {activity.overflowCount > 0 ? (
              <Text
                as="div"
                variant="caption"
                tone="muted"
                className="px-1.5 pt-0.5 text-xxs"
              >
                +{activity.overflowCount} more in history
              </Text>
            ) : null}
          </div>
        )}
      </div>
      <Surface
        tone="muted"
        radius="xl"
        shadow="none"
        className="space-y-1.5 px-3 py-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <Text as="div" variant="label" tone="subtle">
            Runtime
          </Text>
          <Text
            as="div"
            variant="caption"
            tone="secondary"
            className="shrink-0 text-xs capitalize"
          >
            {runtimeState}
          </Text>
        </div>
        <Text
          as="div"
          variant="bodyStrong"
          tone="primary"
          className="truncate text-sm"
        >
          {runtimeLabel}
        </Text>
        {resourcesSummary ? (
          <Text
            as="div"
            variant="caption"
            tone="muted"
            className="text-xs leading-5"
          >
            {resourcesSummary}
          </Text>
        ) : null}
      </Surface>
    </div>
  );
}

export function AgentProfilePopoverCard({
  placement = "top",
  ...cardProps
}: AgentProfileCardProps & { placement?: PopoverProps["placement"] }) {
  return (
    <StudioDialogPopover
      placement={placement}
      offset={8}
      className="w-80 overflow-hidden p-0"
    >
      <AgentProfileCardContent {...cardProps} />
    </StudioDialogPopover>
  );
}

export function AssistantAvatarPopover({
  motion = "idle",
  scrollReactive = false,
  ...cardProps
}: AgentProfileCardProps & {
  motion?: AssistantAvatarMotion;
  scrollReactive?: boolean;
}) {
  return (
    <DialogTrigger>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        radius="full"
        aria-label={`Agent info: ${cardProps.displayName}`}
        className="relative z-10 h-8 w-8 bg-transparent p-0 shadow-none hover:bg-transparent data-[hovered]:bg-transparent"
      >
        <ChatMessageAvatar
          kind="assistant"
          metadata={cardProps.metadata ?? null}
          agent={{
            handle: cardProps.agentHandle,
            avatarSeed: cardProps.agentAvatarSeed,
          }}
          motion={motion}
          scrollReactive={scrollReactive}
        />
      </Button>
      <AgentProfilePopoverCard {...cardProps} placement="top" />
    </DialogTrigger>
  );
}
