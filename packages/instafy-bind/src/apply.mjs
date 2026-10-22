// The apply step ("apply, no model"): executors never write site files.
// The binder validates records, enforces the lane and source policy per intent, stamps provenance,
// merges into the target file atomically and bumps data/version.json.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT_LANE, DEFAULT_SCRIPT_LANES, executorOf, targetOf } from "./bound.mjs";
import { formatErrors } from "./schema-lite.mjs";
import { noteSiteWrite } from "./save-owner.mjs";
import { originAllowed, uriParamOrigins } from "./net.mjs";
import {
  MAX_FILE_BYTES, RECORDS_PATH_RE, RECORDS_SCHEMA_ID, emptyRecordsFile, mergeRecords, normalizeRecord, rid, trimRecords, validateRecord,
} from "./records.mjs";

const FUTURE_SLACK_MS = 5 * 60 * 1000;

// A viewer's position must not land in shared records (every viewer reads them, and the site's files are
// committed): params that look like coordinates, and any the intent lists in `private_params`, go to the
// handler only. prov.intent keeps the rest and names what it withheld, so retry() knows it cannot re-send.
const LOCATION_PARAM_RE = /^(lat|lng|lon|long|latitude|longitude|coords?|coordinates|position|geo|geolocation|location|accuracy|altitude|heading|near|near_me|my_location|user_location)$/i;
const COORD_PAIR_RE = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;

function looksLikePosition(value) {
  if (typeof value === "string") return COORD_PAIR_RE.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length >= 2 && value.length <= 3 && value.every((n) => typeof n === "number") && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 180 && value.some((n) => !Number.isInteger(n));
  return Object.keys(value).some((key) => LOCATION_PARAM_RE.test(key));
}

/** The params safe to keep in shared records, and the names withheld from them. */
export function shareableParams(params, def = {}) {
  const declared = Array.isArray(def.private_params) ? def.private_params : [];
  const kept = {};
  const withheld = [];
  for (const [key, value] of Object.entries(params && typeof params === "object" ? params : {})) {
    if (declared.includes(key) || LOCATION_PARAM_RE.test(key) || looksLikePosition(value)) withheld.push(key);
    else kept[key] = value;
  }
  return { params: kept, withheld };
}
export const DEFAULT_AGENT_TTL_S = 3600;

function writeJsonAtomic(file, value, { pretty = false } = {}) {
  const text = `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  // In a space's checkout, the serving binder owns this write and commits it (save-owner.mjs).
  noteSiteWrite(file, text);
  return Buffer.byteLength(text);
}

function insideSite(siteDir, file) {
  const realSite = fs.realpathSync(siteDir);
  const realDir = fs.realpathSync(path.dirname(file));
  return realDir === realSite || realDir.startsWith(realSite + path.sep);
}

export function versionFile(siteDir) {
  return path.join(siteDir, "data", "version.json");
}

export function readVersion(siteDir) {
  try {
    const value = JSON.parse(fs.readFileSync(versionFile(siteDir), "utf8"));
    if (value && typeof value.v === "number") return { files: {}, jobs: {}, ...value };
  } catch {
    // start fresh
  }
  return { v: 0, updated_at: null, files: {}, jobs: {} };
}

/** v + 1; files[path] = new v for touched files; jobs merged (last 200 kept). */
export function bumpVersion(siteDir, { files = [], jobs = null } = {}) {
  fs.mkdirSync(path.join(siteDir, "data"), { recursive: true });
  const version = readVersion(siteDir);
  version.v = (version.v || 0) + 1;
  version.updated_at = new Date().toISOString();
  for (const file of files) version.files[file] = version.v;
  if (jobs) {
    version.jobs = { ...version.jobs, ...jobs };
    const keys = Object.keys(version.jobs);
    if (keys.length > 200) for (const key of keys.slice(0, keys.length - 200)) delete version.jobs[key];
  }
  writeJsonAtomic(versionFile(siteDir), version, { pretty: true });
  return version;
}

export function readRecordsFile(file) {
  if (!fs.existsSync(file)) return emptyRecordsFile();
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schema !== RECORDS_SCHEMA_ID || !Array.isArray(value.records)) throw new Error(`${file} is not a ${RECORDS_SCHEMA_ID} file`);
  return value;
}

const RID_RE = /^[A-Za-z0-9_.:-]{1,96}$/;

/**
 * Agent replies are filled in before validation. The binder, not the model, owns:
 * - prov.lane (the intent's agent lane) and prov.observed_at (when the binder received the reply; a model's
 *   clock or training-data date never decides a merge);
 * - ttl_s and source defaults;
 * - cid/oid/iid when they are missing or malformed (built from ref, attr and source).
 */
function prepareAgentRecord(record, { lane, ttl, now }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const prov = record.prov && typeof record.prov === "object" && !Array.isArray(record.prov) ? record.prov : {};
  record.prov = prov;
  prov.lane = lane;
  prov.observed_at = now.toISOString();
  if (prov.ttl_s === undefined) prov.ttl_s = ttl;
  if (prov.source === undefined) {
    try {
      prov.source = new URL(prov.url).hostname.replace(/^www\./, "");
    } catch {
      prov.source = "octo";
    }
  }
  if (record.type === "claim" && (typeof record.cid !== "string" || !RID_RE.test(record.cid))) {
    record.cid = rid("clm", record.ref, record.attr, prov.source);
  }
  if (record.type === "offer" && (typeof record.oid !== "string" || !RID_RE.test(record.oid))) {
    record.oid = rid("off", record.ref, prov.source, record.variant?.label || record.label || "");
  }
  if (record.type === "item" && (typeof record.iid !== "string" || !RID_RE.test(record.iid))) {
    record.iid = rid("itm", prov.source, record.name?.en || Object.values(record.name || {})[0] || "");
  }
  return record;
}

/** Script records get the fields a handler may leave out: `prov.observed_at` (the binder's clock), `prov.ttl_s`,
 *  `prov.lane` (local when allowed) and `prov.source` (the URL's host). What the handler set stays. */
export const DEFAULT_SCRIPT_TTL_S = 3600;
function prepareScriptRecord(record, { lanes, now }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  if (record.prov === undefined) record.prov = {};
  const prov = record.prov;
  if (!prov || typeof prov !== "object" || Array.isArray(prov)) return record;
  if (prov.observed_at === undefined) prov.observed_at = now.toISOString();
  if (prov.ttl_s === undefined) prov.ttl_s = DEFAULT_SCRIPT_TTL_S;
  if (prov.lane === undefined) prov.lane = lanes.includes("local") ? "local" : lanes[0];
  if (prov.source === undefined && typeof prov.url === "string") {
    try {
      prov.source = new URL(prov.url).hostname.replace(/^www\./, "");
    } catch {
      // left out: the schema names it
    }
  }
  return record;
}

function recordUrls(record) {
  return [record.prov?.url, record.prov?.license?.url, record.handoff?.url].filter((url) => typeof url === "string");
}

/** The ref an intent's records are about: the schema-checked params.ref, else the envelope ref. */
export function intentRef(intent) {
  if (typeof intent?.params?.ref === "string" && intent.params.ref) return intent.params.ref;
  return typeof intent?.ref === "string" && intent.ref ? intent.ref : null;
}

/** Origins an agent intent's records may link to: agent.allowed_origins, else the origins of its URL params. */
export function agentOrigins(def, intent) {
  if (def.agent?.allowed_origins?.length) return def.agent.allowed_origins;
  const fromParams = uriParamOrigins(def.params, intent?.params);
  return fromParams.length ? fromParams : null;
}

/**
 * Check and stamp records from one executor batch. Pure (no file writes).
 * Agent records must be about the intent's ref, stay inside its origins and use its lane.
 * Returns {accepted, rejected: [{index, reason}]}.
 */
export function checkRecords(records, { name, def, intent, job, now = new Date() }) {
  const executor = executorOf(def);
  const agentLane = def.agent?.lane || DEFAULT_AGENT_LANE;
  const lanes = def.lanes || (executor === "agent" ? [agentLane] : DEFAULT_SCRIPT_LANES);
  const ttl = def.agent?.ttl_s ?? DEFAULT_AGENT_TTL_S;
  const scopeRef = executor === "agent" ? intentRef(intent) : null;
  const origins = executor === "agent" ? agentOrigins(def, intent) : null;
  const accepted = [];
  const rejected = [];
  (Array.isArray(records) ? records : []).forEach((raw, index) => {
    let record = normalizeRecord(raw);
    if (executor === "agent") record = prepareAgentRecord(record, { lane: agentLane, ttl, now });
    else record = prepareScriptRecord(record, { lanes, now });
    const problems = validateRecord(record);
    if (problems.length) {
      rejected.push({ index, reason: formatErrors(problems, 2) });
      return;
    }
    if (!lanes.includes(record.prov.lane)) {
      rejected.push({ index, reason: `lane "${record.prov.lane}" is not allowed for ${name} (${lanes.join(", ")})` });
      return;
    }
    if (def.sources && !def.sources.includes(record.prov.source)) {
      rejected.push({ index, reason: `source "${record.prov.source}" is not declared in ${name}.sources` });
      return;
    }
    if (executor === "agent" && record.type !== "item") {
      if (!scopeRef) {
        rejected.push({ index, reason: `${name} has no ref (add a "ref" param), so its agent records cannot be scoped` });
        return;
      }
      if (record.ref !== scopeRef) {
        rejected.push({ index, reason: `ref "${String(record.ref).slice(0, 60)}" is not the clicked ref ${scopeRef}` });
        return;
      }
    }
    if (executor === "agent" && origins) {
      const outside = recordUrls(record).find((url) => !originAllowed(url, origins));
      if (outside) {
        rejected.push({ index, reason: `URL outside allowed_origins: ${outside.slice(0, 80)}` });
        return;
      }
    }
    const observed = Date.parse(record.prov.observed_at);
    if (observed > now.getTime() + FUTURE_SLACK_MS) record.prov.observed_at = now.toISOString();
    const shared = shareableParams(intent.params, def);
    record.prov.intent = { name, params: shared.params, id: intent.id, ...(shared.withheld.length ? { withheld: shared.withheld } : {}) };
    record.prov.job = job;
    record.prov.observed_by = `instafy-bind/${executor}`;
    accepted.push(record);
  });
  return { accepted, rejected };
}

/**
 * Merge accepted records into the intent's target file and bump data/version.json.
 * A file that would pass 200 KB (map viewers ignore larger files) drops expired, then oldest, records.
 * Returns {rel, v, version, total, applied, added, replaced, kept, dropped, trimmed, bytes, limit}.
 */
export function writeRecords(siteDir, rel, records, { jobs = null, attribution = [], limit = MAX_FILE_BYTES } = {}) {
  if (!RECORDS_PATH_RE.test(rel)) throw new Error(`records path "${rel}" must look like data/records/<name>.json`);
  const file = path.join(siteDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!insideSite(siteDir, file)) throw new Error(`records path "${rel}" leaves the site`);
  const current = readRecordsFile(file);
  const merged = mergeRecords(current.records, records);
  const trim = trimRecords(merged.records, limit);
  const stored = new Set(trim.records);
  const out = {
    schema: RECORDS_SCHEMA_ID,
    writer: { cmd: "instafy-bind", updated_at: new Date().toISOString() },
    attribution: [...new Set([...(current.attribution || []), ...attribution.filter(Boolean)])].slice(0, 10),
    records: trim.records,
  };
  const bytes = writeJsonAtomic(file, out);
  const version = bumpVersion(siteDir, { files: [rel], jobs });
  return {
    rel, v: version.files[rel], version: version.v, total: trim.records.length, applied: merged.applied.filter((r) => stored.has(r)),
    added: merged.added, replaced: merged.replaced, kept: merged.kept, dropped: merged.dropped, trimmed: trim.trimmed, bytes, limit,
  };
}

/** checkRecords + writeRecords for one batch. `applied` is what was stored (and is what viewers are sent). */
export function applyBatch(siteDir, records, { name, def, intent, job, ids = [intent.id], bound = null, now }) {
  const { accepted, rejected } = checkRecords(records, { name, def, intent, job, now });
  if (accepted.length === 0) return { accepted, applied: [], rejected, file: null, trimmed: 0 };
  const jobs = Object.fromEntries(ids.map((id) => [id, "running"]));
  const file = writeRecords(siteDir, targetOf(name, def), accepted, { jobs, attribution: bound?.attribution || [] });
  return { accepted, applied: file.applied, rejected, file, trimmed: file.trimmed };
}

const collected = new Map();

/** All records the site currently holds, across declared targets and results.files. Cached per version.json v. */
export function collectRecords(siteDir, bound) {
  const v = readVersion(siteDir).v;
  const cached = collected.get(siteDir);
  if (cached && cached.v === v && cached.bound === bound) return cached.value;
  const value = collectRecordsUncached(siteDir, bound);
  collected.set(siteDir, { v, bound, value });
  return value;
}

function collectRecordsUncached(siteDir, bound) {
  const files = new Set(bound.results?.files || []);
  for (const [name, def] of Object.entries(bound.intents)) files.add(targetOf(name, def));
  const version = readVersion(siteDir);
  for (const rel of Object.keys(version.files || {})) if (RECORDS_PATH_RE.test(rel)) files.add(rel);
  const records = [];
  const versions = {};
  for (const rel of files) {
    try {
      const value = readRecordsFile(path.join(siteDir, rel));
      records.push(...value.records);
      versions[rel] = version.files?.[rel] ?? 0;
    } catch {
      // unreadable files are skipped; the static file still shows the problem
    }
  }
  return { schema: RECORDS_SCHEMA_ID, v: version.v, files: versions, records };
}
