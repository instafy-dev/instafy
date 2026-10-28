import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ownedServicePids, stopOwnedService } from "./devStackProcesses.mjs";

test("only the recorded pid and its process group's listeners are this checkout's", () => {
  const listeners = [
    { pid: 4321, pgid: 4321 },
    { pid: 4330, pgid: 4321 },
    // Another checkout's or project's controller on the same port.
    { pid: 5100, pgid: 5100 },
  ];
  assert.deepEqual(ownedServicePids({ recordedPid: 4321, recordedIsService: true, listeners }), [4321, 4330]);
  assert.deepEqual(ownedServicePids({ recordedPid: 4321, recordedIsService: true, listeners: [] }), [4321]);
  // Nothing recorded: nothing is ours, whatever holds the port.
  assert.deepEqual(ownedServicePids({ recordedPid: 0, recordedIsService: false, listeners }), []);
  assert.deepEqual(ownedServicePids({ recordedPid: Number.NaN, recordedIsService: true, listeners }), []);
  // The recorded pid is now some other program: the record is stale.
  assert.deepEqual(ownedServicePids({ recordedPid: 4321, recordedIsService: false, listeners }), []);
});

test("nothing is signalled when this checkout started nothing", async () => {
  const signals = [];
  const result = await stopOwnedService({
    recordedPid: 0,
    isService: () => true,
    listeners: () => [{ pid: 5100, pgid: 5100 }],
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      return true;
    },
    wait: async () => {},
  });
  assert.deepEqual(result, { pids: [], stopped: false });
  assert.deepEqual(signals, []);
});

test("a service that ignores SIGINT gets SIGTERM, then SIGKILL, and only its own pids do", async () => {
  const alive = new Set([4321, 4330, 5100]);
  const signals = [];
  const result = await stopOwnedService({
    recordedPid: 4321,
    isService: (pid) => pid === 4321,
    listeners: () => [{ pid: 4330, pgid: 4321 }, { pid: 5100, pgid: 5100 }],
    kill: (pid, signal) => {
      if (!alive.has(pid)) return false;
      if (signal !== 0) signals.push([pid, signal]);
      if (signal === "SIGKILL") alive.delete(pid);
      return true;
    },
    wait: async () => {},
    graceMs: 3,
    pollMs: 1,
  });
  assert.deepEqual(result, { pids: [4321, 4330], stopped: true });
  assert.deepEqual(signals, [
    [4321, "SIGINT"], [4330, "SIGINT"],
    [4321, "SIGTERM"], [4330, "SIGTERM"],
    [4321, "SIGKILL"], [4330, "SIGKILL"],
  ]);
  assert.ok(alive.has(5100), "another project's controller keeps running");
});

// Real processes whose command lines say "runtime-controller", as every
// project's controller does. `pkill -f runtime-controller` stopped them all.
function commandOf(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
function groupOf(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
  return Number.parseInt(result.stdout.trim(), 10);
}
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function kill(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
const idle = "setInterval(() => {}, 1000);";
// Like `cargo run`: a detached leader whose binary runs in its process group.
const leader =
  `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(idle)}, "runtime-controller"], { stdio: "ignore" });` +
  `process.stdout.write(String(child.pid) + "\\n"); ${idle}`;

test("stopping this checkout's controller leaves another project's controller running", { skip: process.platform === "win32" }, async (t) => {
  const started = [];
  t.after(() => {
    for (const pid of started) kill(pid, "SIGKILL");
  });
  const ours = spawn(process.execPath, ["-e", leader, "runtime-controller"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  started.push(ours.pid);
  const binary = await new Promise((resolve, reject) => {
    ours.stdout.once("data", (chunk) => resolve(Number.parseInt(String(chunk), 10)));
    ours.once("error", reject);
  });
  started.push(binary);
  const theirs = spawn(process.execPath, ["-e", idle, "runtime-controller"], { detached: true, stdio: "ignore" });
  started.push(theirs.pid);
  assert.match(commandOf(theirs.pid), /runtime-controller/);
  assert.equal(groupOf(binary), ours.pid, "the binary runs in the recorded pid's process group");

  const result = await stopOwnedService({
    recordedPid: ours.pid,
    isService: (pid) => commandOf(pid).includes("runtime-controller"),
    // Both listen on the controller's port, as when another project's
    // controller took it while this one was down.
    listeners: () => [binary, theirs.pid].map((pid) => ({ pid, pgid: groupOf(pid) })),
    kill,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs: 20,
  });

  assert.deepEqual(result.pids.sort(), [ours.pid, binary].sort());
  assert.equal(result.stopped, true);
  assert.equal(isRunning(binary), false);
  assert.equal(isRunning(theirs.pid), true, "another project's controller is never stopped");
});

test("the dev launcher never looks up a process to stop by its name", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "run-e2e-dev.mjs"), "utf8");
  assert.doesNotMatch(source, /\b(pkill|pgrep|killall)\b/);
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, name);
    const next = source.indexOf("\nasync function ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };
  for (const name of ["stopOwnedController", "stopOwnedProvider"]) {
    assert.match(body(name), /stopOwnedService\(/, name);
  }
  for (const name of ["stopControllerInternal", "stopControllerIfWeStarted", "clearControllerPortForPrebuiltLaunch"]) {
    assert.doesNotMatch(body(name), /killPid|process\.kill|listListeningPidsByPort/, name);
  }
  for (const name of ["stopProviderService", "clearProviderPortForPrebuiltLaunch"]) {
    assert.doesNotMatch(body(name), /killPid|process\.kill/, name);
  }
  // A provider this checkout did not start is not recorded as its own.
  assert.doesNotMatch(body("startProviderService"), /writeProviderPid\(existingPid\)/);
});
