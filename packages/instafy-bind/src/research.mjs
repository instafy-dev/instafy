// Research handoff files ("instafy.research@1"): what a research-team lane writes, one file per city or product.
// `instafy web handoff --check <file>` checks one file against the schema (no network); `instafy web handoff <dir>`
// lists a folder's usable items and reads each product price's page again, so a builder carries only prices the page
// still shows. Generic: a shopping page needs no map pack for this, a trip's map pack has its own builder on top.
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { pageText, politeFetch } from "./web.mjs";
import { classify, STATUS, Tally } from "./lookup.mjs";

const KINDS = ["hotel", "station", "sight", "food", "store"];
const isUrl = (u) => typeof u === "string" && /^https?:\/\/\S+$/.test(u);

/** "Hualien and Taitung", "Kaohsiung / Tainan", "Porto, Braga": an item that names several stops. */
export const isCluster = (item) => /\s(and|&)\s|[,/、]|\s\+\s/i.test(String(item || ""));
const clusterCities = (item) => String(item || "").split(/\s+(?:and|&|\+)\s+|\s*[,/、]\s*/i).map((x) => x.trim()).filter(Boolean);
const namedCity = (it, x) => {
  const text = `${x?.query || ""} ${x?.name || ""} ${x?.from || ""} ${x?.text || ""}`.toLowerCase();
  return clusterCities(it.item).find((c) => text.includes(c.toLowerCase())) || null;
};

/** Check one handoff object: { ok, errors[], item } with the usable parts. */
export function checkHandoff(j) {
  const errors = [];
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, errors: ["not a JSON object"] };
  if (j.schema !== "instafy.research@1") errors.push(`schema is ${JSON.stringify(j.schema)}, expected "instafy.research@1"`);
  if (typeof j.item !== "string" || !j.item.trim()) errors.push("item missing");
  if (!["city", "product"].includes(j.kind)) errors.push("kind must be city or product");
  const arr = (k) => (j[k] === undefined ? [] : Array.isArray(j[k]) ? j[k] : (errors.push(`${k} must be an array`), []));
  const facts = arr("facts").filter((f, i) => {
    if (typeof f?.text !== "string" || !f.text.trim()) { errors.push(`facts[${i}].text missing`); return false; }
    if (!isUrl(f.source_url)) { errors.push(`facts[${i}] has no source_url: listed as unverified`); return false; }
    if (!["high", "medium", "low"].includes(f.confidence)) { errors.push(`facts[${i}].confidence must be high, medium or low`); return false; }
    return true;
  });
  const places = arr("places").filter((p, i) => {
    if (typeof p?.name !== "string" || !p.name.trim()) { errors.push(`places[${i}].name missing`); return false; }
    if (!KINDS.includes(p.kind)) { errors.push(`places[${i}].kind must be one of ${KINDS.join(", ")}`); return false; }
    for (const k of ["lat", "lng", "lon", "coord", "coordinates", "geometry"]) if (p[k] !== undefined) errors.push(`places[${i}] carries "${k}": ignored (places are looked up by query)`);
    return true;
  });
  const legs = arr("legs").filter((l, i) => {
    if (typeof l?.from !== "string" || typeof l?.to !== "string") { errors.push(`legs[${i}] needs from and to`); return false; }
    return true;
  });
  const prices = arr("prices").filter((x, i) => {
    if (!Number.isFinite(x?.amount) || x.amount <= 0) { errors.push(`prices[${i}].amount must be a number copied from the page (e.g. 150 or 129.95)`); return false; }
    if (typeof x.currency !== "string" || !/^[A-Z]{3}$/.test(x.currency)) { errors.push(`prices[${i}].currency must be a 3-letter code (USD, EUR, SEK)`); return false; }
    if (!isUrl(x.source_url) || !/^https:/.test(x.source_url)) { errors.push(`prices[${i}] has no https source_url (the product page that shows it): dropped`); return false; }
    if (typeof x.retrieved_at !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(x.retrieved_at)) { errors.push(`prices[${i}].retrieved_at must be the day you read it (YYYY-MM-DD)`); return false; }
    return true;
  });
  if (j.kind === "city" && prices.length) errors.push("prices are for product files; a hotel price is never typed (only a price check reads it)");
  const unknowns = arr("unknowns").filter((u) => typeof u === "string" && u.trim());
  if (j.kind === "city" && isCluster(j.item)) {
    const loose = places.filter((p) => (typeof p.stop !== "string" || !p.stop.trim()) && !namedCity(j, p)).length;
    if (loose) errors.push(`item "${j.item}" covers several stops, but ${loose} place(s) have no "stop" and name none of them: put "stop": "<City>" on every place and leg`);
  }
  const fatal = errors.some((e) => /^(not a JSON|schema|item missing|kind must)/.test(e));
  if (j.kind === "city" && (typeof j.country !== "string" || !j.country.trim())) errors.push('no "country": add "country": "<name>" so the builder can tell this city from places of the same name elsewhere');
  if (j.kind === "product" && typeof j.successor === "string" && j.successor.trim())
    errors.push(`"successor": ${JSON.stringify(j.successor.slice(0, 60))} is newer than the researched model: research the current one and keep the older one as "previous", or say why the older one fits better in "summary"`);
  const clip = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined);
  return {
    ok: !fatal,
    errors,
    item: {
      item: j.item, kind: j.kind, summary: typeof j.summary === "string" ? j.summary : "", facts, places, legs, unknowns,
      prices: j.kind === "product" ? prices : [],
      ...(clip(j.model) ? { model: clip(j.model) } : {}), ...(clip(j.previous) ? { previous: clip(j.previous) } : {}),
    },
  };
}

/** Does a page's text (or its raw HTML, where a schema.org offer says "price":"150.00") show this amount? 150 matches
 *  "150", "$150.00", "150,00 kr"; 1299 also "1,299" and "1 299". */
export function pageShowsPrice(text, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const int = Math.floor(amount + 1e-9);
  const cents = Math.round((amount - int) * 100);
  const grouped = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, "[,.\\s  ]?");
  const dec = cents ? `[.,]${String(cents).padStart(2, "0")}` : "(?:[.,]0{1,2})?";
  return new RegExp(`(?<![\\d.,])${grouped}${dec}(?![\\d]|[.,]\\d)`).test(String(text || ""));
}

/** Read each price's page again (the polite reader's rules). A price its page no longer shows, or whose page is gone,
 *  gets `stale: true`; one still shown gets `checked: true`; an unreadable page leaves the price as it was; a site
 *  that did not answer (unavailable: down, refused, timed out) leaves it as it was with `unchecked: "unavailable"`,
 *  never stale. `status` is the lookup status of the whole re-check (ok | partial | unavailable). */
export async function recheckPrices(items, { maxPages = 25, concurrency = 4, fetchPage = politeFetch } = {}) {
  const urls = [...new Set(items.flatMap((it) => (it.prices || []).map((x) => x.source_url)))];
  const todo = urls.slice(0, maxPages);
  const pages = new Map();
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const url = todo[next++];
      try {
        const r = await fetchPage(url, { timeoutMs: 15_000 });
        if (r.refused || r.challenge) pages.set(url, { state: "unreadable" });
        else if (r.status === 404 || r.status === 410) pages.set(url, { state: "gone" });
        else if (r.status >= 400) pages.set(url, { state: "unreadable" });
        else pages.set(url, { state: "ok", text: `${/json/i.test(r.type || "") ? r.text : pageText(r.text).lines.join("\n")}\n${r.text}` });
      } catch (error) {
        pages.set(url, { state: classify(error) === "unavailable" ? "unavailable" : "unreadable", host: hostOf(url) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  let stale = 0;
  let checked = 0;
  for (const it of items) {
    for (const x of it.prices || []) {
      const pg = pages.get(x.source_url);
      if (pg?.state === "gone" || (pg?.state === "ok" && !pageShowsPrice(pg.text, x.amount))) { x.stale = true; stale += 1; }
      else if (pg?.state === "ok") { x.checked = true; checked += 1; }
      else if (pg?.state === "unavailable") x.unchecked = "unavailable";
    }
  }
  const tally = new Tally();
  for (const pg of pages.values()) {
    tally.add(pg.state === "unavailable" ? STATUS.UNAVAILABLE : pg.state === "gone" ? STATUS.NOT_FOUND : STATUS.OK, { label: pg.host });
  }
  const read = [...pages.values()].filter((p) => p.state === "ok").length;
  const unavailable = [...pages.values()].filter((p) => p.state === "unavailable");
  return {
    status: urls.length ? tally.status : STATUS.OK, pages: urls.length, read, skipped: Math.max(0, urls.length - todo.length), checked, stale,
    unavailable: unavailable.length, unavailable_sites: [...new Set(unavailable.map((p) => p.host))],
  };
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "the store"; } };

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { error: error.code === "ENOENT" ? "no such file" : `not valid JSON (${error.message})` };
  }
}

export const HANDOFF_HELP = `handoff --check <file.json>
        Check one research handoff file ("instafy.research@1", one city or product per lane) against the schema,
        no network: prints what is wrong. Exit 1 when it is not usable.
handoff <handoff dir> [--json]
        The folder's usable items and, for products, each price read again on its page: a price the page no longer
        shows is listed as stale (leave it off the page or say it is unconfirmed). Exit 1 when no file is usable.`;

/** `instafy web handoff …`: resolves with the exit code. */
export async function runHandoffCommand(target, { check = false, json = false, stdout, stderr, fetchPage }) {
  if (!target) {
    stderr.write(`instafy web handoff: name a file (--check) or a folder\n\n${HANDOFF_HELP}\n`);
    return 64;
  }
  const say = (value, lines) => stdout.write(json ? `${JSON.stringify(value)}\n` : `${lines.filter((l) => l !== null).join("\n")}\n`);
  if (check) {
    const { value, error } = readJson(target);
    if (error) { say({ ok: false, file: target, errors: [error] }, [`${target}: ${error}`]); return 1; }
    const c = checkHandoff(value);
    const it = c.item || {};
    const counts = c.ok ? `${it.places.length} place(s), ${it.facts.length} sourced fact(s), ${it.legs.length} leg(s)${it.kind === "product" ? `, ${it.prices.length} sourced price(s)` : ""}` : "";
    say({ ok: c.ok, file: target, errors: c.errors }, [
      c.ok ? `${target}: usable (${counts})${c.errors.length ? "; fix these:" : "."}` : `${target}: NOT usable; fix these:`,
      ...c.errors.map((e) => `  ${e}`),
    ]);
    return c.ok ? 0 : 1;
  }
  let files;
  try { files = fs.readdirSync(target).filter((f) => f.endsWith(".json")).sort(); } catch { files = null; }
  if (!files) { stderr.write(`instafy web handoff: no handoff folder at ${target}\n`); return 1; }
  const items = [];
  const problems = [];
  for (const f of files) {
    const { value, error } = readJson(path.join(target, f));
    if (error) { problems.push(`${f}: ${error}`); continue; }
    const c = checkHandoff(value);
    for (const e of c.errors) problems.push(`${f}: ${e}`);
    if (c.ok) items.push(c.item);
  }
  if (!items.length) {
    say({ ok: false, files: files.length, problems }, [`No usable handoff file in ${target}:`, ...problems.map((p) => `  ${p}`)]);
    return 1;
  }
  const prices = await recheckPrices(items, fetchPage ? { fetchPage } : {});
  const priced = items.flatMap((it) => (it.prices || []).map((x) => ({ item: it.item, model: it.model, store: x.store || hostOf(x.source_url), ...x })));
  say({ ok: true, status: prices.status, files: files.length, items: items.map((i) => ({ item: i.item, kind: i.kind, model: i.model, summary: i.summary, unknowns: i.unknowns })), problems, prices: priced, recheck: prices }, [
    `${items.length} handoff item(s): ${items.map((i) => `${i.item}${i.model ? ` (${i.model})` : ""}`).join(", ")}`,
    priced.length ? `Prices read again: ${prices.read} of ${prices.pages} page(s); ${prices.checked} still on the page, ${prices.stale} stale.` : null,
    prices.unavailable ? `UNAVAILABLE: ${prices.unavailable} page(s) did not answer (${prices.unavailable_sites.join(", ")}): those prices are unconfirmed, not stale. Show them as "not re-checked" and offer a re-check later.` : null,
    problems.length ? `Problems (skipped parts):\n${problems.map((p) => `  ${p}`).join("\n")}` : null,
    priced.length ? 'Prices (put each on the page as "seen <day> at <store>" with its link; leave a stale one off or mark it unconfirmed):' : null,
    ...priced.map((x) => `  ${x.item}${x.model ? ` (${x.model})` : ""}: ${x.amount} ${x.currency}${x.kind ? ` ${x.kind}` : ""} at ${x.store}, seen ${x.retrieved_at}${x.stale ? ", STALE (the page no longer shows it)" : x.checked ? ", still on the page" : x.unchecked === "unavailable" ? ", not re-checked (the store did not answer)" : ""} [${x.source_url}]`),
    ...items.filter((i) => i.kind === "product" && !i.prices.length).map((i) => `  ${i.item}: no price from a page (a store that blocks reads gets a "check the price" link)`),
    items.some((i) => i.unknowns.length) ? "Unverified (say so on the page and in the reply):" : null,
    ...items.flatMap((i) => i.unknowns.map((u) => `  ${i.item}: ${u}`)),
  ]);
  return 0;
}
