import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Heading } from "../../components/Heading";
import { Text } from "../../components/Text";

interface HostedRuntimePromptDialogProps {
  runtimes: ControllerRuntimeStatusEntry[];
  onUseExisting: (runtimeId: string) => void;
  onLaunchNew: () => void;
  onCancel: () => void;
}

export function HostedRuntimePromptDialog({
  runtimes,
  onUseExisting,
  onLaunchNew,
  onCancel,
}: HostedRuntimePromptDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 pb-[max(var(--instafy-safe-area-inset-bottom),1rem)] pl-[max(var(--instafy-safe-area-inset-left),1rem)] pr-[max(var(--instafy-safe-area-inset-right),1rem)] pt-[max(var(--instafy-safe-area-inset-top),1rem)]"
      role="dialog"
      aria-modal="true"
      data-testid="hosted-runtime-existing-dialog"
      onClick={onCancel}
    >
      <Card
        tone="default"
        radius="2xl"
        shadow="lg"
        padding="lg"
        className="max-h-full w-full max-w-md overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <Heading level={2} variant="title">
          Instafy Cloud already running
        </Heading>
        <Text variant="body" tone="secondary" className="mt-2">
          You already have an Instafy Cloud runtime for this project. You can reuse it or start an additional one.
        </Text>
        <div className="mt-3 space-y-2">
          {runtimes.map((runtime) => {
            const displayName = runtime.displayName?.trim().length
              ? runtime.displayName.trim()
              : "Instafy Cloud";
            const statusLabel = runtime.status
              ? runtime.status.replace(/_/g, " ")
              : "unknown";
            const healthLabel = runtime.health
              ? runtime.health.charAt(0).toUpperCase() + runtime.health.slice(1)
              : "Unknown";
            return (
              <Button
                key={runtime.runtimeId}
                onPress={() => onUseExisting(runtime.runtimeId)}
                variant="outline"
                size="md"
                radius="xl"
                fullWidth
                className="justify-start text-left"
                data-testid="hosted-runtime-use-existing"
                data-runtime-id={runtime.runtimeId}
                data-runtime-status={runtime.status ?? ""}
                data-runtime-health={runtime.health ?? ""}
              >
                <div className="flex flex-col gap-0.5">
                  <Text as="span" variant="bodyStrong" tone="primary">
                    {displayName}
                  </Text>
                  <Text as="span" variant="caption" tone="muted">
                    Status: {statusLabel} · Health: {healthLabel}
                  </Text>
                </div>
              </Button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            onPress={onCancel}
            variant="outline"
            size="sm"
            radius="full"
            data-testid="hosted-runtime-cancel"
          >
            Cancel
          </Button>
          <Button
            onPress={onLaunchNew}
            variant="primary"
            size="sm"
            radius="full"
            data-testid="hosted-runtime-launch-new"
          >
            Start additional runtime
          </Button>
        </div>
      </Card>
    </div>
  );
}
