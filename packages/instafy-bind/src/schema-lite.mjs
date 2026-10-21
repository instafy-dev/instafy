// JSON-Schema subset validator, compatible with map-pack ENGINE-SPEC v0.2 §9.2.
//
// Subset (intent params): type (also an array of types), properties, required,
// additionalProperties: false, enum, const, default, minimum, maximum, minLength,
// maxLength, pattern, items, minItems, maxItems, format (date, date-time, uri),
// title, description.
//
// Extended (records schema, bound.json): the subset plus oneOf, $ref (local
// "#/$defs/..."), $defs, maxProperties, additionalProperties as a schema, $schema, $id.
//
// checkSchema() reports unknown keywords, so a constraint is never silently ignored.

export const SUBSET_KEYWORDS = [
  "type", "properties", "required", "additionalProperties", "enum", "const", "default",
  "minimum", "maximum", "minLength", "maxLength", "pattern", "items", "minItems", "maxItems",
  "format", "title", "description",
];
export const EXTENDED_KEYWORDS = [...SUBSET_KEYWORDS, "oneOf", "$ref", "$defs", "maxProperties", "$schema", "$id"];
const TYPES = ["object", "string", "number", "integer", "boolean", "array", "null"];
const FORMATS = ["date", "date-time", "uri"];

/** Check a schema itself. Returns [{path, message}]. `extended: false` allows the §9.2 subset only. */
export function checkSchema(schema, { extended = false, path = "$" } = {}) {
  const problems = [];
  const allowed = new Set(extended ? EXTENDED_KEYWORDS : SUBSET_KEYWORDS);
  const walk = (s, p) => {
    if (typeof s === "boolean" && extended) return;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      problems.push({ path: p, message: "schema must be an object" });
      return;
    }
    for (const k of Object.keys(s)) {
      if (!allowed.has(k)) problems.push({ path: `${p}.${k}`, message: `unsupported keyword "${k}"` });
    }
    if (s.type !== undefined) {
      for (const t of Array.isArray(s.type) ? s.type : [s.type]) {
        if (!TYPES.includes(t)) problems.push({ path: `${p}.type`, message: `unknown type "${t}"` });
      }
    }
    if (s.format !== undefined && !FORMATS.includes(s.format)) {
      problems.push({ path: `${p}.format`, message: `unsupported format "${s.format}" (use ${FORMATS.join(", ")})` });
    }
    if (s.pattern !== undefined) {
      try {
        new RegExp(s.pattern);
      } catch (error) {
        problems.push({ path: `${p}.pattern`, message: `invalid regex: ${error.message}` });
      }
    }
    if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((x) => typeof x === "string"))) {
      problems.push({ path: `${p}.required`, message: "required must be an array of property names" });
    }
    if (s.enum !== undefined && !Array.isArray(s.enum)) problems.push({ path: `${p}.enum`, message: "enum must be an array" });
    if (s.additionalProperties !== undefined && s.additionalProperties !== false && !extended) {
      problems.push({ path: `${p}.additionalProperties`, message: "only additionalProperties: false is supported" });
    }
    if (s.properties !== undefined) {
      if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) {
        problems.push({ path: `${p}.properties`, message: "properties must be an object" });
      } else {
        for (const [k, v] of Object.entries(s.properties)) walk(v, `${p}.properties.${k}`);
      }
    }
    if (s.items !== undefined) walk(s.items, `${p}.items`);
    if (extended && s.additionalProperties && typeof s.additionalProperties === "object") {
      walk(s.additionalProperties, `${p}.additionalProperties`);
    }
    if (extended && Array.isArray(s.oneOf)) s.oneOf.forEach((x, i) => walk(x, `${p}.oneOf[${i}]`));
    if (extended && s.$defs) for (const [k, v] of Object.entries(s.$defs)) walk(v, `${p}.$defs.${k}`);
    if (Array.isArray(s.required) && s.properties && s.additionalProperties === false) {
      for (const r of s.required) {
        if (!(r in s.properties)) {
          problems.push({ path: `${p}.required`, message: `"${r}" is required but not declared in properties` });
        }
      }
    }
  };
  walk(schema, path);
  return problems;
}

const typeOf = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
const typeOk = (t, v) => {
  const actual = typeOf(v);
  return t === actual || (t === "number" && actual === "integer");
};
const regexCache = new Map();
function regex(pattern) {
  let compiled = regexCache.get(pattern);
  if (!compiled) {
    compiled = new RegExp(pattern);
    regexCache.set(pattern, compiled);
  }
  return compiled;
}

function formatOk(format, value) {
  if (typeof value !== "string") return true;
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === "date-time") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
  }
  if (format === "uri") {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`only local $ref is supported (${ref})`);
  let node = root;
  for (const part of ref.slice(2).split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
  return node;
}

/** Validate a value. Returns [{path, message}]; empty means valid. Stops after `max` errors. */
export function validate(schema, value, { root = schema, path = "$", max = 50 } = {}) {
  const errors = [];
  const err = (p, m) => {
    if (errors.length < max) errors.push({ path: p, message: m });
  };
  const visit = (s, x, p) => {
    if (errors.length >= max) return;
    if (s === true || s === undefined) return;
    if (s === false) {
      err(p, "not allowed");
      return;
    }
    if (s.$ref) {
      visit(resolveRef(root, s.$ref), x, p);
      return;
    }
    if (s.oneOf) {
      // Discriminate on a "type" const when every branch has one: clearer errors than "matched 0 of 3".
      const branches = s.oneOf.map((b) => (b && b.$ref ? resolveRef(root, b.$ref) : b));
      const consts = branches.map((b) => b?.properties?.type?.const);
      if (consts.every((c) => c !== undefined) && x && typeof x === "object" && !Array.isArray(x)) {
        const index = consts.indexOf(x.type);
        if (index < 0) err(`${p}.type`, `must be one of ${consts.map((c) => JSON.stringify(c)).join(", ")}`);
        else visit(branches[index], x, p);
      } else {
        const matched = branches.filter((b) => validate(b, x, { root, path: p, max: 1 }).length === 0).length;
        if (matched !== 1) err(p, `must match exactly one schema in oneOf (matched ${matched})`);
      }
      return;
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeOk(t, x))) {
        err(p, `must be ${types.join(" or ")} (got ${typeOf(x)})`);
        return;
      }
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(x)) err(p, `must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(x))) {
      err(p, `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    }
    if (typeof x === "number") {
      if (!Number.isFinite(x)) err(p, "must be a finite number");
      if (s.minimum !== undefined && x < s.minimum) err(p, `must be >= ${s.minimum}`);
      if (s.maximum !== undefined && x > s.maximum) err(p, `must be <= ${s.maximum}`);
    }
    if (typeof x === "string") {
      const length = [...x].length;
      if (s.minLength !== undefined && length < s.minLength) err(p, `must be at least ${s.minLength} characters`);
      if (s.maxLength !== undefined && length > s.maxLength) err(p, `must be at most ${s.maxLength} characters`);
      if (s.pattern !== undefined && !regex(s.pattern).test(x)) err(p, `must match ${s.pattern}`);
      if (s.format !== undefined && !formatOk(s.format, x)) err(p, `must be a valid ${s.format}`);
    }
    if (Array.isArray(x)) {
      if (s.minItems !== undefined && x.length < s.minItems) err(p, `must have at least ${s.minItems} items`);
      if (s.maxItems !== undefined && x.length > s.maxItems) err(p, `must have at most ${s.maxItems} items`);
      if (s.items) x.forEach((item, i) => visit(s.items, item, `${p}[${i}]`));
    }
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const keys = Object.keys(x);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) err(p, `must have at most ${s.maxProperties} properties`);
      for (const r of s.required || []) if (x[r] === undefined) err(`${p}.${r}`, "is required");
      const props = s.properties || {};
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(props, k)) visit(props[k], x[k], `${p}.${k}`);
        else if (s.additionalProperties === false) err(`${p}.${k}`, "is not allowed");
        else if (s.additionalProperties && typeof s.additionalProperties === "object") visit(s.additionalProperties, x[k], `${p}.${k}`);
      }
    }
  };
  visit(schema, value, path);
  return errors;
}

/** Fill `default` values of an object schema's properties (one level, like the map engine's form). */
export function applyDefaults(schema, value) {
  if (!schema || schema.type !== "object" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = { ...value };
  for (const [k, s] of Object.entries(schema.properties || {})) {
    if (out[k] === undefined && s && s.default !== undefined) out[k] = structuredClone(s.default);
  }
  return out;
}

/** "path message; path message (+n more)" for logs and 400 reasons. */
export function formatErrors(errors, limit = 3) {
  const head = errors.slice(0, limit).map((e) => `${e.path} ${e.message}`).join("; ");
  return errors.length > limit ? `${head} (+${errors.length - limit} more)` : head;
}
