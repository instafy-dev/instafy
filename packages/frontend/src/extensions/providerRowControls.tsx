import { CheckCircle, MinusCircle, WarningTriangle, XmarkCircle } from "iconoir-react";
import { IconButton, type ButtonProps } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { textTones } from "../styles/typography";
import { SEMANTIC_TONE_CLASSES } from "../theme/semanticTones";
import type { ExtensionStatusTone } from "./providerStatusPresentation";

// A status word and its icon take the shared semantic tones, measured in both
// themes by theme/__tests__/semanticTones.test.ts; idle and loading words take
// the muted grey. On the white list the 500 steps they replace read 1.9 to
// 3.8:1 and the idle slate-400 2.2:1.
function providerStatusToneClassName(tone: ExtensionStatusTone) {
  if (tone === "ready") {
    return SEMANTIC_TONE_CLASSES.success.text;
  }
  if (tone === "attention") {
    return SEMANTIC_TONE_CLASSES.warning.text;
  }
  if (tone === "error") {
    return SEMANTIC_TONE_CLASSES.danger.text;
  }
  return textTones.muted;
}

function ProviderStatusIcon({ tone }: { tone: ExtensionStatusTone }) {
  if (tone === "loading") {
    return <Spinner aria-hidden="true" tone="slate" size="xs" />;
  }
  if (tone === "ready") {
    return <CheckCircle className={`h-4 w-4 ${SEMANTIC_TONE_CLASSES.success.icon}`} aria-hidden="true" />;
  }
  if (tone === "attention") {
    return (
      <WarningTriangle className={`h-4 w-4 ${SEMANTIC_TONE_CLASSES.warning.icon}`} aria-hidden="true" />
    );
  }
  if (tone === "error") {
    return <XmarkCircle className={`h-4 w-4 ${SEMANTIC_TONE_CLASSES.danger.icon}`} aria-hidden="true" />;
  }
  return <MinusCircle className={`h-4 w-4 ${textTones.muted}`} aria-hidden="true" />;
}

export function ProviderStatusIndicator({
  providerId,
  label,
  tone = "idle",
}: {
  providerId: string;
  label: string;
  tone?: ExtensionStatusTone;
}) {
  return (
    <span
      className="inline-flex min-h-6 items-center justify-end gap-1.5"
      data-testid={`project-provider-status-${providerId}`}
      data-state={tone}
      aria-label={label}
      title={label}
    >
      <span className={["truncate text-xs font-medium", providerStatusToneClassName(tone)].join(" ")}>
        {label}
      </span>
      <ProviderStatusIcon tone={tone} />
    </span>
  );
}

export function formatProviderCollapseLabel(actionLabel: string | undefined, title: string) {
  return (actionLabel ?? `Collapse ${title}`).replace(/^Close\b/i, "Collapse");
}

export function ProviderDisclosureButton({
  ariaLabel,
  testId,
  onPress,
}: {
  ariaLabel: string;
  testId?: string;
  onPress?: ButtonProps["onPress"];
}) {
  return (
    <IconButton
      variant="ghost"
      size="xs"
      radius="full"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-testid={testId}
      onPress={onPress}
      className="shrink-0 border border-slate-200/70 bg-white/70 text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700/80 dark:bg-slate-900/70 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-100"
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 10l4-4 4 4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      </svg>
    </IconButton>
  );
}
