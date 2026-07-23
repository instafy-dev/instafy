import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

const requestedPort = Number.parseInt((process.env.PORT ?? "").trim() || process.argv[2] || "48199", 10);
const host = (process.env.HOST ?? "0.0.0.0").trim() || "0.0.0.0";
const statePath = (process.env.STATE_PATH ?? "").trim();

const SEARCH_COOKIE = "instafy_fixture_search_used_v1";
const UNLOCK_COOKIE = "instafy_fixture_unlock_v1";
const GATE_CODE = "opensesame";

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function cookieOverlayHtml() {
  // Full-screen overlay that blocks clicks until consent is accepted.
  return `
<div id="cookie-overlay" role="dialog" aria-label="Cookie consent">
  <div class="cookie-card">
    <h2>Cookies</h2>
    <p>This fixture site requires accepting cookies before you can click links.</p>
    <div class="cookie-actions">
      <button id="cookie-agree" type="button">I agree</button>
      <button id="cookie-decline" type="button">No thanks</button>
    </div>
    <p class="cookie-hint">Hint: click <strong>I agree</strong> to proceed.</p>
  </div>
</div>
`;
}

function sharedStyles() {
  return `
  :root { color-scheme: light; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.4; }
  header { padding: 16px 20px; border-bottom: 1px solid #e6e6e6; }
  header h1 { margin: 0; font-size: 18px; }
  main { padding: 16px 20px 40px; max-width: 860px; }
  a { color: #1b64d1; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: #666; }
  .cards { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 12px; }
  .card { border: 1px solid #e6e6e6; border-radius: 10px; padding: 12px 14px; background: #fff; }
  .card-title { font-weight: 700; margin: 0 0 6px; }
  .card-desc { margin: 0; color: #444; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid #e6e6e6; font-size: 12px; color: #555; }

  #cookie-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.55);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 99999;
  }
  #cookie-overlay[aria-hidden="false"] { display: flex; }
  .cookie-card {
    width: min(520px, calc(100vw - 32px));
    background: #fff;
    border-radius: 14px;
    padding: 16px 18px;
    box-shadow: 0 18px 40px rgba(0,0,0,.25);
  }
  .cookie-card h2 { margin: 0 0 8px; font-size: 18px; }
  .cookie-card p { margin: 8px 0; color: #333; }
  .cookie-actions { display: flex; gap: 10px; margin-top: 10px; }
  .cookie-actions button {
    border: 1px solid #1b64d1;
    border-radius: 10px;
    padding: 10px 12px;
    background: #1b64d1;
    color: white;
    font-weight: 700;
    cursor: pointer;
  }
  .cookie-actions button#cookie-decline {
    background: #fff;
    color: #1b64d1;
  }
  .cookie-hint { font-size: 12px; color: #666; }
`;
}

function sharedScript() {
  return `
  const KEY = "instafy_fixture_cookie_consent_v1";
  const overlay = document.getElementById("cookie-overlay");
  const agree = document.getElementById("cookie-agree");
  const decline = document.getElementById("cookie-decline");
  const setVisible = (visible) => {
    if (!overlay) return;
    overlay.setAttribute("aria-hidden", visible ? "false" : "true");
  };
  const hasConsent = () => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  };
  const accept = () => {
    try { localStorage.setItem(KEY, "1"); } catch {}
    setVisible(false);
  };
  const init = () => {
    setVisible(!hasConsent());
    agree?.addEventListener("click", accept);
    decline?.addEventListener("click", () => setVisible(false));
  };
  init();
`;
}

function renderPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(title)}</title>
    <style>${sharedStyles()}</style>
  </head>
  <body>
    ${body}
    ${cookieOverlayHtml()}
    <script>${sharedScript()}</script>
  </body>
</html>`;
}

function renderHome() {
  const body = `
    <header>
      <h1>Fixture News <span class="chip">local bench</span></h1>
    </header>
    <main>
      <p class="muted">A deterministic site for Instafy /learn browser benchmarks.</p>
      <div class="cards">
        <a class="card" href="/article/alpha" data-testid="fixture-article-alpha">
          <p class="card-title">Alpha</p>
          <p class="card-desc">First visible story (benchmark target).</p>
        </a>
        <a class="card" href="/article/beta" data-testid="fixture-article-beta">
          <p class="card-title">Beta</p>
          <p class="card-desc">Second story.</p>
        </a>
      </div>
      <p style="margin-top:16px;"><a href="/search">Search</a></p>
      <p><a href="/lookup">Lookup archive</a> <span class="muted">(search variant)</span></p>
      <p><a href="/catalog">Catalog</a> <span class="muted">(pagination task)</span></p>
      <p><a href="/directory">Directory</a> <span class="muted">(filter table task)</span></p>
      <p><a href="/gate">Secret story</a> <span class="muted">(requires unlock)</span></p>
    </main>
  `;
  return renderPage({ title: "Fixture News", body });
}

function renderSearch(url) {
  const q = (url.searchParams.get("q") ?? "").trim();
  const normalized = q.toLowerCase();
  const results = [];
  if (!q) {
    results.push({ slug: "alpha", label: "Alpha" });
    results.push({ slug: "beta", label: "Beta" });
  } else if (normalized.includes("beta") || normalized === "b") {
    results.push({ slug: "beta", label: "Beta" });
  } else if (normalized.includes("alpha") || normalized.includes("a")) {
    results.push({ slug: "alpha", label: "Alpha" });
  } else {
    results.push({ slug: "beta", label: "Beta" });
  }

  const items = results
    .map(
      (r) => `
      <a class="card" href="/article/${htmlEscape(r.slug)}" data-testid="fixture-search-result-${htmlEscape(r.slug)}">
        <p class="card-title">${htmlEscape(r.label)}</p>
        <p class="card-desc">Search result</p>
      </a>
    `,
    )
    .join("");

  const body = `
    <header>
      <h1>Fixture News Search <span class="chip">local bench</span></h1>
    </header>
    <main>
      <form action="/search" method="get">
        <label for="q">Search</label>
        <input id="q" name="q" value="${htmlEscape(q)}" style="margin-left:8px;padding:8px 10px;border:1px solid #e6e6e6;border-radius:10px;width:min(520px,100%);" />
        <button type="submit" style="margin-left:8px;padding:8px 10px;border:1px solid #1b64d1;border-radius:10px;background:#1b64d1;color:#fff;font-weight:700;">Go</button>
      </form>
      <div class="cards" style="margin-top:16px;">${items}</div>
      <p style="margin-top:16px;"><a href="/">Back home</a></p>
    </main>
  `;
  return renderPage({ title: q ? `Search: ${q}` : "Search", body });
}

function renderLookup(url) {
  const term = (url.searchParams.get("term") ?? "").trim();
  const normalized = term.toLowerCase();
  const results = [];
  if (!term) {
    results.push({ slug: "beta", label: "Beta dossier" });
    results.push({ slug: "alpha", label: "Alpha memo" });
  } else if (normalized.includes("beta") || normalized.includes("dossier")) {
    results.push({ slug: "beta", label: "Beta dossier" });
  } else if (normalized.includes("alpha") || normalized.includes("memo")) {
    results.push({ slug: "alpha", label: "Alpha memo" });
  } else {
    results.push({ slug: "beta", label: "Beta dossier" });
  }

  const items = results
    .map(
      (r) => `
      <a class="card" href="/article/${htmlEscape(r.slug)}" data-testid="fixture-lookup-result-${htmlEscape(r.slug)}">
        <p class="card-title">${htmlEscape(r.label)}</p>
        <p class="card-desc">Archive result</p>
      </a>
    `,
    )
    .join("");

  const body = `
    <header>
      <h1>Fixture Lookup Archive <span class="chip">transfer</span></h1>
    </header>
    <main>
      <form action="/lookup" method="get">
        <label for="term">Lookup</label>
        <input id="term" name="term" value="${htmlEscape(term)}" style="margin-left:8px;padding:8px 10px;border:1px solid #e6e6e6;border-radius:10px;width:min(520px,100%);" />
        <button type="submit" style="margin-left:8px;padding:8px 10px;border:1px solid #1b64d1;border-radius:10px;background:#1b64d1;color:#fff;font-weight:700;">Find</button>
      </form>
      <div class="cards" style="margin-top:16px;">${items}</div>
      <p style="margin-top:16px;"><a href="/">Back home</a></p>
    </main>
  `;
  return renderPage({ title: term ? `Lookup: ${term}` : "Lookup archive", body });
}

function renderCatalog(url) {
  const pageValue = Math.max(1, Number.parseInt((url.searchParams.get("page") ?? "1").trim() || "1", 10) || 1);
  const pageNumber = Math.min(pageValue, 2);
  const items =
    pageNumber === 1
      ? [
          { slug: "alpha", label: "Alpha listing", desc: "Catalog page 1 item." },
          { slug: "beta", label: "Beta listing", desc: "Catalog page 1 item." },
        ]
      : [
          { slug: "delta", label: "Delta listing", desc: "Target only visible on page 2." },
          { slug: "gamma", label: "Gamma listing", desc: "Secondary item on page 2." },
        ];

  const itemCards = items
    .map(
      (r) => `
      <a class="card" href="/article/${htmlEscape(r.slug)}" data-testid="fixture-catalog-result-${htmlEscape(r.slug)}">
        <p class="card-title">${htmlEscape(r.label)}</p>
        <p class="card-desc">${htmlEscape(r.desc)}</p>
      </a>
    `,
    )
    .join("");

  const nav = `
    <div style="display:flex;gap:10px;margin-top:16px;">
      ${pageNumber > 1 ? `<a href="/catalog?page=${pageNumber - 1}" data-testid="fixture-catalog-prev">Previous page</a>` : ""}
      ${pageNumber < 2 ? `<a href="/catalog?page=${pageNumber + 1}" data-testid="fixture-catalog-next">Next page</a>` : ""}
    </div>
  `;

  const body = `
    <header>
      <h1>Fixture Catalog <span class="chip">page ${pageNumber}</span></h1>
    </header>
    <main>
      <p class="muted">Browse multiple pages to find the requested listing.</p>
      <div class="cards">${itemCards}</div>
      ${nav}
      <p style="margin-top:16px;"><a href="/">Back home</a></p>
    </main>
  `;
  return renderPage({ title: `Catalog page ${pageNumber}`, body });
}

function renderDirectory(url) {
  const team = (url.searchParams.get("team") ?? "").trim().toLowerCase();
  const rows = [
    { team: "blue", label: "Alpha account", slug: "alpha" },
    { team: "green", label: "Epsilon account", slug: "epsilon" },
    { team: "red", label: "Gamma account", slug: "gamma" },
  ];
  const filtered = team ? rows.filter((row) => row.team === team) : rows.filter((row) => row.team !== "green");

  const tableRows =
    filtered.length > 0
      ? filtered
          .map(
            (row) => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #ececec;">${htmlEscape(row.team)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #ececec;">
            <a href="/article/${htmlEscape(row.slug)}" data-testid="fixture-directory-result-${htmlEscape(row.slug)}">${htmlEscape(row.label)}</a>
          </td>
        </tr>
      `,
          )
          .join("")
      : `
        <tr>
          <td colspan="2" style="padding:8px 10px;border-bottom:1px solid #ececec;">No rows for this filter.</td>
        </tr>
      `;

  const body = `
    <header>
      <h1>Fixture Directory <span class="chip">filter</span></h1>
    </header>
    <main>
      <form action="/directory" method="get" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <label for="team">Team</label>
        <select id="team" name="team" style="padding:8px 10px;border:1px solid #e6e6e6;border-radius:10px;">
          <option value="" ${team ? "" : "selected"}>Choose team</option>
          <option value="blue" ${team === "blue" ? "selected" : ""}>Blue</option>
          <option value="green" ${team === "green" ? "selected" : ""}>Green</option>
          <option value="red" ${team === "red" ? "selected" : ""}>Red</option>
        </select>
        <button type="submit" data-testid="fixture-directory-apply" style="padding:8px 10px;border:1px solid #1b64d1;border-radius:10px;background:#1b64d1;color:#fff;font-weight:700;">Apply filter</button>
      </form>
      <table style="margin-top:16px;border-collapse:collapse;width:min(620px,100%);">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid #e6e6e6;">Team</th>
            <th style="text-align:left;padding:8px 10px;border-bottom:1px solid #e6e6e6;">Entry</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <p style="margin-top:16px;"><a href="/">Back home</a></p>
    </main>
  `;
  return renderPage({ title: team ? `Directory: ${team}` : "Directory", body });
}

function renderArticle(slug) {
  const tokenMap = {
    alpha: "ALPHA-TOKEN-7f9c3d",
    beta: "BETA-TOKEN-2a4e19",
    gamma: "GAMMA-TOKEN-91c0fa",
    delta: "DELTA-TOKEN-5c203a",
    epsilon: "EPSILON-TOKEN-6f10bd",
  };
  const headlineMap = {
    alpha: "Fixture News: Alpha",
    beta: "Fixture News: Beta",
    gamma: "Fixture News: Gamma",
    delta: "Fixture News: Delta",
    epsilon: "Fixture News: Epsilon",
  };
  const headline = headlineMap[slug] ?? "Fixture News";
  const token = tokenMap[slug] ?? "FIXTURE-TOKEN";
  const body = `
    <header>
      <h1>${htmlEscape(headline)}</h1>
    </header>
    <main>
      <p class="muted">Article slug: <code>${htmlEscape(slug)}</code></p>
      <p class="muted">Article token: <code data-testid="fixture-article-token">${htmlEscape(token)}</code></p>
      <p>This page is intentionally simple so /learn improvements are measurable.</p>
      <p><a href="/">Back home</a> · <a href="/search">Search</a></p>
    </main>
  `;
  return renderPage({ title: headline, body });
}

function renderGate({ error }) {
  const body = `
    <header>
      <h1>Fixture Gate <span class="chip">local bench</span></h1>
    </header>
    <main>
      <p class="muted">Unlock the secret story by entering the access code.</p>
      <p class="muted">Access code: <code data-testid="fixture-gate-code">${htmlEscape(GATE_CODE)}</code></p>
      ${error ? `<p style="color:#b00020;font-weight:700;">${htmlEscape(error)}</p>` : ""}
      <form action="/gate" method="get" style="margin-top:14px;">
        <label for="code">Code</label>
        <input id="code" name="code" value="" autocomplete="off" style="margin-left:8px;padding:8px 10px;border:1px solid #e6e6e6;border-radius:10px;width:min(260px,100%);" />
        <button type="submit" data-testid="fixture-gate-submit" style="margin-left:8px;padding:8px 10px;border:1px solid #1b64d1;border-radius:10px;background:#1b64d1;color:#fff;font-weight:700;">Unlock</button>
      </form>
      <p style="margin-top:16px;"><a href="/">Back home</a></p>
    </main>
  `;
  return renderPage({ title: "Fixture Gate", body });
}

function parseCookieHeader(raw) {
  const out = {};
  if (!raw || typeof raw !== "string") return out;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${requestedPort || 48199}`);
  const cookies = parseCookieHeader(req.headers.cookie);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHome());
    return;
  }
  if (url.pathname === "/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (q) {
      headers["set-cookie"] = `${SEARCH_COOKIE}=1; Path=/; Max-Age=86400; SameSite=Lax`;
    }
    res.writeHead(200, headers);
    res.end(renderSearch(url));
    return;
  }
  if (url.pathname === "/lookup") {
    const term = (url.searchParams.get("term") ?? "").trim();
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (term) {
      headers["set-cookie"] = `${SEARCH_COOKIE}=1; Path=/; Max-Age=86400; SameSite=Lax`;
    }
    res.writeHead(200, headers);
    res.end(renderLookup(url));
    return;
  }
  if (url.pathname === "/catalog") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderCatalog(url));
    return;
  }
  if (url.pathname === "/directory") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDirectory(url));
    return;
  }
  if (url.pathname === "/gate") {
    const code = (url.searchParams.get("code") ?? "").trim();
    if (code) {
      if (code === GATE_CODE) {
        res.writeHead(302, {
          location: "/article/gamma",
          "set-cookie": `${UNLOCK_COOKIE}=1; Path=/; Max-Age=86400; SameSite=Lax`,
        });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderGate({ error: "Wrong code. Try again." }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderGate({ error: null }));
    return;
  }
  if (url.pathname.startsWith("/article/")) {
    const slug = url.pathname.replace("/article/", "").trim();
    if (["alpha", "delta", "epsilon"].includes(slug)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderArticle(slug));
      return;
    }
    if (slug === "beta") {
      if (cookies[SEARCH_COOKIE] !== "1") {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        res.end(
          renderPage({
            title: "Search required",
            body: `
              <header><h1>Search required</h1></header>
              <main>
                <p class="muted">To open the Beta article, use the Search UI first.</p>
                <p><a href="/search">Go to search</a> · <a href="/">Back home</a></p>
              </main>
            `,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderArticle(slug));
      return;
    }
    if (slug === "gamma") {
      if (cookies[UNLOCK_COOKIE] !== "1") {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        res.end(
          renderPage({
            title: "Locked",
            body: `
              <header><h1>Locked</h1></header>
              <main>
                <p class="muted">This story is locked. Use the gate to unlock it.</p>
                <p><a href="/gate">Open gate</a> · <a href="/">Back home</a></p>
              </main>
            `,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderArticle(slug));
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen({ host, port: requestedPort }, () => {
  const address = server.address();
  const actualPort =
    address && typeof address === "object" && typeof address.port === "number"
      ? address.port
      : requestedPort;

  if (statePath) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          { pid: process.pid, host, port: actualPort, startedAt: new Date().toISOString() },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // best-effort only
    }
  }

  // Single line so global-setup can parse it if needed.
  console.log(`fixture-site listening host=${host} port=${actualPort}`);
});
