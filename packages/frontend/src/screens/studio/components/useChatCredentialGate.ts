import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import { controllerClient } from "../../../sdk/instafy";
import type { StatusIntent } from "../../../status/useStatus";
import type { ChatMessage } from "../types";
import type { AiCredentialsGateState } from "./AiCredentialsStatusBubble";
import { AI_CONFIG_CHANGED_EVENT } from "./aiConfigEvents";
import {
  defaultAiConnectWizardState,
  readAiConnectWizardState,
  writeAiConnectWizardState,
  type AiConnectWizardMode,
} from "./aiConnectWizardStorage";
import { shouldDisplayChatMessage } from "./chatMessagePresentation";
import { resolveAiCredentialGateState } from "./credentialGateState";
import { connectDesktopCodexAuthJson } from "./desktopCodexAuthJson";
import { isExpiredCredentialProxyError } from "./proxyError";
import { canRestorePersistedAiOnboarding } from "./gettingStartedAiChoices";

const {
  createCodex: createCodexCredential,
  getRequirements: getCredentialRequirements,
  list: listMyCredentials,
  setDefault: setDefaultCredential,
} = controllerClient.credentials;

const CREDENTIAL_DRAFT_STORAGE_KEY = "instafy.chat.credentialsDraft";
const CREDENTIAL_GATE_CACHE_TTL_MS = 5 * 60 * 1000;
const CREDENTIAL_GATE_CHECKING_RECHECK_MS = 5_000;
const CREDENTIAL_GATE_REQUEST_TIMEOUT_MS = 8_000;
const CREDENTIAL_GATE_CHECKING_TIMEOUT_MS = 20_000;

type PendingCredentialDraft = {
  conversationId: string;
  draft: string;
  editorState: string | null;
  createdAt: number;
  autoSubmit: boolean;
};

type CredentialRequirementState = {
  requiresUserCredentials: boolean | null;
  proxyBackend: string | null;
  hasDefaultCredential: boolean;
  managedAi: {
    enabled: boolean;
    available: boolean;
    label: string;
    creditBurnAmount: number;
    dailyPromptLimit: number;
    dailyPromptsUsed: number;
    remainingPrompts: number | null;
  } | null;
  error: string | null;
};

type CredentialGateStatusState = {
  status: "unknown" | "loading" | "ready" | "missing" | "needs_default" | "error";
  error: string | null;
};

type CredentialGateCacheEntry = {
  requirements: CredentialRequirementState;
  gateStatus: CredentialGateStatusState;
  updatedAt: number;
};

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;
type FocusInput = (options?: { force?: boolean }) => void;
type RefreshAvailableAgents = (options?: { silent?: boolean }) => void | Promise<void>;

type UseChatCredentialGateOptions = {
  activeConversationId: string | null;
  activeProjectId: string | null;
  aiConnectWizardStorageKey: string | null;
  canUseDesktopConnect: boolean;
  currentUserId: string | null;
  focusInput: FocusInput;
  hasUser: boolean;
  inputEditorState: string | null;
  inputRequiresAi: boolean;
  inputValue: string;
  messages: ChatMessage[];
  onInputChange: (conversationId: string, value: string, editorState: string | null) => void;
  pinAiOnboardingToBottom: () => void;
  pendingCredentialAutoSubmitRef: MutableRefObject<boolean>;
  refreshAvailableAgents: RefreshAvailableAgents;
  runtimeControllerEnabled: boolean;
  showStatus: ShowStatus;
};

const credentialGateCache = new Map<string, CredentialGateCacheEntry>();

function buildCredentialGateCacheKey(userId: string | null, projectId: string | null): string | null {
  const userKey = typeof userId === "string" ? userId.trim() : "";
  const projectKey = typeof projectId === "string" ? projectId.trim() : "";
  if (!userKey || !projectKey) {
    return null;
  }
  return `${userKey}:${projectKey}`;
}

function readCredentialGateCache(cacheKey: string | null): CredentialGateCacheEntry | null {
  if (!cacheKey) {
    return null;
  }
  const cached = credentialGateCache.get(cacheKey) ?? null;
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.updatedAt > CREDENTIAL_GATE_CACHE_TTL_MS) {
    credentialGateCache.delete(cacheKey);
    return null;
  }
  return cached;
}

// Both endpoints behind this cache (/me/credentials and
// /me/credentials/requirements) are user-scoped, so the freshest entry the
// same user resolved in any other space is valid seed data for a new one.
// The live refreshes still run and replace the seed within one round-trip.
function readCredentialGateCacheForUser(userId: string | null): CredentialGateCacheEntry | null {
  const userKey = typeof userId === "string" ? userId.trim() : "";
  if (!userKey) {
    return null;
  }
  const prefix = `${userKey}:`;
  const now = Date.now();
  let freshest: CredentialGateCacheEntry | null = null;
  for (const [key, entry] of credentialGateCache) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    if (now - entry.updatedAt > CREDENTIAL_GATE_CACHE_TTL_MS) {
      credentialGateCache.delete(key);
      continue;
    }
    if (!freshest || entry.updatedAt > freshest.updatedAt) {
      freshest = entry;
    }
  }
  return freshest;
}

function readSeededCredentialGateCache(
  cacheKey: string | null,
  userId: string | null,
): CredentialGateCacheEntry | null {
  return readCredentialGateCache(cacheKey) ?? readCredentialGateCacheForUser(userId);
}

function writeCredentialGateCache(cacheKey: string | null, entry: CredentialGateCacheEntry): void {
  if (!cacheKey) {
    return;
  }
  credentialGateCache.set(cacheKey, entry);
}

function deleteCredentialGateCache(cacheKey: string | null): void {
  if (!cacheKey) {
    return;
  }
  credentialGateCache.delete(cacheKey);
}

function createDefaultCredentialRequirementState(controllerEnabled: boolean): CredentialRequirementState {
  return {
    requiresUserCredentials: controllerEnabled ? null : false,
    proxyBackend: null,
    hasDefaultCredential: false,
    managedAi: null,
    error: null,
  };
}

function createDefaultCredentialGateStatusState(controllerEnabled: boolean): CredentialGateStatusState {
  return {
    status: controllerEnabled ? "unknown" : "ready",
    error: null,
  };
}

function withCredentialGateTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  if (typeof window === "undefined") {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out. Retry after the local stack is ready.`));
    }, CREDENTIAL_GATE_REQUEST_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function readPendingCredentialDraft(): PendingCredentialDraft | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CREDENTIAL_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PendingCredentialDraft> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.conversationId !== "string" || parsed.conversationId.trim().length === 0) {
      return null;
    }
    return {
      conversationId: parsed.conversationId,
      draft: typeof parsed.draft === "string" ? parsed.draft : "",
      editorState: typeof parsed.editorState === "string" ? parsed.editorState : null,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      autoSubmit: parsed.autoSubmit === true,
    };
  } catch {
    return null;
  }
}

function writePendingCredentialDraft(value: PendingCredentialDraft | null) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!value) {
      window.localStorage.removeItem(CREDENTIAL_DRAFT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CREDENTIAL_DRAFT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

export function useChatCredentialGate({
  activeConversationId,
  activeProjectId,
  aiConnectWizardStorageKey,
  canUseDesktopConnect,
  currentUserId,
  focusInput,
  hasUser,
  inputEditorState,
  inputRequiresAi,
  inputValue,
  messages,
  onInputChange,
  pinAiOnboardingToBottom,
  pendingCredentialAutoSubmitRef,
  refreshAvailableAgents,
  runtimeControllerEnabled,
  showStatus,
}: UseChatCredentialGateOptions) {
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const [availableCredentials, setAvailableCredentials] = useState<ControllerCredentialListItem[]>([]);
  const credentialGateCacheKey = useMemo(
    () => buildCredentialGateCacheKey(currentUserId, activeProjectId),
    [activeProjectId, currentUserId],
  );
  const cachedCredentialGate = useMemo(
    () =>
      runtimeControllerEnabled
        ? readSeededCredentialGateCache(credentialGateCacheKey, currentUserId)
        : null,
    [credentialGateCacheKey, currentUserId, runtimeControllerEnabled],
  );
  const [credentialRequirements, setCredentialRequirements] = useState<CredentialRequirementState>(
    () => cachedCredentialGate?.requirements ?? createDefaultCredentialRequirementState(runtimeControllerEnabled),
  );
  const [credentialGateStatus, setCredentialGateStatus] = useState<CredentialGateStatusState>(
    () => cachedCredentialGate?.gateStatus ?? createDefaultCredentialGateStatusState(runtimeControllerEnabled),
  );
  // The cache records what a key resolved live. A seed is another key's
  // answer and stays cached there on its own clock; re-recording it under this
  // key with a fresh clock would keep an aging answer alive for another full
  // TTL and make it the freshest seed for every later space.
  const seededCredentialGateRef = useRef<CredentialGateCacheEntry | null>(cachedCredentialGate);
  // The commit that changes the key still carries the previous key's state,
  // so the key the state belongs to follows one commit behind.
  const [credentialStateKey, setCredentialStateKey] = useState(credentialGateCacheKey);
  const credentialsRequired =
    runtimeControllerEnabled && credentialRequirements.requiresUserCredentials !== false;
  const credentialsReady = !credentialsRequired || credentialGateStatus.status === "ready";
  const lastCredentialCheckRef = useRef(0);
  const credentialReadyRef = useRef(credentialsReady);
  const [aiOnboardingOpen, setAiOnboardingOpen] = useState(false);
  const [aiOnboardingMode, setAiOnboardingMode] = useState<AiConnectWizardMode>("default");
  const [aiOnboardingCompletion, setAiOnboardingCompletion] = useState<{
    id: number;
    mode: AiConnectWizardMode;
    storageKey: string | null;
  } | null>(null);
  const [credentialGateCheckingVisible, setCredentialGateCheckingVisible] = useState(false);
  const aiOnboardingBaselineRef = useRef<{
    credentialCount: number;
    defaultCredentialId: string | null;
  } | null>(null);
  const previousAiConnectWizardStorageKeyRef = useRef(aiConnectWizardStorageKey);
  const lastExpiredCredentialMessageIdRef = useRef<string | null>(null);

  const activeAiCredentials = useMemo(
    () =>
      availableCredentials.filter(
        (credential) =>
          !credential.revokedAt &&
          (credential.kind === "codex_auth_json" || credential.kind === "openai_api_key"),
      ),
    [availableCredentials],
  );
  const defaultAiCredential = useMemo(
    () => activeAiCredentials.find((credential) => credential.isDefault) ?? null,
    [activeAiCredentials],
  );

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      setCredentialRequirements(createDefaultCredentialRequirementState(false));
      setCredentialGateStatus(createDefaultCredentialGateStatusState(false));
      return;
    }
    const cached = readSeededCredentialGateCache(credentialGateCacheKey, currentUserId);
    seededCredentialGateRef.current = cached;
    setCredentialRequirements(cached?.requirements ?? createDefaultCredentialRequirementState(true));
    setCredentialGateStatus(cached?.gateStatus ?? createDefaultCredentialGateStatusState(true));
    setCredentialStateKey(credentialGateCacheKey);
  }, [credentialGateCacheKey, currentUserId, runtimeControllerEnabled]);

  useEffect(() => {
    if (!runtimeControllerEnabled || credentialStateKey !== credentialGateCacheKey) {
      return;
    }
    const requirementsResolved = credentialRequirements.requiresUserCredentials !== null;
    const gateResolved = credentialGateStatus.status !== "unknown" && credentialGateStatus.status !== "loading";
    if (!requirementsResolved && !gateResolved) {
      return;
    }
    const existing = readCredentialGateCache(credentialGateCacheKey);
    const nextRequirements = requirementsResolved
      ? credentialRequirements
      : (existing?.requirements ?? credentialRequirements);
    const nextGateStatus = gateResolved
      ? credentialGateStatus
      : (existing?.gateStatus ?? credentialGateStatus);

    const hasResolvedRequirements = nextRequirements.requiresUserCredentials !== null;
    const hasResolvedGateStatus =
      nextGateStatus.status !== "unknown" && nextGateStatus.status !== "loading";
    if (!hasResolvedRequirements && !hasResolvedGateStatus) {
      return;
    }
    const seed = seededCredentialGateRef.current;
    if (seed && nextRequirements === seed.requirements && nextGateStatus === seed.gateStatus) {
      return;
    }

    writeCredentialGateCache(credentialGateCacheKey, {
      requirements: { ...nextRequirements },
      gateStatus: { ...nextGateStatus },
      updatedAt: Date.now(),
    });
  }, [credentialGateCacheKey, credentialGateStatus, credentialRequirements, credentialStateKey, runtimeControllerEnabled]);

  const openAiOnboarding = useCallback((options?: { mode?: AiConnectWizardMode }) => {
    const mode = options?.mode ?? "default";
    if (aiConnectWizardStorageKey) {
      const stored = readAiConnectWizardState(aiConnectWizardStorageKey);
      writeAiConnectWizardState(aiConnectWizardStorageKey, {
        ...(stored ?? defaultAiConnectWizardState()),
        open: true,
        mode,
        updatedAt: Date.now(),
      });
    }
    aiOnboardingBaselineRef.current = {
      credentialCount: activeAiCredentials.length,
      defaultCredentialId: defaultAiCredential?.id ?? null,
    };
    setAiOnboardingMode(mode);
    setAiOnboardingOpen(true);
    pinAiOnboardingToBottom();
  }, [activeAiCredentials.length, aiConnectWizardStorageKey, defaultAiCredential?.id, pinAiOnboardingToBottom]);

  const closeAiOnboarding = useCallback(() => {
    if (aiConnectWizardStorageKey) {
      writeAiConnectWizardState(aiConnectWizardStorageKey, null);
    }
    setAiOnboardingOpen(false);
    setAiOnboardingMode("default");
    aiOnboardingBaselineRef.current = null;
  }, [aiConnectWizardStorageKey]);

  useEffect(() => {
    if (previousAiConnectWizardStorageKeyRef.current === aiConnectWizardStorageKey) {
      return;
    }
    previousAiConnectWizardStorageKeyRef.current = aiConnectWizardStorageKey;
    setAiOnboardingOpen(false);
    setAiOnboardingMode("default");
    aiOnboardingBaselineRef.current = null;
  }, [aiConnectWizardStorageKey]);

  const completeAiOnboarding = useCallback(() => {
    const completedMode = aiOnboardingMode;
    closeAiOnboarding();
    setAiOnboardingCompletion((previous) => ({
      id: (previous?.id ?? 0) + 1,
      mode: completedMode,
      storageKey: aiConnectWizardStorageKey,
    }));
  }, [aiConnectWizardStorageKey, aiOnboardingMode, closeAiOnboarding]);

  useEffect(() => {
    if (!aiOnboardingOpen) {
      return;
    }
    const baseline = aiOnboardingBaselineRef.current;
    if (!baseline) {
      return;
    }
    const currentDefaultId = defaultAiCredential?.id ?? null;
    if (
      activeAiCredentials.length > baseline.credentialCount ||
      currentDefaultId !== baseline.defaultCredentialId
    ) {
      completeAiOnboarding();
    }
  }, [activeAiCredentials.length, aiOnboardingOpen, completeAiOnboarding, defaultAiCredential?.id]);

  useEffect(() => {
    let latestExpiredAssistantMessage: ChatMessage | null = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate.role !== "assistant" || !shouldDisplayChatMessage(candidate)) {
        continue;
      }
      if (!isExpiredCredentialProxyError(candidate.content)) {
        continue;
      }
      latestExpiredAssistantMessage = candidate;
      break;
    }

    if (!latestExpiredAssistantMessage) {
      return;
    }
    if (lastExpiredCredentialMessageIdRef.current === latestExpiredAssistantMessage.id) {
      return;
    }
    lastExpiredCredentialMessageIdRef.current = latestExpiredAssistantMessage.id;

    const messageAgeMs = Date.now() - latestExpiredAssistantMessage.timestamp;
    if (Number.isFinite(messageAgeMs) && messageAgeMs > 10 * 60_000) {
      return;
    }

    openAiOnboarding();
  }, [messages, openAiOnboarding]);

  const stashDraftForCredentials = useCallback((options?: { autoSubmit?: boolean }) => {
    if (!activeConversationId) {
      return;
    }
    const draft = inputValue;
    const editorState = inputEditorState ?? null;
    const hasPayload = draft.trim().length > 0 || (editorState && editorState.trim().length > 0);
    if (!hasPayload) {
      return;
    }
    writePendingCredentialDraft({
      conversationId: activeConversationId,
      draft,
      editorState,
      createdAt: Date.now(),
      autoSubmit: options?.autoSubmit === true,
    });
  }, [activeConversationId, inputEditorState, inputValue]);

  const restoreDraftAfterCredentials = useCallback((): boolean => {
    if (!activeConversationId) {
      return false;
    }
    if (inputValue.trim().length > 0) {
      return false;
    }
    const pending = readPendingCredentialDraft();
    if (!pending || pending.conversationId !== activeConversationId) {
      return false;
    }
    if (Date.now() - pending.createdAt > 30 * 60 * 1000) {
      writePendingCredentialDraft(null);
      return false;
    }
    pendingCredentialAutoSubmitRef.current = pending.autoSubmit;
    onInputChange(activeConversationId, pending.draft, pending.editorState);
    writePendingCredentialDraft(null);
    focusInput();
    return true;
  }, [activeConversationId, focusInput, inputValue, onInputChange, pendingCredentialAutoSubmitRef]);

  const refreshCredentialRequirements = useCallback(async () => {
    if (!runtimeControllerEnabled) {
      setCredentialRequirements({
        requiresUserCredentials: false,
        proxyBackend: null,
        hasDefaultCredential: false,
        managedAi: null,
        error: null,
      });
      return;
    }
    const result = await withCredentialGateTimeout(
      getCredentialRequirements(),
      "AI credential requirements check",
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false as const,
        requiresUserCredentials: false,
        proxyBackend: null,
        hasDefaultCredential: false,
        managedAi: null,
        error: message,
      };
    });
    if (!result.success) {
      setCredentialRequirements({
        requiresUserCredentials: true,
        proxyBackend: null,
        hasDefaultCredential: false,
        managedAi: null,
        error: result.error ?? "Unable to check credential requirements.",
      });
      return;
    }
    setCredentialRequirements({
      requiresUserCredentials: result.requiresUserCredentials,
      proxyBackend: result.proxyBackend ?? null,
      hasDefaultCredential: result.hasDefaultCredential,
      managedAi: result.managedAi ?? null,
      error: result.error ?? null,
    });
  }, [runtimeControllerEnabled]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !hasUser) {
      return;
    }
    // Cached requirements make the first paint fast; always refresh in the
    // background so the included allowance and selected default stay live.
    void refreshCredentialRequirements();
  }, [
    hasUser,
    refreshCredentialRequirements,
    runtimeControllerEnabled,
  ]);

  const refreshCredentials = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!runtimeControllerEnabled) {
      setCredentialGateStatus({ status: "ready", error: null });
      setAvailableCredentials([]);
      return;
    }
    if (!hasUser) {
      setCredentialGateStatus({ status: "missing", error: null });
      setAvailableCredentials([]);
      return;
    }
    if (!silent) {
      setCredentialGateStatus((previous) => ({
        status: previous.status === "ready" ? "ready" : "loading",
        error: null,
      }));
    }
    const result = await withCredentialGateTimeout(
      listMyCredentials(),
      "AI credential list check",
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false as const, credentials: [], error: message };
    });
    if (!result.success) {
      setCredentialGateStatus({
        status: "error",
        error: result.error ?? "Unable to load credentials.",
      });
      return;
    }

    setAvailableCredentials(result.credentials);
    const active = result.credentials.filter(
      (credential) =>
        !credential.revokedAt &&
        (credential.kind === "codex_auth_json" || credential.kind === "openai_api_key"),
    );
    const hasDefault = active.some((credential) => credential.isDefault);

    if (hasDefault) {
      setCredentialGateStatus({ status: "ready", error: null });
      return;
    }
    if (active.length > 0) {
      setCredentialGateStatus({ status: "needs_default", error: null });
      return;
    }
    setCredentialGateStatus({ status: "missing", error: null });
  }, [hasUser, runtimeControllerEnabled]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!currentUserId) {
      setAvailableCredentials([]);
      setCredentialGateStatus({ status: "missing", error: null });
      return;
    }
    // A seeded inventory answer must not flip back to "loading" for the
    // round-trip that only confirms it; a cold gate still reports loading.
    const seededStatus = readSeededCredentialGateCache(credentialGateCacheKey, currentUserId)?.gateStatus.status;
    const seeded = seededStatus !== undefined && seededStatus !== "unknown" && seededStatus !== "loading";
    void refreshCredentials({ silent: seeded });
  }, [credentialGateCacheKey, currentUserId, refreshCredentials, runtimeControllerEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleAiConfigChanged = () => {
      deleteCredentialGateCache(credentialGateCacheKey);
      void refreshCredentialRequirements();
      void refreshCredentials({ silent: true });
      void refreshAvailableAgents({ silent: true });
    };
    window.addEventListener(AI_CONFIG_CHANGED_EVENT, handleAiConfigChanged as EventListener);
    return () => window.removeEventListener(AI_CONFIG_CHANGED_EVENT, handleAiConfigChanged as EventListener);
  }, [credentialGateCacheKey, refreshAvailableAgents, refreshCredentialRequirements, refreshCredentials]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !inputRequiresAi || credentialsReady) {
      return;
    }
    const now = Date.now();
    if (now - lastCredentialCheckRef.current < 4_000) {
      return;
    }
    lastCredentialCheckRef.current = now;
    void refreshCredentials();
  }, [credentialsReady, inputRequiresAi, refreshCredentials, runtimeControllerEnabled]);

  useEffect(() => {
    const previousReady = credentialReadyRef.current;
    credentialReadyRef.current = credentialsReady;
    if (previousReady || !credentialsReady) {
      return;
    }
    if (aiConnectWizardStorageKey) {
      writeAiConnectWizardState(aiConnectWizardStorageKey, null);
    }
    restoreDraftAfterCredentials();
  }, [aiConnectWizardStorageKey, credentialsReady, restoreDraftAfterCredentials]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !inputRequiresAi || credentialsReady) {
      return;
    }
    const intervalId = window.setInterval(() => void refreshCredentials({ silent: true }), 9_000);
    return () => window.clearInterval(intervalId);
  }, [credentialsReady, inputRequiresAi, refreshCredentials, runtimeControllerEnabled]);

  const connectFromDesktop = useCallback(async () => {
    stashDraftForCredentials({ autoSubmit: true });
    if (!canUseDesktopConnect) {
      showStatus("Desktop connect is only available in the Instafy desktop app.", "info", 4500);
      return;
    }
    if (credentialsBusy) {
      return;
    }
    setCredentialsBusy(true);
    try {
      const result = await connectDesktopCodexAuthJson({
        label: "Codex on this computer",
      });
      if (!result.success) {
        throw new Error(result.error ?? "Unable to save credentials.");
      }
      await refreshCredentials();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message, "error", 5000);
    } finally {
      setCredentialsBusy(false);
    }
  }, [canUseDesktopConnect, credentialsBusy, refreshCredentials, showStatus, stashDraftForCredentials]);

  const uploadAuthJsonFile = useCallback(async (file: File) => {
    stashDraftForCredentials({ autoSubmit: true });
    if (credentialsBusy) {
      return;
    }
    setCredentialsBusy(true);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as unknown;
      const result = await createCodexCredential({
        authJson: parsed,
        label: "auth.json",
      });
      if (!result.success) {
        throw new Error(result.error ?? "Unable to save credentials.");
      }
      await refreshCredentials();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Upload failed: ${message}`, "error", 5000);
    } finally {
      setCredentialsBusy(false);
    }
  }, [credentialsBusy, refreshCredentials, showStatus, stashDraftForCredentials]);

  const saveApiKey = useCallback(async (apiKey: string, provider: "openai" | "deepseek" | "zai" | "gemini") => {
    stashDraftForCredentials({ autoSubmit: true });
    if (credentialsBusy) {
      return { success: false, error: "Credentials are busy." };
    }
    setCredentialsBusy(true);
    try {
      const label =
        provider === "openai"
          ? "API key"
          : provider === "deepseek"
            ? "DeepSeek"
            : provider === "zai"
              ? "z.ai"
              : "Gemini";
      const result = await createCodexCredential({
        authJson: {
          OPENAI_API_KEY: apiKey,
        },
        label,
        provider,
      });
      if (!result.success) {
        return { success: false, error: result.error ?? "Unable to save credentials." };
      }
      await refreshCredentials();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    } finally {
      setCredentialsBusy(false);
    }
  }, [credentialsBusy, refreshCredentials, stashDraftForCredentials]);

  const handleSetDefaultCredentialFromChat = useCallback(async (credentialId: string) => {
    if (!credentialId || credentialsBusy) {
      return;
    }
    setCredentialsBusy(true);
    try {
      const result = await setDefaultCredential(credentialId);
      if (!result.success) {
        showStatus(result.error ?? "Unable to set default credential.", "error", 4500);
        return;
      }
      showStatus("Default credential updated.", "success", 2500);
      await refreshCredentials();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to set default credential: ${message}`, "error", 4500);
    } finally {
      setCredentialsBusy(false);
    }
  }, [credentialsBusy, refreshCredentials, showStatus]);

  const credentialGateResolution = useMemo(
    () =>
      resolveAiCredentialGateState({
        runtimeControllerEnabled,
        inputRequiresAi,
        credentialsReady,
        currentUserId,
        credentialRequirements: {
          requiresUserCredentials: credentialRequirements.requiresUserCredentials,
          error: credentialRequirements.error,
        },
        credentialGateStatus: {
          status: credentialGateStatus.status,
          error: credentialGateStatus.error,
        },
      }),
    [
      credentialGateStatus.error,
      credentialGateStatus.status,
      credentialRequirements.error,
      credentialRequirements.requiresUserCredentials,
      credentialsReady,
      currentUserId,
      inputRequiresAi,
      runtimeControllerEnabled,
    ],
  );
  const credentialGateState: AiCredentialsGateState | null = credentialGateResolution.state;

  useEffect(() => {
    if (credentialGateState !== "checking") {
      setCredentialGateCheckingVisible(false);
      return;
    }
    const visibleTimeoutId = window.setTimeout(() => setCredentialGateCheckingVisible(true), 300);
    const recheckTimeoutId = window.setTimeout(() => {
      void refreshCredentialRequirements();
      void refreshCredentials({ silent: true });
    }, CREDENTIAL_GATE_CHECKING_RECHECK_MS);
    const failTimeoutId = window.setTimeout(() => {
      setCredentialGateStatus((previous) =>
        previous.status === "ready"
          ? previous
          : {
              status: "error",
              error: "AI connection check timed out. Retry after the local stack is ready.",
            },
      );
    }, CREDENTIAL_GATE_CHECKING_TIMEOUT_MS);
    return () => {
      window.clearTimeout(visibleTimeoutId);
      window.clearTimeout(recheckTimeoutId);
      window.clearTimeout(failTimeoutId);
    };
  }, [credentialGateState, refreshCredentialRequirements, refreshCredentials]);

  const refreshCredentialGate = useCallback(() => {
    deleteCredentialGateCache(credentialGateCacheKey);
    lastCredentialCheckRef.current = 0;
    setCredentialRequirements(createDefaultCredentialRequirementState(runtimeControllerEnabled));
    setCredentialGateStatus(createDefaultCredentialGateStatusState(runtimeControllerEnabled));
    void refreshCredentialRequirements();
    void refreshCredentials();
  }, [credentialGateCacheKey, refreshCredentialRequirements, refreshCredentials, runtimeControllerEnabled]);

  const credentialGateStateForBubble =
    credentialGateState === "checking" && !credentialGateCheckingVisible ? null : credentialGateState;
  const credentialGateDetail = useMemo(
    () => credentialGateResolution.detail,
    [credentialGateResolution.detail],
  );

  const canRestoreStoredAiOnboarding = useMemo(
    () =>
      canRestorePersistedAiOnboarding({
        runtimeControllerEnabled,
        hasUser,
        requirementsResolved: credentialRequirements.requiresUserCredentials !== null,
        requirementsHasDefaultCredential: credentialRequirements.hasDefaultCredential,
        hydratedDefaultCredentialId: defaultAiCredential?.id ?? null,
      }),
    [
      credentialRequirements.hasDefaultCredential,
      credentialRequirements.requiresUserCredentials,
      defaultAiCredential?.id,
      hasUser,
      runtimeControllerEnabled,
    ],
  );

  useEffect(() => {
    if (!aiConnectWizardStorageKey || aiOnboardingOpen || credentialGateState) {
      return;
    }
    if (!canRestoreStoredAiOnboarding) {
      return;
    }
    const stored = readAiConnectWizardState(aiConnectWizardStorageKey);
    if (!stored?.open) {
      return;
    }
    openAiOnboarding({ mode: stored.mode });
  }, [
    aiConnectWizardStorageKey,
    aiOnboardingOpen,
    canRestoreStoredAiOnboarding,
    credentialGateState,
    openAiOnboarding,
  ]);

  return {
    activeAiCredentials,
    aiOnboardingCompletion,
    aiOnboardingMode,
    aiOnboardingOpen,
    availableCredentials,
    closeAiOnboarding,
    connectFromDesktop,
    credentialGateDetail,
    credentialInventoryStatus: credentialGateStatus.status,
    credentialGateState,
    credentialGateStateForBubble,
    credentialRequirements,
    credentialsBusy,
    credentialsReady,
    defaultAiCredential,
    handleSetDefaultCredentialFromChat,
    openAiOnboarding,
    refreshCredentialGate,
    refreshCredentials,
    saveApiKey,
    stashDraftForCredentials,
    uploadAuthJsonFile,
  };
}
