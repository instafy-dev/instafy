import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * What the Playwright suite may clean up on a local stack it shares with a developer's own
 * spaces: only runtimes, containers and rows of projects owned by the suite's own test users
 * (the configured Playwright user and the disposable users the harness signs up). A developer's
 * runtimes, the stack's shared services (the model proxy, the gateways) and other spaces' rows
 * are never touched. `KEEP_RUNTIME=1` or `PLAYWRIGHT_CLEANUP_RUNTIME=0` turns runtime cleanup off
 * altogether.
 */

export type PlaywrightEnvironment = Readonly<Record<string, string | undefined>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+$/i;

/**
 * The disposable users the harness signs up (`guest+<uuid>@`, `private-runtime-<label>-<uuid>@`,
 * `electron-shared-browser-<uuid>@`), as POSIX regular expressions Postgres and JavaScript both
 * read. Each ends in a random id, so no person's address matches.
 */
export const DISPOSABLE_TEST_USER_EMAIL_PATTERNS = [
  "^guest\\+[0-9a-f-]{36}@instafy\\.dev$",
  "^private-runtime-[a-z0-9-]+-[0-9a-f-]{36}@instafy\\.dev$",
  "^electron-shared-browser-[0-9a-f-]{36}@instafy\\.dev$",
] as const;

/** Whether runtime cleanup is turned off for this run. */
export function runtimeCleanupDisabled(env: PlaywrightEnvironment): boolean {
  return (
    (env.KEEP_RUNTIME ?? "").trim() === "1" ||
    (env.PLAYWRIGHT_CLEANUP_RUNTIME ?? "").trim() === "0"
  );
}

/** The configured Playwright user, lowercased (the harness's default when none is set). */
export function playwrightTestUserEmails(env: PlaywrightEnvironment): string[] {
  const email = (env.PLAYWRIGHT_TEST_EMAIL || env.TEST_USER_1_EMAIL || "playwright@instafy.dev")
    .trim()
    .toLowerCase();
  return EMAIL_PATTERN.test(email) ? [email] : [];
}

/** Whether `email` belongs to one of the suite's own users. */
export function isPlaywrightTestUserEmail(email: string, env: PlaywrightEnvironment): boolean {
  const lowered = email.trim().toLowerCase();
  return (
    playwrightTestUserEmails(env).includes(lowered) ||
    DISPOSABLE_TEST_USER_EMAIL_PATTERNS.some((pattern) => new RegExp(pattern).test(lowered))
  );
}

/** SQL listing the ids of projects owned by the suite's users, one per line. */
export function ownedProjectIdsSql(env: PlaywrightEnvironment): string {
  const emails = playwrightTestUserEmails(env).map((email) => `'${email.replace(/'/g, "''")}'`);
  const conditions = [
    ...(emails.length ? [`lower(users.email) in (${emails.join(", ")})`] : []),
    ...DISPOSABLE_TEST_USER_EMAIL_PATTERNS.map((pattern) => `lower(users.email) ~ '${pattern}'`),
  ];
  return `select projects.id from projects join auth.users users on users.id = projects.owner_user_id where ${conditions.join(" or ")} order by projects.id;`;
}

/** Project ids from `psql -At` output; anything that is not a uuid is dropped. */
export function parseProjectIds(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => UUID_PATTERN.test(line)),
    ),
  ];
}

/**
 * Whether a runtime compose project belongs to one of `projectIds`. The docker allocator names
 * them `<prefix><project id without dashes>-<runtime id prefix>`.
 */
export function composeProjectOwnedBy(
  composeProject: string,
  prefix: string,
  projectIds: readonly string[],
): boolean {
  return projectIds.some((projectId) =>
    composeProject.startsWith(`${prefix}${projectId.replace(/-/g, "").toLowerCase()}-`),
  );
}

/**
 * The containers of `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}'`
 * that run a runtime of one of `projectIds`. The base compose project (the shared services) and
 * containers without a compose project are never included.
 */
export function ownedRuntimeContainerIds(
  dockerPsOutput: string,
  options: { prefix: string; baseComposeProject: string; projectIds: readonly string[] },
): string[] {
  return dockerPsOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((row) => {
      const [id, , composeProject] = row.split("\t");
      const project = (composeProject || "").trim();
      if (!id || !project || project === options.baseComposeProject) return [];
      return composeProjectOwnedBy(project, options.prefix, options.projectIds) ? [id] : [];
    });
}

/** The networks of `docker network ls --format '{{.ID}}\t{{.Name}}'` made for a runtime of one of `projectIds`. */
export function ownedRuntimeNetworkIds(
  dockerNetworkOutput: string,
  options: { prefix: string; projectIds: readonly string[] },
): string[] {
  return dockerNetworkOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((row) => {
      const [id, name] = row.split("\t");
      if (!id || !name) return [];
      return composeProjectOwnedBy(name.trim(), options.prefix, options.projectIds) ? [id] : [];
    });
}

/** SQL clearing the runtime rows of `projectIds` only; null when there are none. */
export function ownedRuntimeRowsCleanupSql(projectIds: readonly string[]): string | null {
  const ids = projectIds.filter((id) => UUID_PATTERN.test(id));
  if (ids.length === 0) return null;
  const list = ids.map((id) => `'${id.toLowerCase()}'`).join(", ");
  const scope = `project_id in (${list})`;
  return [
    `update runtimes set active_lease_id = null where ${scope};`,
    `delete from runtime_tunnel_grants where ${scope};`,
    `delete from origin_instances where ${scope};`,
    `delete from runtimes where ${scope};`,
    `delete from runtime_leases where ${scope};`,
  ].join(" ");
}

/** The runtime compose project prefix and the base (shared services) compose project. */
export function runtimeComposeNames(env: PlaywrightEnvironment): {
  prefix: string;
  baseComposeProject: string;
} {
  return {
    prefix:
      (env.DOCKER_PROJECT_PREFIX || env.RUNTIME_DOCKER_PROJECT_PREFIX || "instafy-runtime-").trim() ||
      "instafy-runtime-",
    baseComposeProject: (env.COMPOSE_PROJECT_NAME || "instafy-runtime").trim() || "instafy-runtime",
  };
}

function isLocalDbUrl(dbUrl: string): boolean {
  try {
    const host = new URL(dbUrl).hostname.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * The repo's local Supabase database container, for running psql inside it when the host has no
 * psql: SUPABASE_DB_CONTAINER when set, else `supabase_db_<project_id>` from the repo's Supabase
 * config, and only when `dbUrl` is that config's database port. Null otherwise, so a database URL
 * that names another stack is never answered by this repo's container (or another project's).
 */
export function localSupabaseDbContainer(
  dbUrl: string,
  configToml: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  const explicit = (env.SUPABASE_DB_CONTAINER ?? "").trim();
  if (explicit) return explicit;
  if (!configToml) return null;
  let section = "";
  let projectId: string | undefined;
  let configPort: string | undefined;
  for (const raw of configToml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const entry = /^([A-Za-z0-9_]+)\s*=\s*"?([^"]*)"?$/.exec(line);
    if (!entry) continue;
    if (section === "" && entry[1] === "project_id") projectId = entry[2].trim();
    if (section === "db" && entry[1] === "port") configPort = entry[2].trim();
  }
  if (!projectId || !configPort) return null;
  let urlPort: string;
  try {
    urlPort = new URL(dbUrl).port || "5432";
  } catch {
    return null;
  }
  return urlPort === configPort ? `supabase_db_${projectId}` : null;
}

function readSupabaseConfig(cwd: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, "supabase", "supabase", "config.toml"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Run `sql` against the local stack's database (host psql, else psql in the repo's local Supabase
 * container, see `localSupabaseDbContainer`) and return its unaligned output. Throws when it cannot
 * run; never targets a database that is not on this machine.
 */
export function queryLocalDb(
  sql: string,
  options: { dbUrl: string; cwd: string; env: NodeJS.ProcessEnv; psqlBin: string | null },
): string {
  if (!isLocalDbUrl(options.dbUrl)) {
    throw new Error("refusing to clean up a database that is not on this machine");
  }
  const psqlArgs = ["-At", "-v", "ON_ERROR_STOP=1", "-c", sql];
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  let result;
  if (options.psqlBin) {
    result = spawnSync(options.psqlBin, ["-d", options.dbUrl, ...psqlArgs], spawnOptions);
  } else {
    const container = localSupabaseDbContainer(options.dbUrl, readSupabaseConfig(options.cwd), options.env);
    if (!container) {
      throw new Error(
        "no psql on the PATH, and the database is not the repo's local Supabase (set SUPABASE_DB_CONTAINER)",
      );
    }
    result = spawnSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", ...psqlArgs], spawnOptions);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || "").trim() || `psql exited with code ${result.status}`);
  }
  return result.stdout || "";
}

/**
 * Whether `projectId` is one of the suite's own projects. A project missing from `known` (read
 * before the run created it, say) is checked again with `reread`; the returned list is the one to
 * keep. A failed re-read answers not owned.
 */
export function ownedProjectLookup(
  projectId: string,
  known: readonly string[] | null,
  reread: () => string[],
): { owned: boolean; ids: readonly string[] | null } {
  const id = projectId.toLowerCase();
  if (known?.includes(id)) return { owned: true, ids: known };
  let ids: string[];
  try {
    ids = reread();
  } catch {
    return { owned: false, ids: known };
  }
  return { owned: ids.includes(id), ids };
}

/** `psql` when it is on the PATH, else null (`queryLocalDb` then uses the Supabase container's). */
export function findPsql(env: NodeJS.ProcessEnv): string | null {
  const probe = spawnSync("psql", ["--version"], { env, stdio: "ignore" });
  return probe.status === 0 ? "psql" : null;
}

/** The projects owned by the suite's own users, read from the local stack's database. */
export function readPlaywrightOwnedProjectIds(options: {
  dbUrl: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  psqlBin: string | null;
}): string[] {
  return parseProjectIds(queryLocalDb(ownedProjectIdsSql(options.env), options));
}
