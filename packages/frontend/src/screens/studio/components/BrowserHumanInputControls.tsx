import { useContext, useLayoutEffect, type ReactNode } from "react";
import { CursorPointer, Play } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { InlineNotice } from "../../../components/InlineNotice";
import { StudioDialogBody } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { BrowserToolsOverlayContext } from "./BrowserToolsPopover";
import { useBrowserHumanInput, type BrowserHumanInputOptions } from "./useBrowserHumanInput";

type BrowserHumanInputPresentation = {
  // A compact toolbar can place actions in a popover without unmounting the
  // takeover dialog that also opens from a click on the browser surface.
  renderControls?: (controls: ReactNode) => ReactNode;
};

/**
 * What a pause on the person's fields in the space's browser says stays
 * behind once they sign in: Instafy's browser is the space's, so a sign-in
 * there reaches its other chats (and members). The Browser view shows it in
 * a row of its own under the toolbar while the pause waits, at every width.
 */
export function sharedBrowserSignInNote(spaceHasTeammates: boolean): string {
  return spaceHasTeammates
    ? "This space's browser keeps you signed in for its chats and members until you clear it."
    : "This space's browser keeps you signed in for its chats until you clear it.";
}

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
    ? `Fill the ${state.request.fields.length === 1 ? "highlighted field" : `${state.request.fields.length} highlighted fields`} on the page, then let Octo continue. Keep passwords and codes out of chat.`
    : "You control the browser. Finish your changes on the page, then let Octo continue.";
  const waitingGuidance = state.busy === "continue"
    ? "Continuing Octo's task. Input remains locked."
    : "Waiting for agent control to stop. Input remains locked.";
  const controls = (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2" data-testid="browser-human-input-controls" data-browser-session-safe-zone="true">
      {state.active && props.humanControlConfirmed ? (
        <Button type="button" preset="inline" variant="primary" className="shrink-0"
          isDisabled={state.busy !== null || props.canContinue === false} title={manualGuidance}
          onPress={() => void state.continueTask()} data-testid="browser-human-input-continue">
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          {state.busy === "continue" ? "Continuing…" : "Let Octo continue"}
        </Button>
      ) : state.active && !state.error ? (
        <Text as="span" variant="caption" tone="muted" role="status">{state.busy === "continue" ? "Continuing…" : "Stopping Octo…"}</Text>
      ) : props.canTakeOver ? (
        <IconButton type="button" size="sm" variant="ghost"
          aria-label="Take over browser" title="Take over browser" onPress={state.requestTakeOver} data-testid="browser-human-input-request">
          <CursorPointer className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      ) : null}
      {state.active ? <span className="sr-only" role="status">{props.humanControlConfirmed ? manualGuidance : waitingGuidance}</span> : null}
      {state.error ? <InlineNotice tone="danger" appearance="inline" role="alert" className="basis-full">{state.error}</InlineNotice> : null}
    </div>
  );
  return (
    <>
      {props.renderControls ? props.renderControls(controls) : controls}
      <StudioDialogModal isOpen={dialogOpen} onOpenChange={(open) => { if (!open) state.dismissTakeOver(); }}
        isDismissable={state.busy === null} isKeyboardDismissDisabled={state.busy !== null}
        dialogAriaLabel="Take over browser" size="sm" gutter="responsive" layout="editor" data-browser-session-safe-zone="true">
        <StudioDialogBody scrollable>
          <Text as="h2" variant="subtitle" tone="primary">Take over the browser?</Text>
          <Text as="p" variant="body" tone="muted" className="mt-2">Octo will pause so you can use the page. When you’re ready, choose <strong>Let Octo continue</strong> in the browser controls.</Text>
          {state.error ? <InlineNotice tone="danger" appearance="inline" role="alert" className="mt-3">{state.error}</InlineNotice> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button type="button" preset="form" variant="ghost" isDisabled={state.busy !== null} onPress={state.dismissTakeOver} data-testid="browser-human-input-cancel">Keep Octo working</Button>
            <Button type="button" preset="form" variant="primary" isDisabled={state.busy !== null} onPress={() => void state.takeOver()} data-testid="browser-human-input-takeover">{state.busy === "takeover" ? "Stopping Octo…" : "Take over"}</Button>
          </div>
        </StudioDialogBody>
      </StudioDialogModal>
    </>
  );
}
