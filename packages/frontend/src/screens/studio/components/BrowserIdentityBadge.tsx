// A calm, always-visible indicator that the agent's browser is the project's
// SHARED browser — so it is never a surprise that a login done here (or by the
// agent) is visible to, and reusable by, everyone on the project. This is the
// "make the sharing obvious" half of the browser-identity work.

const SHARED_BROWSER_TOOLTIP =
  "This is the project's shared browser. Anyone on the project can see it and reuse whatever you sign into here. Choose Personal Browser in the desktop app when a login should stay on this device.";

export function BrowserIdentityBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="browser-identity-badge"
      title={SHARED_BROWSER_TOOLTIP}
      className={[
        "inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xxs font-medium text-sky-700 dark:text-sky-300",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-400" aria-hidden="true" />
      <span>Shared with your team</span>
    </span>
  );
}
