import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../../components/Button";
import { FeedbackNotice } from "../../../../components/FeedbackNotice";
import { PreviewFeedbackPlacement } from "./PreviewFeedbackPlacement";

/** Send stays off this long, so a click meant for the page cannot land on it. */
export const ASK_CONFIRM_ARM_MS = 600;

/**
 * Studio's own nonmodal confirm for an ask whose intent says `confirm: true`:
 * the message that would be sent as the person, then Send or Cancel. It sits
 * in Studio's chrome over the top of the site, like the location toast, and
 * the words are Studio's rendering, never the page's. Nothing has focus by
 * default, and Send is off for a moment after it appears.
 */
type AskConfirmStripProps = {
  line: string;
  onSend: () => void;
  onCancel: () => void;
  contained?: boolean;
};

export function AskConfirmStrip({ line, onSend, onCancel, contained = false }: AskConfirmStripProps) {
  // Changing the request remounts its decision state, even if a caller keeps
  // this component mounted between two different confirmations.
  return <AskConfirmation key={line} line={line} onSend={onSend} onCancel={onCancel} contained={contained} />;
}

function AskConfirmation({ line, onSend, onCancel, contained }: Required<AskConfirmStripProps>) {
  const [armed, setArmed] = useState(false);
  const [settled, setSettled] = useState(false);
  const settledRef = useRef(false);
  const descriptionId = useId();
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ASK_CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const decide = (send: boolean) => {
    if (settledRef.current || (send && !armed)) return;
    settledRef.current = true;
    setSettled(true);
    if (send) onSend(); else onCancel();
  };
  return <PreviewFeedbackPlacement contained={contained} restoreFocus onKeyDown={event => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    decide(false);
  }}>
    <FeedbackNotice role="group" aria-label="Send this to Octo as you?" aria-describedby={descriptionId}
      data-testid="site-ask-confirm" icon={<span aria-hidden="true">🐙</span>}
      actions={<>
        <Button variant="secondary" preset="inline" data-testid="site-ask-confirm-cancel" isDisabled={settled} onPress={() => decide(false)}>Cancel</Button>
        <Button variant="primary" preset="inline" data-testid="site-ask-confirm-send" isDisabled={!armed || settled} onPress={() => decide(true)}>Send</Button>
      </>}>
      <span id={descriptionId} role="status" aria-live="polite" aria-atomic="true" data-testid="site-ask-confirm-line">Send “{line}” as you?</span>
    </FeedbackNotice>
  </PreviewFeedbackPlacement>;
}
