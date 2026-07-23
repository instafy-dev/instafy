import { Text } from "../components/Text";
import type { HostHandsFreeVoiceAvailability } from "./hostAudioSessionState";

type HostHandsFreeVoiceNoticeProps = {
  availability: HostHandsFreeVoiceAvailability;
  className?: string;
  testIdPrefix?: string;
  variant?: "default" | "inverse";
};

export function HostHandsFreeVoiceNotice({
  availability,
  className = "",
  testIdPrefix = "host-audio-hands-free",
  variant = "default",
}: HostHandsFreeVoiceNoticeProps) {
  const palette =
    availability.state === "unavailable"
      ? variant === "inverse"
        ? "border-rose-400/20 bg-rose-400/10 text-rose-50"
        : "border-rose-200/80 bg-rose-50/90 text-rose-950 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-50"
      : availability.state === "background_paused"
        ? variant === "inverse"
          ? "border-amber-300/20 bg-amber-300/10 text-amber-50"
          : "border-amber-200/80 bg-amber-50/90 text-amber-950 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-50"
        : availability.state === "foreground_only"
          ? variant === "inverse"
            ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-50"
            : "border-cyan-200/80 bg-cyan-50/90 text-cyan-950 dark:border-cyan-500/20 dark:bg-cyan-500/10 dark:text-cyan-50"
          : variant === "inverse"
            ? "border-white/12 bg-white/6 text-slate-100"
            : "border-slate-200/70 bg-slate-50/90 text-slate-900 dark:border-slate-800/80 dark:bg-slate-950/60 dark:text-slate-100";

  const detailTone = variant === "inverse" ? "text-current/80" : "text-current/75";

  return (
    <div
      className={[
        "rounded-2xl border p-3",
        palette,
        className,
      ].join(" ")}
      data-testid={`${testIdPrefix}-notice`}
    >
      <div className="space-y-1">
        <Text variant="bodyStrong" tone="secondary" data-testid={`${testIdPrefix}-title`}>
          {availability.label}
        </Text>
        <Text
          variant="caption"
          tone="muted"
          className={detailTone}
          data-testid={`${testIdPrefix}-detail`}
        >
          {availability.detail}
        </Text>
      </div>
    </div>
  );
}
