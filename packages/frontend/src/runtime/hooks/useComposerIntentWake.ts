import { useEffect } from "react";
import { clearIdlePaused, clearRestoredAwaitingIntent } from "../idlePauseRegistry";

/** The chat composer's editable root (ChatInput). */
export const COMPOSER_INTENT_SELECTOR = "#studio-chat-input";

function isInsideComposer(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && target.closest(COMPOSER_INTENT_SELECTOR) !== null;
}

// A key that writes into the composer. Shortcuts pressed while it has focus
// (Cmd+K opens search, which can switch spaces), Escape, Tab and the arrows
// do not; text that arrives without a plain key (IME, dictation, AltGr,
// paste) is caught by beforeinput.
function isTypingKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  return (
    event.key.length === 1 ||
    event.key === "Backspace" ||
    event.key === "Delete" ||
    event.key === "Enter"
  );
}

/**
 * Lifts the holds on the active space's machine when the person works in the
 * composer: clicking into it, or typing there. Nothing else counts. Clicks in
 * the navigation would start the machine of the space being left, and focus
 * alone can arrive without the person (a dialog handing focus back, the
 * window regaining focus, focus kept across a space switch).
 */
export function useComposerIntentWake(projectId: string | null) {
  useEffect(() => {
    if (typeof window === "undefined" || !projectId) {
      return;
    }
    const wake = () => {
      clearRestoredAwaitingIntent(projectId);
      clearIdlePaused(projectId);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (isInsideComposer(event)) {
        wake();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingKey(event) && isInsideComposer(event)) {
        wake();
      }
    };
    const onInput = (event: Event) => {
      if (isInsideComposer(event)) {
        wake();
      }
    };
    // Capture, so a handler inside the composer that stops propagation does
    // not hide the intent.
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("beforeinput", onInput, true);
    window.addEventListener("input", onInput, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("beforeinput", onInput, true);
      window.removeEventListener("input", onInput, true);
    };
  }, [projectId]);
}
