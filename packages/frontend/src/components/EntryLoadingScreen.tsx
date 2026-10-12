import { OctoMark } from "./OctoMark";

/**
 * A quiet shared handoff while a route or authenticated session becomes ready.
 * It sits on the marketing paper (#F8F8F6, dark #141414, the studio's dark
 * canvas): the step between the landing and login never flashes white, and
 * the studio's own near-white canvas follows it without a jump.
 */
export function EntryLoadingScreen() {
  return (
    <div
      className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-[var(--marketing-canvas)] px-6 text-brand-ink dark:text-brand-paper"
      data-testid="entry-loading-screen"
    >
      <div className="flex flex-col items-center gap-5">
        <div aria-hidden="true">
          <OctoMark className="h-12 w-12" motion="thinking" />
        </div>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-slate-600 dark:text-slate-400">
          Getting things ready…
        </p>
      </div>
    </div>
  );
}
