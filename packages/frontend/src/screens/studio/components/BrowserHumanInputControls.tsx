import { useContext, useLayoutEffect } from "react";
import { CursorPointer, Play } from "iconoir-react";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { BrowserToolsOverlayContext } from "./BrowserToolsPopover";
import { useBrowserHumanInput, type BrowserHumanInputOptions } from "./useBrowserHumanInput";

export function BrowserHumanInputControls(props: BrowserHumanInputOptions) {
  const state = useBrowserHumanInput(props);
  return <BrowserHumanInputStatus {...props} state={state} />;
}

export function BrowserHumanInputStatus(props: BrowserHumanInputOptions & { state: ReturnType<typeof useBrowserHumanInput> }) {
  const { state } = props;
  const registerOverlay = useContext(BrowserToolsOverlayContext);
  const dialogOpen = state.takeoverRequested && props.canTakeOver;
  useLayoutEffect(() => dialogOpen ? registerOverlay?.() : undefined, [dialogOpen, registerOverlay]);
  if (!state.active && !props.canTakeOver) return null;
  const manualGuidance = state.request
    ? `Fill the ${state.request.fields.length === 1 ? "highlighted field" : `${state.request.fields.length} highlighted fields`} on the page, then let the AI continue. Keep passwords and codes out of chat.`
    : "You control the browser. Finish your changes on the page, then let the AI continue.";
  const waitingGuidance = state.busy === "continue"
    ? "Continuing the AI task. Input remains locked."
    : "Waiting for agent control to stop. Input remains locked.";
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs" data-testid="browser-human-input-controls" data-browser-session-safe-zone="true">
      {state.active && props.humanControlConfirmed ? (
        <button type="button" className="inline-flex min-h-9 pointer-coarse:min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-indigo-600 px-3 font-medium text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-50"
          disabled={state.busy !== null || props.canContinue === false} title={state.error ?? manualGuidance}
          onClick={() => void state.continueTask()} data-testid="browser-human-input-continue">
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          {state.busy === "continue" ? "Continuing…" : "Let AI continue"}
        </button>
      ) : state.active && !state.error ? (
        <span role="status" className="text-slate-500 dark:text-slate-400">{state.busy === "continue" ? "Continuing…" : "Stopping AI…"}</span>
      ) : props.canTakeOver ? (
        <button type="button" className="inline-flex min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 items-center justify-center rounded-full text-slate-500 hover:bg-slate-500/10 focus-visible:outline-2 focus-visible:outline-indigo-500"
          aria-label="Take over browser" title="Take over browser" onClick={state.requestTakeOver} data-testid="browser-human-input-request">
          <CursorPointer className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      {state.active ? <span className="sr-only" role="status">{props.humanControlConfirmed ? manualGuidance : waitingGuidance}</span> : null}
      {state.error ? <span role="alert" className="max-w-48 truncate text-rose-600 dark:text-rose-300" title={state.error}>{state.error}</span> : null}
      <StudioDialogModal isOpen={dialogOpen} onOpenChange={(open) => { if (!open) state.dismissTakeOver(); }}
        isDismissable={state.busy === null} isKeyboardDismissDisabled={state.busy !== null}
        dialogAriaLabel="Take over browser" modalClassName="!max-w-sm" dialogClassName="p-5" data-browser-session-safe-zone="true">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">Take over the browser?</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">The AI will pause so you can use the page. When you’re ready, choose <strong>Let AI continue</strong> in the browser toolbar.</p>
        {state.error ? <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-300">{state.error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="min-h-10 pointer-coarse:min-h-11 rounded-full px-4 text-sm text-slate-600 hover:bg-slate-500/10 dark:text-slate-300" disabled={state.busy !== null} onClick={state.dismissTakeOver} data-testid="browser-human-input-cancel">Keep AI working</button>
          <button type="button" className="min-h-10 pointer-coarse:min-h-11 rounded-full bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50" disabled={state.busy !== null} onClick={() => void state.takeOver()} data-testid="browser-human-input-takeover">{state.busy === "takeover" ? "Stopping AI…" : "Take over"}</button>
        </div>
      </StudioDialogModal>
    </div>
  );
}
