import type { ProviderEventLogEntry } from "./providerEventLog";
import type { ProviderEventSyntheticScenario } from "./providerEventSynthetic";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { SettingsSurface } from "../screens/studio/components/SettingsSurface";
import {
  formatProviderEventLogEntrySummary,
  formatProviderEventReactionLabel,
} from "./providerEventPanelPresentation";

type ExtensionProviderEventDebugPanelProps = {
  entries: ProviderEventLogEntry[];
  onEmitScenario: (scenario: ProviderEventSyntheticScenario) => void;
  onClear: () => void;
};

export function ExtensionProviderEventDebugPanel({
  entries,
  onEmitScenario,
  onClear,
}: ExtensionProviderEventDebugPanelProps) {
  return (
    <SettingsSurface data-testid="provider-event-debug-panel" className="space-y-3">
      <div className="space-y-1">
        <Text variant="bodyStrong" tone="primary">
          Synthetic provider events
        </Text>
        <Text variant="caption" tone="muted">
          Emit camera, wake-word, or rapid telemetry events through the same host policy and
          bounded log path used for real provider observations.
        </Text>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          radius="full"
          onPress={() => onEmitScenario("camera_capture")}
          data-testid="provider-event-emit-camera"
        >
          Emit camera event
        </Button>
        <Button
          variant="outline"
          size="xs"
          radius="full"
          onPress={() => onEmitScenario("audio_wake_word")}
          data-testid="provider-event-emit-wake-word"
        >
          Emit wake word
        </Button>
        <Button
          variant="outline"
          size="xs"
          radius="full"
          onPress={() => onEmitScenario("telemetry_burst")}
          data-testid="provider-event-emit-telemetry"
        >
          Emit telemetry burst
        </Button>
        <Button
          variant="ghost"
          size="xs"
          radius="full"
          onPress={onClear}
          isDisabled={entries.length === 0}
          data-testid="provider-event-clear-log"
        >
          Clear log
        </Button>
      </div>
      <div className="space-y-2 border-t border-slate-200/70 pt-3 dark:border-slate-800">
        <Text variant="caption" tone="muted">
          Recent provider events
        </Text>
        {entries.length === 0 ? (
          <Text variant="caption" tone="muted">
            No provider events captured yet.
          </Text>
        ) : (
          <div className="space-y-2">
            {entries.slice(0, 8).map((entry, index) => (
              <div
                key={`${entry.key}:${entry.lastTimestampNs}`}
                className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
                data-testid={`provider-event-log-entry-${index}`}
              >
                <Badge size="xs" className="text-slate-600">
                  {formatProviderEventReactionLabel(entry.reaction)}
                </Badge>
                {entry.count > 1 ? (
                  <Badge size="xs" className="text-slate-600">
                    {entry.count}x
                  </Badge>
                ) : null}
                <Text variant="caption" tone="muted" className="leading-5">
                  {formatProviderEventLogEntrySummary(entry)}
                </Text>
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsSurface>
  );
}
