import { useCallback, useState } from "react";
import { Button } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";

type NudgePhase = "idle" | "requesting" | "enabled" | "error";

interface NotificationsNudgeBubbleProps {
  title?: string;
  detail?: string;
  onEnable: () => Promise<boolean>;
  onDismiss: () => void;
}

export function NotificationsNudgeBubble({
  title = "Enable notifications?",
  detail = "Get alerted when new assistant messages arrive.",
  onEnable,
  onDismiss,
}: NotificationsNudgeBubbleProps) {
  const [phase, setPhase] = useState<NudgePhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const handleEnable = useCallback(async () => {
    if (phase === "requesting" || phase === "enabled") {
      return;
    }
    setError(null);
    setPhase("requesting");
    try {
      const ok = await onEnable();
      if (!ok) {
        setPhase("error");
        setError("Notifications were not enabled.");
        return;
      }
      setPhase("enabled");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setPhase("error");
      setError(message);
    }
  }, [onEnable, phase]);

  const isBusy = phase === "requesting";

  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="sm"
      className="w-full max-w-lg px-3 py-2.5"
      data-testid="notifications-nudge-bubble"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Text as="p" variant="bodyStrong" tone="primary" role={phase === "enabled" ? "status" : undefined}>
            {phase === "enabled" ? "Notifications enabled." : title}
          </Text>
          {phase === "enabled" ? null : (
            <Text as="p" variant="caption" tone={phase === "error" ? "danger" : "muted"} role={phase === "error" ? "alert" : phase === "requesting" ? "status" : undefined} className="mt-0.5">
              {phase === "requesting"
                ? "Requesting permission…"
                : phase === "error"
                  ? error ?? "Unable to enable notifications."
                  : detail}
            </Text>
          )}
        </div>
      </div>

      {phase === "enabled" ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            preset="inline"
            onPress={() => void handleEnable()}
            isPending={isBusy}
          >
            Enable
          </Button>
          <Button
            variant="ghost"
            preset="inline"
            onPress={onDismiss}
            isDisabled={isBusy}
          >
            Not now
          </Button>
        </div>
      )}
    </Surface>
  );
}
