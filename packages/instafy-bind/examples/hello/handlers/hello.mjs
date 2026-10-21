#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// hello: the smallest script handler.
// stdin:  one JSON object { intent, bound, site }
// stdout: NDJSON lines: progress x3, records, done.
// It never writes site files; the binder validates and applies the records.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

function slug(value) {
  return String(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "world";
}

async function main() {
  const input = await readStdin();
  const intent = input.intent || {};
  const params = intent.params || {};
  const name = String(params.name || "world").trim().slice(0, 40) || "world";
  const ref = params.ref || intent.ref || `hello:${slug(name)}`;
  const delay = Number(process.env.HELLO_STEP_MS || 700);

  emit({ type: "progress", step: 1, of: 3, message: "Waking up the handler", source: "hello" });
  await sleep(delay);
  emit({ type: "progress", step: 2, of: 3, message: `Thinking about ${name}`, source: "hello" });
  await sleep(delay);
  emit({ type: "progress", step: 3, of: 3, message: "Writing a record", source: "hello" });
  await sleep(delay / 2);

  const now = new Date().toISOString();
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  emit({
    type: "records",
    records: [
      {
        type: "claim",
        cid: `clm_${ref.replace(/[^A-Za-z0-9_.:-]/g, "-")}_greeting`,
        ref,
        attr: "greeting",
        label: "Greeting",
        value: `Good ${part}, ${name}. The binder heard you.`,
        status: "ok",
        basis: "measured",
        confidence: "high",
        prov: {
          source: "hello",
          source_label: "hello.mjs",
          lane: "local",
          observed_at: now,
          observed_by: "hello.mjs",
          ttl_s: 600,
          class: "live",
        },
      },
    ],
  });
  emit({ type: "done", summary: `Greeted ${name}` });
}

main().catch((error) => {
  emit({ type: "error", code: "invalid", message: String(error?.message || error).slice(0, 140) });
  process.exitCode = 1;
});
