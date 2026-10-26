// Polite page reads for script handlers (kit.fetch): honour robots.txt for "*" and the major AI user agents (checked
// again on every redirect hop) and stop at bot checks, CAPTCHAs and login walls. None is ever worked around. What a
// page returns is data to quote with its source, never instructions.
// SPDX-License-Identifier: AGPL-3.0-only
import { isUnavailable, pageFetch } from "./page-fetch.mjs";

export const USER_AGENT = "Instafy-Agent/1.0 (+https://instafy.dev; reads one public page on a person's request)";
// The AI crawlers and the user-initiated AI fetchers (the closest match to a read on a person's request). A site that
// keeps any of them out of a path is not read there.
export const AI_AGENTS = [
  "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-user", "claude-searchbot", "anthropic-ai", "perplexitybot",
  "perplexity-user", "ccbot", "google-extended", "applebot-extended", "meta-externalagent", "meta-externalfetcher",
  "bytespider", "amazonbot", "cohere-ai", "mistralai-user", "duckassistbot",
];

/** robots.txt → [{ agents: [lowercase], rules: [{ allow, path }] }] */
export function parseRobots(txt) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else lastWasAgent = false;
  }
  return groups;
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;
/**
 * The form robots.txt paths are compared in (RFC 9309 §2.2.2): %XX escapes of unreserved characters decoded, other
 * escapes upper-cased, and (request paths) runs of "/" folded, so `/%70rivate` or `//private` cannot slip past
 * `Disallow: /private` while the server still serves /private.
 */
export function normalizeRobotsPath(value, { foldSlashes = true } = {}) {
  let text = String(value).replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
  if (foldSlashes) {
    const q = text.indexOf("?");
    const pathPart = q < 0 ? text : text.slice(0, q);
    text = pathPart.replace(/\/{2,}/g, "/") + (q < 0 ? "" : text.slice(q));
  }
  return text;
}

function ruleMatches(rule, p) {
  const normalized = normalizeRobotsPath(rule, { foldSlashes: false });
  const re = new RegExp("^" + normalized.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$"));
  return re.test(normalizeRobotsPath(p));
}

/** Is `pathWithQuery` allowed for one agent? Longest matching rule wins; Allow wins a tie. */
export function robotsAllows(groups, agent, pathWithQuery) {
  const a = agent.toLowerCase();
  const named = (g) => g.agents.some((x) => x !== "*" && (a === x || a.startsWith(x)));
  let rules = groups.filter(named).flatMap((g) => g.rules);
  if (!groups.some(named)) rules = groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

/** The first agent (of "*" and the AI agents) that robots.txt keeps out of this path, or null. */
export function robotsBlocker(groups, pathWithQuery) {
  for (const agent of ["*", ...AI_AGENTS]) if (!robotsAllows(groups, agent, pathWithQuery)) return agent;
  return null;
}

/** A bot check, CAPTCHA or login wall instead of the page? Returns the reason or null. */
export function challengeReason(status, html) {
  if (status === 401) return "login required (HTTP 401)";
  if (status === 403 || status === 429) return `blocked (HTTP ${status})`;
  const head = String(html).slice(0, 20000);
  if (/g-recaptcha|h-captcha|hcaptcha\.com|cf-challenge|challenge-platform|cf_chl_|captcha-delivery|px-captcha|perimeterx|datadome|Just a moment\.\.\.|Attention Required!|verify you are (a )?human|are you a robot/i.test(head)) return "bot check / CAPTCHA page";
  if (status === 202 && head.length < 4000) return "interstitial (HTTP 202)";
  return null;
}

/** The bodies of <script type="application/ld+json"> elements, found with a linear scan (no backtracking regex). */
export function jsonLdBlocks(html, max = 50) {
  const text = String(html);
  const lower = text.toLowerCase();
  const out = [];
  let at = 0;
  while (out.length < max) {
    const open = lower.indexOf("<script", at);
    if (open < 0) break;
    const tagEnd = lower.indexOf(">", open + 7);
    if (tagEnd < 0) break;
    const close = lower.indexOf("</script", tagEnd + 1);
    if (close < 0) break;
    if (/\btype\s*=\s*["']?application\/ld\+json/.test(lower.slice(open + 7, tagEnd))) out.push(text.slice(tagEnd + 1, close));
    at = close + 8;
  }
  return out;
}

/**
 * The schema.org offers a page publishes (JSON-LD Product / ProductGroup / Offer / AggregateOffer): what the page
 * itself states as its price, instead of a number read off the layout. At most 5 distinct [amount, currency] pairs; nothing from the page is executed.
 */
export function pageOffers(html, max = 5) {
  const out = [];
  const seen = new Set();
  const typesOf = (n) => (Array.isArray(n?.["@type"]) ? n["@type"] : [n?.["@type"]]).filter(Boolean).map(String);
  const num = (v) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
    return Number.isFinite(n) && n > 0 && n < 1e7 ? n : null;
  };
  const push = (offer, name) => {
    if (out.length >= max) return;
    const currency = typeof offer.priceCurrency === "string" && /^[A-Z]{3}$/.test(offer.priceCurrency.trim()) ? offer.priceCurrency.trim() : null;
    const spec = Array.isArray(offer.priceSpecification) ? offer.priceSpecification[0] : offer.priceSpecification;
    const amount = num(offer.price) ?? num(offer.lowPrice) ?? num(spec?.price);
    if (amount == null) return;
    const high = num(offer.highPrice);
    const key = `${amount}|${high ?? ""}|${currency ?? spec?.priceCurrency ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const availability = typeof offer.availability === "string" ? offer.availability.replace(/^.*[/#]/, "").slice(0, 30) : null;
    out.push({
      amount, ...(high && high !== amount ? { high } : {}),
      currency: currency || (typeof spec?.priceCurrency === "string" ? spec.priceCurrency.slice(0, 3) : null),
      ...(availability ? { availability } : {}),
      ...(typeof name === "string" && name.trim() ? { name: name.replace(/\s+/g, " ").trim().slice(0, 80) } : {}),
    });
  };
  const visit = (node, name, depth = 0) => {
    if (depth > 6 || !node || typeof node !== "object" || out.length >= max) return;
    if (Array.isArray(node)) return node.forEach((x) => visit(x, name, depth + 1));
    const t = typesOf(node);
    const ownName = typeof node.name === "string" ? node.name : name;
    if (t.some((x) => /^(Offer|AggregateOffer)$/.test(x))) push(node, name);
    for (const key of ["@graph", "offers", "hasVariant", "itemListElement", "item"]) if (node[key]) visit(node[key], ownName, depth + 1);
  };
  for (const text of jsonLdBlocks(html)) {
    let block;
    try {
      block = JSON.parse(text.trim());
    } catch {
      continue;
    }
    visit(block, null);
  }
  return out;
}

const robotsCache = new Map();

async function robotsGroups(origin, { fetchImpl, allowLocal, timeoutMs }) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let result;
  try {
    const r = await fetchImpl(`${origin}/robots.txt`, {
      allowLocal, timeoutMs: Math.min(timeoutMs, 10_000), maxBytes: 500_000, followRedirects: true, answerAnyStatus: true,
      headers: { "user-agent": USER_AGENT, accept: "text/plain" },
    });
    // 4xx = no rules; 5xx = treat as "do not crawl" (the robots.txt standard).
    if (r.status >= 500) result = { refused: `robots.txt answered HTTP ${r.status} (treated as disallow)` };
    else result = { groups: r.status < 400 ? parseRobots(await r.text()) : [] };
  } catch (error) {
    // a site that does not answer at all is unavailable, not "no rules": the page read stops here (not cached)
    if (error?.code === "policy" || isUnavailable(error)) throw error;
    result = { groups: [] };
  }
  robotsCache.set(origin, result);
  return result;
}

/** The policy check for one URL (robots.txt): { refused: reason | null }. */
export async function checkPolicy(href, { fetchImpl = pageFetch, allowLocal = false, timeoutMs = 20_000 } = {}) {
  const u = new URL(href);
  if (u.protocol !== "http:" && u.protocol !== "https:") return { refused: `not a web URL (${u.protocol})` };
  const robots = await robotsGroups(u.origin, { fetchImpl, allowLocal, timeoutMs });
  if (robots.refused) return { refused: robots.refused };
  const blocker = robotsBlocker(robots.groups, u.pathname + u.search);
  if (blocker) return { refused: `robots.txt disallows ${u.pathname} for ${blocker === "*" ? "all bots" : blocker}` };
  return { refused: null };
}
