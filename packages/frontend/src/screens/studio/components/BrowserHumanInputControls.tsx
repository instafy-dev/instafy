import { useBrowserHumanInput, type BrowserHumanInputOptions } from "./useBrowserHumanInput";

export function BrowserHumanInputControls(props: BrowserHumanInputOptions) {
  const state = useBrowserHumanInput(props);
  return <BrowserHumanInputStatus {...props} state={state} />;
}

export function BrowserHumanInputStatus(props: BrowserHumanInputOptions & { state: ReturnType<typeof useBrowserHumanInput> }) {
  const { state } = props;
  if (!state.active && !props.canTakeOver) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" data-testid="browser-human-input-controls" data-browser-session-safe-zone="true">
      {state.active ? (
        <div className="min-w-0 flex-1" role="status">
          <p className="font-semibold">{props.humanControlConfirmed ? "You control the browser" : "Waiting for agent control to stop…"}</p>
          <p>{props.humanControlConfirmed
            ? state.request ? `Fill the ${state.request.fields.length === 1 ? "highlighted field" : `${state.request.fields.length} highlighted fields`} directly on the page, then continue. Keep passwords and codes out of chat.` : "Complete your manual step directly on the page, then continue. Keep passwords and codes out of chat."
            : "Input stays locked until the browser confirms control has returned to you."}</p>
        </div>
      ) : <span className="min-w-0 flex-1">Need to fill something yourself?</span>}
      {state.active && props.humanControlConfirmed ? (
        <button type="button" className="min-h-10 shrink-0 rounded-full bg-amber-900 px-3 font-semibold text-white disabled:opacity-50" disabled={state.busy !== null || props.canContinue === false} onClick={() => void state.continueTask()} data-testid="browser-human-input-continue">
          {state.busy === "continue" ? "Starting fresh turn…" : "Done, continue"}
        </button>
      ) : props.canTakeOver ? (
        <button type="button" className="min-h-10 shrink-0 rounded-full border border-amber-600 px-3 font-semibold disabled:opacity-50" disabled={state.busy !== null} onClick={() => void state.takeOver()} data-testid="browser-human-input-takeover">
          {state.busy === "takeover" ? "Stopping agent…" : "Take over"}
        </button>
      ) : null}
      {state.error ? <p className="w-full" role="alert">{state.error}</p> : null}
    </div>
  );
}
