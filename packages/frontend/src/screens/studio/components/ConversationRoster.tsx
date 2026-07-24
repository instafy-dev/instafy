import { DialogTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import type {
  ConversationRosterAgent,
  ConversationRosterHuman,
} from "./conversationRosterMembers";

const MAX_STACK_AVATARS = 5;

/**
 * "Who is in this room": a compact overlapping avatar stack next to the
 * composer — humans first, then AI participants — with a "+N" overflow after
 * {@link MAX_STACK_AVATARS}. Clicking it opens a popover listing every member;
 * AI members carry a muted "AI · listening" descriptor, which absorbs the old
 * OctoPresenceChip semantics: in skill-mode group conversations agents
 * evaluate every ambient turn and usually stay silent, and this is the quiet
 * trace of that. The roster is static presence — it never hides while someone
 * is typing (the typing indicator is a separate surface).
 */
export function ConversationRoster({
  agents,
  humans,
}: {
  agents: readonly ConversationRosterAgent[];
  humans: readonly ConversationRosterHuman[];
}) {
  const totalCount = humans.length + agents.length;
  if (totalCount === 0) {
    return null;
  }

  const stackEntries = [
    ...humans.map((human) => ({
      key: `human:${human.userId}`,
      avatar: (
        <ChatMessageAvatar kind="human" seed={human.userId} label={human.label} size="xs" />
      ),
    })),
    ...agents.map((agent) => ({
      key: `agent:${agent.handle}`,
      avatar: (
        <ChatMessageAvatar
          kind="assistant"
          agent={{ handle: agent.handle, avatarSeed: agent.avatarSeed }}
          size="xs"
        />
      ),
    })),
  ];
  const visibleStackEntries = stackEntries.slice(0, MAX_STACK_AVATARS);
  const overflowCount = totalCount - visibleStackEntries.length;

  return (
    <DialogTrigger>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        radius="full"
        aria-label={`Conversation members (${totalCount})`}
        data-testid="conversation-roster"
        className="gap-1.5 border border-slate-200/60 bg-white/85 px-0.5 py-0.5 shadow-sm backdrop-blur dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]"
      >
        <span className="flex items-center -space-x-2">
          {visibleStackEntries.map((entry) => (
            <span
              key={entry.key}
              className="rounded-full ring-2 ring-white dark:ring-[var(--color-studio-dark-panel)]"
            >
              {entry.avatar}
            </span>
          ))}
        </span>
        {overflowCount > 0 ? (
          <span
            className="pr-1.5 text-xxs font-medium text-slate-500 dark:text-slate-400"
            data-testid="conversation-roster-overflow"
          >
            +{overflowCount}
          </span>
        ) : null}
      </Button>
      <StudioDialogPopover placement="top" offset={8} className="w-64 overflow-hidden p-0">
        <div
          data-testid="conversation-roster-popover"
          className="max-h-80 overflow-y-auto p-2"
        >
          <ul className="space-y-0.5">
            {humans.map((human) => (
              <li
                key={`human:${human.userId}`}
                className="flex items-center gap-2.5 rounded-xl px-2 py-1.5"
                data-testid="conversation-roster-human"
              >
                <ChatMessageAvatar
                  kind="human"
                  seed={human.userId}
                  label={human.label}
                  size="xs"
                />
                <div className="min-w-0 flex-1">
                  <Text as="div" variant="bodyStrong" tone="inherit" className="truncate text-sm">
                    {human.label}
                  </Text>
                  {human.isSelf && human.label !== "You" ? (
                    <Text as="div" variant="caption" tone="muted" className="text-xs">
                      You
                    </Text>
                  ) : null}
                </div>
              </li>
            ))}
            {agents.map((agent) => (
              <li
                key={`agent:${agent.handle}`}
                className="flex items-center gap-2.5 rounded-xl px-2 py-1.5"
                data-testid="conversation-roster-agent"
              >
                <ChatMessageAvatar
                  kind="assistant"
                  agent={{ handle: agent.handle, avatarSeed: agent.avatarSeed }}
                  size="xs"
                />
                <div className="min-w-0 flex-1">
                  <Text as="div" variant="bodyStrong" tone="inherit" className="truncate text-sm">
                    {agent.displayName}
                  </Text>
                  <Text as="div" variant="caption" tone="muted" className="text-xs">
                    AI · listening
                  </Text>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </StudioDialogPopover>
    </DialogTrigger>
  );
}
