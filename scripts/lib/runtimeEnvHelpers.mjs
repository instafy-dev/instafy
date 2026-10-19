import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SERVICE_RUNTIME_EMAIL = "service-runtime@instafy.dev";
export const DEFAULT_SUPABASE_PROJECT_URL = "http://127.0.0.1:54321";

const WAIT_BETWEEN_REQUESTS_MS = 500;
const ADMIN_USERS_PER_PAGE = 200;
const ADMIN_USERS_MAX_PAGES = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeAdminUserEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Check one page of `GET /auth/v1/admin/users` for the user whose email is
 * exactly `wanted` (already normalized). The admin list ignores an `email`
 * parameter, and its `filter` matches substrings and the user-editable full
 * name, so being listed proves nothing: only an entry's own email counts.
 * Throws on a page without a `users` array, a matching entry without a UUID
 * id, or two different ids with the email; it never falls back to the first
 * listed user.
 */
export function matchAdminUsersPage(payload, wanted) {
  if (!wanted) {
    throw new Error("the service runtime email is empty");
  }
  const users = payload && Array.isArray(payload.users) ? payload.users : null;
  if (!users) {
    throw new Error("the admin user list response has no users array");
  }
  let match = null;
  for (const entry of users) {
    if (!entry || typeof entry !== "object" || normalizeAdminUserEmail(entry.email) !== wanted) {
      continue;
    }
    if (typeof entry.id !== "string" || !UUID_PATTERN.test(entry.id)) {
      throw new Error("the admin user list names the service runtime email without a valid id");
    }
    if (match && match.id !== entry.id) {
      throw new Error("several admin users have the service runtime email");
    }
    match = entry;
  }
  return { listed: users.length, match };
}

/**
 * Page through the admin user list, `perPage` users at a time and at most
 * `maxPages` pages, for the one user whose email is exactly `email`. Resolves
 * `{ status: "found", user }`, `{ status: "missing" }` once the whole list was
 * read without a match, or `{ status: "unknown", reason }` for a malformed
 * page, two holders or a list longer than the cap. Rejects when a page request
 * fails, so a caller waiting for the stack can retry.
 */
export async function findAdminUserByEmail({
  supabaseUrl,
  headers,
  email,
  fetchImpl = fetch,
  perPage = ADMIN_USERS_PER_PAGE,
  maxPages = ADMIN_USERS_MAX_PAGES,
}) {
  const wanted = normalizeAdminUserEmail(email);
  let found = null;
  for (let page = 1; page <= maxPages; page += 1) {
    // `filter` only narrows the list; matchAdminUsersPage decides.
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      filter: wanted,
    });
    const response = await fetchImpl(`${supabaseUrl}/auth/v1/admin/users?${query}`, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`admin user list returned ${response.status} ${response.statusText} ${body}`.trim());
    }
    let checked;
    try {
      checked = matchAdminUsersPage(await response.json(), wanted);
    } catch (error) {
      return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    if (checked.match) {
      if (found && found.id !== checked.match.id) {
        return { status: "unknown", reason: "several admin users have the service runtime email" };
      }
      found = checked.match;
    }
    if (checked.listed < perPage) {
      return found ? { status: "found", user: found } : { status: "missing" };
    }
  }
  return {
    status: "unknown",
    reason: `the admin user list did not end within ${maxPages} pages of ${perPage} users`,
  };
}

/**
 * The user a `POST /auth/v1/admin/users` response names, accepted only when it
 * is a single user whose email is exactly `email`.
 */
export function createdAdminUser(payload, email) {
  const wanted = normalizeAdminUserEmail(email);
  if (!wanted || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (normalizeAdminUserEmail(payload.email) !== wanted) {
    return null;
  }
  return typeof payload.id === "string" && UUID_PATTERN.test(payload.id) ? payload : null;
}

export function setEnvFileValue(filePath, key, value) {
  if (!value) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      content = "";
    }
    const lines = content ? content.split(/\r?\n/) : [];
    const prefix = `${key}=`;
    let replaced = false;
    let changed = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].startsWith(prefix)) {
        const updated = `${prefix}${value}`;
        if (lines[index] !== updated) {
          lines[index] = updated;
          changed = true;
        }
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.push(`${prefix}${value}`);
      changed = true;
    }
    const next = lines.filter((line, idx) => line || idx === lines.length - 1);
    const nextContent = `${next.join("\n").replace(/\n+$/, "\n")}\n`;
    const normalizedOriginal = content
      ? `${content.replace(/\r\n/g, "\n").replace(/\n+$/, "\n")}\n`
      : "";
    if (!changed && nextContent === normalizedOriginal) {
      return;
    }
    fs.writeFileSync(filePath, nextContent, { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
    }
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to set ${key} in ${filePath}: ${error.message}`
    );
  }
}

export function deleteEnvFileValue(filePath, key) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const prefix = `${key}=`;
    const lines = content.split(/\r?\n/);
    const next = lines.filter((line) => !line.startsWith(prefix));
    if (next.length === lines.length) {
      return;
    }
    fs.writeFileSync(
      filePath,
      `${next.join("\n").replace(/\n+$/, "")}\n`,
      "utf-8"
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    console.warn(
      `[runtime-dev] Unable to delete ${key} from ${filePath}: ${error.message}`
    );
  }
}

export async function ensureServiceRuntimeUserId(supabaseEnv = {}) {
  const supabaseUrlRaw =
    process.env.SUPABASE_PROJECT_URL ||
    process.env.SUPABASE_URL ||
    supabaseEnv.SUPABASE_PROJECT_URL ||
    supabaseEnv.SUPABASE_URL ||
    DEFAULT_SUPABASE_PROJECT_URL;
  const supabaseUrl = supabaseUrlRaw ? supabaseUrlRaw.trim().replace(/\/$/, "") : "";
  if (!supabaseUrl) {
    console.warn(
      "[runtime-dev] Skipping service runtime user setup: SUPABASE_PROJECT_URL is not available."
    );
    return null;
  }

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    supabaseEnv.SERVICE_ROLE_KEY ||
    "";
  if (!serviceRoleKey) {
    console.warn(
      "[runtime-dev] Skipping service runtime user setup: SUPABASE_SERVICE_ROLE_KEY is not configured."
    );
    return null;
  }

  const serviceEmail =
    (process.env.SERVICE_RUNTIME_USER_EMAIL || DEFAULT_SERVICE_RUNTIME_EMAIL)
      .trim()
      .toLowerCase();
  if (!serviceEmail) {
    console.warn(
      "[runtime-dev] Skipping service runtime user setup: SERVICE_RUNTIME_USER_EMAIL is empty."
    );
    return null;
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available; update Node or provide a polyfill.");
  }

  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };

  const lookupServiceUser = async (maxAttempts) => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await findAdminUserByEmail({ supabaseUrl, headers, email: serviceEmail });
      } catch (error) {
        console.warn(
          `[runtime-dev] Unable to list users for the service runtime user (attempt ${
            attempt + 1
          }): ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await sleep(WAIT_BETWEEN_REQUESTS_MS);
    }
    return { status: "unknown", reason: "the admin user list stayed unavailable" };
  };

  const lookup = await lookupServiceUser(8);
  if (lookup.status === "unknown") {
    console.warn(
      `[runtime-dev] Unable to look up service runtime user ${serviceEmail}: ${lookup.reason}. Adopting and creating no user.`
    );
    return null;
  }

  let userRecord = lookup.status === "found" ? lookup.user : null;
  let created = false;
  if (!userRecord) {
    const createPayload = {
      email: serviceEmail,
      password: process.env.SERVICE_RUNTIME_USER_PASSWORD || "TempPass123!",
      email_confirm: true,
    };
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers,
        body: JSON.stringify(createPayload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 422 && body.includes("email_exists")) {
          console.log(
            "[runtime-dev] Service runtime user already exists; re-querying."
          );
          const retry = await lookupServiceUser(6);
          if (retry.status !== "found") {
            console.warn(
              `[runtime-dev] Service runtime user ${serviceEmail} exists, but no listed user has that exact email${
                retry.status === "unknown" ? ` (${retry.reason})` : ""
              }. Adopting no user.`
            );
            return null;
          }
          userRecord = retry.user;
        } else {
          console.warn(
            `[runtime-dev] Failed to create service runtime user: ${response.status} ${response.statusText} ${body}`
          );
          return null;
        }
      } else {
        userRecord = createdAdminUser(await response.json(), serviceEmail);
        if (!userRecord) {
          console.warn(
            `[runtime-dev] The create response did not name a user with the email ${serviceEmail}. Adopting no user.`
          );
          return null;
        }
        created = true;
      }
    } catch (error) {
      console.warn(
        `[runtime-dev] Error creating service runtime user: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  if (created) {
    console.log(
      `[runtime-dev] Created service runtime user ${serviceEmail} (${userRecord.id}).`
    );
  } else {
    console.log(
      `[runtime-dev] Found service runtime user ${serviceEmail} (${userRecord.id}).`
    );
  }

  return { id: userRecord.id, email: serviceEmail };
}

// The provider's folders next to its checkouts (checkout stamps, evicted
// checkouts), and a space folder's name (a lower-case, hyphenated UUID).
const STAMP_FOLDER = ".instafy-checkout-stamps";
const PROVIDER_FOLDERS = [STAMP_FOLDER, ".instafy-evicted"];
const SPACE_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Make the stamp folder in the gateway's folder `folder` (and `folder`
 * itself when there is none yet), so the origin gateway refuses to start on
 * it instead of moving the runtime checkouts there into its `.legacy/`
 * folder. `why` says why it is kept, after "Keeping <stamps> ". Whether the
 * stamp folder exists now.
 */
export function stampGatewayFolder(folder, { log = console, why }) {
  const stamps = path.join(folder, STAMP_FOLDER);
  try {
    try {
      fs.lstatSync(stamps);
    } catch {
      fs.mkdirSync(stamps, { recursive: true });
    }
    log.warn(
      `[runtime-dev] Keeping ${stamps} ${why}. The origin gateway refuses to start on that folder ` +
        "until it is gone, instead of moving runtime checkouts there into its .legacy/ folder."
    );
    return true;
  } catch (error) {
    log.warn(
      `[runtime-dev] Unable to create ${stamps} (${error.message}); the origin gateway may move ` +
        `runtime checkouts in ${folder} into its .legacy/ folder when it starts.`
    );
    return false;
  }
}

function runningProviderReason(from, to) {
  return (
    `because the runtime provider is already running and may keep runtime checkouts in ${from}. ` +
    `Stop the provider and start again so new checkouts go to ${to}`
  );
}

/**
 * Record, in `file` (next to the provider's pid file), that the provider
 * this script launched as process `pid` keeps its runtimes' checkouts in
 * `root`.
 */
export function recordProviderCheckoutRoot(file, pid, root) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ pid, root: path.resolve(root) })}\n`);
  } catch {
    // Without a record, a later run treats that provider's folder as unknown.
  }
}

/**
 * The folder the provider running as process `pid` keeps its checkouts in,
 * as `recordProviderCheckoutRoot` recorded it when this script launched
 * that process; `null` when no record names that process (a provider an
 * older script, another run or a person started).
 */
export function recordedProviderCheckoutRoot(file, pid) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return record?.pid === pid && typeof record.root === "string" && record.root ? record.root : null;
  } catch {
    return null;
  }
}

/**
 * The folder the local runtime provider keeps its runtimes' checkouts in
 * (`DOCKER_REPO_HOST`, one `<space id>` folder each). With git-canonical on,
 * that is a folder of its own, never the gateway's (`tmp/origin-gateway-
 * workspaces`): the gateway moves every space folder of its root out of the
 * way when it starts, and refuses to start on a provider's folder.
 */
export function resolveRuntimeCheckoutRoot({ env = process.env, repoRoot, sandboxDir }) {
  const explicit = String(env.DOCKER_REPO_HOST ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (String(env.GIT_CANONICAL ?? "").trim() === "1") {
    return path.join(repoRoot, "tmp", "runtime-checkouts");
  }
  return String(env.RUNTIME_REPO_HOST ?? "").trim() || sandboxDir;
}

/**
 * Move the runtime checkouts an earlier local stack kept in the gateway's
 * folder `from` (when the provider and the gateway shared it) to the
 * provider's own folder `to`, with the provider's stamp and eviction
 * folders, before either starts. A space whose runtime may still use its
 * checkout (`inUse(id)`), or whose folder `to` already has, stays where it
 * is, with a warning. `inUse` is `null` when the runtime containers could
 * not be listed: then every space stays, and nothing of the provider's
 * moves. Nothing is replaced and links are never followed.
 *
 * With `providerRunning`, a provider this start did not launch is serving,
 * and it may be one started before its checkouts had a folder of their own:
 * it keeps them in `from`, makes new ones there and holds any of them open.
 * Then nothing moves either; every space stays, with a warning to stop the
 * provider and start again, so that start moves them. `providerRoot` is
 * the folder that provider keeps its checkouts in, when this script
 * launched it and recorded it (`recordedProviderCheckoutRoot`); unless it
 * is known to be another folder than `from`, the provider may clone a space
 * into `from` at any moment before the gateway starts, so the stamp folder
 * is made there even while `from` holds no checkout yet.
 *
 * While a checkout stays in `from`, its stamp stays too, and the provider's
 * folders are never removed from `from` (the stamp folder is made when
 * there is none): the gateway refuses to start on a folder that holds them,
 * where it would otherwise move that checkout into its `.legacy/`
 * (`park_legacy_checkouts` in origin-http-server).
 */
export function relocateRuntimeCheckouts({
  from,
  to,
  inUse = () => false,
  providerRunning = false,
  providerRoot = null,
  log = console,
}) {
  const report = { moved: [], kept: [] };
  if (path.resolve(from) === path.resolve(to)) {
    return report;
  }
  // A running provider that may keep its checkouts in `from`.
  const providerMayUseFrom =
    providerRunning && (providerRoot == null || path.resolve(providerRoot) === path.resolve(from));
  let names;
  try {
    names = fs.readdirSync(from).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log.warn(`[runtime-dev] Unable to list ${from}: ${error.message}`);
    } else if (providerMayUseFrom) {
      stampGatewayFolder(from, { log, why: runningProviderReason(from, to) });
    }
    return report;
  }
  const keep = (name, reason, { quiet = false } = {}) => {
    report.kept.push({ name, reason });
    if (!quiet) {
      log.warn(`[runtime-dev] Left ${path.join(from, name)} in place: ${reason}.`);
    }
  };
  const move = (source, target) => {
    if (fs.existsSync(target)) {
      return "the provider's folder already has it";
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      return null;
    } catch (error) {
      return `it could not be moved (${error.message})`;
    }
  };
  const providerFolders = [];
  for (const name of names) {
    const source = path.join(from, name);
    let stat;
    try {
      stat = fs.lstatSync(source);
    } catch {
      continue;
    }
    if (SPACE_FOLDER.test(name) && stat.isDirectory()) {
      if (providerRunning) {
        // One warning names them all, below.
        keep(name, "the runtime provider is already running and may use it", { quiet: true });
        continue;
      }
      if (inUse === null) {
        keep(name, "the runtime containers could not be listed, so one of this space may still use it; start again");
        continue;
      }
      if (inUse(name)) {
        keep(name, "a runtime container of this space may still use it; stop it and start again");
        continue;
      }
      const refused = move(source, path.join(to, name));
      if (refused) {
        keep(name, refused);
      } else {
        report.moved.push(name);
        log.log(`[runtime-dev] Moved the runtime checkout ${name} to ${to}.`);
      }
    } else if (PROVIDER_FOLDERS.includes(name) && stat.isDirectory()) {
      providerFolders.push(name);
    }
  }
  // The checkouts the gateway would still find here.
  const stayed = report.kept.map((item) => item.name).filter((name) => SPACE_FOLDER.test(name));
  if (providerRunning && stayed.length > 0) {
    log.warn(
      `[runtime-dev] Left ${stayed.length} runtime checkout(s) in ${from}: the runtime provider is already ` +
        "running, and one started before runtime checkouts had a folder of their own keeps them there and " +
        `may still use them. Stop the provider and start again to move them to ${to}.`
    );
  }
  for (const name of inUse === null || providerRunning ? [] : providerFolders) {
    const source = path.join(from, name);
    let entries;
    try {
      entries = fs.readdirSync(source).sort();
    } catch (error) {
      keep(name, `it could not be listed (${error.message})`);
      continue;
    }
    for (const entry of entries) {
      if (name === STAMP_FOLDER && stayed.includes(entry)) {
        // Its checkout stayed, with a warning of its own.
        keep(path.join(name, entry), "the checkout of its space stayed in place", { quiet: true });
        continue;
      }
      const refused = move(path.join(source, entry), path.join(to, name, entry));
      if (refused) {
        keep(path.join(name, entry), refused);
      }
    }
    if (stayed.length === 0) {
      try {
        fs.rmdirSync(source);
      } catch {
        // Something stayed behind; the gateway names it if it refuses.
      }
    }
  }
  if (stayed.length > 0) {
    stampGatewayFolder(from, { log, why: `while runtime checkouts stay in ${from}` });
  } else if (providerMayUseFrom) {
    stampGatewayFolder(from, { log, why: runningProviderReason(from, to) });
  }
  if (fs.existsSync(path.join(from, ".legacy"))) {
    log.warn(
      `[runtime-dev] ${path.join(from, ".legacy")} holds folders an earlier gateway start moved there; ` +
        `runtime checkouts among them can be moved back to ${to} by hand (they may belong to root).`
    );
  }
  return report;
}

/**
 * Dev defaults for the secrets the controller and the AI proxy share.
 * `ensureDevProxySecrets` sets each one that `env` leaves unset or blank, so
 * the controller, the stack's proxy and every per-space proxy the provider
 * launches through docker compose (which takes them from the provider's
 * environment) agree. Without the lease token a compose-launched proxy exits
 * with "controller integration requires PROXY_CREDENTIAL_LEASE_TOKEN".
 */
export const DEV_PROXY_SECRET_DEFAULTS = Object.freeze({
  CONTROLLER_INTERNAL_TOKEN: "dev-internal-token",
  PROXY_SIGNING_SECRET: "dev-proxy-secret",
  PROXY_CREDENTIAL_LEASE_TOKEN: "dev-proxy-credential-lease-token",
});

export function ensureDevProxySecrets(env = process.env) {
  for (const [key, value] of Object.entries(DEV_PROXY_SECRET_DEFAULTS)) {
    if (!String(env[key] ?? "").trim()) env[key] = value;
  }
  return env;
}
