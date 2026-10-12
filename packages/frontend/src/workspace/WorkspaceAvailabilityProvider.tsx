import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { probeWorkspaceAvailability } from "../services/runtimeController/workspaceAvailabilityProbe";

export type WorkspaceAvailabilityIssue = { kind: "connection" | "unavailable" | "access" };
export interface WorkspaceAvailabilityScope {
  projectId: string | null;
  originId?: string | null;
  runtimeId?: string | null;
  routing?: "legacy" | "default";
}
interface AvailabilityValue {
  issue: WorkspaceAvailabilityIssue | null;
  checking: boolean;
  recoveryVersion: number;
  reportFailure: () => void;
  retry: () => void;
}
const EMPTY = { issue: null, checking: false, recoveryVersion: 0 };
const fallback: AvailabilityValue = { ...EMPTY, reportFailure: () => {}, retry: () => {} };
const Context = createContext<AvailabilityValue>(fallback);

/** One read-only recovery owner per active space/origin. Never starts compute or replays writes. */
export function WorkspaceAvailabilityProvider({ scope, children }: { scope: WorkspaceAvailabilityScope; children: ReactNode }) {
  const { projectId, originId = null, runtimeId = null, routing = "legacy" } = scope;
  const key = JSON.stringify([projectId, originId, runtimeId, routing]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const inFlight = useRef<{ key: string; generation: number } | null>(null);
  const lastCheck = useRef<{ key: string; at: number } | null>(null);
  const attempts = useRef(0);
  const [state, setState] = useState<{ key: string; issue: WorkspaceAvailabilityIssue | null; checking: boolean; recoveryVersion: number }>({ key, ...EMPTY });
  const visible = state.key === key ? state : EMPTY;

  useEffect(() => {
    attempts.current = 0;
    return () => { generation.current += 1; };
  }, [key]);

  const check = useCallback(async (force: boolean) => {
    if (!projectId || currentKey.current !== key || (inFlight.current?.key === key && inFlight.current.generation === generation.current)) return;
    if (!force && lastCheck.current?.key === key && Date.now() - lastCheck.current.at < 5_000) return;
    const requestGeneration = generation.current;
    const request = { key, generation: requestGeneration };
    inFlight.current = request;
    lastCheck.current = { key, at: Date.now() };
    setState((previous) => ({ ...(previous.key === key ? previous : { key, ...EMPTY }), checking: true }));
    try {
      const result = await probeWorkspaceAvailability({ projectId, originId, runtimeId, routing });
      if (currentKey.current !== key || requestGeneration !== generation.current) return;
      attempts.current += 1;
      setState((previous) => {
        const current = previous.key === key ? previous : { key, ...EMPTY };
        if (result.kind === "available") {
          attempts.current = 0;
          return { key, issue: null, checking: false, recoveryVersion: current.recoveryVersion + (current.issue ? 1 : 0) };
        }
        // A feature-specific/unknown failure cannot prove that a prior outage recovered.
        return { ...current, checking: false, issue: result.kind === "unknown" ? current.issue : { kind: result.kind } };
      });
    } catch {
      // Unexpected client errors are not evidence that the whole workspace is offline.
      if (currentKey.current === key && requestGeneration === generation.current) {
        setState((previous) => ({ ...previous, checking: false }));
      }
    } finally {
      if (inFlight.current === request) inFlight.current = null;
    }
  }, [key, originId, projectId, routing, runtimeId]);
  const reportFailure = useCallback(() => { void check(false); }, [check]);
  const retry = useCallback(() => { void check(true); }, [check]);

  useEffect(() => {
    if (!visible.issue || visible.checking) return;
    // Permission failures need explicit recovery, not a stream of unauthorized requests.
    const timer = visible.issue.kind === "access" ? null : window.setTimeout(() => {
      if (document.visibilityState === "visible") retry();
    }, Math.min(60_000, 15_000 * Math.max(1, attempts.current)));
    const onResume = () => { if (document.visibilityState === "visible") retry(); };
    window.addEventListener("online", onResume);
    window.addEventListener("instafy:controller-stream-reconnected", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("online", onResume);
      window.removeEventListener("instafy:controller-stream-reconnected", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [retry, visible.checking, visible.issue]);

  const value = useMemo(() => ({ ...visible, reportFailure, retry }), [visible, reportFailure, retry]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWorkspaceAvailability() { return useContext(Context); }
