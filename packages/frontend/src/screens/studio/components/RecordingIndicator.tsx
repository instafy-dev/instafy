import { Microphone } from "iconoir-react";

const PRESENTATION_CLASSES = {
  inline: "h-5 w-5 shadow-[0_0_0_6px_rgba(59,130,246,0.08)] dark:shadow-[0_0_0_6px_rgba(96,165,250,0.06)]",
  strip: "h-9 w-9 shadow-[0_0_0_10px_rgba(59,130,246,0.08)] dark:shadow-[0_0_0_8px_rgba(96,165,250,0.06)]",
} as const;

/** The same recording cue in the draft and its expanded voice controls. */
export function RecordingIndicator({
  presentation,
  className,
  title,
  testId,
}: {
  presentation: keyof typeof PRESENTATION_CLASSES;
  className?: string;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      title={title}
      className={[
        "relative inline-flex flex-none items-center justify-center rounded-full border border-primary-300/70 bg-primary-500/10 text-primary-600 dark:border-primary-400/50 dark:bg-primary-400/10 dark:text-primary-200",
        PRESENTATION_CLASSES[presentation],
        className,
      ].filter(Boolean).join(" ")}
    >
      <span className="absolute inset-0 animate-ping rounded-full bg-primary-500/20 dark:bg-primary-400/20" />
      <Microphone className={presentation === "inline" ? "relative h-3.5 w-3.5" : "relative h-4.5 w-4.5"} />
    </span>
  );
}
