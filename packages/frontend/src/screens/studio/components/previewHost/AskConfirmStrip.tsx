import { useEffect, useState } from "react";
import { Button } from "../../../../components/Button";

/** Send stays off this long, so a click meant for the page cannot land on it. */
export const ASK_CONFIRM_ARM_MS = 600;

/**
 * Studio's own one-line confirm for an ask whose intent says `confirm: true`:
 * the message that would be sent as the person, then Send or Cancel. It sits
 * in Studio's chrome over the top of the site, like the location toast, and
 * the words are Studio's rendering, never the page's. Nothing has focus by
 * default, and Send is off for a moment after it appears.
 */
export function AskConfirmStrip({ line, onSend, onCancel }: { line: string; onSend: () => void; onCancel: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const timer = window.setTimeout(() => setArmed(true), ASK_CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [line]);
  return <div role="alertdialog" aria-label="Send this to Octo as you?" data-testid="site-ask-confirm"
    className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3">
    <div className="pointer-events-auto flex min-h-9 max-w-full items-center gap-1 rounded-2xl bg-slate-900/90 py-0.5 pl-3 pr-1 text-xs font-medium text-white shadow-lg backdrop-blur">
      <span aria-hidden="true">🐙</span>
      <span className="min-w-0 line-clamp-2" data-testid="site-ask-confirm-line">Send “{line}” as you?</span>
      <Button variant="ghost" size="sm" radius="full" data-testid="site-ask-confirm-send" isDisabled={!armed} onPress={onSend}
        className="h-8 px-2 text-xs font-semibold text-white hover:bg-white/10 pointer-coarse:h-11">Send</Button>
      <Button variant="ghost" size="sm" radius="full" data-testid="site-ask-confirm-cancel" onPress={onCancel}
        className="h-8 px-2 text-xs text-white/80 hover:bg-white/10 pointer-coarse:h-11">Cancel</Button>
    </div>
  </div>;
}
