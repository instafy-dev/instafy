import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Brain, CheckCircle, Cpu, EditPencil, MoreHoriz, Trash, Upload, WarningTriangle, Xmark } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { EntityRow } from "../../../components/EntityRow";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { DeepSeekIcon, GeminiIcon, OpenAIIcon, ZaiIcon } from "../../../components/ProviderIcons";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { useAuth } from "../../../providers/AuthProvider";
import {
  type ControllerAgentProfile,
  type ControllerCredentialListItem,
  type CredentialRequirementsResult,
  controllerBaseUrl,
  controllerClient,
  runtimeControllerEnabled,
} from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import {
  normalizeCustomAgentAvatarSrc,
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import { normalizeCustomAgentHandle } from "../../../assistants/localBuiltInAssistantCatalog";
import { formatCredentialKind, resolveCredentialLabel } from "../../../utils/credentialFormatting";
import {
  AI_PROVIDER_OPTIONS,
  modelOptionsForProvider,
  normalizeAiModelId,
  normalizeAiProviderId,
  type AiProviderId,
} from "../../../utils/aiProviderModels";
import { CredentialsConnectModal } from "./CredentialsConnectModal";
import { AgentProfileModal, type AgentProfileModalMode } from "./AgentProfileModal";
import {
  clearPendingAgentProfileTarget,
  readPendingAgentProfileTarget,
} from "./agentProfileDeepLink";
import { emitAiConfigChanged } from "./aiConfigEvents";
import { SettingsAddButton } from "./SettingsAddButton";
import {
  StudioListRow,
  StudioListSection,
  StudioListSurface,
} from "./StudioListSection";
import { useCredentialsConnectFlow } from "./useCredentialsConnectFlow";
import { isExpiredCredentialProxyError } from "./proxyError";

const {
  create: createMyAgent,
  list: listMyAgents,
  remove: deleteMyAgent,
  update: updateMyAgent,
} = controllerClient.agents;
const {
  clearDefault: clearDefaultCredential,
  createCodex: createCodexCredential,
  getRequirements: getCredentialRequirements,
  list: listMyCredentials,
  revoke: revokeMyCredential,
  setDefault: setDefaultCredential,
  test: testMyCredential,
} = controllerClient.credentials;

function normalizeAgentHandle(raw: string): string | null {
  return normalizeCustomAgentHandle(raw);
}

function resolveCredentialProviderId(
  credential: Pick<ControllerCredentialListItem, "kind" | "metadata">,
): AiProviderId {
  if (credential.kind === "codex_auth_json") {
    return "openai";
  }

  const metadata = credential.metadata as Record<string, unknown> | null | undefined;
  const provider = typeof metadata?.["provider"] === "string" ? String(metadata?.["provider"]) : "";
  const normalized = provider.trim().toLowerCase();
  if (normalized === "deepseek") {
    return "deepseek";
  }
  if (normalized === "zai" || normalized === "z.ai") {
    return "zai";
  }
  if (
    normalized === "gemini" ||
    normalized === "google" ||
    normalized === "google-ai" ||
    normalized === "google_gemini" ||
    normalized === "google-gemini"
  ) {
    return "gemini";
  }
  return "openai";
}

function resolveCredentialAccountHint(
  credential: Pick<ControllerCredentialListItem, "kind" | "id" | "metadata">,
): string | null {
  const metadata = credential.metadata as Record<string, unknown> | null | undefined;
  const accountId = typeof metadata?.account_id === "string" ? metadata.account_id.trim() : "";
  if (credential.kind === "codex_auth_json" && accountId) {
    return `acct …${accountId.slice(-6)}`;
  }
  if (credential.kind === "codex_auth_json") {
    return `id …${credential.id.slice(0, 6)}`;
  }
  return null;
}

const CREDENTIAL_TEST_FAILURE_MAX_CHARS = 220;
const AI_MODE_ERROR_MAX_CHARS = 150;
const AI_MANAGER_ROW_CLASS_NAME =
  "rounded-none border-0 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900/45";
const AI_MANAGER_ICON_CLASS_NAME =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300";
type CredentialTestFeedbackStatus = "ok" | "fail" | "needs_reconnect";
type CredentialTestFeedback = {
  status: CredentialTestFeedbackStatus;
  testedAt: number;
  detail?: string | null;
};

function formatAiModeErrorDetail(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return "AI runtime status is unavailable right now.";
  }

  const lowered = normalized.toLowerCase();
  if (
    lowered.includes("proxy request failed") ||
    lowered.includes("connection refused") ||
    lowered.includes("/healthz")
  ) {
    return "Instafy can't reach the AI runtime right now.";
  }

  const compact = normalized.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (compact.length <= AI_MODE_ERROR_MAX_CHARS) {
    return compact;
  }
  return `${compact.slice(0, AI_MODE_ERROR_MAX_CHARS - 1).trimEnd()}…`;
}

function formatCredentialTestFailureMessage(raw: string | null | undefined): string | null {
  const normalized = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();

  if (
    lowered.includes("cloudcode-pa.googleapis.com/") &&
    (lowered.includes("404") || lowered.includes("requested url <code>/</code>"))
  ) {
    return "Gemini endpoint returned 404. Update and restart the backend stack, then retry.";
  }
  if (
    lowered.includes("access_token_scope_insufficient") ||
    lowered.includes("insufficient authentication scopes")
  ) {
    return "This Gemini connection used Google login, which is no longer supported. Replace it with a Gemini API key.";
  }
  if (
    lowered.includes("service_disabled") ||
    lowered.includes("accessnotconfigured") ||
    lowered.includes("cloud code private api has not been used")
  ) {
    return "Gemini Code Assist API is not enabled for this Google project/account.";
  }
  if (lowered.includes("permission_denied") || lowered.includes("insufficientpermissions")) {
    return "Google account is connected but does not have Gemini Code Assist access.";
  }
  if (lowered.includes("usage_limit_reached") || lowered.includes("rate limit") || lowered.includes("429")) {
    return "Provider rate limit reached. Try again shortly.";
  }

  const withoutHtml = normalized.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const compact = withoutHtml || normalized;
  if (compact.length <= CREDENTIAL_TEST_FAILURE_MAX_CHARS) {
    return compact;
  }
  return `${compact.slice(0, CREDENTIAL_TEST_FAILURE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Reconnect-in-place re-uploads an auth.json, so it only exists for that kind.
 * Every other provider has to be re-added. The copy below and the row's
 * Reconnect button both derive from this predicate — they used to disagree, so
 * a Gemini or API-key row said "Reconnect the credential" beside no Reconnect
 * button at all.
 */
function canReconnectCredentialInPlace(
  credential: { kind?: string | null } | null | undefined,
): boolean {
  return credential?.kind === "codex_auth_json";
}

function resolveCredentialTestFailureFeedback(
  raw: string | null | undefined,
  canReconnect: boolean,
): Omit<CredentialTestFeedback, "testedAt"> {
  const detail = formatCredentialTestFailureMessage(raw);
  if (typeof raw === "string" && isExpiredCredentialProxyError(raw)) {
    return {
      status: "needs_reconnect",
      detail: canReconnect
        ? "The saved AI login is stale. Reconnect it below, then test again."
        : "The saved AI login is stale. Add a fresh connection for this provider, make it the default, then remove this one.",
    };
  }
  return { status: "fail", detail };
}

function resolveAgentAvatarUrlDraftFromSeed(seed: string | null | undefined): string {
  return normalizeCustomAgentAvatarSrc(seed) ?? "";
}

function resolveCredentialTestStatusLabel(status: CredentialTestFeedbackStatus): string {
  if (status === "ok") {
    return "Verified";
  }
  if (status === "needs_reconnect") {
    return "Needs reconnect";
  }
  return "Failed";
}

function CredentialTestStatusIcon({ status }: { status: CredentialTestFeedbackStatus }) {
  if (status === "ok") {
    return <CheckCircle className="h-4 w-4" aria-hidden="true" />;
  }
  if (status === "needs_reconnect") {
    return <WarningTriangle className="h-4 w-4" aria-hidden="true" />;
  }
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-rose-500/40"
      aria-hidden="true"
    >
      <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

async function readCredentialJsonFile(file: File): Promise<unknown> {
  const contents = await file.text();
  return JSON.parse(contents) as unknown;
}

function AgentAvatar({
  agent,
  size = "md",
}: {
  agent: Pick<ControllerAgentProfile, "avatarSeed" | "handle" | "displayName">;
  size?: "sm" | "md";
}) {
  const imageSrc = resolveAgentAvatarImageSrc(agent);
  const dimensions = size === "sm" ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm";
  if (imageSrc) {
    return (
      <span
        className={[
          "inline-flex flex-none items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900",
          dimensions,
        ].join(" ")}
        aria-hidden="true"
      >
        <img src={imageSrc} alt="" className="h-full w-full object-cover" decoding="async" draggable={false} />
      </span>
    );
  }
  return (
    <span
      className={[
        "inline-flex flex-none items-center justify-center rounded-full text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10",
        dimensions,
      ].join(" ")}
      style={{ backgroundImage: resolveAgentAvatarGradient(agent.avatarSeed) }}
      aria-hidden="true"
    >
      {resolveAgentAvatarText(agent)}
    </span>
  );
}

export function CredentialsSettingsCard() {
  const { user } = useAuth();
  const { showStatus } = useStatus();

  const [credentials, setCredentials] = useState<ControllerCredentialListItem[]>([]);
  const [agents, setAgents] = useState<ControllerAgentProfile[]>([]);
  const [credentialRequirements, setCredentialRequirements] = useState<CredentialRequirementsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);
  const [agentActionPendingId, setAgentActionPendingId] = useState<string | null>(null);
  const [agentProfileModal, setAgentProfileModal] = useState<
    | { mode: AgentProfileModalMode; agentId?: string }
    | null
  >(null);
  const [agentHandleDraft, setAgentHandleDraft] = useState("");
  const [agentNameDraft, setAgentNameDraft] = useState("");
  const [agentAvatarUrlDraft, setAgentAvatarUrlDraft] = useState("");
  const [agentDescriptionDraft, setAgentDescriptionDraft] = useState("");
  const [agentCredentialDraft, setAgentCredentialDraft] = useState<string | null>(null);
  const [agentProviderDraft, setAgentProviderDraft] = useState<AiProviderId>("openai");
  const [agentModelDraft, setAgentModelDraft] = useState<string | null>(null);
  const [credentialTestPendingId, setCredentialTestPendingId] = useState<string | null>(null);
  const [credentialTestFeedback, setCredentialTestFeedback] = useState<Record<string, CredentialTestFeedback>>({});
  const [mobileCredentialMenuId, setMobileCredentialMenuId] = useState<string | null>(null);
  const mobileCredentialMenuLastActionRef = useRef<string | null>(null);
  const reconnectFileInputRef = useRef<HTMLInputElement | null>(null);
  const reconnectCredentialIdRef = useRef<string | null>(null);

  const activeCredentials = useMemo(() => {
    return credentials.filter((credential) => !credential.revokedAt);
  }, [credentials]);

  const codexCredentials = useMemo(() => {
    return activeCredentials.filter(
      (credential) => credential.kind === "codex_auth_json" || credential.kind === "openai_api_key"
    );
  }, [activeCredentials]);

  const { octoAgent, botAgents } = useMemo(() => {
    let octo: ControllerAgentProfile | null = null;
    const bots: ControllerAgentProfile[] = [];
    for (const agent of agents) {
      if ((agent.handle ?? "").toLowerCase() === "octo") {
        octo = agent;
        continue;
      }
      bots.push(agent);
    }
    return { octoAgent: octo, botAgents: bots };
  }, [agents]);

  const credentialsById = useMemo(() => {
    const lookup = new Map<string, ControllerCredentialListItem>();
    for (const credential of credentials) {
      lookup.set(credential.id, credential);
    }
    return lookup;
  }, [credentials]);

  const loadCredentials = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!runtimeControllerEnabled || !controllerBaseUrl) {
        setCredentials([]);
        setAgents([]);
        setCredentialRequirements(null);
        return;
      }
      if (!user) {
        setCredentials([]);
        setAgents([]);
        setCredentialRequirements(null);
        return;
      }
      if (!options?.silent) {
        setLoading(true);
      }
      const [result, agentsResult, requirementsResult] = await Promise.all([
        listMyCredentials().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false as const, credentials: [], error: message };
        }),
        listMyAgents().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false as const, agents: [], error: message };
        }),
        getCredentialRequirements().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return {
            success: false as const,
            requiresUserCredentials: false,
            proxyBackend: null,
            hasDefaultCredential: false,
            managedAi: null,
            error: message,
          };
        }),
      ]);
      if (result.success) {
        setCredentials(result.credentials);
      } else if (!options?.silent) {
        showStatus(result.error ?? "Unable to load credentials.", "error", 4500);
      }

      if (agentsResult.success) {
        setAgents(agentsResult.agents);
      } else if (!options?.silent) {
        showStatus(agentsResult.error ?? "Unable to load bots.", "error", 4500);
      }
      setCredentialRequirements(requirementsResult);
      if (!options?.silent) {
        setLoading(false);
      }
    },
    [showStatus, user]
  );

  useEffect(() => {
    void loadCredentials({ silent: true });
  }, [loadCredentials]);

  const notifyAiConfigChanged = useCallback((reason: string) => {
    emitAiConfigChanged(reason);
  }, []);

  const {
    canManageAiConnections,
    openConnectModal,
    openConnectModalAtStep,
    connectModalProps,
  } = useCredentialsConnectFlow({
    userPresent: Boolean(user),
    loadCredentials,
    notifyAiConfigChanged,
    showStatus,
    formatCredentialTestFailureMessage,
  });

  const handleTestCredential = useCallback(
    async (credentialId: string) => {
      if (credentialTestPendingId) {
        return;
      }
      const canReconnect = canReconnectCredentialInPlace(credentialsById.get(credentialId));
      setCredentialTestPendingId(credentialId);
      setCredentialTestFeedback((prev) => {
        if (!prev[credentialId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[credentialId];
        return next;
      });
      try {
        const result = await testMyCredential(credentialId);
        if (!result.success) {
          const feedback = resolveCredentialTestFailureFeedback(result.error, canReconnect);
          setCredentialTestFeedback((prev) => ({
            ...prev,
            [credentialId]: { ...feedback, testedAt: Date.now() },
          }));
          return;
        }
        if (result.ok) {
          setCredentialTestFeedback((prev) => ({
            ...prev,
            [credentialId]: { status: "ok", testedAt: Date.now(), detail: null },
          }));
          return;
        }
        const feedback = resolveCredentialTestFailureFeedback(result.output, canReconnect);
        setCredentialTestFeedback((prev) => ({
          ...prev,
          [credentialId]: { ...feedback, testedAt: Date.now() },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const feedback = resolveCredentialTestFailureFeedback(message, canReconnect);
        setCredentialTestFeedback((prev) => ({
          ...prev,
          [credentialId]: { ...feedback, testedAt: Date.now() },
        }));
      } finally {
        setCredentialTestPendingId(null);
      }
    },
    [credentialTestPendingId, credentialsById],
  );

  const handleMakeDefault = useCallback(
    async (credentialId: string) => {
      if (actionPendingId) {
        return;
      }
      setActionPendingId(credentialId);
      try {
        const result = await setDefaultCredential(credentialId);
        if (!result.success) {
          showStatus(result.error ?? "Unable to set default credential.", "error", 4500);
          return;
        }
        showStatus("Default credential updated.", "success", 2500);
        await loadCredentials({ silent: true });
        notifyAiConfigChanged("credential_default_changed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to set default credential: ${message}`, "error", 4500);
      } finally {
        setActionPendingId(null);
      }
    },
    [actionPendingId, loadCredentials, notifyAiConfigChanged, showStatus]
  );

  const handleUseManagedAi = useCallback(async () => {
    if (actionPendingId) {
      return;
    }
    setActionPendingId("managed-ai");
    try {
      const result = await clearDefaultCredential();
      if (!result.success) {
        showStatus(result.error ?? "Unable to switch to Instafy AI.", "error", 4500);
        return;
      }
      showStatus("Instafy AI is now active.", "success", 2500);
      await loadCredentials({ silent: true });
      notifyAiConfigChanged("credential_default_cleared");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to switch to Instafy AI: ${message}`, "error", 4500);
    } finally {
      setActionPendingId(null);
    }
  }, [actionPendingId, loadCredentials, notifyAiConfigChanged, showStatus]);

  const handleRevoke = useCallback(
    async (credentialId: string) => {
      if (actionPendingId) {
        return;
      }
      if (typeof window !== "undefined") {
        const credential = credentialsById.get(credentialId) ?? null;
        const label = credential ? resolveCredentialLabel(credential) : `Credential ${credentialId.slice(0, 8)}`;
        const kind = credential ? formatCredentialKind(credential) : "AI credential";
        const hint = credential ? resolveCredentialAccountHint(credential) : null;
        const detail = [kind, hint].filter(Boolean).join(" · ");
        const confirmed = window.confirm(
          `Remove ${label}${detail ? ` (${detail})` : ""}?\n\nAgents stop using it immediately — running work pinned to it will fail.`,
        );
        if (!confirmed) {
          return;
        }
      }
      setActionPendingId(credentialId);
      try {
        const result = await revokeMyCredential(credentialId);
        if (!result.success) {
          showStatus(result.error ?? "Unable to revoke credential.", "error", 4500);
          return;
        }
        showStatus("Credential removed.", "success", 2500);
        await loadCredentials({ silent: true });
        notifyAiConfigChanged("credential_removed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to revoke credential: ${message}`, "error", 4500);
      } finally {
        setActionPendingId(null);
      }
    },
    [actionPendingId, credentialsById, loadCredentials, notifyAiConfigChanged, showStatus]
  );

  const handleTriggerReconnectCredential = useCallback(
    (credentialId: string) => {
      if (actionPendingId || credentialTestPendingId) {
        return;
      }
      reconnectCredentialIdRef.current = credentialId;
      reconnectFileInputRef.current?.click();
    },
    [actionPendingId, credentialTestPendingId],
  );

  const handleReconnectCredentialFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = "";
      if (!file) {
        return;
      }

      const credentialId = reconnectCredentialIdRef.current;
      reconnectCredentialIdRef.current = null;
      if (!credentialId) {
        return;
      }

      const credential = credentialsById.get(credentialId) ?? null;
      if (!credential || credential.kind !== "codex_auth_json") {
        showStatus("This connection cannot be reconnected with auth.json.", "error", 4500);
        return;
      }
      if (actionPendingId) {
        return;
      }

      setActionPendingId(credentialId);
      try {
        const authJson = await readCredentialJsonFile(file);
        const result = await createCodexCredential({
          authJson,
          label: resolveCredentialLabel(credential) || "Browser upload",
          makeDefault: credential.isDefault,
        });
        if (!result.success || !result.credentialId) {
          showStatus(result.error ?? "Unable to reconnect credential.", "error", 5000);
          return;
        }

        const revokeResult = await revokeMyCredential(credentialId);
        if (!revokeResult.success) {
          showStatus(
            revokeResult.error
              ? `Credential reconnected, but the old one could not be removed: ${revokeResult.error}`
              : "Credential reconnected, but the old one could not be removed.",
            "error",
            6500,
          );
        } else {
          showStatus("Credential reconnected.", "success", 3000);
        }
        setCredentialTestFeedback((prev) => {
          if (!prev[credentialId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[credentialId];
          return next;
        });
        await loadCredentials({ silent: true });
        notifyAiConfigChanged("credential_reconnected");
      } catch {
        showStatus("Unable to read auth.json from this computer.", "error", 5000);
      } finally {
        setActionPendingId(null);
      }
    },
    [actionPendingId, credentialsById, loadCredentials, notifyAiConfigChanged, showStatus],
  );

  const closeAgentProfileModal = useCallback(() => {
    setAgentProfileModal(null);
    setAgentHandleDraft("");
    setAgentNameDraft("");
    setAgentAvatarUrlDraft("");
    setAgentDescriptionDraft("");
    setAgentCredentialDraft(null);
    setAgentProviderDraft("openai");
    setAgentModelDraft(null);
  }, []);

  const defaultCodexCredential = useMemo(() => {
    return codexCredentials.find((credential) => credential.isDefault) ?? null;
  }, [codexCredentials]);

  const defaultCredentialId = useMemo(() => {
    const preferred = defaultCodexCredential ?? codexCredentials[0] ?? null;
    return preferred ? preferred.id : null;
  }, [codexCredentials, defaultCodexCredential]);

  const aiModeSummary = useMemo(() => {
    if (!runtimeControllerEnabled || !user) {
      return null;
    }

    if (loading && !credentialRequirements) {
      return {
        title: "Checking which AI mode is active.",
        detail: "Instafy compares your default credential with the managed Instafy AI lane before deciding what new prompts use.",
      };
    }

    if (credentialRequirements?.error) {
      return {
        title: "Current AI mode is unavailable right now.",
        detail: formatAiModeErrorDetail(credentialRequirements.error),
      };
    }

    const managedAi = credentialRequirements?.managedAi ?? null;
    const managedAiEnabled = managedAi?.enabled === true;
    const managedAiAvailable = managedAi?.available === true;
    const managedAiLabel = managedAi?.label?.trim() || "Instafy AI";
    const defaultCredentialLabel = defaultCodexCredential
      ? resolveCredentialLabel(defaultCodexCredential)
      : null;

    if (credentialRequirements?.hasDefaultCredential && defaultCredentialLabel) {
      return {
        title: `Using your AI: ${defaultCredentialLabel}.`,
        detail: managedAiEnabled
          ? `${managedAiLabel} is ready when no default credential is selected, but new prompts currently use your default connection.`
          : "New prompts use your default credential until you switch it below.",
      };
    }

    if (managedAiAvailable) {
      const quotaDetail =
        typeof managedAi?.remainingPrompts === "number" && managedAi?.dailyPromptLimit > 0
          ? `${managedAi.remainingPrompts} of ${managedAi.dailyPromptLimit} managed prompts remain today.`
          : managedAi?.dailyPromptLimit && managedAi.dailyPromptLimit > 0
            ? `${managedAi.dailyPromptLimit} managed prompts are available each day.`
            : "Managed prompts burn from your shared team balance.";
      return {
        title: `Using ${managedAiLabel}.`,
        detail:
          codexCredentials.length > 0
            ? `No default credential is selected, so new prompts use ${managedAiLabel}. ${quotaDetail} Set one of your saved connections as default below to switch to your own AI.`
            : `No personal credential is connected, so new prompts use ${managedAiLabel}. ${quotaDetail}`,
      };
    }

    if (codexCredentials.length > 0) {
      return {
        title: "Choose which saved AI connection should be active.",
        detail: "You already have AI credentials saved, but none is set as default. Set one below to use your own AI for new prompts.",
      };
    }

    return {
      title: "No active AI mode is configured yet.",
      detail: managedAiEnabled
        ? `${managedAiLabel} is not currently available, so connect your own AI below to start using prompts.`
        : "Connect your own AI below to start using prompts.",
    };
  }, [
    codexCredentials.length,
    credentialRequirements,
    defaultCodexCredential,
    loading,
    user,
  ]);
  const canSwitchToManagedAi =
    Boolean(defaultCodexCredential) &&
    credentialRequirements?.managedAi?.enabled === true &&
    !credentialRequirements?.error;

  const openCreateBotModal = useCallback((credentialId: string) => {
    const credential = credentialsById.get(credentialId) ?? null;
    const provider = credential ? resolveCredentialProviderId(credential) : "openai";
    setAgentProfileModal({ mode: "create" });
    setAgentHandleDraft("");
    setAgentNameDraft("");
    setAgentAvatarUrlDraft("");
    setAgentDescriptionDraft("");
    setAgentCredentialDraft(credentialId);
    setAgentProviderDraft(provider);
    setAgentModelDraft(modelOptionsForProvider(provider)[0]?.id ?? null);
  }, [credentialsById]);

  const handleAgentCredentialChange = useCallback(
    (credentialId: string) => {
      setAgentCredentialDraft(credentialId);
      const credential = credentialsById.get(credentialId) ?? null;
      const provider = credential ? resolveCredentialProviderId(credential) : "openai";
      setAgentProviderDraft(provider);
      setAgentModelDraft((prev) => {
        const options = modelOptionsForProvider(provider);
        const fallback = options[0]?.id ?? null;
        const normalizedPrev = normalizeAiModelId(provider, prev);
        if (!normalizedPrev) {
          return fallback;
        }
        if (provider !== agentProviderDraft) {
          return fallback;
        }
        return options.some((option) => option.id === normalizedPrev)
          ? normalizedPrev
          : fallback;
      });
    },
    [agentProviderDraft, credentialsById]
  );

  const openEditBotModal = useCallback((agent: ControllerAgentProfile) => {
    setAgentProfileModal({ mode: "edit", agentId: agent.id });
    setAgentHandleDraft(`@${agent.handle}`);
    setAgentNameDraft(agent.displayName ?? "");
    setAgentAvatarUrlDraft(resolveAgentAvatarUrlDraftFromSeed(agent.avatarSeed));
    setAgentDescriptionDraft(agent.description ?? "");
    const resolvedCredentialId = agent.credentialId ?? defaultCredentialId ?? null;
    setAgentCredentialDraft(resolvedCredentialId);
    const credential = resolvedCredentialId ? credentialsById.get(resolvedCredentialId) ?? null : null;
    const provider = credential ? resolveCredentialProviderId(credential) : normalizeAiProviderId(agent.provider);
    setAgentProviderDraft(provider);
    setAgentModelDraft(() => {
      const options = modelOptionsForProvider(provider);
      const fallback = options[0]?.id ?? null;
      const current = normalizeAiModelId(provider, agent.model);
      if (!current) {
        return fallback;
      }
      return options.some((option) => option.id === current) ? current : fallback;
    });
  }, [credentialsById, defaultCredentialId]);

  const openOctoProfileModal = useCallback((agent: ControllerAgentProfile) => {
    setAgentProfileModal({ mode: "octo", agentId: agent.id });
    setAgentHandleDraft("@octo");
    setAgentNameDraft(agent.displayName ?? "Octo");
    setAgentAvatarUrlDraft(resolveAgentAvatarUrlDraftFromSeed(agent.avatarSeed));
    setAgentDescriptionDraft(agent.description ?? "");
    const resolvedCredentialId = agent.credentialId ?? defaultCredentialId ?? null;
    setAgentCredentialDraft(resolvedCredentialId);
    const credential = resolvedCredentialId ? credentialsById.get(resolvedCredentialId) ?? null : null;
    const provider = credential ? resolveCredentialProviderId(credential) : normalizeAiProviderId(agent.provider);
    setAgentProviderDraft(provider);
    setAgentModelDraft(() => {
      const options = modelOptionsForProvider(provider);
      const fallback = options[0]?.id ?? null;
      const current = normalizeAiModelId(provider, agent.model);
      if (!current) {
        return fallback;
      }
      return options.some((option) => option.id === current) ? current : fallback;
    });
  }, [credentialsById, defaultCredentialId]);

  useEffect(() => {
    if (agentProfileModal) {
      return;
    }
    const pending = readPendingAgentProfileTarget();
    if (!pending) {
      return;
    }
    if (pending === "octo") {
      if (!octoAgent) {
        return;
      }
      openOctoProfileModal(octoAgent);
      clearPendingAgentProfileTarget();
      return;
    }

    const agent =
      botAgents.find((candidate) => (candidate.handle ?? "").toLowerCase() === pending) ?? null;
    if (!agent) {
      return;
    }
    openEditBotModal(agent);
    clearPendingAgentProfileTarget();
  }, [agentProfileModal, botAgents, octoAgent, openEditBotModal, openOctoProfileModal]);

  const handleSaveAgentProfile = useCallback(async () => {
    if (!agentProfileModal) {
      return;
    }
    if (agentActionPendingId) {
      return;
    }

    const trimmedName = agentNameDraft.trim();
    const trimmedDescription = agentDescriptionDraft.trim();
    const rawAvatarUrl = agentAvatarUrlDraft.trim();
    const normalizedAvatarUrl = normalizeCustomAgentAvatarSrc(rawAvatarUrl);
    if (rawAvatarUrl.length > 0 && !normalizedAvatarUrl) {
      showStatus("Profile picture URL must start with https://, http://, or /.", "error", 4500);
      return;
    }

    if (agentProfileModal.mode === "create") {
      const credentialId = (agentCredentialDraft ?? "").trim();
      if (!credentialId) {
        showStatus("Select a credential to power this bot.", "error", 4500);
        return;
      }

      const handleDraftTrimmed = agentHandleDraft.trim();
      const handleNormalized =
        handleDraftTrimmed.length > 0 ? normalizeAgentHandle(handleDraftTrimmed) : null;
      if (handleDraftTrimmed.length > 0 && !handleNormalized) {
        showStatus("Bot handle must look like @bob (letters/numbers, up to 20 chars).", "error", 4500);
        return;
      }
      const handleForRequest = handleNormalized ?? undefined;

      setAgentActionPendingId(`create:${credentialId}`);
      try {
        const result = await createMyAgent({
          credentialId,
          handle: handleForRequest,
          displayName: trimmedName.length > 0 ? trimmedName : undefined,
          avatarSeed: normalizedAvatarUrl ?? undefined,
          description: trimmedDescription.length > 0 ? trimmedDescription : undefined,
          model: agentModelDraft,
        });
        if (!result.success || !result.agent) {
          showStatus(result.error ?? "Unable to create bot.", "error", 4500);
          return;
        }
        showStatus(`Bot created: @${result.agent.handle}`, "success", 3000);
        closeAgentProfileModal();
        await loadCredentials({ silent: true });
        notifyAiConfigChanged("agent_created");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to create bot: ${message}`, "error", 4500);
      } finally {
        setAgentActionPendingId(null);
      }
      return;
    }

    const agentId = (agentProfileModal.agentId ?? "").trim();
    if (!agentId) {
      return;
    }
    const existingAgent = agents.find((candidate) => candidate.id === agentId) ?? null;
    const existingCustomAvatarUrl = normalizeCustomAgentAvatarSrc(existingAgent?.avatarSeed ?? null);
    const nextAvatarSeed =
      normalizedAvatarUrl ??
      (rawAvatarUrl.length === 0 && existingCustomAvatarUrl ? agentId : undefined);

    const shouldUpdateHandle = agentProfileModal.mode === "edit";
    const normalizedHandle = shouldUpdateHandle ? normalizeAgentHandle(agentHandleDraft) : null;
    if (shouldUpdateHandle && !normalizedHandle) {
      showStatus("Bot handle must look like @bob (letters/numbers, up to 20 chars).", "error", 4500);
      return;
    }
    const handleForRequest = normalizedHandle ?? undefined;

    const credentialId = (agentCredentialDraft ?? "").trim();
    const credentialSelectionRequired = codexCredentials.length > 0;
    if (credentialSelectionRequired && !credentialId) {
      showStatus("Select a credential to power this agent.", "error", 4500);
      return;
    }

    setAgentActionPendingId(agentId);
    try {
      const result = await updateMyAgent(agentId, {
        handle: handleForRequest,
        displayName: trimmedName.length > 0 ? trimmedName : null,
        avatarSeed: nextAvatarSeed,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        credentialId: credentialId.length > 0 ? credentialId : undefined,
        model: agentModelDraft,
      });
      if (!result.success || !result.agent) {
        showStatus(result.error ?? "Unable to update bot.", "error", 4500);
        return;
      }
      showStatus(`Updated @${result.agent.handle}.`, "success", 2500);
      closeAgentProfileModal();
      await loadCredentials({ silent: true });
      notifyAiConfigChanged("agent_updated");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to update bot: ${message}`, "error", 4500);
    } finally {
      setAgentActionPendingId(null);
    }
  }, [
    agentActionPendingId,
    agentAvatarUrlDraft,
    agentCredentialDraft,
    codexCredentials.length,
    agents,
    agentDescriptionDraft,
    agentHandleDraft,
    agentModelDraft,
    agentNameDraft,
    agentProfileModal,
    closeAgentProfileModal,
    loadCredentials,
    notifyAiConfigChanged,
    showStatus,
  ]);

  const handleDeleteAgent = useCallback(
    async (agent: ControllerAgentProfile) => {
      if (agentActionPendingId) {
        return;
      }
      if (typeof window !== "undefined") {
        const confirmed = window.confirm(`Delete @${agent.handle}? This will not revoke your credentials.`);
        if (!confirmed) {
          return;
        }
      }
      setAgentActionPendingId(agent.id);
      try {
        const result = await deleteMyAgent(agent.id);
        if (!result.success) {
          showStatus(result.error ?? "Unable to delete bot.", "error", 4500);
          return;
        }
        showStatus(`Deleted @${agent.handle}.`, "success", 2500);
        if (agentProfileModal?.agentId === agent.id) {
          closeAgentProfileModal();
        }
        await loadCredentials({ silent: true });
        notifyAiConfigChanged("agent_deleted");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to delete bot: ${message}`, "error", 4500);
      } finally {
        setAgentActionPendingId(null);
      }
    },
    [agentActionPendingId, agentProfileModal, closeAgentProfileModal, loadCredentials, notifyAiConfigChanged, showStatus]
  );

  const agentProfileModalMode: AgentProfileModalMode = agentProfileModal?.mode ?? "create";
  const agentProfileModalTitle =
    agentProfileModalMode === "create"
      ? "Create bot"
      : agentProfileModalMode === "octo"
        ? "Edit @octo"
        : `Edit ${agentHandleDraft.trim() || "@bot"}`;
  const agentProfileModalSubtitle =
    agentProfileModalMode === "create"
      ? (() => {
          const credentialId = (agentCredentialDraft ?? "").trim();
          const credential = credentialId ? credentialsById.get(credentialId) ?? null : null;
          const label = credential ? resolveCredentialLabel(credential) : null;
          return label ? `Powered by ${label}.` : "Powered by the selected credential.";
        })()
      : agentProfileModalMode === "octo"
        ? (() => {
            const credentialId = (agentCredentialDraft ?? "").trim();
            const credential = credentialId ? credentialsById.get(credentialId) ?? null : null;
            const label = credential ? resolveCredentialLabel(credential) : null;
            return label
              ? `Powered by ${label}. Used when @octo is asked to introduce itself.`
              : "Used when @octo is asked to introduce itself.";
          })()
        : undefined;

  const credentialsByProvider = useMemo(() => {
    const map = new Map<AiProviderId, ControllerCredentialListItem[]>();
    map.set("openai", []);
    map.set("deepseek", []);
    map.set("zai", []);
    map.set("gemini", []);
    for (const credential of codexCredentials) {
      const provider = resolveCredentialProviderId(credential);
      map.get(provider)?.push(credential);
    }
    return map;
  }, [codexCredentials]);

  const agentProviderOptions = useMemo(() => {
    return AI_PROVIDER_OPTIONS.map((option) => ({
      ...option,
      disabled: (credentialsByProvider.get(option.id)?.length ?? 0) === 0,
    }));
  }, [credentialsByProvider]);

  const agentCredentialOptions = useMemo(() => {
    const list = credentialsByProvider.get(agentProviderDraft) ?? [];
    if (!agentCredentialDraft) {
      return list;
    }
    if (list.some((credential) => credential.id === agentCredentialDraft)) {
      return list;
    }
    const selected = codexCredentials.find((credential) => credential.id === agentCredentialDraft) ?? null;
    return selected ? [selected, ...list] : list;
  }, [agentCredentialDraft, agentProviderDraft, codexCredentials, credentialsByProvider]);

  const agentModelOptions = useMemo(() => {
    return modelOptionsForProvider(agentProviderDraft);
  }, [agentProviderDraft]);

  const handleAgentProviderChange = useCallback(
    (provider: AiProviderId) => {
      setAgentProviderDraft(provider);
      setAgentCredentialDraft((prev) => {
        const list = credentialsByProvider.get(provider) ?? [];
        if (prev && list.some((credential) => credential.id === prev)) {
          return prev;
        }
        return list[0]?.id ?? null;
      });
      setAgentModelDraft((prev) => {
        const normalizedPrev = normalizeAiModelId(provider, prev);
        if (!normalizedPrev) {
          return normalizedPrev;
        }
        const allowed = modelOptionsForProvider(provider).some(
          (option) => option.id === normalizedPrev,
        );
        return allowed ? normalizedPrev : null;
      });
    },
    [credentialsByProvider]
  );

  const handleCreateBotFromManager = useCallback(() => {
    if (!defaultCredentialId) {
      showStatus("Connect an AI credential first to create bots.", "error", 4500);
      return;
    }
    openCreateBotModal(defaultCredentialId);
  }, [defaultCredentialId, openCreateBotModal, showStatus]);

  const handleConnectCredentialFromModal = useCallback(() => {
    const step =
      agentProviderDraft === "deepseek"
        ? "deepseek"
        : agentProviderDraft === "zai"
          ? "zai"
          : agentProviderDraft === "gemini"
            ? "gemini"
            : "codex";
    closeAgentProfileModal();
    openConnectModalAtStep(step);
  }, [agentProviderDraft, closeAgentProfileModal, openConnectModalAtStep]);

  return (
    <>
      <AgentProfileModal
        isOpen={Boolean(agentProfileModal)}
        mode={agentProfileModalMode}
        title={agentProfileModalTitle}
        subtitle={agentProfileModalSubtitle}
        pending={Boolean(agentActionPendingId)}
        credentialId={agentCredentialDraft}
        credentials={agentCredentialOptions}
        onCredentialChange={handleAgentCredentialChange}
        onConnectCredential={handleConnectCredentialFromModal}
        providerId={agentProviderDraft}
        providerOptions={agentProviderOptions}
        onProviderChange={handleAgentProviderChange}
        modelId={agentModelDraft}
        modelOptions={agentModelOptions}
        onModelChange={setAgentModelDraft}
        handle={agentHandleDraft}
        onHandleChange={setAgentHandleDraft}
        handleDisabled={agentProfileModalMode === "octo"}
        handlePlaceholder={agentProfileModalMode === "create" ? "@bot (optional)" : "@bob"}
        handleHelpText={
          agentProfileModalMode === "create"
            ? "Leave empty to auto-generate a handle from the credential label."
            : undefined
        }
        displayName={agentNameDraft}
        onDisplayNameChange={setAgentNameDraft}
        avatarImageUrl={agentAvatarUrlDraft}
        onAvatarImageUrlChange={setAgentAvatarUrlDraft}
        description={agentDescriptionDraft}
        onDescriptionChange={setAgentDescriptionDraft}
        onClose={closeAgentProfileModal}
        onSave={() => void handleSaveAgentProfile()}
        saveLabel={agentProfileModalMode === "create" ? "Create bot" : "Save"}
      />

      <div className="space-y-8" data-testid="credentials-settings-card">
        <StudioListSection
          title="AI connections"
          description="Connect providers and choose what new prompts use."
          tone="activity"
          icon={<Cpu className="h-5 w-5" aria-hidden={true} />}
          actions={
            codexCredentials.length > 0 ? (
              <SettingsAddButton
                onPress={openConnectModal}
                isDisabled={!canManageAiConnections || loading}
                data-testid="credentials-add-connection"
                ariaLabel="Add AI connection"
                title="Add AI connection"
              />
            ) : null
          }
        >
          <div className="min-w-0 space-y-3">
            {runtimeControllerEnabled && user && aiModeSummary ? (
              <div
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm"
                data-testid="credentials-ai-mode-summary"
              >
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {aiModeSummary.title}
                </span>
                <Text variant="caption" tone="muted" className="min-w-0 max-w-3xl">
                  {aiModeSummary.detail}
                </Text>
                {canSwitchToManagedAi ? (
                  <Button
                    onPress={() => void handleUseManagedAi()}
                    isDisabled={actionPendingId === "managed-ai"}
                    variant="outline"
                    size="xs"
                    radius="full"
                    data-testid="credentials-use-managed-ai"
                  >
                    Use Instafy AI
                  </Button>
                ) : null}
              </div>
            ) : null}

            {!runtimeControllerEnabled ? (
              <div className="px-1" data-testid="credentials-empty">
                <Text as="div" variant="body" className="font-semibold">
                  Runtime controller is not connected
                </Text>
                <Text as="div" variant="caption" tone="muted">
                  Connect the runtime controller to manage AI connections.
                </Text>
              </div>
            ) : !user ? (
              <div className="px-1">
                <Text as="div" variant="body" className="font-semibold">
                  Sign in required
                </Text>
                <Text as="div" variant="caption" tone="muted">
                  Sign in to manage AI connections.
                </Text>
              </div>
            ) : null}

            {runtimeControllerEnabled && user && !loading && codexCredentials.length === 0 ? (
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-1 py-1">
                <div className="min-w-0">
                  <Text as="div" variant="body" className="font-semibold">
                    No AI connections yet
                  </Text>
                  <Text as="div" variant="caption" tone="muted">
                    Connect a provider to use your own account.
                  </Text>
                </div>
                <Button
                  onPress={openConnectModal}
                  isDisabled={!canManageAiConnections || loading}
                  variant="outline"
                  size="xs"
                  radius="full"
                  data-testid="credentials-add-connection"
                >
                  Connect AI
                </Button>
              </div>
            ) : null}

            {codexCredentials.length > 0 ? (
              <ul className="space-y-2" data-testid="credentials-list-codex">
                {codexCredentials.map((credential) => {
                  const label = resolveCredentialLabel(credential);
                  const kindLabel = formatCredentialKind(credential);
                  const accountHint = resolveCredentialAccountHint(credential);
                  const metadata = credential.metadata as Record<string, unknown> | null | undefined;
                  const provider =
                    typeof metadata?.provider === "string" ? metadata.provider.trim().toLowerCase() : "";
                  const icon =
                    credential.kind === "codex_auth_json" ? (
                      <OpenAIIcon className="h-5 w-5" />
                    ) : provider === "deepseek" ? (
                      <DeepSeekIcon className="h-5 w-5" />
                    ) : provider === "zai" || provider === "z.ai" ? (
                      <ZaiIcon className="h-5 w-5" />
                    ) : provider === "gemini" ||
                      provider === "google" ||
                      provider === "google-ai" ||
                      provider === "google_gemini" ||
                      provider === "google-gemini" ? (
                      <GeminiIcon className="h-5 w-5" />
                    ) : (
                      <OpenAIIcon className="h-5 w-5" />
                    );
                  const iconTone =
                    credential.kind === "codex_auth_json"
                      ? "text-slate-900 dark:text-slate-50"
                      : provider === "deepseek"
                        ? "text-[#2563EB] dark:text-slate-50"
                        : provider === "zai" || provider === "z.ai"
                          ? "text-[#7C3AED] dark:text-slate-50"
                          : provider === "gemini" ||
                            provider === "google" ||
                            provider === "google-ai" ||
                            provider === "google_gemini" ||
                            provider === "google-gemini"
                            ? "text-[#0EA5E9] dark:text-slate-50"
                          : "text-slate-900 dark:text-slate-50";
                  const pending = actionPendingId === credential.id;
                  const testPending = credentialTestPendingId === credential.id;
                  const canReconnectAuthJson = canReconnectCredentialInPlace(credential);
                  const testFeedbackEntry = credentialTestFeedback[credential.id] ?? null;
                  const testFeedbackState = testFeedbackEntry?.status ?? null;
                  const testFeedbackLabel = testFeedbackState
                    ? resolveCredentialTestStatusLabel(testFeedbackState)
                    : null;
                  const testFeedbackToneClass =
                    testFeedbackState === "ok"
                      ? "text-emerald-700 dark:text-emerald-300"
                      : testFeedbackState === "needs_reconnect"
                        ? "text-secondary-700 dark:text-secondary-200"
                      : "text-rose-600 dark:text-rose-300";
                  const testFeedbackTitle =
                    testFeedbackState === "ok"
                      ? "Last test passed"
                      : testFeedbackState === "needs_reconnect"
                        ? testFeedbackEntry?.detail
                          ? `Credential needs reconnect: ${testFeedbackEntry.detail}`
                          : "Credential needs reconnect"
                      : testFeedbackEntry?.detail
                        ? `Last test failed: ${testFeedbackEntry.detail}`
                        : "Last test failed";
                  const testFeedbackDetailClass =
                    testFeedbackState === "needs_reconnect"
                      ? "text-secondary-700 dark:text-secondary-200"
                      : "text-rose-500 dark:text-rose-300";

                  return (
                    <li key={credential.id} data-testid={`credentials-connection-row-${credential.id}`}>
                      <EntityRow
                        surface="outlined"
                        density="rich"
                        start={
                          <span
                            className={[
                              "flex h-9 w-9 items-center justify-center rounded-full ring-1 ring-black/5 dark:ring-white/10",
                              "bg-white/90 dark:bg-slate-950/40",
                              iconTone,
                            ].join(" ")}
                            aria-hidden="true"
                          >
                            {icon}
                          </span>
                        }
                        title={label}
                        titleEnd={
                          testFeedbackState === "needs_reconnect" || credential.isDefault ? (
                            <span className="inline-flex min-w-0 items-center justify-end gap-1">
                              {testFeedbackState === "needs_reconnect" ? (
                                <Badge tone="warning" size="xs">
                                  Needs reconnect
                                </Badge>
                              ) : null}
                              {credential.isDefault ? (
                                <Badge size="xs" className="md:hidden">
                                  Default
                                </Badge>
                              ) : null}
                            </span>
                          ) : null
                        }
                        subtitle={
                          <>
                            {kindLabel}
                            {accountHint ? ` · ${accountHint}` : ""}
                          </>
                        }
                        detail={
                          testPending ? (
                            <div className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                              <Spinner aria-hidden="true" size="xs" tone="slate" />
                              <span>Testing...</span>
                            </div>
                          ) : testFeedbackLabel ? (
                            <div
                              className="min-w-0"
                              title={testFeedbackTitle}
                              data-testid={`credentials-connection-test-result-${credential.id}`}
                            >
                              <span
                                className={[
                                  "inline-flex items-center gap-1 text-xs",
                                  testFeedbackToneClass,
                                ].join(" ")}
                              >
                                <CredentialTestStatusIcon status={testFeedbackState ?? "fail"} />
                                <span>{testFeedbackLabel}</span>
                              </span>
                              {testFeedbackEntry?.status !== "ok" && testFeedbackEntry?.detail ? (
                                <span className={["mt-0.5 block truncate text-xs", testFeedbackDetailClass].join(" ")}>
                                  {testFeedbackEntry.detail}
                                </span>
                              ) : null}
                            </div>
                          ) : null
                        }
                        className="items-start"
                        startClassName="pt-0.5"
                        detailClassName="min-w-0"
                        end={
                          <div className="flex items-center gap-2">
                            <div className="hidden md:flex items-center gap-2">
                              {credential.isDefault ? (
                                <Badge size="xs">Default</Badge>
                              ) : (
                                <Button
                                  onPress={() => void handleMakeDefault(credential.id)}
                                  isDisabled={pending || testPending}
                                  variant="ghost"
                                  size="xs"
                                  radius="full"
                                  data-testid={`credentials-connection-default-${credential.id}`}
                                >
                                  Make default
                                </Button>
                              )}

                              <Button
                                onPress={() => void handleTestCredential(credential.id)}
                                isDisabled={pending || testPending}
                                variant="outline"
                                size="xs"
                                radius="full"
                                className="gap-1.5"
                                data-testid={`credentials-connection-test-${credential.id}`}
                              >
                                {testPending ? <Spinner aria-hidden="true" size="xs" tone="primary" /> : null}
                                {testPending ? "Testing…" : testFeedbackEntry ? "Retest" : "Test"}
                              </Button>

                              {canReconnectAuthJson ? (
                                <Button
                                  onPress={() => handleTriggerReconnectCredential(credential.id)}
                                  isDisabled={pending || testPending}
                                  variant={testFeedbackState === "needs_reconnect" ? "outline" : "ghost"}
                                  size="xs"
                                  radius="full"
                                  className={[
                                    "gap-1.5",
                                    testFeedbackState === "needs_reconnect"
                                      ? "border-secondary-200 bg-secondary-50 text-secondary-800 hover:bg-secondary-100 dark:border-secondary-500/40 dark:bg-secondary-500/10 dark:text-secondary-100 dark:hover:bg-secondary-500/15"
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}
                                  data-testid={`credentials-connection-reconnect-${credential.id}`}
                                >
                                  {pending ? <Spinner aria-hidden="true" size="xs" tone="primary" /> : null}
                                  {pending ? "Reconnecting…" : "Reconnect"}
                                </Button>
                              ) : null}

                              <IconButton
                                onPress={() => void handleRevoke(credential.id)}
                                isDisabled={pending || testPending}
                                variant="ghost"
                                radius="full"
                                size="xs"
                                aria-label={`Remove ${label}`}
                                data-testid={`credentials-connection-remove-${credential.id}`}
                              >
                                <Trash className="h-4 w-4" aria-hidden="true" />
                              </IconButton>
                            </div>

                            <div className="md:hidden">
                              <MenuTrigger
                                isOpen={mobileCredentialMenuId === credential.id}
                                onOpenChange={(open) => {
                                  if (!open) {
                                    const lastAction = mobileCredentialMenuLastActionRef.current;
                                    mobileCredentialMenuLastActionRef.current = null;
                                    if (lastAction === "test") {
                                      setMobileCredentialMenuId(credential.id);
                                      return;
                                    }
                                    setMobileCredentialMenuId((current) =>
                                      current === credential.id ? null : current,
                                    );
                                    return;
                                  }
                                  mobileCredentialMenuLastActionRef.current = null;
                                  setMobileCredentialMenuId(credential.id);
                                }}
                              >
                                <IconButton
                                  variant="ghost"
                                  radius="full"
                                  size="xs"
                                  aria-label={`Manage ${label}`}
                                  isDisabled={pending}
                                  data-testid={`credentials-connection-menu-${credential.id}`}
                                >
                                  <MoreHoriz className="h-4 w-4" aria-hidden="true" />
                                </IconButton>
                                <StudioPopover placement="left top" offset={8} className="w-56 p-1">
                                  <StudioMenu
                                    aria-label="Connection actions"
                                    onClose={() => {}}
                                    onAction={(key) => {
                                      const action = String(key);
                                      mobileCredentialMenuLastActionRef.current = action;
                                      if (action === "default") {
                                        void handleMakeDefault(credential.id);
                                        setMobileCredentialMenuId(null);
                                      } else if (action === "test") {
                                        void handleTestCredential(credential.id);
                                        setMobileCredentialMenuId(credential.id);
                                      } else if (action === "reconnect") {
                                        handleTriggerReconnectCredential(credential.id);
                                        setMobileCredentialMenuId(null);
                                      } else if (action === "remove") {
                                        void handleRevoke(credential.id);
                                        setMobileCredentialMenuId(null);
                                      }
                                    }}
                                  >
                                    {!credential.isDefault ? (
                                      <StudioMenuItem id="default" isDisabled={testPending}>
                                        <MenuItemContent>Make default</MenuItemContent>
                                      </StudioMenuItem>
                                    ) : (
                                      <StudioMenuItem id="default" isDisabled>
                                        <MenuItemContent>Default</MenuItemContent>
                                      </StudioMenuItem>
                                    )}
                                    <StudioMenuItem id="test" isDisabled={testPending}>
                                      <MenuItemContent
                                        start={
                                          testPending ? (
                                            <Spinner aria-hidden="true" size="xs" tone="primary" />
                                          ) : null
                                        }
                                      >
                                        {testPending ? "Testing…" : "Test"}
                                      </MenuItemContent>
                                    </StudioMenuItem>
                                    {testPending ? (
                                      <StudioMenuItem
                                        id="test-status"
                                        isDisabled
                                        className="py-1 data-[disabled]:cursor-default data-[disabled]:opacity-100"
                                      >
                                        <MenuItemContent textClassName="text-xs text-slate-500 dark:text-slate-400">
                                          Checking this credential…
                                        </MenuItemContent>
                                      </StudioMenuItem>
                                    ) : testFeedbackEntry?.status ? (
                                      <StudioMenuItem
                                        id="test-status"
                                        isDisabled
                                        className="py-1 data-[disabled]:cursor-default data-[disabled]:opacity-100"
                                        data-testid={`credentials-connection-test-result-mobile-${credential.id}`}
                                      >
                                        <MenuItemContent
                                          start={<CredentialTestStatusIcon status={testFeedbackEntry.status} />}
                                          startClassName={["shrink-0", testFeedbackToneClass].join(" ")}
                                          textClassName={["text-xs", testFeedbackToneClass].join(" ")}
                                        >
                                          {resolveCredentialTestStatusLabel(testFeedbackEntry.status)}
                                        </MenuItemContent>
                                      </StudioMenuItem>
                                    ) : null}
                                    {testFeedbackEntry?.status !== "ok" && testFeedbackEntry?.detail ? (
                                      <StudioMenuItem
                                        id="test-status-detail"
                                        isDisabled
                                        className="py-1 data-[disabled]:cursor-default data-[disabled]:opacity-100"
                                      >
                                        <MenuItemContent textClassName={["text-xs", testFeedbackDetailClass].join(" ")}>
                                          {testFeedbackEntry.detail}
                                        </MenuItemContent>
                                      </StudioMenuItem>
                                    ) : null}
                                    {canReconnectAuthJson ? (
                                      <StudioMenuItem id="reconnect" isDisabled={testPending}>
                                        <MenuItemContent start={<Upload aria-hidden="true" />}>
                                          Reconnect auth.json…
                                        </MenuItemContent>
                                      </StudioMenuItem>
                                    ) : null}
                                    <StudioMenuSeparator />
                                    <StudioMenuItem id="remove" isDisabled={testPending}>
                                      <MenuItemContent
                                        start={<Trash aria-hidden="true" />}
                                        textClassName="text-rose-600 dark:text-rose-300"
                                      >
                                        Remove…
                                      </MenuItemContent>
                                    </StudioMenuItem>
                                  </StudioMenu>
                                </StudioPopover>
                              </MenuTrigger>
                            </div>
                          </div>
                        }
                        endClassName="self-center"
                      />
                    </li>
                  );
                })}
              </ul>
          ) : null}
          </div>
        </StudioListSection>

        <StudioListSection
          title="Agents"
          description="Customize @octo and create bots for quick styles."
          tone="suggestion"
          icon={<Brain className="h-5 w-5" aria-hidden={true} />}
          actions={
            defaultCredentialId ? (
              <SettingsAddButton
                onPress={handleCreateBotFromManager}
                isDisabled={Boolean(agentActionPendingId)}
                data-testid="bots-create"
                ariaLabel="Create bot"
                title="Create bot"
              />
            ) : null
          }
        >
          {octoAgent || botAgents.length > 0 ? (
              <ul className="space-y-2" data-testid="bots-list">
                {octoAgent ? (
                  <li>
                    <EntityRow
                      surface="outlined"
                      title="@octo"
                      subtitle={octoAgent.displayName ? octoAgent.displayName : "Octo"}
                      start={<AgentAvatar agent={octoAgent} />}
                      density="compact"
                      isDisabled={agentActionPendingId === octoAgent.id}
                      className="items-start"
                      startClassName="pt-0.5"
                      end={
                        <IconButton
                          onPress={() => openOctoProfileModal(octoAgent)}
                          isDisabled={agentActionPendingId === octoAgent.id}
                          variant="ghost"
                          size="xs"
                          radius="full"
                          aria-label="Edit @octo"
                          data-testid="bots-octo-edit"
                        >
                          <EditPencil className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                      }
                      endClassName="self-center"
                    />
                  </li>
                ) : null}

                {botAgents.map((agent) => {
                  const connectedCredential = agent.credentialId ? credentialsById.get(agent.credentialId) : null;
                  const connectedLabel = connectedCredential ? resolveCredentialLabel(connectedCredential) : null;
                  const pending = agentActionPendingId === agent.id;
                  return (
                    <li key={agent.id}>
                      <EntityRow
                        surface="outlined"
                        title={`@${agent.handle}`}
                        subtitle={
                          <>
                            {agent.displayName ? agent.displayName : "Bot"}
                            {connectedLabel ? ` · ${connectedLabel}` : ""}
                          </>
                        }
                        start={<AgentAvatar agent={agent} />}
                        density="compact"
                        isDisabled={pending}
                        className="items-start"
                        startClassName="pt-0.5"
                        end={
                          <div className="flex flex-none items-center gap-1">
                            <div className="hidden md:flex items-center gap-1">
                              <IconButton
                                onPress={() => openEditBotModal(agent)}
                                isDisabled={pending}
                                variant="ghost"
                                radius="full"
                                size="xs"
                                aria-label={`Edit @${agent.handle}`}
                                data-testid={`bots-edit-${agent.id}`}
                              >
                                <EditPencil className="h-4 w-4" aria-hidden="true" />
                              </IconButton>
                              <IconButton
                                onPress={() => void handleDeleteAgent(agent)}
                                isDisabled={pending}
                                variant="ghost"
                                radius="full"
                                size="xs"
                                aria-label={`Delete @${agent.handle}`}
                                data-testid={`bots-delete-${agent.id}`}
                              >
                                <Trash className="h-4 w-4" aria-hidden="true" />
                              </IconButton>
                            </div>

                            <div className="md:hidden">
                              <MenuTrigger>
                                <IconButton
                                  variant="ghost"
                                  radius="full"
                                  size="xs"
                                  aria-label={`Manage @${agent.handle}`}
                                  isDisabled={pending}
                                >
                                  <MoreHoriz className="h-4 w-4" aria-hidden="true" />
                                </IconButton>
                                <StudioPopover placement="left top" offset={8} className="w-56 p-1">
                                  <StudioMenu
                                    aria-label="Bot actions"
                                    onAction={(key) => {
                                      const action = String(key);
                                      if (action === "edit") {
                                        openEditBotModal(agent);
                                      } else if (action === "delete") {
                                        void handleDeleteAgent(agent);
                                      }
                                    }}
                                  >
                                    <StudioMenuItem id="edit">
                                      <MenuItemContent>Edit</MenuItemContent>
                                    </StudioMenuItem>
                                    <StudioMenuSeparator />
                                    <StudioMenuItem id="delete">
                                      <MenuItemContent
                                        start={<Trash aria-hidden="true" />}
                                        textClassName="text-rose-600 dark:text-rose-300"
                                      >
                                        Delete…
                                      </MenuItemContent>
                                    </StudioMenuItem>
                                  </StudioMenu>
                                </StudioPopover>
                              </MenuTrigger>
                            </div>
                          </div>
                        }
                        endClassName="self-center"
                      />
                    </li>
                  );
                })}
              </ul>
          ) : runtimeControllerEnabled && user ? (
            <StudioListSurface>
              <StudioListRow separated={false}>
                <EntityRow
                  surface="plain"
                  density="compact"
                  className={AI_MANAGER_ROW_CLASS_NAME}
                  start={
                    <span className={AI_MANAGER_ICON_CLASS_NAME} aria-hidden={true}>
                      <Brain className="h-5 w-5" />
                    </span>
                  }
                  startClassName="self-center"
                  title="No bots yet"
                  subtitle={
                    defaultCredentialId
                      ? "Create a custom handle when you want a different style or model."
                      : "Connect AI before creating custom bot handles."
                  }
                  end={
                    defaultCredentialId ? (
                      <Button
                        onPress={handleCreateBotFromManager}
                        isDisabled={Boolean(agentActionPendingId)}
                        variant="outline"
                        size="xs"
                        radius="full"
                      >
                        Create bot
                      </Button>
                    ) : null
                  }
                  endClassName="self-center"
                />
              </StudioListRow>
            </StudioListSurface>
          ) : null}
        </StudioListSection>
      </div>

      <input
        ref={reconnectFileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        data-testid="credentials-reconnect-auth-json-input"
        onChange={handleReconnectCredentialFile}
      />
      <CredentialsConnectModal {...connectModalProps} />
    </>
  );
}
