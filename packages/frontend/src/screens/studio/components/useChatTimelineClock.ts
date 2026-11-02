import { useEffect, useRef, useState } from "react";

/** One clock per transcript for local-calendar labels such as Today/Yesterday. */
export function useChatTimelineClock(): number {
  const [now, setNow] = useState(() => Date.now());
  const initialNow = useRef(now);

  useEffect(() => {
    let timer: number | undefined;
    const scheduleNextMidnight = (current: number) => {
      window.clearTimeout(timer);
      const nextMidnight = new Date(current);
      // Calendar arithmetic, not a fixed 24 hours: daylight saving changes
      // the elapsed time until the next local day.
      nextMidnight.setHours(24, 0, 0, 0);
      timer = window.setTimeout(refresh, Math.max(1, nextMidnight.getTime() - current));
    };
    const refresh = () => {
      const current = Date.now();
      setNow(current);
      scheduleNextMidnight(current);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    const current = Date.now();
    // Mounting a large transcript can take a few milliseconds. Scheduling
    // its clock must not rerender every row unless the local day changed.
    if (new Date(initialNow.current).toDateString() !== new Date(current).toDateString()) {
      setNow(current);
    }
    scheduleNextMidnight(current);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return now;
}
