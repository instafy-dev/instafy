import { useEffect, useRef, useState } from "react";
import { Cpu, Cube, Xmark } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import {
  resolveAgentAvatarGradient,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import {
  modelOptionsForProvider,
  normalizeAiProviderId,
} from "../../../utils/aiProviderModels";
import {
  normalizeReasoningEffort,
  reasoningEffortLabel,
  REASONING_EFFORT_OPTIONS,
  type AiReasoningEffort,
} from "../../../utils/aiReasoning";
import {
  useChatParticipantsSnapshot,
  type ParticipantAgent,
  type ParticipantEditingContext,
  type ParticipantRuntimeInfo,
  type ParticipantSubscriptionUsage,
} from "./chatParticipantsStore";
import { formatReset, windowLabel } from "./subscriptionUsageFormat";

/**
 * Right-edge overlay listing the active conversation's people and agents.
 *
 * Design rule: SILENCE IS THE DEFAULT. A dimension appears only when it is
 * non-default or a problem — usage speaks up only when headroom is low, the
 * credential only when it is pinned or broken, runtime health only when the
 * machine is not ready. Model + reasoning read as an editable sentence (dotted
 * tokens, menu on click). The machine is a quiet footer when everyone shares
 * one box, and becomes per-machine group headers only when real topology
 * exists (several machines / native / dedicated).
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

// A plain-language credential type from its kind. Unlike the model name (which
// says nothing about the auth backend), this tells you *whose quota* pays for
// the agent — a ChatGPT subscription vs a metered API key. Falls back to the
// raw label for kinds without a friendly name.
function friendlyCredentialKind(kind?: string | null): string | null {
  switch ((kind ?? "").trim()) {
    case "codex_auth_json":
      return "ChatGPT subscription";
    case "openai_api_key":
      return "OpenAI API key";
    case "gemini_api":
      return "Gemini API key";
    case "gemini_cli":
      return "Gemini (CLI)";
    case "gemini_oauth_connected":
    case "gemini_oauth_mode":
      return "Gemini";
    default:
      return null;
  }
}

// The credential line renders only when it is worth a line: pinned (non-default)
// or broken. The healthy default is the norm and stays silent.
function notableCredentialLine(
  agent: ParticipantAgent,
): { text: string; tone: "muted" | "warning" | "danger" } | null {
  const descriptor =
    friendlyCredentialKind(agent.credentialKind) ?? agent.credentialLabel ?? "credential";
  switch (agent.credentialState) {
    case "missing":
      return { text: "Its credential is missing", tone: "danger" };
    case "revoked":
      return { text: "Its credential was revoked", tone: "danger" };
    case "none":
      return { text: "No AI credential", tone: "warning" };
    case "pinned":
      return { text: `${descriptor} · pinned`, tone: "muted" };
    default:
      return null;
  }
}

const USAGE_LOW_THRESHOLD = 25;

function windowRemaining(
  window: ParticipantSubscriptionUsage["windows"][number],
  nowMs: number,
): number {
  // A window whose reset time has passed (with no fresher snapshot) has rolled
  // over — the stale "used" figure would wrongly read as drained.
  const lapsed = window.resetAt > 0 && window.resetAt * 1000 <= nowMs;
  return lapsed ? 100 : Math.max(0, 100 - window.usedPercent);
}

// Only the windows actually running low. Their detail (reset times) appears
// only then — but the headline % rides every row so agents' headroom can be
// compared at a glance even when everyone is healthy.
function lowUsageWindows(
  usage: ParticipantSubscriptionUsage,
  nowMs: number,
): ParticipantSubscriptionUsage["windows"] {
  return usage.windows.filter(
    (window) => windowRemaining(window, nowMs) <= USAGE_LOW_THRESHOLD,
  );
}

// The tightest window's remaining % — the number that answers "how much can I
// still lean on this agent". Null when the credential reports no windows.
function lowestRemaining(usage: ParticipantSubscriptionUsage, nowMs: number): number | null {
  if (usage.windows.length === 0) return null;
  return Math.min(...usage.windows.map((window) => windowRemaining(window, nowMs)));
}

// One compact line per low window: "<label> · <reset>" left, "<n>% left" right.
function UsageWindowRow({
  window,
  nowMs,
}: {
  window: ParticipantSubscriptionUsage["windows"][number];
  nowMs: number;
}) {
  const label = windowLabel(window.windowMinutes);
  const remaining = windowRemaining(window, nowMs);
  const remainingTone: "warning" | "danger" = remaining <= 10 ? "danger" : "warning";
  const reset = formatReset(window.resetAt, nowMs);
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

function LowUsageRows({
  windows,
  nowMs,
}: {
  windows: ParticipantSubscriptionUsage["windows"];
  nowMs: number;
}) {
  // Short rolling window first, longer window second.
  const sorted = [...windows].sort((a, b) => a.windowMinutes - b.windowMinutes);
  return (
    <div className="mt-0.5" data-testid="participants-usage">
      {sorted.map((window) => (
        <UsageWindowRow key={window.kind} window={window} nowMs={nowMs} />
      ))}
    </div>
  );
}

const DEFAULT_MENU_KEY = "__default__";

// An editable word: the current value rendered as text with a dotted underline
// (the "click to change" tell), opening a menu on click. Calmer than a boxed
// dropdown, still a real button for a11y. The menu portals into a StudioPopover,
// which the drawer's click-away already exempts.
function InlineMenuSelect({
  displayLabel,
  selectedKey,
  options,
  ariaLabel,
  onSelect,
  disabled = false,
  triggerTestId,
}: {
  displayLabel: string;
  selectedKey: string;
  options: { key: string; label: string }[];
  ariaLabel: string;
  onSelect: (key: string) => void;
  disabled?: boolean;
  triggerTestId?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        radius="lg"
        isDisabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        data-testid={triggerTestId}
        onPress={() => {
          if (!open) setOpen(true);
        }}
        className="inline-flex h-auto min-h-0 max-w-full items-center border-0 bg-transparent p-0 text-xxs font-medium text-slate-600 underline decoration-slate-400/80 decoration-dotted underline-offset-[3px] shadow-none hover:text-slate-900 hover:decoration-slate-500 data-[hovered]:text-slate-900 dark:text-slate-200 dark:decoration-slate-500 dark:hover:text-white dark:data-[hovered]:text-white"
      >
        <span className="min-w-0 truncate">{displayLabel}</span>
      </Button>
      <StudioPopover
        triggerRef={triggerRef}
        isNonModal
        placement="bottom start"
        offset={4}
        className="min-w-[9rem] p-2"
        data-testid={triggerTestId ? `${triggerTestId}-menu` : undefined}
      >
        <StudioMenu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={new Set([selectedKey])}
          onAction={(key) => {
            onSelect(String(key));
            setOpen(false);
          }}
          className="space-y-1"
        >
          {options.map((option) => (
            <StudioMenuItem key={option.key} id={option.key}>
              {option.label}
            </StudioMenuItem>
          ))}
        </StudioMenu>
      </StudioPopover>
    </MenuTrigger>
  );
}

// Model + reasoning as an editable sentence in the agent row: "gpt-5.5 · High",
// each word a dotted token that opens its menu. Saves through the editing
// context (ChatPanel owns the write + refresh).
function AgentInlineControls({
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
  const showReasoning = providerId === "openai";

  const save = (patch: { model?: string | null; reasoningEffort?: AiReasoningEffort | null }) => {
    setSaving(true);
    void editing.saveAgent(agentId, patch).finally(() => setSaving(false));
  };

  const modelMenuOptions = [
    { key: DEFAULT_MENU_KEY, label: "Default" },
    ...modelOptions.map((option) => ({ key: option.id, label: option.label })),
  ];
  const reasoningMenuOptions = [
    { key: DEFAULT_MENU_KEY, label: "Default" },
    ...REASONING_EFFORT_OPTIONS.map((option) => ({ key: option.id, label: option.label })),
  ];

  return (
    <span
      className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5"
      data-testid="participants-agent-controls"
    >
      {modelOptions.length > 0 ? (
        <InlineMenuSelect
          displayLabel={agent.model ?? "Default"}
          selectedKey={agent.model ?? DEFAULT_MENU_KEY}
          options={modelMenuOptions}
          ariaLabel={`Model for @${agent.handle}`}
          disabled={saving}
          onSelect={(key) => save({ model: key === DEFAULT_MENU_KEY ? null : key })}
          triggerTestId={`drawer-agent-model-select-${agent.handle}`}
        />
      ) : null}
      {modelOptions.length > 0 && showReasoning ? (
        <span aria-hidden="true" className="text-xxs text-slate-400 dark:text-slate-500">
          ·
        </span>
      ) : null}
      {showReasoning ? (
        <InlineMenuSelect
          displayLabel={
            reasoningValue ? reasoningEffortLabel(reasoningValue) : "Default reasoning"
          }
          selectedKey={reasoningValue ?? DEFAULT_MENU_KEY}
          options={reasoningMenuOptions}
          ariaLabel={`Reasoning for @${agent.handle}`}
          disabled={saving}
          onSelect={(key) =>
            save({ reasoningEffort: key === DEFAULT_MENU_KEY ? null : (key as AiReasoningEffort) })
          }
          triggerTestId={`drawer-agent-reasoning-select-${agent.handle}`}
        />
      ) : null}
    </span>
  );
}

const RUNTIME_HEALTHY_STATES = new Set(["ready", "online", "healthy"]);
const RUNTIME_BOOTING_STATES = new Set(["booting", "starting", "pending"]);
const RUNTIME_DOWN_STATES = new Set(["offline", "expired", "stopped", "error"]);

function runtimeStatusMeta(rawStatus: string): {
  status: string;
  healthy: boolean;
  dotColor: string;
} {
  const status = rawStatus.toLowerCase();
  const healthy = RUNTIME_HEALTHY_STATES.has(status);
  const dotColor = healthy
    ? "#57c06a"
    : RUNTIME_BOOTING_STATES.has(status)
      ? "#e0a53a"
      : RUNTIME_DOWN_STATES.has(status)
        ? "#e5706b"
        : "#8b9096";
  return { status, healthy, dotColor };
}

function runtimeKindLabel(kind: ParticipantRuntimeInfo["kind"]): string {
  return kind === "native" ? "Native" : kind === "dedicated" ? "Dedicated" : "Shared";
}

// Header for a runtime group — rendered only when the conversation spans more
// than one machine (real topology). Identity + kind badge + health dot; a
// status word only when something is wrong.
function RuntimeGroupHeader({
  runtime,
  agentCount,
}: {
  runtime: ParticipantRuntimeInfo;
  agentCount: number;
}) {
  const Icon = runtime.kind === "native" ? Cpu : Cube;
  const { status, healthy, dotColor } = runtimeStatusMeta(runtime.status);
  const detail = runtime.kind === "native" ? "this machine" : runtime.resourcesSummary;
  return (
    <div
      className="flex items-start gap-2 pb-0.5 pt-2.5"
      data-testid="participants-runtime-group"
    >
      <Icon
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-slate-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Text
            as="span"
            variant="caption"
            tone="secondary"
            className="min-w-0 truncate text-xxs font-medium"
          >
            {runtime.label}
          </Text>
          <span className="shrink-0 rounded bg-slate-200/70 px-1.5 py-px text-3xs font-medium text-slate-600 dark:bg-white/10 dark:text-slate-300">
            {runtimeKindLabel(runtime.kind)}
            {runtime.kind === "shared" && agentCount > 1 ? ` · ${agentCount}` : ""}
          </span>
          <span
            aria-hidden="true"
            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
          {!healthy && status !== "unknown" ? (
            <Text as="span" variant="caption" tone="muted" className="shrink-0 text-3xs">
              {status}
            </Text>
          ) : null}
        </div>
        {detail ? (
          <Text as="div" variant="caption" tone="muted" className="truncate text-3xs">
            {detail}
          </Text>
        ) : null}
      </div>
    </div>
  );
}

// The quiet single-machine footer: when every agent shares one box, the roster
// doesn't need per-agent machine chrome — one line at the bottom says where
// everything runs. (Becomes the deep-link into the runtime view next.)
function MachineFooter({
  runtime,
  agentCount,
}: {
  runtime: ParticipantRuntimeInfo;
  agentCount: number;
}) {
  const Icon = runtime.kind === "native" ? Cpu : Cube;
  const { status, healthy } = runtimeStatusMeta(runtime.status);
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 border-t border-slate-200/70 pt-2 dark:border-[color:var(--color-studio-dark-divider)]"
      data-testid="participants-machine-footer"
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500"
        aria-hidden="true"
      />
      <Text as="span" variant="caption" tone="muted" className="min-w-0 truncate text-xxs">
        {agentCount > 1 ? "All on " : "On "}
        {runtime.label} · {runtimeKindLabel(runtime.kind).toLowerCase()}
        {runtime.kind === "native" ? " · this machine" : ""}
      </Text>
      {!healthy && status !== "unknown" ? (
        <Text as="span" variant="caption" tone="warning" className="shrink-0 text-xxs">
          {status}
        </Text>
      ) : null}
    </div>
  );
}

export function ParticipantsDrawer({ onClose }: { onClose: () => void }) {
  const snapshot = useChatParticipantsSnapshot();
  // Relative reset times ("resets in 2h 10m") go stale between snapshots, so
  // re-tick every 30s while the drawer is open. Cheap: a single interval, no
  // network. Seeded lazily so tests can render deterministically at mount.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

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
      // The token menus (model/reasoning) portal outside the drawer; a click
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

  // Usage is a property of the credential, not the agent — when several agents
  // share one account, its low-headroom warning shows once, on the first agent.
  const usageShownFor = new Set<string>();

  // Cluster agents by the machine they run in (first-seen order). Agents with
  // no runtime info fall into a single unheadered group.
  const runtimeGroups: {
    key: string;
    runtime: ParticipantRuntimeInfo | null;
    agents: ParticipantAgent[];
  }[] = [];
  const runtimeGroupIndex = new Map<string, number>();
  for (const agent of agents) {
    const key = agent.runtime?.id ?? "__no_runtime__";
    const existing = runtimeGroupIndex.get(key);
    if (existing === undefined) {
      runtimeGroupIndex.set(key, runtimeGroups.length);
      runtimeGroups.push({ key, runtime: agent.runtime ?? null, agents: [agent] });
    } else {
      runtimeGroups[existing].agents.push(agent);
    }
  }
  // Structure grows with the situation: one shared machine → a quiet footer;
  // several machines → per-machine group headers.
  const singleMachine = runtimeGroups.length === 1 && runtimeGroups[0]?.runtime != null;
  const showGroupHeaders =
    !singleMachine && runtimeGroups.some((group) => group.runtime != null);

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

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3">
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
                    <span className="ml-1.5 font-normal text-slate-400 dark:text-slate-500">
                      you
                    </span>
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
              {showGroupHeaders ? "Runtimes & agents" : "Agents"}
            </Text>
            {runtimeGroups.map((group) => (
              <div key={group.key}>
                {showGroupHeaders && group.runtime ? (
                  <RuntimeGroupHeader
                    runtime={group.runtime}
                    agentCount={group.agents.length}
                  />
                ) : null}
                <div
                  className={
                    showGroupHeaders && group.runtime
                      ? "border-l border-slate-200/70 pl-2.5 dark:border-[color:var(--color-studio-dark-divider)]"
                      : ""
                  }
                >
                  {group.agents.map((agent) => {
                    const credential = notableCredentialLine(agent);
                    const isEditable = editing != null && agent.agentId != null;
                    // Read-only fallback: the same sentence, as plain text.
                    const readOnlyMeta = [
                      agent.model,
                      normalizeReasoningEffort(agent.reasoningEffort)
                        ? reasoningEffortLabel(
                            normalizeReasoningEffort(agent.reasoningEffort) as AiReasoningEffort,
                          )
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    const usageLive =
                      agent.subscriptionUsage != null &&
                      (agent.credentialState === "default" ||
                        agent.credentialState === "pinned");
                    // Headline headroom rides EVERY row (no dedup) so agents can
                    // be compared at a glance — and a sibling on a shared, drained
                    // credential can't look deceptively fine.
                    const remaining = usageLive
                      ? lowestRemaining(agent.subscriptionUsage as ParticipantSubscriptionUsage, nowMs)
                      : null;
                    // The reset-time detail rows appear only when low — and once
                    // per shared credential, on the first agent that uses it.
                    const lowWindows =
                      usageLive &&
                      agent.credentialId != null &&
                      !usageShownFor.has(agent.credentialId)
                        ? lowUsageWindows(
                            agent.subscriptionUsage as ParticipantSubscriptionUsage,
                            nowMs,
                          )
                        : [];
                    if (lowWindows.length > 0 && agent.credentialId) {
                      usageShownFor.add(agent.credentialId);
                    }
                    return (
                      <div key={agent.handle} className="flex items-start gap-2.5 py-1.5">
                        <AgentAvatar agent={agent} />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                            <Text
                              as="span"
                              variant="caption"
                              tone="secondary"
                              className="shrink-0 text-xs font-medium"
                            >
                              @{agent.handle}
                            </Text>
                            {isEditable && editing ? (
                              <AgentInlineControls agent={agent} editing={editing} />
                            ) : readOnlyMeta ? (
                              <Text
                                as="span"
                                variant="caption"
                                tone="muted"
                                className="min-w-0 truncate text-xxs"
                              >
                                {readOnlyMeta}
                              </Text>
                            ) : null}
                            {remaining != null ? (
                              <Text
                                as="span"
                                variant="caption"
                                tone={
                                  remaining <= 10
                                    ? "danger"
                                    : remaining <= USAGE_LOW_THRESHOLD
                                      ? "warning"
                                      : "muted"
                                }
                                className="shrink-0 text-xxs tabular-nums"
                                data-testid="participants-agent-headroom"
                              >
                                · {remaining}% left
                              </Text>
                            ) : null}
                          </div>
                          {credential ? (
                            <Text
                              as="div"
                              variant="caption"
                              tone={credential.tone}
                              className="truncate pt-0.5 text-xxs"
                            >
                              {credential.text}
                            </Text>
                          ) : null}
                          {lowWindows.length > 0 ? (
                            <LowUsageRows windows={lowWindows} nowMs={nowMs} />
                          ) : null}
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
                </div>
              </div>
            ))}
            {singleMachine && runtimeGroups[0]?.runtime ? (
              <MachineFooter
                runtime={runtimeGroups[0].runtime}
                agentCount={runtimeGroups[0].agents.length}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
