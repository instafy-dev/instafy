import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The `cargo build` of a `cargo run`: the same manifest, binary and flags, without the program's own arguments. */
export function cargoBuildArgs(runArgs) {
  if (!Array.isArray(runArgs) || runArgs[0] !== "run") {
    throw new Error("cargoBuildArgs needs the arguments of a `cargo run`");
  }
  const programArgs = runArgs.indexOf("--");
  return ["build", ...runArgs.slice(1, programArgs === -1 ? undefined : programArgs)];
}

/**
 * Builds a Cargo launch before it starts, so the readiness wait that follows times startup and
 * never a compile. A prebuilt launch is not built. The build runs with the run's own cwd, env
 * object and stdio (the same environment keeps Cargo's fingerprints, so the run does not compile
 * again), in the caller's process group (Ctrl-C stops it with the launcher), with no timeout:
 * it finishes or fails.
 */
export function buildBeforeLaunch(launch, { cwd, env, stdio, label, spawn = spawnProcess }) {
  if (launch?.source !== "cargo") return Promise.resolve({ built: false });
  const args = cargoBuildArgs(launch.args);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, args, { cwd, env, stdio });
    child.once("error", (error) => reject(new Error(`${label} build could not start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ built: true, args });
      else reject(new Error(`${label} build failed (${signal ? `signal ${signal}` : `exit code ${code}`})`));
    });
  });
}

export function resolveRustBinaryLaunch({
  env = process.env,
  envKey,
  repoRoot,
  cargoArgs,
  label,
}) {
  const configured = typeof env?.[envKey] === "string" ? env[envKey].trim() : "";
  if (!configured) {
    return { command: "cargo", args: [...cargoArgs], source: "cargo" };
  }

  const binaryPath = path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(repoRoot, configured);
  let stat;
  try {
    stat = fs.statSync(binaryPath);
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch (error) {
    throw new Error(
      `${label} prebuilt binary from ${envKey} is not executable: ${binaryPath} (${error.message})`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `${label} prebuilt binary from ${envKey} is not a regular file: ${binaryPath}`,
    );
  }

  return { command: binaryPath, args: [], source: "prebuilt" };
}
