// SPDX-License-Identifier: AGPL-3.0-only
//
// "Find running shoes": a bound compare grid.
// Reads seed items from data/items.json, renders uw.records@1 records from the binder's store,
// and turns clicks into intents (read_offer = script, check_size = Octo turn).
// Records are untrusted data: everything goes through textContent, and links must be https.

(() => {
  const $ = (id) => document.getElementById(id);
  const bind = window.instafyBind;
  const grid = $("grid"), statusEl = $("status"), conn = $("conn"), logEl = $("log"), sizeInput = $("size");

  const TIMEOUT_S = { read_offer: 60, check_size: 330 };
  const READ_CELLS = ["price", "in_stock", "sizes", "colors", "link"];
  const ROWS = [
    { key: "price", label: "Price" },
    { key: "in_stock", label: "Stock" },
    { key: "size", label: "Your size" },
    { key: "sizes", label: "Sizes" },
    { key: "colors", label: "Colours" },
    { key: "link", label: "Store" },
  ];

  let items = [];
  let capabilities = new Set(["read_offer", "check_size"]);
  let staticRecords = [];                 // only used when no binder is serving the page
  const pending = new Map();              // intent id -> { name, ref, cells:Set, started, remote }
  const errors = new Map();               // `${ref}|${cell}` -> { code, message, retry }
  const flash = new Set();                // `${ref}|${cell}` flashed on the next render

  // ---------- helpers ----------
  function normSize(value) {
    const s = String(value ?? "").toLowerCase().replace(/\b(us|eu|uk|men'?s|women'?s|size)\b/g, "").replace(/^\s*[mw](?=\d)/, "").trim();
    const n = Number.parseFloat(s.replace(",", "."));
    return Number.isFinite(n) ? String(n) : s.replace(/\s+/g, "");
  }
  function sizeAttr(size) {
    return `size_${normSize(size).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "x"}`;
  }
  function mySize() {
    const v = sizeInput.value.trim();
    return /^[A-Za-z0-9 .,/-]{1,12}$/.test(v) ? v : "";
  }
  function age(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const expired = (r) => Date.now() > Date.parse(r?.prov?.observed_at) + (r?.prov?.ttl_s ?? Infinity) * 1000;
  const newest = (list) => list.slice().sort((a, b) => Date.parse(b.prov?.observed_at) - Date.parse(a.prov?.observed_at))[0];
  const safeUrl = (u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) ? url.href : null;
    } catch { return null; }
  };
  function money(amount, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
    } catch { return `${currency} ${amount}`; }
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function log(kind, text) {
    const row = el("div", `k-${kind}`);
    row.textContent = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}  ${kind.padEnd(8)} ${text}`;
    logEl.prepend(row);
    while (logEl.childElementCount > 120) logEl.lastChild.remove();
  }
  let toastTimer;
  function toast(text) {
    const t = $("toast");
    t.textContent = String(text).slice(0, 140);
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("on"), 2800);
  }
  const announce = (text) => { $("announce").textContent = text; };
  const itemByRef = (ref) => items.find((i) => i.ref === ref);
  function resolveRef(value) {
    const v = String(value || "").trim();
    return items.find((i) => i.ref === v || i.letter.toLowerCase() === v.toLowerCase() || i.ref === `shoes:${v}`)?.ref || null;
  }

  // ---------- records ----------
  function allRecords() {
    if (bind) {
      try { return bind.records() || []; } catch { return []; }
    }
    return staticRecords;
  }
  function claimFor(recs, ref, attr) {
    return newest(recs.filter((r) => r.type === "claim" && r.ref === ref && r.attr === attr));
  }
  function priceOffer(recs, ref) {
    return newest(recs.filter((r) => r.type === "offer" && r.ref === ref && !r.variant?.label));
  }
  function sizeOffer(recs, ref, size) {
    const want = normSize(size);
    return newest(recs.filter((r) => r.type === "offer" && r.ref === ref && r.variant?.label && normSize(r.variant.label) === want));
  }
  function cheapestRefs(recs) {
    const byCur = new Map();
    for (const item of items) {
      const o = priceOffer(recs, item.ref);
      if (!o || o.seller?.trust !== "curated" || o.availability !== "in_stock" || expired(o)) continue;
      const list = byCur.get(o.price.currency) || [];
      list.push(o);
      byCur.set(o.price.currency, list);
    }
    const out = new Set();
    for (const list of byCur.values()) {
      if (list.length < 2) continue;
      const min = Math.min(...list.map((o) => o.price.amount));
      list.filter((o) => o.price.amount === min).forEach((o) => out.add(o.ref));
    }
    return out;
  }

  // ---------- intents ----------
  function cellsFor(name, params) {
    if (name === "check_size") return new Set(["size"]);
    return new Set(params?.size ? [...READ_CELLS, "size"] : READ_CELLS);
  }
  function readParams(item, withSize = true) {
    const size = withSize ? mySize() : "";
    return size ? { url: item.url, ref: item.ref, size, attr: sizeAttr(size) } : { url: item.url, ref: item.ref };
  }
  function send(name, params, ui) {
    if (!bind) return toast("No binder is serving this page");
    if (!capabilities.has(name)) return toast("This binder doesn't run that check");
    let id;
    try {
      id = bind.intent(name, params, { ref: params.ref, ui });
    } catch (error) {
      toast(error?.message || String(error));
      return;
    }
    const cells = cellsFor(name, params);
    for (const c of cells) errors.delete(`${params.ref}|${c}`);
    pending.set(id, { name, ref: params.ref, params, cells, started: Date.now(), remote: false });
    log("intent", `${name} ${params.ref}${params.size ? " size " + params.size : ""}  ${id}`);
    render();
    return id;
  }
  function settle(id) {
    const p = pending.get(id);
    pending.delete(id);
    return p;
  }
  // Another viewer's click: events carry only intent ids, so ask the binder's job list for name and ref.
  const lookedUp = new Set();
  async function noteRemote(msg) {
    const id = msg?.id;
    if (!id || pending.has(id) || lookedUp.has(id) || msg.status === "rejected") return;
    lookedUp.add(id);
    try {
      const job = (await bind.jobs()).find((j) => (j.ids || []).includes(id)) || null;
      if (!job || !itemByRef(job.ref) || ["done", "error"].includes(job.state) || pending.has(id)) return;
      pending.set(id, { name: job.name, ref: job.ref, params: {}, cells: cellsFor(job.name, {}), started: Date.now(), remote: true });
      log("remote", `${job.name} ${job.ref} (another viewer)`);
      render();
    } catch {
      /* the skeleton is a nicety; results still arrive */
    }
  }
  const isPending = (ref, cell) => [...pending.values()].some((p) => p.ref === ref && p.cells.has(cell));
  function pendingId(ref, cell) {
    // The cancel ✕ sits in the job's first cell only, so one job shows one ✕.
    for (const [id, p] of pending) if (p.ref === ref && p.cells.values().next().value === cell) return id;
    return null;
  }
  function pendingNote(ref, cell) {
    const p = [...pending.values()].find((x) => x.ref === ref && x.cells.has(cell));
    if (!p) return "";
    if (p.progress) return p.progress;
    return p.name === "check_size" ? "Octo is checking…" : "Reading the page…";
  }
  setInterval(() => {
    let changed = false;
    for (const [id, p] of pending) {
      if (Date.now() - p.started > (TIMEOUT_S[p.name] || 60) * 1000) {
        pending.delete(id);
        for (const c of p.cells) errors.set(`${p.ref}|${c}`, { code: "timeout", message: "No answer in time", retry: { name: p.name, params: p.params } });
        changed = true;
      }
    }
    if (changed) render();
  }, 5000);

  // ---------- render ----------
  function headCell(item) {
    const h = el("div", "head");
    h.dataset.ref = item.ref;
    h.setAttribute("role", "columnheader");
    h.append(el("span", "letter", item.letter), el("span", "brand", item.brand), el("span", "model", item.model), el("span", "use", item.use));
    return h;
  }

  function actButton(symbol, title, onClick) {
    const b = el("button", "", symbol);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }

  // Re-run what produced a record: its prov.intent if the binder stamped one, else the default read.
  function retryFor(record, item, fallbackName = "read_offer") {
    const pi = record?.prov?.intent;
    if (pi?.name && capabilities.has(pi.name) && pi.params && pi.params.ref === item.ref) {
      const params = { ...pi.params };
      if (pi.name === "read_offer") params.refresh = true;
      return { name: pi.name, params };
    }
    return { name: fallbackName, params: fallbackName === "check_size" ? { ...readParams(item), size: mySize(), attr: sizeAttr(mySize()) } : readParams(item) };
  }

  function fillCell(cell, { value, valueClass = "", extra, meta, record, acts = [], note }) {
    const v = el("div", `v ${valueClass}`.trim());
    if (value instanceof Node) v.append(value);
    else v.textContent = value;
    if (extra) v.append(...extra);
    cell.append(v);
    if (acts.length) {
      const a = el("div", acts.length > 1 ? "acts two" : "acts");
      a.append(...acts);
      cell.append(a);
    }
    const metaText = meta ?? (record ? [record.prov?.source_label || record.prov?.source, age(record.prov?.observed_at) + (expired(record) ? " · expired" : "")].filter(Boolean).join(" · ") : "");
    if (metaText) cell.append(el("div", "m", metaText));
    if (note) cell.append(el("div", "note", note));
    if (record && expired(record)) cell.classList.add("expired");
  }

  function bodyCell(item, row, recs, lowest) {
    const cell = el("div", "cell");
    cell.dataset.ref = item.ref;
    cell.dataset.cell = row.key;
    cell.setAttribute("role", "cell");
    const key = `${item.ref}|${row.key}`;
    if (flash.has(key)) {
      cell.classList.add("flash");
      setTimeout(() => cell.classList.remove("flash"), 1600);
    }
    if (isPending(item.ref, row.key)) {
      const sk = el("div", "skel");
      sk.setAttribute("aria-label", "Checking");
      const line = el("div", "pl");
      line.append(el("span", "", pendingNote(item.ref, row.key)));
      const id = pendingId(item.ref, row.key);
      if (id && bind) {
        const x = actButton("✕", "Cancel this check", () => { bind.cancel(id); log("cancel", id); });
        line.append(x);
      }
      sk.append(el("i"), el("i"), line);
      cell.append(sk);
      return cell;
    }
    const err = errors.get(key);
    if (err) {
      cell.classList.add("err");
      fillCell(cell, {
        value: "Couldn't check", valueClass: "none",
        meta: `${err.code}: ${err.message}`,
        acts: [actButton("↻", "Try again", () => send(err.retry.name, err.retry.params, "cell"))],
      });
      return cell;
    }
    const again = (record, name) => actButton("↻", "Check again", () => {
      const r = retryFor(record, item, name);
      send(r.name, r.params, "cell");
    });

    switch (row.key) {
      case "price": {
        const o = priceOffer(recs, item.ref);
        if (!o) { fillCell(cell, { value: "Not checked", valueClass: "none", acts: [again(null)] }); break; }
        const extra = [];
        const was = claimFor(recs, item.ref, "list_price");
        if (was && typeof was.value === "number" && was.value > o.price.amount) extra.push(el("span", "was", money(was.value, was.unit || o.price.currency)));
        if (lowest.has(item.ref)) extra.push(el("span", "chip low", `lowest ${o.price.currency}`));
        if (o.price.kind === "from") extra.unshift(el("span", "chip", "from"));
        // Only a price read from the brand's own store (seller.trust "curated") counts as the store's price.
        if (o.seller?.trust !== "curated") extra.push(el("span", "chip warn", o.prov?.lane === "assist" ? "Octo, unverified" : "other site"));
        fillCell(cell, { value: money(o.price.amount, o.price.currency), extra, record: o, acts: [again(o)] });
        break;
      }
      case "in_stock": {
        const c = claimFor(recs, item.ref, "in_stock");
        if (!c) { fillCell(cell, { value: "—", valueClass: "none", acts: [again(null)] }); break; }
        fillCell(cell, { value: c.value ?? "Unknown", valueClass: c.value === "In stock" ? "in" : c.value === "Sold out" ? "out" : "", record: c, acts: [again(c)] });
        break;
      }
      case "size": {
        const size = mySize();
        if (!size) { fillCell(cell, { value: "Enter your size", valueClass: "none" }); break; }
        const attr = sizeAttr(size);
        const c = claimFor(recs, item.ref, attr);
        const o = sizeOffer(recs, item.ref, size);
        const acts = [actButton("↻", `Read size ${size} from the page data`, () => send("read_offer", readParams(item), "cell"))];
        if (capabilities.has("check_size")) {
          acts.push(actButton("🐙", `Ask Octo to check size ${size} on the page`, () => send("check_size", { url: item.url, ref: item.ref, size, attr }, "cell")));
        }
        if (!c) { fillCell(cell, { value: `Size ${size}: not checked`, valueClass: "none small", acts }); break; }
        const extra = [];
        if (c.prov?.lane === "assist") extra.push(el("span", "chip", "Octo"));
        if (o && !expired(o)) extra.push(el("span", "sp", money(o.price.amount, o.price.currency)));
        const value = c.value == null ? "Not in page data" : c.value;
        fillCell(cell, {
          value, valueClass: c.value === "In stock" ? "in" : c.value === "Sold out" ? "out" : c.value == null ? "none small" : "",
          extra, record: c, acts, note: c.status !== "ok" ? c.note : "",
        });
        break;
      }
      case "sizes": {
        const inStock = claimFor(recs, item.ref, "sizes_in_stock");
        const listed = claimFor(recs, item.ref, "sizes_listed");
        const c = inStock || listed;
        if (!c) { fillCell(cell, { value: "—", valueClass: "none", acts: [again(null)] }); break; }
        if (c.value == null) { fillCell(cell, { value: "Not in page data", valueClass: "none small", record: c, acts: [again(c)] }); break; }
        fillCell(cell, { value: c.value, valueClass: "small", extra: inStock ? [el("span", "chip ok", "in stock")] : [], record: c, acts: [again(c)] });
        break;
      }
      case "colors": {
        const c = claimFor(recs, item.ref, "colors");
        fillCell(cell, c ? { value: c.value, valueClass: "small", record: c } : { value: "—", valueClass: "none" });
        break;
      }
      case "link": {
        // The store link comes from the seed list (data/items.json), or from an offer the binder marked curated.
        // An offer from anywhere else never replaces the link: records are data a viewer's click could have planted.
        const o = priceOffer(recs, item.ref);
        const curated = o?.seller?.trust === "curated";
        const href = (curated && safeUrl(o.handoff?.url)) || safeUrl(item.url);
        const a = el("a", "handoff", `${(curated && o.seller?.name) || item.site} ↗`);
        if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; }
        fillCell(cell, { value: a, meta: curated ? "brand store" : item.site });
        break;
      }
    }
    return cell;
  }

  function render() {
    const recs = allRecords();
    const lowest = cheapestRefs(recs);
    grid.style.setProperty("--cols", String(items.length || 4));
    const frag = document.createDocumentFragment();
    frag.append(el("div", "rowLabel", ""));
    items.forEach((item) => frag.append(headCell(item)));
    ROWS.forEach((row, i) => {
      const label = el("div", "rowLabel", row.label);
      label.setAttribute("role", "rowheader");
      if (i === ROWS.length - 1) label.classList.add("last");
      frag.append(label);
      for (const item of items) {
        const c = bodyCell(item, row, recs, lowest);
        if (i === ROWS.length - 1) c.classList.add("last");
        frag.append(c);
      }
    });
    grid.replaceChildren(frag);
    flash.clear();
    const currencies = new Set(items.map((i) => priceOffer(recs, i.ref)?.price.currency).filter(Boolean));
    $("foot").firstChild.textContent = currencies.size > 1
      ? `Each cell shows value · source · age. Prices in different currencies (${[...currencies].join(", ")}) are not compared. ↻ checks again; 🐙 asks Octo to open the page. `
      : "Each cell shows value · source · age. ↻ checks again; 🐙 asks Octo to open the page. ";
    $("checkAll").disabled = !bind || [...pending.values()].some((p) => p.name === "read_offer" && !p.remote);
  }
  setInterval(render, 30000);

  function highlight(refs, ms = 2500) {
    for (const ref of refs) {
      grid.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`).forEach((node) => {
        node.classList.add("col-hl");
        setTimeout(() => node.classList.remove("col-hl"), Math.min(ms, 15000));
      });
    }
  }
  function select(ref) {
    const head = grid.querySelector(`.head[data-ref="${CSS.escape(ref)}"]`);
    if (!head) return;
    const wrap = grid.parentElement;
    wrap.scrollTo({ left: Math.max(0, head.offsetLeft - grid.querySelector(".rowLabel").offsetWidth), behavior: "smooth" });
    head.scrollIntoView({ block: "nearest", behavior: "smooth" });
    highlight([ref], 4000);
  }

  // ---------- wiring ----------
  try { sizeInput.value = localStorage.getItem("shoes.size") || ""; } catch {}
  sizeInput.addEventListener("input", () => {
    try { localStorage.setItem("shoes.size", sizeInput.value.trim()); } catch {}
    render();
  });
  $("checkAll").addEventListener("click", () => {
    for (const item of items) send("read_offer", readParams(item), "header");
    statusEl.textContent = `Reading ${items.length} store pages…`;
  });

  async function loadItems() {
    const res = await fetch("data/items.json", { cache: "no-store" });
    const data = await res.json();
    items = (data.items || []).filter((i) => i && typeof i.ref === "string" && safeUrl(i.url));
    if (data.question) $("question").textContent = `${data.question} ${items.length} shortlisted pairs, read live from each brand's own store.`;
  }

  async function loadStatic() {
    // No binder: show whatever records were written last, read-only.
    const merged = new Map();
    for (const file of ["data/records/read_offer.json", "data/records/check_size.json"]) {
      try {
        const res = await fetch(file, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        for (const r of data.records || []) {
          const k = r.cid || r.oid || r.iid;
          if (!k) continue;
          const prev = merged.get(k);
          if (!prev || Date.parse(r.prov?.observed_at) > Date.parse(prev.prov?.observed_at)) merged.set(k, r);
        }
      } catch {}
    }
    staticRecords = [...merged.values()];
  }

  function wireBinder() {
    bind.ready.then((hello) => {
      if (!hello?.connected) {
        capabilities = new Set();
        conn.textContent = "read-only";
        conn.dataset.state = "off";
        statusEl.textContent = "No binder is connected, so checks are off. Showing the last saved results.";
        render();
        return;
      }
      conn.textContent = "live";
      conn.dataset.state = "live";
      capabilities = new Set(hello.names || (hello.intents || []).map((i) => i.name));
      log("hello", `binder ready · ${[...capabilities].join(", ")}`);
      render();
    });

    bind.on("ack", (msg) => {
      noteRemote(msg);
      log("ack", `${msg.status || ""} ${msg.id || ""}${msg.reason ? " · " + msg.reason : ""}`);
      if (msg.status === "rejected") {
        const p = settle(msg.id);
        if (p && !p.remote) toast(msg.reason === "cooldown" ? "Just checked. Try again in a few seconds." : `Not sent: ${msg.reason || "rejected"}`);
        render();
      } else if (msg.status === "needs_confirm") {
        statusEl.textContent = "Waiting for confirmation in chat…";
      }
    });
    bind.on("progress", (msg) => {
      noteRemote(msg);
      const pr = msg.progress || {};
      const text = [pr.message, pr.of ? `${pr.step}/${pr.of}` : ""].filter(Boolean).join(" · ");
      const p = pending.get(msg.id);
      if (p) p.progress = text;
      log("progress", `${p?.ref || msg.id} ${text}`);
      statusEl.textContent = `${itemByRef(p?.ref)?.model || "Checking"}: ${text}`;
      render();
    });
    bind.on("results", (msg) => {
      const recs = Array.isArray(msg.records) ? msg.records : [];
      const p = pending.get(msg.id);
      markFlash(recs);
      const refs = [...new Set(recs.map((r) => r.ref))];
      log("results", `${recs.length} record(s) ${refs.join(", ")}`);
      if (refs.length) announce(`${refs.map((r) => itemByRef(r)?.model || r).join(", ")} updated`);
      if (p) for (const c of p.cells) errors.delete(`${p.ref}|${c}`);
    });
    bind.on("records", (msg) => {
      markFlash(msg?.changed || []);
      render();
    });
    function markFlash(recs) {
      for (const r of recs) {
        if (r.type === "offer" && r.variant?.label) flash.add(`${r.ref}|size`);
        else if (r.type === "offer") READ_CELLS.forEach((c) => c !== "colors" && flash.add(`${r.ref}|${c}`));
        else if (r.attr === "in_stock") flash.add(`${r.ref}|in_stock`);
        else if (/^size_/.test(r.attr || "")) flash.add(`${r.ref}|size`);
        else if (/^sizes_/.test(r.attr || "")) flash.add(`${r.ref}|sizes`);
        else if (r.attr === "colors") flash.add(`${r.ref}|colors`);
      }
    }
    bind.on("done", (msg) => {
      const p = settle(msg.id);
      log("done", `${p?.ref || msg.id}${msg.summary ? " · " + msg.summary : ""}`);
      if (msg.summary) statusEl.textContent = msg.summary;
      render();
    });
    bind.on("error", (msg) => {
      const p = settle(msg.id) || (msg.ref && msg.name ? { ref: msg.ref, name: msg.name, params: msg.params, cells: cellsFor(msg.name, msg.params) } : null);
      const e = msg.error || {};
      log("error", `${p?.ref || msg.id} ${e.code || "error"} ${e.message || ""}`);
      if (p && e.code === "cancelled") {
        statusEl.textContent = `${itemByRef(p.ref)?.model || p.ref}: cancelled`;
      } else if (p) {
        for (const c of p.cells) errors.set(`${p.ref}|${c}`, { code: e.code || "error", message: e.message || "Something went wrong", retry: { name: p.name, params: p.params } });
        statusEl.textContent = `${itemByRef(p.ref)?.model || p.ref}: ${e.message || e.code}`;
      }
      render();
    });
    bind.on("command", (msg) => {
      const c = msg.command || {};
      const args = c.args || {};
      log("command", `${c.name} ${JSON.stringify(args)}`);
      if (c.name === "select") {
        const ref = resolveRef(args.ref ?? args.letter);
        if (ref) select(ref);
      } else if (c.name === "highlight") {
        highlight((args.refs || [args.ref]).map(resolveRef).filter(Boolean), Number(args.ms) || 2500);
      } else if (c.name === "toast") {
        toast(args.text || args.message || "");
      } else if (c.name === "reload") {
        setTimeout(() => location.reload(), 50);
      }
    });
  }

  (async () => {
    try {
      await loadItems();
    } catch (error) {
      statusEl.textContent = "Couldn't load data/items.json";
      return;
    }
    if (!bind) {
      conn.textContent = "read-only";
      conn.dataset.state = "off";
      statusEl.textContent = "No binder is serving this page, so checks are off. Showing the last saved results.";
      await loadStatic();
      render();
      return;
    }
    wireBinder();
    render();
  })();
})();
