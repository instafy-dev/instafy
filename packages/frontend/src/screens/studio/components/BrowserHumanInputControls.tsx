import { useContext, useLayoutEffect, type ReactNode } from "react";
import { CursorPointer, Play } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { BrowserToolsOverlayContext } from "./BrowserToolsPopover";
import { useBrowserHumanInput, type BrowserHumanInputOptions } from "./useBrowserHumanInput";

type BrowserHumanInputPresentation = {
  // A compact toolbar can place actions in a popover without unmounting the
  // takeover dialog that also opens from a click on the browser surface.
  renderControls?: (controls: ReactNode) => ReactNode;
};

export function BrowserHumanInputControls(props: BrowserHumanInputOptions & BrowserHumanInputPresentation) {
  const state = useBrowserHumanInput(props);
  return <BrowserHumanInputStatus {...props} state={state} />;
}

export function BrowserHumanInputStatus(props: BrowserHumanInputOptions & BrowserHumanInputPresentation & { state: ReturnType<typeof useBrowserHumanInput> }) {
  const { state } = props;
  const registerOverlay = useContext(BrowserToolsOverlayContext);
  const dialogOpen = state.takeoverRequested && props.canTakeOver;
  useLayoutEffect(() => dialogOpen ? registerOverlay?.() : undefined, [dialogOpen, registerOverlay]);
  if (!state.active && !props.canTakeOver) return props.renderControls?.(null) ?? null;
  const manualGuidance = state.request
    ? `Fill the ${state.request.fields.length === 1 ? "highlighted field" : `${state.request.fields.length} highlighted fields`} on the page, then let the AI continue. Keep passwords and codes out of chat.`
    : "You control the browser. Finish your changes on the page, then let the AI continue.";
  const waitingGuidance = state.busy === "continue"
    ? "Continuing the AI task. Input remains locked."
    : "Waiting for agent control to stop. Input remains locked.";
  const controls = (
    <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2 text-xs" data-testid="browser-human-input-controls" data-browser-session-safe-zone="true">
      {state.active && props.humanControlConfirmed ? (
        <Button type="button" size="sm" variant="primary" radius="full" className="min-h-9 shrink-0"
          isDisabled={state.busy !== null || props.canContinue === false} title={state.error ?? manualGuidance}
          onPress={() => void state.continueTask()} data-testid="browser-human-input-continue">
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          {state.busy === "continue" ? "Continuing…" : "Let AI continue"}
        </Button>
      ) : state.active && !state.error ? (
        <span role="status" className="text-slate-500 dark:text-slate-400">{state.busy === "continue" ? "Continuing…" : "Stopping AI…"}</span>
      ) : props.canTakeOver ? (
        <IconButton type="button" size="md" variant="ghost" radius="full"
          aria-label="Take over browser" title="Take over browser" onPress={state.requestTakeOver} data-testid="browser-human-input-request">
          <CursorPointer className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      ) : null}
      {state.active ? <span className="sr-only" role="status">{props.humanControlConfirmed ? manualGuidance : waitingGuidance}</span> : null}
      {state.error ? <span role="alert" className="max-w-48 truncate text-rose-600 dark:text-rose-300" title={state.error}>{state.error}</span> : null}
    </div>
  );
  return (
    <>
      {props.renderControls ? props.renderControls(controls) : controls}
      <StudioDialogModal isOpen={dialogOpen} onOpenChange={(open) => { if (!open) state.dismissTakeOver(); }}
        isDismissable={state.busy === null} isKeyboardDismissDisabled={state.busy !== null}
        dialogAriaLabel="Take over browser" modalClassName="!max-w-sm" dialogClassName="p-5" data-browser-session-safe-zone="true">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">Take over the browser?</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">The AI will pause so you can use the page. When you’re ready, choose <strong>Let AI continue</strong> in the browser controls.</p>
        {state.error ? <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-300">{state.error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" radius="full" className="min-h-10" isDisabled={state.busy !== null} onPress={state.dismissTakeOver} data-testid="browser-human-input-cancel">Keep AI working</Button>
          <Button type="button" size="sm" variant="primary" radius="full" className="min-h-10" isDisabled={state.busy !== null} onPress={() => void state.takeOver()} data-testid="browser-human-input-takeover">{state.busy === "takeover" ? "Stopping AI…" : "Take over"}</Button>
        </div>
      </StudioDialogModal>
    </>
  );
}
