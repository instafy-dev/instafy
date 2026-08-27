import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  controllerBaseUrl,
  controllerClient,
  runtimeControllerEnabled,
} from "../../../sdk/instafy";
import {
  type CredentialsConnectApiKeyProvider,
  type CredentialsConnectModalProps,
  type CredentialsConnectModalStep,
} from "./CredentialsConnectModal";
import {
  canUseDesktopCodexAuthJson,
  connectDesktopCodexAuthJson,
  useDesktopCodexAuthJsonStatus,
} from "./desktopCodexAuthJson";
import {
  canUseDevServerCodexAuthJson,
  connectDevServerCodexAuthJson,
} from "./devServerCodexAuthJson";
import {
  CHATGPT_CONNECTION_DEFAULT_WARNING,
  CHATGPT_CONNECTION_RESOLUTION_WARNING,
  CHATGPT_CONNECTION_VERIFICATION_WARNING,
} from "./device-auth/deviceAuthCompletion";
import { useDeviceAuthFlow } from "./device-auth/useDeviceAuthFlow";

const {
  createCodex: createCodexCredential,
  revoke: revokeMyCredential,
  setDefault: setDefaultCredential,
  test: testMyCredential,
} = controllerClient.credentials;

async function readJsonFile(file: File): Promise<unknown> {
  const contents = await file.text();
  return JSON.parse(contents) as unknown;
}

type UseCredentialsConnectFlowOptions = {
  userPresent: boolean;
  loadCredentials: (options?: { silent?: boolean }) => Promise<void>;
  notifyAiConfigChanged: (reason: string) => void;
  showStatus: (
    message: string,
    intent: "error" | "success" | "warning",
    durationMs?: number,
  ) => void;
  formatCredentialTestFailureMessage: (raw: string | null | undefined) => string | null;
};

type UseCredentialsConnectFlowResult = {
  canManageAiConnections: boolean;
  openConnectModal: () => void;
  openConnectModalAtStep: (step: CredentialsConnectModalStep) => void;
  connectModalProps: CredentialsConnectModalProps;
};

export function useCredentialsConnectFlow({
  userPresent,
  loadCredentials,
  notifyAiConfigChanged,
  showStatus,
  formatCredentialTestFailureMessage,
}: UseCredentialsConnectFlowOptions): UseCredentialsConnectFlowResult {
  const [connectPending, setConnectPending] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [connectModalStep, setConnectModalStep] = useState<CredentialsConnectModalStep>("picker");
  const [apiKeyPendingProvider, setApiKeyPendingProvider] = useState<CredentialsConnectApiKeyProvider | null>(null);
  const [openaiApiKeyDraft, setOpenaiApiKeyDraft] = useState("");
  const [openaiLabelDraft, setOpenaiLabelDraft] = useState("");
  const [deepseekApiKeyDraft, setDeepseekApiKeyDraft] = useState("");
  const [deepseekLabelDraft, setDeepseekLabelDraft] = useState("");
  const [zaiApiKeyDraft, setZaiApiKeyDraft] = useState("");
  const [zaiLabelDraft, setZaiLabelDraft] = useState("");
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState("");
  const [geminiLabelDraft, setGeminiLabelDraft] = useState("");
  const handleDeviceAuthCompleted = useCallback(
    async ({
      credentialId,
    }: {
      credentialId?: string | null;
    }): Promise<{ success: true; warning?: string }> => {
      if (!credentialId) {
        return {
          success: true,
          warning: CHATGPT_CONNECTION_RESOLUTION_WARNING,
        };
      }

      const testResult = await testMyCredential(credentialId).catch(() => null);
      if (!testResult?.success || !testResult.ok) {
        return {
          success: true,
          warning: CHATGPT_CONNECTION_VERIFICATION_WARNING,
        };
      }

      const defaultResult = await setDefaultCredential(credentialId).catch(() => null);
      if (!defaultResult?.success) {
        return {
          success: true,
          warning: CHATGPT_CONNECTION_DEFAULT_WARNING,
        };
      }

      return { success: true };
    },
    [],
  );
  const deviceAuth = useDeviceAuthFlow({ onCompleted: handleDeviceAuthCompleted });
  const completedDeviceAuthSessionRef = useRef<string | null>(null);

  const deviceAuthSession = deviceAuth.session;
  const deviceAuthProvider = deviceAuth.provider;
  const deviceAuthError = deviceAuth.error;
  const deviceAuthBusy = deviceAuth.busy;
  const deviceAuthCompleting = deviceAuth.completing;
  const deviceAuthCompletionWarning = deviceAuth.completionWarning;
  const beginDeviceAuthFlow = deviceAuth.begin;
  const cancelDeviceAuthFlow = deviceAuth.cancel;
  const resetDeviceAuthFlow = deviceAuth.reset;
  const connectInteractionBusy =
    connectPending || deviceAuthBusy || deviceAuthCompleting || apiKeyPendingProvider !== null;

  const canUseDesktopConnect = canUseDesktopCodexAuthJson();
  const desktopCodexAuthJsonStatus = useDesktopCodexAuthJsonStatus(canUseDesktopConnect);
  const canManageAiConnections = runtimeControllerEnabled && Boolean(controllerBaseUrl) && userPresent;

  const resetConnectDrafts = useCallback(() => {
    setLabelDraft("");
    setOpenaiApiKeyDraft("");
    setOpenaiLabelDraft("");
    setDeepseekApiKeyDraft("");
    setDeepseekLabelDraft("");
    setZaiApiKeyDraft("");
    setZaiLabelDraft("");
    setGeminiApiKeyDraft("");
    setGeminiLabelDraft("");
  }, []);

  const closeConnectModal = useCallback(() => {
    if (connectInteractionBusy) {
      return;
    }
    setConnectModalOpen(false);
    setConnectModalStep("picker");
    setShowAdvanced(false);
    resetConnectDrafts();
    if (deviceAuthSession?.status === "pending") {
      void cancelDeviceAuthFlow();
    } else {
      resetDeviceAuthFlow();
    }
    completedDeviceAuthSessionRef.current = null;
  }, [
    cancelDeviceAuthFlow,
    connectInteractionBusy,
    deviceAuthSession,
    resetConnectDrafts,
    resetDeviceAuthFlow,
  ]);

  const openConnectModal = useCallback(() => {
    setConnectModalOpen(true);
    setConnectModalStep("picker");
    setShowAdvanced(false);
    resetDeviceAuthFlow();
    completedDeviceAuthSessionRef.current = null;
  }, [resetDeviceAuthFlow]);

  const openConnectModalAtStep = useCallback(
    (step: CredentialsConnectModalStep) => {
      setConnectModalOpen(true);
      setConnectModalStep(step);
      setShowAdvanced(false);
      resetDeviceAuthFlow();
      completedDeviceAuthSessionRef.current = null;
    },
    [resetDeviceAuthFlow],
  );

  const handleConnectModalBack = useCallback(() => {
    if (connectInteractionBusy) {
      return;
    }
    setConnectModalStep("picker");
    setShowAdvanced(false);
    if (deviceAuthSession?.status === "pending") {
      void cancelDeviceAuthFlow();
    } else {
      resetDeviceAuthFlow();
    }
    completedDeviceAuthSessionRef.current = null;
  }, [cancelDeviceAuthFlow, connectInteractionBusy, deviceAuthSession, resetDeviceAuthFlow]);

  const beginDeviceAuth = useCallback(
    async (provider: "codex") => {
      if (!runtimeControllerEnabled || !controllerBaseUrl) {
        showStatus("BYOC needs a configured controller (VITE_CONTROLLER_URL).", "error", 4500);
        return;
      }
      if (!userPresent) {
        showStatus("Sign in to connect credentials.", "error", 3500);
        return;
      }
      if (connectPending) {
        return;
      }

      setConnectPending(true);
      resetDeviceAuthFlow();
      completedDeviceAuthSessionRef.current = null;

      try {
        await beginDeviceAuthFlow({
          provider,
        });
      } finally {
        setConnectPending(false);
      }
    },
    [beginDeviceAuthFlow, connectPending, resetDeviceAuthFlow, showStatus, userPresent],
  );

  const cancelDeviceAuthSession = useCallback(async () => {
    if (connectInteractionBusy) {
      return;
    }
    if (!deviceAuthSession) {
      resetDeviceAuthFlow();
      return;
    }
    if (deviceAuthSession.status === "pending") {
      await cancelDeviceAuthFlow();
    } else {
      resetDeviceAuthFlow();
    }
  }, [cancelDeviceAuthFlow, connectInteractionBusy, deviceAuthSession, resetDeviceAuthFlow]);

  useEffect(() => {
    if (!deviceAuthSession) {
      return;
    }
    if (deviceAuthSession.status !== "completed") {
      return;
    }
    if (completedDeviceAuthSessionRef.current === deviceAuthSession.sessionId) {
      return;
    }
    completedDeviceAuthSessionRef.current = deviceAuthSession.sessionId;

    void (async () => {
      await loadCredentials({ silent: true });
      notifyAiConfigChanged(deviceAuthProvider === "gemini" ? "gemini_oauth_connected" : "codex_oauth_connected");
      if (deviceAuthCompletionWarning) {
        showStatus(deviceAuthCompletionWarning, "warning", 6500);
      } else {
        showStatus(
          deviceAuthProvider === "gemini" ? "Gemini credentials connected." : "ChatGPT credentials connected.",
          "success",
          3500,
        );
      }
      closeConnectModal();
    })();
  }, [
    closeConnectModal,
    deviceAuthCompletionWarning,
    deviceAuthProvider,
    deviceAuthSession,
    loadCredentials,
    notifyAiConfigChanged,
    showStatus,
  ]);

  const handleConnectCodex = useCallback(async () => {
    if (!runtimeControllerEnabled || !controllerBaseUrl) {
      showStatus("BYOC needs a configured controller (VITE_CONTROLLER_URL).", "error", 4500);
      return;
    }
    if (!userPresent) {
      showStatus("Sign in to connect credentials.", "error", 3500);
      return;
    }
    if (connectPending) {
      return;
    }

    if (canUseDesktopConnect) {
      setConnectPending(true);
      try {
        const result = await connectDesktopCodexAuthJson({
          label: labelDraft.trim() ? labelDraft.trim() : "Codex on this computer",
        });
        if (!result.success) {
          showStatus(result.error ?? "Unable to save credentials.", "error", 5000);
          return;
        }
        showStatus("Codex credentials connected.", "success", 3500);
        setLabelDraft("");
        await loadCredentials({ silent: true });
        notifyAiConfigChanged("codex_connected");
        closeConnectModal();
      } catch {
        showStatus("Unable to connect the local Codex login.", "error", 5000);
      } finally {
        setConnectPending(false);
      }
      return;
    }

    void beginDeviceAuth("codex");
  }, [
    beginDeviceAuth,
    canUseDesktopConnect,
    closeConnectModal,
    connectPending,
    labelDraft,
    loadCredentials,
    notifyAiConfigChanged,
    showStatus,
    userPresent,
  ]);

  // Dev-only: seed this machine's Codex login through the same completion
  // contract as every other connect path (loadCredentials + close, folded into
  // connectPending so the modal locks while it runs).
  const canDevSeedCodex = canUseDevServerCodexAuthJson();
  const handleDevSeedCodex = useCallback(async () => {
    if (!userPresent) {
      showStatus("Sign in to connect credentials.", "error", 3500);
      return;
    }
    if (connectPending) {
      return;
    }
    setConnectPending(true);
    try {
      const result = await connectDevServerCodexAuthJson();
      if (!result.success) {
        showStatus(result.error ?? "Unable to save credentials.", "error", 5000);
        return;
      }
      showStatus("Connected this machine's Codex login.", "success", 3500);
      await loadCredentials({ silent: true });
      notifyAiConfigChanged("codex_connected");
      closeConnectModal();
    } catch {
      showStatus("Unable to connect the local Codex login.", "error", 5000);
    } finally {
      setConnectPending(false);
    }
  }, [
    closeConnectModal,
    connectPending,
    loadCredentials,
    notifyAiConfigChanged,
    showStatus,
    userPresent,
  ]);

  const handleTriggerUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleUploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }
      if (!runtimeControllerEnabled || !controllerBaseUrl) {
        showStatus("BYOC needs a configured controller (VITE_CONTROLLER_URL).", "error", 4500);
        return;
      }
      if (!userPresent) {
        showStatus("Sign in to connect credentials.", "error", 3500);
        return;
      }

      setConnectPending(true);
      try {
        const authJson = await readJsonFile(file);
        const result = await createCodexCredential({
          authJson,
          label: labelDraft.trim() ? labelDraft.trim() : "Browser upload",
        });
        if (!result.success) {
          showStatus(result.error ?? "Unable to save credentials.", "error", 5000);
          return;
        }
        showStatus("Codex credentials connected.", "success", 3500);
        setLabelDraft("");
        await loadCredentials({ silent: true });
        notifyAiConfigChanged("codex_connected");
        closeConnectModal();
      } catch {
        showStatus("Unable to read auth.json from this computer.", "error", 5000);
      } finally {
        setConnectPending(false);
      }
    },
    [closeConnectModal, labelDraft, loadCredentials, notifyAiConfigChanged, showStatus, userPresent],
  );

  const handleConnectApiKey = useCallback(
    async (provider: CredentialsConnectApiKeyProvider): Promise<boolean> => {
      if (!runtimeControllerEnabled || !controllerBaseUrl) {
        showStatus("BYOC needs a configured controller (VITE_CONTROLLER_URL).", "error", 4500);
        return false;
      }
      if (!userPresent) {
        showStatus("Sign in to connect credentials.", "error", 3500);
        return false;
      }
      if (apiKeyPendingProvider) {
        return false;
      }

      const rawKey =
        provider === "openai"
          ? openaiApiKeyDraft
          : provider === "deepseek"
            ? deepseekApiKeyDraft
            : provider === "zai"
              ? zaiApiKeyDraft
              : geminiApiKeyDraft;
      const apiKey = rawKey.trim();
      if (!apiKey) {
        showStatus("Paste your API key first.", "error", 3500);
        return false;
      }

      const draftLabel =
        provider === "openai"
          ? openaiLabelDraft
          : provider === "deepseek"
            ? deepseekLabelDraft
            : provider === "zai"
              ? zaiLabelDraft
              : geminiLabelDraft;
      const label = draftLabel.trim()
        ? draftLabel.trim()
        : provider === "openai"
          ? "OpenAI"
          : provider === "deepseek"
            ? "DeepSeek"
            : provider === "zai"
              ? "z.ai"
              : "Gemini";

      setApiKeyPendingProvider(provider);
      let createdCredentialId: string | null = null;
      try {
        const result = await createCodexCredential({
          authJson: { OPENAI_API_KEY: apiKey },
          label,
          provider,
        });
        if (!result.success || !result.credentialId) {
          showStatus(result.error ?? "Unable to save credentials.", "error", 5000);
          return false;
        }
        createdCredentialId = result.credentialId;
        const testResult = await testMyCredential(result.credentialId);
        if (!testResult.success) {
          const revokeResult = await revokeMyCredential(result.credentialId);
          createdCredentialId = null;
          const cleanupDetail = revokeResult.success
            ? ""
            : " The unverified connection could not be removed; remove it from AI Connections before retrying.";
          showStatus(
            `${formatCredentialTestFailureMessage(testResult.error) ?? "Unable to test credential."}${cleanupDetail}`,
            "error",
            6500,
          );
          return false;
        }
        if (!testResult.ok) {
          const detail = formatCredentialTestFailureMessage(testResult.output);
          const revokeResult = await revokeMyCredential(result.credentialId);
          createdCredentialId = null;
          const cleanupDetail = revokeResult.success
            ? ""
            : " The unverified connection could not be removed; remove it from AI Connections before retrying.";
          showStatus(
            `${detail ? `Credential verification failed: ${detail}` : "Credential verification failed. Check the key and retry."}${cleanupDetail}`,
            "error",
            7000,
          );
          return false;
        }

        createdCredentialId = null;
        if (provider === "openai") {
          setOpenaiApiKeyDraft("");
          setOpenaiLabelDraft("");
        } else if (provider === "deepseek") {
          setDeepseekApiKeyDraft("");
          setDeepseekLabelDraft("");
        } else if (provider === "zai") {
          setZaiApiKeyDraft("");
          setZaiLabelDraft("");
        } else {
          setGeminiApiKeyDraft("");
          setGeminiLabelDraft("");
        }

        showStatus("Credential verified.", "success", 3500);
        await loadCredentials({ silent: true });
        notifyAiConfigChanged(`${provider}_api_key_connected`);
        return true;
      } catch (error) {
        if (createdCredentialId) {
          await revokeMyCredential(createdCredentialId).catch(() => undefined);
        }
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to connect credential: ${message}`, "error", 5000);
        return false;
      } finally {
        setApiKeyPendingProvider(null);
      }
    },
    [
      apiKeyPendingProvider,
      deepseekApiKeyDraft,
      deepseekLabelDraft,
      formatCredentialTestFailureMessage,
      geminiApiKeyDraft,
      geminiLabelDraft,
      loadCredentials,
      notifyAiConfigChanged,
      openaiApiKeyDraft,
      openaiLabelDraft,
      showStatus,
      userPresent,
      zaiApiKeyDraft,
      zaiLabelDraft,
    ],
  );

  return {
    canManageAiConnections,
    openConnectModal,
    openConnectModalAtStep,
    connectModalProps: {
      canManageAiConnections,
      canUseDesktopConnect,
      desktopCodexAuthJsonStatus,
      connectModalOpen,
      connectModalStep,
      connectPending,
      apiKeyPendingProvider,
      showAdvanced,
      labelDraft,
      openaiApiKeyDraft,
      openaiLabelDraft,
      deepseekApiKeyDraft,
      deepseekLabelDraft,
      zaiApiKeyDraft,
      zaiLabelDraft,
      geminiApiKeyDraft,
      deviceAuthError,
      deviceAuthBusy,
      deviceAuthCompleting,
      deviceAuthProvider,
      deviceAuthSession,
      fileInputRef,
      onClose: closeConnectModal,
      onBack: handleConnectModalBack,
      onStepChange: setConnectModalStep,
      onShowAdvancedChange: setShowAdvanced,
      onLabelDraftChange: setLabelDraft,
      onOpenaiApiKeyDraftChange: setOpenaiApiKeyDraft,
      onOpenaiLabelDraftChange: setOpenaiLabelDraft,
      onDeepseekApiKeyDraftChange: setDeepseekApiKeyDraft,
      onDeepseekLabelDraftChange: setDeepseekLabelDraft,
      onZaiApiKeyDraftChange: setZaiApiKeyDraft,
      onZaiLabelDraftChange: setZaiLabelDraft,
      onGeminiApiKeyDraftChange: setGeminiApiKeyDraft,
      onConnectCodex: handleConnectCodex,
      canDevSeedCodex,
      onDevSeedCodex: () => void handleDevSeedCodex(),
      onBeginDeviceAuth: (provider) => void beginDeviceAuth(provider),
      onCancelDeviceAuthSession: () => void cancelDeviceAuthSession(),
      onTriggerUpload: handleTriggerUpload,
      onUploadFile: (event) => void handleUploadFile(event),
      onConnectApiKey: handleConnectApiKey,
    },
  };
}
