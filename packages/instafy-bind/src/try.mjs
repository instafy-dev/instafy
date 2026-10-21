// `instafy-bind try <dir> <intent> [params] [--save]`: run one script intent exactly as a viewer's click would (same
// input, same handler environment, same record checks), without serving the site; --save stores what it accepted. A model building a
// site uses it before replying, so a button that crashes or whose records are rejected never ships silently.
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executorOf, loadBound, resolveIntent, targetOf } from "./bound.mjs";
import { applyDefaults, formatErrors, validate } from "./schema-lite.mjs";
import { checkRecords, writeRecords } from "./apply.mjs";
import { runScript } from "./executors/script.mjs";
import { bindDir } from "./tokens.mjs";

const TRIED_FILE = "tried.json";

function readJsonMaybe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** sha256 of a handler file (the doctor compares it with the last successful try). */
export function handlerHash(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** The last tries of a site: { [intent]: { hash, ok, at } }. */
export function readTried(siteDir) {
  return readJsonMaybe(path.join(siteDir, ".bind", TRIED_FILE)) || {};
}

function writeTried(siteDir, name, entry) {
  try {
    const dir = bindDir(siteDir);
    const tried = readTried(siteDir);
    tried[name] = entry;
    fs.writeFileSync(path.join(dir, TRIED_FILE), `${JSON.stringify(tried, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // the result is still printed
  }
}

function describe(record) {
  const what = record.type === "claim" ? `${record.attr}: ${record.status === "uncertain" ? `uncertain (${record.note || "no note"})` : JSON.stringify(record.value)}`
    : record.type === "offer" ? `offer ${record.price?.amount ?? "?"} ${record.price?.currency ?? ""} at ${record.seller?.name ?? record.prov?.source ?? "?"}`
      : `${record.type}`;
  return `${record.ref ?? ""} ${what} · ${record.prov?.source ?? "?"}`.trim();
}

/**
 * Run one script intent. Resolves { exit, lines, accepted, rejected, error }.
 * exit 0: the handler ended with at least one accepted record (a value or an uncertain claim).
 * exit 1: it crashed, reported an error, sent no records, or every record was rejected.
 * exit 64: the request itself was wrong (unknown intent, bad params, not a script intent).
 */
export async function tryIntent(siteDir, name, rawParams = "{}", { allowLocal = false, allowEnv = [], timeoutMs = null, save = false } = {}) {
  const dir = path.resolve(siteDir);
  const lines = [];
  let bound;
  try {
    bound = loadBound(dir);
  } catch (error) {
    return { exit: 64, lines: [`error ${error.message}`] };
  }
  const def = bound.intents?.[name];
  if (!def) return { exit: 64, lines: [`error unknown intent "${name}" (intents: ${Object.keys(bound.intents || {}).join(", ")})`] };
  if (executorOf(def) !== "script") return { exit: 64, lines: [`error ${name} is an agent intent; check its prompt with serve --dry-run instead`] };
  const resolved = resolveIntent(def, { siteDir: dir });
  if (!resolved.ok) return { exit: 64, lines: [`error ${name}: ${resolved.reason}`] };
  let params;
  try {
    params = applyDefaults(def.params, JSON.parse(rawParams || "{}"));
  } catch (error) {
    return { exit: 64, lines: [`error params are not JSON: ${error.message}`] };
  }
  const problems = validate(def.params, params);
  if (problems.length) return { exit: 64, lines: [`error params: ${formatErrors(problems)}`] };

  const intent = { id: `try_${Date.now().toString(36)}`, name, params, ref: typeof params.ref === "string" ? params.ref : null, at: new Date().toISOString() };
  const records = [];
  const controller = new AbortController();
  const limitS = timeoutMs ? timeoutMs / 1000 : def.timeout_s || 90;
  const timer = setTimeout(() => controller.abort({ code: "timeout", message: `no answer within ${limitS} s` }), limitS * 1000);
  timer.unref?.();
  let summary = null;
  let failure = null;
  try {
    const done = await runScript({
      handler: resolved.handler,
      siteDir: dir,
      input: { intent, bound: def, site: { dir, title: bound.title || path.basename(dir) } },
      signal: controller.signal,
      onProgress: (p) => lines.push(`…     ${p.step ?? ""}/${p.of ?? ""} ${p.message ?? ""}`.trimEnd()),
      onRecords: (batch) => records.push(...batch),
      log: (level, text) => {
        if (level !== "debug") lines.push(`${level.padEnd(5)} ${text}`);
      },
      allowLocal,
      envNames: def.env || [],
      allowEnv,
    });
    summary = done.summary;
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }
  const { accepted, rejected } = checkRecords(structuredClone(records), { name, def, intent, job: intent.id });
  for (const record of accepted) lines.push(`ok    ${describe(record)}`);
  for (const r of rejected) lines.push(`error record #${r.index} rejected: ${r.reason}`);
  let exit = 0;
  if (failure) {
    lines.push(`error ${failure.code || "upstream"}: ${failure.message}`);
    exit = 1;
  } else if (!records.length) {
    lines.push("error the handler sent no records: a click would leave the cell empty (send a value or kit.uncertain with a note)");
    exit = 1;
  } else if (!accepted.length) {
    lines.push("error every record was rejected: a click would show an error");
    exit = 1;
  }
  if (summary && !failure) lines.push(`done  ${summary}`);
  // --save: the accepted records go into the site the way a click's do (same merge, version bump), so a new page
  // opens with its values; a failed try saves nothing
  let saved = null;
  if (save && exit === 0 && accepted.length) {
    const file = writeRecords(dir, targetOf(name, def), accepted, { attribution: bound.attribution || [] });
    saved = { file: file.rel, records: file.applied.length, version: file.version };
    lines.push(`saved ${file.applied.length} record(s) to ${file.rel} (version ${file.version}); a page that is already open shows them after a reload command`);
  } else if (save) lines.push("saved nothing: the try failed");
  writeTried(dir, name, { hash: handlerHash(resolved.handler), ok: exit === 0, at: new Date().toISOString() });
  return { exit, lines, accepted, rejected, saved, error: failure ? { code: failure.code, message: failure.message } : null };
}
