#!/usr/bin/env node
// instafy-bind: serve a bound site (a website plus the generic binder backend).
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { createBinder, discoverSites, trimEnd } from "../src/server.mjs";
import { initSite, STARTER_NAMES } from "../src/init.mjs";
import { checkBound, resolveIntent, executorOf } from "../src/bound.mjs";
import { formatErrors } from "../src/schema-lite.mjs";
import { resolveControllerConfig, agentExecutorRefusal, agentUnavailableReason, detachedBinderEnv } from "../src/config.mjs";
import { findServerState, readAdminToken, writeServerState, removeServerState } from "../src/tokens.mjs";
import { COMMAND_NAMES, safeText } from "../src/protocol.mjs";
import { envNameRefusal } from "../src/executors/script.mjs";
import { DEFAULT_AGENT_BUDGET_PER_HOUR } from "../src/budget.mjs";
import { handlerHash, readTried, tryIntent } from "../src/try.mjs";
import { checkReport } from "../src/check.mjs";

const HELP = `instafy-bind: a website plus a generic backend that turns clicks into typed intents.

Usage:
  instafy-bind serve <dir|gallery> [--port 4180] [--host 127.0.0.1] [--preview | --no-token]
                     [--agent-executor [--space <id>] [--conversation <id>] [--agent-conversation <id>]
                     [--server-url <url>] [--agent-budget ${DEFAULT_AGENT_BUDGET_PER_HOUR}]] [--dry-run] [--confirm] [--allow-local]
                     [--allow-env NAME] [--public-url <url>] [--trust-proxy]
                     [--no-save] [--json] [--verbose] [--detach [--log <file>]]
  instafy-bind init <dir> [--starter compare|ranked|timeline|checklist|blank] [--force]
  instafy-bind command <dir> <name> [json-args]    names: ${COMMAND_NAMES.join(", ")}
  instafy-bind confirm <dir> <job|all> [--no]
  instafy-bind doctor [dir]
  instafy-bind try <dir> <intent> [json-params] [--save] [--allow-local]
  instafy-bind check <dir> --expect "<item>,<item>,…" [--json]

serve      Serve the site (or every subfolder with a bound.json) with the binder endpoints under
           __bind/. Prints share URLs with the viewer token: #k=... for pages that load __bind/client.js,
           ?k=... (sets a cookie, then redirects) for other pages.
           --preview: for Studio's preview card. No viewer token; besides localhost the binder answers only
           the private preview that \`instafy preview open --port <port>\` opens for this port (space members
           only, checked by Instafy before a request reaches the binder). Any other Host gets 421.
           Agent intents are "Ask Octo" buttons: the page hands the click to Studio, which sends it as the
           clicker's own chat message (billed like typing it). The binder answers them 409 ask_via_host and
           holds no Instafy login.
           --agent-executor: the owner's opt-in to run agent intents as Octo turns on their own login (\`instafy
           login\`), for clicks made on this machine only (loopback, no proxy); every other click is still an
           ask. The turns go to the site's own thread, created in --space (a child of --conversation when
           given). --agent-conversation <id> uses an existing conversation instead. --agent-budget caps Octo
           turns per site per hour (repairs included). --dry-run prints those prompts instead.
           --detach: start the binder in the background (its own session, output to --log, default
           <tmp>/instafy-bind-<port>.log), wait until it answers as itself (another server already on the port
           is refused), print where it serves and exit. A server started in an agent turn without it stops when
           the turn ends.
           In a folder of an Instafy space, the binder saves the data files it writes for clicks (records,
           data/version.json): it commits them to the space's checkout a few seconds after the last write, and
           the space's next save publishes them. --no-save leaves them as changed files.
init       Write a starter bound.json, index.html and handlers/hello.mjs. --starter <name>: a themed page instead,
           with theme.css and site.js (compare 2-8 options; ranked a top-N; timeline days or steps in time;
           checklist ticks; blank anything else). You design the content in data.json and app.js. Existing
           files are kept; --force overwrites them.
check      Does the site show every item the request named (each product, stop or entry)? Reads the text of its
           HTML pages and every value in its data files (data.json, data/**/*.json), and lists the items it does
           not show. On a page of options (the compare and ranked starters' data.json) it also lists values that
           only say nothing ("—", "n/a"), values without the page and day they were read, and a filter that
           would count a row whose value is unknown; and it notes the rows a filter lists apart. Exit 1 when an
           item is missing or a value needs fixing, 2 when there is nothing to check. Items: --expect, plus an
           "expect" array in data.json. Run it before telling anyone the page is done.
command    Push a command (select, highlight, toast, reload) to every open viewer. Uses the
           admin token in .bind/admin-token.
confirm    Approve (or --no: decline) jobs waiting for confirmation.
doctor     Check Node, bound.json, handlers and the Instafy controller settings (never prints tokens).
try        Run one script intent as a viewer's click would (same input, environment and record checks), print
           its records, and exit 1 when it crashes, reports an error, sends nothing or every record is rejected.
           Nothing is written to the site. Run it for every script intent before telling anyone the site works.
           --save: also store the accepted records in the site, exactly as a click's would be (same checks,
           provenance and merge), so the page opens with the values, each with its source and age. Use it to fill
           a new page (one try per item); a served page shows them after \`command <dir> reload '{}'\`.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const repeatable = new Set(["public-url", "allow-env"]);
  const booleans = new Set(["no-token", "preview", "dry-run", "confirm", "allow-local", "json", "verbose", "force", "no", "help", "trust-proxy", "detach", "save", "no-save", "agent-executor"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h") flags.help = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (booleans.has(key)) flags[key] = inline === undefined ? true : inline !== "false";
      else {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        if (repeatable.has(key)) (flags[key] ||= []).push(value);
        else flags[key] = value;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

function fail(message, code = 1) {
  process.stderr.write(`instafy-bind: ${message}\n`);
  process.exit(code);
}

/** argv for the background binder: the same command without --detach/--log. */
function detachedServeArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--detach" || arg.startsWith("--detach=")) continue;
    if (arg === "--log") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--log=")) continue;
    out.push(arg);
  }
  return out;
}

/** The folder's real path, or the path itself when it cannot be resolved. */
function realOr(dir) {
  try {
    return fs.realpathSync(path.resolve(String(dir)));
  } catch {
    return path.resolve(String(dir));
  }
}

async function serveDetached(dir, flags) {
  const port = flags.port === undefined ? 4180 : Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--detach needs a fixed --port");
  const logFile = path.resolve(flags.log || path.join(os.tmpdir(), `instafy-bind-${port}.log`));
  const fd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [process.argv[1], ...detachedServeArgs(process.argv.slice(2))], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: detachedBinderEnv(process.env, [].concat(flags["allow-env"] || []), { keepLogin: Boolean(flags["agent-executor"]) }),
  });
  fs.closeSync(fd);
  child.unref();
  const host = flags.host || "127.0.0.1";
  const folder = realOr(dir);
  // A gallery answers under each site's folder: ask the first one.
  let prefix = "";
  try {
    prefix = discoverSites(dir, { plain: true })[0]?.prefix ?? "";
  } catch {
    // the binder says why in its log
  }
  const running = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 20_000;
  let up = false;
  // Whether something else answered on the port: another site's server, or another binder.
  let other = false;
  while (Date.now() < deadline && running()) {
    try {
      const response = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}${prefix}/__bind/health`, { signal: AbortSignal.timeout(2_000) });
      // Only this binder's own answer counts: the folder it serves and the process it runs in, from the child started
      // here while it still runs. Any other answer on the port is another server, never this site being served.
      const binder = (await response.json().catch(() => null))?.binder;
      if (response.ok && binder?.pid === child.pid && realOr(binder.root) === folder && running()) {
        up = true;
        break;
      }
      other = true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const tail = () => {
    try {
      return fs.readFileSync(logFile, "utf8").split("\n").slice(-12).join("\n");
    } catch {
      return "";
    }
  };
  if (!up) {
    // A binder that never answered as itself is not left running in the background.
    if (running()) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    if (other) fail(`port ${port} is in use by another server, so ${dir} is not served there; pick another --port (log ${logFile}):\n${tail()}`);
    fail(`the background binder did not start (log ${logFile}):\n${tail()}`);
  }
  process.stdout.write(`instafy-bind serving ${dir} on port ${port} in the background (pid ${child.pid}; log ${logFile}); it keeps running after this turn.\n`);
  const shown = tail().split("\n").filter((line) => /show it in Studio|public link|agent executor|intents:/.test(line));
  for (const line of shown) process.stdout.write(`${line}\n`);
}

async function serve(dir, flags) {
  if (!dir) fail("serve needs a folder");
  if (flags["agent-executor"] && agentExecutorRefusal(process.env)) fail(agentExecutorRefusal(process.env));
  if (flags.detach) return serveDetached(dir, flags);
  const json = Boolean(flags.json);
  const verbose = Boolean(flags.verbose);
  const out = (event) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  const log = (level, raw) => {
    if (level === "debug" && !verbose) return;
    const text = safeText(raw);
    if (json) out({ event: "log", level, text });
    else process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${level.padEnd(5)} ${text}\n`);
  };
  const onDryRun = (prompt, job) => {
    if (json) out({ event: "dry_run", job: job.id, intent: job.name, prompt });
    else process.stdout.write(`\n----- dry run: prompt for ${job.name} (${job.id}) -----\n${prompt}\n----- end of prompt -----\n\n`);
  };
  const port = flags.port === undefined ? 4180 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be a number");
  const agentBudget = flags["agent-budget"] === undefined ? DEFAULT_AGENT_BUDGET_PER_HOUR : Number(flags["agent-budget"]);
  if (!Number.isInteger(agentBudget) || agentBudget < 0 || agentBudget > 1000) fail("--agent-budget must be a whole number of turns per hour (0-1000)");

  let binder;
  try {
    binder = createBinder({
      root: dir,
      port,
      host: flags.host || "127.0.0.1",
      noToken: Boolean(flags["no-token"]),
      preview: Boolean(flags.preview),
      agentExecutor: Boolean(flags["agent-executor"]),
      conversation: flags.conversation,
      agentConversation: flags["agent-conversation"],
      space: flags.space,
      serverUrl: flags["server-url"],
      agentBudget,
      allowEnv: flags["allow-env"] || [],
      trustProxy: Boolean(flags["trust-proxy"]),
      dryRun: Boolean(flags["dry-run"]),
      confirm: Boolean(flags.confirm),
      allowLocal: Boolean(flags["allow-local"]),
      publicOrigins: flags["public-url"] || [],
      save: !flags["no-save"],
      log,
      onDryRun,
    });
    await binder.listen();
  } catch (error) {
    fail(error.message);
  }

  writeServerState(binder.root, {
    pid: process.pid,
    url: binder.url,
    started_at: new Date().toISOString(),
    sites: binder.sites.map((s) => ({ name: s.name, prefix: s.prefix, dir: s.dir })),
  });

  // Jobs that need confirmation are announced here; answer with "y <job>" or "n <job>". The job id is required:
  // a bare "y" never approves a batch, and the params are printed again (JSON-encoded) when you decide.
  const announced = new Set();
  for (const site of binder.sites) {
    const broadcast = site.hub.broadcast.bind(site.hub);
    site.hub.broadcast = (msg) => {
      if (msg.type === "ack" && msg.status === "needs_confirm" && !msg.coalesced && !announced.has(msg.job)) {
        announced.add(msg.job);
        const job = site.jobs.jobs.find((j) => j.id === msg.job);
        const line = `confirm? ${msg.job} ${job?.name} ${JSON.stringify(job?.intent.params)}  (type "y ${msg.job}" or "n ${msg.job}")`;
        if (json) out({ event: "needs_confirm", site: site.name, job: msg.job, intent: job?.name, params: job?.intent.params });
        else process.stderr.write(`${safeText(line)}\n`);
      }
      return broadcast(msg);
    };
  }
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const [answer, jobId] = line.trim().split(/\s+/);
      if (!/^[yn]$/i.test(answer || "")) return;
      if (!jobId) {
        const waiting = binder.sites.flatMap((site) => site.jobs.pendingConfirmations().map((j) => j.id));
        log("info", waiting.length ? `name the job: "${answer} <job>" (waiting: ${waiting.join(", ")})` : "no job is waiting for confirmation");
        return;
      }
      for (const site of binder.sites) {
        const job = site.jobs.pendingConfirmations().find((j) => j.id === jobId);
        if (!job) continue;
        const yes = answer.toLowerCase() === "y";
        site.jobs.confirm(jobId, yes);
        log("info", `${jobId} ${yes ? "confirmed" : "declined"}: ${job.name} ${JSON.stringify(job.intent.params)}`);
      }
    });
  }

  const listenPort = new URL(binder.url).port;
  const sites = binder.sites.map((site) => ({
    name: site.name,
    url: binder.shareUrl(site),
    intents: [...site.runnable],
    unavailable: site.unavailable,
    ...(binder.preview ? { preview_command: previewCommand(listenPort, site) } : {}),
    ...(flags["public-url"]?.length ? { public_urls: flags["public-url"].map((origin) => binder.shareUrl(site, trimEnd(origin, "/"))) } : {}),
  }));
  if (json) {
    out({ event: "listening", url: binder.url, preview: binder.preview, agent: binder.agentState, agent_reason: binder.agentReason, sites });
  } else {
    process.stdout.write(`instafy-bind serving ${binder.root}${binder.preview ? " (preview mode: no viewer token)" : ""}\n`);
    for (const site of sites) {
      process.stdout.write(`  ${site.name}: ${site.url}\n    intents: ${site.intents.join(", ") || "(none)"}\n`);
      if (site.preview_command) process.stdout.write(`    show it in Studio: ${site.preview_command}\n`);
      for (const link of site.public_urls || []) process.stdout.write(`    public link (share this whole link; it carries the viewer token): ${link}\n`);
    }
    if (binder.agentState === "host") {
      process.stdout.write("  agent executor: host (Ask Octo clicks go through Studio as the clicker's own message; this binder holds no Instafy login)\n");
    } else {
      process.stdout.write(`  agent executor: ${binder.agentState}${binder.agentReason ? ` (${binder.agentReason})` : ""}${binder.agentState === "ready" || binder.agentState === "dry_run" ? " for clicks on this machine; other clicks ask through Studio" : ""}\n`);
    }
    if (binder.agentState === "ready") {
      const target = binder.controller.agentConversationId ? `conversation ${binder.controller.agentConversationId}` : `the site's own thread in space ${binder.controller.spaceId}`;
      process.stdout.write(`  agent turns: ${target}, at most ${agentBudget} per site per hour\n`);
    }
    process.stdout.write(`  commands: instafy-bind command ${dir} toast '{"text":"Hi"}'  (admin token in ${path.join(binder.root, ".bind", "admin-token")})\n`);
  }

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    removeServerState(binder.root);
    await binder.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** The `instafy preview open` command that shows one site of this binder in Studio's preview card. */
function previewCommand(port, site) {
  // Printed for a shell: keep the title inside double quotes without anything the shell would expand.
  const title = String(site.title || site.name).replace(/["$`\\\s]+/g, " ").trim().slice(0, 120) || site.name;
  return `instafy preview open --port ${port}${site.prefix ? ` --path ${site.prefix}/` : ""} --title "${title}"`;
}

function locate(dir) {
  const found = findServerState(dir);
  if (!found) fail(`no running binder for ${dir} (start one with: instafy-bind serve <dir>)`);
  const abs = fs.realpathSync(path.resolve(dir));
  const sites = found.state.sites || [];
  const site = sites.find((s) => fs.existsSync(s.dir) && fs.realpathSync(s.dir) === abs) || (sites.length === 1 ? sites[0] : null);
  if (!site) fail(`${dir} is a gallery; name one site folder (${sites.map((s) => s.name).join(", ")})`);
  return { url: found.state.url, root: found.root, site };
}

async function postAdmin(dir, endpoint, body) {
  const { url, root, site } = locate(dir);
  const token = readAdminToken(root);
  let response;
  try {
    response = await fetch(`${url}${site.prefix}/__bind/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    fail(`binder at ${url} is not reachable (${error.message})`);
  }
  const text = await response.text();
  process.stdout.write(`${text}\n`);
  if (!response.ok) process.exit(1);
}

async function command(dir, name, rawArgs) {
  if (!dir || !name) fail(`usage: instafy-bind command <dir> <name> [json-args]   names: ${COMMAND_NAMES.join(", ")}`);
  if (!COMMAND_NAMES.includes(name)) fail(`unknown command "${name}" (use ${COMMAND_NAMES.join(", ")})`);
  let args = {};
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      fail("json-args must be a JSON object, e.g. '{\"ref\":\"products:a\"}'");
    }
  }
  await postAdmin(dir, "command", { name, args });
}

async function doctor(dir, flags = {}) {
  const lines = [];
  let bad = false;
  const ok = (text) => lines.push(`ok    ${text}`);
  const warn = (text) => lines.push(`warn  ${text}`);
  const error = (text) => {
    bad = true;
    lines.push(`error ${text}`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) ok(`node ${process.versions.node}`);
  else error(`node ${process.versions.node} (need >= 18)`);

  // Only --agent-executor reads the owner's login; without it Ask Octo goes through Studio and needs none.
  const ownerExecutor = Boolean(flags["agent-executor"]);
  let agentReady = !ownerExecutor;
  if (ownerExecutor) {
    try {
      agentReady = !agentUnavailableReason(resolveControllerConfig({ cwd: dir ? path.resolve(dir) : process.cwd() }));
    } catch {
      agentReady = false;
    }
  }
  if (dir) {
    const sites = fs.existsSync(dir) ? discoverSites(dir) : [];
    if (!sites.length) error(`${dir}: no bound.json here or in a subfolder`);
    if (sites.length && sites[0].prefix !== "") {
      for (const marker of [".git", ".env", "package.json"]) {
        if (fs.existsSync(path.join(dir, marker))) warn(`${dir} has ${marker}: serve only a folder of sites, not a workspace (only site folders are served, but keep secrets out of them)`);
      }
    }
    for (const site of sites) {
      let bound;
      try {
        bound = JSON.parse(fs.readFileSync(path.join(site.dir, "bound.json"), "utf8"));
      } catch (e) {
        error(`${site.name}: bound.json: ${e.message}`);
        continue;
      }
      const problems = checkBound(bound);
      if (problems.length) {
        error(`${site.name}: bound.json: ${formatErrors(problems, 5)}`);
        continue;
      }
      ok(`${site.name}: bound.json (${Object.keys(bound.intents).length} intents)`);
      for (const [name, def] of Object.entries(bound.intents)) {
        const r = resolveIntent(def, { siteDir: site.dir });
        if (r.ok && executorOf(def) === "script" && r.handler) {
          const last = readTried(site.dir)[name];
          if (!last || last.hash !== handlerHash(r.handler)) warn(`${site.name}: ${name} has not been tried since its handler changed: run \`instafy bind try ${dir} ${name} '<params>'\` for one real item`);
          else if (!last.ok) warn(`${site.name}: ${name} failed its last try: fix the handler, then \`instafy bind try\` again`);
        }
        if (r.ok) ok(`${site.name}: ${name} -> ${executorOf(def)}${r.handler ? ` ${r.handler.startsWith(site.dir + path.sep) ? path.relative(site.dir, r.handler) : r.handler}` : ""}${def.env?.length ? ` (env: ${def.env.join(", ")})` : ""}`);
        else error(`${site.name}: ${name}: ${r.reason}`);
      }
      for (const line of lintSite(site, bound, { agentReady })) warn(line);
    }
  }

  if (!ownerExecutor) {
    ok("Ask Octo: clicks go through Studio as the clicker's own message (no Instafy login needed; --agent-executor checks the owner's)");
  } else try {
    const config = resolveControllerConfig({ cwd: dir ? path.resolve(dir) : process.cwd() });
    ok(`controller ${config.controllerUrl}`);
    if (config.hasToken) ok(`access token from ${config.tokenSource}`);
    else warn("no Instafy access token: agent intents only work with --dry-run (run `instafy login`)");
    if (config.note) warn(config.note);
    if (config.agentConversationId) {
      ok(`agent conversation ${config.agentConversationId}`);
      if (config.agentConversationId === config.conversationId) warn("agent turns would go into your own conversation; prefer a space so the binder creates the site's own thread");
    } else if (config.spaceId) ok(`space ${config.spaceId} (the binder creates the site's own thread on the first agent intent)`);
    else warn("no space: pass --space so agent intents get their own thread");
    const reason = agentUnavailableReason(config);
    if (!reason) ok("agent executor ready");
  } catch (e) {
    error(`controller settings: ${e.message}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  if (bad) process.exit(1);
}

/** Lint checks for mistakes a model writing a bound site tends to make. Returns warning lines. */
function lintSite(site, bound, { agentReady }) {
  const warnings = [];
  const w = (text) => warnings.push(`${site.name}: ${text}`);
  let html = "";
  try {
    html = fs.readFileSync(path.join(site.dir, "index.html"), "utf8");
  } catch {
    w("index.html is missing");
  }
  if (html && !/__bind\/client\.js/.test(html)) w('index.html does not load "__bind/client.js"; viewers get no live updates');
  const files = bound.results?.files;
  // A site with only agent intents does nothing where the binder has no owner login: in an Octo turn, or for a
  // Studio viewer. Its buttons then just say the service is not connected.
  if (!Object.values(bound.intents).some((def) => executorOf(def) === "script")) {
    w('no script intent: agent intents are "Ask Octo" buttons that only work where Instafy can send them as the clicker\'s message, so anywhere else every button stays dead; add a script intent (when it cannot read a page it returns status "uncertain" records with a note) and keep agent intents as an extra "Ask Octo"');
  }
  for (const [name, def] of Object.entries(bound.intents)) {
    const target = def.target?.records || `data/records/${name}.json`;
    if (Array.isArray(files) && !files.includes(target)) w(`${name}: ${target} is not in results.files, so static viewers never load it`);
    for (const env of def.env || []) {
      const refusal = envNameRefusal(env);
      if (refusal) w(`${name}: env ${env} ${refusal}`);
    }
    if (executorOf(def) !== "agent") continue;
    const props = def.params?.properties || {};
    const prompt = def.agent?.prompt || "";
    for (const [, key] of prompt.matchAll(/["'\u201c\u2018]\{\{\s*([A-Za-z0-9_]+)\s*\}\}["'\u201d\u2019]/g)) {
      w(`${name}: agent.prompt quotes {{${key}}}; placeholders are already JSON-quoted (it renders as ""value"")`);
    }
    if (!props.ref) w(`${name}: agent intents need a "ref" param; records Octo returns are kept only for the clicked ref`);
    const uriParams = Object.entries(props).filter(([, schema]) => schema?.format === "uri").map(([key]) => key);
    const origins = def.agent?.allowed_origins || [];
    if (uriParams.length && (!origins.length || origins.includes("https://*"))) {
      w(`${name}: ${uriParams.join(", ")} can point Octo's browser at any site; list the stores in agent.allowed_origins`);
    }
    for (const [key, schema] of Object.entries(props)) {
      const free = schema?.type === "string" && !schema.pattern && !schema.enum && !schema.format && !schema.const;
      if (free && key !== "ref" && new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`).test(prompt)) {
        w(`${name}: {{${key}}} is free text in the task; give it a pattern or enum so a viewer cannot write instructions there`);
      }
    }
    for (const source of def.sources || []) {
      if (/^www\./i.test(source)) w(`${name}: sources entry ${source}: the binder drops "www." from agent sources; write ${source.slice(4)}`);
    }
    if (!agentReady) w(`${name}: --agent-executor has no owner login here, so this intent runs only as an ask through Studio (or with --dry-run)`);
  }
  return warnings;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const { positional, flags } = parsed;
  const [cmd, ...rest] = positional;
  if (!cmd || flags.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  switch (cmd) {
    case "serve":
      return serve(rest[0], flags);
    case "init": {
      if (!rest[0]) fail("init needs a folder");
      if (flags.starter === true || flags.starter === "") fail(`--starter needs a name (${STARTER_NAMES.join(", ")})`);
      let result;
      try {
        result = initSite(rest[0], { force: Boolean(flags.force), starter: flags.starter ?? null });
      } catch (error) {
        fail(error.message);
      }
      for (const file of result.written) process.stdout.write(`wrote ${path.join(rest[0], file)}\n`);
      for (const file of result.skipped) process.stdout.write(`kept  ${path.join(rest[0], file)} (exists; --force overwrites)\n`);
      if (flags.starter) process.stdout.write(`next: put the real content in ${path.join(rest[0], flags.starter === "blank" ? "app.js" : "data.json")}, then instafy-bind serve ${rest[0]}\n`);
      else process.stdout.write(`next: instafy-bind serve ${rest[0]}   (add --dry-run to see agent prompts without an Instafy login)\n`);
      return;
    }
    case "command":
      return command(rest[0], rest[1], rest[2]);
    case "confirm":
      if (!rest[0] || !rest[1]) fail("usage: instafy-bind confirm <dir> <job|all> [--no]");
      return postAdmin(rest[0], "confirm", { job: rest[1], ok: !flags.no });
    case "doctor":
      return doctor(rest[0], flags);
    case "check": {
      if (!rest[0]) fail('usage: instafy-bind check <dir> --expect "<item>,<item>" [--json]', 64);
      let report;
      try {
        report = checkReport(rest[0], flags.expect ?? [], { json: Boolean(flags.json) });
      } catch (error) {
        fail(error.message, 64);
      }
      process.stdout.write(`${report.lines.join("\n")}\n`);
      process.exitCode = report.exit;
      return;
    }
    case "try": {
      if (!rest[0] || !rest[1]) fail("usage: instafy-bind try <dir> <intent> [json-params]", 64);
      const result = await tryIntent(rest[0], rest[1], rest[2] ?? "{}", {
        allowLocal: Boolean(flags["allow-local"]),
        allowEnv: flags["allow-env"] || [],
        save: Boolean(flags.save),
      });
      process.stdout.write(`${result.lines.join("\n")}\n`);
      process.exitCode = result.exit;
      return;
    }
    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((error) => fail(error.stack || error.message));
