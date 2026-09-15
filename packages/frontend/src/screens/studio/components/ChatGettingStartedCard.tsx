import { useEffect, useRef } from "react";
import { Github, Key, NavArrowLeft, Sparks } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { controllerClient } from "../../../sdk/instafy";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import { CHAT_BUBBLE_MAX_WIDTH } from "./chatBubbleWidth";
import { ConnectChipStrip } from "./ConnectChipStrip";
import type { SkillConnector } from "./connectors";
import type { GettingStartedAiViewState } from "./gettingStartedAiChoices";
import { ONBOARDING_PATHS, type OnboardingAction } from "./onboardingPlaybook";

const { deriveGithubImportTargetPath } = controllerClient.projects;

type GithubDeviceAuthSession = {
  sessionId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  status: "pending" | "completed" | "failed" | "cancelled";
  error?: string | null;
};

type ChatGettingStartedMode = "root" | "github";

interface ChatGettingStartedCardProps {
  mode: ChatGettingStartedMode;
  onSelectMode: (mode: ChatGettingStartedMode) => void;
  onSelectAction: (action: OnboardingAction) => void;
  // "Connect a tool" chips. A press only reports the skill; ChatPanel opens
  // the confirm stage of the Connect sheet. "More tools" opens its browse stage.
  onSelectConnector: (connector: SkillConnector) => void;
  onBrowseConnectors: () => void;
  installedSkillNames: ReadonlySet<string>;
  showConnectTools: boolean;
  managedAiOffer: {
    label: string;
    dailyPromptLimit: number;
    remainingPrompts: number | null;
  } | null;
  selectedAi: "managed" | "connected" | null;
  aiViewState: GettingStartedAiViewState;
  canChangeAiChoice: boolean;
  personalAiConnectionState: "missing" | "needs_default" | null;
  onStartWithManagedAi: () => void;
  onConnectOwnAi: () => void;
  onChangeAiChoice: () => void;
  githubRepoDraft: string;
  githubRefDraft: string;
  githubImportBusy: boolean;
  githubImportElapsedSeconds: number;
  githubImportError: string | null;
  githubDeviceAuthSession: GithubDeviceAuthSession | null;
  githubDeviceAuthError: string | null;
  onGithubRepoDraftChange: (value: string) => void;
  onGithubRefDraftChange: (value: string) => void;
  onBeginGithubDeviceAuth: () => void;
  onCancelGithubDeviceAuth: () => void;
  onImportGithub: () => void;
}

function ActionButton({
  action,
  onPress,
}: {
  action: OnboardingAction;
  onPress: () => void;
}) {
  const Icon = action.icon;
  return (
    <Button
      variant="outline"
      size="sm"
      radius="2xl"
      className="h-full items-start justify-start overflow-hidden px-3 py-2.5 text-left shadow-none sm:px-3.5 sm:py-3"
      onPress={onPress}
      data-testid={`onboarding-action-${action.id}`}
    >
      <span className="flex w-full items-start gap-2.5 sm:gap-3">
        <Icon
          className="mt-0.5 h-4.5 w-4.5 shrink-0 text-slate-600 dark:text-slate-300"
          aria-hidden={true}
        />
        <span className="min-w-0">
          <Text as="span" variant="bodyStrong" className="block text-left">
            {action.title}
          </Text>
          <Text as="span" variant="caption" className="mt-0.5 block text-left text-slate-600 sm:mt-1 dark:text-slate-300">
            {action.description}
          </Text>
        </span>
      </span>
    </Button>
  );
}

export function ChatGettingStartedCard({
  mode,
  onSelectMode,
  onSelectAction,
  onSelectConnector,
  onBrowseConnectors,
  installedSkillNames,
  showConnectTools,
  managedAiOffer,
  selectedAi,
  aiViewState,
  canChangeAiChoice,
  personalAiConnectionState,
  onStartWithManagedAi,
  onConnectOwnAi,
  onChangeAiChoice,
  githubRepoDraft,
  githubRefDraft,
  githubImportBusy,
  githubImportElapsedSeconds,
  githubImportError,
  githubDeviceAuthSession,
  githubDeviceAuthError,
  onGithubRepoDraftChange,
  onGithubRefDraftChange,
  onBeginGithubDeviceAuth,
  onCancelGithubDeviceAuth,
  onImportGithub,
}: ChatGettingStartedCardProps) {
  const codingActions = ONBOARDING_PATHS.find((entry) => entry.id === "coding")?.actions ?? [];
  const importGithubAction = codingActions.find((entry) => entry.id === "import-github-repo") ?? null;
  const startFromScratchAction = codingActions.find((entry) => entry.id === "start-from-scratch") ?? null;
  const managedAiAllowance = managedAiOffer
    ? managedAiOffer.dailyPromptLimit <= 0
      ? "No daily prompt cap."
      : managedAiOffer.remainingPrompts === 0
      ? `Today's free prompts are used (${managedAiOffer.dailyPromptLimit}/day).`
      : typeof managedAiOffer.remainingPrompts === "number"
        ? `${managedAiOffer.remainingPrompts} of ${managedAiOffer.dailyPromptLimit} free prompts left today.`
        : `${managedAiOffer.dailyPromptLimit} free prompts each day.`
    : null;
  const aiResolvingStepRef = useRef<HTMLDivElement | null>(null);
  const aiChoiceStepRef = useRef<HTMLDivElement | null>(null);
  const workspaceStepRef = useRef<HTMLDivElement | null>(null);
  const previousAiViewStateRef = useRef(aiViewState);
  const previousModeRef = useRef(mode);
  useEffect(() => {
    const returnedToRoot = previousModeRef.current === "github" && mode === "root";
    if (mode === "root") {
      if (aiViewState === "resolving" && returnedToRoot) {
        aiResolvingStepRef.current?.focus();
      } else if (
        aiViewState === "choice" &&
        (previousAiViewStateRef.current !== "choice" || returnedToRoot)
      ) {
        aiChoiceStepRef.current?.focus();
      } else if (
        aiViewState === "workspace" &&
        (previousAiViewStateRef.current !== "workspace" || returnedToRoot)
      ) {
        // Hand focus to the next/current decision instead of leaving it on a
        // control that was removed by the transition.
        workspaceStepRef.current?.focus();
      }
    }
    previousAiViewStateRef.current = aiViewState;
    previousModeRef.current = mode;
  }, [aiViewState, mode]);
  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="sm"
      className={`@container w-full ${CHAT_BUBBLE_MAX_WIDTH.card} px-3 py-3 sm:px-4`}
      data-testid="onboarding-getting-started"
    >
      {mode === "root" ? (
        <>
          {aiViewState === "resolving" ? (
            <div
              ref={aiResolvingStepRef}
              tabIndex={-1}
              aria-labelledby="onboarding-ai-resolving-heading"
              className="flex items-center gap-2.5 px-0.5 py-1.5 outline-none"
              data-testid="onboarding-ai-resolving"
            >
              <Spinner aria-hidden="true" tone="slate" size="sm" />
              <div>
                <Text
                  id="onboarding-ai-resolving-heading"
                  as="h3"
                  variant="bodyStrong"
                  tone="primary"
                >
                  Checking your AI setup…
                </Text>
                <Text as="p" variant="caption" tone="muted" className="mt-0.5">
                  Your workspace options will appear when this check finishes.
                </Text>
              </div>
            </div>
          ) : null}
          {aiViewState === "choice" ? (
            <div
              ref={aiChoiceStepRef}
              tabIndex={-1}
              aria-labelledby="onboarding-ai-choice-heading"
              className="px-0.5 pt-0.5 outline-none"
              data-testid="onboarding-ai-choice"
            >
              <Text
                id="onboarding-ai-choice-heading"
                as="h3"
                variant="bodyStrong"
                tone="primary"
              >
                {managedAiOffer || personalAiConnectionState === "needs_default"
                  ? "Choose your AI"
                  : "Connect your AI"}
              </Text>
              <Text as="p" variant="caption" tone="muted" className="mt-0.5">
                {personalAiConnectionState === "needs_default"
                  ? managedAiOffer
                    ? "Use free AI now, or choose which saved connection Instafy should use."
                    : "Choose which saved connection Instafy should use."
                  : managedAiOffer?.remainingPrompts === 0
                    ? "Today's free prompts are used. Bring your own AI to keep going, or come back tomorrow."
                    : managedAiOffer
                      ? "Start free now, or bring your own AI for the best results. Next: pick what to work on."
                      : "Connect the AI account you already use."}
              </Text>
              <div className={`mt-2 grid gap-2 ${managedAiOffer ? "@sm:grid-cols-2" : ""}`}>
                {managedAiOffer ? (
                  <Button
                    variant="primary"
                    size="sm"
                    radius="xl"
                    className="h-full items-start justify-start px-3 py-2.5 text-left"
                    onPress={onStartWithManagedAi}
                    isDisabled={managedAiOffer.remainingPrompts === 0}
                    data-testid="onboarding-use-managed-ai"
                  >
                    <span className="flex min-w-0 items-start gap-2.5">
                      <Sparks className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        <Text as="span" variant="caption" tone="inherit" className="block text-left font-medium">
                          Start free with {managedAiOffer.label}
                        </Text>
                        <Text as="span" variant="caption" tone="inherit" className="mt-0.5 block text-left opacity-90">
                          {managedAiAllowance}
                        </Text>
                      </span>
                    </span>
                  </Button>
                ) : null}
                <Button
                  variant={managedAiOffer ? "outline" : "primary"}
                  size="sm"
                  radius="xl"
                  className="h-full items-start justify-start px-3 py-2.5 text-left"
                  onPress={onConnectOwnAi}
                  data-testid={
                    personalAiConnectionState === "needs_default"
                      ? "onboarding-choose-connected-ai"
                      : "onboarding-connect-own-ai"
                  }
                >
                  <span className="flex min-w-0 items-start gap-2.5">
                    <Key className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">
                      <Text as="span" variant="caption" tone="inherit" className="block text-left font-medium">
                        {personalAiConnectionState === "needs_default"
                          ? "Choose connected AI"
                          : "Bring my own AI"}
                      </Text>
                      <Text as="span" variant="caption" tone="inherit" className="mt-0.5 block text-left opacity-80">
                        {personalAiConnectionState === "needs_default"
                          ? "Select which saved connection Instafy should use."
                          : "ChatGPT/Codex login or API keys for OpenAI, DeepSeek, z.ai, and Gemini."}
                      </Text>
                    </span>
                  </span>
                </Button>
              </div>
            </div>
          ) : null}
          {/* Step 2 appears once the AI choice is settled: one decision at a time. */}
          {aiViewState === "workspace" ? (
            <div
              ref={workspaceStepRef}
              tabIndex={-1}
              aria-labelledby="onboarding-workspace-heading"
              className="px-0.5 pt-0.5 outline-none"
              data-testid="onboarding-workspace-step"
            >
              {selectedAi ? (
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <Text as="span" variant="caption" tone="muted">
                    Using{" "}
                    {selectedAi === "managed"
                      ? `free ${managedAiOffer?.label ?? "Instafy AI"}`
                      : "your connected AI"}
                  </Text>
                  {canChangeAiChoice ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      radius="full"
                      className="px-1.5 underline-offset-2 hover:underline"
                      onPress={onChangeAiChoice}
                      data-testid="onboarding-change-ai"
                    >
                      {/* Tone on a span: a text colour on the Button loses to the
                          ghost variant's text-slate-700 (no tailwind-merge). */}
                      <span className="text-slate-500 dark:text-slate-400">Change AI</span>
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <Text
                id="onboarding-workspace-heading"
                as="h3"
                variant="bodyStrong"
                tone="primary"
              >
                What should your agent work on?
              </Text>
              <div className="mt-2 grid gap-2 @sm:grid-cols-2">
                {importGithubAction ? (
                  <ActionButton
                    action={importGithubAction}
                    onPress={() => onSelectAction(importGithubAction)}
                  />
                ) : null}
                {startFromScratchAction ? (
                  <ActionButton
                    action={startFromScratchAction}
                    onPress={() => onSelectAction(startFromScratchAction)}
                  />
                ) : null}
              </div>
              {showConnectTools ? (
                <>
                  <div
                    className="mt-3 border-t border-slate-200/70 pt-3 dark:border-[color:var(--color-studio-dark-panel-border)]"
                    data-testid="onboarding-connect-strip"
                  >
                    <Text as="p" id="onboarding-connect-label" variant="caption" tone="muted">
                      Connect a tool
                    </Text>
                    <ConnectChipStrip
                      className="mt-1.5"
                      aria-labelledby="onboarding-connect-label"
                      installedSkillNames={installedSkillNames}
                      onSelect={onSelectConnector}
                      onMoreTools={onBrowseConnectors}
                    />
                  </div>
                  <Text
                    as="p"
                    variant="caption"
                    tone="subtle"
                    className="mt-2.5"
                    data-testid="onboarding-type-hint"
                  >
                    Or just type below.
                  </Text>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {mode === "github" ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Button
                variant="ghost"
                size="sm"
                radius="full"
                onPress={() => onSelectMode("root")}
                className="gap-1 px-2 text-slate-600 dark:text-slate-300"
                data-testid="onboarding-back-button"
              >
                <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
              <Text as="h3" variant="bodyStrong" tone="primary" className="mt-2">
                Import a GitHub repo
              </Text>
              <Text as="p" variant="caption" tone="muted" className="mt-1">
                Paste a repo URL or <code className="rounded bg-slate-100 px-1 py-0.5 text-xxs dark:bg-slate-800">owner/repo</code>.
                Files will land under{" "}
                <code className="break-all rounded bg-slate-100 px-1 py-0.5 text-xxs dark:bg-slate-800">
                  {deriveGithubImportTargetPath(githubRepoDraft || "owner/repo")}
                </code>
                .
              </Text>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            <Input
              value={githubRepoDraft}
              onChange={(event) => onGithubRepoDraftChange(event.target.value)}
              placeholder="https://github.com/owner/repo or owner/repo"
              size="sm"
              radius="xl"
              disabled={githubImportBusy}
              aria-label="GitHub repository"
              data-testid="onboarding-github-repo-input"
            />
            <Input
              value={githubRefDraft}
              onChange={(event) => onGithubRefDraftChange(event.target.value)}
              placeholder="ref (optional): main, a tag, or a commit SHA"
              size="sm"
              radius="xl"
              disabled={githubImportBusy}
              aria-label="GitHub ref (optional)"
              data-testid="onboarding-github-ref-input"
            />
            <Text as="p" variant="caption" tone="muted" className="text-xs">
              Public repos import without login. For a private repo, use Connect GitHub: you
              approve a short code on GitHub. No password is entered here.
            </Text>
            {githubDeviceAuthError ? (
              <Text as="p" variant="caption" tone="inherit" className="text-xs text-rose-600 dark:text-rose-300">
                {githubDeviceAuthError}
              </Text>
            ) : null}
            {githubDeviceAuthSession ? (
              <div className="rounded-2xl border border-slate-200/70 bg-slate-50/50 px-3 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/20 dark:text-slate-300">
                <div className="font-semibold text-slate-700 dark:text-slate-100">GitHub device login</div>
                {githubDeviceAuthSession.status === "completed" ? (
                  <Text as="div" variant="caption" tone="muted" className="mt-1 text-xs">
                    Connected. Imports will use the GitHub account you approved.
                  </Text>
                ) : (
                  <>
                    <Text as="div" variant="caption" tone="muted" className="mt-1 text-xs">
                      Open the login page and enter this code:
                    </Text>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <code className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold tracking-wide text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                        {githubDeviceAuthSession.userCode}
                      </code>
                      <Button
                        onPress={() => {
                          try {
                            void navigator.clipboard?.writeText(githubDeviceAuthSession.userCode);
                          } catch {
                            // ignore clipboard failures
                          }
                        }}
                        variant="ghost"
                        size="xs"
                        radius="full"
                        isDisabled={githubImportBusy}
                      >
                        Copy code
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <Button
                        onPress={() => void openExternalUrl(githubDeviceAuthSession.verificationUrl)}
                        variant="primary"
                        size="xs"
                        radius="full"
                        fullWidth
                        isDisabled={githubImportBusy}
                        className="justify-start sm:w-auto sm:flex-1"
                      >
                        Open login
                      </Button>
                      <Button
                        onPress={onCancelGithubDeviceAuth}
                        variant="outline"
                        size="xs"
                        radius="full"
                        fullWidth
                        isDisabled={githubImportBusy}
                        className="justify-start sm:w-auto sm:flex-1"
                      >
                        Cancel login
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {!githubDeviceAuthSession || githubDeviceAuthSession.status !== "completed" ? (
                <Button
                  variant="outline"
                  size="xs"
                  radius="full"
                  onPress={onBeginGithubDeviceAuth}
                  isDisabled={githubImportBusy}
                  className="gap-2"
                  data-testid="onboarding-github-connect-button"
                >
                  <Github className="h-3.5 w-3.5" aria-hidden="true" />
                  Connect GitHub
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="xs"
                radius="full"
                onPress={onImportGithub}
                isDisabled={githubImportBusy}
                data-testid="onboarding-github-import-button"
              >
                {githubImportBusy ? (
                  <>
                    <Spinner aria-hidden="true" tone="primary" size="xs" />
                    Importing… {githubImportElapsedSeconds}s
                  </>
                ) : (
                  "Import files"
                )}
              </Button>
            </div>
            {githubImportError ? (
              <Text as="p" variant="caption" tone="inherit" className="text-xs text-rose-600 dark:text-rose-300">
                {githubImportError}
              </Text>
            ) : null}
          </div>
        </>
      ) : null}
    </Surface>
  );
}
