import { useEffect, useRef, useState } from "react";
import { THINKING_LINE, WAITING_FOR_YOU_LINE } from "./turnActivity";

/** A running label stays on screen at least this long, so a step that ends at once never flashes past. */
export const ACTIVITY_LABEL_HOLD_MS = 1_200;

/**
 * "Thinking…" shows only after this long with no step running. Until then the
 * line keeps the step before it, so a short pause between steps changes nothing.
 */
export const THINKING_LABEL_DELAY_MS = 3_000;

type ShownLabel = {
  text: string;
  /** When it went on screen. */
  at: number;
  /** A running label: the turn ran when it showed. A done line is not one. */
  live: boolean;
  /** It asks something of the person, so the next label never waits behind it. */
  asks: boolean;
};

function asksOfPerson(text: string, immediate: boolean): boolean {
  return immediate || text === WAITING_FOR_YOU_LINE;
}

/**
 * The running label as the line shows it: it changes only to the next label
 * that has lasted, never for a moment. Each label holds for at least
 * {@link ACTIVITY_LABEL_HOLD_MS}, and a label that is replaced before its turn
 * comes is never shown at all. The last one holds as long before the turn's
 * done line takes its place. A label that asks something of the person
 * ("Waiting for you", or one the caller marks `immediate`, such as the
 * runtime-busy notice) shows at once, and goes at once when it is answered.
 * A line that never ran (a done line, after a reload) shows its text as it is.
 */
export function useSteadyActivityLabel(text: string, live: boolean, immediate = false): string {
  const [shown, setShown] = useState<ShownLabel>(() => ({
    text,
    at: Date.now(),
    live,
    asks: asksOfPerson(text, immediate),
  }));
  const target = useRef({ text, since: Date.now() });

  useEffect(() => {
    const now = Date.now();
    if (target.current.text !== text) {
      target.current = { text, since: now };
    }
    if (text === shown.text && live === shown.live) {
      return;
    }
    const asks = asksOfPerson(text, immediate);
    const show = () => setShown({ text, at: Date.now(), live, asks });
    // "Waiting for you" comes and goes at once: the person has something to
    // answer, and once they did the line never says it still waits for them.
    // A line that was not running has nothing to hold.
    if (text === shown.text || asks || shown.asks || !shown.live) {
      show();
      return;
    }
    let showAt = shown.at + ACTIVITY_LABEL_HOLD_MS;
    if (live && text === THINKING_LINE) {
      showAt = Math.max(showAt, target.current.since + THINKING_LABEL_DELAY_MS);
    }
    if (showAt <= now) {
      show();
      return;
    }
    const timer = setTimeout(show, showAt - now);
    return () => clearTimeout(timer);
  }, [immediate, live, shown, text]);

  // While the turn runs, and until its last running label has held, the line
  // shows what has lasted; a line that never ran shows its text at once.
  return live || (shown.live && !shown.asks) ? shown.text : text;
}
