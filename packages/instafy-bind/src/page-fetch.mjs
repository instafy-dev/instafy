// Page reads through the lookup chain (src/lookup.mjs): every page a handler, `instafy web cite` or a price
// re-check reads goes through the "page" capability, so a site that is down is known as down (per host, shared by
// every process on the machine) and is reported as "unavailable" (exit 4, error code "unavailable"), never as a
// missing page. A 5xx answer is "unavailable"; 404/410 and every other answer are returned to the caller.
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import { safeFetch } from "./net.mjs";
import { Health, loadProviders, lookup } from "./lookup.mjs";

const DEFAULTS = JSON.parse(fs.readFileSync(new URL("./lookup-providers.json", import.meta.url), "utf8"));

let cached = null;
/** The declared providers (lookup-providers.json + INSTAFY_LOOKUP_PROVIDERS), read once per process. */
export function pageRegistry(env = process.env) {
  if (!cached || cached.env !== env) cached = loadProviders(DEFAULTS, { env });
  return cached;
}

/** The "http-page" protocol: one GET of the URL itself (no base URL to redirect it anywhere). `answerAnyStatus`
 *  keeps a 5xx as an answer (robots.txt: 5xx means "do not crawl"). */
export const httpPageProtocol = {
  async lookup(request, provider) {
    const { answerAnyStatus = false, ...options } = request.options || {};
    const response = await safeFetch(request.url, { timeoutMs: provider.timeout_ms, ...options });
    if (!answerAnyStatus && response.status >= 500) {
      throw Object.assign(new Error(`${new URL(request.url).hostname} answered HTTP ${response.status}`), { httpStatus: response.status });
    }
    return [response];
  },
};

/**
 * safeFetch's signature and answer, through the "page" chain. Throws code "unavailable" (LookupUnavailableError,
 * exit 4) when the site did not answer, answered 5xx, or was found down moments ago; "policy" refusals as before.
 */
export async function pageFetch(url, options = {}, { env = process.env, health = new Health({ env }) } = {}) {
  let host = null;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    // safeFetch reports the bad URL
  }
  const result = await lookup("page", { url, options }, {
    registry: pageRegistry(env), health, protocols: { "http-page": httpPageProtocol }, where: { host }, label: host || "the page",
  });
  return result.results[0];
}
