// `instafy-bind init <dir>`: a starter bound site (bound.json, index.html, handlers/hello.mjs).
// `instafy-bind init <dir> --starter compare|ranked|timeline|checklist|blank`: one of the themed starter pages in
// src/starters, plus the shared theme.css and site.js. They are ordinary files the site owns and edits.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STARTERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "starters");
/** Starter name -> {site file: source file under src/starters}. theme.css and site.js go with every one. */
export const STARTERS = Object.freeze({
  compare: files("compare", ["index.html", "app.js", "data.json", "bound.json"], { "handlers/read_offer.mjs": "handlers/read_offer.mjs" }),
  ranked: files("ranked", ["index.html", "app.js", "data.json", "bound.json"], { "handlers/read_offer.mjs": "handlers/read_offer.mjs" }),
  timeline: files("timeline", ["index.html", "app.js", "data.json"]),
  checklist: files("checklist", ["index.html", "app.js", "data.json", "bound.json"], { "handlers/set_check.mjs": "handlers/set_check.mjs" }),
  blank: files("blank", ["index.html", "app.js"]),
});
export const STARTER_NAMES = Object.keys(STARTERS);

function files(name, own, shared = {}) {
  const map = { "theme.css": "theme.css", "site.js": "site.js" };
  for (const file of own) map[file] = `${name}/${file}`;
  return Object.freeze({ ...map, ...shared });
}

const NAME_PARAMS = {
  type: "object",
  required: ["name", "ref"],
  additionalProperties: false,
  properties: {
    // A pattern keeps free text out of the agent prompt: a name, not a sentence of instructions.
    name: { type: "string", minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9À-ÿ .'-]{1,40}$" },
    ref: { type: "string", maxLength: 60, pattern: "^greetings:[a-z0-9-]{1,40}$" },
  },
};

export const STARTER_BOUND = {
  version: 1,
  title: "Bound site starter",
  intents: {
    hello: {
      label: "Say hello",
      emoji: "👋",
      describe: "A script handler that answers with a greeting claim",
      params: NAME_PARAMS,
      executor: "script",
      handler: "handlers/hello.mjs",
      lanes: ["local"],
      target: { records: "data/records/hello.json" },
      pending: "item",
      cooldown_s: 2,
      timeout_s: 20,
    },
    ask_octo: {
      label: "Ask Octo",
      emoji: "🐙",
      describe: "An agent intent: one Octo turn writes the greeting instead of a script",
      params: NAME_PARAMS,
      executor: "agent",
      agent: {
        prompt: "Write a one-line, friendly greeting for {{name}} (at most 12 words). Return it as one claim with attr \"greeting\", label \"Greeting\", basis \"editorial\", prov.source \"octo\", ttl_s 3600. Do not browse.",
        lane: "assist",
        timeout_s: 180,
      },
      target: { records: "data/records/hello.json" },
      pending: "item",
      cooldown_s: 20,
    },
  },
  results: { files: ["data/records/hello.json"], poll_s: 5, sse: true },
};

export const STARTER_HANDLER = `// Script handler for the "hello" intent. The binder runs it with node, cwd = the site folder.
// stdin: {intent, bound, site}. stdout: NDJSON progress / records / done / error. Never write site files.
// Fetching? Use kit.fetch(url): public http(s) only; it answers like fetch ({ok, status, text(), json()}).
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
const { name, ref } = intent.params;

kit.progress(1, 1, "Writing a greeting");
kit.records([
  {
    type: "claim",
    cid: kit.rid("clm", ref, "greeting", "local"),
    ref,
    attr: "greeting",
    value: "Hello, " + name + "!",
    label: "Greeting",
    status: "ok",
    basis: "editorial",
    confidence: "high",
    prov: { source: "hello-handler", lane: "local", observed_at: new Date().toISOString(), ttl_s: 3600 },
  },
]);
kit.done("Greeted " + name);
`;

export const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bound site starter</title>
<style>
  /* Theme: Instafy preset (light + dark). Change the tokens to re-skin the page. */
  :root { color-scheme: light dark; --bg: #fbfaf7; --fg: #0f172a; --muted: #5f5b54; --card: #fff; --line: #ebe7e2; --edge: #d4d0ca; --accent: #007acc; --accent-fill: #0066ac; --accent-fg: #fff; --skel: #f6f3ef; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #fbfaf7; --muted: #b5b0a9; --card: #1d1d1d; --line: #2e2e2e; --edge: #3d3d3d; --accent: #3794ff; --accent-fill: #1f74d8; --accent-fg: #fff; --skel: #262626; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-weight: 650; letter-spacing: -.02em; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  form { display: flex; flex-wrap: wrap; gap: 8px; }
  input { flex: 1 1 180px; min-height: 44px; padding: 0 14px; border: 1px solid var(--edge); border-radius: 16px; background: var(--card); color: inherit; font: inherit; }
  button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--accent-fill); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--edge); min-height: 36px; padding: 0 12px; }
  #status { color: var(--muted); min-height: 1.5em; }
  #pending { display: flex; align-items: center; gap: 8px; color: var(--muted); }
  #pending[hidden] { display: none; }
  .skel { flex: 1; height: 14px; border-radius: 7px; background: linear-gradient(90deg, var(--skel), var(--line), var(--skel)); background-size: 200% 100%; animation: shimmer 1.2s infinite linear; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skel { animation: none; } }
  ul { list-style: none; padding: 0; }
  li { display: flex; gap: 8px; align-items: flex-start; padding: 12px 14px; margin: 8px 0; border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
  li > div { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  li small { display: block; color: var(--muted); }
  li.expired { opacity: .6; }
</style>
</head>
<body>
<main>
  <h1>Bound site starter</h1>
  <form id="f">
    <input id="name" placeholder="Your name" maxlength="40" required>
    <button>Say hello</button>
    <button type="button" id="octo" hidden>Ask Octo</button>
  </form>
  <p id="status" role="status" aria-live="polite"></p>
  <p id="pending" hidden><span class="skel"></span><button type="button" class="ghost" id="cancel">Cancel</button></p>
  <ul id="records"></ul>
</main>
<script src="__bind/client.js"></script>
<script>
  // Patterns worth keeping: render records with textContent only; show a placeholder while an intent runs
  // (for any viewer: instafyBind.isPending); show each value's source and age; offer ↻ via instafyBind.retry.
  const bind = window.instafyBind;
  const $ = (id) => document.getElementById(id);
  let mine = null;

  const slug = (text) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "someone";

  function render() {
    const records = bind.records().filter((r) => r.type === "claim").sort((a, b) => (b.prov.observed_at || "").localeCompare(a.prov.observed_at || ""));
    $("records").replaceChildren(...records.map((r) => {
      const li = document.createElement("li");
      if (bind.expired(r)) li.classList.add("expired");
      const body = document.createElement("div");
      body.textContent = (r.label || r.attr) + ": " + r.value;
      const meta = document.createElement("small");
      meta.textContent = [r.prov.source, r.prov.lane === "assist" ? "Octo" : r.prov.lane, bind.ageText(r), bind.expired(r) ? "expired" : ""].filter(Boolean).join(" · ");
      body.append(meta);
      const again = document.createElement("button");
      again.type = "button";
      again.className = "ghost";
      again.textContent = "↻";
      again.title = "Check again";
      again.setAttribute("aria-label", "Check again");
      again.disabled = bind.isPending(r.ref);
      again.addEventListener("click", () => bind.retry(r));
      li.append(body, again);
      return li;
    }));
    const running = bind.active();
    $("pending").hidden = running.length === 0;
    $("cancel").hidden = !mine;
  }

  function send(name) {
    const text = $("name").value.trim();
    if (!text) return;
    const ref = "greetings:" + slug(text);
    mine = bind.intent(name, { name: text, ref }, { ref, ui: "form" });
    render();
  }

  const status = $("status");
  bind.ready.then((info) => {
    status.textContent = info.connected ? "Connected to the binder" : "No binder: showing saved results";
    $("octo").hidden = !info.names.includes("ask_octo");
  });
  bind.on("records", render);
  bind.on("ack", (m) => {
    if (m.status === "rejected" && m.id === mine) { mine = null; status.textContent = "Not sent: " + m.reason; }
    render();
  });
  bind.on("progress", (m) => { status.textContent = m.progress.message || "Working"; render(); });
  bind.on("done", (m) => { if (m.id === mine) mine = null; status.textContent = m.summary || "Done"; render(); });
  bind.on("error", (m) => { if (m.id === mine) mine = null; status.textContent = m.error.code === "cancelled" ? "Cancelled" : "Error: " + m.error.message; render(); });
  bind.on("command", (m) => console.log("command from the binder", m.command));
  setInterval(render, 30000);

  $("f").addEventListener("submit", (event) => { event.preventDefault(); send("hello"); });
  $("octo").addEventListener("click", () => send("ask_octo"));
  $("cancel").addEventListener("click", () => { if (mine) bind.cancel(mine); });
</script>
</body>
</html>
`;

/**
 * Write the starter files: the hello starter, or with `starter` one of STARTER_NAMES. Existing files are kept unless
 * `force`. Returns {written, skipped}. An unknown starter throws with the list of names.
 */
export function initSite(dir, { force = false, starter = null } = {}) {
  let files;
  if (starter == null || starter === "") {
    files = {
      "bound.json": `${JSON.stringify(STARTER_BOUND, null, 2)}\n`,
      "index.html": STARTER_HTML,
      "handlers/hello.mjs": STARTER_HANDLER,
    };
  } else {
    const map = Object.hasOwn(STARTERS, starter) ? STARTERS[starter] : null;
    if (!map) throw new Error(`unknown starter "${starter}" (use ${STARTER_NAMES.join(", ")})`);
    files = Object.fromEntries(Object.entries(map).map(([rel, source]) => [rel, fs.readFileSync(path.join(STARTERS_DIR, source))]));
  }
  const written = [];
  const skipped = [];
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (fs.existsSync(file) && !force) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    written.push(rel);
  }
  return { written, skipped };
}
