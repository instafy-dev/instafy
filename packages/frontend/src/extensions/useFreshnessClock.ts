import { useEffect, useState } from "react";

/** The current time, read again every 30 seconds, for "how long ago" labels. */
export function useFreshnessClock() {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return nowMs;
}
