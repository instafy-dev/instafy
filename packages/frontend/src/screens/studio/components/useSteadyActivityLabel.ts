import { useEffect, useRef, useState } from "react";
import { STARTING_LINE, THINKING_LINE, WAITING_FOR_YOU_LINE } from "./turnActivity";

/** A running label stays on screen at least this long, so a step that ends at once never flashes past. */
export const ACTIVITY_LABEL_HOLD_MS = 1_200;

/**
 * "Thinking…" shows only after this long with no step running. Until then the
 * line keeps the step before it, or "Starting…" at the start of a turn, so a
 * turn opens with one label and a short pause between steps changes nothing.
 */
export const THINKING_LABEL_DELAY_MS = 3_000;

/**
 * The running label as the line shows it: it changes only to the next label
 * that has lasted, never for a moment. Each label holds for at least
 * {@link ACTIVITY_LABEL_HOLD_MS}, and a label that is replaced before its turn
 * comes is never shown at all. "Waiting for you" shows at once: the person
 * has something to answer. A line that is not running (a done summary) shows
 * its text as it is. `opensTurn`: the line is new and its turn has no step
 * yet, so it opens with "Starting…" rather than a "Thinking…" of a moment.
 */
export function useSteadyActivityLabel(text: string, live: boolean, opensTurn = false): string {
  // A turn with no step yet opens with "Starting…", as the row before it said.
  const [shown, setShown] = useState(() => (live && opensTurn && text === THINKING_LINE ? STARTING_LINE : text));
  const shownAt = useRef(Date.now());
  const target = useRef({ text, since: Date.now() });

  useEffect(() => {
    const now = Date.now();
    if (target.current.text !== text) {
      target.current = { text, since: now };
    }
    if (text === shown) {
      return;
    }
    const show = () => {
      shownAt.current = Date.now();
      setShown(text);
    };
    if (!live || text === WAITING_FOR_YOU_LINE) {
      show();
      return;
    }
    let showAt = shownAt.current + ACTIVITY_LABEL_HOLD_MS;
    if (text === THINKING_LINE) {
      showAt = Math.max(showAt, target.current.since + THINKING_LABEL_DELAY_MS);
    }
    if (showAt <= now) {
      show();
      return;
    }
    const timer = setTimeout(show, showAt - now);
    return () => clearTimeout(timer);
  }, [live, shown, text]);

  return live ? shown : text;
}
