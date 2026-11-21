import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This checkout's Supabase CLI project: `supabase --workdir supabase` reads its config.toml.
export const LOCAL_SUPABASE_PROJECT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "supabase",
);

// The Supabase CLI's own ports when config.toml names none.
const CLI_PORTS = { api: 54321, db: 54322 };

/**
 * The API and database ports this checkout's local Supabase listens on (`[api] port` and
 * `[db] port` in its config.toml), and the loopback URLs they give. The committed config gives
 * 54321 and 54322; a checkout whose config names other ports gets those, never another stack's.
 */
export function localSupabasePorts(projectDir = LOCAL_SUPABASE_PROJECT_DIR) {
  const file = path.join(projectDir, "config.toml");
  const ports = { ...CLI_PORTS };
  let section = "";
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      // `[db.pooler]`, `[api.tls]` and `[[tables]]` are other sections, whose ports are not these.
      section = /^\[([^[\]]+)\]$/.exec(line)?.[1].trim() ?? "";
      continue;
    }
    const entry = Object.hasOwn(CLI_PORTS, section) ? /^port\s*=\s*(.*)$/.exec(line) : null;
    if (!entry) continue;
    const value = entry[1].trim();
    const port = /^\d{1,5}$/.test(value) ? Number(value) : 0;
    if (port < 1 || port > 65535) {
      throw new Error(`${file}: [${section}] port = ${value} is not a port (1-65535).`);
    }
    ports[section] = port;
  }
  return {
    apiPort: ports.api,
    dbPort: ports.db,
    apiUrl: `http://127.0.0.1:${ports.api}`,
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${ports.db}/postgres`,
  };
}
