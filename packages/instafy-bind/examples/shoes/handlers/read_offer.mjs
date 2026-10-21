#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// read_offer: fetch one public product page and read its schema.org Product/Offer JSON-LD.
// stdin:  { intent, bound, site }   (map-pack v0.2 §10 handler contract)
// stdout: NDJSON progress / records / done / error.
//
// Records carry prov.lane "local": a script on this machine read the page. The page is untrusted:
// only typed JSON-LD fields are read, and nothing is copied except short values (price, sizes, names).
// URLs must be https and public; private, loopback and LAN targets are refused unless the binder
// runs with --allow-local (env BIND_ALLOW_LOCAL=1), which is for local fixtures only.

import fs from "node:fs";
import path from "node:path";
import { safeFetch } from "./lib/safe-fetch.mjs";
import { buildRecords, parseProductPage, siteNameFrom, summaryLine } from "./lib/offers.mjs";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

function allowLocal(input) {
  const env = process.env.BIND_ALLOW_LOCAL || process.env.UW_ALLOW_LOCAL || "";
  return env === "1" || env === "true" || input?.host?.allow_local === true || input?.allow_local === true;
}

function seedItems(siteDir) {
  try {
    const file = path.join(siteDir || process.cwd(), "data", "items.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).items || [];
  } catch {
    return [];
  }
}

function sizeAttr(size) {
  const s = String(size).toLowerCase().replace(/\b(us|eu|uk|men'?s|women'?s|size)\b/g, "").replace(/^\s*[mw](?=\d)/, "").trim();
  const n = Number.parseFloat(s.replace(",", "."));
  const norm = Number.isFinite(n) ? String(n) : s;
  return `size_${norm.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "x"}`;
}

async function main() {
  const input = await readStdin();
  const intent = input.intent || {};
  const params = intent.params || {};
  const ref = params.ref || intent.ref;
  const url = params.url;
  if (!ref || !url) {
    emit({ type: "error", code: "invalid", message: "read_offer needs url and ref" });
    return;
  }
  const local = allowLocal(input);
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    emit({ type: "error", code: "invalid", message: "Not a valid URL" });
    return;
  }

  // Per-ref URLs come from the seed list, never from the click: a viewer must not be able to make the grid show
  // another site's price and link under a brand's name. Unknown refs are only read with --allow-local (fixtures).
  const seed = seedItems(input.site?.dir);
  const item = seed.find((i) => i.ref === ref);
  const sameHost = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
  const seedHost = item ? new URL(item.url).hostname : null;
  if (item && !sameHost(seedHost, host)) {
    emit({ type: "error", code: "policy", message: `${ref} is read from ${seedHost.replace(/^www\./, "")} only` });
    return;
  }
  if (!item && !local) {
    emit({ type: "error", code: "policy", message: `${ref} is not in data/items.json` });
    return;
  }

  emit({ type: "progress", step: 1, of: 3, message: `Fetching ${host.replace(/^www\./, "")}`, source: host });
  let page;
  try {
    page = await safeFetch(url, { allowLocal: local });
  } catch (error) {
    emit({ type: "error", code: error.code === "policy" ? "policy" : "upstream", message: String(error.message || error).slice(0, 140) });
    return;
  }

  const finalHost = new URL(page.url).hostname;
  if (item && !sameHost(seedHost, finalHost)) {
    emit({ type: "error", code: "policy", message: `The store redirected to ${finalHost}; not reading it` });
    return;
  }
  emit({ type: "progress", step: 2, of: 3, message: "Reading product data (schema.org JSON-LD)", source: finalHost });
  const summary = parseProductPage(page.text);
  if (!summary) {
    emit({ type: "error", code: "not_found", message: `No schema.org Product data on ${finalHost}. Try "Ask Octo" for this one.` });
    return;
  }

  emit({ type: "progress", step: 3, of: 3, message: "Building records", source: finalHost });
  const trust = item ? "curated" : "unknown";
  const size = typeof params.size === "string" && params.size.trim() ? params.size.trim() : null;
  const records = buildRecords({
    ref,
    pageUrl: page.url,
    host: finalHost,
    siteName: siteNameFrom(page.text, finalHost.replace(/^www\./, "")),
    summary,
    size,
    attr: size ? params.attr || sizeAttr(size) : null,
    trust,
  });
  emit({ type: "records", records });
  emit({ type: "done", summary: summaryLine(summary, finalHost) });
}

main().catch((error) => {
  emit({ type: "error", code: "invalid", message: String(error?.message || error).slice(0, 140) });
  process.exitCode = 1;
});
