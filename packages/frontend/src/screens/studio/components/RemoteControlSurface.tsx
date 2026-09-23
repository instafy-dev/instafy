import "./RemoteControlSurface.css";

/** Mount only while someone else owns the view; working controls motion, not authority.
 * Legacy CSS/test selectors remain stable for existing browser consumers.
 */
export function RemoteControlSurface({ controller, working, onTakeOver, actionLabel = "Take over" }: {
  controller: string;
  working: boolean;
  onTakeOver?: () => void;
  actionLabel?: string;
}) {
  const status = `${controller} has control`;
  return (
    <div className="browser-agent-surface" data-working={working} data-testid="browser-agent-surface" data-controller={controller}>
      <div className="browser-agent-glow" aria-hidden="true"><div className="browser-agent-grid" /></div>
      {onTakeOver ? (
        <button type="button" className="browser-agent-surface-target"
          aria-label={`${status}. ${actionLabel}`}
          onClick={onTakeOver} data-testid="browser-agent-surface-takeover">
          <span className="browser-agent-surface-hint">{status} · {actionLabel}</span>
        </button>
      ) : <span className="sr-only" role="status">{status}</span>}
    </div>
  );
}
