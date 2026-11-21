import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// A foreground `instafy runtime start` whose agent exits because its machine lifetime ended (status 4)
// mints a new runtime token and starts the agent again. These run the built CLI against a controller
// that holds that second mint open until a test answers it, so a stop can land while it mints. Each
// runtime gets its own copy of the CLI, in a folder where the process runner finds a stand-in
// runtime-agent, and a stand-in `docker` is first on PATH for the Docker runner. Neither starts
// anything real, and the cleanup signals only the processes they record, each by its own pid.

type Mode = "docker" | "process";
type Exit = { code: number | null; signal: NodeJS.Signals | null };

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtCli = path.join(packageRoot, "dist", "cli.js");
const accessToken = "person-session";

const FAKE_DOCKER = `#!/bin/sh
# Logs each call and starts nothing. The first container's agent has exited because its machine
# lifetime ended (status 4); a later one runs until it is removed.
for arg; do last=$arg; done
echo "$1 $last" >> "$FAKE_DOCKER_LOG"
removed="$FAKE_DOCKER_LOG.removed-$last"
case "$1" in
  run)
    if [ -e "$FAKE_DOCKER_LOG.ran" ]; then echo fake-container-2; else : > "$FAKE_DOCKER_LOG.ran"; echo fake-container-1; fi ;;
  logs)
    # Follows a running container until it is removed, for 20 seconds at most.
    if [ "$last" != fake-container-1 ]; then
      echo "$$" >> "$FAKE_DOCKER_LOG.followers"
      i=0
      while [ ! -e "$removed" ] && [ "$i" -lt 400 ]; do sleep 0.05; i=$((i + 1)); done
    fi ;;
  inspect)
    if [ -e "$removed" ]; then exit 1; fi
    case "$last:$3" in
      fake-container-1:*ExitCode*)
        # When asked, a racing runtime stop clears the runtime's state as this reads how it exited.
        if [ -n "$FAKE_DOCKER_CLEAR_STATE" ]; then rm -f "$FAKE_DOCKER_CLEAR_STATE"; fi
        echo "false 4" ;;
      fake-container-1:*) echo false ;;
      *ExitCode*) echo "true 0" ;;
      *) echo true ;;
    esac ;;
  rm)
    : > "$removed" ;;
esac
exit 0
`;

const FAKE_AGENT = `#!/bin/sh
# The first agent exits because its machine lifetime ended (status 4); a later one runs. When asked,
# the first clears the runtime's state as it exits, as a racing runtime stop would, or removes its
# own binary first.
echo "$$" >> "$FAKE_AGENT_LOG"
if [ -e "$FAKE_AGENT_LOG.ran" ]; then exec sleep 20; fi
: > "$FAKE_AGENT_LOG.ran"
if [ -n "$FAKE_AGENT_CLEAR_STATE" ]; then rm -f "$FAKE_AGENT_CLEAR_STATE"; fi
if [ -n "$FAKE_AGENT_REMOVE_SELF" ]; then rm -f "$0"; fi
exit 4
`;

/** Signals one process. 0 and negative pids name process groups, or every process, so they never get here. */
function killProcess(pid: number, signal: NodeJS.Signals) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`refusing to signal pid ${pid}`);
  }
  process.kill(pid, signal);
}

/** A copy of the built CLI in `root`, where the process runner finds the stand-in runtime-agent, and the stand-in docker. */
function install(root: string, agentMode: number) {
  const cliRoot = path.join(root, "packages", "instafy-cli");
  fs.mkdirSync(path.join(cliRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(cliRoot, "dist"), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(cliRoot, "package.json"));
  fs.copyFileSync(path.join(packageRoot, "bin", "instafy.js"), path.join(cliRoot, "bin", "instafy.js"));
  fs.copyFileSync(builtCli, path.join(cliRoot, "dist", "cli.js"));
  fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(cliRoot, "node_modules"), "dir");
  // Where the process runner looks for runtime-agent, from the CLI's own folder.
  const agent = path.join(root, "target", "debug", "runtime-agent");
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, FAKE_AGENT);
  fs.chmodSync(agent, agentMode);
  const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "docker"), FAKE_DOCKER);
  fs.chmodSync(path.join(fakeBin, "docker"), 0o755);
  return { cli: path.join(cliRoot, "bin", "instafy.js"), fakeBin };
}

/** A controller that answers the first start's mint and holds every later one until it is answered. */
async function startController(spaceId: string, runtimeId: string) {
  const held: http.ServerResponse[] = [];
  let mints = 0;
  const answer = (res: http.ServerResponse, n: number) => {
    const token = [
      "header",
      Buffer.from(JSON.stringify({ runtime_id: runtimeId, n })).toString("base64url"),
      "signature",
    ].join(".");
    try {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token, runtimeId }));
    } catch {
      // The CLI that asked is gone.
    }
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST" && req.url === `/projects/${spaceId}/runtime/token`) {
        mints += 1;
        if (mints === 1) {
          answer(res, mints);
        } else {
          held.push(res);
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    mints: () => mints,
    answerHeld: () => {
      for (const res of held.splice(0)) answer(res, 2);
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

async function exitWithin(exit: Promise<Exit>, timeoutMs: number): Promise<Exit | null> {
  return Promise.race([exit, delay(timeoutMs).then(() => null)]);
}

type RuntimeOptions = {
  /** The stand-in runtime-agent's file mode: without its execute bits, it cannot be spawned. */
  agentMode?: number;
  /** The first agent runs, rather than exiting because its lifetime ended. */
  agentRuns?: boolean;
  /** As the first agent exits, the runtime's state is cleared, as a racing `runtime stop` would. */
  stateClearedAsItExits?: boolean;
  /** The first agent removes its own binary before it exits. */
  agentBinaryRemoved?: boolean;
};

/** A folder of its own for `runtime start`, with its own controller, home and copy of the CLI. */
async function prepareRuntime(mode: Mode, options: RuntimeOptions = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-lifetime-stop-"));
  const home = path.join(work, "home");
  const cwd = path.join(work, "cwd");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const { cli, fakeBin } = install(path.join(work, "install"), options.agentMode ?? 0o755);
  const spaceId = randomUUID();
  const runtimeId = randomUUID();
  const controller = await startController(spaceId, runtimeId);
  const dockerLog = path.join(work, "docker.log");
  const agentLog = path.join(work, "agent.log");
  const stateFile = path.join(home, ".instafy", "cli-runtime-state.json");
  if (options.agentRuns) {
    fs.writeFileSync(`${agentLog}.ran`, "");
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    INSTAFY_RUNTIME_AGENT_IMAGE: "instafy-runtime-agent:lifetime-stop-test",
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_AGENT_LOG: agentLog,
    ...(options.stateClearedAsItExits
      ? { FAKE_AGENT_CLEAR_STATE: stateFile, FAKE_DOCKER_CLEAR_STATE: stateFile }
      : {}),
    ...(options.agentBinaryRemoved ? { FAKE_AGENT_REMOVE_SELF: "1" } : {}),
  };
  const startArgs = [
    "runtime",
    "start",
    "--space",
    spaceId,
    "--server-url",
    controller.url,
    "--access-token",
    accessToken,
    "--runtime-mode",
    mode,
    "--workspace",
    path.join(work, "workspace"),
    // A process runner needs no tunnel then.
    ...(mode === "process" ? ["--origin-endpoint", "http://127.0.0.1:9"] : []),
  ];
  const logLines = (log: string) =>
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  const pidsIn = (log: string) => logLines(log).map(Number);
  const commandPids: number[] = [];

  const run = async (args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = (await once(child, "exit")) as [number | null];
    return { code, stdout, stderr };
  };
  const readState = (): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  return {
    cwd,
    env,
    spaceId,
    runtimeId,
    startArgs,
    controller,
    stateFile,
    readState,
    run,
    /** The pids of the agents that started, in order. */
    agentPids: () => pidsIn(agentLog),
    writeState: (state: Record<string, unknown>) => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    },
    /** `runtime stop`, only ever against a record that names a container or one process. */
    stop: async () => {
      const state = readState();
      if (state?.runner !== "docker" && !(Number.isInteger(state?.pid) && Number(state?.pid) > 0)) {
        throw new Error(`refusing to run runtime stop against ${JSON.stringify(state)}`);
      }
      return run(["runtime", "stop", "--json"]);
    },
    /** Starts `runtime start` in the foreground, in a process group of its own. */
    start: () => {
      const child = spawn(process.execPath, [cli, ...startArgs], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const pid = child.pid;
      if (!pid) {
        throw new Error("runtime start did not start");
      }
      commandPids.push(pid);
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const exit = new Promise<Exit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      return { pid, exit, output: () => output };
    },
    /** How the command ended, how many agents started, which containers were left, and whether state was. */
    outcome: (exited: Exit | null) => {
      const docker = logLines(dockerLog);
      const ran = docker.filter((line) => line.startsWith("run ")).length;
      const removed = new Set(docker.filter((line) => line.startsWith("rm ")).map((line) => line.slice(3)));
      return {
        exited,
        launches: mode === "docker" ? ran : pidsIn(agentLog).length,
        containersLeft: Array.from({ length: ran }, (_, index) => `fake-container-${index + 1}`).filter(
          (id) => !removed.has(id),
        ),
        stateLeft: fs.existsSync(stateFile),
      };
    },
    cleanup: () => {
      for (const pid of [...commandPids, ...pidsIn(agentLog), ...pidsIn(`${dockerLog}.followers`)]) {
        try {
          killProcess(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      controller.close();
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}

/**
 * Starts `runtime start` in a folder of its own and waits until its agent exited because its lifetime
 * ended and the new token's mint is in flight.
 */
async function startRuntimeUntilItMints(mode: Mode, options: RuntimeOptions = {}) {
  const runtime = await prepareRuntime(mode, options);
  try {
    const started = runtime.start();
    await Promise.race([
      waitFor(() => runtime.controller.mints() >= 2, "the new token's mint"),
      started.exit.then((exited) => {
        throw new Error(
          `runtime start exited before it minted again (${JSON.stringify(exited)}):\n${started.output()}`,
        );
      }),
    ]);
    return { ...runtime, ...started };
  } catch (error) {
    runtime.cleanup();
    throw error;
  }
}

const stoppedExit = (mode: Mode, signal: NodeJS.Signals): Exit =>
  // As a stop of that runner ends: the Docker runner's foreground command removes its container and
  // exits 0 on SIGINT or SIGTERM; nothing else handles a signal, so the signal ends it.
  mode === "docker" && signal !== "SIGHUP" ? { code: 0, signal: null } : { code: null, signal };

// What Node prints when a child process's 'error' event has no listener.
const unhandledSpawnError = /Unhandled 'error' event|Emitted 'error' event|ERR_UNHANDLED_ERROR/;

describe.skipIf(process.platform === "win32")("a stop while a new runtime token is minted", () => {
  beforeAll(() => {
    if (!fs.existsSync(builtCli)) {
      throw new Error(`${builtCli} is missing: build the CLI first (pnpm --filter @instafy/cli build).`);
    }
  });

  it.each([
    ["docker", "SIGINT"],
    ["docker", "SIGTERM"],
    ["docker", "SIGHUP"],
    ["process", "SIGINT"],
    ["process", "SIGTERM"],
    ["process", "SIGHUP"],
  ] as const)("%s runner: %s keeps it stopped and ends the command", async (mode, signal) => {
    const runtime = await startRuntimeUntilItMints(mode);
    try {
      killProcess(runtime.pid, signal);
      const exited = await exitWithin(runtime.exit, 5_000);
      // The mint lands after the stop.
      runtime.controller.answerHeld();
      await delay(500);

      expect(runtime.outcome(exited), runtime.output()).toEqual({
        exited: stoppedExit(mode, signal),
        launches: 1,
        containersLeft: [],
        stateLeft: false,
      });
    } finally {
      runtime.cleanup();
    }
  }, 30_000);

  it.each(["docker", "process"] as const)(
    "by `runtime stop` from another terminal stops the %s runner, which status and start see running until then",
    async (mode) => {
      const runtime = await startRuntimeUntilItMints(mode);
      try {
        const status = await runtime.run(["runtime", "status", "--json"]);
        expect(JSON.parse(status.stdout), status.stderr).toMatchObject({
          running: true,
          pid: runtime.pid,
          projectId: runtime.spaceId,
          runtimeId: runtime.runtimeId,
        });

        const second = await runtime.run(runtime.startArgs);
        expect(second.code).toBe(1);
        expect(second.stderr).toContain(`Runtime already running (pid ${runtime.pid})`);

        const stop = await runtime.stop();
        expect(JSON.parse(stop.stdout), stop.stderr).toEqual({ stopped: true, pid: runtime.pid });
        const exited = await exitWithin(runtime.exit, 5_000);
        runtime.controller.answerHeld();
        await delay(500);

        expect(runtime.outcome(exited), runtime.output()).toEqual({
          // `runtime stop` signals with SIGINT.
          exited: stoppedExit(mode, "SIGINT"),
          launches: 1,
          containersLeft: [],
          stateLeft: false,
        });
        // The second start minted nothing.
        expect(runtime.controller.mints()).toBe(2);
      } finally {
        runtime.cleanup();
      }
    },
    30_000,
  );

  it.each(["docker", "process"] as const)(
    "by `runtime stop` clearing the state before it signalled this command keeps the %s runner stopped",
    async (mode) => {
      const runtime = await startRuntimeUntilItMints(mode);
      try {
        // As `runtime stop` does when the agent it signalled had already exited for its lifetime.
        fs.rmSync(runtime.stateFile, { force: true });
        runtime.controller.answerHeld();
        const exited = await exitWithin(runtime.exit, 5_000);
        await delay(500);

        expect(runtime.outcome(exited), runtime.output()).toEqual({
          exited: { code: 0, signal: null },
          launches: 1,
          containersLeft: [],
          stateLeft: false,
        });
        expect(runtime.output()).toContain("stays stopped");
      } finally {
        runtime.cleanup();
      }
    },
    30_000,
  );
});

describe.skipIf(process.platform === "win32")("a runtime that starts again after its lifetime ended", () => {
  beforeAll(() => {
    if (!fs.existsSync(builtCli)) {
      throw new Error(`${builtCli} is missing: build the CLI first (pnpm --filter @instafy/cli build).`);
    }
  });

  it.each(["docker", "process"] as const)(
    "is named by the %s runner's state once it runs again, and `runtime stop` stops it",
    async (mode) => {
      const runtime = await startRuntimeUntilItMints(mode);
      try {
        runtime.controller.answerHeld();
        // The command's own record is released without clearing the new agent's.
        const names = (state: Record<string, unknown> | null) =>
          mode === "docker"
            ? state?.containerId === "fake-container-2"
            : runtime.agentPids().length === 2 && state?.pid === runtime.agentPids()[1];
        await waitFor(() => names(runtime.readState()), "the new agent's record");
        await delay(300);
        expect(names(runtime.readState()), JSON.stringify(runtime.readState())).toBe(true);

        const status = await runtime.run(["runtime", "status", "--json"]);
        expect(JSON.parse(status.stdout), status.stderr).toMatchObject(
          mode === "docker"
            ? { running: true, runner: "docker", containerId: "fake-container-2" }
            : { running: true, runner: "process", pid: runtime.agentPids()[1] },
        );

        const stop = await runtime.stop();
        expect(JSON.parse(stop.stdout), stop.stderr).toEqual(
          mode === "docker"
            ? { stopped: true, containerId: "fake-container-2" }
            : { stopped: true, pid: runtime.agentPids()[1] },
        );
        const exited = await exitWithin(runtime.exit, 10_000);

        expect(runtime.outcome(exited), runtime.output()).toEqual({
          exited: { code: 0, signal: null },
          launches: 2,
          containersLeft: [],
          stateLeft: false,
        });
        expect(runtime.controller.mints()).toBe(2);
      } finally {
        runtime.cleanup();
      }
    },
    30_000,
  );

  // A `runtime stop` that read the command's own record just before the new agent's replaced it
  // signals the command, not the agent.
  it.each(["docker", "process"] as const)(
    "is stopped by the %s runner when a stop reaches the command just after it runs again",
    async (mode) => {
      const runtime = await startRuntimeUntilItMints(mode);
      try {
        runtime.controller.answerHeld();
        await waitFor(
          () =>
            mode === "docker"
              ? runtime.readState()?.containerId === "fake-container-2"
              : runtime.agentPids().length === 2 && runtime.readState()?.pid === runtime.agentPids()[1],
          "the new agent's record",
        );
        killProcess(runtime.pid, "SIGINT");
        const exited = await exitWithin(runtime.exit, 10_000);

        expect(runtime.outcome(exited), runtime.output()).toEqual({
          exited: { code: 0, signal: null },
          launches: 2,
          containersLeft: [],
          stateLeft: false,
        });
        if (mode === "process") {
          // The stop went to the new agent, which is gone too.
          const agent = runtime.agentPids()[1];
          expect(Number.isInteger(agent) && agent > 0, String(agent)).toBe(true);
          const isRunning = (pid: number) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          };
          await waitFor(() => !isRunning(agent), "the new agent to exit", 5_000);
        }
      } finally {
        runtime.cleanup();
      }
    },
    30_000,
  );

  it.each(["docker", "process"] as const)(
    "is not started again by the %s runner when a `runtime stop` cleared its state as the agent exited",
    async (mode) => {
      const runtime = await prepareRuntime(mode, { stateClearedAsItExits: true });
      try {
        const started = runtime.start();
        const exited = await exitWithin(started.exit, 10_000);
        runtime.controller.answerHeld();
        await delay(500);

        expect(runtime.outcome(exited), started.output()).toEqual({
          exited: { code: 0, signal: null },
          launches: 1,
          containersLeft: [],
          stateLeft: false,
        });
        // Only the first start's token was minted.
        expect(runtime.controller.mints()).toBe(1);
        expect(started.output()).toContain("does not start it again");
      } finally {
        runtime.cleanup();
      }
    },
    30_000,
  );

  it("ends with status 4 and no record when the agent's binary is gone by then", async () => {
    const runtime = await startRuntimeUntilItMints("process", { agentBinaryRemoved: true });
    try {
      runtime.controller.answerHeld();
      const exited = await exitWithin(runtime.exit, 10_000);

      expect(runtime.outcome(exited), runtime.output()).toEqual({
        exited: { code: 4, signal: null },
        launches: 1,
        containersLeft: [],
        stateLeft: false,
      });
      expect(runtime.output()).toContain("The runtime did not start again");
      expect(runtime.output()).toContain("ENOENT");
      expect(runtime.output()).not.toMatch(unhandledSpawnError);

      const status = await runtime.run(["runtime", "status", "--json"]);
      expect(JSON.parse(status.stdout), status.stderr).toEqual({ running: false });
    } finally {
      runtime.cleanup();
    }
  }, 30_000);

  it("is never recorded when its first start cannot spawn the agent", async () => {
    const runtime = await prepareRuntime("process", { agentMode: 0o644 });
    try {
      const started = runtime.start();
      const exited = await exitWithin(started.exit, 10_000);

      expect(runtime.outcome(exited), started.output()).toEqual({
        exited: { code: 1, signal: null },
        launches: 0,
        containersLeft: [],
        stateLeft: false,
      });
      expect(started.output()).toContain("EACCES");
      expect(started.output()).not.toMatch(unhandledSpawnError);
    } finally {
      runtime.cleanup();
    }
  }, 30_000);

  // Reading such a record signals nothing (`kill(pid, 0)` only checks); `runtime stop` against one is
  // covered without a real signal in runtime-stale-pid.spec.ts.
  it.each([-1, 0])("treats a process record with pid %s as stale, and starts over it", async (pid) => {
    const runtime = await prepareRuntime("process", { agentRuns: true });
    try {
      runtime.writeState({
        runner: "process",
        pid,
        projectId: runtime.spaceId,
        workspace: runtime.cwd,
        startedAt: new Date().toISOString(),
      });
      const status = await runtime.run(["runtime", "status", "--json"]);
      expect(JSON.parse(status.stdout), status.stderr).toMatchObject({ running: false, pid });

      const started = runtime.start();
      await Promise.race([
        waitFor(
          () => runtime.agentPids().length === 1 && runtime.readState()?.pid === runtime.agentPids()[0],
          "the agent's record",
        ),
        started.exit.then((exited) => {
          throw new Error(`runtime start exited (${JSON.stringify(exited)}):\n${started.output()}`);
        }),
      ]);
      expect(started.output()).not.toContain("already running");
    } finally {
      runtime.cleanup();
    }
  }, 30_000);
});
