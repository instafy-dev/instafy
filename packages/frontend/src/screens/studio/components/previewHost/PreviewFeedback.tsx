import { AskConfirmStrip } from "./AskConfirmStrip";
import { FollowToast } from "./FollowControls";
import { LocationBlockedNotice, LocationToast } from "./PreviewLocation";
import type { PreviewFeedbackTiming } from "./usePreviewFeedbackTimer";

export type PreviewFeedbackLaneProps = {
  active?: boolean;
  confirmation?: { line: string; onSend: () => void; onCancel: () => void } | null;
  location?: { title: string; onStop: () => void; onDismiss: () => void } | null;
  blockedLocation?: { onDismiss: () => void } | null;
  follow?: { text: string; testId?: string; timing?: PreviewFeedbackTiming } | null;
};

/** One scrollable, pane-contained lane: decisions and location controls never cover each other. */
export function PreviewFeedbackLane({ active = true, confirmation, location, blockedLocation, follow }: PreviewFeedbackLaneProps) {
  const actionable = Boolean(confirmation || location || blockedLocation);
  if (!active || (!actionable && !follow)) return null;
  return <div className="pointer-events-none absolute inset-x-0 bottom-2 top-2 z-30 flex min-h-0 items-start justify-center px-2"
    data-testid="preview-feedback-lane">
    <div className="pointer-events-auto min-h-0 w-full max-w-lg max-h-full space-y-2 overflow-y-auto overscroll-contain p-1"
      data-testid="preview-feedback-scroll">
      {confirmation ? <AskConfirmStrip {...confirmation} contained /> : null}
      {blockedLocation ? <LocationBlockedNotice {...blockedLocation} contained paused={Boolean(confirmation)} /> : null}
      {location ? <LocationToast {...location} contained paused={Boolean(confirmation)} /> : null}
      {!actionable && follow ? <FollowToast {...follow} contained /> : null}
    </div>
  </div>;
}
