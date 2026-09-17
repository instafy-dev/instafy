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
import {
  CARD_READ_ONLY_TOOL_CONNECTORS,
  CARD_TOOL_CONNECTORS,
  type ProductConnector,
  type SkillConnector,
} from "./connectors";
import type {
  GettingStartedAiViewState,
  GettingStartedManagedAiOffer,
} from "./gettingStartedAiChoices";

// The collapsed row names at most this many tools before "More tools", so it
// holds one line at 390 px: "Import a repo · Notion · More tools" is narrower
// than the three labels it replaces.
const COLLAPSED_ROW_TOOL_LIMIT = 2;

// The collapsed row keeps the verb for the repo import, which is the one
// place a bare "GitHub" would lose it.
function collapsedToolLabel(connector: ProductConnector): string {
  return connector.kind === "github" ? "Import a repo" : connector.name;
}

function collapsedToolTestId(connector: ProductConnector): string {
  return connector.kind === "github"
    ? "onboarding-collapsed-import-github-repo"
    : `onboarding-collapsed-${connector.id}`;
}

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
  // While a draft is in the composer the card collapses to one row of the
  // same tools in text form (no heading, no AI line) instead of unmounting,
  // so the options stay reachable; the full card returns when the draft clears.
  collapsed?: boolean;
  onSelectMode: (mode: ChatGettingStartedMode) => void;
  // A skill chip press only reports the skill; ChatPanel opens the confirm
  // stage of the Connect sheet. "More tools" opens its browse stage. The
  // GitHub chip never comes through here: see handleSelectTool.
  onSelectConnector: (connector: SkillConnector) => void;
  onBrowseConnectors: () => void;
  installedSkillNames: ReadonlySet<string>;
  /**
   * False for a member without write access. It drops every control whose
   * press ends in a line being sent into the conversation: the skill chips
   * and "More tools". The repo import sends nothing, so it stays.
   */
  showConnectTools: boolean;
  managedAiOffer: GettingStartedManagedAiOffer | null;
  selectedAi: "managed" | "connected" | null;
  /** Label of the saved connection in use, once hydrated; null until then. */
  connectedAiLabel: string | null;
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

function formatCreditsEach(amount: number): string {
  return amount === 1 ? "1 credit each" : `${amount} credits each`;
}

// The collapsed row's buttons: text-only ghost pills at caption size, 44 px on
// coarse pointers through the Button size.
function CollapsedActionButton({
  label,
  onPress,
  testId,
}: {
  label: string;
  onPress: () => void;
  testId: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      radius="full"
      className="px-1 underline-offset-2 hover:underline"
      onPress={onPress}
      data-testid={testId}
    >
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
    </Button>
  );
}

export function ChatGettingStartedCard({
  mode,
  collapsed = false,
  onSelectMode,
  onSelectConnector,
  onBrowseConnectors,
  installedSkillNames,
  showConnectTools,
  managedAiOffer,
  selectedAi,
  connectedAiLabel,
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
  // The row a member can actually press: every featured tool that can be
  // picked today, or just the repo import when they cannot write here.
  const cardTools = showConnectTools ? CARD_TOOL_CONNECTORS : CARD_READ_ONLY_TOOL_CONNECTORS;
  // GitHub goes through onSelectMode, never through the host's connector
  // routing: that path calls beginGithubImport, which un-dismisses the card
  // and sets a flag overriding every later show gate. From the card the press
  // only switches to the import form, exactly as its own button always did.
  const handleSelectTool = (connector: ProductConnector) => {
    if (connector.kind === "github") {
      onSelectMode("github");
      return;
    }
    onSelectConnector(connector);
  };
  // A paused tier keeps the choice framing but offers no free button: the one
  // primary action is Connect AI, and the line says why.
  const managedAiPaused = managedAiOffer?.paused === true;
  const managedAiChoice = managedAiOffer && !managedAiPaused ? managedAiOffer : null;
  const managedAiAllowance = managedAiChoice
    ? managedAiChoice.dailyPromptLimit <= 0
      ? "No daily prompt cap."
      : managedAiChoice.remainingPrompts === 0
      ? `Today's free prompts are used (${managedAiChoice.dailyPromptLimit}/day).`
      : typeof managedAiChoice.remainingPrompts === "number"
        ? `${managedAiChoice.remainingPrompts} of ${managedAiChoice.dailyPromptLimit} free prompts left today.`
        : `${managedAiChoice.dailyPromptLimit} free prompts each day.`
    : null;
  const managedAiLabel = managedAiOffer?.label ?? "Instafy AI";
  const aiChoiceHeading =
    managedAiOffer || personalAiConnectionState === "needs_default" ? "Choose your AI" : "Connect AI";
  const aiChoiceLine =
    personalAiConnectionState === "needs_default"
      ? managedAiChoice
        ? "Use free AI now, or choose which saved connection Instafy should use."
        : "Choose which saved connection Instafy should use."
      : managedAiPaused
        ? `Free ${managedAiLabel} is paused right now. Connect your own AI to start; you pay your provider directly and Instafy adds nothing.`
        : managedAiChoice?.remainingPrompts === 0
          ? "Today's free prompts are used. Connect your own AI to keep going, or come back tomorrow."
          : managedAiChoice
            // Names what the next step actually offers, so the forward
            // reference stays true when that step is a row of tools.
            ? "Start free now, or connect your own AI for the best results. Next: pick a tool, or just type."
            : "Connect the AI account you already use.";
  // The status line names what will answer, at the point of decision.
  const aiStatusLine =
    selectedAi === "managed"
      ? `Using free ${managedAiLabel}: ${
          managedAiOffer && managedAiOffer.dailyPromptLimit > 0
            ? `${managedAiOffer.dailyPromptLimit} prompts a day`
            : "no daily cap"
        }, ${formatCreditsEach(managedAiOffer?.creditBurnAmount ?? 1)}`
      : selectedAi === "connected"
        ? connectedAiLabel
          ? `Using ${connectedAiLabel}`
          : "Using your connected AI"
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
      className={`@container w-full ${CHAT_BUBBLE_MAX_WIDTH.card} ${
        mode === "root" && collapsed ? "px-2 py-1.5 sm:px-2.5" : "px-3 py-3 sm:px-4"
      }`}
      data-testid="onboarding-getting-started"
      data-collapsed={mode === "root" && collapsed ? "true" : undefined}
    >
      {mode === "root" && collapsed ? (
        <ul
          className="flex flex-wrap items-center gap-x-1 gap-y-0.5"
          aria-label="Workspace options"
          data-testid="onboarding-collapsed-row"
        >
          {/* The same tools as the full row, in the same order, in text form.
              The repo import keeps its verb; the rest are named. */}
          {cardTools.slice(0, COLLAPSED_ROW_TOOL_LIMIT).map((connector, index) => (
            <li key={connector.id} className={index === 0 ? undefined : "flex items-center gap-x-1"}>
              {index === 0 ? null : (
                <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
              )}
              <CollapsedActionButton
                label={collapsedToolLabel(connector)}
                onPress={() => handleSelectTool(connector)}
                testId={collapsedToolTestId(connector)}
              />
            </li>
          ))}
          {showConnectTools ? (
            <li className="flex items-center gap-x-1">
              <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
              <CollapsedActionButton
                label="More tools"
                onPress={onBrowseConnectors}
                testId="onboarding-collapsed-more-tools"
              />
            </li>
          ) : null}
        </ul>
      ) : null}
      {mode === "root" && !collapsed ? (
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
                {aiChoiceHeading}
              </Text>
              <Text as="p" variant="caption" tone="muted" className="mt-0.5" data-testid="onboarding-ai-choice-line">
                {aiChoiceLine}
              </Text>
              <div className={`mt-2 grid gap-2 ${managedAiChoice ? "@sm:grid-cols-2" : ""}`}>
                {managedAiChoice ? (
                  <Button
                    variant="primary"
                    size="sm"
                    radius="xl"
                    className="h-full items-start justify-start px-3 py-2.5 text-left"
                    onPress={onStartWithManagedAi}
                    isDisabled={managedAiChoice.remainingPrompts === 0}
                    data-testid="onboarding-use-managed-ai"
                  >
                    <span className="flex min-w-0 items-start gap-2.5">
                      <Sparks className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        <Text as="span" variant="caption" tone="inherit" className="block text-left font-medium">
                          Start free with {managedAiChoice.label}
                        </Text>
                        <Text as="span" variant="caption" tone="inherit" className="mt-0.5 block text-left opacity-90">
                          {managedAiAllowance}
                        </Text>
                      </span>
                    </span>
                  </Button>
                ) : null}
                <Button
                  variant={managedAiChoice ? "outline" : "primary"}
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
                          : "Connect AI"}
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
              {aiStatusLine ? (
                <Text
                  as="p"
                  variant="caption"
                  tone="muted"
                  className="mb-1.5 flex flex-wrap items-center gap-x-1"
                  data-testid="onboarding-ai-status"
                >
                  <span>{aiStatusLine}</span>
                  {canChangeAiChoice ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <Button
                        variant="ghost"
                        size="xs"
                        radius="full"
                        className="px-1 underline-offset-2 hover:underline"
                        onPress={onChangeAiChoice}
                        data-testid="onboarding-change-ai"
                      >
                        {/* Tone on a span: a text colour on the Button loses to the
                            ghost variant's text-slate-700 (no tailwind-merge). */}
                        <span className="text-slate-500 dark:text-slate-400">Change AI</span>
                      </Button>
                    </>
                  ) : null}
                </Text>
              ) : null}
              {/* One heading, one row, one line. The heading does the work the
                  separate "Connect a tool" caption used to do, so the card
                  keeps exactly one heading and no hairline inside the step. */}
              <Text
                id="onboarding-workspace-heading"
                as="h3"
                variant="bodyStrong"
                tone="primary"
              >
                Start with a tool you already use
              </Text>
              <ConnectChipStrip
                className="mt-2"
                aria-labelledby="onboarding-workspace-heading"
                connectors={cardTools}
                showMoreTools={showConnectTools}
                installedSkillNames={installedSkillNames}
                onSelect={handleSelectTool}
                onMoreTools={onBrowseConnectors}
              />
              {/* Ungated: the member with the least to press is the one who
                  most needs the sentence telling them to type. */}
              <Text
                as="p"
                variant="caption"
                tone="subtle"
                className="mt-2.5"
                data-testid="onboarding-type-hint"
              >
                Or just type what you want below.
              </Text>
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
