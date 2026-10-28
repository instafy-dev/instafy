// Which processes the dev launcher (scripts/run-e2e-dev.mjs) may stop, and how.
//
// Several checkouts and projects run their own controller and provider on one
// machine. The launcher stops only what it started itself: the pid it wrote to
// its pid file when it launched a service. It never looks a process up by its
// name (`pkill -f runtime-controller` stopped every project's controller) and
// never stops a process only because it holds the port.

/**
 * The pids to stop for one service this checkout started: the recorded pid,
 * while it is still that service, and the listeners on the service's port that
 * are that pid or in its process group (each service is started detached, so
 * `cargo run` and the binary it runs share the recorded pid as their group).
 * Empty when nothing is recorded, or when the recorded pid is now some other
 * program. `listeners` is `[{ pid, pgid }]` for the port.
 */
export function ownedServicePids({ recordedPid, recordedIsService, listeners }) {
  if (!Number.isInteger(recordedPid) || recordedPid <= 0 || !recordedIsService) {
    return [];
  }
  const pids = new Set([recordedPid]);
  for (const { pid, pgid } of listeners ?? []) {
    if (Number.isInteger(pid) && pid > 0 && (pid === recordedPid || pgid === recordedPid)) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/**
 * Stops the service this checkout started, and nothing else: SIGINT, then
 * SIGTERM, then SIGKILL to `ownedServicePids`, each followed by up to
 * `graceMs` for those pids to exit. Returns `{ pids, stopped }`. `pids` is
 * empty, and nothing is signalled, when this checkout started nothing that is
 * still running; `stopped` says every one of `pids` has exited.
 *
 * - `recordedPid`: the pid from the service's pid file (0 when there is none).
 * - `isService(pid)`: whether that pid is still the service (its command line).
 * - `listeners()`: `[{ pid, pgid }]` listening on the service's port.
 * - `kill(pid, signal)`: sends `signal` (0 only checks); false when the pid is gone.
 * - `onStop(pids)`: called once, before the first signal.
 */
export async function stopOwnedService({
  recordedPid,
  isService,
  listeners = () => [],
  kill,
  wait,
  graceMs = 5_000,
  pollMs = 100,
  onStop,
}) {
  const recorded = Number.isInteger(recordedPid) && recordedPid > 0;
  const pids = ownedServicePids({
    recordedPid,
    recordedIsService: recorded && isService(recordedPid),
    listeners: recorded ? listeners() : [],
  });
  if (pids.length === 0) {
    return { pids, stopped: false };
  }
  onStop?.(pids);
  const running = () => pids.filter((pid) => kill(pid, 0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
    for (const pid of running()) {
      kill(pid, signal);
    }
    for (let waited = 0; waited < graceMs && running().length > 0; waited += pollMs) {
      await wait(pollMs);
    }
    if (running().length === 0) {
      return { pids, stopped: true };
    }
  }
  return { pids, stopped: running().length === 0 };
}
