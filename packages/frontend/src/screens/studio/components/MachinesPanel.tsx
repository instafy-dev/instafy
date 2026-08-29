import { useEffect, useState } from "react";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import { SettingsShell } from "./SettingsShell";
import { Text } from "../../../components/Text";
import { RuntimeMenuPanel } from "../../../runtime/components/RuntimeMenuPanel";
import { useRuntimeMenuOptions } from "../../../runtime/useRuntimeMenu";
import {
  listMyAgents,
  type ControllerAgentProfile,
} from "../../../services/runtimeController/agents";
import { useMachinesPanelFocus, setMachinesPanelFocus } from "./machinesPanelStore";

/**
 * The canonical machines surface: every runtime this workspace can reach, with
 * status, size, CPU/RAM history, and lifecycle controls — reusing the same
 * RuntimeMenuPanel machinery the runtime selector uses, at page width. Reached
 * from the left rail and deep-linked from the conversation panel's machine
 * links (the focused machine scrolls into view and flashes).
 */

const READY_STATES = new Set(["ready", "online", "healthy"]);

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
    runtimeEnsureError,
    runtimeEnsureLimit,
  } = ops;

  // Agents per machine: pinned agents name their runtime directly; unpinned
  // ones ride the workspace's current shared machine (auto resolved to the
  // concrete ready box when one exists — auto is a policy, not a place).
  const [agents, setAgents] = useState<ControllerAgentProfile[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listMyAgents().then((result) => {
      if (!cancelled && result.success) setAgents(result.agents);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
  // clear the one-shot focus so revisits start neutral.
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

  const machinesWithAgents = runtimeOptions.filter(
    (option) => option.id && agentsByRuntimeId.has(option.id),
  );

  return (
    <SettingsShell
      testId="machines-panel"
      title="Machines"
      subtitle="The runtimes your agents run in — status, size, resource history, and controls."
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
        onCopyTunnel={copyTunnelDetails}
        listClassName="mt-2 pr-1"
        emptyStateMessage="No machines are connected yet — send an agent a message and the shared cloud runtime boots on demand."
      />

      {machinesWithAgents.length > 0 ? (
        <div className="mt-4" data-testid="machines-agents-summary">
          <Text as="div" variant="caption" tone="subtle" className="pb-1 text-xxs font-medium">
            Agents by machine
          </Text>
          {machinesWithAgents.map((option) => (
            <div key={option.id} className="flex items-center gap-2 py-1">
              <Text
                as="span"
                variant="caption"
                tone="muted"
                className="min-w-0 max-w-[45%] truncate text-xxs"
              >
                {option.label}
              </Text>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {(agentsByRuntimeId.get(option.id as string) ?? []).map((agent) => (
                  <span
                    key={agent.id}
                    className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-0.5 pr-2 text-xxs text-slate-600 dark:bg-white/[0.07] dark:text-slate-300"
                  >
                    <ChatMessageAvatar
                      kind="assistant"
                      agent={{ handle: agent.handle, avatarSeed: agent.avatarSeed }}
                      size="2xs"
                    />
                    @{agent.handle}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </SettingsShell>
  );
}
