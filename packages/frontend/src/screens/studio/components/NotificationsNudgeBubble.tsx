import { useCallback, useState } from "react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
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
      className="w-full max-w-[32rem] border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200"
      data-testid="notifications-nudge-bubble"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Text as="p" variant="bodyStrong" className="truncate">
            {phase === "enabled" ? "Notifications enabled." : title}
          </Text>
          {phase === "enabled" ? null : (
            <Text as="p" variant="caption" tone="muted" className="mt-0.5">
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
            size="xs"
            radius="full"
            onPress={() => void handleEnable()}
            isDisabled={isBusy}
            className="gap-2"
          >
            {isBusy ? <Spinner size="sm" /> : null}
            Enable
          </Button>
          <Button
            variant="ghost"
            size="xs"
            radius="full"
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
