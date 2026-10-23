// What the Octo turn eval does with a case's space once its evidence is saved (docs/Octo-Turn-Eval.md).
//
// A case ends when its jobs settle or its time runs out. Work can outlive it: a lane still leased, a builder's
// continuation queued for later, a runtime the controller still has as requested. Stopping the space's containers
// with docker leaves all of that in the controller, which later wakes a runtime for it. So the eval deletes the
// space through the controller, the way a person deletes one: the delete cancels its queued and leased jobs and its
// queued messages, stops its runtimes and releases their leases, and the controller's sweep cancels anything that
// reaches the space after that. The eval then waits until the database shows nothing open and nothing running, and
// only then stops a container of the space that is somehow still up.
import { execFileSync } from "node:child_process";

import { DEFAULT_DB_URL } from "./octo-turn-grade.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Job statuses the controller still runs or will run. */
export const OPEN_JOB_STATUSES = ["queued", "leased"];
/** Runtime statuses that hold nothing: every other status (requested, ready, running, draining) is still live. */
export const RELEASED_RUNTIME_STATUSES = ["stopped", "offline", "removed"];

/** One row: how many of the space's jobs are open and how many of its runtimes are live. Read-only. */
export function spaceStateQuery(projectId) {
  if (!UUID_RE.test(String(projectId))) throw new Error(`not a project uuid: ${projectId}`);
  const list = (values) => values.map((value) => `'${value}'`).join(", ");
  return `select json_build_object(
    'openJobs', (select count(*) from agent_jobs where project_id = '${projectId}' and status in (${list(OPEN_JOB_STATUSES)})),
    'liveRuntimes', (select count(*) from runtimes where project_id = '${projectId}' and status not in (${list(RELEASED_RUNTIME_STATUSES)})))`;
}

export function readSpaceState({ projectId, dbUrl = process.env.OCTO_EVAL_DB_URL || DEFAULT_DB_URL }) {
  const out = execFileSync("psql", [dbUrl, "-tA", "-c", spaceStateQuery(projectId)], { encoding: "utf8" });
  const state = JSON.parse(out.trim());
  return { openJobs: Number(state.openJobs), liveRuntimes: Number(state.liveRuntimes) };
}

/** True when nothing of the space is open or running. */
export function spaceReleased(state) {
  return Boolean(state) && state.openJobs === 0 && state.liveRuntimes === 0;
}

/**
 * Ends a case: unless `keepSpace`, deletes the space through the controller, waits up to `timeoutMs` for the
 * database to show it released, then stops any container of the space still running. Returns what it did, for the
 * case's evidence.
 *
 * @param {{
 *   keepSpace?: boolean,
 *   deleteSpace: () => Promise<{ ok: boolean, status: number, error?: string }>,
 *   readState: () => { openJobs: number, liveRuntimes: number },
 *   listContainers: () => string[],
 *   stopContainers: (names: string[]) => string[],
 *   wait?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   pollMs?: number,
 * }} io
 */
export async function finishCase({
  keepSpace = false,
  deleteSpace,
  readState,
  listContainers,
  stopContainers,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 180_000,
  pollMs = 5_000,
}) {
  if (keepSpace) return { kept: true, deleted: false, released: false, state: safeRead(readState), stoppedContainers: [] };
  const started = now();
  const deleted = await deleteSpace().catch((error) => ({ ok: false, status: 0, error: String(error?.message ?? error) }));
  let state = safeRead(readState);
  if (deleted.ok) {
    while (!spaceReleased(state) && now() - started < timeoutMs) {
      await wait(pollMs);
      state = safeRead(readState);
    }
  }
  // The controller stops the space's runtimes; a container it did not reach is stopped here, never before.
  const leftover = listContainers();
  return {
    kept: false,
    deleted: deleted.ok,
    deleteStatus: deleted.status,
    ...(deleted.error ? { deleteError: deleted.error.slice(0, 200) } : {}),
    released: spaceReleased(state),
    state,
    waitedMs: now() - started,
    stoppedContainers: leftover.length ? stopContainers(leftover) : [],
  };
}

function safeRead(readState) {
  try {
    return readState();
  } catch (error) {
    return { openJobs: -1, liveRuntimes: -1, error: String(error?.message ?? error).slice(0, 200) };
  }
}
