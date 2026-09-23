import "./BrowserAgentSurface.css";

/** A visual/input layer only; the browser host remains the control authority. */
export function BrowserAgentSurface({ working, onTakeOver }: { working: boolean; onTakeOver?: () => void }) {
  return (
    <div className="browser-agent-surface" data-working={working} data-testid="browser-agent-surface">
      <div className="browser-agent-mosaic" aria-hidden="true" />
      {onTakeOver ? (
        <button type="button" className="browser-agent-surface-target"
          aria-label={working ? "AI is working. Take over browser" : "AI has browser control. Take over browser"}
          onClick={onTakeOver} data-testid="browser-agent-surface-takeover">
          <span className="browser-agent-surface-hint">{working ? "AI is working" : "AI control"} · Click to take over</span>
        </button>
      ) : null}
    </div>
  );
}
