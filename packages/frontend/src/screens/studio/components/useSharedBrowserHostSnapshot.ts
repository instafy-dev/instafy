import { useCallback, useEffect, useRef, useState } from "react";
import { controllerClient } from "../../../sdk/instafy";
import type { SharedBrowserHostSnapshot } from "../../../services/runtimeController/browserSession";

/**
 * One reading of Instafy's browser on the space's machine (`GET browser/host`).
 * `snapshot` is null when the machine answered that it has none (404).
 * `fetchedAtMs` is when the reading was asked for, so it is never newer than
 * the state it shows.
 */
export type SharedBrowserHostReading = {
  snapshot: SharedBrowserHostSnapshot | null;
  fetchedAtMs: number;
};

export type SharedBrowserHostRefresh = (options?: { force?: boolean }) => Promise<SharedBrowserHostReading | null>;

/** Readings are at least this far apart, unless one is forced. */
export const SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS = 2_000;
/** How often a card waiting on the browser reads it again. */
export const SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS = 10_000;

type FetchHost = (params: {
  projectId: string;
  runtimeId: string;
  browserSessionId: string;
}) => Promise<SharedBrowserHostSnapshot | null>;

type Options = {
  projectId: string | null;
  /** The conversation's own machine, whose browser this reads. */
  runtimeId: string | null;
  /** The browser surface's session id, as the browser view sends it. */
  browserSessionId: string;
  /**
   * Only for a covered space whose conversation machine is a live host, and
   * only while Studio may start cards by itself.
   */
  enabled: boolean;
  /** Read again every ten seconds while the page is visible (a card is waiting). */
  poll: boolean;
  /** Tests only. */
  fetchHost?: FetchHost;
};

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

const defaultFetchHost: FetchHost = (params) => controllerClient.browserSessions.fetchHost(params);

/**
 * The last reading of Instafy's browser on the conversation's machine, for
 * deciding whether Studio may open it by itself. `refresh()` is single-flight
 * and reads at most once every two seconds; `refresh({force: true})` reads
 * now, even while another reading is in flight, and the newest reading asked
 * for wins. A failed reading (gateway or token error) keeps the last one and
 * resolves to null.
 */
export function useSharedBrowserHostSnapshot(options: Options) {
  const { projectId, runtimeId, browserSessionId, enabled, poll } = options;
  const key = enabled && projectId && runtimeId ? `${projectId}\n${runtimeId}\n${browserSessionId}` : null;
  const [state, setState] = useState<{ key: string; reading: SharedBrowserHostReading } | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const paramsRef = useRef({ projectId, runtimeId, browserSessionId });
  paramsRef.current = { projectId, runtimeId, browserSessionId };
  const fetchHostRef = useRef(options.fetchHost ?? defaultFetchHost);
  fetchHostRef.current = options.fetchHost ?? defaultFetchHost;
  const flight = useRef<{
    key: string | null;
    inFlight: Promise<SharedBrowserHostReading | null> | null;
    lastStartedAt: number;
    last: SharedBrowserHostReading | null;
    sequence: number;
    applied: number;
  }>({ key: null, inFlight: null, lastStartedAt: 0, last: null, sequence: 0, applied: 0 });

  if (flight.current.key !== key) {
    flight.current = {
      key,
      inFlight: null,
      lastStartedAt: 0,
      last: null,
      sequence: flight.current.sequence,
      applied: flight.current.sequence,
    };
  }

  const refresh = useCallback<SharedBrowserHostRefresh>((refreshOptions) => {
    const requestKey = keyRef.current;
    const params = paramsRef.current;
    if (!requestKey || !params.projectId || !params.runtimeId) return Promise.resolve(null);
    const current = flight.current;
    const now = Date.now();
    if (!refreshOptions?.force) {
      if (current.inFlight) return current.inFlight;
      if (current.last && now - current.lastStartedAt < SHARED_BROWSER_HOST_REFRESH_MIN_GAP_MS) {
        return Promise.resolve(current.last);
      }
    }
    current.sequence += 1;
    const sequence = current.sequence;
    current.lastStartedAt = now;
    const promise = fetchHostRef.current({
      projectId: params.projectId,
      runtimeId: params.runtimeId,
      browserSessionId: params.browserSessionId,
    }).then(
      (snapshot): SharedBrowserHostReading | null => {
        if (!mounted.current || keyRef.current !== requestKey || flight.current !== current) return null;
        const reading = { snapshot, fetchedAtMs: now };
        if (sequence > current.applied) {
          current.applied = sequence;
          current.last = reading;
          setState({ key: requestKey, reading });
        }
        return reading;
      },
      () => null,
    ).finally(() => {
      if (current.inFlight === promise) current.inFlight = null;
    });
    current.inFlight = promise;
    return promise;
  }, []);

  const [visible, setVisible] = useState(isDocumentVisible);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(isDocumentVisible());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!key || !poll || !visible) return;
    const timer = window.setInterval(() => { void refresh(); }, SHARED_BROWSER_HOST_SNAPSHOT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [key, poll, refresh, visible]);


  const reading = state && state.key === key ? state.reading : null;
  return {
    snapshot: reading?.snapshot ?? null,
    fetchedAtMs: reading?.fetchedAtMs ?? null,
    refresh,
  };
}
