import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { NavArrowLeft, Upload, WarningTriangle, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { DeepSeekIcon, GeminiIcon, OpenAIIcon, ZaiIcon } from "../../../components/ProviderIcons";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import {
  controllerClient,
  type ControllerCredentialListItem,
} from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { formatCredentialOptionLabel, resolveCredentialLabel } from "../../../utils/credentialFormatting";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import {
  defaultAiConnectWizardState,
  readAiConnectWizardState,
  writeAiConnectWizardState,
  type AiConnectWizardProvider,
  type AiConnectWizardStep,
} from "./aiConnectWizardStorage";
import {
  AccessDecisionCard,
  AccessProviderChoiceButton,
  AccessSectionLabel,
} from "./AccessDecisionCard";
import { ChatGptDeviceCodePrerequisite } from "./ChatGptDeviceCodePrerequisite";
import { ChatActivityBubble } from "./ChatActivityBubble";
import {
  isLikelyDesktopDevice,
  shouldPromptForCodexAuthJsonUpload,
  useDesktopCodexAuthJsonStatus,
} from "./desktopCodexAuthJson";
import {
  CHATGPT_CONNECTION_DEFAULT_WARNING,
  CHATGPT_CONNECTION_RESOLUTION_WARNING,
  CHATGPT_CONNECTION_VERIFICATION_WARNING,
} from "./device-auth/deviceAuthCompletion";
import { useDeviceAuthFlow } from "./device-auth/useDeviceAuthFlow";

const {
  list: listMyCredentials,
  setDefault: setDefaultCredential,
  test: testMyCredential,
} = controllerClient.credentials;

export type AiCredentialsGateState =
  | "checking"
  | "missing"
  | "needs_default"
  | "error"
  | "unavailable";

type AiCredentialsWizardIntent = "gate" | "connect";

interface AiCredentialsStatusBubbleProps {
  state: AiCredentialsGateState;
  detail?: string | null;
  isBusy: boolean;
  canUseDesktopConnect: boolean;
  onStashDraft: () => void;
  onConnectDesktop: () => void;
  onUploadAuthJson: (file: File) => void;
  onSaveApiKey: (
    apiKey: string,
    provider: AiConnectWizardProvider,
  ) => Promise<{ success: boolean; error?: string }>;
  onRetry?: () => void;
  intent?: AiCredentialsWizardIntent;
  storageKey?: string | null;
  connectedCredentials?: ControllerCredentialListItem[];
  defaultCredentialId?: string | null;
  managedAi?: {
    enabled: boolean;
    available: boolean;
    label: string;
    creditBurnAmount: number;
    dailyPromptLimit: number;
    dailyPromptsUsed: number;
    remainingPrompts: number | null;
  } | null;
  onSetDefaultCredential?: (credentialId: string) => void;
  onUseManagedAi?: () => void | Promise<void>;
  onChatWithoutAi?: () => void;
  onClose?: () => void;
}

type AiProviderChoice = "openai" | "deepseek" | "zai" | "gemini";

function AiProviderIconFrame({
  children,
  className,
  featured = false,
}: {
  children: ReactNode;
  className?: string;
  featured?: boolean;
}) {
  return (
    <span
      className={[
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 ring-black/5 dark:ring-white/10",
        featured ? "bg-white/90 dark:bg-white" : "bg-white/90 dark:bg-slate-950/40",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

export function AiCredentialsStatusBubble({
  state,
  detail,
  isBusy,
  canUseDesktopConnect,
  onStashDraft,
  onConnectDesktop,
  onUploadAuthJson,
  onSaveApiKey,
  onRetry,
  intent = "gate",
  storageKey = null,
  connectedCredentials = [],
  defaultCredentialId = null,
  managedAi = null,
  onSetDefaultCredential,
  onUseManagedAi,
  onChatWithoutAi,
  onClose,
}: AiCredentialsStatusBubbleProps) {
  const { showStatus } = useStatus();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [connectStep, setConnectStep] = useState<AiConnectWizardStep>("provider");
  const [selectedProvider, setSelectedProvider] = useState<AiConnectWizardProvider | null>(null);
  const [showDeviceAuthPrerequisite, setShowDeviceAuthPrerequisite] = useState(false);
  const connectWizardHydratedRef = useRef(false);
  const desktopCodexAuthJsonStatus = useDesktopCodexAuthJsonStatus(canUseDesktopConnect);
  const shouldPromptForAuthJsonUpload = shouldPromptForCodexAuthJsonUpload(
    desktopCodexAuthJsonStatus,
  );
  const effectiveState: AiCredentialsGateState =
    state === "needs_default" && connectedCredentials.length === 0 ? "missing" : state;
  const showUnavailableState = effectiveState === "unavailable";
  const showConnectWizard =
    !showUnavailableState && (effectiveState === "missing" || intent === "connect");
  const canGoBack = showConnectWizard && connectStep !== "provider";
  const allowAuthJsonUpload = useMemo(() => isLikelyDesktopDevice(), []);

  const finalizeDeviceAuth = useCallback(
    async ({
      provider,
      credentialId,
    }: {
      provider: "codex" | "gemini" | "github";
      sessionId: string;
      credentialId?: string | null;
    }) => {
      // Only the AI credential wizard uses device auth for Codex/Gemini.
      if (provider === "github") {
        onRetry?.();
        return { success: true as const };
      }

      const finishWithWarning = (warning: string) => {
        showStatus(warning, "warning", 6500);
        onRetry?.();
        return { success: true as const, warning };
      };

      let resolvedCredentialId = typeof credentialId === "string" ? credentialId.trim() : "";
      if (!resolvedCredentialId) {
        const credentialsResult = await listMyCredentials().catch(() => null);
        if (!credentialsResult || !credentialsResult.success) {
          return finishWithWarning(CHATGPT_CONNECTION_RESOLUTION_WARNING);
        }
        const activeDefault = credentialsResult.credentials.find(
          (credential) =>
            !credential.revokedAt &&
            credential.isDefault &&
            (credential.kind === "codex_auth_json" || credential.kind === "openai_api_key"),
        );
        resolvedCredentialId = activeDefault?.id?.trim() ?? "";
      }

      if (!resolvedCredentialId) {
        return finishWithWarning(CHATGPT_CONNECTION_RESOLUTION_WARNING);
      }

      const testResult = await testMyCredential(resolvedCredentialId).catch(() => null);
      if (!testResult || !testResult.success || testResult.ok === false) {
        return finishWithWarning(CHATGPT_CONNECTION_VERIFICATION_WARNING);
      }

      const setDefaultResult = await setDefaultCredential(resolvedCredentialId).catch(() => null);
      if (!setDefaultResult || !setDefaultResult.success) {
        return finishWithWarning(CHATGPT_CONNECTION_DEFAULT_WARNING);
      }

      onRetry?.();
      return { success: true as const };
    },
    [onRetry, showStatus],
  );

  const deviceAuth = useDeviceAuthFlow({
    onCompleted: finalizeDeviceAuth,
  });

  const deviceAuthSession = deviceAuth.session;
  const deviceAuthError = deviceAuth.error;
  const deviceAuthBusy = deviceAuth.busy;
  const deviceAuthCompleting = deviceAuth.completing;
  const deviceAuthCompletionWarning = deviceAuth.completionWarning;
  const beginDeviceAuthFlow = deviceAuth.begin;
  const cancelDeviceAuthFlow = deviceAuth.cancel;
  const resetDeviceAuthFlow = deviceAuth.reset;
  const hydrateDeviceAuthFlow = deviceAuth.hydrate;
  const wizardBusy = isBusy || deviceAuthBusy || deviceAuthCompleting;

  const title = useMemo(() => {
    if (intent === "connect") {
      if (effectiveState === "needs_default" && connectedCredentials.length > 0) {
        return "Choose which AI connection to use.";
      }
      if (managedAi?.available && connectedCredentials.length === 0) {
        return `Start with ${managedAi.label} or connect your own.`;
      }
      if (connectedCredentials.length > 0) {
        return "Add another AI connection?";
      }
      return "Let’s connect AI.";
    }
    switch (effectiveState) {
      case "checking":
        return "Checking AI connection…";
      case "needs_default":
        return "Pick which credential I should use.";
      case "unavailable":
        return "I can't verify the AI connection right now.";
      case "error":
        return "I couldn't load your AI setup.";
      default:
        return "Connect AI to start.";
    }
  }, [connectedCredentials.length, effectiveState, intent, managedAi?.available, managedAi?.label]);

  const resolvedDetail = useMemo(() => {
    if (deviceAuthError) {
      return deviceAuthError;
    }
    if (detail !== undefined) {
      return detail;
    }
    switch (effectiveState) {
      case "checking":
        return null;
      case "needs_default":
        return connectedCredentials.length > 0
          ? "Choose one below — you can change it anytime."
          : "Open AI Manager and set one as default.";
      case "unavailable":
        return "Retry in a moment. Your AI credentials may still be fine.";
      case "error":
        return "Try again, or manage AI connections in AI Manager.";
      default:
        if (intent === "connect" && managedAi?.available && connectedCredentials.length === 0) {
          const burnLabel =
            managedAi.creditBurnAmount === 1
              ? "Each prompt burns 1 credit."
              : `Each prompt burns ${managedAi.creditBurnAmount} credits.`;
          const quotaLabel =
            typeof managedAi.remainingPrompts === "number"
              ? ` ${managedAi.remainingPrompts} managed prompts left today.`
              : "";
          return `${burnLabel}${quotaLabel} Connect your own provider when you want longer runs, provider-specific control, or deeper work.`;
        }
        return "Pick a provider, then follow the steps. Browser login is the easiest path, and the connection is saved to your Instafy profile.";
    }
  }, [
    connectedCredentials.length,
    detail,
    deviceAuthError,
    effectiveState,
    intent,
    managedAi?.available,
    managedAi?.creditBurnAmount,
    managedAi?.remainingPrompts,
  ]);

  const beginDeviceAuth = useCallback(async () => {
    if (isBusy || deviceAuthBusy) {
      return;
    }
    onStashDraft();
    setApiKeyDraft("");
    setApiKeyError(null);
    setSelectedProvider("openai");
    setConnectStep("openai-login");
    resetDeviceAuthFlow();
    await beginDeviceAuthFlow({ provider: "codex" });
  }, [beginDeviceAuthFlow, deviceAuthBusy, isBusy, onStashDraft, resetDeviceAuthFlow]);

  const cancelDeviceAuthSession = useCallback(async () => {
    if (wizardBusy) {
      return;
    }
    if (deviceAuthSession?.status === "pending") {
      await cancelDeviceAuthFlow();
      return;
    }
    resetDeviceAuthFlow();
  }, [cancelDeviceAuthFlow, deviceAuthSession?.status, resetDeviceAuthFlow, wizardBusy]);

  const resetConnectState = useCallback(() => {
    setSelectedProvider(null);
    setConnectStep("provider");
    setApiKeyDraft("");
    setApiKeyError(null);
    setShowDeviceAuthPrerequisite(false);
    resetDeviceAuthFlow();
  }, [resetDeviceAuthFlow]);

  const handleBack = useCallback(() => {
    if (wizardBusy) {
      return;
    }
    if (!showConnectWizard) {
      return;
    }
    if (connectStep === "provider") {
      return;
    }
    if (connectStep === "openai-login" && showDeviceAuthPrerequisite && !deviceAuthSession) {
      setShowDeviceAuthPrerequisite(false);
      return;
    }
    if (connectStep === "openai-login" && deviceAuthSession) {
      void cancelDeviceAuthSession();
      return;
    }

    resetDeviceAuthFlow();
    setApiKeyError(null);

    if (connectStep === "openai-auth") {
      setSelectedProvider(null);
      setConnectStep("provider");
      return;
    }

    if (connectStep === "openai-login" || connectStep === "openai-api-key" || connectStep === "openai-upload") {
      setSelectedProvider("openai");
      setConnectStep("openai-auth");
      return;
    }

    if (connectStep === "gemini-api-key") {
      setSelectedProvider("gemini");
      setConnectStep("gemini-auth");
      return;
    }

    resetConnectState();
  }, [
    cancelDeviceAuthSession,
    connectStep,
    deviceAuthSession,
    resetDeviceAuthFlow,
    resetConnectState,
    showDeviceAuthPrerequisite,
    showConnectWizard,
    wizardBusy,
  ]);

  const handleClose = useCallback(async () => {
    if (wizardBusy) {
      return;
    }
    if (deviceAuthSession) {
      await cancelDeviceAuthSession();
    }
    onClose?.();
  }, [cancelDeviceAuthSession, deviceAuthSession, onClose, wizardBusy]);

  const handleNativeBack = useCallback(() => {
    if (wizardBusy) {
      return;
    }
    if (canGoBack) {
      handleBack();
      return;
    }
    void handleClose();
  }, [canGoBack, handleBack, handleClose, wizardBusy]);
  useNativeBackButtonAction(
    canGoBack || (intent === "connect" && Boolean(onClose)),
    handleNativeBack,
  );

  useEffect(() => {
    connectWizardHydratedRef.current = false;
    if (!storageKey || !showConnectWizard) {
      return;
    }

    const stored = readAiConnectWizardState(storageKey);
    if (!stored) {
      resetConnectState();
      connectWizardHydratedRef.current = true;
      return;
    }
    setSelectedProvider(stored.provider);
    setConnectStep(stored.step);
    const hydratedProvider = stored.step === "openai-login" ? "codex" : null;
    hydrateDeviceAuthFlow({
      provider: hydratedProvider,
      session: stored.deviceAuthSession,
      error: stored.deviceAuthError,
    });
    connectWizardHydratedRef.current = true;
  }, [hydrateDeviceAuthFlow, resetConnectState, showConnectWizard, storageKey]);

  useEffect(() => {
    if (!storageKey) {
      return;
    }
    if (!showConnectWizard) {
      return;
    }
    if (!connectWizardHydratedRef.current) {
      return;
    }

    const base = defaultAiConnectWizardState();
    const stored = readAiConnectWizardState(storageKey);
    const open =
      intent === "connect" || connectStep !== "provider" || deviceAuthSession?.status === "pending";
    writeAiConnectWizardState(storageKey, {
      ...base,
      open,
      mode: stored?.mode ?? base.mode,
      provider: selectedProvider,
      step: connectStep,
      deviceAuthSession,
      deviceAuthError,
      updatedAt: Date.now(),
    });
  }, [connectStep, deviceAuthError, deviceAuthSession, intent, selectedProvider, showConnectWizard, storageKey]);

  const handleTriggerUpload = useCallback(() => {
    onStashDraft();
    fileInputRef.current?.click();
  }, [onStashDraft]);

  const handleUploadFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (!file) {
        return;
      }
      onUploadAuthJson(file);
      event.target.value = "";
    },
    [onUploadAuthJson],
  );

  const defaultCredential = useMemo(() => {
    if (!defaultCredentialId) {
      return null;
    }
    return connectedCredentials.find((credential) => credential.id === defaultCredentialId) ?? null;
  }, [connectedCredentials, defaultCredentialId]);

  const showDeviceAuthPanel = deviceAuthSession !== null;

  const handleSelectProvider = useCallback((provider: AiProviderChoice) => {
    if (provider === "openai") {
      setSelectedProvider("openai");
      setConnectStep("openai-auth");
      return;
    }
    if (provider === "deepseek") {
      setApiKeyDraft("");
      setSelectedProvider("deepseek");
      setConnectStep("deepseek-api-key");
      return;
    }
    if (provider === "zai") {
      setApiKeyDraft("");
      setSelectedProvider("zai");
      setConnectStep("zai-api-key");
      return;
    }
    if (provider === "gemini") {
      setApiKeyDraft("");
      setSelectedProvider("gemini");
      setConnectStep("gemini-auth");
      return;
    }
    setSelectedProvider(null);
    setConnectStep("provider");
  }, []);

  const handleOpenAiAuthChoice = useCallback((choice: "login" | "apiKey" | "upload") => {
    setSelectedProvider("openai");
    if (choice === "login") {
      setConnectStep("openai-login");
      return;
    }
    if (choice === "apiKey") {
      setConnectStep("openai-api-key");
      return;
    }
    if (!allowAuthJsonUpload) {
      setConnectStep("openai-auth");
      return;
    }
    setConnectStep("openai-upload");
  }, [allowAuthJsonUpload]);

  useEffect(() => {
    if (!allowAuthJsonUpload && connectStep === "openai-upload") {
      setConnectStep("openai-auth");
    }
  }, [allowAuthJsonUpload, connectStep]);

  if (effectiveState === "checking" && intent === "gate") {
    return (
      <ChatActivityBubble
        testId="credentials-status-indicator"
        label={title}
        indicator={<Spinner aria-hidden="true" tone="slate" size="xs" />}
        contentGapClassName="gap-2"
        className="text-slate-600 dark:text-slate-300"
      />
    );
  }

  if ((effectiveState === "unavailable" || effectiveState === "error") && intent === "gate") {
    const tone = effectiveState === "unavailable" ? "warning" : "danger";
    const iconClassName =
      effectiveState === "unavailable"
        ? "bg-secondary-100 text-secondary-800 dark:bg-secondary-400/15 dark:text-secondary-100"
        : "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-100";

    return (
      <Surface
        tone={tone}
        radius="2xl"
        shadow="sm"
        data-testid="credentials-status-indicator"
        className="max-w-[min(85%,30rem)] px-3 py-2.5 text-sm"
        aria-live="polite"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span
            className={[
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
              iconClassName,
            ].join(" ")}
            aria-hidden="true"
          >
            <WarningTriangle className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <Text as="div" variant="bodyStrong" tone="inherit" className="text-sm leading-5">
              {title}
            </Text>
            {resolvedDetail ? (
              <Text as="div" variant="caption" tone="muted" className="mt-0.5 text-xs leading-5">
                {resolvedDetail}
              </Text>
            ) : null}
          </div>
          {onRetry ? (
            <Button onPress={onRetry} variant="outline" size="xs" radius="full" isDisabled={isBusy}>
              Retry
            </Button>
          ) : null}
        </div>
      </Surface>
    );
  }

  return (
    <AccessDecisionCard
      tone={
        effectiveState === "error"
          ? "danger"
          : effectiveState === "unavailable"
            ? "warning"
            : "default"
      }
      className="leading-snug text-slate-600 dark:text-slate-200"
      aria-live="polite"
      data-testid="credentials-status-indicator"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {canGoBack ? (
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="Back"
              onPress={handleBack}
              isDisabled={wizardBusy}
              className="shrink-0 text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700"
            >
              <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
          <div className="flex min-w-0 items-center gap-2">
            {effectiveState === "checking" ? (
              <Spinner aria-hidden="true" tone="slate" size="xs" />
            ) : null}
            <Text
              as="div"
              variant="bodyStrong"
              tone="inherit"
              className="min-w-0 text-lg leading-6 text-slate-950 dark:text-white"
            >
              {title}
            </Text>
          </div>
        </div>
        {intent === "connect" && onClose ? (
          <IconButton
            variant="ghost"
            size="sm"
            radius="full"
            aria-label="Close AI connect"
            onPress={() => void handleClose()}
            isDisabled={wizardBusy}
            className="text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200"
          >
            <Xmark className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
      {resolvedDetail ? (
        <Text as="div" variant="body" tone="muted" className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {resolvedDetail}
        </Text>
      ) : null}
      {intent === "gate" && onChatWithoutAi ? (
        <Button
          onPress={() => {
            if (!wizardBusy) {
              onChatWithoutAi();
            }
          }}
          variant="ghost"
          size="xs"
          radius="xl"
          fullWidth
          isDisabled={wizardBusy}
          className="mt-2 justify-start text-left text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          data-testid="ai-gate-chat-without-ai"
        >
          Just chatting with teammates? Turn the assistant off.
        </Button>
      ) : null}

          {state === "needs_default" && connectedCredentials.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              {connectedCredentials.map((credential) => (
                <Button
                  key={credential.id}
                  onPress={() => onSetDefaultCredential?.(credential.id)}
                  variant={credential.id === defaultCredentialId ? "primary" : "outline"}
                  size="xs"
                  radius="full"
                  fullWidth
                  isDisabled={isBusy || !onSetDefaultCredential}
                  className="justify-start"
                >
                  {formatCredentialOptionLabel(credential)}
                </Button>
              ))}
            </div>
          ) : null}

          {showConnectWizard && connectStep === "provider" ? (
            <div className="mt-5 space-y-3">
              {defaultCredential ? (
                <Text as="div" variant="caption" tone="muted" className="text-xs">
                  Currently using: {resolveCredentialLabel(defaultCredential)}
                </Text>
              ) : null}
              {managedAi?.available && connectedCredentials.length === 0 ? (
                <Button
                  onPress={() => {
                    void onUseManagedAi?.();
                  }}
                  variant="primary"
                  size="xs"
                  radius="full"
                  fullWidth
                  isDisabled={isBusy || !onUseManagedAi || managedAi.remainingPrompts === 0}
                  className="justify-center"
                >
                  {`Use free ${managedAi.label} (${managedAi.dailyPromptLimit}/day)`}
                </Button>
              ) : null}
              <AccessSectionLabel>Choose provider</AccessSectionLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                <AccessProviderChoiceButton
                  onPress={() => handleSelectProvider("openai")}
                  isDisabled={isBusy}
                  featured
                  icon={
                    <AiProviderIconFrame featured className="text-slate-900 dark:text-slate-50">
                      <OpenAIIcon className="h-5 w-5 text-slate-950" />
                    </AiProviderIconFrame>
                  }
                  title="OpenAI"
                  description="Subscription or API key."
                />
                <AccessProviderChoiceButton
                  onPress={() => handleSelectProvider("deepseek")}
                  isDisabled={isBusy}
                  icon={
                    <AiProviderIconFrame className="text-emerald-600">
                      <DeepSeekIcon className="h-5 w-5" />
                    </AiProviderIconFrame>
                  }
                  title="DeepSeek"
                  description="Use an API key."
                />
                <AccessProviderChoiceButton
                  onPress={() => handleSelectProvider("zai")}
                  isDisabled={isBusy}
                  icon={
                    <AiProviderIconFrame className="text-[#7C3AED]">
                      <ZaiIcon className="h-5 w-5" />
                    </AiProviderIconFrame>
                  }
                  title="z.ai"
                  description="Use a z.ai API key."
                />
                <AccessProviderChoiceButton
                  onPress={() => handleSelectProvider("gemini")}
                  isDisabled={isBusy}
                  icon={
                    <AiProviderIconFrame className="text-[#0EA5E9]">
                      <GeminiIcon className="h-5 w-5" />
                    </AiProviderIconFrame>
                  }
                  title="Gemini"
                  description="Use a Gemini API key."
                />
              </div>
            </div>
          ) : null}

          {showConnectWizard && connectStep === "openai-auth" ? (
            <div className="mt-2 space-y-2">
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                OpenAI selected. How do you want to connect?
              </Text>
              <div className="flex flex-col gap-2">
                <Button
                  onPress={() => handleOpenAiAuthChoice("login")}
                  variant="primary"
                  size="xs"
                  radius="full"
                  fullWidth
                  isDisabled={isBusy}
                  className="justify-start"
                >
                  ChatGPT login (Plus/Team)
                </Button>
                <Button
                  onPress={() => handleOpenAiAuthChoice("apiKey")}
                  variant="outline"
                  size="xs"
                  radius="full"
                  fullWidth
                  isDisabled={isBusy}
                  className="justify-start"
                >
                  API key
                </Button>
                {allowAuthJsonUpload ? (
                  <Button
                    onPress={() => handleOpenAiAuthChoice("upload")}
                    variant="ghost"
                    size="xs"
                    radius="full"
                    fullWidth
                    isDisabled={isBusy}
                    className="justify-start"
                  >
                    Upload auth.json (advanced)
                  </Button>
                ) : null}
              </div>
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                ChatGPT subscription or API key.
              </Text>
            </div>
          ) : null}

          {showConnectWizard && connectStep === "gemini-auth" ? (
            <div className="mt-2 space-y-2">
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                Gemini currently connects with an API key.
              </Text>
              <div className="flex flex-col gap-2">
                <Button
                  onPress={() => {
                    setApiKeyDraft("");
                    setApiKeyError(null);
                    setConnectStep("gemini-api-key");
                  }}
                  variant="primary"
                  size="xs"
                  radius="full"
                  fullWidth
                  isDisabled={isBusy}
                  className="justify-start"
                >
                  API key
                </Button>
              </div>
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                Google subscription login is disabled for now to keep credential handling simple.
              </Text>
            </div>
          ) : null}

          {showConnectWizard &&
          connectStep === "openai-login" &&
          !showDeviceAuthPanel &&
          !showDeviceAuthPrerequisite ? (
            <div className="mt-2 space-y-2">
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                Great — pick a login method:
              </Text>
              <div className="flex flex-col gap-2">
                {canUseDesktopConnect ? (
                  <Button
                    onPress={() => {
                      if (shouldPromptForAuthJsonUpload) {
                        handleTriggerUpload();
                        return;
                      }
                      onStashDraft();
                      onConnectDesktop();
                    }}
                    variant="primary"
                    size="xs"
                    radius="full"
                    fullWidth
                    isDisabled={isBusy}
                    className="justify-start"
                  >
                    {shouldPromptForAuthJsonUpload ? "Choose auth.json" : "Use local Codex login"}
                  </Button>
                ) : null}
                <Button
                  onPress={() => setShowDeviceAuthPrerequisite(true)}
                  variant={canUseDesktopConnect ? "outline" : "primary"}
                  size="xs"
                  radius="full"
                  fullWidth
                  isDisabled={isBusy}
                  className="justify-start"
                >
                  Browser login (device code)
                </Button>
              </div>
              {canUseDesktopConnect ? (
                <Text as="div" variant="caption" tone="muted" className="text-xs">
                  {desktopCodexAuthJsonStatus?.exists
                    ? "Found ~/.codex/auth.json."
                    : shouldPromptForAuthJsonUpload
                      ? "No default Codex auth.json found on this computer."
                      : "Desktop will use this computer's local Codex login."}
                </Text>
              ) : null}
            </div>
          ) : null}

          {showConnectWizard &&
          connectStep === "openai-login" &&
          !showDeviceAuthPanel &&
          showDeviceAuthPrerequisite ? (
            <ChatGptDeviceCodePrerequisite
              busy={deviceAuthBusy}
              containerClassName="mt-2 rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-300"
              containerTestId="chat-ai-device-code-prerequisite"
              continueClassName="mt-2 min-h-11"
              disabled={isBusy}
              helpTestId="chat-ai-device-code-help"
              onContinue={beginDeviceAuth}
            />
          ) : null}

          {showConnectWizard && connectStep === "openai-login" && showDeviceAuthPanel ? (
            <div className="mt-2 space-y-2">
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                Open the login page and enter this one‑time code:
              </Text>
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                You&apos;ll connect whichever ChatGPT account you sign into (email doesn&apos;t need to match Instafy). Codex
                access typically requires ChatGPT Plus/Team.
              </Text>
              <div className="space-y-1.5 rounded-2xl border border-slate-200/70 bg-slate-50/60 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-300">
                <div className="flex items-start gap-2">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xxs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-100">
                    1
                  </span>
                  <span>Copy the one-time code if needed.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xxs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-100">
                    2
                  </span>
                  <span>Finish approval in the browser tab that opens.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xxs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-100">
                    3
                  </span>
                  <span>Come back here. Instafy will detect the connection automatically.</span>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 break-all rounded-lg bg-white px-3 py-2 text-base font-semibold tracking-widest text-slate-800 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-100 dark:ring-slate-700">
                    {deviceAuthSession.userCode}
                  </code>
                  <Button
                    onPress={() => {
                      try {
                        void navigator.clipboard?.writeText(deviceAuthSession.userCode);
                      } catch (_error) {
                        // ignore clipboard failures
                      }
                    }}
                    variant="outline"
                    size="sm"
                    radius="full"
                    isDisabled={isBusy || deviceAuthCompleting}
                  >
                    Copy code
                  </Button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    onPress={() => void openExternalUrl(deviceAuthSession.verificationUrl)}
                    variant="primary"
                    size="sm"
                    radius="full"
                    fullWidth
                    isDisabled={isBusy || deviceAuthCompleting}
                    className="min-h-11 justify-start sm:w-auto sm:flex-1"
                  >
                    Open login
                  </Button>
                  <Button
                    onPress={() => {
                      try {
                        void navigator.clipboard?.writeText(deviceAuthSession.verificationUrl);
                      } catch (_error) {
                        // ignore clipboard failures
                      }
                    }}
                    variant="outline"
                    size="sm"
                    radius="full"
                    fullWidth
                    isDisabled={isBusy || deviceAuthCompleting}
                    className="min-h-11 justify-start sm:w-auto sm:flex-1"
                  >
                    Copy link
                  </Button>
                  <Button
                    onPress={cancelDeviceAuthSession}
                    variant="ghost"
                    size="sm"
                    radius="full"
                    fullWidth
                    isDisabled={isBusy || deviceAuthBusy || deviceAuthCompleting}
                    className="min-h-11 justify-start sm:w-auto"
                  >
                    Cancel login
                  </Button>
                </div>
              </div>
              <Text as="div" variant="caption" tone="muted" className="text-[11px] leading-relaxed">
                Only enter this code on the OpenAI page. Instafy will never ask you to paste your ChatGPT password
                here.
              </Text>
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-300">
                {deviceAuthSession.status === "pending" ? (
                  <>
                    <Spinner aria-hidden="true" tone="slate" size="xs" />
                    <span>
                      {deviceAuthCompleting
                        ? "Login complete — checking the connection…"
                        : "Waiting for you to finish login…"}
                    </span>
                  </>
                ) : deviceAuthSession.status === "completed" ? (
                  deviceAuthCompletionWarning ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      {deviceAuthCompletionWarning}
                    </span>
                  ) : (
                    <>
                      <Spinner aria-hidden="true" tone="primary" size="xs" />
                      <span>Connected — syncing credentials…</span>
                    </>
                  )
                ) : deviceAuthSession.status === "failed" ? (
                  <span className="text-rose-600 dark:text-rose-400">
                    {deviceAuthSession.error ?? "Device login failed."}
                  </span>
                ) : null}
              </div>
              {deviceAuthSession.status === "failed" ? (
                <div className="flex flex-col gap-2">
                  <Button
                    onPress={beginDeviceAuth}
                    variant="primary"
                    size="xs"
                    radius="full"
                    fullWidth
                    className="justify-start"
                    isDisabled={isBusy}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {showConnectWizard && connectStep === "openai-upload" ? (
            <div className="mt-2 space-y-2">
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                Upload a `codex` auth JSON (advanced).
              </Text>
              <div className="flex flex-col gap-2">
                <Button
                  onPress={handleTriggerUpload}
                  variant="outline"
                  size="xs"
                  radius="full"
                  fullWidth
                  isDisabled={isBusy}
                  className="justify-start"
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  Upload auth.json
                </Button>
              </div>
            </div>
          ) : null}

          {state === "error" || state === "unavailable" ? (
            <div className="mt-2 flex flex-col gap-2">
              {onRetry ? (
                <Button onPress={onRetry} variant="primary" size="xs" radius="full" fullWidth isDisabled={isBusy} className="justify-start">
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}

          {showConnectWizard &&
          (connectStep === "openai-api-key" ||
            connectStep === "deepseek-api-key" ||
            connectStep === "zai-api-key" ||
            connectStep === "gemini-api-key") ? (
            <div className="mt-2 space-y-2">
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                {(connectStep === "openai-api-key"
                  ? "OpenAI API key"
                  : connectStep === "deepseek-api-key"
                    ? "DeepSeek API key"
                    : connectStep === "zai-api-key"
                      ? "z.ai API key"
                      : "Gemini API key") + " selected. Paste it below:"}
              </Text>
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                Don’t have a key?{" "}
                <a
                  href={
                    connectStep === "openai-api-key"
                      ? "https://platform.openai.com/api-keys"
                      : connectStep === "deepseek-api-key"
                        ? "https://platform.deepseek.com/api_keys"
                        : connectStep === "zai-api-key"
                          ? "https://z.ai"
                          : "https://aistudio.google.com/apikey"
                  }
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(event) => {
                    event.preventDefault();
                    void openExternalUrl(event.currentTarget.href);
                  }}
                  className="font-medium text-primary-600 underline underline-offset-2 hover:text-primary-700 dark:text-primary-300 dark:hover:text-primary-200"
                >
                  Create one at{" "}
                  {connectStep === "openai-api-key"
                    ? "platform.openai.com"
                    : connectStep === "deepseek-api-key"
                      ? "platform.deepseek.com"
                      : connectStep === "zai-api-key"
                        ? "z.ai"
                        : "Google AI Studio"}
                </a>
                {" "}— you pay the provider directly for what you use.
              </Text>
              <Input
                value={apiKeyDraft}
                onChange={(event) => {
                  setApiKeyDraft(event.target.value);
                  setApiKeyError(null);
                }}
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={
                  connectStep === "openai-api-key"
                    ? "OpenAI API key"
                    : connectStep === "deepseek-api-key"
                      ? "DeepSeek API key"
                      : connectStep === "zai-api-key"
                        ? "z.ai API key"
                        : "Gemini API key"
                }
                placeholder="sk-…"
                size="sm"
                radius="xl"
                disabled={isBusy}
              />
              {apiKeyError ? (
                <Text
                  as="div"
                  variant="caption"
                  tone="danger"
                  className="text-xs"
                  data-testid="ai-connect-api-key-error"
                >
                  {apiKeyError}
                </Text>
              ) : null}
              <div className="flex flex-col gap-2">
                <Button
                  onPress={() => {
                    const trimmed = apiKeyDraft.trim();
                    if (!trimmed) {
                      return;
                    }
                    onStashDraft();
                    setApiKeyError(null);
                    void (async () => {
                      const provider =
                        connectStep === "openai-api-key"
                          ? "openai"
                          : connectStep === "deepseek-api-key"
                            ? "deepseek"
                            : connectStep === "zai-api-key"
                              ? "zai"
                              : "gemini";
                      const result = await onSaveApiKey(trimmed, provider);
                      if (!result.success) {
                        setApiKeyError(result.error ?? "Unable to save API key.");
                        return;
                      }
                      setApiKeyDraft("");
                    })();
                  }}
                  variant="primary"
                  size="xs"
                  radius="full"
                  fullWidth
                  className="justify-start"
                  isDisabled={isBusy || apiKeyDraft.trim().length === 0}
                >
                  Save key
                </Button>
                <Button
                  onPress={() => {
                    setApiKeyDraft("");
                    if (connectStep === "openai-api-key") {
                      setConnectStep("openai-auth");
                      return;
                    }
                    if (connectStep === "gemini-api-key") {
                      setConnectStep("gemini-auth");
                      return;
                    }
                    resetConnectState();
                  }}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  fullWidth
                  className="justify-start"
                  isDisabled={isBusy}
                >
                  Cancel
                </Button>
              </div>
              <Text as="div" variant="caption" tone="muted" className="text-xs">
                Saved to your Instafy profile (not stored in the browser).
              </Text>
            </div>
          ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleUploadFile}
      />
    </AccessDecisionCard>
  );
}
