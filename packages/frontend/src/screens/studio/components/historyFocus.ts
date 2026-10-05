/**
 * Keyboard focus in History when the control that had it goes away (a
 * resolved file's buttons, a removed row, a hidden line or Show more).
 * Focus only moves when it fell to the page, never away from a place the
 * person chose meanwhile.
 */

/** Focus is on nothing: the element that had it was removed. */
export function focusWasLost(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/** Focus the first candidate that can take focus, when focus was lost. */
export function restoreLostFocus(...candidates: Array<HTMLElement | null | undefined>): boolean {
  if (!focusWasLost()) {
    return false;
  }
  for (const candidate of candidates) {
    if (!candidate || !candidate.isConnected || (candidate as HTMLButtonElement).disabled) {
      continue;
    }
    candidate.focus();
    if (document.activeElement === candidate) {
      return true;
    }
  }
  return false;
}

/** Focus ring for elements that take focus only from code (`tabIndex={-1}`). */
export const PROGRAMMATIC_FOCUS_CLASS =
  "rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40";
