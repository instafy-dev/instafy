import test from "node:test";
import assert from "node:assert/strict";
import { applyDefaults, checkSchema, validate } from "../src/schema-lite.mjs";

const params = {
  type: "object",
  required: ["url", "size"],
  additionalProperties: false,
  properties: {
    url: { type: "string", format: "uri", maxLength: 50 },
    size: { type: "string", enum: ["40", "41", "42"] },
    qty: { type: "integer", minimum: 1, maximum: 3, default: 1 },
    when: { type: "string", format: "date" },
    at: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    note: { type: ["string", "null"], pattern: "^[a-z ]*$" },
  },
};

test("subset: valid params pass", () => {
  assert.deepEqual(validate(params, { url: "https://a.example/x", size: "42", qty: 2, when: "2026-10-11", at: [1, 2.5], note: null }), []);
});

test("subset: each keyword reports", () => {
  const errors = validate(params, { url: "not a url", size: "43", qty: 1.5, when: "2026-13-45", at: [1], note: "UPPER", extra: 1 });
  const paths = errors.map((e) => e.path);
  for (const p of ["$.url", "$.size", "$.qty", "$.when", "$.at", "$.note", "$.extra"]) assert.ok(paths.includes(p), `missing ${p}: ${JSON.stringify(errors)}`);
  assert.deepEqual(validate(params, { size: "40" }).map((e) => e.path), ["$.url"]);
  assert.equal(validate({ type: "string", maxLength: 3 }, "abcd").length, 1);
  assert.equal(validate({ type: "number" }, Infinity).length, 1);
  assert.equal(validate({ const: 2 }, 3).length, 1);
});

test("checkSchema: unknown keywords and bad shapes are errors in the subset", () => {
  assert.deepEqual(checkSchema(params), []);
  const problems = checkSchema({ type: "object", properties: { a: { type: "string", oneOf: [] }, b: { type: "strin" } }, additionalProperties: {} });
  const messages = problems.map((p) => p.message).join(" | ");
  assert.match(messages, /unsupported keyword "oneOf"/);
  assert.match(messages, /unknown type "strin"/);
  assert.match(messages, /only additionalProperties: false/);
  assert.match(checkSchema({ type: "string", pattern: "(" })[0].message, /invalid regex/);
  assert.match(checkSchema({ type: "string", format: "email" })[0].message, /unsupported format/);
  assert.match(checkSchema({ type: "object", required: ["x"], properties: {}, additionalProperties: false })[0].message, /not declared/);
});

test("extended: oneOf with $ref/$defs, maxProperties, additionalProperties as a schema", () => {
  const schema = {
    $defs: {
      a: { type: "object", required: ["type", "n"], properties: { type: { const: "a" }, n: { type: "integer" } } },
      b: { type: "object", required: ["type"], properties: { type: { const: "b" }, tags: { type: "object", maxProperties: 2, additionalProperties: { type: "string", maxLength: 3 } } } },
    },
    type: "array",
    items: { oneOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }] },
  };
  assert.deepEqual(checkSchema(schema, { extended: true }), []);
  assert.ok(checkSchema(schema).length > 0, "subset rejects $defs/oneOf");
  assert.deepEqual(validate(schema, [{ type: "a", n: 1 }, { type: "b", tags: { x: "ok" } }]), []);
  const errors = validate(schema, [{ type: "c" }, { type: "a", n: "1" }, { type: "b", tags: { x: "long", y: "a", z: "b" } }]);
  assert.match(JSON.stringify(errors), /must be one of/);
  assert.ok(errors.some((e) => e.path === "$[1].n"));
  assert.ok(errors.some((e) => e.message.includes("at most 2 properties")));
  assert.ok(errors.some((e) => e.path === "$[2].tags.x"));
  // Without a discriminating const, oneOf counts matches.
  const plain = { oneOf: [{ type: "string" }, { type: "number" }] };
  assert.deepEqual(validate(plain, 1), []);
  assert.equal(validate(plain, true).length, 1);
});

test("applyDefaults fills missing properties only", () => {
  assert.deepEqual(applyDefaults(params, { url: "https://x.y", size: "40" }), { url: "https://x.y", size: "40", qty: 1 });
  assert.deepEqual(applyDefaults(params, { qty: 3 }), { qty: 3 });
});
