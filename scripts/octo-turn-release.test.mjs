import { test } from "node:test";
import assert from "node:assert/strict";

import { finishCase, spaceReleased, spaceStateQuery } from "./octo-turn-release.mjs";

const PROJECT = "11111111-2222-4333-8444-555555555555";

/** A fake controller and machine: the delete releases the space after `releaseAfterPolls` reads. */
function world({ deleteStatus = 204, releaseAfterPolls = 1, containers = ["instafy-runtime-x-1"], containerOutlivesRelease = false } = {}) {
  const calls = [];
  let deleted = false;
  let reads = 0;
  let running = [...containers];
  return {
    calls,
    io: {
      deleteSpace: async () => {
        calls.push("delete");
        deleted = deleteStatus < 300;
        return { ok: deleted, status: deleteStatus, ...(deleted ? {} : { error: "forbidden" }) };
      },
      readState: () => {
        calls.push("read");
        // Before the delete a stopped case still has a queued continuation and a requested runtime.
        if (!deleted) return { openJobs: 1, liveRuntimes: 1 };
        reads += 1;
        const released = reads > releaseAfterPolls;
        if (released && !containerOutlivesRelease) running = [];
        return released ? { openJobs: 0, liveRuntimes: 0 } : { openJobs: 1, liveRuntimes: 1 };
      },
      listContainers: () => {
        calls.push("list");
        return running;
      },
      stopContainers: (names) => {
        calls.push(`stop:${names.join(",")}`);
        running = [];
        return names;
      },
      wait: async () => { calls.push("wait"); },
    },
  };
}

test("a finished case deletes its space through the controller and waits until nothing of it is open or running", async () => {
  const { calls, io } = world({ releaseAfterPolls: 2 });
  const result = await finishCase(io);
  assert.equal(calls[0], "delete", "the controller acts first, never docker");
  assert.ok(!calls.some((call) => call.startsWith("stop:")), "the controller stopped the runtime; nothing is stopped behind its back");
  assert.equal(result.deleted, true);
  assert.equal(result.released, true);
  assert.deepEqual(result.state, { openJobs: 0, liveRuntimes: 0 });
  assert.deepEqual(result.stoppedContainers, []);
  assert.equal(calls.filter((call) => call === "wait").length, 2);
});

test("a container still up once the controller released the space is stopped after the release, not before", async () => {
  const { calls, io } = world({ containerOutlivesRelease: true });
  const result = await finishCase(io);
  assert.equal(result.released, true);
  assert.deepEqual(result.stoppedContainers, ["instafy-runtime-x-1"]);
  assert.ok(calls.indexOf("stop:instafy-runtime-x-1") > calls.lastIndexOf("read"));
});

test("a refused delete is recorded and not reported as released", async () => {
  const { io } = world({ deleteStatus: 403 });
  const result = await finishCase(io);
  assert.equal(result.deleted, false);
  assert.equal(result.deleteStatus, 403);
  assert.equal(result.released, false);
  assert.deepEqual(result.state, { openJobs: 1, liveRuntimes: 1 });
});

test("a space that does not release in time is reported with what is still open", async () => {
  const { io } = world({ releaseAfterPolls: 1_000 });
  let clock = 0;
  const result = await finishCase({ ...io, now: () => clock, wait: async (ms) => { clock += ms; }, timeoutMs: 20_000, pollMs: 5_000 });
  assert.equal(result.released, false);
  assert.deepEqual(result.state, { openJobs: 1, liveRuntimes: 1 });
  assert.ok(result.waitedMs >= 20_000);
});

test("keeping the space for a readback deletes and stops nothing", async () => {
  const { calls, io } = world();
  const result = await finishCase({ ...io, keepSpace: true });
  assert.equal(result.kept, true);
  assert.ok(!calls.includes("delete") && !calls.some((call) => call.startsWith("stop:")));
});

test("a requested runtime and a queued continuation both count as not released", () => {
  const sql = spaceStateQuery(PROJECT);
  assert.match(sql, /status in \('queued', 'leased'\)/);
  assert.match(sql, /status not in \('stopped', 'offline', 'removed'\)/);
  assert.equal(spaceReleased({ openJobs: 0, liveRuntimes: 1 }), false);
  assert.equal(spaceReleased({ openJobs: 1, liveRuntimes: 0 }), false);
  assert.equal(spaceReleased({ openJobs: 0, liveRuntimes: 0 }), true);
  assert.throws(() => spaceStateQuery("x'; drop table runtimes; --"), /not a project uuid/);
});
