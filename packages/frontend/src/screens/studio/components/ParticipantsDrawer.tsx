import { useEffect, useState } from "react";
import { NavArrowDown, Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { useCredits } from "../../../credits/useCredits";
import {
  resolveAgentAvatarGradient,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import {
  modelOptionsForProvider,
  normalizeAiProviderId,
} from "../../../utils/aiProviderModels";
import { normalizeReasoningEffort, type AiReasoningEffort } from "../../../utils/aiReasoning";
import {
  useChatParticipantsSnapshot,
  type ParticipantAgent,
  type ParticipantEditingContext,
  type ParticipantSubscriptionUsage,
} from "./chatParticipantsStore";
import { ModelMenuSelect } from "./ModelMenuSelect";
import { ReasoningMenuSelect } from "./ReasoningMenuSelect";
import { formatReset, windowLabel } from "./subscriptionUsageFormat";

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

// Lead with the account the agent uses (what a person recognizes) and annotate
// only the notable states. "Default" (follows the workspace default) is the
// unremarkable norm and needs no label; "Pinned" (locked to this one) and the
// broken states are what's worth flagging.
function credentialLine(
  agent: ParticipantAgent,
): { text: string; tone: "muted" | "warning" | "danger" } {
  const label = agent.credentialLabel ?? "credential";
  switch (agent.credentialState) {
    case "missing":
      return { text: "Its credential is missing", tone: "danger" };
    case "revoked":
      return { text: "Its credential was revoked", tone: "danger" };
    case "none":
      return { text: "No AI credential", tone: "warning" };
    case "pinned":
      return { text: `${label} · pinned`, tone: "muted" };
    default:
      return { text: label, tone: "muted" };
  }
}

// One compact line per window: "<label> · <reset>" on the left, "<n>% left" on
// the right (amber as it drains). No bar — the number is the signal, and a
// single row keeps the drawer tight even with two windows per agent.
function UsageWindowRow({
  window,
  nowMs,
}: {
  window: ParticipantSubscriptionUsage["windows"][number];
  nowMs: number;
}) {
  const label = windowLabel(window.windowMinutes);
  // Once the reset time has passed and no fresher snapshot has arrived, the
  // window has rolled over — the last-known "used" figure is stale. Show it as
  // refreshed (full) rather than "nearly out of quota".
  const lapsed = window.resetAt > 0 && window.resetAt * 1000 <= nowMs;
  const remaining = lapsed ? 100 : Math.max(0, 100 - window.usedPercent);
  // Colour only when it matters: neutral while there's plenty, amber as it runs
  // low, red when nearly out — so a glance flags which agents to avoid leaning on.
  const remainingTone: "muted" | "warning" | "danger" =
    lapsed || remaining > 25 ? "muted" : remaining <= 10 ? "danger" : "warning";
  const reset = lapsed ? "just reset" : formatReset(window.resetAt, nowMs);
  return (
    <div
      className="flex items-baseline justify-between gap-2 pt-0.5"
      data-testid="participants-usage-window"
    >
      <Text as="span" variant="caption" tone="muted" className="min-w-0 truncate text-xxs">
        {label}
        {reset ? ` · ${reset}` : ""}
      </Text>
      <Text
        as="span"
        variant="caption"
        tone={remainingTone}
        className="shrink-0 text-xxs tabular-nums"
      >
        {remaining}% left
      </Text>
    </div>
  );
}

function SubscriptionUsageMeters({
  usage,
  nowMs,
}: {
  usage: ParticipantSubscriptionUsage;
  nowMs: number;
}) {
  // Short rolling window first, longer window second — regardless of the order
  // upstream lists them — so the fast-moving one reads at the top.
  const windows = [...usage.windows].sort((a, b) => a.windowMinutes - b.windowMinutes);
  return (
    <div className="mt-1" data-testid="participants-usage">
      {windows.map((window) => (
        <UsageWindowRow key={window.kind} window={window} nowMs={nowMs} />
      ))}
    </div>
  );
}

// Inline edit controls for an agent row: the same Model + Reasoning pickers as
// the composer chip, but here in the roster where you weigh them against each
// agent's usage. Saves through the editing context (ChatPanel owns the write +
// refresh); the row's displayed values update when the refreshed snapshot lands.
function AgentEditControls({
  agent,
  editing,
}: {
  agent: ParticipantAgent;
  editing: ParticipantEditingContext;
}) {
  const [saving, setSaving] = useState(false);
  const agentId = agent.agentId;
  if (!agentId) return null;

  const providerId = normalizeAiProviderId(agent.providerId ?? "");
  const modelOptions = modelOptionsForProvider(providerId);
  const reasoningValue = normalizeReasoningEffort(agent.reasoningEffort);

  const save = async (patch: {
    model?: string | null;
    reasoningEffort?: AiReasoningEffort | null;
  }) => {
    setSaving(true);
    try {
      await editing.saveAgent(agentId, patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-1.5" data-testid="participants-agent-edit">
      {modelOptions.length > 0 ? (
        <ModelMenuSelect
          value={agent.model}
          options={modelOptions}
          disabled={saving}
          includeDefaultOption
          defaultLabel={`Default (${modelOptions[0]?.label ?? "recommended"})`}
          ariaLabel={`Select model for @${agent.handle}`}
          onSelect={(nextModel) => void save({ model: nextModel })}
          triggerTestId={`drawer-agent-model-select-${agent.handle}`}
        />
      ) : null}
      {providerId === "openai" ? (
        <ReasoningMenuSelect
          value={reasoningValue}
          disabled={saving}
          ariaLabel={`Select reasoning effort for @${agent.handle}`}
          onSelect={(nextEffort) => void save({ reasoningEffort: nextEffort })}
          triggerTestId={`drawer-agent-reasoning-select-${agent.handle}`}
        />
      ) : null}
    </div>
  );
}

export function ParticipantsDrawer({ onClose }: { onClose: () => void }) {
  const snapshot = useChatParticipantsSnapshot();
  // Which agent rows are expanded into their edit controls (by handle).
  const [expandedAgents, setExpandedAgents] = useState<ReadonlySet<string>>(() => new Set());
  const toggleAgentExpanded = (handle: string) =>
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  // Relative reset times ("resets in 2h 10m") go stale between snapshots, so
  // re-tick every 30s while the drawer is open. Cheap: a single interval, no
  // network. Seeded lazily so tests can render deterministically at mount.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
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

  // Clicking anywhere outside the drawer closes it. Skip clicks on the roster
  // facepile — it toggles on its own, so closing here would race its toggle and
  // reopen the drawer. Uses mousedown so it settles before the click lands.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest('[data-testid="participants-drawer"]')) return;
      if (target.closest('[data-testid="conversation-roster"]')) return;
      // The row edit menus (model/reasoning) portal outside the drawer; a click
      // inside one must not be read as a click-away that closes the drawer.
      if (target.closest("[data-studio-popover]")) return;
      onClose();
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  const { humans, agents, runningAgentHandles, totalQueuedCount, editing } = snapshot;
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

  // Usage is a property of the credential, not the agent — so when several
  // agents share one account, show the meters once (on the first agent that
  // uses it) instead of repeating identical bars down the list.
  const usageShownFor = new Set<string>();

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
              // Fold an unremarkable (healthy) credential into the model·provider
              // line so a normal agent is just handle + one meta line + usage.
              // Broken states keep their own coloured line so the warning reads.
              const credentialHealthy = credential.tone === "muted";
              const metaLine = (
                credentialHealthy ? [...metaParts, credential.text] : metaParts
              )
                .filter(Boolean)
                .join(" · ");
              // First agent on a live credential carries its usage meters; the
              // rest reference the same account by name without repeating them.
              const showUsage =
                agent.subscriptionUsage != null &&
                (agent.credentialState === "default" || agent.credentialState === "pinned") &&
                agent.credentialId != null &&
                !usageShownFor.has(agent.credentialId);
              if (showUsage && agent.credentialId) usageShownFor.add(agent.credentialId);
              const isEditable = editing != null && agent.agentId != null;
              const isExpanded = expandedAgents.has(agent.handle);
              return (
                <div key={agent.handle} className="flex items-start gap-2.5 py-1.5">
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
                    {metaLine ? (
                      <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                        {metaLine}
                      </Text>
                    ) : null}
                    {!credentialHealthy ? (
                      <Text
                        as="div"
                        variant="caption"
                        tone={credential.tone}
                        className="truncate text-xxs"
                      >
                        {credential.text}
                      </Text>
                    ) : null}
                    {showUsage && agent.subscriptionUsage ? (
                      <SubscriptionUsageMeters usage={agent.subscriptionUsage} nowMs={nowMs} />
                    ) : null}
                    {isEditable && isExpanded && editing ? (
                      <AgentEditControls agent={agent} editing={editing} />
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                    {runningSet.has(agent.handle) ? (
                      <span className="flex items-center gap-1.5 text-xxs font-semibold text-primary-600 dark:text-primary-300">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full bg-primary-500 shadow-[0_0_5px_rgba(55,148,255,0.8)]"
                        />
                        Running
                      </span>
                    ) : null}
                    {isEditable ? (
                      <IconButton
                        variant="ghost"
                        size="xs"
                        radius="full"
                        aria-label={isExpanded ? `Hide @${agent.handle} settings` : `Edit @${agent.handle} settings`}
                        aria-expanded={isExpanded}
                        data-testid={`participants-agent-expand-${agent.handle}`}
                        onPress={() => toggleAgentExpanded(agent.handle)}
                        className="text-slate-400 hover:text-slate-600 data-[hovered]:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 dark:data-[hovered]:text-slate-300"
                      >
                        <NavArrowDown
                          className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          aria-hidden="true"
                        />
                      </IconButton>
                    ) : null}
                  </div>
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
