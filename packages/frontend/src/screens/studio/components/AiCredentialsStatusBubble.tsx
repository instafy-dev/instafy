import { useCallback, useMemo } from "react";
import { WarningTriangle, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import { formatCredentialOptionLabel, resolveCredentialLabel } from "../../../utils/credentialFormatting";
import { AccessDecisionCard } from "./AccessDecisionCard";
import { CHAT_BUBBLE_MAX_WIDTH } from "./chatBubbleWidth";
import { ChatActivityBubble } from "./ChatActivityBubble";
import { describeManagedAiNextAvailable, isManagedAiAllowanceUsedUp } from "./managedAiAllowance";

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
  onRetry?: () => void;
  intent?: AiCredentialsWizardIntent;
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
    nextAvailableAt?: string | null;
  } | null;
  onSetDefaultCredential?: (credentialId: string) => void;
  onUseManagedAi?: () => void | Promise<void>;
  onChatWithoutAi?: () => void;
  /**
   * Opens the Add AI connection modal, which carries the provider list. The
   * bubble itself never picks a provider: the gate is one sentence and one
   * button, and the proactive connect prompt hands off to the same modal.
   */
  onConnectAi?: () => void;
  /**
   * Gate only: the space has more than one member, so "turn the assistant
   * off" is a real option. Alone in a space there is nobody else to chat with.
   */
  hasTeammates?: boolean;
  onClose?: () => void;
}

// Instafy AI is paid for with credits, so the offer never calls it free.
function formatManagedAiOfferLabel(managedAi: { label: string; dailyPromptLimit: number }): string {
  return managedAi.dailyPromptLimit > 0
    ? `Use ${managedAi.label} (${managedAi.dailyPromptLimit} a day)`
    : `Use ${managedAi.label}`;
}

export function AiCredentialsStatusBubble({
  state,
  detail,
  isBusy,
  onRetry,
  intent = "gate",
  connectedCredentials = [],
  defaultCredentialId = null,
  managedAi = null,
  onSetDefaultCredential,
  onUseManagedAi,
  onChatWithoutAi,
  onConnectAi,
  hasTeammates = false,
  onClose,
}: AiCredentialsStatusBubbleProps) {
  const effectiveState: AiCredentialsGateState =
    state === "needs_default" && connectedCredentials.length === 0 ? "missing" : state;
  const showUnavailableState = effectiveState === "unavailable";
  // The bubble never hosts a provider list: picking lives in the Add AI
  // connection modal. The blocking gate and the proactive connect prompt are
  // one sentence and one button that hands off to it.
  const showReducedGate = effectiveState === "missing";
  const showConnectWizard = !showUnavailableState && intent === "connect";
  // The gate is up only because today's hosted AI messages are used up, not
  // because AI was never set up: say so, and when more are available.
  const managedAiUsedUp =
    intent === "gate" && effectiveState === "missing" && isManagedAiAllowanceUsedUp(managedAi);

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
        return managedAiUsedUp && managedAi
          ? `You've used today's ${managedAi.label} messages. Your message is kept.`
          : "Connect AI to send this. Your message is kept.";
    }
  }, [
    connectedCredentials.length,
    effectiveState,
    intent,
    managedAi,
    managedAiUsedUp,
  ]);

  const resolvedDetail = useMemo(() => {
    if (detail !== undefined) {
      return detail;
    }
    switch (effectiveState) {
      case "needs_default":
        // effectiveState normalizes the zero-credential case to "missing", so
        // this branch always has credentials to choose from.
        return "Choose one below. You can change it anytime.";
      case "unavailable":
        return "Retry in a moment. Your AI credentials may still be fine.";
      case "error":
        // The Retry button beside this is real; there is no link to AI Manager
        // from here, so the sentence no longer sends the reader looking for one.
        return "Try again. Your AI connections are unchanged.";
      default:
        // Checking shows only its title, and a missing connection shows the
        // gate, which says what to do in its title and button.
        return null;
    }
  }, [detail, effectiveState]);

  const handleClose = useCallback(() => {
    if (!isBusy) {
      onClose?.();
    }
  }, [isBusy, onClose]);
  useNativeBackButtonAction(intent === "connect" && Boolean(onClose), handleClose);

  const defaultCredential = useMemo(() => {
    if (!defaultCredentialId) {
      return null;
    }
    return connectedCredentials.find((credential) => credential.id === defaultCredentialId) ?? null;
  }, [connectedCredentials, defaultCredentialId]);

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
        className={`${CHAT_BUBBLE_MAX_WIDTH.status} px-3 py-2.5 text-sm`}
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

  if (showReducedGate) {
    const managedAiOffered = Boolean(
      managedAi?.enabled && managedAi.available && onUseManagedAi && connectedCredentials.length === 0,
    );
    return (
      <Surface
        tone="default"
        radius="2xl"
        shadow="sm"
        className={`w-full ${CHAT_BUBBLE_MAX_WIDTH.card} px-3 py-3 leading-snug text-slate-600 sm:px-4 dark:text-slate-200`}
        aria-live="polite"
        data-testid="credentials-status-indicator"
      >
        <div className="flex items-start justify-between gap-3">
          <Text as="p" variant="bodyStrong" tone="primary" className="min-w-0">
            {title}
          </Text>
          {intent === "connect" && onClose ? (
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="Close AI connect"
              onPress={handleClose}
              isDisabled={isBusy}
              className="-mt-1 -mr-1 shrink-0 text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200"
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
        {intent === "connect" && defaultCredential ? (
          <Text as="p" variant="caption" tone="muted" className="mt-1 text-xs">
            Currently using: {resolveCredentialLabel(defaultCredential)}
          </Text>
        ) : null}
        {managedAiUsedUp ? (
          <Text
            as="p"
            variant="caption"
            tone="muted"
            className="mt-1 text-xs"
            data-testid="ai-gate-managed-ai-used-up"
          >
            {describeManagedAiNextAvailable(managedAi?.nextAvailableAt)} Connect your own AI to send it
            now.
          </Text>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            radius="full"
            onPress={() => onConnectAi?.()}
            isDisabled={isBusy}
            data-testid="ai-gate-connect-ai"
          >
            {managedAiUsedUp ? "Connect your own AI" : "Connect AI"}
          </Button>
          {managedAiOffered && managedAi ? (
            <Button
              variant="outline"
              size="sm"
              radius="full"
              onPress={() => {
                void onUseManagedAi?.();
              }}
              isDisabled={isBusy || managedAi.remainingPrompts === 0}
              data-testid="ai-gate-use-managed-ai"
            >
              {formatManagedAiOfferLabel(managedAi)}
            </Button>
          ) : null}
        </div>
        {intent === "gate" && hasTeammates && onChatWithoutAi ? (
          <Button
            onPress={() => {
              if (!isBusy) {
                onChatWithoutAi();
              }
            }}
            variant="ghost"
            size="xs"
            radius="full"
            isDisabled={isBusy}
            className="mt-2 -ml-1.5 px-1.5 text-left text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
            data-testid="ai-gate-chat-without-ai"
          >
            Just chatting with teammates? Turn the assistant off.
          </Button>
        ) : null}
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
        {intent === "connect" && onClose ? (
          <IconButton
            variant="ghost"
            size="sm"
            radius="full"
            aria-label="Close AI connect"
            onPress={handleClose}
            isDisabled={isBusy}
            className="text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200"
          >
            <Xmark className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
      {resolvedDetail ? (
        <Text as="div" variant="bodyRoomy" tone="muted" className="mt-2">
          {resolvedDetail}
        </Text>
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

      {showConnectWizard && onConnectAi ? (
        <div className="mt-3">
          <Button
            onPress={onConnectAi}
            variant="outline"
            size="xs"
            radius="full"
            isDisabled={isBusy}
            data-testid="ai-connect-add-connection"
          >
            Connect AI
          </Button>
        </div>
      ) : null}
    </AccessDecisionCard>
  );
}
