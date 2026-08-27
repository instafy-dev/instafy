import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brain, NavArrowDown, NavArrowRight, Settings, WarningTriangle, Xmark } from "iconoir-react";
import { DialogTrigger } from "react-aria-components";
import { RuntimeMenuPanel } from "../../../runtime/components/RuntimeMenuPanel";
import { EntityRow } from "../../../components/EntityRow";
import { ResponsiveDialogSurface } from "../../../components/aria/ResponsiveDialogSurface";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { Toggle } from "../../../components/Toggle";
import { ModelMenuSelect } from "./ModelMenuSelect";
import { useStatus } from "../../../status/useStatus";
import { useCredits } from "../../../credits/useCredits";
import {
  controllerClient,
  type ControllerCredentialListItem,
  type ControllerAgentProfile,
} from "../../../sdk/instafy";
import { formatCredentialRuntimeDetail, resolveCredentialLabel } from "../../../utils/credentialFormatting";
import {
  runtimeEntryIsBooting,
  runtimeEntryIsReady,
} from "../../../runtime/utils/runtimeEntry";
import {
  OCTO_AVATAR_SRC,
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import {
  modelOptionsForProvider,
  normalizeAiModelId,
  normalizeAiProviderId,
  type AiProviderId,
} from "../../../utils/aiProviderModels";
import {
  getDefaultAssistantDefinition,
  getDefaultAssistantHandle,
  isReservedBuiltInAgentHandle,
} from "../../../assistants/localBuiltInAssistantCatalog";

const { update: updateMyAgent } = controllerClient.agents;
const defaultAssistantHandle = getDefaultAssistantHandle();
const defaultAssistantDefinition = getDefaultAssistantDefinition();

type RuntimeMenuHookResult = ReturnType<
  typeof import("../../../runtime/useRuntimeMenu").useRuntimeMenuOptions
>;

interface OctoAgentChipProps {
  runtimeMenu: RuntimeMenuHookResult;
  runtimeReady: boolean;
  projectId: string | null;
  assistantEnabled: boolean;
  conversationId: string | null;
  onAssistantEnabledChange: (conversationId: string | null, enabled: boolean) => void;
  extraAgentHandles: string[];
  availableAgents: ControllerAgentProfile[];
  onAddAgentHandle: (conversationId: string | null, handle: string) => void;
  onRemoveAgentHandle: (conversationId: string | null, handle: string) => void;
  onEditAgentProfile?: (handle: string) => void;
  credentials: ControllerCredentialListItem[];
  credentialsReady: boolean;
  onCredentialsRefresh: () => void;
  pendingByAgentHandle?: ReadonlyMap<string, number>;
  onOpenAiOnboarding: () => void;
  onOpenAiManager?: () => void;
  onOpenCredits?: () => void;
  isDisabled?: boolean;
  triggerClassName?: string;
  suppressLoadingIndicator?: boolean;
}

interface PopoverSectionProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

const AGENT_RUNTIME_MODE_STORAGE_PREFIX = "instafy.runtime.agentMode.v1";

function compactRuntimeId(runtimeId: string | null): string | null {
  const trimmed = (runtimeId ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= 10) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}`;
}

function formatBytesCompact(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
  const rounded = Math.round(value * 10 ** decimals) / 10 ** decimals;
  return `${rounded} ${units[unitIndex]}`;
}

function formatUsagePair(
  used: number | null | undefined,
  limit: number | null | undefined,
): string | null {
  if (typeof used !== "number" || Number.isNaN(used) || used < 0) {
    return null;
  }
  const usedLabel = formatBytesCompact(used);
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return usedLabel;
  }
  return `${usedLabel} / ${formatBytesCompact(limit)}`;
}

function formatCpuLimitCores(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) {
    return `${rounded} cores`;
  }
  return `${rounded.toFixed(1)} cores`;
}

function formatRuntimeResourcesSummary(resources: {
  cpuPct?: number | null;
  cpuLimitCores?: number | null;
  memoryUsedBytes?: number | null;
  memoryLimitBytes?: number | null;
  diskUsedBytes?: number | null;
  diskLimitBytes?: number | null;
} | null | undefined): string | null {
  if (!resources) {
    return null;
  }
  const segments: string[] = [];
  const cpuLimitCores = formatCpuLimitCores(resources.cpuLimitCores);
  if (typeof resources.cpuPct === "number" && Number.isFinite(resources.cpuPct)) {
    segments.push(
      cpuLimitCores ? `CPU ${Math.round(resources.cpuPct)}% (${cpuLimitCores})` : `CPU ${Math.round(resources.cpuPct)}%`,
    );
  } else if (cpuLimitCores) {
    segments.push(`CPU ${cpuLimitCores}`);
  }
  const memory = formatUsagePair(resources.memoryUsedBytes, resources.memoryLimitBytes);
  if (memory) {
    segments.push(`RAM ${memory}`);
  }
  const disk = formatUsagePair(resources.diskUsedBytes, resources.diskLimitBytes);
  if (disk) {
    segments.push(`Disk ${disk}`);
  }
  return segments.length > 0 ? segments.join(" · ") : null;
}

function isBrowserSessionRuntimeLabel(label: string | null | undefined): boolean {
  return (label ?? "").trim().toLowerCase() === "browser session";
}

function PopoverSection({ title, children, className }: PopoverSectionProps) {
  return (
    <section className={["space-y-2", className].filter(Boolean).join(" ")}>
      <Text as="div" variant="caption" tone="subtle" className="px-1 text-xxs font-medium">
        {title}
      </Text>
      {children}
    </section>
  );
}

export function OctoAgentChip({
  runtimeMenu,
  runtimeReady,
  projectId,
  assistantEnabled,
  conversationId,
  onAssistantEnabledChange,
  extraAgentHandles,
  availableAgents,
  onAddAgentHandle,
  onRemoveAgentHandle,
  onEditAgentProfile,
  credentials,
  credentialsReady,
  onCredentialsRefresh,
  pendingByAgentHandle,
  onOpenAiOnboarding,
  onOpenAiManager,
  onOpenCredits,
  isDisabled = false,
  triggerClassName,
  suppressLoadingIndicator = false,
}: OctoAgentChipProps) {
  const { showStatus } = useStatus();
  const { billing: creditBilling, controllerEnabled: creditsControllerEnabled } = useCredits();
  const {
    runtime: runtimeContext,
    runtimeOptions,
    currentRuntime,
  } = runtimeMenu;
  const {
    preferredRuntimeId,
    setPreferredRuntime,
    clearSessionRuntimeOverride,
    ensureHostedRuntime,
    hostedRuntimeEnsuring,
    hostedRuntimeTakeoverInProgress,
    takeOverHostedRuntimeLimit,
    copyTunnelDetails,
    runtimeStatuses,
    terminateRuntime,
    removeRuntime,
    startRuntime,
    runtimeEnsureError,
    runtimeEnsureLimit,
  } = runtimeContext;
  const runtimeConnectionWarning = runtimeContext.runtime
    .controllerStreamDisconnected
    ? runtimeContext.runtime.controllerStreamDisconnectMessage ??
      "Lost live runtime updates. Retrying…"
    : null;
  const creditLimit = creditBilling.creditLimit ?? 0;
  const creditBalance = creditBilling.creditBalance ?? 0;
  const lowBalanceThreshold = Math.max(2, Math.floor(creditLimit * 0.2));
  const outOfCredits = creditsControllerEnabled && creditLimit > 0 && creditBalance <= 0;
  const lowCredits =
    creditsControllerEnabled &&
    creditLimit > 0 &&
    creditBalance > 0 &&
    creditBalance <= lowBalanceThreshold;
  const shouldShowCreditsRow = Boolean(onOpenCredits) && creditsControllerEnabled && creditLimit > 0;
  const displayedCreditBalance = Math.max(0, creditBalance);
  const creditsRowTitle = outOfCredits
    ? "Out of credits"
    : lowCredits
      ? `Low credits: ${displayedCreditBalance}/${creditLimit}`
      : `${displayedCreditBalance}/${creditLimit} credits left`;
  const creditsRowSubtitle = outOfCredits
    ? "Refill to keep chatting."
    : lowCredits
      ? "Running low. Refill or upgrade."
      : "Usage, billing, and refills";

  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuInstanceKey, setMenuInstanceKey] = useState(0);
  const handleMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (!open) {
      setMenuView("main");
    }
  }, []);

  const [menuView, setMenuView] = useState<"main" | "agents">("main");
  const [perAgentRuntimeEnabled, setPerAgentRuntimeEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !projectId) {
      setPerAgentRuntimeEnabled(false);
      return;
    }
    try {
      const key = `${AGENT_RUNTIME_MODE_STORAGE_PREFIX}:${projectId}`;
      const stored = window.localStorage.getItem(key);
      setPerAgentRuntimeEnabled(stored === "1");
    } catch {
      setPerAgentRuntimeEnabled(false);
    }
  }, [projectId]);

  const handlePerAgentRuntimeToggle = useCallback(
    (nextEnabled: boolean) => {
      setPerAgentRuntimeEnabled(nextEnabled);
      if (typeof window === "undefined" || !projectId) {
        return;
      }
      try {
        const key = `${AGENT_RUNTIME_MODE_STORAGE_PREFIX}:${projectId}`;
        if (nextEnabled) {
          window.localStorage.setItem(key, "1");
        } else {
          window.localStorage.removeItem(key);
        }
      } catch {
        // ignore storage write errors
      }
    },
    [projectId],
  );

  const closeMenu = useCallback(() => {
    setMenuView("main");
    setMenuOpen(false);
    setMenuInstanceKey((current) => current + 1);
  }, []);

  const openAgentSettings = useCallback(
    (handle: string) => {
      if (!onEditAgentProfile) {
        return;
      }
      closeMenu();
      onEditAgentProfile(handle);
    },
    [closeMenu, onEditAgentProfile],
  );

  const [agentModelUpdatingId, setAgentModelUpdatingId] = useState<string | null>(null);
  const [agentRuntimeUpdatingId, setAgentRuntimeUpdatingId] = useState<string | null>(null);
  const [agentCredentialUpdatingId, setAgentCredentialUpdatingId] = useState<string | null>(null);
  const agentCredentialActionInFlightRef = useRef(false);

  const activeAiCredentials = useMemo(() => {
    return credentials.filter(
      (credential) =>
        !credential.revokedAt &&
        (credential.kind === "codex_auth_json" || credential.kind === "openai_api_key"),
    );
  }, [credentials]);

  const defaultCredential = useMemo(() => {
    return activeAiCredentials.find((credential) => credential.isDefault) ?? null;
  }, [activeAiCredentials]);
  const credentialsById = useMemo(() => {
    const map = new Map<string, ControllerCredentialListItem>();
    for (const credential of credentials) {
      map.set(credential.id, credential);
    }
    return map;
  }, [credentials]);
  const aiSetupState = useMemo<"ready" | "missing" | "needs_default">(() => {
    if (activeAiCredentials.length === 0) {
      return "missing";
    }
    if (!defaultCredential) {
      return "needs_default";
    }
    return "ready";
  }, [activeAiCredentials.length, defaultCredential]);
  const aiControlsReady = credentialsReady || aiSetupState === "ready";

  const defaultCredentialProviderId = useMemo<AiProviderId>(() => {
    if (!defaultCredential) {
      return "openai";
    }
    if (defaultCredential.kind === "codex_auth_json") {
      return "openai";
    }
    const metadata = defaultCredential.metadata as Record<string, unknown> | null | undefined;
    const provider = typeof metadata?.provider === "string" ? metadata.provider : "";
    return normalizeAiProviderId(provider);
  }, [defaultCredential]);

  const readyRuntimeEntry = useMemo(
    () => runtimeStatuses.find((entry) => runtimeEntryIsReady(entry)),
    [runtimeStatuses],
  );
  const connectingRuntimeEntry = useMemo(
    () => runtimeStatuses.find((entry) => runtimeEntryIsBooting(entry)),
    [runtimeStatuses],
  );
  const connectionInProgress = hostedRuntimeEnsuring || Boolean(connectingRuntimeEntry);
  const isConnecting = connectionInProgress && !readyRuntimeEntry;
  const connectingLabelFallback = hostedRuntimeEnsuring ? "Instafy Cloud" : currentRuntime.label;
  const activeLabel = isConnecting
    ? connectingRuntimeEntry?.displayName ??
      connectingRuntimeEntry?.runtimeId ??
      connectingLabelFallback
    : currentRuntime.isAuto && readyRuntimeEntry
      ? readyRuntimeEntry.displayName ?? readyRuntimeEntry.runtimeId ?? currentRuntime.label
      : currentRuntime.label;
  const currentProjectRuntimeId = preferredRuntimeId ?? readyRuntimeEntry?.runtimeId ?? null;

  const handleSelect = (runtimeId: string | null) => {
    setMenuOpen(false);
    clearSessionRuntimeOverride();
    void setPreferredRuntime(runtimeId);
  };

  const handleCopyTunnel = useCallback(
    (mode: "url" | "host", runtimeId?: string | null) => {
      void copyTunnelDetails(mode, runtimeId ?? currentRuntime.id ?? null);
    },
    [copyTunnelDetails, currentRuntime.id],
  );

  const handleTerminateRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeId) {
        return;
      }
      await terminateRuntime(runtimeId);
    },
    [terminateRuntime],
  );

  const handleRemoveRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeId) return;
      await removeRuntime(runtimeId);
    },
    [removeRuntime],
  );

  const handleStartRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeId) return;
      await startRuntime(runtimeId);
    },
    [startRuntime],
  );

  const runtimeStatus: "error" | "loading" | "warning" | "ready" | "offline" =
    runtimeEnsureError
      ? "error"
      : isConnecting
        ? "loading"
        : runtimeConnectionWarning
          ? "warning"
          : runtimeReady
            ? "ready"
            : "offline";
  const runtimeNeedsRepair = Boolean(runtimeEnsureError) || (!runtimeReady && !isConnecting);

  const statusBorderClassName =
    runtimeStatus === "ready"
      ? "border-primary-300 dark:border-primary-500/40"
      : runtimeStatus === "loading"
        ? "border-secondary-300 dark:border-secondary-500/40"
        : runtimeStatus === "warning"
          ? "border-amber-300 dark:border-amber-500/40"
        : runtimeStatus === "error"
          ? "border-rose-300 dark:border-rose-500/40"
          : "border-slate-200 dark:border-[color:var(--color-studio-dark-raised-control-border)]";

  const triggerButtonClassName = [
    statusBorderClassName,
    isDisabled ? "opacity-60" : "",
    !(assistantEnabled || extraAgentHandles.length > 0) ? "opacity-70" : "",
    "min-w-0 gap-1.5 border bg-white px-3 py-1 text-xs font-medium text-slate-700 transition",
    "hover:bg-slate-50 data-[hovered]:bg-slate-50",
    "dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-200 dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)]",
    triggerClassName ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const normalizedAvailableAgents = useMemo(() => {
    const seen = new Set<string>();
    const agents: ControllerAgentProfile[] = [];
    for (const agent of availableAgents ?? []) {
      const handle = agent.handle?.trim().toLowerCase();
      if (!handle || handle === "ai") {
        continue;
      }
      if (seen.has(handle)) {
        continue;
      }
      seen.add(handle);
      agents.push({ ...agent, handle });
    }
    return agents;
  }, [availableAgents]);

  const agentByHandle = useMemo(() => {
    const map = new Map<string, ControllerAgentProfile>();
    for (const agent of normalizedAvailableAgents) {
      if (agent.handle) {
        map.set(agent.handle, agent);
      }
    }
    return map;
  }, [normalizedAvailableAgents]);

  const runtimeOptionsById = useMemo(() => {
    const map = new Map<string, (typeof runtimeOptions)[number]>();
    for (const option of runtimeOptions) {
      if (option.id) {
        map.set(option.id, option);
      }
    }
    return map;
  }, [runtimeOptions]);
  const runtimeStatusesById = useMemo(() => {
    const map = new Map<string, (typeof runtimeStatuses)[number]>();
    for (const entry of runtimeStatuses) {
      if (!entry.runtimeId) {
        continue;
      }
      map.set(entry.runtimeId, entry);
    }
    return map;
  }, [runtimeStatuses]);
  const activeSharedRuntimeOption = useMemo(() => {
    const readyRuntimeId = readyRuntimeEntry?.runtimeId ?? null;
    if (readyRuntimeId) {
      return runtimeOptionsById.get(readyRuntimeId) ?? currentRuntime;
    }
    return currentRuntime;
  }, [currentRuntime, readyRuntimeEntry?.runtimeId, runtimeOptionsById]);
  const runtimeMenuOptions = useMemo(
    () => runtimeOptions.filter((option) => !isBrowserSessionRuntimeLabel(option.label)),
    [runtimeOptions],
  );

  const activeAgentHandles = useMemo(() => {
    const handles: string[] = [];
    if (assistantEnabled) {
      handles.push(defaultAssistantHandle);
    }
    for (const handle of extraAgentHandles) {
      const normalized = handle.trim().toLowerCase();
      if (!normalized || handles.includes(normalized)) {
        continue;
      }
      handles.push(normalized);
    }
    return handles;
  }, [assistantEnabled, extraAgentHandles]);

  const primaryAgentHandle = useMemo(() => {
    if (assistantEnabled) {
      return defaultAssistantHandle;
    }
    return extraAgentHandles[0] ?? null;
  }, [assistantEnabled, extraAgentHandles]);

  const primaryAgent = useMemo(() => {
    if (!primaryAgentHandle || primaryAgentHandle === defaultAssistantHandle) {
      return agentByHandle.get(defaultAssistantHandle) ?? null;
    }
    return agentByHandle.get(primaryAgentHandle) ?? null;
  }, [agentByHandle, primaryAgentHandle]);

  const primaryAgentProviderId = useMemo<AiProviderId>(() => {
    if (!primaryAgent) {
      return defaultCredentialProviderId;
    }
    const providerRaw = (primaryAgent.provider ?? "").trim().toLowerCase();
    if (!providerRaw || providerRaw === "assistant") {
      return defaultCredentialProviderId;
    }
    return normalizeAiProviderId(providerRaw);
  }, [defaultCredentialProviderId, primaryAgent]);

  const activeAgentCards = useMemo(() => {
    return activeAgentHandles.map((handle) => {
      const agent = agentByHandle.get(handle) ?? null;
      const providerId: AiProviderId = (() => {
        if (!agent) {
          return handle === defaultAssistantHandle ? primaryAgentProviderId : defaultCredentialProviderId;
        }
        const providerRaw = (agent.provider ?? "").trim().toLowerCase();
        if (!providerRaw || providerRaw === "assistant") {
          return defaultCredentialProviderId;
        }
        return normalizeAiProviderId(providerRaw);
      })();
      const modelOptions = modelOptionsForProvider(providerId);
      const modelValue = normalizeAiModelId(providerId, agent?.model);
      const pinnedRuntimeId = agent?.runtimeId?.trim() ?? "";
      const runtimeMode: "shared" | "dedicated" = pinnedRuntimeId ? "dedicated" : "shared";
      const runtimeOption = pinnedRuntimeId
        ? runtimeOptionsById.get(pinnedRuntimeId) ?? activeSharedRuntimeOption
        : activeSharedRuntimeOption;
      const runtimeId = (pinnedRuntimeId || currentProjectRuntimeId || runtimeOption.id || "").trim() || null;
      const runtimeIdShort = compactRuntimeId(runtimeId);
      const runtimeModeLabel = runtimeMode === "dedicated" ? "Dedicated runtime" : "Shared runtime";
      const runtimeResourcesSummary = formatRuntimeResourcesSummary(
        (runtimeId ? runtimeStatusesById.get(runtimeId)?.resources ?? null : null) ??
          runtimeOption.resources ??
          (runtimeMode === "shared" ? readyRuntimeEntry?.resources ?? null : null),
      );
      const avatarImageSrc = resolveAgentAvatarImageSrc(agent ?? { handle, avatarSeed: handle });
      const displayNameRaw = agent?.displayName?.trim() ?? "";
      const displayName = displayNameRaw && displayNameRaw.toLowerCase() !== handle ? displayNameRaw : null;
      const pendingCount = pendingByAgentHandle?.get(handle) ?? 0;
      const explicitCredentialId = agent?.credentialId?.trim() || null;
      const defaultCredentialId = defaultCredential?.id ?? null;
      const connectedCredential = explicitCredentialId
        ? credentialsById.get(explicitCredentialId) ?? null
        : defaultCredential;
      const credentialLabel = connectedCredential
        ? resolveCredentialLabel(connectedCredential)
        : explicitCredentialId
          ? `Credential ${explicitCredentialId.slice(0, 8)}`
          : null;
      const credentialDetail = connectedCredential ? formatCredentialRuntimeDetail(connectedCredential) : null;
      const credentialIsMissing = Boolean(explicitCredentialId && !connectedCredential);
      const credentialIsRevoked = Boolean(connectedCredential?.revokedAt);
      const credentialUsesDefault = !explicitCredentialId || explicitCredentialId === defaultCredentialId;
      const credentialCanUseDefault = Boolean(
        agent && explicitCredentialId && defaultCredentialId && explicitCredentialId !== defaultCredentialId,
      );
      return {
        handle,
        agent,
        providerId,
        modelOptions,
        modelValue,
        runtimeId,
        runtimeIdShort,
        runtimeModeLabel,
        runtimeResourcesSummary,
        runtimeOption,
        runtimeMode,
        avatarImageSrc,
        displayName,
        pendingCount,
        credentialLabel,
        credentialDetail,
        credentialIsMissing,
        credentialIsRevoked,
        credentialUsesDefault,
        credentialCanUseDefault,
        isPrimary: handle === primaryAgentHandle,
      };
    });
  }, [
    activeAgentHandles,
    agentByHandle,
    currentProjectRuntimeId,
    credentialsById,
    defaultCredential,
    defaultCredentialProviderId,
    pendingByAgentHandle,
    primaryAgentHandle,
    primaryAgentProviderId,
    activeSharedRuntimeOption,
    readyRuntimeEntry?.resources,
    runtimeOptionsById,
    runtimeStatusesById,
  ]);
  const handleAgentModelChange = useCallback(
    async (agent: ControllerAgentProfile, nextModel: string | null) => {
      if (agentModelUpdatingId) {
        return;
      }
      const nextValue = (nextModel ?? "").trim() || null;
      const currentValue = (agent.model ?? "").trim() || null;
      if (nextValue === currentValue) {
        return;
      }

      setAgentModelUpdatingId(agent.id);
      try {
        const result = await updateMyAgent(agent.id, { model: nextValue });
        if (!result.success || !result.agent) {
          showStatus(result.error ?? "Unable to update agent model.", "error", 4500);
          return;
        }
        showStatus("Model updated.", "success", 2500);
        onCredentialsRefresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to update model: ${message}`, "error", 4500);
      } finally {
        setAgentModelUpdatingId(null);
      }
    },
    [agentModelUpdatingId, onCredentialsRefresh, showStatus],
  );

  const handleAgentRuntimePreferenceChange = useCallback(
    async (agent: ControllerAgentProfile, nextRuntimeId: string | null) => {
      if (!projectId) {
        showStatus("Open a space before changing agent runtime preferences.", "warning", 3500);
        return;
      }
      if (agentRuntimeUpdatingId) {
        return;
      }
      const currentRuntimeId = agent.runtimeId?.trim() || null;
      const normalizedNextRuntimeId = nextRuntimeId?.trim() || null;
      if (currentRuntimeId === normalizedNextRuntimeId) {
        return;
      }
      setAgentRuntimeUpdatingId(agent.id);
      try {
        const result = await updateMyAgent(agent.id, {
          projectId,
          runtimeId: normalizedNextRuntimeId,
        });
        if (!result.success || !result.agent) {
          showStatus(result.error ?? "Unable to update agent runtime.", "error", 4500);
          return;
        }
        showStatus(
          normalizedNextRuntimeId ? `Pinned @${agent.handle} to runtime.` : `@${agent.handle} now uses shared runtime.`,
          "success",
          2500,
        );
        onCredentialsRefresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to update agent runtime: ${message}`, "error", 4500);
      } finally {
        setAgentRuntimeUpdatingId(null);
      }
    },
    [agentRuntimeUpdatingId, onCredentialsRefresh, projectId, showStatus],
  );

  const handleAgentUseDefaultCredential = useCallback(
    async (agent: ControllerAgentProfile) => {
      if (agentCredentialUpdatingId || agentCredentialActionInFlightRef.current) {
        return;
      }
      if (!defaultCredential) {
        showStatus("Choose a default credential first.", "warning", 3500);
        return;
      }
      agentCredentialActionInFlightRef.current = true;
      setAgentCredentialUpdatingId(agent.id);
      try {
        const result = await updateMyAgent(agent.id, { credentialId: defaultCredential.id });
        if (!result.success || !result.agent) {
          showStatus(result.error ?? "Unable to update agent credential.", "error", 4500);
          return;
        }
        showStatus(`@${agent.handle} now uses the current default credential.`, "success", 2500);
        onCredentialsRefresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to update credential: ${message}`, "error", 4500);
      } finally {
        agentCredentialActionInFlightRef.current = false;
        setAgentCredentialUpdatingId(null);
      }
    },
    [agentCredentialUpdatingId, defaultCredential, onCredentialsRefresh, showStatus],
  );

  const handleSelectPrimaryAgent = useCallback(
    (handle: string) => {
      const normalized = handle.trim().toLowerCase();
      if (!normalized) {
        return;
      }

      for (const existingHandle of extraAgentHandles) {
        onRemoveAgentHandle(conversationId, existingHandle);
      }

      if (normalized === defaultAssistantHandle) {
        onAssistantEnabledChange(conversationId, true);
        setMenuView("main");
        return;
      }

      onAssistantEnabledChange(conversationId, false);
      onAddAgentHandle(conversationId, normalized);
      setMenuView("main");
    },
    [
      conversationId,
      extraAgentHandles,
      onAddAgentHandle,
      onAssistantEnabledChange,
      onRemoveAgentHandle,
    ],
  );

  const isDefaultAssistantPrimary = primaryAgentHandle === defaultAssistantHandle;

  const aiEnabled = assistantEnabled || extraAgentHandles.length > 0;
  const canOpenPrimarySettings = Boolean(
    (primaryAgentHandle && onEditAgentProfile) || onOpenAiManager,
  );
  const handleOpenAiConnect = useCallback(() => {
    closeMenu();
    onOpenAiOnboarding();
  }, [closeMenu, onOpenAiOnboarding]);

  const handleOpenAiSettings = useCallback(() => {
    if (!onOpenAiManager) {
      return;
    }
    closeMenu();
    onOpenAiManager();
  }, [closeMenu, onOpenAiManager]);

  const handleAiEnabledChange = useCallback(
    (nextEnabled: boolean) => {
      if (isDisabled || !conversationId) {
        return;
      }
      if (nextEnabled) {
        if (aiEnabled) {
          return;
        }
        if (!aiControlsReady) {
          handleOpenAiConnect();
          return;
        }
        onAssistantEnabledChange(conversationId, true);
        return;
      }
      if (!aiEnabled) {
        return;
      }
      for (const handle of extraAgentHandles) {
        onRemoveAgentHandle(conversationId, handle);
      }
      onAssistantEnabledChange(conversationId, false);
    },
    [
      aiEnabled,
      aiControlsReady,
      conversationId,
      extraAgentHandles,
      handleOpenAiConnect,
      isDisabled,
      onAssistantEnabledChange,
      onRemoveAgentHandle,
    ],
  );

  const runtimeMenuPanel = (
    <RuntimeMenuPanel
      runtimeEnsureError={runtimeEnsureError}
      runtimeEnsureLimit={runtimeEnsureLimit}
      connectionWarning={runtimeConnectionWarning}
      hostedRuntimeEnsuring={hostedRuntimeEnsuring}
      title={runtimeNeedsRepair ? "Runtime repair" : "Runtime"}
      onRetryHosted={ensureHostedRuntime}
      onTakeOverHostedRuntimeLimit={takeOverHostedRuntimeLimit}
      hostedRuntimeTakeoverInProgress={hostedRuntimeTakeoverInProgress}
      runtimeOptions={runtimeMenuOptions}
      selectedRuntimeId={preferredRuntimeId}
      onSelectOption={handleSelect}
      onTerminateRuntime={handleTerminateRuntime}
      onRemoveRuntime={handleRemoveRuntime}
      onStartRuntime={handleStartRuntime}
      onCopyTunnel={handleCopyTunnel}
      listClassName="mt-2 max-h-[42vh] overflow-auto pr-1"
      emptyStateMessage="No runtime is connected to this space yet."
    />
  );

  return (
    <DialogTrigger key={menuInstanceKey} isOpen={menuOpen} onOpenChange={handleMenuOpenChange}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        radius="xl"
        ref={menuTriggerRef}
        isDisabled={isDisabled}
        className={triggerButtonClassName}
        data-testid="runtime-selector-button"
        aria-label={`Runtime & AI: ${activeLabel}`}
        title={activeLabel}
      >
        <span className="sr-only">{activeLabel}</span>
        <Brain className="h-4 w-4" aria-hidden="true" />
        {runtimeNeedsRepair ? <span className="truncate">Runtime</span> : null}
        {runtimeStatus === "loading" && !suppressLoadingIndicator ? (
          <Spinner
            aria-hidden="true"
            tone="secondary"
            size="sm"
            data-testid="runtime-selector-loading-indicator"
          />
        ) : (
          <NavArrowDown
            className="h-3.5 w-3.5 text-slate-400 dark:text-slate-300"
            aria-hidden="true"
          />
        )}
      </Button>
      <ResponsiveDialogSurface
        mobileFullScreen={false}
        desktop={{
          isNonModal: true,
          triggerRef: menuTriggerRef,
          placement: "top start",
          offset: 8,
          className:
            "w-[min(92vw,24rem)] max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain p-3",
          "data-testid": "runtime-selector-popover",
        }}
        mobile={{
          isDismissable: true,
          dialogAriaLabel: "Runtime and AI menu",
          style: {
            paddingLeft: "calc(var(--instafy-safe-area-inset-left) + 0.75rem)",
            paddingRight: "calc(var(--instafy-safe-area-inset-right) + 0.75rem)",
          },
          className:
            "items-stretch justify-stretch p-3 pt-[calc(var(--instafy-safe-area-inset-top)+0.75rem)] pb-[calc(var(--instafy-safe-area-inset-bottom)+0.75rem)]",
          modalClassName: "h-full max-h-full w-full max-w-none overflow-y-auto p-3",
          "data-testid": "runtime-selector-popover",
        }}
      >
        <div className="space-y-3" data-popover-scope="runtime-selector">
          {menuView === "agents" ? (
            <div>
              <div className="flex items-center justify-between gap-2 px-1">
                <Text as="div" variant="bodyStrong" tone="inherit" className="text-sm">
                  Agents
                </Text>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  radius="full"
                  onPress={() => setMenuView("main")}
                  className="px-2 py-1 text-xs"
                >
                  Back
                </Button>
              </div>

              <div className="mt-3 space-y-1">
                <Text as="div" variant="caption" tone="subtle" className="px-1 text-xxs font-medium">
                  Default responder
                </Text>
                <Text as="div" variant="caption" tone="muted" className="px-1 text-xxs">
                  Mention @name once to route follow-ups to that agent.
                </Text>
                <div className="mt-1 max-h-44 space-y-1 overflow-auto">
                  <EntityRow
                    title={defaultAssistantDefinition.mentionToken}
                    start={
                      <span
                        aria-hidden="true"
                        className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white shadow-sm dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)]"
                      >
                        <img
                          src={OCTO_AVATAR_SRC}
                          alt=""
                          className="h-full w-full object-cover"
                          decoding="async"
                          draggable={false}
                        />
                      </span>
                    }
                    surface={isDefaultAssistantPrimary ? "selected" : "outlined"}
                    onPress={() => handleSelectPrimaryAgent(defaultAssistantHandle)}
                    isDisabled={isDisabled}
                    trailingAction={
                      canOpenPrimarySettings ? (
                        <IconButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          radius="full"
                          isDisabled={isDisabled}
                          onPress={() => {
                            if (onEditAgentProfile) {
                              openAgentSettings(defaultAssistantHandle);
                              return;
                            }
                            if (onOpenAiManager) {
                              closeMenu();
                              onOpenAiManager();
                            }
                          }}
                          aria-label={`Open settings for ${defaultAssistantDefinition.mentionToken}`}
                          className="text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100"
                        >
                          <Settings className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                      ) : null
                    }
                  />

                  {normalizedAvailableAgents
                    .filter((agent) => agent.handle && !isReservedBuiltInAgentHandle(agent.handle))
                    .map((agent) => {
                      const isDefault = primaryAgentHandle === agent.handle;
                      const avatarImageSrc = resolveAgentAvatarImageSrc(agent);
                      return (
                        <EntityRow
                          key={agent.id}
                          title={`@${agent.handle}`}
                          subtitle={agent.displayName?.trim() ? agent.displayName.trim() : undefined}
                          start={
                            avatarImageSrc ? (
                              <span
                                aria-hidden="true"
                                className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white shadow-sm dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)]"
                              >
                                <img
                                  src={avatarImageSrc}
                                  alt=""
                                  className="h-full w-full object-cover"
                                  decoding="async"
                                  draggable={false}
                                />
                              </span>
                            ) : (
                              <span
                                aria-hidden="true"
                                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-3xs font-semibold text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10"
                                style={{ backgroundImage: resolveAgentAvatarGradient(agent.avatarSeed) }}
                              >
                                {resolveAgentAvatarText(agent)}
                              </span>
                            )
                          }
                          surface={isDefault ? "selected" : "outlined"}
                          onPress={() => handleSelectPrimaryAgent(agent.handle)}
                          isDisabled={isDisabled}
                          trailingAction={
                            onEditAgentProfile ? (
                              <IconButton
                                type="button"
                                variant="ghost"
                                size="sm"
                                radius="full"
                                isDisabled={isDisabled}
                                onPress={() => openAgentSettings(agent.handle)}
                                aria-label={`Open settings for @${agent.handle}`}
                                className="text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100"
                              >
                                <Settings className="h-4 w-4" aria-hidden="true" />
                              </IconButton>
                            ) : null
                          }
                        />
                      );
                    })}
                </div>
              </div>

            </div>
          ) : (
            <>
              <div className="px-1">
                <div className="flex items-center justify-between gap-3">
                  <Text as="div" variant="bodyStrong" tone="inherit" className="text-sm">
                    Runtime &amp; AI
                  </Text>
                  <IconButton
                    slot="close"
                    variant="ghost"
                    size="sm"
                    radius="full"
                    onPress={() => setMenuView("main")}
                    aria-label="Close agent menu"
                    className="text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100"
                  >
                    <Xmark className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-3">

                {!aiControlsReady ? (
                  <Card
                    tone="raised"
                    radius="xl"
                    shadow="none"
                    padding="sm"
                    className="space-y-3"
                    data-testid="runtime-ai-setup-card"
                  >
                    <div className="space-y-1">
                      <Text as="div" variant="bodyStrong" tone="inherit" className="text-sm">
                        {aiSetupState === "needs_default" ? "Choose default AI" : "No AI connected"}
                      </Text>
                      <Text as="div" variant="caption" tone="muted" className="leading-relaxed">
                        {aiSetupState === "needs_default"
                          ? `Pick which connected credential ${defaultAssistantDefinition.mentionToken} should use. Model controls show up after that.`
                          : `Add a provider to unlock ${defaultAssistantDefinition.mentionToken}, models, and chat replies.`}
                      </Text>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        radius="xl"
                        onPress={handleOpenAiConnect}
                        isDisabled={isDisabled}
                        data-testid="runtime-ai-connect-button"
                      >
                        {aiSetupState === "needs_default" ? "Choose default AI" : "Connect AI"}
                      </Button>
                      {onOpenAiManager ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          radius="xl"
                          onPress={handleOpenAiSettings}
                          isDisabled={isDisabled}
                        >
                          Manage
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                ) : null}

                {aiControlsReady && activeAgentCards.length > 0 ? (
                  <div className="space-y-2">
                    {activeAgentCards.map((card) => (
                      <Card
                        key={card.handle}
                        tone="raised"
                        radius="xl"
                        shadow="none"
                        padding="sm"
                        className="space-y-2"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {card.avatarImageSrc ? (
                            <span
                              aria-hidden="true"
                              className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white shadow-sm dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)]"
                            >
                              <img
                                src={card.avatarImageSrc}
                                alt=""
                                className="h-full w-full object-cover"
                                decoding="async"
                                draggable={false}
                              />
                            </span>
                          ) : (
                            <span
                              aria-hidden="true"
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10"
                              style={{ backgroundImage: resolveAgentAvatarGradient(card.agent?.avatarSeed ?? card.handle) }}
                            >
                              {resolveAgentAvatarText(card.agent ?? { handle: card.handle })}
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <Text as="div" variant="bodyStrong" tone="inherit" className="truncate text-sm">
                                @{card.handle}
                              </Text>
                              {card.pendingCount > 0 ? (
                                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-3xs font-semibold text-slate-600 dark:border-[color:var(--color-studio-dark-active-border)] dark:bg-[var(--color-studio-dark-active)] dark:text-slate-200">
                                  Queue {card.pendingCount}
                                </span>
                              ) : null}
                            </div>
                            {card.displayName ? (
                              <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                                {card.displayName}
                              </Text>
                            ) : null}
                          </div>
                          {canOpenPrimarySettings ? (
                            <IconButton
                              type="button"
                              variant="ghost"
                              size="sm"
                              radius="full"
                              isDisabled={isDisabled}
                              onPress={() => {
                                if (onEditAgentProfile) {
                                  openAgentSettings(card.handle);
                                  return;
                                }
                                if (onOpenAiManager) {
                                  closeMenu();
                                  onOpenAiManager();
                                }
                              }}
                              aria-label={`Open settings for @${card.handle}`}
                              data-testid={card.isPrimary ? "runtime-ai-settings-button" : undefined}
                              className="shrink-0 text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100 dark:data-[hovered]:text-slate-100"
                            >
                              <Settings className="h-4 w-4" aria-hidden="true" />
                            </IconButton>
                          ) : null}
                        </div>

                        {card.agent && card.modelOptions.length > 0 ? (
                          <ModelMenuSelect
                            value={card.modelValue}
                            options={card.modelOptions}
                            disabled={Boolean(agentModelUpdatingId) || isDisabled}
                            includeDefaultOption
                            defaultLabel={`Default (${card.modelOptions[0]?.label ?? "recommended"})`}
                            ariaLabel={`Select model for @${card.handle}`}
                            onSelect={(nextModel) => {
                              void handleAgentModelChange(card.agent as ControllerAgentProfile, nextModel);
                            }}
                            triggerTestId={card.isPrimary ? "octo-agent-model-select" : `agent-model-select-${card.handle}`}
                            menuTestId={card.isPrimary ? "octo-agent-model-menu" : `agent-model-menu-${card.handle}`}
                          />
                        ) : null}
                        {card.agent ? (
                          <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex min-w-0 items-center gap-1.5">
                                {card.credentialIsMissing || card.credentialIsRevoked || !card.credentialUsesDefault ? (
                                  <WarningTriangle
                                    className="h-3.5 w-3.5 shrink-0 text-secondary-500"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                                  Credential
                                </Text>
                              </div>
                              <Text
                                as="div"
                                variant="caption"
                                tone={
                                  card.credentialIsMissing || card.credentialIsRevoked
                                    ? "danger"
                                    : card.credentialUsesDefault
                                      ? "muted"
                                      : "warning"
                                }
                                className="truncate text-xxs"
                                title={card.credentialLabel ?? undefined}
                              >
                                {card.credentialIsMissing
                                  ? "Pinned credential is missing"
                                  : card.credentialIsRevoked
                                    ? "Pinned credential was revoked"
                                    : card.credentialLabel
                                      ? `${card.credentialUsesDefault ? "Using default" : "Pinned"} · ${card.credentialLabel}`
                                      : "No credential selected"}
                              </Text>
                              {card.credentialDetail ? (
                                <Text as="div" variant="caption" tone="subtle" className="truncate text-xxs">
                                  {card.credentialDetail}
                                </Text>
                              ) : null}
                            </div>
                            {card.credentialCanUseDefault ? (
                              <div className="flex shrink-0 flex-col items-end gap-0.5">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  radius="full"
                                  className="text-xxs"
                                  onPress={() => {
                                    void handleAgentUseDefaultCredential(card.agent as ControllerAgentProfile);
                                  }}
                                  isDisabled={Boolean(agentCredentialUpdatingId) || isDisabled}
                                  data-testid={card.isPrimary ? "runtime-ai-use-default-credential" : undefined}
                                >
                                  {agentCredentialUpdatingId === card.agent.id
                                    ? "Switching to default..."
                                    : "Use default credential"}
                                </Button>
                                {defaultCredential ? (
                                  <Text
                                    as="span"
                                    variant="caption"
                                    tone="subtle"
                                    className="max-w-36 truncate text-3xs"
                                    title={resolveCredentialLabel(defaultCredential)}
                                  >
                                    {resolveCredentialLabel(defaultCredential)}
                                  </Text>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {card.agent ? (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                                {card.runtimeModeLabel}
                                {card.runtimeOption.label ? ` · ${card.runtimeOption.label}` : ""}
                                {card.runtimeIdShort ? ` · rt:${card.runtimeIdShort}` : ""}
                              </Text>
                              {card.runtimeResourcesSummary ? (
                                <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                                  {card.runtimeResourcesSummary}
                                </Text>
                              ) : null}
                            </div>
                            {card.runtimeMode === "dedicated" ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                radius="full"
                                isDisabled={Boolean(agentRuntimeUpdatingId) || isDisabled || !projectId}
                                onPress={() => {
                                  void handleAgentRuntimePreferenceChange(card.agent as ControllerAgentProfile, null);
                                }}
                              >
                                Use shared
                              </Button>
                            ) : perAgentRuntimeEnabled ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                radius="full"
                                isDisabled={
                                  Boolean(agentRuntimeUpdatingId) ||
                                  isDisabled ||
                                  !projectId ||
                                  !currentProjectRuntimeId
                                }
                                onPress={() => {
                                  void handleAgentRuntimePreferenceChange(
                                    card.agent as ControllerAgentProfile,
                                    currentProjectRuntimeId,
                                  );
                                }}
                              >
                                Assign current runtime
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </Card>
                    ))}
                  </div>
                ) : null}

                {shouldShowCreditsRow ? (
                  <PopoverSection title="Credits">
                    <EntityRow
                      title={creditsRowTitle}
                      subtitle={creditsRowSubtitle}
                      end={<NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
                      surface="interactive"
                      titleClassName="tabular-nums"
                      onPress={onOpenCredits}
                      isDisabled={isDisabled}
                      data-testid="runtime-ai-credits-row"
                    />
                  </PopoverSection>
                ) : null}

                {aiControlsReady ? (
                  <PopoverSection title="Agents">
                    <EntityRow
                      title="Manage agents"
                      subtitle={
                        activeAgentCards.length > 1
                          ? `${activeAgentCards.length} responders available`
                          : "Profiles, responders, and routing"
                      }
                      end={<NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
                      surface="interactive"
                      onPress={() => setMenuView("agents")}
                      isDisabled={isDisabled}
                    />
                  </PopoverSection>
                ) : null}

                <PopoverSection title="Assistant">
                  <div className="space-y-2 px-1">
                    <Toggle
                      size="sm"
                      label="Enable assistant"
                      description={
                        aiControlsReady
                          ? "Octo replies in this chat."
                          : aiSetupState === "needs_default"
                            ? aiEnabled
                              ? "AI is connected. Pick a default above to resume replies."
                              : "Pick a default AI above, then turn this on."
                            : aiEnabled
                              ? "No AI is connected, so replies are paused. Connect AI above, or turn this off."
                              : "Connect AI first, then turn this on."
                      }
                      isSelected={aiEnabled}
                      onChange={handleAiEnabledChange}
                      isDisabled={isDisabled || !conversationId}
                      data-testid="chat-assistant-toggle"
                      className="w-full justify-between"
                    />
                    {aiControlsReady ? (
                      <Toggle
                        size="sm"
                        label="Per-agent runtimes"
                        description="Allow dedicated runtime assignment per agent"
                        isSelected={perAgentRuntimeEnabled}
                        onChange={handlePerAgentRuntimeToggle}
                        isDisabled={isDisabled || !projectId}
                        className="w-full justify-between"
                      />
                    ) : null}
                  </div>
                </PopoverSection>

                {/* The runtime panel must keep one stable JSX position:
                    conditional placement remounts it mid-retry and drops its
                    in-flight action state, so repair mode reorders with CSS. */}
                <div
                  className={`flex flex-col gap-3 ${runtimeNeedsRepair ? "order-first" : ""}`}
                  data-testid={runtimeNeedsRepair ? "runtime-repair-priority" : undefined}
                >
                  <div
                    className={`h-px bg-slate-200/80 dark:bg-[var(--color-studio-dark-divider)] ${
                      runtimeNeedsRepair ? "order-last" : ""
                    }`}
                  />
                  {runtimeMenuPanel}
                </div>
              </div>
            </>
            )}
          </div>
      </ResponsiveDialogSurface>
      </DialogTrigger>
  );
}
