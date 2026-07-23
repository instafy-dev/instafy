import { Button } from "../components/Button";
import { Text } from "../components/Text";
import type { HostAudioPermissionState } from "./audioSessionDiagnostics";
import {
  describeHostMicrophonePermissionNotice,
  shouldShowHostMicrophonePermissionNotice,
} from "./hostMicrophonePermission";

type HostMicrophonePermissionNoticeProps = {
  permission: HostAudioPermissionState | null | undefined;
  requesting?: boolean;
  error?: string | null;
  onRequest?: (() => void) | null;
  className?: string;
  testIdPrefix?: string;
};

export function HostMicrophonePermissionNotice({
  permission,
  requesting = false,
  error = null,
  onRequest = null,
  className = "",
  testIdPrefix = "host-audio-mic",
}: HostMicrophonePermissionNoticeProps) {
  if (!shouldShowHostMicrophonePermissionNotice(permission)) {
    return null;
  }

  const copy = describeHostMicrophonePermissionNotice(permission);

  return (
    <div
      className={[
        "rounded-2xl border border-amber-200/80 bg-amber-50/90 p-3 text-amber-950 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-50",
        className,
      ].join(" ")}
      data-testid={`${testIdPrefix}-notice`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <Text variant="bodyStrong" tone="secondary" data-testid={`${testIdPrefix}-title`}>
            {copy.title}
          </Text>
          <Text variant="caption" tone="muted" data-testid={`${testIdPrefix}-description`}>
            {copy.description}
          </Text>
          {error ? (
            <Text variant="caption" tone="danger" data-testid={`${testIdPrefix}-error`}>
              {error}
            </Text>
          ) : null}
        </div>
        {onRequest ? (
          <Button
            onPress={onRequest}
            isDisabled={requesting}
            variant="outline"
            size="sm"
            radius="xl"
            data-testid={`${testIdPrefix}-action`}
          >
            {requesting ? "Requesting…" : copy.actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
