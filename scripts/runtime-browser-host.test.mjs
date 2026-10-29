// The runtime entrypoint's on-demand browser host (`start-browser-host`).
// Each case runs the real entrypoint in bash with fake X, window manager,
// egress proxy, Chromium and WebRTC sender binaries, so the host's own
// validation, ordering, environment allowlists, status lines and cleanup are
// exercised without Docker. scripts/runtime-image-browser-smoke.sh --lazy
// proves the same subcommand against a real image in CI.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const entrypointPath = path.join(repositoryRoot, "docker/runtime/entrypoint.sh");
const entrypoint = fs.readFileSync(entrypointPath, "utf8");
// Both runtime images ship util-linux's flock, so Linux runs use the real
// one and the one-host-per-state-directory test. macOS has none; there a
// stand-in that always grants the lock keeps the other cases running.
const realFlock = spawnSync("sh", ["-c", "command -v flock"]).status === 0;

function fakeBinaries(fixture) {
  const bin = path.join(fixture, "bin");
  fs.mkdirSync(bin);
  // Helpers run with a positive environment allowlist, so the fakes carry the
  // fixture directory in their own text rather than in the environment.
  const write = (name, body) => fs.writeFileSync(path.join(bin, name),
    `#!/bin/sh\nFIXTURE='${fixture}'\n${body}\n`, { mode: 0o755 });
  // Each long-lived fake records its pid, arguments and environment, then
  // becomes a sleep with that pid so SIGTERM stops it like the real process.
  const longLived = (name, extra = "") => write(name, `echo $$ > "$FIXTURE/${name}.pid"
printf '%s\\n' "$@" > "$FIXTURE/${name}.args"
env > "$FIXTURE/${name}.env"
${extra}
touch "$FIXTURE/${name}.up"
exec sleep 60`);
  longLived("Xtigervnc");
  longLived("fluxbox");
  longLived("browser-egress-proxy");
  longLived("browser-webrtc-sender");
  write("ffmpeg", "exit 0");
  if (!realFlock) write("flock", "exit 0");
  // The image's npm is not needed by the host; keep the entrypoint's
  // NODE_PATH probe fast and hermetic.
  write("npm", "exit 1");
  write("xdpyinfo", `[ "$FAKE_X" != "never" ] && [ -f "$FIXTURE/Xtigervnc.up" ]`);
  write("fake-chrome", `echo $$ > "$FIXTURE/chromium.pid"
printf '%s\\n' "$@" > "$FIXTURE/chromium.args"
env > "$FIXTURE/chromium.env"
(nice 2>/dev/null || echo unknown) > "$FIXTURE/chromium.nice"
(awk '{ print $5 }' /proc/$$/stat 2>/dev/null || echo unknown) > "$FIXTURE/chromium.pgid"
# Like Chromium's zygote and renderers: a descendant the host did not start.
sleep 60 &
echo $! > "$FIXTURE/renderer.pid"
case "$(cat "$FIXTURE/chromium.mode" 2>/dev/null)" in
  exits) exit 3 ;;
  crashes) touch "$FIXTURE/chromium.up"; sleep 1; exit 9 ;;
esac
touch "$FIXTURE/chromium.up"
exec sleep 60`);
  // Answers like the egress proxy, Chromium and the sender once their fake
  // process is up, and like a refused connection before that.
  write("curl", `for url; do :; done
case "$url" in
  *":$INSTAFY_BROWSER_HOST_EGRESS_PORT/healthz")
    [ "$FAKE_EGRESS" != "unhealthy" ] && [ -f "$FIXTURE/browser-egress-proxy.up" ] && printf '%s' '{"ok":true,"policy":"public-http-only"}' && exit 0 ;;
  *"/json/version")
    [ -f "$FIXTURE/chromium.up" ] && printf '%s' '{"Browser": "Chrome/152.0.0.0"}' && exit 0 ;;
  *"/healthz")
    [ -f "$FIXTURE/browser-webrtc-sender.up" ] && printf '%s' '{"ok":true}' && exit 0 ;;
esac
exit 7`);
  return bin;
}

let nextPort = 47100 + Math.floor(Math.random() * 400) * 10;

function hostEnvironment(fixture, bin, overrides = {}) {
  // Chromium runs with an allowlisted environment, so its fake reads its
  // behavior from the fixture.
  const { FAKE_CHROMIUM: chromiumMode, ...settings } = overrides;
  fs.writeFileSync(path.join(fixture, "chromium.mode"), chromiumMode ?? "runs");
  const base = nextPort;
  nextPort += 10;
  return {
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE: fixture,
    WORKSPACE_DIR: path.join(fixture, "workspace"),
    INSTAFY_BROWSER_HOST_HOME: path.join(fixture, "host-home"),
    INSTAFY_BROWSER_HOST_PROFILE_DIR: path.join(fixture, "persisted", "profile"),
    INSTAFY_BROWSER_HOST_STATE_DIR: path.join(fixture, "state"),
    INSTAFY_BROWSER_HOST_DISPLAY: ":47",
    INSTAFY_BROWSER_HOST_CDP_PORT: String(base),
    INSTAFY_BROWSER_HOST_VNC_PORT: String(base + 1),
    INSTAFY_BROWSER_HOST_EGRESS_PORT: String(base + 2),
    INSTAFY_BROWSER_HOST_CHROMIUM: path.join(bin, "fake-chrome"),
    // Shortens only the fake's readiness polling budget for failure cases.
    INSTAFY_CHROMIUM_CDP_READY_TIMEOUT_SECS: "5",
    ...settings,
  };
}

// Starts the host and resolves with its first status line, then lets the
// caller stop it and read how it ended.
function startHost(env) {
  const child = spawn("bash", [entrypointPath, "start-browser-host"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const firstStatus = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no status line within 20 s\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((value) => value.startsWith("instafy-browser-host: "));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((value) => value.startsWith("instafy-browser-host: "));
      if (line) resolve(line);
      else reject(new Error(`exited without a status line\nstderr: ${stderr}`));
    });
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    firstStatus,
    async finish() {
      const result = await exited;
      return { ...result, stdout, stderr };
    },
  };
}

function withFixture(run) {
  return async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-browser-host-"));
    try {
      await run(fixture, fakeBinaries(fixture));
    } finally {
      for (const name of ["Xtigervnc", "fluxbox", "browser-egress-proxy", "browser-webrtc-sender", "chromium", "renderer"]) {
        const pidFile = path.join(fixture, `${name}.pid`);
        if (fs.existsSync(pidFile)) {
          try {
            process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch {}
        }
      }
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  };
}

const read = (fixture, name) => fs.readFileSync(path.join(fixture, name), "utf8");
const alive = (fixture, name) => {
  try {
    process.kill(Number(read(fixture, `${name}.pid`)), 0);
    return true;
  } catch {
    return false;
  }
};
const envOf = (fixture, name) => new Map(read(fixture, `${name}.env`).trim().split("\n").map((line) => {
  const index = line.indexOf("=");
  return [line.slice(0, index), line.slice(index + 1)];
}));

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(label);
}

test("a started host reports ready, keeps a persisted profile and stops every child on SIGTERM", withFixture(async (fixture, bin) => {
  const env = hostEnvironment(fixture, bin, {
    INSTAFY_BROWSER_RENDER_SCALE: "2",
    INSTAFY_VNC_GEOMETRY: "1280x720",
    INSTAFY_BROWSER_VIEWPORT_ONLY: "1",
    // Values from the caller that no browser process may inherit.
    INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON: '[{"urls":["turns:turn.example.test:443"],"username":"u","credential":"c"}]',
    RUNTIME_ACCESS_TOKEN: "runtime-token-fixture",
    DATABASE_URL: "postgres://fixture",
  });
  // A profile saved by an earlier session on another machine: its sign-in
  // data must survive, and the foreign singleton lock must not block Chromium.
  fs.mkdirSync(env.INSTAFY_BROWSER_HOST_PROFILE_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.INSTAFY_BROWSER_HOST_PROFILE_DIR, "Cookies"), "signed-in");
  fs.symlinkSync("another-machine-4242", path.join(env.INSTAFY_BROWSER_HOST_PROFILE_DIR, "SingletonLock"));

  const host = startHost(env);
  const status = await host.firstStatus;
  assert.match(status, new RegExp(`^instafy-browser-host: ready display=:47 cdp=${env.INSTAFY_BROWSER_HOST_CDP_PORT} vnc=${env.INSTAFY_BROWSER_HOST_VNC_PORT} egress=${env.INSTAFY_BROWSER_HOST_EGRESS_PORT} webrtc=off scale=2\\.00 elapsed_ms=[0-9]+$`, "u"));

  // The caller's profile is used in place, not replaced or wiped.
  assert.equal(read(fixture, "persisted/profile/Cookies"), "signed-in");
  assert.equal(fs.existsSync(path.join(env.INSTAFY_BROWSER_HOST_PROFILE_DIR, "SingletonLock")), false);
  for (const directory of ["host-home", "persisted/profile", "state"]) {
    assert.equal(fs.statSync(path.join(fixture, directory)).mode & 0o777, 0o700, directory);
  }

  const chromiumArgs = read(fixture, "chromium.args").trim().split("\n");
  for (const flag of [
    `--user-data-dir=${env.INSTAFY_BROWSER_HOST_PROFILE_DIR}`,
    `--remote-debugging-port=${env.INSTAFY_BROWSER_HOST_CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--proxy-server=http://127.0.0.1:${env.INSTAFY_BROWSER_HOST_EGRESS_PORT}`,
    "--force-device-scale-factor=2.00",
    "--window-size=2560,1440",
    "--kiosk",
    "--disk-cache-size=67108864",
    "--password-store=basic",
  ]) {
    assert.ok(chromiumArgs.includes(flag), `${flag} in ${chromiumArgs.join(" ")}`);
  }
  assert.equal(chromiumArgs.at(-1), "about:blank");

  const xArgs = read(fixture, "Xtigervnc.args").trim().split("\n");
  assert.deepEqual(xArgs.slice(0, 3), [":47", "-rfbport", env.INSTAFY_BROWSER_HOST_VNC_PORT]);
  assert.ok(xArgs.includes("-localhost"));
  // Text copied or selected in the browser never reaches a viewer.
  assert.ok(xArgs.includes("-SendCutText=0"));
  assert.equal(envOf(fixture, "browser-egress-proxy").get("INSTAFY_BROWSER_EGRESS_PROXY_BIND"), `127.0.0.1:${env.INSTAFY_BROWSER_HOST_EGRESS_PORT}`);

  // Every helper gets the positive allowlist and this host's HOME and display.
  for (const name of ["Xtigervnc", "fluxbox", "browser-egress-proxy", "chromium"]) {
    const helper = envOf(fixture, name);
    assert.equal(helper.get("HOME"), env.INSTAFY_BROWSER_HOST_HOME, name);
    for (const secret of ["INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON", "RUNTIME_ACCESS_TOKEN", "DATABASE_URL", "FIXTURE"]) {
      assert.equal(helper.has(secret), false, `${name} received ${secret}`);
    }
  }
  assert.equal(envOf(fixture, "chromium").get("DISPLAY"), ":47");
  // The window manager's settings live under the host's HOME, never /root.
  assert.match(read(fixture, "host-home/.fluxbox/init"), /^session\.screen0\.rootCommand: \/bin\/true$/mu);
  // On Linux the host leads its own process group and runs the browser at
  // nice 10; other platforms have no setsid or portable niceness probe.
  if (process.platform === "linux") {
    assert.equal(read(fixture, "chromium.nice").trim(), "10");
    assert.equal(read(fixture, "chromium.pgid").trim(), String(host.child.pid));
    // The host itself re-executed without the TURN credentials: its own
    // environment, readable by any same-user process, no longer has them.
    const hostEnvironment = fs.readFileSync(`/proc/${host.child.pid}/environ`, "utf8").split("\0");
    assert.equal(hostEnvironment.some((entry) => entry.startsWith("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON=")), false);
    assert.ok(hostEnvironment.includes("RUNTIME_ACCESS_TOKEN=runtime-token-fixture"), "the caller's own allowlist is its responsibility");
  }

  for (const name of ["Xtigervnc", "fluxbox", "browser-egress-proxy", "chromium"]) assert.ok(alive(fixture, name), name);
  host.child.kill("SIGTERM");
  const ended = await host.finish();
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stdout, /^instafy-browser-host: stopped$/mu);
  for (const name of ["Xtigervnc", "fluxbox", "browser-egress-proxy", "chromium"]) assert.equal(alive(fixture, name), false, name);
  // Stopping the group also stops what the browser itself started.
  if (process.platform === "linux") assert.equal(alive(fixture, "renderer"), false, "renderer");
  // Stopping keeps the sign-ins for the next start.
  assert.equal(read(fixture, "persisted/profile/Cookies"), "signed-in");
}));

test("the WebRTC sender gets its own port and never the TURN credentials", withFixture(async (fixture, bin) => {
  const env = hostEnvironment(fixture, bin, {
    INSTAFY_BROWSER_WEBRTC_ENABLED: "1",
    INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN: "1",
    INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON: '[{"urls":["turns:turn.example.test:443"],"username":"u","credential":"c"}]',
  });
  env.INSTAFY_BROWSER_HOST_WEBRTC_PORT = String(Number(env.INSTAFY_BROWSER_HOST_CDP_PORT) + 3);
  const host = startHost(env);
  assert.match(await host.firstStatus, new RegExp(` webrtc=${env.INSTAFY_BROWSER_HOST_WEBRTC_PORT} `, "u"));
  const sender = envOf(fixture, "browser-webrtc-sender");
  assert.equal(sender.get("INSTAFY_BROWSER_WEBRTC_BIND"), `127.0.0.1:${env.INSTAFY_BROWSER_HOST_WEBRTC_PORT}`);
  assert.equal(sender.get("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"), "1");
  assert.equal(sender.get("DISPLAY"), ":47");
  assert.equal(sender.has("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"), false);
  host.child.kill("SIGTERM");
  assert.equal((await host.finish()).code, 0);
  assert.equal(alive(fixture, "browser-webrtc-sender"), false);
}));

test("invalid, reserved and shared settings fail before anything starts", withFixture(async (fixture, bin) => {
  fs.writeFileSync(path.join(fixture, "not-a-directory"), "");
  const cases = [
    [{ INSTAFY_BROWSER_HOST_PROFILE_DIR: "" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_PROFILE_DIR: "relative/profile" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_HOME: "/tmp/../root" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_DISPLAY: "1" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_CDP_PORT: "80" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_CDP_PORT: "1023" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_CDP_PORT: "65536" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_VNC_PORT: "47001", INSTAFY_BROWSER_HOST_EGRESS_PORT: "47001" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_WEBRTC_ENABLED: "1" }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_STATE_DIR: path.join(fixture, "not-a-directory", "state") }, "config_invalid", 64],
    [{ INSTAFY_BROWSER_HOST_DISPLAY: ":1" }, "port_reserved", 65],
    [{ INSTAFY_BROWSER_HOST_DISPLAY: ":01" }, "port_reserved", 65],
    [{ INSTAFY_BROWSER_HOST_CDP_PORT: "9223" }, "port_reserved", 65],
    [{ INSTAFY_BROWSER_HOST_VNC_PORT: "5900" }, "port_reserved", 65],
    [{ INSTAFY_BROWSER_HOST_EGRESS_PORT: "9226" }, "port_reserved", 65],
    [{ INSTAFY_BROWSER_HOST_CHROMIUM: path.join(fixture, "missing-chrome") }, "stack_missing", 67],
    [{ INSTAFY_BROWSER_EGRESS_ISOLATION: "0" }, "egress_unavailable", 68],
  ];
  for (const [overrides, reason, code] of cases) {
    const host = startHost(hostEnvironment(fixture, bin, overrides));
    assert.equal(await host.firstStatus, `instafy-browser-host: failed ${reason}`, JSON.stringify(overrides));
    const ended = await host.finish();
    assert.equal(ended.code, code, JSON.stringify(overrides));
    assert.equal(ended.stdout.trim().split("\n").length, 1, "exactly one status line");
    for (const name of ["Xtigervnc", "browser-egress-proxy", "chromium"]) {
      assert.equal(fs.existsSync(path.join(fixture, `${name}.pid`)), false, `${name} started for ${JSON.stringify(overrides)}`);
    }
  }
}));

test("a display or port that is already taken is reported, never taken over", withFixture(async (fixture, bin) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = String(server.address().port);
    const host = startHost(hostEnvironment(fixture, bin, { INSTAFY_BROWSER_HOST_VNC_PORT: port }));
    assert.equal(await host.firstStatus, "instafy-browser-host: failed port_in_use");
    assert.equal((await host.finish()).code, 66);
  } finally {
    server.close();
  }

  // A live X server owns display :46 (this test's own pid stands in for it);
  // its lock file is left alone.
  const lock = "/tmp/.X46-lock";
  if (process.platform === "linux" && !fs.existsSync(lock)) {
    fs.writeFileSync(lock, `${String(process.pid).padStart(10)}\n`);
    try {
      const host = startHost(hostEnvironment(fixture, bin, { INSTAFY_BROWSER_HOST_DISPLAY: ":46" }));
      assert.equal(await host.firstStatus, "instafy-browser-host: failed display_in_use");
      assert.equal((await host.finish()).code, 66);
      assert.ok(fs.existsSync(lock));
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  assert.equal(fs.existsSync(path.join(fixture, "Xtigervnc.pid")), false);
}));

test("a profile that a running Chromium on this machine holds is refused", withFixture(async (fixture, bin) => {
  if (process.platform !== "linux") return; // The owner check reads /proc.
  const env = hostEnvironment(fixture, bin);
  fs.mkdirSync(env.INSTAFY_BROWSER_HOST_PROFILE_DIR, { recursive: true });
  // A process named like Chromium on this host holds the lock. The kernel
  // names a process after the file it runs, so run sleep through a link.
  const holder = spawn("bash", ["-c", 'ln -s "$(command -v sleep)" "$1/chromium" && exec "$1/chromium" 30', "holder", fixture], { stdio: "ignore" });
  try {
    await waitUntil(() => {
      try {
        return fs.readFileSync(`/proc/${holder.pid}/comm`, "utf8").startsWith("chrom");
      } catch {
        return false;
      }
    }, "holder process did not start");
    fs.symlinkSync(`${os.hostname()}-${holder.pid}`, path.join(env.INSTAFY_BROWSER_HOST_PROFILE_DIR, "SingletonLock"));
    const host = startHost(env);
    assert.equal(await host.firstStatus, "instafy-browser-host: failed profile_in_use");
    assert.equal((await host.finish()).code, 66);
    assert.ok(fs.lstatSync(path.join(env.INSTAFY_BROWSER_HOST_PROFILE_DIR, "SingletonLock")).isSymbolicLink());
  } finally {
    holder.kill("SIGKILL");
  }
}));

test("start failures stop the helpers that already started", withFixture(async (fixture, bin) => {
  for (const [overrides, reason, code, started] of [
    [{ FAKE_EGRESS: "unhealthy" }, "egress_unavailable", 68, ["browser-egress-proxy"]],
    [{ FAKE_X: "never" }, "display_failed", 69, ["browser-egress-proxy", "Xtigervnc"]],
    [{ FAKE_CHROMIUM: "exits" }, "chromium_failed", 70, ["browser-egress-proxy", "Xtigervnc", "fluxbox"]],
    // A write that fails mid-start (here the window manager's settings
    // directory is a file) still ends with one status line.
    [{ INSTAFY_BROWSER_HOST_HOME: path.join(fixture, "broken-home") }, "host_error", 72, ["browser-egress-proxy", "Xtigervnc"]],
  ]) {
    for (const name of ["Xtigervnc", "fluxbox", "browser-egress-proxy", "chromium"]) fs.rmSync(path.join(fixture, `${name}.pid`), { force: true });
    for (const name of ["Xtigervnc", "browser-egress-proxy", "chromium"]) fs.rmSync(path.join(fixture, `${name}.up`), { force: true });
    fs.mkdirSync(path.join(fixture, "broken-home"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "broken-home", ".fluxbox"), "");
    const host = startHost(hostEnvironment(fixture, bin, overrides));
    assert.equal(await host.firstStatus, `instafy-browser-host: failed ${reason}`);
    const ended = await host.finish();
    assert.equal(ended.code, code, ended.stderr);
    assert.equal(ended.stdout.trim().split("\n").length, 1, `exactly one status line for ${reason}`);
    for (const name of started) {
      assert.ok(fs.existsSync(path.join(fixture, `${name}.pid`)), `${name} should have started for ${reason}`);
      assert.equal(alive(fixture, name), false, `${name} still runs after ${reason}`);
    }
  }
}));

test("a Chromium crash after ready ends the host and its helpers", withFixture(async (fixture, bin) => {
  const host = startHost(hostEnvironment(fixture, bin, { FAKE_CHROMIUM: "crashes" }));
  assert.match(await host.firstStatus, /^instafy-browser-host: ready /u);
  const ended = await host.finish();
  assert.equal(ended.code, 71, ended.stderr);
  assert.match(ended.stdout, /^instafy-browser-host: exited chromium$/mu);
  for (const name of ["Xtigervnc", "fluxbox", "browser-egress-proxy"]) assert.equal(alive(fixture, name), false, name);
}));

test("a second start on the same state directory is refused while the first runs", withFixture(async (fixture, bin) => {
  if (!realFlock) return; // The stand-in flock always grants the lock.
  const first = startHost(hostEnvironment(fixture, bin));
  assert.match(await first.firstStatus, /^instafy-browser-host: ready /u);
  const firstChromium = read(fixture, "chromium.pid");
  const second = startHost(hostEnvironment(fixture, bin, { INSTAFY_BROWSER_HOST_DISPLAY: ":48" }));
  assert.equal(await second.firstStatus, "instafy-browser-host: failed host_in_use");
  assert.equal((await second.finish()).code, 66);
  assert.equal(read(fixture, "chromium.pid"), firstChromium, "the second start launched Chromium");
  assert.ok(alive(fixture, "chromium"));
  first.child.kill("SIGTERM");
  assert.equal((await first.finish()).code, 0);
}));

test("the base image's boot path starts no display or browser, even with the browser session on", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-browser-boot-"));
  try {
    const bin = fakeBinaries(fixture);
    // Everything before the runtime-agent exec, as the image smoke runs it.
    const boot = path.join(fixture, "boot.sh");
    const lines = entrypoint.trimEnd().split("\n");
    assert.equal(lines.at(-1), "exec /usr/local/bin/runtime-agent");
    fs.writeFileSync(boot, `${lines.slice(0, -1).join("\n")}\necho boot-finished\n`);
    const result = spawnSync("bash", [boot], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: path.join(fixture, "home"),
        WORKSPACE_DIR: path.join(fixture, "workspace"),
        INSTAFY_RUNTIME_FLAVOR: "base",
        INSTAFY_ENABLE_BROWSER_SESSION: "1",
        RUNTIME_ID: "00000000-0000-4000-8000-00000000b5e3",
        // Keeps the boot-time egress proxy (which the base image may still
        // start, as before) out of this host's /tmp.
        INSTAFY_BROWSER_EGRESS_ISOLATION: "0",
        INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "boot-finished");
    assert.match(result.stderr, /the base image starts its browser only on demand/u);
    for (const name of ["Xtigervnc", "fluxbox", "chromium", "browser-webrtc-sender"]) {
      assert.equal(fs.existsSync(path.join(fixture, `${name}.pid`)), false, `${name} started at boot`);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the boot path still starts only the boot-time browser and execs runtime-agent", () => {
  const lines = entrypoint.trimEnd().split("\n");
  assert.equal(lines.at(-1), "exec /usr/local/bin/runtime-agent");
  assert.equal(lines.at(-3), "start_browser_session");
  // Subcommands are dispatched before the boot path and end the process.
  const lazy = entrypoint.indexOf('if [ "${1:-}" = "start-browser-host" ]; then\n  start_browser_host\nfi\n');
  const relaunch = entrypoint.indexOf('if [ "${1:-}" = "launch-chromium" ]; then');
  const boot = entrypoint.lastIndexOf("\nstart_browser_session\n");
  assert.ok(lazy > 0 && lazy < relaunch && relaunch < boot);
  // The lazy host never reuses the boot-time pid files, deletes X locks or
  // kills processes it did not start.
  const start = entrypoint.indexOf("readonly BROWSER_HOST_STATUS_PREFIX=");
  const host = entrypoint.slice(start, lazy);
  assert.ok(start > 0);
  for (const forbidden of ["pkill", "chromium_pid_file", "browser_egress_proxy_pid_file", "browser_webrtc_pid_file", ".X11-unix", "/root/", "cleanup_chromium_profile_locks", "ensure_browser_egress_proxy", "INSTAFY_BROWSER_ACTIONS_FILE"]) {
    assert.equal(host.includes(forbidden), false, `browser host uses ${forbidden}`);
  }
});

test("the boot-time and on-demand Chromium share one flag list", () => {
  const launches = [...entrypoint.matchAll(/env -i "\$\{MODEL_SAFE_ENV\[@\]\}" "\$\{chrome_path\}" \\\n {4}"\$\{CHROMIUM_LAUNCH_FLAGS\[@\]\}" \\\n/gu)];
  assert.equal(launches.length, 2);
  assert.equal([...entrypoint.matchAll(/--no-sandbox/gu)].length, 1);
});

// The display sends every RFB viewer the text copied or selected in the
// browser (the X clipboard and selection) unless told not to, and everyone who
// may watch the browser has an RFB lane: the view-only one needs only
// browser.view. No Instafy viewer reads that text, so no display sends it.
test("no display sends the browser's copied or selected text to its viewers", () => {
  // Each launch, with its flag lines up to the redirection.
  const launches = [...entrypoint.matchAll(/ Xtigervnc "\$\{DISPLAY\}" \\\n((?:[ \t]+-[^\n]*\\\n)+)/gu)];
  assert.equal(launches.length, 2);
  for (const [, flags] of launches) {
    assert.ok(flags.split("\n").map((line) => line.trim()).includes("-SendCutText=0 \\"), flags);
  }
});
