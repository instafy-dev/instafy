import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Xmark } from "iconoir-react";
import {
  Button as AriaButton,
  DialogTrigger,
  MenuTrigger,
} from "react-aria-components";
import { AgentProfilePopoverCard } from "./AssistantAvatarPopover";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { formatRuntimeResourcesSummary } from "./chatRuntimeResources";
import { getBuiltInAssistantDisplayName } from "../../../assistants/localBuiltInAssistantCatalog";
import { SettingsShell } from "./SettingsShell";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import {
  StudioMenu,
  StudioMenuItem,
} from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { RuntimeMenuPanel } from "../../../runtime/components/RuntimeMenuPanel";
import {
  useRuntimeMenuOptions,
  type RuntimeMenuOption,
} from "../../../runtime/useRuntimeMenu";
import { useProjects } from "../../../projects/useProjects";
import {
  listMyAgents,
  updateMyAgent,
  type ControllerAgentProfile,
} from "../../../services/runtimeController/agents";
import {
  useMachinesPanelFocus,
  setMachinesPanelFocus,
} from "./machinesPanelStore";

/**
 * The canonical machines surface: every runtime this workspace can reach, with
 * status, size, CPU/RAM history, and lifecycle controls — reusing the same
 * RuntimeMenuPanel machinery the runtime selector uses, at page width. Reached
 * from the left rail and deep-linked from the conversation panel's machine
 * links (the focused machine scrolls into view and flashes).
 *
 * Also the home of per-agent runtime PINNING. The default is unpinned — agents
 * ride the workspace's shared machine, and that stays the norm. Pinning is the
 * deliberate exception (native/local work, isolation, a differently-sized box),
 * so its controls live here where machines are the subject: assign an agent to
 * a machine, or unpin it back to shared. A pin is strict — the page surfaces an
 * offline pinned machine rather than silently falling back to shared.
 */

const READY_STATES = new Set(["ready", "online", "healthy"]);

function AssignAgentMenu({
  machine,
  candidates,
  disabledReason,
  onAssign,
}: {
  machine: RuntimeMenuOption;
  candidates: ControllerAgentProfile[];
  disabledReason: string | null;
  onAssign: (agentId: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (candidates.length === 0) return null;
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        radius="full"
        isDisabled={disabledReason != null}
        aria-label={`Pin an agent to ${machine.label}`}
        aria-haspopup="menu"
        title={
          disabledReason ??
          "Pinned agents always run on this machine; unpinned ones ride the shared machine."
        }
        data-testid={`machines-assign-agent-${machine.id ?? "unknown"}`}
        onPress={() => {
          if (!open) setOpen(true);
        }}
        className="inline-flex items-center gap-1 border-0 bg-transparent px-1.5 py-0.5 text-xxs text-slate-500 shadow-none hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200"
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        Pin agent
      </Button>
      <StudioPopover
        triggerRef={triggerRef}
        isNonModal
        placement="bottom start"
        offset={4}
        className="min-w-[11rem] p-2"
      >
        <StudioMenu
          aria-label={`Pin an agent to ${machine.label}`}
          onAction={(key) => {
            onAssign(String(key));
            setOpen(false);
          }}
          className="space-y-1"
        >
          {candidates.map((agent) => (
            <StudioMenuItem key={agent.id} id={agent.id}>
              @{agent.handle}
            </StudioMenuItem>
          ))}
        </StudioMenu>
      </StudioPopover>
    </MenuTrigger>
  );
}

export function MachinesPanel() {
  const runtimeMenu = useRuntimeMenuOptions();
  const { runtime: ops, runtimeOptions } = runtimeMenu;
  const {
    preferredRuntimeId,
    setPreferredRuntime,
    ensureHostedRuntime,
    hostedRuntimeEnsuring,
    hostedRuntimeTakeoverInProgress,
    takeOverHostedRuntimeLimit,
    copyTunnelDetails,
    terminateRuntime,
    removeRuntime,
    startRuntime,
    showDesktopRuntimeHelp,
    runtimeEnsureError,
    runtimeEnsureLimit,
    refreshRuntimeStatuses,
  } = ops;
  const { activeProjectId } = useProjects();

  // A stats page should stay current: runtime status updates are otherwise
  // event-driven, and a quiet machine emits almost none — leaving the CPU/RAM
  // sparklines stuck at a single dot. Poll while mounted so history accrues.
  useEffect(() => {
    void refreshRuntimeStatuses();
    const id = window.setInterval(() => void refreshRuntimeStatuses(), 10_000);
    return () => window.clearInterval(id);
  }, [refreshRuntimeStatuses]);

  // Agents per machine: pinned agents name their runtime directly; unpinned
  // ones ride the workspace's current shared machine (auto resolved to the
  // concrete ready box when one exists — auto is a policy, not a place).
  const [agents, setAgents] = useState<ControllerAgentProfile[]>([]);
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  // Pins are PER-PROJECT (user_agent_project_settings), so the list must be
  // fetched with the active project or every runtimeId comes back null.
  const refreshAgents = useCallback(() => {
    void listMyAgents({ projectId: activeProjectId ?? null }).then((result) => {
      if (result.success) setAgents(result.agents);
    });
  }, [activeProjectId]);
  useEffect(() => {
    refreshAgents();
  }, [refreshAgents]);

  // Pin/unpin write path — the same updateMyAgent rail every agent setting
  // uses. Default stays unpinned (runtimeId null = ride the shared machine);
  // pins are validated against the active project, so both directions need one.
  const pinDisabledReason = activeProjectId
    ? null
    : "Open a space to pin agents to machines.";
  const saveAgentRuntime = useCallback(
    (agentId: string, runtimeId: string | null) => {
      if (!activeProjectId) return;
      setSavingAgentId(agentId);
      setPinError(null);
      void updateMyAgent(agentId, { runtimeId, projectId: activeProjectId })
        .then((result) => {
          if (!result.success) {
            setPinError(result.error ?? "Couldn't update the agent's machine.");
            return;
          }
          refreshAgents();
        })
        .finally(() => setSavingAgentId(null));
    },
    [activeProjectId, refreshAgents],
  );

  const sharedRuntimeId = (() => {
    const current = runtimeMenu.currentRuntime;
    if (current?.id && !current.isAuto) return current.id;
    const concrete = runtimeOptions.find(
      (option) =>
        Boolean(option.id) &&
        !option.isAuto &&
        READY_STATES.has(String(option.state ?? "").toLowerCase()),
    );
    return concrete?.id ?? current?.id ?? null;
  })();

  const agentsByRuntimeId = new Map<string, ControllerAgentProfile[]>();
  for (const agent of agents) {
    const runtimeId = agent.runtimeId?.trim() || sharedRuntimeId;
    if (!runtimeId) continue;
    const bucket = agentsByRuntimeId.get(runtimeId);
    if (bucket) bucket.push(agent);
    else agentsByRuntimeId.set(runtimeId, [agent]);
  }

  // Deep-link focus: scroll the named machine into view and flash it, then
  // clear the one-shot focus so revisits start neutral. Read before first
  // render so the focused machine also starts expanded.
  const focusRuntimeId = useMachinesPanelFocus();
  useEffect(() => {
    if (!focusRuntimeId) return;
    const node = document.querySelector<HTMLElement>(
      `[data-runtime-option-id="${CSS.escape(focusRuntimeId)}"]`,
    );
    if (node) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add(
        "rounded-xl",
        "ring-2",
        "ring-primary-400/70",
        "transition-shadow",
      );
      const timer = window.setTimeout(() => {
        node.classList.remove("ring-2", "ring-primary-400/70");
      }, 1800);
      setMachinesPanelFocus(null);
      return () => window.clearTimeout(timer);
    }
    setMachinesPanelFocus(null);
  }, [focusRuntimeId]);

  // This is a stats page: the first (or deep-link-focused) machine starts with
  // its details — sparklines, facts, agents — open, no click required.
  const firstConcreteId =
    runtimeOptions.find((option) => Boolean(option.id) && !option.isAuto)?.id ??
    null;
  const defaultExpandedOptionId = focusRuntimeId ?? firstConcreteId;

  // Agents + pinning render INSIDE each machine's card (no separate section —
  // the machine is named once). Only concrete machines can host pins.
  const renderMachineAgents = (option: RuntimeMenuOption) => {
    const machineId = option.id;
    if (!machineId || option.isAuto) return null;
    const machineAgents = agentsByRuntimeId.get(machineId) ?? [];
    const candidates = agents.filter(
      (agent) => (agent.runtimeId?.trim() || null) !== machineId,
    );
    if (machineAgents.length === 0 && candidates.length === 0) return null;
    return (
      // Labeled like the metric rows so the chips start on the card's shared
      // content edge instead of hanging in the label column.
      <div
        className="flex items-start gap-3"
        data-testid={`machines-card-agents-${machineId}`}
      >
        <Text
          as="span"
          variant="caption"
          tone="muted"
          className="w-14 shrink-0 pt-1 text-right text-xxs"
        >
          Agents
        </Text>
        <div className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {machineAgents.map((agent) => {
              const pinnedHere =
                (agent.runtimeId?.trim() || null) === machineId;
              return (
                <span
                  key={agent.id}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-0.5 pr-2 text-xxs text-slate-600 dark:bg-white/[0.07] dark:text-slate-300"
                  data-testid={`machines-agent-chip-${agent.handle}`}
                  title={
                    pinnedHere
                      ? `@${agent.handle} is pinned to this machine`
                      : `@${agent.handle} rides the shared machine (default)`
                  }
                >
                  {/* Avatar + handle open the agent's profile; the unpin
                      control stays a sibling so no buttons nest. */}
                  <DialogTrigger>
                    <AriaButton
                      aria-label={`View profile for @${agent.handle}`}
                      data-testid={`machines-agent-profile-${agent.handle}`}
                      className="inline-flex min-w-0 items-center gap-1 rounded-full outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-primary-500/40"
                    >
                      <ChatMessageAvatar
                        kind="assistant"
                        agent={{
                          handle: agent.handle,
                          avatarSeed: agent.avatarSeed,
                        }}
                        size="2xs"
                      />
                      <span className="max-w-[9rem] truncate">
                        @{agent.handle}
                      </span>
                    </AriaButton>
                    <AgentProfilePopoverCard
                      placement="bottom start"
                      agentHandle={agent.handle}
                      agentId={agent.id}
                      agentAvatarSeed={agent.avatarSeed || agent.handle}
                      displayName={
                        getBuiltInAssistantDisplayName(agent.handle) ??
                        (agent.displayName?.trim()
                          ? agent.displayName.trim()
                          : `@${agent.handle}`)
                      }
                      pinnedRuntimeId={agent.runtimeId ?? null}
                      runtimeLabel={option.label}
                      runtimeState={String(option.state ?? "unknown")}
                      resourcesSummary={formatRuntimeResourcesSummary(
                        option.resources ?? null,
                      )}
                    />
                  </DialogTrigger>
                  {pinnedHere ? (
                    // Only an explicit pin can be removed; shared riders aren't
                    // pinned, so they carry no unpin control.
                    <button
                      type="button"
                      aria-label={`Unpin @${agent.handle} (back to shared)`}
                      disabled={savingAgentId === agent.id}
                      onClick={() => saveAgentRuntime(agent.id, null)}
                      data-testid={`machines-unpin-${agent.handle}`}
                      className="ml-0.5 inline-flex text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                    >
                      <Xmark className="h-3 w-3" aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              );
            })}
            <AssignAgentMenu
              machine={option}
              candidates={candidates}
              disabledReason={pinDisabledReason}
              onAssign={(agentId) => saveAgentRuntime(agentId, machineId)}
            />
          </span>
          {pinError ? (
            <Text
              as="p"
              variant="caption"
              tone="danger"
              className="pt-1 text-xxs"
              data-testid="machines-pin-error"
            >
              {pinError}
            </Text>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <SettingsShell
      testId="machines-panel"
      title="Machines"
      subtitle="Status, size, resource history, and controls for the machines your agents run on."
    >
      <RuntimeMenuPanel
        showHeader={false}
        runtimeEnsureError={runtimeEnsureError}
        runtimeEnsureLimit={runtimeEnsureLimit}
        connectionWarning={null}
        onRetryHosted={ensureHostedRuntime}
        hostedRuntimeEnsuring={hostedRuntimeEnsuring}
        onTakeOverHostedRuntimeLimit={takeOverHostedRuntimeLimit}
        hostedRuntimeTakeoverInProgress={hostedRuntimeTakeoverInProgress}
        runtimeOptions={runtimeOptions}
        selectedRuntimeId={preferredRuntimeId}
        onSelectOption={(runtimeId) => void setPreferredRuntime(runtimeId)}
        onTerminateRuntime={(runtimeId) => void terminateRuntime(runtimeId)}
        onRemoveRuntime={(runtimeId) => void removeRuntime(runtimeId)}
        onStartRuntime={(runtimeId) => void startRuntime(runtimeId)}
        onShowSelfHostHelp={showDesktopRuntimeHelp}
        onCopyTunnel={copyTunnelDetails}
        listClassName="mt-2 pr-1"
        emptyStateMessage="No machines are connected yet — send an agent a message and the shared cloud runtime boots on demand."
        defaultExpandedOptionId={defaultExpandedOptionId}
        renderOptionExtras={renderMachineAgents}
        sparklineVariant="page"
        headerActions
      />
    </SettingsShell>
  );
}
