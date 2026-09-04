import { Group } from "iconoir-react";
import { Button } from "../../../components/Button";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import {
  toggleParticipantsDrawer,
  useParticipantsDrawerOpen,
} from "./chatParticipantsStore";
import type {
  ConversationRosterAgent,
  ConversationRosterHuman,
} from "./conversationRosterMembers";

const MAX_STACK_AVATARS = 5;

/**
 * "Who is in this room": a compact overlapping avatar stack pinned to the top
 * right of the conversation surface — humans first, then AI participants —
 * with a "+N" overflow after {@link MAX_STACK_AVATARS}. It is the entry point
 * for the participants drawer: clicking it opens/closes the drawer (which
 * lists every member with their model, credential, and status, plus the shared
 * budget). An amber dot rides the stack when an agent's credential needs
 * attention, so that state is visible without opening anything.
 *
 * Styling is deliberately ambient: a bare, transparent avatar stack (no panel,
 * border, shadow or blur) so it reads as passive information with a control
 * affordance. Each avatar carries a thin ring painted in the chat surface's
 * own background to separate overlapping faces.
 */
export function ConversationRoster({
  agents,
  humans,
  hasCredentialWarning = false,
}: {
  agents: readonly ConversationRosterAgent[];
  humans: readonly ConversationRosterHuman[];
  hasCredentialWarning?: boolean;
}) {
  const drawerOpen = useParticipantsDrawerOpen();
  const totalCount = humans.length + agents.length;
  // Persistent entry point: even before anyone has joined (a brand-new chat),
  // keep a plain icon so the participants/config panel is always reachable —
  // otherwise there is no way to open it until a member appears.
  if (totalCount === 0) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        radius="full"
        aria-label="Open participants"
        aria-expanded={drawerOpen}
        data-testid="conversation-roster"
        onPress={() => toggleParticipantsDrawer()}
        className="border-0 bg-transparent px-1 py-0.5 text-slate-400 shadow-none hover:text-slate-600 data-[hovered]:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 dark:data-[hovered]:text-slate-300"
      >
        <Group className="h-4 w-4" aria-hidden="true" />
      </Button>
    );
  }

  const stackEntries = [
    ...humans.map((human) => ({
      key: `human:${human.userId}`,
      avatar: (
        <ChatMessageAvatar kind="human" seed={human.userId} label={human.label} size="2xs" />
      ),
    })),
    ...agents.map((agent) => ({
      key: `agent:${agent.handle}`,
      avatar: (
        <ChatMessageAvatar
          kind="assistant"
          agent={{ handle: agent.handle, avatarSeed: agent.avatarSeed }}
          size="2xs"
        />
      ),
    })),
  ];
  const visibleStackEntries = stackEntries.slice(0, MAX_STACK_AVATARS);
  const overflowCount = totalCount - visibleStackEntries.length;

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      radius="full"
      aria-label={`Conversation members (${totalCount})`}
      aria-expanded={drawerOpen}
      data-testid="conversation-roster"
      onPress={() => toggleParticipantsDrawer()}
      className="relative gap-1 border-0 bg-transparent px-1 py-0.5 shadow-none"
    >
      <span className="flex items-center -space-x-1.5">
        {visibleStackEntries.map((entry) => (
          <span
            key={entry.key}
            className="rounded-full ring-1 ring-white dark:ring-[var(--color-studio-dark-panel)]"
          >
            {entry.avatar}
          </span>
        ))}
      </span>
      {overflowCount > 0 ? (
        <span
          className="pr-0.5 text-xxs font-medium text-slate-500 dark:text-slate-400"
          data-testid="conversation-roster-overflow"
        >
          +{overflowCount}
        </span>
      ) : null}
      {hasCredentialWarning ? (
        <span
          aria-hidden="true"
          data-testid="conversation-roster-warning"
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-secondary-500 dark:border-[var(--color-studio-dark-panel)]"
        />
      ) : null}
    </Button>
  );
}
