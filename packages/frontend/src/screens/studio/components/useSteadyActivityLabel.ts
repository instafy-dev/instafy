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
 * comes is never shown at all. A label that asks something of the person
 * ("Waiting for you", or one the caller marks `immediate`, such as the
 * runtime-busy notice) shows at once, and goes at once when it is answered.
 * A line that is not running (a done summary) shows its text as it is.
 * `opensTurn`: the line is new and its turn has no step yet, so it opens with
 * "Starting…" rather than a "Thinking…" of a moment.
 */
export function useSteadyActivityLabel(text: string, live: boolean, opensTurn = false, immediate = false): string {
  // A turn with no step yet opens with "Starting…", as the row before it said.
  const [shown, setShown] = useState(() => (live && opensTurn && text === THINKING_LINE ? STARTING_LINE : text));
  const shownAt = useRef(Date.now());
  const target = useRef({ text, since: Date.now() });
  // The label on screen asks something of the person, so the next one never waits behind it.
  const shownAsks = useRef(immediate || text === WAITING_FOR_YOU_LINE);

  useEffect(() => {
    const now = Date.now();
    if (target.current.text !== text) {
      target.current = { text, since: now };
    }
    if (text === shown) {
      return;
    }
    const asks = immediate || text === WAITING_FOR_YOU_LINE;
    const show = () => {
      shownAt.current = Date.now();
      shownAsks.current = asks;
      setShown(text);
    };
    // "Waiting for you" comes and goes at once: the person has something to
    // answer, and once they did the line never says it still waits for them.
    if (!live || asks || shownAsks.current) {
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
  }, [immediate, live, shown, text]);

  return live ? shown : text;
}
