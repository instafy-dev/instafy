import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LocalHardwareBinding,
  LocalHardwareIoActionRunResult,
  LocalHardwareIoOpportunity,
} from "@instafy/sdk/hardware-provider";
import {
  SERIAL_HARDWARE_PROVIDER_DESCRIPTOR,
  SERIAL_HARDWARE_PROVIDER_ID,
} from "@instafy/sdk/hardware-provider";
import type { ProviderProjectBinding } from "@instafy/sdk/provider-project-binding";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { useRuntime } from "../../../runtime/useRuntime";
import type { LocalWorkspacePresence } from "../../../services/originTypes";
import { controllerBaseUrl } from "../../../services/runtimeController/core";
import { useStatus } from "../../../status/useStatus";
import {
  createSerialHardwareResourceGrant,
  readProjectHardwareBindingStore,
  revokeProjectHardwareBinding,
  upsertProjectHardwareBinding,
} from "../../../services/runtimeController/hardwareBindings";
import {
  readProjectProviderBindingStore,
  revokeProjectProviderBinding,
} from "../../../services/runtimeController/providerBindings";
import {
  ProviderBindingApprovalModal,
  type ProviderBindingApprovalDefaults,
} from "./ProviderBindingApprovalModal";
import { buildDesktopStudioDeepLink } from "./desktopStudioDeepLink";
import { SettingsSection } from "./SettingsSection";
import { SettingsSurface } from "./SettingsSurface";

interface ProjectProviderBindingsCardProps {
  projectId: string | null;
  canManageAccess?: boolean;
}

function statusLabel(status: ProviderProjectBinding["status"]): string {
  switch (status) {
    case "bound_read_write":
      return "Read + write";
    case "bound_read_only":
      return "Read only";
    default:
      return "Unbound";
  }
}

function hardwareResourceLabel(binding: LocalHardwareBinding): string {
  if (binding.grantedResources.length === 0) {
    return "Any serial device on this runtime host";
  }
  return binding.grantedResources
    .map((resource) => resource.displayName || resource.path)
    .join(", ");
}

function hardwareCapabilityLabel(binding: LocalHardwareBinding): string {
  const labels: string[] = [];
  if (binding.grantedCapabilities.includes("hardware_serial_list")) {
    labels.push("List serial ports");
  }
  if (binding.grantedCapabilities.includes("hardware_serial_probe")) {
    labels.push("Probe serial ports");
  }
  return labels.length > 0 ? labels.join(" + ") : "No capabilities";
}

function opportunityActionLabels(opportunity: LocalHardwareIoOpportunity): string {
  const available = opportunity.actions
    .filter((action) => action.status === "available")
    .map((action) => action.label);
  const planned = opportunity.actions
    .filter((action) => action.status === "planned")
    .map((action) => action.label);
  const parts: string[] = [];
  if (available.length > 0) {
    parts.push(`Now: ${available.join(", ")}`);
  }
  if (planned.length > 0) {
    parts.push(`Planned: ${planned.join(", ")}`);
  }
  return parts.join(" · ");
}

function ioActionStatusLabel(result: LocalHardwareIoActionRunResult): string {
  const probe = result.serialProbe;
  const parts = [result.message];
  if (probe) {
    parts.push(
      `exists: ${probe.exists ? "yes" : "no"}`,
      `readable: ${probe.readable ? "yes" : "no"}`,
      `writable: ${probe.writable ? "yes" : "no"}`,
    );
  }
  if (result.process) {
    parts.push(`exit: ${result.process.exitCode ?? result.process.signal ?? "unknown"}`);
  }
  return parts.join(" · ");
}

function combinedCountLabel(options: {
  providerCount: number;
  hardwareCount: number;
  loading: boolean;
}): string {
  if (options.loading) {
    return "Loading…";
  }
  const parts: string[] = [];
  if (options.providerCount > 0) {
    parts.push(`${options.providerCount} provider${options.providerCount === 1 ? "" : "s"}`);
  }
  if (options.hardwareCount > 0) {
    parts.push(`${options.hardwareCount} runtime host${options.hardwareCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No access";
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function shortRuntimeHostId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function hardwareHostGroupKey(binding: LocalHardwareBinding): string {
  return binding.runtimeHostId ?? "__unknown_host__";
}

function bindingRuntimeHostLabel(binding: LocalHardwareBinding): string {
  return (
    normalizeText(binding.runtimeHostLabel) ??
    (binding.runtimeHostId ? `Runtime ${shortRuntimeHostId(binding.runtimeHostId)}` : "Unknown host")
  );
}

function hardwareBindingTestId(binding: LocalHardwareBinding): string {
  const id = binding.bindingId ?? binding.providerId;
  return id.replace(/[^a-z0-9_.-]+/gi, "-");
}

function hardwareOpportunityTestId(opportunity: LocalHardwareIoOpportunity): string {
  const id = opportunity.resource.displayName ?? opportunity.resource.id;
  return id.replace(/[^a-z0-9_.-]+/gi, "-");
}

function hardwareOpportunityActionTestId(
  opportunity: LocalHardwareIoOpportunity,
  actionId: string,
): string {
  const action = actionId.replace(/[^a-z0-9_.-]+/gi, "-");
  return `${action}-${hardwareOpportunityTestId(opportunity)}`;
}

function ioActionButtonLabel(action: LocalHardwareIoOpportunity["actions"][number]): string {
  return action.label;
}

interface RuntimeHostGrantScope {
  id: string | null;
  label: string;
  detail: string;
  scoped: boolean;
}

interface ProjectWorkspaceSummary {
  sourceCaption: string;
  localPath: string | null;
  localPathLabel: string;
}

interface HardwareHostBindingGroup {
  key: string;
  runtimeHostId: string | null;
  label: string;
  bindings: LocalHardwareBinding[];
}

function isLocalWorkspaceDisconnected(workspace: LocalWorkspacePresence | null): boolean {
  return (
    !workspace ||
    workspace.status === "offline" ||
    workspace.status === "expired" ||
    workspace.presenceStatus === "offline"
  );
}

function resolveProjectWorkspaceSummary(
  localWorkspace: LocalWorkspacePresence | null,
): ProjectWorkspaceSummary {
  const summary: ProjectWorkspaceSummary = {
    sourceCaption: "Stored in Instafy. Desktop and runtimes work on synced copies.",
    localPath: null,
    localPathLabel: "No local copy connected",
  };

  if (isLocalWorkspaceDisconnected(localWorkspace)) {
    return summary;
  }

  const localPath = normalizeText(localWorkspace?.path);
  if (!localPath) {
    return summary;
  }

  const hostname = normalizeText(localWorkspace?.hostname);
  return {
    ...summary,
    localPath,
    localPathLabel: hostname ? `Copy on ${hostname}` : "Local copy",
  };
}

function resolveRuntimeHostGrantScope(
  desktopHostStatus?: InstafyDesktopLocalHardwareHostStatus | null,
): RuntimeHostGrantScope {
  const hasDesktopBridge =
    typeof window !== "undefined" && typeof window.instafyDesktop === "object";
  const fallback: RuntimeHostGrantScope = {
    id: null,
    label: "No local runtime connected",
    detail: hasDesktopBridge
      ? "Start a local runtime to grant hardware."
      : "Open Desktop or connect the CLI to grant hardware.",
    scoped: false,
  };

  if (typeof window === "undefined" || !window.__INSTAFY_RUNTIME__) {
    if (desktopHostStatus?.runtimeHostId) {
      return {
        id: desktopHostStatus.runtimeHostId,
        label: desktopHostStatus.runtimeHostLabel || "Desktop",
        detail: "Grants apply to this Desktop app.",
        scoped: true,
      };
    }
    return fallback;
  }

  try {
    const snapshot = window.__INSTAFY_RUNTIME__.getSnapshot();
    const localWorkspace = snapshot.localWorkspace;
    const runtimeStatuses = snapshot.runtimeStatuses ?? [];
    const runtimeHostId =
      normalizeText(localWorkspace?.runtimeId) ??
      normalizeText(runtimeStatuses.find((entry) => entry.isLocal)?.runtimeId);
    if (!runtimeHostId) {
      if (desktopHostStatus?.runtimeHostId) {
        return {
          id: desktopHostStatus.runtimeHostId,
          label: desktopHostStatus.runtimeHostLabel || "Desktop",
          detail: "Grants apply to this Desktop app.",
          scoped: true,
        };
      }
      return fallback;
    }
    const runtimeEntry =
      runtimeStatuses.find((entry) => entry.runtimeId === runtimeHostId) ??
      runtimeStatuses.find((entry) => entry.isLocal) ??
      null;
    const label =
      normalizeText(localWorkspace?.hostname) ??
      normalizeText(runtimeEntry?.displayName) ??
      `Runtime ${shortRuntimeHostId(runtimeHostId)}`;
    return {
      id: runtimeHostId,
      label,
      detail: `Grants apply to ${label}.`,
      scoped: true,
    };
  } catch {
    if (desktopHostStatus?.runtimeHostId) {
      return {
        id: desktopHostStatus.runtimeHostId,
        label: desktopHostStatus.runtimeHostLabel || "Desktop",
        detail: "Grants apply to this Desktop app.",
        scoped: true,
      };
    }
    return fallback;
  }
}

function groupHardwareBindingsByHost(
  bindings: LocalHardwareBinding[],
): HardwareHostBindingGroup[] {
  const groups = new Map<string, HardwareHostBindingGroup>();
  for (const binding of bindings) {
    const key = hardwareHostGroupKey(binding);
    const existing = groups.get(key);
    if (existing) {
      existing.bindings.push(binding);
      continue;
    }
    groups.set(key, {
      key,
      runtimeHostId: binding.runtimeHostId ?? null,
      label: bindingRuntimeHostLabel(binding),
      bindings: [binding],
    });
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

const LOCAL_RUNTIME_LINK_CLASSNAME =
  "inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-sm shadow-slate-200/40 transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:shadow-none dark:hover:border-slate-600 dark:hover:bg-slate-900";

export function ProjectProviderBindingsCard({
  projectId,
  canManageAccess = true,
}: ProjectProviderBindingsCardProps) {
  const { showStatus } = useStatus();
  const { localWorkspace } = useRuntime();
  const workspaceSummary = useMemo(
    () => resolveProjectWorkspaceSummary(localWorkspace),
    [localWorkspace],
  );
  const desktopFolderBridge =
    typeof window !== "undefined" &&
    typeof window.instafyDesktop?.selectProjectWorkspaceFolder === "function" &&
    typeof window.instafyDesktop?.getProjectWorkspaceBinding === "function"
      ? window.instafyDesktop
      : null;
  const [workspaceFolderBinding, setWorkspaceFolderBinding] = useState<{
    path: string | null;
    defaultPath: string;
  } | null>(null);

  useEffect(() => {
    if (!desktopFolderBridge || !projectId) {
      setWorkspaceFolderBinding(null);
      return;
    }
    let cancelled = false;
    void desktopFolderBridge
      .getProjectWorkspaceBinding!({ projectId })
      .then((result) => {
        if (!cancelled) {
          setWorkspaceFolderBinding(result);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [desktopFolderBridge, projectId]);

  const handleChooseProjectFolder = async () => {
    if (!desktopFolderBridge || !projectId || !canManageAccess) {
      return;
    }
    try {
      const result = await desktopFolderBridge.selectProjectWorkspaceFolder!({
        projectId,
        controllerUrl: controllerBaseUrl,
      });
      if (!result) {
        return;
      }
      if (!result.ok) {
        showStatus(result.reason, "warning", 6000);
        return;
      }
      setWorkspaceFolderBinding((current) => ({
        path: result.path,
        defaultPath: current?.defaultPath ?? "",
      }));
      showStatus(
        result.runtimeRestartRequired
          ? "Folder linked. Restart the local runtime to start using it."
          : "Folder linked. The local runtime will use it for this space's files.",
        "success",
        4000,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message, "error", 5000);
    }
  };

  const handleResetProjectFolder = async () => {
    if (!desktopFolderBridge?.clearProjectWorkspaceBinding || !projectId || !canManageAccess) {
      return;
    }
    try {
      await desktopFolderBridge.clearProjectWorkspaceBinding({ projectId });
      setWorkspaceFolderBinding((current) =>
        current ? { ...current, path: null } : current,
      );
      showStatus("Reset to the managed folder. Restart the local runtime to apply.", "info", 4000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message, "error", 5000);
    }
  };
  const [providerBindings, setProviderBindings] = useState<ProviderProjectBinding[]>([]);
  const [hardwareBindings, setHardwareBindings] = useState<LocalHardwareBinding[]>([]);
  const [providerLoading, setProviderLoading] = useState(false);
  const [hardwareLoading, setHardwareLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalDefaults, setModalDefaults] = useState<ProviderBindingApprovalDefaults>({
    capabilities: ["project_content_read", "project_content_write"],
    preferredPrefix: "",
    purpose: "",
    providerId: "",
    title: "Approve provider access",
    description: "Allow a provider to use this project's files.",
  });
  const [devicePath, setDevicePath] = useState("");
  const [ioOpportunities, setIoOpportunities] = useState<LocalHardwareIoOpportunity[]>([]);
  const [ioOpportunitiesLoading, setIoOpportunitiesLoading] = useState(false);
  const [runtimeHostScope, setRuntimeHostScope] = useState<RuntimeHostGrantScope>(() =>
    resolveRuntimeHostGrantScope(),
  );
  const [providerRevokePendingId, setProviderRevokePendingId] = useState<string | null>(null);
  const [hardwareGrantPending, setHardwareGrantPending] = useState(false);
  const [hardwareRevokePendingId, setHardwareRevokePendingId] = useState<string | null>(null);
  const [ioActionPendingId, setIoActionPendingId] = useState<string | null>(null);
  const [ioActionResult, setIoActionResult] = useState<LocalHardwareIoActionRunResult | null>(
    null,
  );

  const loadProviderBindings = useCallback(async () => {
    if (!projectId) {
      setProviderBindings([]);
      setProviderError(null);
      return;
    }
    setProviderLoading(true);
    setProviderError(null);
    try {
      const store = await readProjectProviderBindingStore({ projectId });
      const nextBindings = Object.values(store.bindings).sort((left, right) =>
        left.providerId.localeCompare(right.providerId),
      );
      setProviderBindings(nextBindings);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setProviderBindings([]);
      setProviderError(message);
    } finally {
      setProviderLoading(false);
    }
  }, [projectId]);

  const loadHardwareBindings = useCallback(async () => {
    if (!projectId) {
      setHardwareBindings([]);
      setHardwareError(null);
      return;
    }
    setHardwareLoading(true);
    setHardwareError(null);
    try {
      const store = await readProjectHardwareBindingStore({ projectId });
      const nextBindings = Object.values(store.bindings).sort((left, right) =>
        left.providerId.localeCompare(right.providerId),
      );
      setHardwareBindings(nextBindings);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setHardwareBindings([]);
      setHardwareError(message);
    } finally {
      setHardwareLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadProviderBindings();
    void loadHardwareBindings();
  }, [loadHardwareBindings, loadProviderBindings]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    const refreshHostScope = async () => {
      const desktopHostStatus = await window.instafyDesktop?.localHardwareHostStatus?.().catch(
        () => null,
      );
      if (cancelled) {
        return;
      }
      setRuntimeHostScope(resolveRuntimeHostGrantScope(desktopHostStatus ?? null));
    };
    void refreshHostScope();
    const intervalId = window.setInterval(() => {
      void refreshHostScope();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.instafyDesktop?.localHardwareIoOpportunities) {
      setIoOpportunities([]);
      return;
    }
    let cancelled = false;
    setIoOpportunitiesLoading(true);
    window.instafyDesktop
      .localHardwareIoOpportunities()
      .then((result) => {
        if (!cancelled) {
          setIoOpportunities(result.opportunities);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIoOpportunities([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIoOpportunitiesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeHostScope.id]);

  const bindingsCountLabel = useMemo(
    () =>
      combinedCountLabel({
        providerCount: providerBindings.length,
        hardwareCount: groupHardwareBindingsByHost(hardwareBindings).length,
        loading: providerLoading || hardwareLoading,
      }),
    [hardwareBindings, hardwareLoading, providerBindings.length, providerLoading],
  );
  const hardwareHostGroups = useMemo(
    () => groupHardwareBindingsByHost(hardwareBindings),
    [hardwareBindings],
  );
  const currentHostGroup = useMemo(() => {
    if (!runtimeHostScope.id) {
      return null;
    }
    return (
      hardwareHostGroups.find((group) => group.runtimeHostId === runtimeHostScope.id) ?? null
    );
  }, [hardwareHostGroups, runtimeHostScope.id]);
  const otherHostGroups = useMemo(
    () =>
      hardwareHostGroups.filter(
        (group) => !runtimeHostScope.id || group.runtimeHostId !== runtimeHostScope.id,
      ),
    [hardwareHostGroups, runtimeHostScope.id],
  );
  const desktopStudioDeepLink = useMemo(() => buildDesktopStudioDeepLink(projectId), [projectId]);
  const isDesktopAppSurface =
    typeof window !== "undefined" && typeof window.instafyDesktop === "object";

  const openCreateModal = () => {
    if (!canManageAccess) {
      return;
    }
    setModalDefaults({
      providerId: "",
      purpose: "",
      preferredPrefix: "",
      capabilities: ["project_content_read", "project_content_write"],
      title: "Approve provider access",
      description: "Allow a provider to use this project's files.",
      saveLabel: "Allow access",
    });
    setModalOpen(true);
  };

  const openEditModal = (binding: ProviderProjectBinding) => {
    if (!canManageAccess) {
      return;
    }
    setModalDefaults({
      providerId: binding.providerId,
      purpose: binding.purpose ?? "",
      preferredPrefix: binding.grantedPrefix ?? "",
      capabilities: binding.grantedCapabilities,
      existingBinding: binding,
      providerIdLocked: true,
      title: `Update ${binding.providerId}`,
      description: "Change what this provider can read, write, or store.",
      saveLabel: "Save access",
    });
    setModalOpen(true);
  };

  const handleProviderRevoke = async (binding: ProviderProjectBinding) => {
    if (!projectId || !canManageAccess) {
      return;
    }
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(`Revoke project access for ${binding.providerId}?`);
    if (!confirmed) {
      return;
    }
    setProviderRevokePendingId(binding.providerId);
    try {
      const ok = await revokeProjectProviderBinding({
        projectId,
        providerId: binding.providerId,
      });
      if (!ok) {
        throw new Error("Unable to revoke provider access.");
      }
      showStatus(`Revoked provider access for ${binding.providerId}.`, "success", 2500);
      await loadProviderBindings();
    } catch (revokeError) {
      const message = revokeError instanceof Error ? revokeError.message : String(revokeError);
      showStatus(message, "error", 4000);
    } finally {
      setProviderRevokePendingId(null);
    }
  };

  const handleHardwareGrant = async () => {
    if (!projectId || !canManageAccess) {
      return;
    }
    const resource = createSerialHardwareResourceGrant(devicePath);
    if (!resource) {
      showStatus("Enter a serial device path before granting local device access.", "error", 3500);
      return;
    }
    setHardwareGrantPending(true);
    try {
      const binding = await upsertProjectHardwareBinding({
        projectId,
        providerId: SERIAL_HARDWARE_PROVIDER_ID,
        runtimeHostId: runtimeHostScope.id,
        runtimeHostLabel: runtimeHostScope.scoped ? runtimeHostScope.label : null,
        purpose: SERIAL_HARDWARE_PROVIDER_DESCRIPTOR.purpose,
        grantedCapabilities: SERIAL_HARDWARE_PROVIDER_DESCRIPTOR.requestedCapabilities,
        grantedResources: [resource],
      });
      if (!binding) {
        throw new Error("Unable to grant local device access.");
      }
      showStatus(`Granted serial access for ${runtimeHostScope.label}.`, "success", 2500);
      setDevicePath("");
      await loadHardwareBindings();
    } catch (grantError) {
      const message = grantError instanceof Error ? grantError.message : String(grantError);
      showStatus(message, "error", 4000);
    } finally {
      setHardwareGrantPending(false);
    }
  };

  const handleIoActionRun = async (
    opportunity: LocalHardwareIoOpportunity,
    actionId: LocalHardwareIoOpportunity["actions"][number]["id"],
  ) => {
    if (!canManageAccess) {
      return;
    }
    if (typeof window === "undefined" || !window.instafyDesktop?.localHardwareIoRunAction) {
      showStatus("Open Desktop or connect a runtime before running host IO.", "error", 3500);
      return;
    }
    const action = opportunity.actions.find((entry) => entry.id === actionId);
    if (!action || action.status !== "available") {
      showStatus("No runnable IO action is available for this opportunity yet.", "error", 3500);
      return;
    }
    const pendingId = `${opportunity.id}:${action.id}`;
    if (opportunity.resource.kind === "serial_device") {
      setDevicePath(opportunity.resource.path);
    }
    setIoActionResult(null);
    setIoActionPendingId(pendingId);
    try {
      const result = await window.instafyDesktop.localHardwareIoRunAction({
        actionId: action.id,
        resource: opportunity.resource,
      });
      setIoActionResult(result);
      showStatus(result.message, result.ok ? "success" : "error", 3500);
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : String(runError);
      showStatus(message, "error", 4000);
    } finally {
      setIoActionPendingId(null);
    }
  };

  const handleHardwareRevoke = async (binding: LocalHardwareBinding) => {
    if (!projectId || !canManageAccess) {
      return;
    }
    const hostLabel = bindingRuntimeHostLabel(binding);
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(`Revoke local device access for ${hostLabel}?`);
    if (!confirmed) {
      return;
    }
    const pendingId = binding.bindingId ?? binding.providerId;
    setHardwareRevokePendingId(pendingId);
    try {
      const ok = await revokeProjectHardwareBinding({
        projectId,
        providerId: binding.providerId,
        bindingId: binding.bindingId ?? null,
        runtimeHostId: binding.runtimeHostId ?? null,
      });
      if (!ok) {
        throw new Error("Unable to revoke local device access.");
      }
      showStatus(`Revoked local device access for ${hostLabel}.`, "success", 2500);
      await loadHardwareBindings();
    } catch (revokeError) {
      const message = revokeError instanceof Error ? revokeError.message : String(revokeError);
      showStatus(message, "error", 4000);
    } finally {
      setHardwareRevokePendingId(null);
    }
  };

  return (
    <>
      <SettingsSection
        title="Connections"
        description="Project files, providers, and local hardware access."
        actions={
          <Text variant="caption" tone="muted" data-testid="project-provider-bindings-count">
            {bindingsCountLabel}
          </Text>
        }
      >
        <div className="grid gap-4" data-testid="project-provider-bindings-card">
          <SettingsSurface className="space-y-3" data-testid="project-workspace-source-panel">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Text variant="bodyStrong" tone="primary">
                  Project files
                </Text>
                <Text variant="caption" tone="muted" className="mt-1">
                  {workspaceSummary.sourceCaption}
                </Text>
              </div>
              <div
                className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/60 sm:max-w-[50%]"
                data-testid="project-workspace-local-copy"
              >
                <Text variant="caption" tone="muted">
                  {workspaceSummary.localPathLabel}
                </Text>
                {workspaceSummary.localPath ? (
                  <Text
                    variant="caption"
                    tone="primary"
                    className="mt-1 break-all"
                    data-testid="project-workspace-local-path"
                  >
                    {workspaceSummary.localPath}
                  </Text>
                ) : null}
              </div>
            </div>
            {desktopFolderBridge && projectId ? (
              <div
                className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
                data-testid="project-workspace-folder-binding"
              >
                <div className="min-w-0">
                  <Text variant="caption" tone="muted" className="block">
                    {workspaceFolderBinding?.path ? "Linked folder" : "Managed folder on this computer"}
                  </Text>
                  <Text
                    variant="caption"
                    tone="primary"
                    className="mt-1 block break-all"
                    data-testid="project-workspace-folder-path"
                  >
                    {workspaceFolderBinding?.path ?? workspaceFolderBinding?.defaultPath ?? "Loading folder…"}
                  </Text>
                </div>
                <div className="flex gap-2">
                  <Button
                    onPress={() => void handleChooseProjectFolder()}
                    variant="outline"
                    size="xs"
                    radius="full"
                    data-testid="project-workspace-folder-choose"
                    isDisabled={!canManageAccess}
                  >
                    {workspaceFolderBinding?.path ? "Change folder…" : "Choose folder…"}
                  </Button>
                  {workspaceFolderBinding?.path ? (
                    <Button
                      onPress={() => void handleResetProjectFolder()}
                      variant="ghost"
                      size="xs"
                      radius="full"
                      data-testid="project-workspace-folder-reset"
                      isDisabled={!canManageAccess}
                    >
                      Reset
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </SettingsSurface>

          <SettingsSurface className="space-y-3" data-testid="project-provider-bindings-panel">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Text variant="bodyStrong" tone="primary">
                  Project providers
                </Text>
                <Text variant="caption" tone="muted" className="mt-1">
                  File access for external tools.
                </Text>
              </div>
              <Button
                onPress={openCreateModal}
                variant="outline"
                size="sm"
                radius="xl"
                isDisabled={!projectId || !canManageAccess}
                className="w-full sm:w-auto"
                data-testid="project-provider-bindings-add"
              >
                Grant provider
              </Button>
            </div>

            {providerError ? (
              <Text variant="caption" tone="danger" data-testid="project-provider-bindings-error">
                {providerError}
              </Text>
            ) : null}

            {!providerError && providerLoading ? (
              <Text variant="caption" tone="muted">
                Loading provider access…
              </Text>
            ) : null}

            {!providerError && !providerLoading && providerBindings.length === 0 ? (
              <Text variant="caption" tone="muted">
                No project providers yet.
              </Text>
            ) : null}

            {!providerError && providerBindings.length > 0 ? (
              <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
                {providerBindings.map((binding) => (
                  <div
                    key={binding.providerId}
                    className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                    data-testid={`project-provider-binding-${binding.providerId}`}
                  >
                    <div className="min-w-0">
                      <Text variant="bodyStrong" tone="primary" className="truncate">
                        {binding.providerId}
                      </Text>
                      <Text variant="caption" tone="muted" className="mt-1">
                        {statusLabel(binding.status)} access
                      </Text>
                      {binding.purpose ? (
                        <Text variant="caption" tone="muted" className="mt-1">
                          {binding.purpose}
                        </Text>
                      ) : null}
                      {binding.rootUri ? (
                        <Text variant="caption" tone="muted" className="mt-1 break-all">
                          Root: {binding.rootUri}
                        </Text>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onPress={() => openEditModal(binding)}
                        variant="outline"
                        size="xs"
                        radius="full"
                        data-testid={`project-provider-binding-edit-${binding.providerId}`}
                        isDisabled={!canManageAccess}
                      >
                        Edit
                      </Button>
                      <Button
                        onPress={() => void handleProviderRevoke(binding)}
                        variant="ghost"
                        size="xs"
                        radius="full"
                        isDisabled={!canManageAccess || providerRevokePendingId === binding.providerId}
                        data-testid={`project-provider-binding-revoke-${binding.providerId}`}
                      >
                        {providerRevokePendingId === binding.providerId ? "Revoking…" : "Revoke"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsSurface>

          <SettingsSurface className="space-y-3" data-testid="project-hardware-bindings-panel">
            <div>
              <Text variant="bodyStrong" tone="primary">
                Local hardware
              </Text>
              <Text variant="caption" tone="muted" className="mt-1">
                Serial devices this runtime can probe on demand.
              </Text>
              {!isDesktopAppSurface ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={desktopStudioDeepLink}
                    className={LOCAL_RUNTIME_LINK_CLASSNAME}
                    data-testid="project-hardware-open-desktop"
                  >
                    Open in Desktop
                  </a>
                  <a
                    href="/install"
                    target="_blank"
                    rel="noreferrer"
                    className={LOCAL_RUNTIME_LINK_CLASSNAME}
                    data-testid="project-hardware-install-desktop"
                  >
                    Install Desktop
                  </a>
                </div>
              ) : null}
            </div>

            <div
              className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-950/60"
              data-testid="project-hardware-current-host"
            >
              <Text variant="caption" tone="muted">
                Current host
              </Text>
              <Text variant="bodyStrong" tone="primary" className="mt-1 break-words">
                {runtimeHostScope.label}
              </Text>
              <Text variant="caption" tone="muted" className="mt-1">
                {runtimeHostScope.detail}
              </Text>
            </div>

            {hardwareError ? (
              <Text variant="caption" tone="danger" data-testid="project-hardware-bindings-error">
                {hardwareError}
              </Text>
            ) : null}

            {runtimeHostScope.scoped ? (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <div className="min-w-0">
                  <Text variant="caption" tone="muted">
                    Available actions
                  </Text>
                  <Text variant="caption" tone="muted" className="mt-1">
                    Probe a detected serial device, then grant access if this project needs it.
                  </Text>
                  {ioOpportunitiesLoading ? (
                    <Text variant="caption" tone="muted" className="mt-2">
                      Scanning local devices…
                    </Text>
                  ) : null}
                  {!ioOpportunitiesLoading && ioOpportunities.length > 0 ? (
                    <div
                      className="mt-2 grid gap-2"
                      data-testid="project-hardware-io-opportunities"
                    >
                      {ioOpportunities.map((opportunity) => (
                        <div
                          key={opportunity.id}
                          className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm shadow-slate-200/40 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:shadow-none"
                          data-testid={`project-hardware-io-opportunity-${hardwareOpportunityTestId(opportunity)}`}
                        >
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => {
                                if (opportunity.resource.kind === "serial_device") {
                                  setDevicePath(opportunity.resource.path);
                                }
                              }}
                              title={opportunity.resource.path}
                            >
                              <span className="block font-medium text-slate-900 dark:text-slate-100">
                                {opportunity.title}
                                {opportunity.available ? "" : " · not ready"}
                              </span>
                              <span className="mt-1 block text-slate-500 dark:text-slate-400">
                                {opportunityActionLabels(opportunity)}
                              </span>
                            </button>
                            <div className="flex flex-wrap gap-2">
                              {opportunity.actions
                                .filter((action) => action.status === "available")
                                .map((action) => {
                                  const pendingId = `${opportunity.id}:${action.id}`;
                                  const testId =
                                    action.id === "serial.probe"
                                      ? `project-hardware-io-probe-${hardwareOpportunityTestId(opportunity)}`
                                      : `project-hardware-io-action-${hardwareOpportunityActionTestId(
                                          opportunity,
                                          action.id,
                                        )}`;
                                  return (
                                    <Button
                                      key={action.id}
                                      onPress={() => void handleIoActionRun(opportunity, action.id)}
                                      variant="outline"
                                      size="xs"
                                      radius="full"
                                      isDisabled={!canManageAccess || ioActionPendingId === pendingId}
                                      data-testid={testId}
                                    >
                                      {ioActionPendingId === pendingId
                                        ? "Running…"
                                        : ioActionButtonLabel(action)}
                                    </Button>
                                  );
                                })}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {ioActionResult ? (
                    <Text
                      variant="caption"
                      tone={ioActionResult.ok ? "success" : "danger"}
                      className="mt-2 block"
                      data-testid="project-hardware-io-action-result"
                    >
                      {ioActionStatusLabel(ioActionResult)}
                    </Text>
                  ) : null}
                  {!ioOpportunitiesLoading && isDesktopAppSurface && ioOpportunities.length === 0 ? (
                    <Text variant="caption" tone="muted" className="mt-2">
                      No local devices found.
                    </Text>
                  ) : null}
                  <div className="mt-3">
                    <Text variant="caption" tone="muted">
                      Device path to grant
                    </Text>
                    <Input
                      value={devicePath}
                      onChange={(event) => setDevicePath(event.target.value)}
                      placeholder="/dev/cu.usbserial-130"
                      disabled={!projectId || !canManageAccess || hardwareGrantPending}
                      data-testid="project-hardware-serial-device"
                      className="mt-1"
                    />
                    <Text variant="caption" tone="muted" className="mt-1">
                      Save access for a serial device on this host.
                    </Text>
                  </div>
                </div>
                <Button
                  onPress={handleHardwareGrant}
                  isDisabled={!projectId || !canManageAccess || hardwareGrantPending || devicePath.trim().length === 0}
                  variant="outline"
                  size="sm"
                  radius="xl"
                  className="w-full md:w-auto"
                  data-testid="project-hardware-grant"
                >
                  {hardwareGrantPending ? "Granting…" : "Grant access"}
                </Button>
              </div>
            ) : null}

            {currentHostGroup ? (
              <HardwareHostSavedAccess
                title="Saved on this host"
                group={currentHostGroup}
                pendingId={hardwareRevokePendingId}
                canRevoke={canManageAccess}
                onRevoke={handleHardwareRevoke}
              />
            ) : null}

            {!hardwareError && hardwareLoading ? (
              <Text variant="caption" tone="muted">
                Loading local devices…
              </Text>
            ) : null}

            {!hardwareError && !hardwareLoading && hardwareBindings.length === 0 ? (
              <Text variant="caption" tone="muted">
                No grants yet.
              </Text>
            ) : null}

            {!hardwareError && otherHostGroups.length > 0 ? (
              <div className="space-y-2" data-testid="project-hardware-other-hosts">
                <Text variant="caption" tone="muted">
                  Other hosts
                </Text>
                {otherHostGroups.map((group) => (
                  <HardwareHostSavedAccess
                    key={group.key}
                    group={group}
                    pendingId={hardwareRevokePendingId}
                    canRevoke={canManageAccess}
                    onRevoke={handleHardwareRevoke}
                  />
                ))}
              </div>
            ) : null}
          </SettingsSurface>
        </div>
      </SettingsSection>

      <ProviderBindingApprovalModal
        isOpen={modalOpen}
        projectId={projectId}
        defaults={modalDefaults}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          void loadProviderBindings();
        }}
      />
    </>
  );
}

function HardwareHostSavedAccess({
  title,
  group,
  pendingId,
  canRevoke,
  onRevoke,
}: {
  title?: string;
  group: HardwareHostBindingGroup;
  pendingId: string | null;
  canRevoke: boolean;
  onRevoke: (binding: LocalHardwareBinding) => void;
}) {
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950"
      data-testid={`project-hardware-host-group-${group.key.replace(/[^a-z0-9_.-]+/gi, "-")}`}
    >
      {title ? (
        <Text variant="caption" tone="muted">
          {title}
        </Text>
      ) : null}
      <Text variant="bodyStrong" tone="primary" className={title ? "mt-1 truncate" : "truncate"}>
        {group.label}
      </Text>
      {group.runtimeHostId ? (
        <Text variant="caption" tone="muted" className="mt-1 break-all">
          Host id: {group.runtimeHostId}
        </Text>
      ) : null}
      <div className="mt-2 divide-y divide-slate-200/70 dark:divide-slate-800">
        {group.bindings.map((binding) => {
          const pendingKey = binding.bindingId ?? binding.providerId;
          return (
            <div
              key={pendingKey}
              className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
              data-testid={`project-hardware-binding-${hardwareBindingTestId(binding)}`}
            >
              <div className="min-w-0">
                <Text variant="caption" tone="muted" className="break-words">
                  {hardwareResourceLabel(binding)}
                </Text>
                <Text variant="caption" tone="muted" className="mt-1 break-words">
                  {hardwareCapabilityLabel(binding)}
                </Text>
              </div>
              <Button
                onPress={() => onRevoke(binding)}
                variant="ghost"
                size="xs"
                radius="full"
                isDisabled={!canRevoke || pendingId === pendingKey}
                data-testid={`project-hardware-binding-revoke-${hardwareBindingTestId(binding)}`}
              >
                {pendingId === pendingKey ? "Revoking…" : "Revoke"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
