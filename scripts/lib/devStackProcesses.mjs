// Which processes the dev launcher (scripts/run-e2e-dev.mjs) may stop, and how.
//
// Several checkouts and projects run their own controller and provider on one
// machine. The launcher stops only what it started itself: the pid it wrote to
// its pid file when it launched a service. It never looks a process up by its
// name (`pkill -f runtime-controller` stopped every project's controller) and
// never stops a process only because it holds the port.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Seconds from `ps -o etime=` (`[[dd-]hh:]mm:ss`), or NaN when it cannot be read. */
export function parseElapsedSeconds(etime) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? "").trim());
  if (!match) {
    return Number.NaN;
  }
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * Whether a process that has run for `elapsedSeconds` started no later than
 * its pid file was written (`recordedAtMs`), within ps's one-second
 * resolution. The launcher writes the pid file right after it spawns the
 * service, so a later start means the recorded process exited and the system
 * gave its pid to another program, possibly another project's controller with
 * the same command line.
 */
export function startedBeforeRecord({ elapsedSeconds, recordedAtMs, nowMs, slackMs = 2_000 }) {
  if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(recordedAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return nowMs - elapsedSeconds * 1_000 <= recordedAtMs + slackMs;
}

function psField(pid, field) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/**
 * Whether `pid` is still the service this checkout recorded in `pidFile`: its
 * command line names the service (`name`), and it started no later than the
 * pid file was written. A name alone cannot tell this checkout's controller
 * from another project's once the recorded pid has been reused.
 */
export function isRecordedService(pid, { pidFile, name, nowMs = Date.now() }) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (!psField(pid, "command").toLowerCase().includes(name)) {
    return false;
  }
  let recordedAtMs;
  try {
    recordedAtMs = fs.statSync(pidFile).mtimeMs;
  } catch {
    return false;
  }
  return startedBeforeRecord({ elapsedSeconds: parseElapsedSeconds(psField(pid, "etime")), recordedAtMs, nowMs });
}

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
 * - `isService(pid)`: whether that pid is still the service (`isRecordedService`).
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
