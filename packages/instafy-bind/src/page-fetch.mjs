// Page reads for script handlers (kit.fetch) and for the robots.txt check: one SSRF-guarded GET (net.mjs). A site
// that does not answer (refused, reset, timed out, not resolvable) or answers 5xx is "unavailable" (error code
// "unavailable"): not a missing page, so a handler can say it could not be checked right now. 404/410 and every other
// answer are returned to the caller.
// SPDX-License-Identifier: AGPL-3.0-only
import { safeFetch } from "./net.mjs";

const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "timeout", "unavailable"]);

/** Did this error mean the site did not answer (as opposed to a refusal, a bad URL or a bug)? */
export function isUnavailable(error) {
  if (!error || error.code === "policy" || error.code === "invalid") return false;
  if (error.code === "unavailable") return true;
  const code = error.code === "upstream" ? error.cause?.code : error.code;
  return Boolean(code && UNAVAILABLE_CODES.has(code));
}

const unavailable = (message, extra = {}) => Object.assign(new Error(message), { code: "unavailable", ...extra });

/**
 * safeFetch's signature and answer. Throws code "unavailable" when the site did not answer or answered 5xx
 * (`answerAnyStatus` keeps a 5xx as an answer: robots.txt reads 5xx as "do not crawl"); "policy" refusals as before.
 */
export async function pageFetch(url, options = {}) {
  const { answerAnyStatus = false, ...rest } = options;
  let host = "the page";
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    // safeFetch reports the bad URL
  }
  let response;
  try {
    response = await safeFetch(url, rest);
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    throw unavailable(`${host} did not answer (${String(error.message).slice(0, 160)}): unavailable right now, not a missing page`, { cause: error });
  }
  if (!answerAnyStatus && response.status >= 500) {
    throw unavailable(`${host} answered HTTP ${response.status}: unavailable right now, not a missing page`, { httpStatus: response.status });
  }
  return response;
}
