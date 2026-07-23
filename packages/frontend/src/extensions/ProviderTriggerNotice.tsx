import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { formatProviderEventSummaryLine } from "./providerEventPresentation";
import type { ProviderTriggerCandidate } from "./providerEventTriggers";

type ProviderTriggerNoticeProps = {
  candidate: ProviderTriggerCandidate;
  candidateCount?: number;
  wakeWordMode?: "manual" | "armed";
  actionLabel?: string | null;
  onAction?: (() => void) | null;
  onDismiss?: (() => void) | null;
  onClearAll?: (() => void) | null;
  className?: string;
  testIdPrefix?: string;
};

function readWakeWordLabel(candidate: ProviderTriggerCandidate) {
  const payload = candidate.latestEvent.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const label = (payload as Record<string, unknown>).label;
  return typeof label === "string" && label.trim().length > 0 ? label.trim() : null;
}

function describeProviderTriggerCandidate(
  candidate: ProviderTriggerCandidate,
  wakeWordMode: "manual" | "armed",
) {
  if (candidate.latestEvent.kind === "audio.wake_word_detected") {
    const label = readWakeWordLabel(candidate);
    return {
      title: "Wake word heard",
      detail:
        wakeWordMode === "armed"
          ? label
            ? `Detected “${label}”. Instafy is armed to start continuous chat voice while this space stays in the foreground.`
            : "Instafy is armed to start continuous chat voice when a wake word is heard while this space stays in the foreground."
          : label
            ? `Detected “${label}”. Instafy recorded it as a trigger candidate, but automatic wake-word launch is not enabled yet.`
            : "Instafy recorded a wake word as a trigger candidate, but automatic wake-word launch is not enabled yet.",
    };
  }

  return {
    title: "Trigger candidate",
    detail:
      formatProviderEventSummaryLine([candidate.latestEvent], { includeRecordOnly: true }) ??
      candidate.latestEvent.kind,
  };
}

export function ProviderTriggerNotice({
  candidate,
  candidateCount = 1,
  wakeWordMode = "manual",
  actionLabel = null,
  onAction = null,
  onDismiss = null,
  onClearAll = null,
  className = "",
  testIdPrefix = "provider-trigger-notice",
}: ProviderTriggerNoticeProps) {
  const copy = describeProviderTriggerCandidate(candidate, wakeWordMode);

  return (
    <div
      className={[
        "rounded-2xl border border-cyan-200/80 bg-cyan-50/90 p-3 text-cyan-950 dark:border-cyan-500/20 dark:bg-cyan-500/10 dark:text-cyan-50",
        className,
      ].join(" ")}
      data-testid={`${testIdPrefix}-notice`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="xs" className="text-cyan-700 dark:text-cyan-100">
              Trigger candidate
            </Badge>
            {candidateCount > 1 ? (
              <Badge size="xs" className="text-cyan-700 dark:text-cyan-100">
                +{candidateCount - 1} more
              </Badge>
            ) : null}
          </div>
          <Text variant="bodyStrong" tone="secondary" data-testid={`${testIdPrefix}-title`}>
            {copy.title}
          </Text>
          <Text variant="caption" tone="muted" data-testid={`${testIdPrefix}-detail`}>
            {copy.detail}
          </Text>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onAction && actionLabel ? (
            <Button
              variant="outline"
              size="sm"
              radius="full"
              onPress={onAction}
              data-testid={`${testIdPrefix}-action`}
            >
              {actionLabel}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button
              variant="ghost"
              size="sm"
              radius="full"
              onPress={onDismiss}
              data-testid={`${testIdPrefix}-dismiss`}
            >
              Dismiss
            </Button>
          ) : null}
          {onClearAll && candidateCount > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              radius="full"
              onPress={onClearAll}
              data-testid={`${testIdPrefix}-clear`}
            >
              Dismiss all
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
