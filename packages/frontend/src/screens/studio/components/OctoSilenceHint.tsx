import { Xmark } from "iconoir-react";

export const OCTO_SILENCE_HINT_MESSAGE =
  "Octo read that and stayed out — mention @octo to bring it in.";

/**
 * Ephemeral, muted line near the composer explaining a witnessed skill-mode
 * decline. Never a transcript message, never persisted; the caller controls
 * visibility (auto-dismiss + one-shot flag live in useOctoSilenceHint).
 * Clicking anywhere on the line dismisses it; the labeled button is the
 * accessible dismiss control.
 */
export function OctoSilenceHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-testid="octo-silence-hint"
      onClick={onDismiss}
      className="pointer-events-auto mx-1 flex items-center justify-between gap-2 rounded-xl border border-slate-200/60 bg-white/90 px-3 py-1.5 text-xs text-slate-500 shadow-sm backdrop-blur dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)] dark:text-slate-400 sm:mx-2"
    >
      <span className="min-w-0">{OCTO_SILENCE_HINT_MESSAGE}</span>
      <button
        type="button"
        aria-label="Dismiss hint"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-300"
      >
        <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
