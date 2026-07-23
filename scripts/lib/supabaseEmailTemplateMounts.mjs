import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SUPABASE_EMAIL_TEMPLATE_NAMES = Object.freeze([
  "invite",
  "magic_link",
  "confirmation",
  "recovery",
  "email_change",
]);

const KONG_TEMPLATE_ROOT = "/home/kong/templates/email";

function runDocker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function commandError(args, result) {
  const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
  return `docker ${args.join(" ")} failed: ${detail}`;
}

export function readSupabaseProjectId(projectDir) {
  const configPath = path.join(projectDir, "config.toml");
  const config = fs.readFileSync(configPath, "utf8");
  const match = config.match(/^project_id\s*=\s*["']([^"']+)["']/m);
  if (!match?.[1]?.trim()) {
    throw new Error(`Unable to read project_id from ${configPath}.`);
  }
  return match[1].trim();
}

function findKongContainer(projectId, executeDocker) {
  const args = [
    "ps",
    "--filter",
    `label=com.supabase.cli.project=${projectId}`,
    "--filter",
    "name=supabase_kong_",
    "--format",
    "{{.Names}}",
  ];
  const result = executeDocker(args);
  if (result.status !== 0) {
    throw new Error(commandError(args, result));
  }
  const containers = String(result.stdout)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (containers.length !== 1) {
    throw new Error(
      `Expected one running Supabase Kong container for project ${projectId}; found ${containers.length}.`,
    );
  }
  return containers[0];
}

function readContainerFile(container, target, executeDocker) {
  const args = ["exec", container, "cat", target];
  return { args, result: executeDocker(args) };
}

/**
 * Supabase CLI bind-mounts custom email templates into Kong. A remote Docker
 * daemon (notably Colima without $HOME mounted) can see the host source as
 * missing and silently create a directory at the file destination instead.
 * Nginx then sends a directory index as the auth email body.
 *
 * Keep normal mounts read-only/no-op. If and only if a destination is a
 * directory, copy the canonical repo template into its index file so Kong's
 * redirect serves the intended content. This repairs the running local stack;
 * production templates are managed independently by Supabase.
 */
export function ensureSupabaseEmailTemplateMounts({
  projectDir,
  executeDocker = runDocker,
  logger = console,
} = {}) {
  if (!projectDir) {
    throw new Error("projectDir is required to validate Supabase email templates.");
  }

  const projectId = readSupabaseProjectId(projectDir);
  const container = findKongContainer(projectId, executeDocker);
  const repaired = [];

  for (const name of SUPABASE_EMAIL_TEMPLATE_NAMES) {
    const source = path.join(projectDir, "templates", `${name}.html`);
    const sourceStat = fs.statSync(source);
    if (!sourceStat.isFile()) {
      throw new Error(`Supabase email template source is not a file: ${source}`);
    }
    const expected = fs.readFileSync(source, "utf8");
    const target = `${KONG_TEMPLATE_ROOT}/${name}.html`;
    let readable = readContainerFile(container, target, executeDocker);

    if (readable.result.status !== 0) {
      const directoryArgs = ["exec", container, "test", "-d", target];
      const directoryResult = executeDocker(directoryArgs);
      if (directoryResult.status !== 0) {
        throw new Error(
          `Supabase email template target is neither a readable file nor a repairable directory: ${target}. ` +
            commandError(readable.args, readable.result),
        );
      }

      const repairedTarget = `${target}/index.html`;
      const copyArgs = ["cp", source, `${container}:${repairedTarget}`];
      const copyResult = executeDocker(copyArgs);
      if (copyResult.status !== 0) {
        throw new Error(commandError(copyArgs, copyResult));
      }
      repaired.push(name);
      readable = readContainerFile(container, repairedTarget, executeDocker);
    }

    if (readable.result.status !== 0) {
      throw new Error(commandError(readable.args, readable.result));
    }
    if (String(readable.result.stdout) !== expected) {
      throw new Error(
        `Supabase email template ${name} in ${container} does not match ${source}.`,
      );
    }
  }

  if (repaired.length > 0) {
    logger.warn(
      `[supabase-templates] Repaired directory-backed Docker mounts for: ${repaired.join(", ")}.`,
    );
  }

  return { container, repaired };
}
