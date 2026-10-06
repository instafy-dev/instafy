import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SERVICE_RUNTIME_EMAIL = "service-runtime@instafy.dev";
export const DEFAULT_SUPABASE_PROJECT_URL = "http://127.0.0.1:54321";

const WAIT_BETWEEN_REQUESTS_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const parseUserResponse = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    if (Array.isArray(payload.users) && payload.users.length > 0) {
      return payload.users[0];
    }
    if (Array.isArray(payload) && payload.length > 0) {
      return payload[0];
    }
    if (payload.id) {
      return payload;
    }
    return null;
  };

  const queryUrl = `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(
    serviceEmail
  )}`;

  const fetchExistingUser = async (maxAttempts = 8) => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch(queryUrl, { headers });
        if (response.ok) {
          const payload = await response.json();
          const record = parseUserResponse(payload);
          if (record) {
            return record;
          }
          // If the query succeeded but no user exists, stop retrying so we can
          // create the service runtime user immediately.
          return null;
        } else {
          const body = await response.text().catch(() => "");
          console.warn(
            `[runtime-dev] Unable to query service runtime user (attempt ${
              attempt + 1
            }): ${response.status} ${response.statusText} ${body}`
          );
        }
      } catch (error) {
        console.warn(
          `[runtime-dev] Error requesting service runtime user (attempt ${
            attempt + 1
          }): ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await sleep(WAIT_BETWEEN_REQUESTS_MS);
    }
    return null;
  };

  let userRecord = await fetchExistingUser();

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
          userRecord = await fetchExistingUser(6);
          created = false;
        } else {
          console.warn(
            `[runtime-dev] Failed to create service runtime user: ${response.status} ${response.statusText} ${body}`
          );
          return null;
        }
      } else {
        const payload = await response.json();
        userRecord = parseUserResponse(payload);
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

  if (!userRecord?.id) {
    console.warn("[runtime-dev] Unable to resolve service runtime user id.");
    return null;
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
const PROVIDER_FOLDERS = [".instafy-checkout-stamps", ".instafy-evicted"];
const SPACE_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 * is, with a warning. Nothing is replaced and links are never followed.
 */
export function relocateRuntimeCheckouts({ from, to, inUse = () => false, log = console }) {
  const report = { moved: [], kept: [] };
  if (path.resolve(from) === path.resolve(to)) {
    return report;
  }
  let names;
  try {
    names = fs.readdirSync(from).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log.warn(`[runtime-dev] Unable to list ${from}: ${error.message}`);
    }
    return report;
  }
  const keep = (name, reason) => {
    report.kept.push({ name, reason });
    log.warn(`[runtime-dev] Left ${path.join(from, name)} in place: ${reason}.`);
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
  for (const name of names) {
    const source = path.join(from, name);
    let stat;
    try {
      stat = fs.lstatSync(source);
    } catch {
      continue;
    }
    if (SPACE_FOLDER.test(name) && stat.isDirectory()) {
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
      for (const entry of fs.readdirSync(source).sort()) {
        const refused = move(path.join(source, entry), path.join(to, name, entry));
        if (refused) {
          keep(path.join(name, entry), refused);
        }
      }
      try {
        fs.rmdirSync(source);
      } catch {
        // Something stayed behind; the gateway names it if it refuses.
      }
    }
  }
  if (fs.existsSync(path.join(from, ".legacy"))) {
    log.warn(
      `[runtime-dev] ${path.join(from, ".legacy")} holds folders an earlier gateway start moved there; ` +
        `runtime checkouts among them can be moved back to ${to} by hand (they may belong to root).`
    );
  }
  return report;
}
