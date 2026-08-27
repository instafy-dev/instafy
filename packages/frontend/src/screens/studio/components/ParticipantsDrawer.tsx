import { useEffect } from "react";
import { Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { useCredits } from "../../../credits/useCredits";
import {
  resolveAgentAvatarGradient,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import {
  useChatParticipantsSnapshot,
  type ParticipantAgent,
  type ParticipantCredentialState,
} from "./chatParticipantsStore";

/**
 * Right-edge overlay listing the active conversation's people and agents, what
 * each agent runs HERE (statuses are conversation-scoped — queue depth is the
 * summary line, never an agent-row claim), the model/provider/credential each
 * agent draws from, and the shared team-credit pool. Opened from the chat's
 * roster facepile and closed to nothing — it overlays rather than pushes, so
 * it never competes with the code/preview panel for the right edge.
 */

function humanInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return `${first}${last}`.toUpperCase() || first.toUpperCase();
}

function AgentAvatar({ agent }: { agent: ParticipantAgent }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-3xs font-semibold text-white ring-1 ring-black/5 dark:ring-white/10"
      style={{ backgroundImage: resolveAgentAvatarGradient(agent.avatarSeed) }}
    >
      {resolveAgentAvatarText({ handle: agent.handle, displayName: agent.displayName })}
    </span>
  );
}

const CREDENTIAL_TONE: Record<
  ParticipantCredentialState,
  { tone: "muted" | "warning" | "danger"; prefix: string }
> = {
  default: { tone: "muted", prefix: "Using default" },
  pinned: { tone: "muted", prefix: "Pinned" },
  missing: { tone: "danger", prefix: "" },
  revoked: { tone: "danger", prefix: "" },
  none: { tone: "warning", prefix: "" },
};

function credentialLine(agent: ParticipantAgent): { text: string; tone: "muted" | "warning" | "danger" } {
  const meta = CREDENTIAL_TONE[agent.credentialState];
  if (agent.credentialState === "missing") {
    return { text: "Pinned credential is missing", tone: "danger" };
  }
  if (agent.credentialState === "revoked") {
    return { text: "Pinned credential was revoked", tone: "danger" };
  }
  if (agent.credentialState === "none") {
    return { text: "No AI credential", tone: "warning" };
  }
  const label = agent.credentialLabel ?? "credential";
  return { text: `${meta.prefix} · ${label}`, tone: "muted" };
}

export function ParticipantsDrawer({ onClose }: { onClose: () => void }) {
  const snapshot = useChatParticipantsSnapshot();
  const {
    billing,
    hasLoaded: creditsLoaded,
    controllerEnabled: creditsEnabled,
  } = useCredits();

  // Escape closes; the panel is docked-style (no backdrop), so this is the
  // keyboard exit alongside the header close button and the facepile toggle.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { humans, agents, runningAgentHandles, totalQueuedCount } = snapshot;
  const runningSet = new Set(runningAgentHandles);
  const runningCount = agents.filter((agent) => runningSet.has(agent.handle)).length;
  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (totalQueuedCount > 0) {
    summaryParts.push(`${totalQueuedCount} message${totalQueuedCount === 1 ? "" : "s"} queued`);
  }

  const creditLimit = billing.creditLimit ?? 0;
  const creditBalance = Math.max(0, billing.creditBalance ?? 0);
  const showCredits = creditsEnabled && creditsLoaded && creditLimit > 0;
  const creditFraction = showCredits ? Math.min(1, creditBalance / creditLimit) : 0;
  const creditsLow = showCredits && creditBalance <= Math.max(2, Math.floor(creditLimit * 0.2));

  return (
    <aside
      aria-label="Conversation participants"
      data-testid="participants-drawer"
      className="absolute right-0 top-0 bottom-0 z-30 flex w-[300px] max-w-[85vw] flex-col border-l border-slate-200/70 bg-white shadow-[0_0_40px_-12px_rgba(0,0,0,0.25)] dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)] dark:shadow-[0_0_40px_-12px_rgba(0,0,0,0.6)]"
    >
      <div className="flex items-center justify-between px-3.5 pb-0.5 pt-3">
        <Text as="div" variant="bodyStrong" tone="primary" className="text-sm">
          In this conversation
        </Text>
        <IconButton
          variant="ghost"
          size="xs"
          radius="full"
          onPress={onClose}
          aria-label="Close participants"
          className="text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100"
        >
          <Xmark className="h-4 w-4" aria-hidden="true" />
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
        {humans.length === 0 && agents.length === 0 ? (
          <Text as="p" variant="caption" tone="muted" className="pt-6 text-center text-xs">
            No one here yet.
          </Text>
        ) : null}

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
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-500 text-3xs font-semibold text-white dark:bg-slate-600">
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
            {agents.map((agent) => {
              const credential = credentialLine(agent);
              const metaParts = [agent.model, agent.providerLabel].filter(Boolean);
              return (
                <div key={agent.handle} className="flex items-start gap-2.5 py-2">
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
                    {metaParts.length > 0 ? (
                      <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                        {metaParts.join(" · ")}
                      </Text>
                    ) : null}
                    <Text
                      as="div"
                      variant="caption"
                      tone={credential.tone}
                      className="truncate text-xxs"
                    >
                      {credential.text}
                    </Text>
                  </div>
                  {runningSet.has(agent.handle) ? (
                    <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xxs font-semibold text-primary-600 dark:text-primary-300">
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-primary-500 shadow-[0_0_5px_rgba(55,148,255,0.8)]"
                      />
                      Running
                    </span>
                  ) : null}
                </div>
              );
            })}
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
