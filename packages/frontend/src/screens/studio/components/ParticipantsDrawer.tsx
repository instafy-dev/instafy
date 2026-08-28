import { useCallback, useState } from "react";
import { NavArrowRight } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { useCredits } from "../../../credits/useCredits";
import {
  resolveAgentAvatarGradient,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import { useChatParticipantsSnapshot } from "./chatParticipantsStore";
import type { ConversationRosterAgent } from "./conversationRosterMembers";

/**
 * Right-edge roster for the active conversation on wide screens: who is here,
 * what each agent is doing HERE (statuses are conversation-scoped — the send
 * queue belongs to the conversation, so queue depth is a summary line and
 * never an agent-row claim), and the shared team-credit pool. Docked
 * panel-tier surface, flat rows; the only data source is the snapshot
 * ChatPanel publishes plus the credits provider. Collapses to an avatar rail,
 * and is forced to the rail while the code/preview panel owns the right edge.
 */

const COLLAPSED_STORAGE_NAME = "instafy.participantsDrawer.collapsed.v1";

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_NAME) === "1";
  } catch {
    return false;
  }
}

function humanInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return `${first}${last}`.toUpperCase() || first.toUpperCase();
}

function AgentAvatar({ agent }: { agent: ConversationRosterAgent }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-3xs font-semibold text-white ring-1 ring-black/5 dark:ring-white/10"
      style={{ backgroundImage: resolveAgentAvatarGradient(agent.avatarSeed) }}
    >
      {resolveAgentAvatarText({ handle: agent.handle, displayName: agent.displayName })}
    </span>
  );
}

function RunningMarker() {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xxs font-semibold text-primary-600 dark:text-primary-300">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-primary-500 shadow-[0_0_5px_rgba(55,148,255,0.8)]"
      />
      Running
    </span>
  );
}

export function ParticipantsDrawer({ forceRail }: { forceRail: boolean }) {
  const snapshot = useChatParticipantsSnapshot();
  const {
    billing,
    hasLoaded: creditsLoaded,
    controllerEnabled: creditsEnabled,
  } = useCredits();
  const [userCollapsed, setUserCollapsed] = useState(readStoredCollapsed);

  const toggleCollapsed = useCallback(() => {
    setUserCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSED_STORAGE_NAME, next ? "1" : "0");
      } catch {
        // Preference just won't stick (private mode).
      }
      return next;
    });
  }, []);

  const { humans, agents, runningAgentHandles, totalQueuedCount } = snapshot;
  if (humans.length === 0 && agents.length === 0) {
    return null;
  }

  const runningSet = new Set(runningAgentHandles);
  const runningCount = agents.filter((agent) => runningSet.has(agent.handle)).length;
  const summaryParts: string[] = [];
  if (runningCount > 0) {
    summaryParts.push(`${runningCount} running`);
  }
  if (totalQueuedCount > 0) {
    summaryParts.push(
      `${totalQueuedCount} message${totalQueuedCount === 1 ? "" : "s"} queued`,
    );
  }

  const creditLimit = billing.creditLimit ?? 0;
  const creditBalance = Math.max(0, billing.creditBalance ?? 0);
  const showCredits = creditsEnabled && creditsLoaded && creditLimit > 0;
  const creditFraction = showCredits ? Math.min(1, creditBalance / creditLimit) : 0;
  const creditsLow = showCredits && creditBalance <= Math.max(2, Math.floor(creditLimit * 0.2));

  const collapsed = forceRail || userCollapsed;

  if (collapsed) {
    return (
      <aside
        aria-label="Conversation participants"
        data-testid="participants-drawer-rail"
        className="flex h-full w-11 shrink-0 flex-col items-center gap-2 border-l border-slate-200/70 bg-white py-2.5 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)]"
      >
        {forceRail ? null : (
          <IconButton
            variant="ghost"
            size="xs"
            radius="full"
            onPress={toggleCollapsed}
            aria-label="Expand participants"
            aria-expanded={false}
            className="text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100"
          >
            <NavArrowRight className="h-3.5 w-3.5 rotate-180" aria-hidden="true" />
          </IconButton>
        )}
        <div className="flex flex-col items-center gap-1.5">
          {humans.slice(0, 3).map((human) => (
            <span
              key={human.userId}
              title={human.label}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-500 text-3xs font-semibold text-white dark:bg-slate-600"
            >
              {humanInitials(human.label)}
            </span>
          ))}
          {agents.slice(0, 4).map((agent) => (
            <span key={agent.handle} title={agent.displayName} className="relative">
              <AgentAvatar agent={agent} />
              {runningSet.has(agent.handle) ? (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-white bg-primary-500 dark:border-[color:var(--color-studio-dark-panel)]"
                />
              ) : null}
            </span>
          ))}
        </div>
        {showCredits ? (
          <span
            title={`Team credits ${creditBalance}/${creditLimit}`}
            aria-hidden="true"
            className="mt-auto flex h-6 w-6 items-center justify-center rounded-full"
            style={{
              background: `conic-gradient(${creditsLow ? "#d7b686" : "var(--color-primary-500)"} 0 ${Math.round(creditFraction * 100)}%, rgba(127,127,127,0.25) ${Math.round(creditFraction * 100)}% 100%)`,
            }}
          >
            <span className="h-4 w-4 rounded-full bg-white dark:bg-[var(--color-studio-dark-panel)]" />
          </span>
        ) : null}
      </aside>
    );
  }

  return (
    <aside
      aria-label="Conversation participants"
      data-testid="participants-drawer"
      className="flex h-full w-[272px] shrink-0 flex-col border-l border-slate-200/70 bg-white dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)]"
    >
      <div className="flex items-center justify-between px-3.5 pb-0.5 pt-3">
        <Text as="div" variant="bodyStrong" tone="primary" className="text-sm">
          In this conversation
        </Text>
        <IconButton
          variant="ghost"
          size="xs"
          radius="full"
          onPress={toggleCollapsed}
          aria-label="Collapse participants"
          aria-expanded
          className="text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100"
        >
          <NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>
      {summaryParts.length > 0 ? (
        <Text
          as="div"
          variant="caption"
          tone="subtle"
          className="px-3.5 pb-1 text-xxs"
          data-testid="participants-drawer-summary"
        >
          {summaryParts.join(" · ")}
        </Text>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-2">
        {humans.length > 0 ? (
          <section aria-label="People">
            <Text
              as="div"
              variant="caption"
              tone="subtle"
              className="pb-1 pt-2.5 text-xxs font-medium"
            >
              People
            </Text>
            {humans.map((human) => (
              <div key={human.userId} className="flex items-center gap-2.5 py-1.5">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-500 text-3xs font-semibold text-white dark:bg-slate-600">
                  {humanInitials(human.label)}
                </span>
                <Text
                  as="div"
                  variant="caption"
                  tone="secondary"
                  className="min-w-0 flex-1 truncate text-xs font-medium"
                >
                  {human.label}
                  {human.isSelf ? (
                    <span className="ml-1.5 font-normal text-slate-400 dark:text-slate-500">you</span>
                  ) : null}
                </Text>
              </div>
            ))}
          </section>
        ) : null}

        {agents.length > 0 ? (
          <section aria-label="Agents">
            <Text
              as="div"
              variant="caption"
              tone="subtle"
              className="border-t border-slate-200/70 pb-1 pt-2.5 text-xxs font-medium dark:border-[color:var(--color-studio-dark-divider)]"
            >
              Agents
            </Text>
            {agents.map((agent) => (
              <div key={agent.handle} className="flex items-center gap-2.5 py-1.5">
                <AgentAvatar agent={agent} />
                <div className="min-w-0 flex-1">
                  <Text
                    as="div"
                    variant="caption"
                    tone="secondary"
                    className="truncate text-xs font-medium"
                  >
                    @{agent.handle}
                  </Text>
                  {agent.displayName && agent.displayName !== `@${agent.handle}` ? (
                    <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                      {agent.displayName}
                    </Text>
                  ) : null}
                </div>
                {runningSet.has(agent.handle) ? <RunningMarker /> : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>

      {showCredits ? (
        <div
          className="border-t border-slate-200/70 px-3.5 py-3 dark:border-[color:var(--color-studio-dark-divider)]"
          data-testid="participants-drawer-credits"
        >
          <div className="flex items-baseline justify-between pb-1.5">
            <Text as="span" variant="caption" tone="secondary" className="text-xs font-semibold">
              Team credits
            </Text>
            <Text
              as="span"
              variant="caption"
              tone={creditsLow ? "warning" : "muted"}
              className="text-xs tabular-nums"
            >
              {creditBalance} / {creditLimit}
            </Text>
          </div>
          <div
            role="meter"
            aria-label="Team credits remaining"
            aria-valuemin={0}
            aria-valuemax={creditLimit}
            aria-valuenow={creditBalance}
            className="h-1 overflow-hidden rounded-full bg-primary-500/15"
          >
            <span
              className={`block h-full rounded-full ${creditsLow ? "bg-secondary-500" : "bg-primary-500"}`}
              style={{ width: `${Math.round(creditFraction * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
    </aside>
  );
}
