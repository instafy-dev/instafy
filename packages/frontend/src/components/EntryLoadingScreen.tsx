import { OctoMark } from "./OctoMark";

/** A quiet shared handoff while a route or authenticated session becomes ready. */
export function EntryLoadingScreen() {
  return (
    <div
      className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-white px-6 text-brand-ink dark:bg-[var(--color-studio-dark-canvas)] dark:text-brand-paper"
      data-testid="entry-loading-screen"
    >
      <div className="flex flex-col items-center gap-5">
        <div aria-hidden="true">
          <OctoMark className="h-12 w-12" motion="thinking" />
        </div>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-slate-500 dark:text-slate-400">
          Getting things ready…
        </p>
      </div>
    </div>
  );
}
