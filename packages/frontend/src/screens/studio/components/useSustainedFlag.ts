import { useEffect, useState } from "react";

/**
 * True once `value` has stayed true for `delayMs` without a break; false as
 * soon as it is false. A state that comes and goes faster than that never
 * shows, so a note such as "Reconnecting…" appears only for a loss that
 * lasts, and never flickers with the state it interrupts.
 */
export function useSustainedFlag(value: boolean, delayMs: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!value) {
      setSustained(false);
      return;
    }
    const timer = window.setTimeout(() => setSustained(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return value && sustained;
}
