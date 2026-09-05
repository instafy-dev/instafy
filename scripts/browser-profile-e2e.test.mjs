import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cargoTestArtifact, copyFixtureEntrypoint, fixtureChildEnvironment, installCancellationSignalHandlers, runOwnedProcess, validateBrowserFixtureEnvironment, validateFixtureEnvironment } from "./browser-profile-e2e.mjs";

test("profile lifecycle requires explicit Linux loopback fixture and display", () => {
  const fixture = { DISPLAY: ":99", TEST_DATABASE_URL: "postgresql://fixture@127.0.0.1:54322/postgres" };
  assert.doesNotThrow(() => validateFixtureEnvironment(fixture, "linux"));
  assert.throws(() => validateFixtureEnvironment(fixture, "darwin"));
  assert.throws(() => validateFixtureEnvironment({}, "linux"));
  for (const url of ["postgresql://fixture@prod.example:5432/postgres", "postgresql://fixture@localhost:54322/postgres", "postgresql://fixture@127.0.0.1/postgres", "postgresql://fixture@127.0.0.1:54322/postgres?host=prod.example"]) {
    assert.throws(() => validateFixtureEnvironment({ ...fixture, TEST_DATABASE_URL: url }, "linux"));
  }
});

test("fixture child environment never inherits credentials or policy overrides", () => {
  assert.deepEqual(fixtureChildEnvironment({ PATH: "/bin", HOME: "/tmp/inert", OPENAI_API_KEY: "must-not-copy", DATABASE_URL: "must-not-copy", INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV: "1", INSTAFY_ENV_DIR: "/private" }), { PATH: "/bin", HOME: "/tmp/inert" });
});

test("native fixture copies identical entrypoint bytes with executable mode without modifying the checkout", async () => {
  const source = new URL("../docker/runtime/entrypoint.sh", import.meta.url);
  const originalMode = (await stat(source)).mode;
  const owned = await mkdtemp(path.join(tmpdir(), "profile-entrypoint-test-"));
  try {
    const destination = await copyFixtureEntrypoint(owned);
    assert.equal(path.dirname(destination), owned);
    assert.deepEqual(await readFile(destination), await readFile(source));
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.equal((await stat(source)).mode, originalMode);
    await assert.rejects(copyFixtureEntrypoint(owned), { code: "EEXIST" });
  } finally {
    await rm(owned, { recursive: true });
  }
  await assert.rejects(stat(owned), { code: "ENOENT" });
});

test("browser helper rejects missing marker, arbitrary ports and unowned profile paths before connecting", () => {
  const fixture = { INSTAFY_PROFILE_E2E: "1", INSTAFY_PROFILE_E2E_RUN_ID: "00000000-0000-0000-0000-000000000000", INSTAFY_PROFILE_E2E_ROOT: "/tmp/inert-profile-fixture", INSTAFY_PLAYWRIGHT_PROFILE_DIR: "/tmp/inert-profile-fixture/profile", INSTAFY_PLAYWRIGHT_CDP_PORT: "9223" };
  assert.doesNotThrow(() => validateBrowserFixtureEnvironment(fixture, "linux"));
  assert.throws(() => validateBrowserFixtureEnvironment({}, "linux"), /fixture marker/);
  assert.throws(() => validateBrowserFixtureEnvironment({ ...fixture, INSTAFY_PLAYWRIGHT_CDP_PORT: "9223/elsewhere" }, "linux"));
  assert.throws(() => validateBrowserFixtureEnvironment({ ...fixture, INSTAFY_PLAYWRIGHT_CDP_PORT: "65536" }, "linux"));
  assert.throws(() => validateBrowserFixtureEnvironment({ ...fixture, INSTAFY_PLAYWRIGHT_PROFILE_DIR: "/tmp/unrelated-profile" }, "linux"));
});

test("exact compiled executable is required; zero/ambiguous test discovery fails", () => {
  const artifact = JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, target: { name: "browser_profile_e2e", kind: ["test"] }, executable: "/tmp/inert-test" });
  assert.equal(cargoTestArtifact(artifact, "browser_profile_e2e", "test"), "/tmp/inert-test");
  assert.throws(() => cargoTestArtifact("", "browser_profile_e2e", "test"));
  assert.throws(() => cargoTestArtifact(`${artifact}\n${artifact}`, "browser_profile_e2e", "test"));
  assert.throws(() => cargoTestArtifact(artifact, "different", "test"));
});

test("SIGINT and SIGTERM cancel the fixture and their handlers are removed", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const emitter = new EventEmitter();
    const cancellation = new AbortController();
    const remove = installCancellationSignalHandlers(cancellation, emitter);
    emitter.emit(signal);
    assert.equal(cancellation.signal.aborted, true);
    remove();
    assert.equal(emitter.listenerCount("SIGINT"), 0);
    assert.equal(emitter.listenerCount("SIGTERM"), 0);
  }
});

async function assertOwnedProcessStopped(pid) {
  for (let retry = 0; retry < 50; retry++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); return; }
    if (process.platform === "linux") {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 1).trimStart().startsWith("Z")) return;
      } catch (error) { if (error.code === "ENOENT") return; throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("owned disposable process survived cancellation/cleanup");
}

test("cancellation stops the owned build/test process group and descendants", async () => {
  const cancellation = new AbortController();
  let output = "";
  let ids;
  const helper = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);";
  await assert.rejects(runOwnedProcess(process.execPath, ["-e", helper], {
    env: fixtureChildEnvironment(process.env), signal: cancellation.signal, timeoutMs: 5_000,
    onOutput(data) {
      output += data;
      if (output.includes("\n")) { ids = JSON.parse(output.trim()); cancellation.abort(); }
    },
  }), { name: "AbortError" });
  assert.equal(ids.length, 2);
  for (const pid of ids) await assertOwnedProcessStopped(pid);
});

test("successful parent exit also cleans its owned orphan helper", async () => {
  const helper = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);child.unref();";
  const output = await runOwnedProcess(process.execPath, ["-e", helper], {
    env: fixtureChildEnvironment(process.env), timeoutMs: 5_000,
  });
  await assertOwnedProcessStopped(Number(output.trim()));
});
