import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type RefObject,
} from "react";
import { NavArrowLeft } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { DeepSeekIcon, GeminiIcon, OpenAIIcon, ZaiIcon } from "../../../components/ProviderIcons";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  StudioDialogBody,
  StudioDialogHeader,
} from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import type { DeviceAuthProvider } from "../../../sdk/instafy";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import { ChatGptDeviceCodePrerequisite } from "./ChatGptDeviceCodePrerequisite";
import { CodexAdvancedConnectionOptions } from "./CodexAdvancedConnectionOptions";
import {
  isLikelyDesktopDevice,
  shouldPromptForCodexAuthJsonUpload,
} from "./desktopCodexAuthJson";
import type { DeviceAuthSession } from "./device-auth/useDeviceAuthFlow";

export type CredentialsConnectModalStep =
  | "picker"
  | "codex"
  | "openai"
  | "deepseek"
  | "zai"
  | "gemini";
export type CredentialsConnectApiKeyProvider = "openai" | "deepseek" | "zai" | "gemini";

// Where each provider issues API keys — shown as a "Get a key" link so users
// don't have to hunt for the console.
const API_KEY_CONSOLE_URL: Record<CredentialsConnectApiKeyProvider, string> = {
  openai: "https://platform.openai.com/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  zai: "https://z.ai/manage-apikey/apikey-list",
  gemini: "https://aistudio.google.com/apikey",
};

function ApiKeyHelpLink({ provider }: { provider: CredentialsConnectApiKeyProvider }) {
  return (
    <a
      href={API_KEY_CONSOLE_URL[provider]}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(event.currentTarget.href);
      }}
      className="text-xs font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-400"
    >
      Get a key ↗
    </a>
  );
}

export type CredentialsConnectModalProps = {
  canManageAiConnections: boolean;
  canUseDesktopConnect: boolean;
  desktopCodexAuthJsonStatus: InstafyDesktopCodexAuthJsonStatus | null;
  connectModalOpen: boolean;
  connectModalStep: CredentialsConnectModalStep;
  connectPending: boolean;
  deviceAuthBusy: boolean;
  deviceAuthCompleting: boolean;
  apiKeyPendingProvider: CredentialsConnectApiKeyProvider | null;
  showAdvanced: boolean;
  labelDraft: string;
  openaiApiKeyDraft: string;
  openaiLabelDraft: string;
  deepseekApiKeyDraft: string;
  deepseekLabelDraft: string;
  zaiApiKeyDraft: string;
  zaiLabelDraft: string;
  geminiApiKeyDraft: string;
  deviceAuthError: string | null;
  deviceAuthProvider: DeviceAuthProvider | null;
  deviceAuthSession: DeviceAuthSession | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onBack: () => void;
  onStepChange: (step: CredentialsConnectModalStep) => void;
  onShowAdvancedChange: (next: boolean) => void;
  onLabelDraftChange: (value: string) => void;
  onOpenaiApiKeyDraftChange: (value: string) => void;
  onOpenaiLabelDraftChange: (value: string) => void;
  onDeepseekApiKeyDraftChange: (value: string) => void;
  onDeepseekLabelDraftChange: (value: string) => void;
  onZaiApiKeyDraftChange: (value: string) => void;
  onZaiLabelDraftChange: (value: string) => void;
  onGeminiApiKeyDraftChange: (value: string) => void;
  onConnectCodex: () => void;
  onBeginDeviceAuth: (provider: "codex") => void;
  onCancelDeviceAuthSession: () => void;
  onTriggerUpload: () => void;
  onUploadFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onConnectApiKey: (provider: CredentialsConnectApiKeyProvider) => Promise<boolean>;
};

export function CredentialsConnectModal({
  canManageAiConnections,
  canUseDesktopConnect,
  desktopCodexAuthJsonStatus,
  connectModalOpen,
  connectModalStep,
  connectPending,
  deviceAuthBusy,
  deviceAuthCompleting,
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
  deviceAuthProvider,
  deviceAuthSession,
  fileInputRef,
  onClose,
  onBack,
  onStepChange,
  onShowAdvancedChange,
  onLabelDraftChange,
  onOpenaiApiKeyDraftChange,
  onOpenaiLabelDraftChange,
  onDeepseekApiKeyDraftChange,
  onDeepseekLabelDraftChange,
  onZaiApiKeyDraftChange,
  onZaiLabelDraftChange,
  onGeminiApiKeyDraftChange,
  onConnectCodex,
  onBeginDeviceAuth,
  onCancelDeviceAuthSession,
  onTriggerUpload,
  onUploadFile,
  onConnectApiKey,
}: CredentialsConnectModalProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false);
  const [copyDeviceCodeFailed, setCopyDeviceCodeFailed] = useState(false);
  const [showDesktopDeviceCodePrerequisite, setShowDesktopDeviceCodePrerequisite] =
    useState(false);
  const canMaskWithTextSecurity = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }

    const style = window.document?.documentElement?.style;
    if (style && ("WebkitTextSecurity" in style || "webkitTextSecurity" in style)) {
      return true;
    }

    const cssSupports = (
      window as unknown as { CSS?: { supports?: (property: string, value: string) => boolean } }
    ).CSS?.supports;
    if (typeof cssSupports !== "function") {
      return false;
    }

    return cssSupports("-webkit-text-security", "disc");
  }, []);

  const apiKeyInputType = canMaskWithTextSecurity ? "text" : "password";
  const apiKeyInputStyle: CSSProperties | undefined = canMaskWithTextSecurity
    ? ({ WebkitTextSecurity: "disc" } as unknown as CSSProperties)
    : undefined;

  const shouldPromptForAuthJsonUpload = shouldPromptForCodexAuthJsonUpload(
    desktopCodexAuthJsonStatus,
  );
  const connectButtonLabel = shouldPromptForAuthJsonUpload
    ? "Choose auth.json"
    : "Use local Codex login";
  const codexDeviceAuthSession = deviceAuthProvider === "codex" ? deviceAuthSession : null;
  const allowAuthJsonImport = canUseDesktopConnect || isLikelyDesktopDevice();
  const modalBusy =
    connectPending || deviceAuthBusy || deviceAuthCompleting || apiKeyPendingProvider !== null;
  const codexChoiceTitle = canUseDesktopConnect ? "Codex on this computer" : "ChatGPT login";
  const codexChoiceDescription = canUseDesktopConnect
    ? desktopCodexAuthJsonStatus?.exists
      ? "Use this computer's existing Codex login."
      : shouldPromptForAuthJsonUpload
        ? "Choose a Codex auth.json from this computer."
        : "Use this computer's Codex login."
    : "Use your ChatGPT subscription with a one-time device code.";

  useEffect(() => {
    setCopiedDeviceCode(false);
    setCopyDeviceCodeFailed(false);
  }, [codexDeviceAuthSession?.sessionId]);

  useEffect(() => {
    setShowDesktopDeviceCodePrerequisite(false);
  }, [connectModalOpen, connectModalStep]);

  useEffect(() => {
    if (!codexDeviceAuthSession || codexDeviceAuthSession.status !== "pending") {
      return;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [codexDeviceAuthSession]);

  const deviceCodeExpiresIn = useMemo(() => {
    if (!codexDeviceAuthSession?.expiresAt) {
      return null;
    }
    const expiresAtMs = Date.parse(codexDeviceAuthSession.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return null;
    }
    const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
    const minutesPart = Math.floor(seconds / 60);
    const secondsPart = String(seconds % 60).padStart(2, "0");
    return `${minutesPart}:${secondsPart}`;
  }, [codexDeviceAuthSession?.expiresAt, nowMs]);

  const deviceLoginHost = useMemo(() => {
    if (!codexDeviceAuthSession?.verificationUrl) {
      return "auth.openai.com";
    }
    try {
      return new URL(codexDeviceAuthSession.verificationUrl).hostname;
    } catch (_error) {
      return "auth.openai.com";
    }
  }, [codexDeviceAuthSession?.verificationUrl]);

  const handleCopyText = async (value: string) => {
    setCopiedDeviceCode(false);
    setCopyDeviceCodeFailed(false);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopiedDeviceCode(true);
    } catch (_error) {
      setCopyDeviceCodeFailed(true);
    }
  };

  const handleConnectApiKeyAndClose = async (provider: CredentialsConnectApiKeyProvider) => {
    const ok = await onConnectApiKey(provider);
    if (ok) {
      onClose();
    }
  };

  const handleNativeBack = useCallback(() => {
    if (modalBusy) {
      return;
    }
    if (connectModalStep === "picker") {
      onClose();
      return;
    }
    onBack();
  }, [connectModalStep, modalBusy, onBack, onClose]);
  useNativeBackButtonAction(connectModalOpen, handleNativeBack);

  return (
    <StudioDialogModal
      isOpen={connectModalOpen}
      onOpenChange={(open) => {
        if (!open && !modalBusy) {
          onClose();
        }
      }}
      isDismissable={!modalBusy}
      dialogAriaLabel="Add AI connection"
      data-testid="credentials-connect-modal"
      modalClassName="flex max-h-full flex-col overflow-hidden"
      dialogClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <StudioDialogHeader
        title="Add AI connection"
        description="Saved to your profile for hosted runs."
        descriptionClassName="text-sm leading-snug"
        leading={
          connectModalStep === "picker" ? null : (
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="Back"
              onPress={onBack}
              isDisabled={modalBusy}
            >
              <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          )
        }
        onClose={onClose}
        closeButtonDisabled={modalBusy}
        closeLabel="Close"
      />

      <StudioDialogBody className="min-h-0 flex-1 touch-pan-y space-y-3 overflow-y-auto overscroll-contain">
        {connectModalStep === "picker" ? (
          <div className="space-y-2">
            <Button
              onPress={() => onStepChange("codex")}
              variant="ghost"
              size="sm"
              radius="xl"
              fullWidth
              className="items-start justify-start gap-3 border border-slate-200 bg-white p-3 text-left shadow-none hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900/60 dark:data-[hovered]:bg-slate-900/60"
              data-testid="credentials-connect-choice-codex"
              isDisabled={!canManageAiConnections}
            >
              <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-white/90 text-slate-900 ring-1 ring-black/5 dark:bg-slate-950/40 dark:text-slate-50 dark:ring-white/10">
                <OpenAIIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <Text variant="bodyStrong" tone="primary">
                  {codexChoiceTitle}
                </Text>
                <Text variant="caption" tone="muted" className="mt-0.5">
                  {codexChoiceDescription}
                </Text>
              </span>
            </Button>

            <Button
              onPress={() => onStepChange("openai")}
              variant="ghost"
              size="sm"
              radius="xl"
              fullWidth
              className="items-start justify-start gap-3 border border-slate-200 bg-white p-3 text-left shadow-none hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900/60 dark:data-[hovered]:bg-slate-900/60"
              data-testid="credentials-connect-choice-openai"
              isDisabled={!canManageAiConnections}
            >
              <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-white/90 text-slate-900 ring-1 ring-black/5 dark:bg-slate-950/40 dark:text-slate-50 dark:ring-white/10">
                <OpenAIIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <Text variant="bodyStrong" tone="primary">
                  OpenAI API key
                </Text>
                <Text variant="caption" tone="muted" className="mt-0.5">
                  Connect a key from the OpenAI API platform.
                </Text>
              </span>
            </Button>

            <Button
              onPress={() => onStepChange("deepseek")}
              variant="ghost"
              size="sm"
              radius="xl"
              fullWidth
              className="items-start justify-start gap-3 border border-slate-200 bg-white p-3 text-left shadow-none hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900/60 dark:data-[hovered]:bg-slate-900/60"
              data-testid="credentials-connect-choice-deepseek"
              isDisabled={!canManageAiConnections}
            >
              <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-white/90 text-[#2563EB] ring-1 ring-black/5 dark:bg-slate-950/40 dark:text-slate-50 dark:ring-white/10">
                <DeepSeekIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <Text variant="bodyStrong" tone="primary">
                  DeepSeek API key
                </Text>
                <Text variant="caption" tone="muted" className="mt-0.5">
                  Best if you already have a DeepSeek account.
                </Text>
              </span>
            </Button>

            <Button
              onPress={() => onStepChange("zai")}
              variant="ghost"
              size="sm"
              radius="xl"
              fullWidth
              className="items-start justify-start gap-3 border border-slate-200 bg-white p-3 text-left shadow-none hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900/60 dark:data-[hovered]:bg-slate-900/60"
              data-testid="credentials-connect-choice-zai"
              isDisabled={!canManageAiConnections}
            >
              <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-white/90 text-[#7C3AED] ring-1 ring-black/5 dark:bg-slate-950/40 dark:text-slate-50 dark:ring-white/10">
                <ZaiIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <Text variant="bodyStrong" tone="primary">
                  z.ai API key
                </Text>
                <Text variant="caption" tone="muted" className="mt-0.5">
                  Connect a z.ai key for hosted runs.
                </Text>
              </span>
            </Button>

            <Button
              onPress={() => onStepChange("gemini")}
              variant="ghost"
              size="sm"
              radius="xl"
              fullWidth
              className="items-start justify-start gap-3 border border-slate-200 bg-white p-3 text-left shadow-none hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900/60 dark:data-[hovered]:bg-slate-900/60"
              data-testid="credentials-connect-choice-gemini"
              isDisabled={!canManageAiConnections}
            >
              <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-white/90 text-[#0EA5E9] ring-1 ring-black/5 dark:bg-slate-950/40 dark:text-slate-50 dark:ring-white/10">
                <GeminiIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <Text variant="bodyStrong" tone="primary">
                  Google Gemini
                </Text>
                <Text variant="caption" tone="muted" className="mt-0.5">
                  Connect a Gemini API key.
                </Text>
              </span>
            </Button>

            {!canManageAiConnections ? (
              <Text variant="caption" tone="muted" className="mt-2">
                Sign in and configure the runtime controller to add connections.
              </Text>
            ) : null}
          </div>
        ) : connectModalStep === "codex" ? (
          <div className="space-y-3" data-testid="credentials-codex-card">
            {deviceAuthError ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                {deviceAuthError}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Text variant="bodyStrong" tone="secondary">
                {codexChoiceTitle}
              </Text>
              {canUseDesktopConnect ? (
                <Button
                  onPress={shouldPromptForAuthJsonUpload ? onTriggerUpload : onConnectCodex}
                  isDisabled={!canManageAiConnections || modalBusy || deviceAuthSession !== null}
                  variant="outline"
                  size="xs"
                  radius="full"
                  data-testid="credentials-connect-codex"
                >
                  {connectPending ? "Connecting…" : connectButtonLabel}
                </Button>
              ) : null}
            </div>

            {codexDeviceAuthSession ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300">
                <div className="font-semibold text-slate-700 dark:text-slate-100">Device login</div>
                <div className="mt-1">Open the OpenAI login page and enter this one-time code:</div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 break-all rounded-lg bg-white px-3 py-2 text-base font-semibold tracking-widest text-slate-800 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-100 dark:ring-slate-700">
                    {codexDeviceAuthSession.userCode}
                  </code>
                  <Button
                    onPress={() => void handleCopyText(codexDeviceAuthSession.userCode)}
                    variant="outline"
                    size="sm"
                    radius="full"
                    isDisabled={modalBusy}
                    aria-label="Copy device code"
                  >
                    {copiedDeviceCode ? "Copied" : "Copy"}
                  </Button>
                </div>
                {copyDeviceCodeFailed ? (
                  <div className="mt-2 text-xs text-rose-600 dark:text-rose-400">
                    Copy was blocked. Press and hold the code to copy it manually.
                  </div>
                ) : null}
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Button
                    onPress={() => void openExternalUrl(codexDeviceAuthSession.verificationUrl)}
                    variant="primary"
                    size="sm"
                    radius="full"
                    isDisabled={modalBusy}
                    fullWidth
                  >
                    Open {deviceLoginHost}
                  </Button>
                  <Button
                    onPress={onCancelDeviceAuthSession}
                    variant="ghost"
                    size="sm"
                    radius="full"
                    isDisabled={modalBusy}
                  >
                    Cancel
                  </Button>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-300">
                  {codexDeviceAuthSession.status === "pending" ? (
                    <>
                      <Spinner aria-hidden="true" tone="slate" size="xs" />
                      {deviceAuthCompleting ? (
                        <span>Login complete — checking the connection…</span>
                      ) : (
                        <span>
                          Waiting for login{deviceCodeExpiresIn ? ` · code expires in ${deviceCodeExpiresIn}` : "…"}
                        </span>
                      )}
                    </>
                  ) : codexDeviceAuthSession.status === "failed" ? (
                    <span className="text-rose-600 dark:text-rose-400">
                      {codexDeviceAuthSession.error ?? "Device login failed."}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  Only enter this code at <span className="font-semibold">{deviceLoginHost}</span>. Instafy will
                  never ask you to paste your ChatGPT password here.
                </div>
                {codexDeviceAuthSession.status === "failed" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      onPress={() => onBeginDeviceAuth("codex")}
                      variant="primary"
                      size="xs"
                      radius="full"
                      isDisabled={modalBusy}
                    >
                      Try again
                    </Button>
                    <Button
                      onPress={onCancelDeviceAuthSession}
                      variant="ghost"
                      size="xs"
                      radius="full"
                      isDisabled={modalBusy}
                    >
                      Back
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : canUseDesktopConnect ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300">
                {desktopCodexAuthJsonStatus?.exists ? (
                  <>
                    <div className="font-semibold text-slate-700 dark:text-slate-100">
                      Desktop found your local Codex login.
                    </div>
                    <div className="mt-1">~/.codex/auth.json</div>
                    <div className="mt-1">
                      Click once to import it into your Instafy AI connections.
                    </div>
                  </>
                ) : shouldPromptForAuthJsonUpload ? (
                  <>
                    <div className="font-semibold text-slate-700 dark:text-slate-100">
                      No default Codex login found.
                    </div>
                    <div className="mt-1">
                      Desktop only checks ~/.codex/auth.json. If Codex uses your system keychain or
                      a custom CODEX_HOME, use browser login instead.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-slate-700 dark:text-slate-100">
                      Use your local Codex login.
                    </div>
                    <div className="mt-1">
                      Desktop will import ~/.codex/auth.json when you continue.
                    </div>
                  </>
                )}
              </div>
            ) : (
              <ChatGptDeviceCodePrerequisite
                busy={connectPending}
                containerTestId="credentials-chatgpt-device-prerequisite"
                continueTestId="credentials-connect-codex"
                disabled={!canManageAiConnections}
                helpTestId="credentials-chatgpt-device-code-help"
                onContinue={() => onBeginDeviceAuth("codex")}
              />
            )}

            {canUseDesktopConnect && !codexDeviceAuthSession ? (
              <div className="space-y-2">
                <div className="flex justify-end">
                  <Button
                    onPress={() =>
                      setShowDesktopDeviceCodePrerequisite((current) => !current)
                    }
                    variant="ghost"
                    size="xs"
                    radius="full"
                    aria-controls="credentials-chatgpt-device-prerequisite"
                    aria-expanded={showDesktopDeviceCodePrerequisite}
                    data-testid="credentials-connect-codex-browser-toggle"
                  >
                    {showDesktopDeviceCodePrerequisite
                      ? "Hide browser login"
                      : "Use browser login instead"}
                  </Button>
                </div>
                {showDesktopDeviceCodePrerequisite ? (
                  <ChatGptDeviceCodePrerequisite
                    busy={connectPending}
                    containerId="credentials-chatgpt-device-prerequisite"
                    containerTestId="credentials-chatgpt-device-prerequisite"
                    continueTestId="credentials-connect-codex-browser"
                    disabled={!canManageAiConnections}
                    helpTestId="credentials-chatgpt-device-code-help"
                    onContinue={() => onBeginDeviceAuth("codex")}
                  />
                ) : null}
              </div>
            ) : null}

            <CodexAdvancedConnectionOptions
              allowAuthJsonImport={allowAuthJsonImport}
              expanded={showAdvanced}
              label={labelDraft}
              onExpandedChange={onShowAdvancedChange}
              onLabelChange={onLabelDraftChange}
              onChooseAuthJson={onTriggerUpload}
            />

            {allowAuthJsonImport ? (
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                data-testid="credentials-codex-auth-json-input"
                onChange={(event) => onUploadFile(event)}
              />
            ) : null}
          </div>
        ) : connectModalStep === "openai" ? (
          <div className="space-y-3" data-testid="credentials-openai-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Text variant="bodyStrong" tone="secondary">
                  OpenAI API key
                </Text>
                <ApiKeyHelpLink provider="openai" />
              </div>
              <Button
                onPress={() => void handleConnectApiKeyAndClose("openai")}
                isDisabled={
                  !canManageAiConnections ||
                  connectPending ||
                  apiKeyPendingProvider !== null ||
                  !openaiApiKeyDraft.trim()
                }
                variant="outline"
                size="xs"
                radius="full"
                data-testid="credentials-openai-connect"
              >
                {apiKeyPendingProvider === "openai" ? "Connecting…" : "Connect & test"}
              </Button>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <Field label="API key" htmlFor="credentials-openai-api-key">
                <Input
                  id="credentials-openai-api-key"
                  value={openaiApiKeyDraft}
                  onChange={(event) => onOpenaiApiKeyDraftChange(event.target.value)}
                  placeholder="Paste key"
                  size="sm"
                  radius="xl"
                  type={apiKeyInputType}
                  style={apiKeyInputStyle}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-bwignore="true"
                  data-1p-ignore="true"
                  data-testid="credentials-openai-api-key-input"
                  disabled={
                    !canManageAiConnections ||
                    connectPending ||
                    apiKeyPendingProvider !== null
                  }
                />
              </Field>
              <Field label="Label (optional)" htmlFor="credentials-openai-label">
                <Input
                  id="credentials-openai-label"
                  value={openaiLabelDraft}
                  onChange={(event) => onOpenaiLabelDraftChange(event.target.value)}
                  placeholder="OpenAI"
                  size="sm"
                  radius="xl"
                  autoComplete="off"
                  data-testid="credentials-openai-label-input"
                  disabled={
                    !canManageAiConnections ||
                    connectPending ||
                    apiKeyPendingProvider !== null
                  }
                />
              </Field>
            </div>

            <Text variant="caption" tone="muted" className="text-xs">
              Note: hosted runs may send prompt context (including file snippets) to OpenAI.
            </Text>
          </div>
        ) : connectModalStep === "deepseek" ? (
          <div className="space-y-3" data-testid="credentials-deepseek-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Text variant="bodyStrong" tone="secondary">
                  DeepSeek API key
                </Text>
                <ApiKeyHelpLink provider="deepseek" />
              </div>
              <Button
                onPress={() => void handleConnectApiKeyAndClose("deepseek")}
                isDisabled={
                  !canManageAiConnections || connectPending || apiKeyPendingProvider !== null || !deepseekApiKeyDraft.trim()
                }
                variant="outline"
                size="xs"
                radius="full"
                data-testid="credentials-deepseek-connect"
              >
                {apiKeyPendingProvider === "deepseek" ? "Connecting…" : "Connect & test"}
              </Button>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <Field label="API key" htmlFor="credentials-deepseek-api-key">
                <Input
                  id="credentials-deepseek-api-key"
                  value={deepseekApiKeyDraft}
                  onChange={(event) => onDeepseekApiKeyDraftChange(event.target.value)}
                  placeholder="Paste key"
                  size="sm"
                  radius="xl"
                  type={apiKeyInputType}
                  style={apiKeyInputStyle}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-bwignore="true"
                  data-1p-ignore="true"
                  data-testid="credentials-deepseek-api-key-input"
                  disabled={!canManageAiConnections || connectPending || apiKeyPendingProvider !== null}
                />
              </Field>
              <Field label="Label (optional)" htmlFor="credentials-deepseek-label">
                <Input
                  id="credentials-deepseek-label"
                  value={deepseekLabelDraft}
                  onChange={(event) => onDeepseekLabelDraftChange(event.target.value)}
                  placeholder="DeepSeek"
                  size="sm"
                  radius="xl"
                  autoComplete="off"
                  data-testid="credentials-deepseek-label-input"
                  disabled={!canManageAiConnections || connectPending || apiKeyPendingProvider !== null}
                />
              </Field>
            </div>

            <Text variant="caption" tone="muted" className="text-xs">
              Note: hosted runs may send prompt context (including file snippets) to DeepSeek.
            </Text>
          </div>
        ) : connectModalStep === "zai" ? (
          <div className="space-y-3" data-testid="credentials-zai-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Text variant="bodyStrong" tone="secondary">
                  z.ai API key
                </Text>
                <ApiKeyHelpLink provider="zai" />
              </div>
              <Button
                onPress={() => void handleConnectApiKeyAndClose("zai")}
                isDisabled={!canManageAiConnections || connectPending || apiKeyPendingProvider !== null || !zaiApiKeyDraft.trim()}
                variant="outline"
                size="xs"
                radius="full"
                data-testid="credentials-zai-connect"
              >
                {apiKeyPendingProvider === "zai" ? "Connecting…" : "Connect & test"}
              </Button>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <Field label="API key" htmlFor="credentials-zai-api-key">
                <Input
                  id="credentials-zai-api-key"
                  value={zaiApiKeyDraft}
                  onChange={(event) => onZaiApiKeyDraftChange(event.target.value)}
                  placeholder="Paste key"
                  size="sm"
                  radius="xl"
                  type={apiKeyInputType}
                  style={apiKeyInputStyle}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-bwignore="true"
                  data-1p-ignore="true"
                  data-testid="credentials-zai-api-key-input"
                  disabled={!canManageAiConnections || connectPending || apiKeyPendingProvider !== null}
                />
              </Field>
              <Field label="Label (optional)" htmlFor="credentials-zai-label">
                <Input
                  id="credentials-zai-label"
                  value={zaiLabelDraft}
                  onChange={(event) => onZaiLabelDraftChange(event.target.value)}
                  placeholder="z.ai"
                  size="sm"
                  radius="xl"
                  autoComplete="off"
                  data-testid="credentials-zai-label-input"
                  disabled={!canManageAiConnections || connectPending || apiKeyPendingProvider !== null}
                />
              </Field>
            </div>

            <Text variant="caption" tone="muted" className="text-xs">
              Note: hosted runs may send prompt context (including file snippets) to z.ai.
            </Text>
          </div>
        ) : connectModalStep === "gemini" ? (
          <div className="space-y-3" data-testid="credentials-gemini-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Text variant="bodyStrong" tone="secondary">
                Gemini API key
              </Text>
              <ApiKeyHelpLink provider="gemini" />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label="API key" htmlFor="credentials-gemini-api-key" className="flex-1">
                <Input
                  id="credentials-gemini-api-key"
                  value={geminiApiKeyDraft}
                  onChange={(event) => onGeminiApiKeyDraftChange(event.target.value)}
                  placeholder="Paste key"
                  size="sm"
                  radius="xl"
                  type={apiKeyInputType}
                  style={apiKeyInputStyle}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-bwignore="true"
                  data-1p-ignore="true"
                  data-testid="credentials-gemini-api-key-input"
                  disabled={
                    !canManageAiConnections ||
                    connectPending ||
                    apiKeyPendingProvider !== null
                  }
                  className="min-w-0"
                />
              </Field>
              <Button
                onPress={() => void handleConnectApiKeyAndClose("gemini")}
                isDisabled={
                  !canManageAiConnections ||
                  connectPending ||
                  apiKeyPendingProvider !== null ||
                  !geminiApiKeyDraft.trim()
                }
                variant="outline"
                size="sm"
                radius="full"
                data-testid="credentials-gemini-connect"
                className="self-start sm:self-auto"
              >
                {apiKeyPendingProvider === "gemini" ? "Connecting..." : "Connect"}
              </Button>
            </div>
          </div>
        ) : null}
      </StudioDialogBody>
    </StudioDialogModal>
  );
}
