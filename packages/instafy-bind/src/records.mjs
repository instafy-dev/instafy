// instafy.records@1 records: normalise, validate, merge.
// The bind client carries the same merge rules in client/bind-client.js.
import { RECORDS_SCHEMA } from "./records-schema.mjs";
import { validate } from "./schema-lite.mjs";

export { RECORDS_SCHEMA };
export const RECORDS_SCHEMA_ID = "instafy.records@1";
export const RECORD_TYPES = ["claim", "offer", "item"];
export const LANES = ["link", "official", "open", "capture", "feed", "assist", "local"];
export const RECORDS_PATH_RE = /^data\/records\/[A-Za-z0-9_.-]{1,80}\.json$/;
export const MAX_RECORDS = 2000;
export const MAX_FILE_BYTES = 200 * 1024;

/** Copy with canonical names: `observer` becomes `observed_by`, `ttl` becomes `ttl_s`. */
export function normalizeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const out = structuredClone(record);
  const prov = out.prov;
  if (prov && typeof prov === "object" && !Array.isArray(prov)) {
    if (prov.observer !== undefined && prov.observed_by === undefined) prov.observed_by = prov.observer;
    delete prov.observer;
    if (prov.ttl !== undefined && prov.ttl_s === undefined) prov.ttl_s = prov.ttl;
    delete prov.ttl;
  }
  return out;
}

/** Validate one record against its type's definition. Returns [{path, message}]. */
export function validateRecord(record) {
  if (!record || typeof record !== "object" || !RECORD_TYPES.includes(record.type)) {
    return [{ path: "$.type", message: 'type must be "claim", "offer" or "item"' }];
  }
  return validate(RECORDS_SCHEMA.$defs[record.type], record, { root: RECORDS_SCHEMA, max: 8 });
}

/** Validate a whole records file object. */
export function validateRecordsFile(obj) {
  return validate(RECORDS_SCHEMA, obj, { max: 30 });
}

export function recordKey(record) {
  if (record.type === "claim") return `c:${record.cid}`;
  if (record.type === "offer") return `o:${record.oid}`;
  return `i:${record.iid}`;
}

const observedAt = (record) => Date.parse(record?.prov?.observed_at || "") || 0;

/** Lanes whose records come from a model or a capture. They never replace a record from another lane. */
export const LOW_TRUST_LANES = ["assist", "capture"];
const laneOf = (record) => record?.prov?.lane ?? null;

/** May `next` replace `previous`? A newer observation wins, except that assist/capture never displace other lanes. */
export function canReplace(previous, next) {
  if (LOW_TRUST_LANES.includes(laneOf(next)) && !LOW_TRUST_LANES.includes(laneOf(previous))) return false;
  return observedAt(next) >= observedAt(previous);
}

/**
 * Merge incoming records into existing ones.
 * - Same key (cid/oid/iid): the newer prov.observed_at wins.
 * - Claims with a different key but the same (ref, attr, prov.source, prov.lane): the newer replaces the older.
 * - An assist or capture record never replaces a record from another lane.
 * Returns {records, applied (the incoming records that were stored), added, replaced, kept, dropped}.
 */
export function mergeRecords(existing, incoming) {
  const byKey = new Map();
  for (const record of existing) byKey.set(recordKey(record), record);
  const applied = [];
  let added = 0;
  let replaced = 0;
  let kept = 0;
  let dropped = 0;
  for (const record of incoming) {
    const key = recordKey(record);
    const previous = byKey.get(key);
    if (previous) {
      if (canReplace(previous, record)) {
        byKey.set(key, record);
        applied.push(record);
        replaced += 1;
      } else {
        kept += 1;
      }
      continue;
    }
    if (record.type === "claim") {
      let older = null;
      for (const [otherKey, other] of byKey) {
        if (
          other.type === "claim" && other.ref === record.ref && other.attr === record.attr &&
          other.prov?.source === record.prov?.source && laneOf(other) === laneOf(record)
        ) {
          older = [otherKey, other];
          break;
        }
      }
      if (older) {
        if (canReplace(older[1], record)) {
          byKey.delete(older[0]);
          byKey.set(key, record);
          applied.push(record);
          replaced += 1;
          dropped += 1;
        } else {
          kept += 1;
        }
        continue;
      }
    }
    byKey.set(key, record);
    applied.push(record);
    added += 1;
  }
  let records = [...byKey.values()];
  if (records.length > MAX_RECORDS) {
    records = records.sort((a, b) => observedAt(b) - observedAt(a)).slice(0, MAX_RECORDS);
  }
  const stored = new Set(records);
  return { records, applied: applied.filter((r) => stored.has(r)), added, replaced, kept, dropped };
}

/** True when observed_at + ttl_s lies in the past. */
export function isExpired(record, now = Date.now()) {
  const ttl = record?.prov?.ttl_s;
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  return observedAt(record) + ttl * 1000 < now;
}

/**
 * Keep a records file under `limit` bytes: drop expired records first, then the oldest.
 * Returns {records, trimmed}.
 */
export function trimRecords(records, limit = MAX_FILE_BYTES, now = Date.now()) {
  const sizeOf = (r) => Buffer.byteLength(JSON.stringify(r)) + 1;
  let total = records.reduce((sum, r) => sum + sizeOf(r), 0) + 200;
  if (total <= limit) return { records, trimmed: 0 };
  const order = records
    .map((r) => ({ r, expired: isExpired(r, now), at: observedAt(r) }))
    .sort((a, b) => Number(b.expired) - Number(a.expired) || a.at - b.at);
  const drop = new Set();
  for (const entry of order) {
    if (total <= limit) break;
    drop.add(entry.r);
    total -= sizeOf(entry.r);
  }
  return { records: records.filter((r) => !drop.has(r)), trimmed: drop.size };
}

export function emptyRecordsFile() {
  return { schema: RECORDS_SCHEMA_ID, writer: {}, attribution: [], records: [] };
}

/** Stable record id: "<prefix>_<slug>", within the rid pattern. */
export function rid(prefix, ...parts) {
  const slug = parts
    .map((part) => String(part ?? "").normalize("NFKD").replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean)
    .join("_");
  return `${prefix}_${slug}`.slice(0, 96);
}
