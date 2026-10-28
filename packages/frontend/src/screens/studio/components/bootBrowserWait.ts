import { sleepUnlessAborted } from "./sharedBrowserHostAttach";

/**
 * Instafy's browser on a browser session machine, started at boot: the
 * machine starts its Chromium again when it exits, and gives up after too
 * many exits. Its origin says which on the browser transports (503 with
 * `browser_restarting` or `browser_stopped`, see the origin's
 * `boot_browser`). An origin that predates this, or any other answer, says
 * nothing, and the view connects as before.
 */
export const BOOT_BROWSER_RESTARTING_CODE = "browser_restarting";
export const BOOT_BROWSER_STOPPED_CODE = "browser_stopped";

export type BootBrowserProbe = "running" | "restarting" | "stopped" | "unknown";

/** What a page read's error says about a boot-time browser. */
export function bootBrowserProbeFromError(error: unknown, isUnavailableError: (error: unknown) => boolean): BootBrowserProbe {
  if (!isUnavailableError(error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  if (code === BOOT_BROWSER_RESTARTING_CODE) return "restarting";
  if (code === BOOT_BROWSER_STOPPED_CODE) return "stopped";
  return "unknown";
}

/**
 * The wait for a restart is a little longer than the machine's own budget
 * for one start: its longest wait between exits (60 s) and Chromium's own
 * start (up to 30 s).
 */
export const BOOT_BROWSER_RESTART_WAIT_TIMEOUT_MS = 120_000;
export const BOOT_BROWSER_RESTART_POLL_MS = 2_000;

export type BootBrowserWaitResult =
  /** It runs, or the origin did not say: connect. */
  | { kind: "connect" }
  | { kind: "stopped" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/**
 * Before the view connects to a boot-time browser: reads once, and while the
 * machine is starting its Chromium again (`restarting`), reads every two
 * seconds until it runs, it gave up, or the wait ends. Anything the origin
 * does not say (`unknown`) lets the view connect as before.
 */
export async function waitForBootBrowserRunning(params: {
  probe: (signal?: AbortSignal) => Promise<BootBrowserProbe>;
  /** Called once, when the first read finds it restarting. */
  onRestarting?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}): Promise<BootBrowserWaitResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? sleepUnlessAborted;
  const pollMs = params.pollMs ?? BOOT_BROWSER_RESTART_POLL_MS;
  const deadline = now() + (params.timeoutMs ?? BOOT_BROWSER_RESTART_WAIT_TIMEOUT_MS);
  let announced = false;
  while (!params.signal?.aborted) {
    const probe = await params.probe(params.signal).catch((): BootBrowserProbe => "unknown");
    if (params.signal?.aborted) break;
    if (probe === "stopped") return { kind: "stopped" };
    if (probe !== "restarting") return { kind: "connect" };
    if (!announced) {
      announced = true;
      params.onRestarting?.();
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { kind: "timeout" };
    if (!(await sleep(Math.min(pollMs, remaining), params.signal))) break;
  }
  return { kind: "cancelled" };
}
