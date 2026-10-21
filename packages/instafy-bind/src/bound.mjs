// bound.json: the per-site manifest of intents (map-pack ENGINE-SPEC v0.2 §9.1 plus executor fields).
import fs from "node:fs";
import path from "node:path";
import { checkSchema, validate, formatErrors } from "./schema-lite.mjs";
import { LANES, RECORDS_PATH_RE } from "./records.mjs";
import { RESERVED_INTENTS } from "./protocol.mjs";

export const BOUND_FILE = "bound.json";
export const DEFAULT_SCRIPT_TIMEOUT_S = 90;
export const DEFAULT_AGENT_TIMEOUT_S = 300;
export const DEFAULT_SCRIPT_LANES = ["open", "official", "local"];
export const DEFAULT_AGENT_LANE = "assist";
/** Lanes an Octo turn may write: its output is a model's reading, never "official" or "open" data. */
export const AGENT_LANES = ["assist", "capture"];

const ORIGIN_PATTERN = "^https?://[A-Za-z0-9*._-]+(:[0-9]{1,5})?$";

export const BOUND_SCHEMA = Object.freeze({
  type: "object",
  required: ["version", "intents"],
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    version: { const: 1 },
    title: { type: "string", maxLength: 120 },
    intents: { type: "object", maxProperties: 40, additionalProperties: { $ref: "#/$defs/intent" } },
    results: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: { type: "array", maxItems: 40, items: { $ref: "#/$defs/recordsPath" } },
        poll_s: { type: "number", minimum: 1, maximum: 300 },
        sse: { type: "boolean" },
      },
    },
    attribution: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
    parentOrigins: { type: "array", maxItems: 10, items: { type: "string", pattern: "^https?://[^/]+$" } },
  },
  $defs: {
    recordsPath: { type: "string", pattern: RECORDS_PATH_RE.source },
    lane: { enum: LANES },
    intent: {
      type: "object",
      required: ["label", "params"],
      additionalProperties: false,
      properties: {
        label: { type: "string", minLength: 1, maxLength: 40 },
        emoji: { type: "string", maxLength: 8 },
        describe: { type: "string", maxLength: 200 },
        params: { type: "object" },
        prefill: { type: "object", additionalProperties: { type: "string", maxLength: 200 } },
        ui: { type: "array", maxItems: 8, items: { type: "string", maxLength: 60 } },
        layers: { type: "array", maxItems: 20, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$" } },
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            records: { $ref: "#/$defs/recordsPath" },
            layer: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$" },
            create: { type: "object" },
          },
        },
        pending: { type: "string", pattern: "^(item|layer|none|cell:[a-z][a-z0-9_]{0,47})$" },
        confirm: { type: "boolean" },
        cooldown_s: { type: "number", minimum: 0, maximum: 3600 },
        timeout_s: { type: "number", minimum: 1, maximum: 1800 },
        sources: { type: "array", maxItems: 20, items: { type: "string", maxLength: 80 } },
        executor: { enum: ["script", "agent"] },
        handler: { type: "string", pattern: "^(pack:[a-z][a-z0-9_]{0,47}|[A-Za-z0-9_./-]{1,120}\\.mjs)$" },
        lanes: { type: "array", minItems: 1, maxItems: 7, items: { $ref: "#/$defs/lane" } },
        env: { type: "array", maxItems: 10, items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" } },
        private_params: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 64 } },
        agent: {
          type: "object",
          required: ["prompt"],
          additionalProperties: false,
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 4000 },
            allowed_origins: { type: "array", maxItems: 20, items: { type: "string", pattern: ORIGIN_PATTERN } },
            lane: { enum: AGENT_LANES },
            timeout_s: { type: "number", minimum: 10, maximum: 1800 },
            ttl_s: { type: "integer", minimum: 0, maximum: 31536000 },
          },
        },
      },
    },
  },
});

/** Which executor an intent uses: explicit `executor`, else `handler` means script, `agent` means agent. */
export function executorOf(def) {
  if (def.executor) return def.executor;
  if (def.handler) return "script";
  if (def.agent) return "agent";
  return null;
}

/** Problems with a bound.json object: [{path, message}]. */
export function checkBound(bound) {
  const problems = validate(BOUND_SCHEMA, bound, { max: 30 });
  if (problems.length) return problems;
  for (const [name, def] of Object.entries(bound.intents)) {
    const p = `$.intents.${name}`;
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(name)) problems.push({ path: p, message: "intent names must match ^[a-z][a-z0-9_]{0,47}$" });
    if (RESERVED_INTENTS.includes(name)) problems.push({ path: p, message: `"${name}" is reserved` });
    problems.push(...checkSchema(def.params, { path: `${p}.params` }));
    if (def.params?.type !== "object") problems.push({ path: `${p}.params.type`, message: 'params must be a schema with type "object"' });
    const executor = executorOf(def);
    if (!executor) problems.push({ path: p, message: 'needs "handler" (script) or "agent" (agent)' });
    if (executor === "script" && !def.handler) problems.push({ path: `${p}.handler`, message: "script intents need a handler" });
    if (executor === "agent" && !def.agent) problems.push({ path: `${p}.agent`, message: "agent intents need agent.prompt" });
    const laneSet = executor === "agent" ? AGENT_LANES : DEFAULT_SCRIPT_LANES;
    for (const lane of def.lanes || []) {
      if (executor && !laneSet.includes(lane)) {
        problems.push({ path: `${p}.lanes`, message: `${executor} intents may only write lanes ${laneSet.join(", ")} (got "${lane}")` });
      }
    }
    if (executor === "agent" && def.agent?.prompt) {
      const declared = new Set(Object.keys(def.params?.properties || {}));
      for (const [, key] of def.agent.prompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
        if (key !== "params" && !declared.has(key)) {
          problems.push({ path: `${p}.agent.prompt`, message: `{{${key}}} is not a declared param` });
        }
      }
    }
  }
  return problems;
}

/** Read and check <siteDir>/bound.json. Throws with a readable message when it is unusable. */
export function loadBound(siteDir) {
  const file = path.join(siteDir, BOUND_FILE);
  let bound;
  try {
    bound = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.code === "ENOENT" ? "not found" : error.message}`);
  }
  const problems = checkBound(bound);
  if (problems.length) throw new Error(`${file}: ${formatErrors(problems, 5)}`);
  return bound;
}

/**
 * Resolve how an intent runs. Returns {executor, handler?, ok, reason?}.
 * Script handlers must stay inside the site (or the pack dir for "pack:<name>").
 */
export function resolveIntent(def, { siteDir, packDir = null } = {}) {
  const executor = executorOf(def);
  if (executor === "agent") return { executor, ok: true };
  if (executor !== "script") return { executor, ok: false, reason: "no executor" };
  let base = siteDir;
  let rel = def.handler;
  if (rel.startsWith("pack:")) {
    if (!packDir) return { executor, ok: false, reason: `${rel} needs --pack-dir (or --handlers-dir)` };
    base = packDir;
    rel = `${rel.slice(5)}.mjs`;
  }
  const abs = path.resolve(base, rel);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { executor, ok: false, reason: `handler ${def.handler} not found` };
  }
  const realBase = fs.realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    return { executor, ok: false, reason: `handler ${def.handler} is outside the site` };
  }
  if (path.relative(realBase, real).split(path.sep).some((part) => part.startsWith("."))) {
    return { executor, ok: false, reason: `handler ${def.handler} is in a hidden folder` };
  }
  return { executor, ok: true, handler: real };
}

/** Records file for an intent: target.records or data/records/<name>.json. */
export function targetOf(name, def) {
  return def.target?.records || `data/records/${name}.json`;
}

/** Public, page-safe description of the intents (what the client's `ready` resolves to). */
export function intentCatalog(bound, runnable) {
  return Object.entries(bound.intents)
    .filter(([name]) => runnable.has(name))
    .map(([name, def]) => ({
      name,
      label: def.label,
      emoji: def.emoji,
      describe: def.describe,
      params: def.params,
      prefill: def.prefill,
      ui: def.ui,
      layers: def.layers,
      pending: def.pending || "item",
      confirm: Boolean(def.confirm),
      cooldown_s: def.cooldown_s ?? 0,
      executor: executorOf(def),
      target: { ...def.target, records: targetOf(name, def) },
    }));
}
