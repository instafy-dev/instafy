import type { ProviderTriggerCandidate } from "./providerEventTriggers";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { SettingsSurface } from "../screens/studio/components/SettingsSurface";
import { formatProviderEventLogEntrySummary } from "./providerEventPanelPresentation";

type ExtensionProviderTriggerQueuePanelProps = {
  entries: ProviderTriggerCandidate[];
  onDismissEntry: (entry: ProviderTriggerCandidate) => void;
  onClear: () => void;
};

export function ExtensionProviderTriggerQueuePanel({
  entries,
  onDismissEntry,
  onClear,
}: ExtensionProviderTriggerQueuePanelProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <SettingsSurface data-testid="provider-trigger-queue-panel" className="space-y-3">
      <div className="space-y-1">
        <Text variant="bodyStrong" tone="primary">
          Pending sensor triggers
        </Text>
        <Text variant="caption" tone="muted">
          These events are classified as possible agent triggers. They are queued for review here,
          but they do not automatically start an agent yet.
        </Text>
      </div>
      <div className="space-y-2">
        {entries.map((entry, index) => (
          <div
            key={`${entry.key}:queue:${entry.lastTimestampNs}`}
            className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
            data-testid={`provider-trigger-queue-entry-${index}`}
          >
            <Badge size="xs" className="text-slate-600">
              Trigger candidate
            </Badge>
            {entry.count > 1 ? (
              <Badge size="xs" className="text-slate-600">
                {entry.count}x
              </Badge>
            ) : null}
            <Text variant="caption" tone="muted" className="leading-5">
              {formatProviderEventLogEntrySummary(entry)}
            </Text>
            <Button
              variant="ghost"
              size="xs"
              radius="full"
              onPress={() => onDismissEntry(entry)}
              data-testid={`provider-trigger-queue-dismiss-${index}`}
            >
              Dismiss
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          radius="full"
          onPress={onClear}
          data-testid="provider-trigger-queue-clear"
        >
          Dismiss all
        </Button>
      </div>
    </SettingsSurface>
  );
}
