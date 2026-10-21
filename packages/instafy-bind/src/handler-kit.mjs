// Helpers for script handlers. A handler loads them without a package install:
//   const kit = await import(process.env.BIND_KIT);
//   const { intent } = await kit.readInput();
//   kit.progress(1, 2, "Reading the page");
//   const page = await kit.fetch(intent.params.url);   // public http(s) only, unless the binder runs with --allow-local
//   kit.records([...]); kit.done("Found 1 price");
import fs from "node:fs";
import path from "node:path";
import { checkPublicUrl } from "./net.mjs";
import { pageFetch } from "./page-fetch.mjs";
import { checkPolicy, challengeReason, pageOffers } from "./web.mjs";
import { rid } from "./records.mjs";

export { rid };

const allowLocal = process.env.BIND_ALLOW_LOCAL === "1";
const CODES = ["not_found", "upstream", "unavailable", "invalid", "policy", "timeout"];

// A handler that throws (a site that refuses the connection, a bug) still answers with an error the site can
// show, instead of a bare exit code. Node also prints the stack to stderr, which goes to the binder log.
let reported = false;
function reportCrash(error) {
  if (reported) return;
  reported = true;
  const message = error instanceof Error ? error.message : String(error);
  const code = CODES.includes(error?.code) ? error.code : "upstream";
  try {
    process.stdout.write(`${JSON.stringify({ type: "error", code, message: message.slice(0, 300) || "the handler failed" })}\n`);
  } catch {
    // stdout is gone; the exit code still says it failed
  }
}
process.on("uncaughtExceptionMonitor", reportCrash);
process.on("unhandledRejection", (error) => {
  reportCrash(error);
  console.error(error);
  process.exitCode = 1;
});

/** The {intent, bound, site} object the binder writes to stdin. */
export async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

export function progress(step, of, message, source) {
  emit({ type: "progress", step, of, message, ...(source ? { source } : {}) });
}
export function records(list) {
  emit({ type: "records", records: list });
}
export function done(summary) {
  reported = true;
  emit({ type: "done", summary });
}
/** error(code, message), or error(message) alone (code "upstream"). */
export function error(code, message) {
  reported = true;
  if (message === undefined) [code, message] = ["upstream", code];
  emit({ type: "error", code: CODES.includes(code) ? code : "upstream", message: String(message ?? "the handler failed") });
}

/**
 * The polite, SSRF-guarded fetch: refuses loopback, private and LAN addresses (re-checked on redirects and at connect
 * time) and paths robots.txt disallows for bots (error code "policy"; record it with kit.uncertain as the reason the
 * value is missing). Never work around a refusal.
 * A site that does not answer (refused, timed out, 5xx) throws error code "unavailable": not a missing page; say it
 * could not be checked right now (the viewer can tap again later).
 */
export async function fetch(url, options = {}) {
  // Checked for the URL and for every redirect hop: a shortener or affiliate link must not lead into a page the
  // target refuses.
  const checkHop = async (hopUrl, hop) => {
    const policy = await checkPolicy(hopUrl, { allowLocal });
    if (!policy.refused) return;
    const where = hop ? `redirected to ${hopUrl}: ` : "";
    throw Object.assign(new Error(`${where}${new URL(hopUrl).hostname} refuses automated reads: ${policy.refused}`), { code: "policy" });
  };
  return pageFetch(url, { ...options, allowLocal, checkHop });
}

/** The site folder the handler serves (handlers also run with it as the working directory). */
export function siteDir() {
  return process.env.BIND_SITE || process.cwd();
}

/** An absolute path inside the site folder; refuses paths that leave it. */
export function sitePath(relative) {
  const root = path.resolve(siteDir());
  const resolved = path.resolve(root, String(relative));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Object.assign(new Error(`${relative} is outside the site folder`), { code: "invalid" });
  return resolved;
}

/** Read a JSON file of the site, e.g. `await kit.readJson("data/items.json")` for the seed data. */
export function readJson(relative) {
  return JSON.parse(fs.readFileSync(sitePath(relative), "utf8"));
}

export function checkUrl(url) {
  return checkPublicUrl(url, { allowLocal });
}

/**
 * The claim for an item a handler could not read (blocked, gone, no product data): every row still ends with a
 * reason. `note` is what the viewer reads ("asics.com blocks automated price checks; open the store").
 *   kit.records([kit.uncertain({ ref, attr: "price", url, note: `HTTP ${page.status}` })]);
 */
export function uncertain({ ref, attr, url, note, label, source }) {
  let host = source;
  if (!host) {
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "unknown";
    }
  }
  return {
    type: "claim",
    cid: rid("clm", ref, attr, host),
    ref,
    attr,
    value: null,
    ...(label ? { label } : {}),
    status: "uncertain",
    basis: "live",
    confidence: "low",
    note: String(note || "could not be checked").slice(0, 200),
    prov: { source: host, lane: "local", ...(url ? { url } : {}), observed_at: new Date().toISOString(), ttl_s: 3600 },
  };
}

/**
 * The prices a page states in its schema.org offers (JSON-LD): [{ amount, high?, currency, availability?, name? }]. Pass the page's HTML, or the response from
 * kit.fetch (then a blocked or failed page throws code "policy"/"upstream" with the reason, for kit.uncertain).
 *   const [offer] = await kit.offers(await kit.fetch(item.url));
 *   if (offer) kit.records([{ type: "offer", oid: kit.rid("off", ref, host), ref, price: { amount: offer.amount, currency: offer.currency }, prov: { source: host, url } }]);
 */
export async function offers(pageOrHtml) {
  if (typeof pageOrHtml === "string") return pageOffers(pageOrHtml);
  const html = await pageOrHtml.text();
  const status = pageOrHtml.status;
  const blocked = challengeReason(status, html);
  if (blocked) throw Object.assign(new Error(`the store blocks automated reads (${blocked})`), { code: "policy" });
  if (status >= 400) throw Object.assign(new Error(`the store answered HTTP ${status}`), { code: "upstream" });
  return pageOffers(html);
}
