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
import { InlineNotice } from "../../../components/InlineNotice";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import {
  StudioDialogBody,
  StudioDialogFooter,
  StudioDialogHeader,
} from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { MobileFocusDialog } from "../../../components/aria/MobileFocusDialog";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import type { DeviceAuthProvider } from "../../../sdk/instafy";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import { CredentialsConnectionChoices, getCodexConnectionChoice } from "./CredentialsConnectionChoices";
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
    <Text
      as="a"
      variant="captionStrong"
      tone="accent"
      href={API_KEY_CONSOLE_URL[provider]}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(event.currentTarget.href);
      }}
      className="underline-offset-2 hover:underline"
    >
      Get a key ↗
    </Text>
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
  canDevSeedCodex: boolean;
  onDevSeedCodex: () => void;
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
  canDevSeedCodex,
  onDevSeedCodex,
  onBeginDeviceAuth,
  onCancelDeviceAuthSession,
  onTriggerUpload,
  onUploadFile,
  onConnectApiKey,
}: CredentialsConnectModalProps) {
  const isDesktop = useBreakpoint("sm", { freeze: connectModalOpen });
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
  const { title: codexChoiceTitle } = getCodexConnectionChoice({
    canUseDesktopConnect,
    desktopCodexAuthJsonStatus,
  });

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
    if (modalBusy || !canManageAiConnections) return;
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

  const body = (
    <StudioDialogBody scrollable={isDesktop} className="space-y-3">
      {connectModalStep === "picker" ? (
        <div className="space-y-2">
          <CredentialsConnectionChoices
            canUseDesktopConnect={canUseDesktopConnect}
            desktopCodexAuthJsonStatus={desktopCodexAuthJsonStatus}
            isDisabled={!canManageAiConnections}
            onChoose={onStepChange}
          />

          {!canManageAiConnections ? (
            <Text variant="caption" tone="muted" className="mt-2">
              Sign in and configure the runtime controller to add connections.
            </Text>
          ) : null}
        </div>
      ) : connectModalStep === "codex" ? (
        <div className="space-y-3" data-testid="credentials-codex-card">
          {deviceAuthError ? (
            <InlineNotice tone="danger" role="alert">
              {deviceAuthError}
            </InlineNotice>
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
            <Surface tone="muted" radius="xl" shadow="none" className="p-3">
              <Text variant="bodyStrong">Device login</Text>
              <Text variant="caption" tone="muted" className="mt-1">Open the OpenAI login page and enter this one-time code:</Text>
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
                <Text variant="caption" tone="danger" className="mt-2" role="alert">
                  Copy was blocked. Press and hold the code to copy it manually.
                </Text>
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
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {codexDeviceAuthSession.status === "pending" ? (
                  <>
                    <LoadingStatus size="xs">
                      {deviceAuthCompleting
                        ? "Login complete — checking the connection…"
                        : "Waiting for login…"}
                    </LoadingStatus>
                    {!deviceAuthCompleting && deviceCodeExpiresIn ? (
                      <Text as="span" variant="caption" tone="muted">Code expires in {deviceCodeExpiresIn}</Text>
                    ) : null}
                  </>
                ) : codexDeviceAuthSession.status === "failed" ? (
                  <Text variant="caption" tone="danger" role="alert">
                    {codexDeviceAuthSession.error ?? "Device login failed."}
                  </Text>
                ) : null}
              </div>
              <Text variant="caption" tone="muted" className="mt-2">
                Only enter this code at <Text as="span" variant="captionStrong" tone="inherit">{deviceLoginHost}</Text>. Instafy will
                never ask you to paste your ChatGPT password here.
              </Text>
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
            </Surface>
          ) : canUseDesktopConnect ? (
            <Surface tone="muted" radius="xl" shadow="none" className="p-3">
              {desktopCodexAuthJsonStatus?.exists ? (
                <>
                  <Text variant="bodyStrong">
                    Desktop found your local Codex login.
                  </Text>
                  <Text variant="mono" tone="muted" className="mt-1">~/.codex/auth.json</Text>
                  <Text variant="caption" tone="muted" className="mt-1">
                    Click once to import it into your Instafy AI connections.
                  </Text>
                </>
              ) : shouldPromptForAuthJsonUpload ? (
                <>
                  <Text variant="bodyStrong">
                    No default Codex login found.
                  </Text>
                  <Text variant="caption" tone="muted" className="mt-1">
                    Desktop only checks ~/.codex/auth.json. If Codex uses your system keychain or
                    a custom CODEX_HOME, use browser login instead.
                  </Text>
                </>
              ) : (
                <>
                  <Text variant="bodyStrong">
                    Use your local Codex login.
                  </Text>
                  <Text variant="caption" tone="muted" className="mt-1">
                    Desktop will import ~/.codex/auth.json when you continue.
                  </Text>
                </>
              )}
            </Surface>
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
            canDevSeed={canDevSeedCodex}
            busy={modalBusy}
            onDevSeed={onDevSeedCodex}
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

          <Text variant="caption" tone="muted">
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

          <Text variant="caption" tone="muted">
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

          <Text variant="caption" tone="muted">
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
          </div>
        </div>
      ) : null}
    </StudioDialogBody>
  );

  const apiKeyDrafts = {
    openai: openaiApiKeyDraft,
    deepseek: deepseekApiKeyDraft,
    zai: zaiApiKeyDraft,
    gemini: geminiApiKeyDraft,
  };
  const apiKeyProvider = connectModalStep === "picker" || connectModalStep === "codex"
    ? null
    : connectModalStep;
  const footer = apiKeyProvider ? (
    <StudioDialogFooter padding="default" divider className="flex justify-end">
      <Button
        onPress={() => void handleConnectApiKeyAndClose(apiKeyProvider)}
        isPending={apiKeyPendingProvider === apiKeyProvider}
        isDisabled={
          !canManageAiConnections ||
          connectPending || deviceAuthBusy || deviceAuthCompleting ||
          (apiKeyPendingProvider !== null && apiKeyPendingProvider !== apiKeyProvider) ||
          !apiKeyDrafts[apiKeyProvider].trim()
        }
        variant="primary"
        elevation="none"
        size="md"
        radius="xl"
        data-testid={`credentials-${apiKeyProvider}-connect`}
      >
        {apiKeyProvider === "gemini" ? "Connect" : "Connect & test"}
      </Button>
    </StudioDialogFooter>
  ) : null;

  if (!isDesktop) {
    return (
      <MobileFocusDialog
        isOpen={connectModalOpen}
        onOpenChange={(open) => { if (!open) handleNativeBack(); }}
        closeDisabled={modalBusy}
        dismissLabel={connectModalStep === "picker" ? "Close" : "Back"}
        dialogAriaLabel="Add AI connection"
        gutter="responsive"
        footer={footer}
        data-testid="credentials-connect-modal"
        header={<>
          <Text as="h2" variant="subtitle" tone="primary">Add AI connection</Text>
          <Text variant="caption" tone="muted">Saved to your profile for hosted runs.</Text>
        </>}
      >
        {body}
      </MobileFocusDialog>
    );
  }

  return (
    <StudioDialogModal
      isOpen={connectModalOpen}
      onNativeBack={handleNativeBack}
      onOpenChange={(open) => {
        if (!open && !modalBusy) {
          onClose();
        }
      }}
      isDismissable={!modalBusy}
      isKeyboardDismissDisabled={modalBusy}
      dialogAriaLabel="Add AI connection"
      data-testid="credentials-connect-modal"
      layout="editor"
      gutter="responsive"
    >
      <StudioDialogHeader
        title="Add AI connection"
        description="Saved to your profile for hosted runs."
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

      {body}
      {footer}
    </StudioDialogModal>
  );
}
