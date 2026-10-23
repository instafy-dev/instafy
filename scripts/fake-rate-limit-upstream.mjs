#!/usr/bin/env node
// A fake rate-limited AI upstream for local development and tests. It forwards every request to
// the real upstream (`--target`) and answers some of them itself with HTTP 429 and a Retry-After,
// as a provider does when its rate limit is reached. Point the model proxy at it with the
// proxy's existing endpoint setting (CODEX_PROXY_CHATGPT_ENDPOINT for a ChatGPT login,
// CODEX_OPENAI_ENDPOINT for an API key) to exercise everything that handles a rate limit: the
// proxy's stream retry, the runtime's failure and the controller's pacing of team agents.
//
// Nothing in the product starts or references it. It refuses non-loopback addresses unless told,
// it never logs headers or bodies, and with no rules it only forwards.
//
//   node scripts/fake-rate-limit-upstream.mjs --target https://chatgpt.com --limit 6/20s --scope new
//   node scripts/fake-rate-limit-upstream.mjs --target https://api.openai.com --fail-rate 0.3 --window 60-180
//   node scripts/fake-rate-limit-upstream.mjs --target https://chatgpt.com --rules rules.json   # rules can change while it runs
//   node scripts/fake-rate-limit-upstream.mjs --self-check                                       # flags only, no network
//
// Rules (flags, or the same keys in a JSON rules file, which is read again whenever it changes):
//   --limit N/Ws      at most N requests forwarded in any W seconds; others get 429 with a
//                     Retry-After of when the oldest leaves the window. Keep W at 30 s or less for
//                     a wait the platform counts as a short rate limit.
//   --fail-rate F     refuse this fraction (0 to 1) of requests, with --retry-after seconds.
//   --window A-B      apply the rules only from A to B seconds after the rules were loaded
//                     (repeatable); without one they always apply.
//   --scope all|new   which requests a rule may refuse. `new` limits only requests that start a
//                     conversation: an OpenAI Responses body whose `input` holds only system,
//                     developer and user messages (no assistant output or tool result yet).
//                     Requests that continue a conversation always pass and are not counted.
//   --path P          only POST requests whose path starts with P count (default: every POST).
//   --retry-after S   Retry-After of a --fail-rate refusal (default 10).
// Each request is logged as one JSON line (time, path, verdict, reason, retryAfter, upstream
// status) to stdout, or to --log FILE.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_LISTEN = "127.0.0.1:8790";
export const DEFAULT_RETRY_AFTER_SECONDS = 10;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
const CONVERSATION_ROLES = new Set(["system", "developer", "user"]);

/** `6/20s`, `6/20` or `6/1m` as { count, windowMs }. */
export function parseLimit(text) {
  const m = /^\s*(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(String(text ?? ""));
  if (!m) throw new Error(`--limit: expected N/Ws (for example 6/20s), got ${JSON.stringify(text)}`);
  const count = Number(m[1]);
  const unit = (m[3] ?? "s").toLowerCase();
  const windowMs = Number(m[2]) * (unit === "ms" ? 1 : unit === "m" ? 60_000 : 1_000);
  if (count < 1 || !(windowMs > 0)) throw new Error("--limit: N and W must be positive");
  return { count, windowMs };
}

/** `60-180` (seconds) as { startMs, endMs }. */
export function parseWindow(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ""));
  if (!m) throw new Error(`--window: expected A-B in seconds, got ${JSON.stringify(text)}`);
  const startMs = Number(m[1]) * 1000;
  const endMs = Number(m[2]) * 1000;
  if (!(endMs > startMs)) throw new Error("--window: B must be after A");
  return { startMs, endMs };
}

/** Validated rules from flags or a rules file. Every key is optional; no rule means forward all. */
export function normalizeRules(raw = {}) {
  const known = new Set(["limit", "failRate", "windows", "scope", "path", "retryAfter"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`unknown rule ${JSON.stringify(key)}`);
  const rules = {
    limit: raw.limit == null ? null : typeof raw.limit === "string" ? parseLimit(raw.limit) : parseLimit(`${raw.limit.count}/${raw.limit.windowMs}ms`),
    failRate: raw.failRate == null ? 0 : Number(raw.failRate),
    windows: (raw.windows ?? []).map((w) => (typeof w === "string" ? parseWindow(w) : parseWindow(`${w.startMs / 1000}-${w.endMs / 1000}`))),
    scope: raw.scope ?? "all",
    path: raw.path ?? "/",
    retryAfter: raw.retryAfter == null ? DEFAULT_RETRY_AFTER_SECONDS : Number(raw.retryAfter),
  };
  if (!(rules.failRate >= 0 && rules.failRate <= 1)) throw new Error("--fail-rate: a fraction from 0 to 1");
  if (!["all", "new"].includes(rules.scope)) throw new Error("--scope: all or new");
  if (!String(rules.path).startsWith("/")) throw new Error("--path: must start with /");
  if (!(Number.isInteger(rules.retryAfter) && rules.retryAfter >= 1 && rules.retryAfter <= 3600)) {
    throw new Error("--retry-after: whole seconds from 1 to 3600");
  }
  return rules;
}

function isLoopbackHost(host) {
  if (host === "localhost") return true;
  if (net.isIPv4(host)) return host.startsWith("127.");
  return host === "::1";
}

export function parseArgs(argv) {
  const o = { listen: DEFAULT_LISTEN, target: null, rulesFile: null, log: null, allowRemote: false, selfCheck: false, help: false };
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--target") o.target = val();
    else if (a === "--listen") o.listen = val();
    else if (a === "--rules") o.rulesFile = val();
    else if (a === "--log") o.log = val();
    else if (a === "--allow-remote") o.allowRemote = true;
    else if (a === "--self-check") o.selfCheck = true;
    else if (a === "--limit") raw.limit = val();
    else if (a === "--fail-rate") raw.failRate = val();
    else if (a === "--window") (raw.windows ??= []).push(val());
    else if (a === "--scope") raw.scope = val();
    else if (a === "--path") raw.path = val();
    else if (a === "--retry-after") raw.retryAfter = val();
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.rulesFile && Object.keys(raw).length) throw new Error("give rules as flags or as --rules FILE, not both");
  o.rules = normalizeRules(raw);
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(o.listen);
  if (!m) throw new Error(`--listen: expected host:port, got ${o.listen}`);
  o.host = m[1];
  o.port = Number(m[2]);
  if (!o.allowRemote && !isLoopbackHost(o.host)) {
    throw new Error(`--listen ${o.host} is not a loopback address; pass --allow-remote to listen there`);
  }
  if (!o.help && !o.selfCheck) {
    if (!o.target) throw new Error("--target is required (the real upstream, for example https://chatgpt.com)");
    const url = new URL(o.target);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("--target must be http or https");
    if (url.search || url.hash) throw new Error("--target takes no query or fragment");
  }
  return o;
}

/** Whether an OpenAI Responses request body starts a conversation: its `input` is a string or holds
 *  only system, developer and user messages. A body that is not such a request is not new. */
export function startsConversation(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  const input = parsed?.input;
  if (typeof input === "string") return true;
  if (!Array.isArray(input) || input.length === 0) return false;
  return input.every((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type != null && item.type !== "message") return false;
    return CONVERSATION_ROLES.has(item.role);
  });
}

/** The decision state for one set of rules: `decide` says whether a request is refused and with
 *  what Retry-After. `now` and `random` are injectable for tests. */
export function createLimiter(rules, { now = () => Date.now(), random = Math.random } = {}) {
  const loadedAt = now();
  const admitted = [];
  return {
    rules,
    loadedAt,
    decide({ method, path, body }) {
      const t = now();
      const counted = method === "POST" && path.startsWith(rules.path) && (rules.scope === "all" || startsConversation(body));
      if (!counted) return { verdict: "forwarded", reason: "not counted" };
      const elapsed = t - loadedAt;
      const active = rules.windows.length === 0 || rules.windows.some((w) => elapsed >= w.startMs && elapsed < w.endMs);
      if (active && rules.limit) {
        while (admitted.length && admitted[0] <= t - rules.limit.windowMs) admitted.shift();
        if (admitted.length >= rules.limit.count) {
          const freeInMs = admitted[0] + rules.limit.windowMs - t;
          return { verdict: "refused", reason: "limit", retryAfter: Math.max(1, Math.ceil(freeInMs / 1000)) };
        }
      }
      if (active && rules.failRate > 0 && random() < rules.failRate) {
        return { verdict: "refused", reason: "fail-rate", retryAfter: rules.retryAfter };
      }
      if (rules.limit) admitted.push(t);
      return { verdict: "forwarded", reason: active ? "admitted" : "outside window" };
    },
  };
}

export function rateLimitBody(retryAfter) {
  return JSON.stringify({
    error: {
      message: `Rate limit reached (fake rate-limited upstream). Please try again in ${retryAfter}s.`,
      type: "requests",
      param: null,
      code: "rate_limit_exceeded",
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Rules from a file, read again when its modification time changes; a file that no longer
 *  parses keeps the last good rules and says so once. */
function rulesFromFile(file, { now, random, warn }) {
  let mtimeMs = -1;
  let limiter = null;
  return () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      if (!limiter) limiter = createLimiter(normalizeRules({}), { now, random });
      return limiter;
    }
    if (stat.mtimeMs !== mtimeMs) {
      mtimeMs = stat.mtimeMs;
      try {
        limiter = createLimiter(normalizeRules(JSON.parse(fs.readFileSync(file, "utf8"))), { now, random });
        warn({ event: "rules loaded", rules: describeRules(limiter.rules) });
      } catch (error) {
        warn({ event: "rules file ignored", error: String(error?.message ?? error) });
        if (!limiter) limiter = createLimiter(normalizeRules({}), { now, random });
      }
    }
    return limiter;
  };
}

export function describeRules(rules) {
  return {
    limit: rules.limit ? `${rules.limit.count}/${rules.limit.windowMs / 1000}s` : null,
    failRate: rules.failRate,
    windows: rules.windows.map((w) => `${w.startMs / 1000}-${w.endMs / 1000}`),
    scope: rules.scope,
    path: rules.path,
    retryAfter: rules.retryAfter,
  };
}

/** Starts the forwarder. Resolves to { server, url, stats, close }. */
export async function startFakeUpstream({ target, host = "127.0.0.1", port = 0, rules, rulesFile, log = () => {}, now = () => Date.now(), random = Math.random }) {
  const targetUrl = new URL(target);
  const basePath = targetUrl.pathname.replace(/\/+$/, "");
  const transport = targetUrl.protocol === "https:" ? https : http;
  const stats = { forwarded: 0, refused: 0, upstreamErrors: 0, byReason: {} };
  const fixed = rulesFile ? null : createLimiter(rules ?? normalizeRules({}), { now, random });
  const current = rulesFile ? rulesFromFile(rulesFile, { now, random, warn: log }) : () => fixed;
  if (fixed) log({ event: "rules loaded", rules: describeRules(fixed.rules) });

  const server = http.createServer(async (req, res) => {
    const startedAt = new Date(now()).toISOString();
    const path = (req.url ?? "/").split("?")[0];
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      res.writeHead(413).end();
      log({ at: startedAt, path, verdict: "rejected", reason: String(error?.message ?? error) });
      return;
    }
    const decision = current().decide({ method: req.method, path, body });
    stats.byReason[decision.reason] = (stats.byReason[decision.reason] ?? 0) + 1;
    if (decision.verdict === "refused") {
      stats.refused += 1;
      const payload = rateLimitBody(decision.retryAfter);
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(decision.retryAfter),
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
      log({ at: startedAt, method: req.method, path, verdict: "refused", reason: decision.reason, retryAfter: decision.retryAfter, status: 429 });
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
    headers["content-length"] = String(body.length);
    const upstream = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        method: req.method,
        path: `${basePath}${req.url ?? "/"}`,
        headers: { ...headers, host: targetUrl.host },
      },
      (upstreamRes) => {
        const out = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
        res.writeHead(upstreamRes.statusCode ?? 502, out);
        upstreamRes.pipe(res);
        stats.forwarded += 1;
        log({ at: startedAt, method: req.method, path, verdict: "forwarded", reason: decision.reason, status: upstreamRes.statusCode });
      },
    );
    upstream.on("error", (error) => {
      stats.upstreamErrors += 1;
      log({ at: startedAt, method: req.method, path, verdict: "upstream error", reason: error.code ?? "error" });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end('{"error":{"message":"fake upstream could not reach the target"}}');
      else res.destroy();
    });
    res.on("close", () => upstream.destroy());
    upstream.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${shownHost}:${address.port}`,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function usage() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.startsWith("//"))
    .map((line) => line.replace(/^\/\/ ?/, ""))
    .join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.selfCheck) {
    console.log(JSON.stringify({ listen: `${options.host}:${options.port}`, rules: describeRules(options.rules) }));
    return;
  }
  const out = options.log ? fs.createWriteStream(options.log, { flags: "a" }) : process.stdout;
  const log = (line) => out.write(`${JSON.stringify(line)}\n`);
  const running = await startFakeUpstream({
    target: options.target,
    host: options.host,
    port: options.port,
    rules: options.rules,
    rulesFile: options.rulesFile,
    log,
  });
  console.error(`fake rate-limited upstream on ${running.url}, forwarding to ${new URL(options.target).origin}`);
  const stop = async () => {
    log({ event: "stopped", ...running.stats });
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(2);
  });
}
