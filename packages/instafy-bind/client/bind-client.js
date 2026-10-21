/*!
 * instafy-bind client (served by the binder at __bind/client.js).
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Load it with a script tag whose src is "__bind/client.js" (relative to the page), then:
 *   const { intents } = await instafyBind.ready;
 *   const id = instafyBind.intent("check_product", { url, size, ref }, { ref });
 *   instafyBind.on("records", ({ records }) => render(records));
 *   instafyBind.on("done", (msg) => { if (msg.id === id) ... });
 *
 * Events for on(type, fn): hello, ack, progress, results, done, error, command, records (store changed),
 * intent (local), and "*" (fn(type, payload)). Each also fires as a window CustomEvent "bind:<type>".
 * Transports in: SSE from the binder, postMessage from window.parent (source "instafy-host", only from the origins
 * the binder lists in health.parentOrigins), and polling data/version.json while SSE is down. All are deduped.
 * Record strings are data: render them with textContent.
 *
 * Ask Octo (agent intents): the binder never runs them for a viewer. Framed by a host that takes asks (Studio: layout
 * caps.ask === true), they are in `names` like any intent and intent() hands the click to the host, which sends it as
 * the clicker's own chat message: {source:"instafy-bind", v:1, type:"ask", payload:{id, intent, label, params, ref}}.
 * The payload also carries the intent's `say` (bound.json's chat line) and `confirm: true` when it has them.
 * The host answers {type:"ask-status", payload:{id, state: "confirm"|"sent"|"done"|"declined"|"failed", reason?}}
 * ("confirm": it is asking the person first, so the click waits instead of timing out). When caps.ask
 * is a string, this person may not send messages there: the asks are listed with `disabled: <that reason>` and a click
 * says so. Anywhere else asks are not offered (the page hides them like any intent not in `names`).
 *
 * Location: `await instafyBind.location()` (or location({watch: true}, onPosition)). In a host that offers it (layout
 * caps.location === "host") the host asks the browser once and shows which site got the position; a page of its own
 * asks navigator.geolocation; a framed page with no such host rejects with code "unavailable" ("Location is not
 * available in this preview yet."). Studio's side is not built yet.
 *
 * Follow mode (Studio's Present / Follow): framed by Studio, the page shares its view while Studio
 * says "present": path, query, hash, the element with an id at the top of the window and the scroll position. A
 * follower's copy applies it (history.replaceState + popstate, then scrolls there). Keep sort and filters in the URL
 * query and give rows ids, and that is all. A page with more state: instafyBind.follow({ get: () => state,
 * apply: (state) => show(state) }). instafyBindConfig.view = false turns it off.
 *
 * Studio's look: its layout message sets <html data-theme="light|dark"> (unless <html data-theme-fixed>) and
 * data-host-title="shown" while Studio shows the page title; the starters' theme.css reads both.
 *
 * The viewer token arrives once as #k=<token>. The client trades it for an HttpOnly cookie (POST __bind/session),
 * removes it from the address bar and never exposes it to other scripts.
 */
(function () {
  "use strict";
  if (window.instafyBind && window.instafyBind.version) return;

  var HOST_TYPES = ["hello", "ack", "progress", "results", "done", "error", "command"];
  var LOW_TRUST_LANES = ["assist", "capture"];
  var NO_LISTENER_MS = 5000;
  var cfg = window.instafyBindConfig || {};
  var script = document.currentScript;
  var base = script && script.src ? script.src.replace(/client\.js(?:[?#].*)?$/, "") : new URL("__bind/", location.href).href;
  var siteRoot = base.replace(/__bind\/$/, "");
  var listeners = {};
  var seen = new Set();
  var seenOrder = [];
  var store = new Map();
  var pending = new Map();
  var active = new Map(); // every viewer's running intents, from acks: id -> {name, ref, status}
  var catalog = null;
  var asks = []; // agent intents: asks the host sends as the clicker's message (catalog entries from the binder)
  var askIds = new Set(); // ids of asks sent to the host, so only its answers about them count
  var hostReady = false;
  var sseOpen = false;
  var parentOrigin = null;
  var parentOrigins = null; // the origins that may host this page in a frame (the binder's list + this origin); null until known
  var parentQueue = [];
  var lastVersion = 0;
  var hasToken = false;
  var resolveReady;
  var ready = new Promise(function (resolve) { resolveReady = resolve; });

  // ---- token: #k=<token> in the share URL. Read once, then removed from the address bar.
  function takeToken() {
    var match = /(?:^#|[#&])k=([A-Za-z0-9_-]{16,128})/.exec(location.hash || "");
    if (!match) return "";
    try {
      var rest = location.hash.replace(/^#/, "").split("&").filter(function (part) { return part.indexOf("k=") !== 0; }).join("&");
      history.replaceState(history.state, "", location.pathname + location.search + (rest ? "#" + rest : ""));
    } catch (e) { /* sandboxed frames may refuse */ }
    return match[1];
  }
  var token = takeToken();
  function authHeaders(extra) {
    var headers = extra || {};
    if (token) headers["x-bind-token"] = token;
    return headers;
  }

  // ---- events
  function emit(type, payload) {
    (listeners[type] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error("[instafy-bind] listener for " + type + " failed", e); }
    });
    (listeners["*"] || []).slice().forEach(function (fn) {
      try { fn(type, payload); } catch (e) { console.error("[instafy-bind] * listener failed", e); }
    });
    try { window.dispatchEvent(new CustomEvent("bind:" + type, { detail: payload })); } catch (e) { /* old browsers */ }
  }
  function on(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
    return function off() {
      var list = listeners[type] || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  // ---- records store (instafy.records@1 merge rules, same as the binder)
  function recordKey(r) {
    if (r.type === "claim") return "c:" + r.cid;
    if (r.type === "offer") return "o:" + r.oid;
    if (r.type === "item") return "i:" + r.iid;
    return null;
  }
  function observed(r) { return Date.parse((r && r.prov && r.prov.observed_at) || "") || 0; }
  function laneOf(r) { return (r && r.prov && r.prov.lane) || null; }
  function canReplace(prev, next) {
    if (LOW_TRUST_LANES.indexOf(laneOf(next)) >= 0 && LOW_TRUST_LANES.indexOf(laneOf(prev)) < 0) return false;
    return observed(next) >= observed(prev);
  }
  function mergeRecords(list) {
    var changed = [];
    (list || []).forEach(function (r) {
      if (!r || typeof r !== "object") return;
      var key = recordKey(r);
      if (!key || !r.prov) return;
      var prev = store.get(key);
      if (prev) {
        if (canReplace(prev, r) && JSON.stringify(prev) !== JSON.stringify(r)) { store.set(key, r); changed.push(r); }
        return;
      }
      if (r.type === "claim") {
        var older = null;
        store.forEach(function (x, k) {
          if (!older && x.type === "claim" && x.ref === r.ref && x.attr === r.attr && x.prov && x.prov.source === r.prov.source && laneOf(x) === laneOf(r)) older = k;
        });
        if (older) {
          if (canReplace(store.get(older), r)) { store.delete(older); store.set(key, r); changed.push(r); }
          return;
        }
      }
      store.set(key, r);
      changed.push(r);
    });
    return changed;
  }
  function allRecords(ref) {
    var out = [];
    store.forEach(function (r) { if (!ref || r.ref === ref) out.push(r); });
    return out;
  }
  function ingestRecords(list, source) {
    var changed = mergeRecords(list);
    if (changed.length) emit("records", { records: allRecords(), changed: changed, source: source });
    return changed;
  }

  // ---- host messages
  function dedupeKey(m) {
    switch (m.type) {
      case "hello": return null;
      case "ack": return "ack|" + m.id + "|" + m.status;
      case "done": case "error": return m.type + "|" + m.id;
      case "progress": return "progress|" + m.id + "|" + (m.at || "") + "|" + JSON.stringify(m.progress || {});
      case "results": return "results|" + m.id + "|" + (m.at || "") + "|" + JSON.stringify(m.files || {}) + "|" + ((m.records || []).length);
      case "command": return "command|" + (m.at || "") + "|" + JSON.stringify(m.command || {});
      default: return null;
    }
  }
  function remember(key) {
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    seenOrder.push(key);
    if (seenOrder.length > 2000) seen.delete(seenOrder.shift());
    return true;
  }
  // Older binders report a coalesced job under its first intent id; re-address it to this page's own id.
  function localize(m) {
    if (!m.id || pending.has(m.id) || !Array.isArray(m.ids)) return m;
    for (var i = 0; i < m.ids.length; i++) {
      if (pending.has(m.ids[i])) { var copy = Object.assign({}, m); copy.id = m.ids[i]; return copy; }
    }
    return m;
  }
  // Built-in toast (Instafy look: charcoal, works on light and dark pages). Placement sits on the
  // .instafy-bind-toast class so a host page's element rules (div { position: relative; padding: 0 })
  // cannot break it; the look sits in :where() and reads --bind-toast-* custom properties, so a site
  // re-skins it with those properties or with any .instafy-bind-toast rule of its own.
  var TOAST_CSS = ".instafy-bind-toast{position:fixed;inset:auto auto max(24px,env(safe-area-inset-bottom)) 50%;" +
    "transform:translateX(-50%);box-sizing:border-box;width:max-content;height:auto;max-width:min(calc(100vw - 32px),480px);" +
    "margin:0;padding:var(--bind-toast-padding,10px 18px);z-index:2147483647;pointer-events:none}" +
    ":where(.instafy-bind-toast){border-radius:var(--bind-toast-radius,16px);background:var(--bind-toast-bg,var(--if-toast-bg,#262626));" +
    "color:var(--bind-toast-ink,var(--if-toast-fg,#fafafa));border:1px solid var(--bind-toast-border,rgb(255 255 255/.08));" +
    "box-shadow:0 12px 32px -12px rgb(0 0 0/.45);" +
    "font:500 14px/1.4 var(--bind-toast-font,var(--if-font,Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif))}";
  var toastEl = null, toastTimer = null;
  function showToast(text) {
    if (!document.getElementById("instafy-bind-style")) {
      var style = document.createElement("style");
      style.id = "instafy-bind-style";
      style.textContent = TOAST_CSS;
      document.head.appendChild(style);
    }
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "instafy-bind-toast";
      toastEl.setAttribute("role", "status");
    }
    toastEl.textContent = String(text || "").slice(0, 200);
    document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.remove(); }, 4000);
  }
  function handleHost(raw, via) {
    if (!raw || raw.source !== "instafy-host" || raw.v !== 2 || HOST_TYPES.indexOf(raw.type) < 0) return;
    var m = localize(raw);
    if (!remember(dedupeKey(m))) return;
    var ids = m.id ? [m.id] : [];
    var myIntent = null;
    ids.forEach(function (id) { if (pending.has(id)) myIntent = pending.get(id); });
    if (m.type === "hello") {
      if (m.capabilities && Array.isArray(m.capabilities.intents) && !catalog) {
        catalog = m.capabilities.intents.map(function (name) { return { name: name }; });
        finishReady({ connected: true, via: via });
      }
    } else if (m.type === "ack") {
      ids.forEach(function (id) {
        var p = pending.get(id);
        if (m.status === "rejected") { pending.delete(id); active.delete(id); return; }
        if (p) { p.status = m.status; p.job = m.job || p.job; if (p.timer) { clearTimeout(p.timer); p.timer = null; } }
        if (m.name) active.set(id, { id: id, name: m.name, ref: m.ref || (p && p.ref) || null, status: m.status, mine: !!p });
      });
    } else if (m.type === "progress") {
      ids.forEach(function (id) {
        var p = pending.get(id);
        if (p) { p.status = "running"; p.progress = m.progress; }
        var a = active.get(id);
        if (a) { a.status = "running"; a.progress = m.progress; }
      });
    } else if (m.type === "results") {
      ingestRecords(m.records, via);
    } else if (m.type === "done" || m.type === "error") {
      ids.forEach(function (id) { pending.delete(id); active.delete(id); });
    }
    emit(m.type, m);
    if (ids.length && (m.type === "ack" || m.type === "progress" || m.type === "done" || m.type === "error")) emitPending();
    // A failed click must never look like nothing happened: when the page shows no errors itself, say so.
    if (m.type === "error" && myIntent && cfg.builtins !== false && !(m.error && m.error.code === "cancelled") &&
        !(listeners.error && listeners.error.length) && !(listeners["*"] && listeners["*"].length)) {
      var why = (m.error && m.error.message) || m.message || "it failed";
      showToast(String(myIntent.name).replace(/_/g, " ") + " did not work: " + String(why).slice(0, 140));
    }
    if (m.type === "command" && cfg.builtins !== false && m.command) {
      if (m.command.name === "toast") showToast(m.command.args && m.command.args.text);
      if (m.command.name === "reload") setTimeout(function () { location.reload(); }, 50);
    }
  }
  // Anything a page draws from isPending (a "Checking…" button) must redraw when this fires: on send, ack,
  // progress, done, error, a local reject and cancel. `records` alone fires before `done` clears the click.
  function pendingList() {
    var list = [];
    var add = function (x) { if (!list.some(function (y) { return y.id === x.id; })) list.push({ id: x.id, name: x.name, ref: x.ref || null, status: x.status || null }); };
    pending.forEach(add);
    active.forEach(add);
    return list;
  }
  function emitPending() { emit("pending", { pending: pendingList() }); }
  function localAck(id, status, reason, extra) {
    handleHost(Object.assign({ source: "instafy-host", v: 2, type: "ack", id: id, status: status, reason: reason }, extra || {}), "local");
  }

  // ---- intents out
  /** n uniform base36 characters (bytes 252-255 are dropped, so no character is likelier than another) */
  function rand36(n) {
    var out = "";
    while (out.length < n) {
      var bytes = new Uint8Array(n * 2);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach(function (_, i) { bytes[i] = Math.random() * 256; });
      bytes.forEach(function (b) { if (b < 252 && out.length < n) out += (b % 36).toString(36); });
    }
    return out;
  }
  function newId() {
    return "int_" + Date.now().toString(36) + "_" + rand36(4);
  }
  function post(msg) {
    return fetch(base + "intent", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(msg), credentials: "same-origin" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (msg.name === "cancel") return;
          // An agent intent the binder will not run for this viewer: it is an ask, which only the host can send.
          if (res.status === 409 && body.reason === "ask_via_host") return askHost(msg);
          if (res.status === 202 || res.status === 409) {
            var p = pending.get(msg.id);
            if (p && body.cancel_key) p.cancelKey = body.cancel_key;
            handleHost({ source: "instafy-host", v: 2, type: "ack", id: msg.id, job: body.job, status: body.status || "queued" }, "http");
            if (p && p.cancelRequested && pending.has(msg.id)) cancel(msg.id);
          } else {
            var reason = body.reason || (res.status === 401 ? "token" : res.status === 429 ? "cooldown" : "http " + res.status);
            localAck(msg.id, "rejected", String(reason).slice(0, 140), { retry_after_s: body.retry_after_s });
          }
        });
      })
      .catch(function () { localAck(msg.id, "rejected", "offline"); });
  }
  function toParent(msg) {
    // Only to a parent that said hello from an allowed origin; never to "*".
    if (window.parent === window || !parentOrigin) return false;
    try { window.parent.postMessage(msg, parentOrigin); return true; } catch (e) { return false; }
  }
  // ---- Ask Octo through the host (see the header)
  var ASK_ELSEWHERE = "Ask Octo works when this page is open in Instafy.";
  var ASK_NO_ANSWER = "Instafy did not answer. Try again, or ask in the chat.";
  /** true: the host sends asks as the clicker's message; a string: it does not let this person send (why); else null. */
  function askState() {
    var a = hostLayout && embedded() ? hostLayout.caps.ask : null;
    return a === true || typeof a === "string" ? a : null;
  }
  /** An agent intent: one of the asks, or one the binder listed as its own (the owner's local --agent-executor). */
  function askDef(name) {
    var list = asks.concat((catalog || []).filter(function (d) { return d.executor === "agent"; }));
    for (var i = 0; i < list.length; i += 1) if (list[i].name === name) return list[i];
    return null;
  }
  /** Asks are in the catalog only while a host takes them (or says why this person cannot). */
  function syncAsks() {
    if (!catalog) return;
    var state = askState();
    catalog = catalog.filter(function (d) { return d.via !== "host"; });
    if (state === null) return;
    asks.forEach(function (d) {
      catalog.push(Object.assign({}, d, { via: "host" }, typeof state === "string" ? { disabled: state } : {}));
    });
  }
  // An ask becomes a chat message everyone in the conversation reads, so the viewer's position goes rounded to about
  // 100 m (3 decimals) without accuracy, altitude, heading or speed, and params the intent lists in private_params
  // stay out. The same rules as the binder's (src/apply.mjs shareableParams, src/executors/agent.mjs coarsen).
  var LOCATION_PARAM_RE = /^(lat|lng|lon|long|latitude|longitude|coords?|coordinates|position|geo|geolocation|location|accuracy|altitude|heading|near|near_me|my_location|user_location)$/i;
  var POSITION_DETAIL_RE = /^(accuracy|altitude|heading|speed)$/i;
  var COORD_PAIR_RE = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;
  function looksLikePosition(v) {
    if (typeof v === "string") return COORD_PAIR_RE.test(v);
    if (!v || typeof v !== "object") return false;
    if (Array.isArray(v)) return v.length >= 2 && v.length <= 3 && v.every(function (n) { return typeof n === "number"; }) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 180 && v.some(function (n) { return !Number.isInteger(n); });
    return Object.keys(v).some(function (k) { return LOCATION_PARAM_RE.test(k); });
  }
  function coarse(n) { return Math.round(n * 1000) / 1000; }
  function coarsen(v) {
    if (typeof v === "number") return Number.isInteger(v) ? v : coarse(v);
    if (typeof v === "string") return v.replace(/-?\d{1,3}\.\d+/g, function (m) { return String(coarse(Number(m))); });
    if (Array.isArray(v)) return v.map(coarsen);
    if (v && typeof v === "object") {
      var out = {};
      Object.keys(v).forEach(function (k) { if (!POSITION_DETAIL_RE.test(k)) out[k] = coarsen(v[k]); });
      return out;
    }
    return v;
  }
  /** {params, withheld, coarsened}: what an ask may carry into the chat. */
  function askParams(params, def) {
    var declared = Array.isArray(def.private_params) ? def.private_params : [];
    var out = {}, withheld = [], coarsened = [];
    Object.keys(params && typeof params === "object" ? params : {}).forEach(function (k) {
      var v = params[k];
      if (declared.indexOf(k) >= 0 || POSITION_DETAIL_RE.test(k)) { withheld.push(k); return; }
      if (LOCATION_PARAM_RE.test(k) || looksLikePosition(v)) { out[k] = coarsen(v); coarsened.push(k); return; }
      out[k] = v;
    });
    return { params: out, withheld: withheld, coarsened: coarsened };
  }
  function askHost(msg) {
    var def = askDef(msg.name);
    var state = askState();
    if (!def || state === null) return localAck(msg.id, "rejected", ASK_ELSEWHERE);
    if (typeof state === "string") return localAck(msg.id, "rejected", state);
    var shared = askParams(msg.params, def);
    var payload = { id: msg.id, intent: msg.name, label: String(def.label || msg.name).slice(0, 120), params: shared.params, ref: msg.ref };
    // bound.json's own words for the chat line ("Check size {size}") and whether the host confirms first
    if (typeof def.say === "string" && def.say) payload.say = def.say.slice(0, 120);
    if (def.confirm === true) payload.confirm = true;
    if (shared.withheld.length) payload.withheld = shared.withheld;
    if (shared.coarsened.length) payload.coarsened = shared.coarsened;
    askIds.add(msg.id);
    if (!toHost("ask", payload)) { askIds.delete(msg.id); return localAck(msg.id, "rejected", ASK_ELSEWHERE); }
    var p = pending.get(msg.id);
    if (p) p.timer = setTimeout(function () { if (pending.has(msg.id) && pending.get(msg.id).status === "sending") { askIds.delete(msg.id); localAck(msg.id, "rejected", ASK_NO_ANSWER); } }, NO_LISTENER_MS);
  }
  function onAskStatus(p) {
    var id = typeof p.id === "string" ? p.id : null;
    if (!id || !askIds.has(id)) return;
    var reason = typeof p.reason === "string" && p.reason ? p.reason.slice(0, 140) : null;
    var base2 = { source: "instafy-host", v: 2, id: id, name: (pending.get(id) || {}).name };
    if (p.state === "sent") handleHost(Object.assign({ type: "ack", status: "sent" }, base2), "host");
    // the host shows its own confirm first (the intent says confirm: true): the click waits for the person there
    else if (p.state === "confirm") handleHost(Object.assign({ type: "ack", status: "needs_confirm" }, base2), "host");
    else if (p.state === "done") { askIds.delete(id); handleHost(Object.assign({ type: "done", summary: reason }, base2), "host"); }
    else if (p.state === "declined") { askIds.delete(id); localAck(id, "rejected", reason || "Not sent."); }
    else if (p.state === "failed") { askIds.delete(id); handleHost(Object.assign({ type: "error", error: { code: "ask_failed", message: reason || "Octo could not answer." } }, base2), "host"); }
  }

  function intent(name, params, opts) {
    opts = opts || {};
    if (catalog && name !== "cancel" && !catalog.some(function (i) { return i.name === name; })) {
      throw new Error("instafy-bind: intent \"" + name + "\" is not available on this site");
    }
    var isAsk = name !== "cancel" && asks.some(function (d) { return d.name === name; }) &&
      !(catalog || []).some(function (i) { return i.name === name && i.via !== "host"; });
    var msg = {
      source: "instafy-site", v: 2, type: "intent", id: newId(), name: name, params: params || {},
      ui: opts.ui == null ? null : String(opts.ui), ref: opts.ref == null ? null : String(opts.ref),
      site: { title: String(document.title || "").slice(0, 120), path: location.pathname.slice(0, 300) },
      at: new Date().toISOString()
    };
    if (opts.attr) msg.attr = String(opts.attr);
    if (opts.state && typeof opts.state === "object") msg.state = opts.state;
    if (name !== "cancel") pending.set(msg.id, { id: msg.id, name: name, params: msg.params, ref: msg.ref || (params && typeof params.ref === "string" ? params.ref : null), status: "sending", at: msg.at });
    emit("intent", msg);
    if (name !== "cancel") emitPending();
    // An ask never goes to the binder or to a v2 parent: only the host that takes asks may send it, as the clicker.
    if (isAsk) { askHost(msg); return msg.id; }
    var sentToParent = toParent(msg);
    ready.then(function () {
      if (hostReady) post(msg);
      else if (sentToParent && name !== "cancel") {
        // Embedded without a binder: the parent must answer, or the click is cleared (spec: 5 s).
        var p = pending.get(msg.id);
        if (p) p.timer = setTimeout(function () { if (pending.has(msg.id) && pending.get(msg.id).status === "sending") localAck(msg.id, "rejected", "No host answered this page."); }, NO_LISTENER_MS);
      } else if (name !== "cancel") {
        localAck(msg.id, "rejected", "No binder is connected to this page. Run instafy-bind serve.");
      }
    });
    return msg.id;
  }
  function cancel(id) {
    var p = pending.get(id);
    // Cancelled before the binder answered: send the cancel once the cancel key arrives.
    if (p && !p.cancelKey && p.status === "sending" && hostReady) { p.cancelRequested = true; return null; }
    return intent("cancel", { id: id, key: (p && p.cancelKey) || "" });
  }

  // ---- helpers pages keep re-writing
  function isPending(ref, name) {
    var hit = false;
    var match = function (x) { if ((!ref || x.ref === ref) && (!name || x.name === name)) hit = true; };
    pending.forEach(match);
    active.forEach(match);
    return hit;
  }
  function ageSeconds(record) { var at = observed(record); return at ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null; }
  function ageText(record) {
    var s = ageSeconds(record);
    if (s == null) return "";
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function expired(record) {
    var ttl = record && record.prov && record.prov.ttl_s;
    return typeof ttl === "number" && ttl > 0 && observed(record) + ttl * 1000 < Date.now();
  }
  /**
   * Run the intent that produced a record again, with the same params (prov.intent). Returns the new id, or null
   * when there is nothing to re-send or the binder withheld params (a viewer's position): ask for them again.
   */
  function retry(record, opts) {
    var src = record && record.prov && record.prov.intent;
    if (!src || !src.name) return null;
    if (Array.isArray(src.withheld) && src.withheld.length) return null;
    var params = Object.assign({}, src.params || {});
    return intent(src.name, params, Object.assign({ ref: typeof params.ref === "string" ? params.ref : record.ref || null }, opts || {}));
  }

  // ---- connection
  function finishReady(extra) {
    var list = (catalog || []).slice();
    list.forEach(function (def) { Object.defineProperty(list, def.name, { value: def, enumerable: false, configurable: true }); });
    var byName = {};
    list.forEach(function (def) { byName[def.name] = def; });
    resolveReady(Object.assign({ intents: list, byName: byName, names: list.map(function (d) { return d.name; }) }, extra));
  }
  function getJson(url) {
    return fetch(url, { cache: "no-store", headers: authHeaders(), credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; });
  }
  function loadRecords() {
    return getJson(base + "records").then(function (body) {
      if (!body) return;
      if (typeof body.v === "number") lastVersion = Math.max(lastVersion, body.v);
      ingestRecords(body.records, "load");
    }).catch(function () {});
  }
  function loadStaticRecords() {
    // No binder (a static snapshot): load the records files bound.json and version.json name.
    var files = {};
    return Promise.all([
      getJson(siteRoot + "bound.json").catch(function () { return null; }),
      getJson(siteRoot + "data/version.json").catch(function () { return null; })
    ]).then(function (both) {
      var bound = both[0], version = both[1];
      if (bound && Array.isArray(bound.parentOrigins)) setParentOrigins(bound.parentOrigins);
      if (bound && bound.results && Array.isArray(bound.results.files)) bound.results.files.forEach(function (f) { files[f] = 1; });
      if (bound && bound.intents) Object.keys(bound.intents).forEach(function (n) { var t = bound.intents[n].target; files[(t && t.records) || "data/records/" + n + ".json"] = 1; });
      if (version && version.files) Object.keys(version.files).forEach(function (f) { files[f] = 1; });
      return Promise.all(Object.keys(files).filter(function (f) { return /^data\/records\/[A-Za-z0-9_.-]+\.json$/.test(f); }).map(function (f) {
        return getJson(siteRoot + f).then(function (body) {
          if (body && body.schema === "instafy.records@1") ingestRecords(body.records, "static");
        }).catch(function () {});
      }));
    });
  }
  function openEvents(queryToken) {
    if (typeof EventSource !== "function") return;
    // The session cookie authenticates the stream; ?k= only when the browser refused the cookie.
    var es = new EventSource(base + "events" + (queryToken ? "?k=" + encodeURIComponent(queryToken) : ""), { withCredentials: false });
    HOST_TYPES.forEach(function (type) {
      es.addEventListener(type, function (e) {
        try { handleHost(JSON.parse(e.data), "sse"); } catch (err) { /* malformed frame */ }
      });
    });
    es.onopen = function () { sseOpen = true; };
    es.onerror = function () { sseOpen = false; };
    api._events = es;
  }
  function startSession() {
    if (!token) return Promise.resolve(false);
    return fetch(base + "session", { method: "POST", headers: authHeaders(), credentials: "same-origin" })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }
  function poll() {
    var delay = pending.size ? 3000 : 30000;
    setTimeout(function () {
      if (sseOpen || document.hidden || !hostReady) return poll();
      getJson(siteRoot + "data/version.json").then(function (v) {
        if (!v) return;
        if (v.jobs) Object.keys(v.jobs).forEach(function (id) {
          if (pending.has(id) && (v.jobs[id] === "done" || v.jobs[id] === "error")) {
            handleHost({ source: "instafy-host", v: 2, type: v.jobs[id], id: id, error: v.jobs[id] === "error" ? { code: "upstream", message: "See the binder log" } : undefined }, "poll");
          }
        });
        if (typeof v.v === "number" && v.v > lastVersion) { lastVersion = v.v; return loadRecords(); }
      }).catch(function () {}).then(poll);
    }, delay);
  }

  // ---- parent frame: only the origins the binder lists (bound.json parentOrigins, and in a preview the Studio that
  // opened it), else this page's own origin. Nobody else, however it frames the page, is its host.
  function setParentOrigins(list) {
    if (parentOrigins) return;
    parentOrigins = (Array.isArray(list) ? list : []).filter(function (o) { return typeof o === "string" && /^https?:\/\/[^\s\/]+$/.test(o); });
    if (parentOrigins.indexOf(location.origin) < 0) parentOrigins.push(location.origin);
    var queued = parentQueue;
    parentQueue = [];
    queued.forEach(onParentMessage);
  }
  function onParentMessage(e) {
    if (!parentOrigins) { if (parentQueue.length < 50) parentQueue.push(e); return; }
    if (e.data.v === 1) return onHostV1(e);
    if (parentOrigins.indexOf(e.origin) < 0) return;
    var data = e.data;
    if (data.type === "hello") parentOrigin = e.origin;
    handleHost(data, "parent");
  }
  window.addEventListener("message", function (e) {
    if (window.parent === window || e.source !== window.parent) return;
    var data = e.data;
    if (!data || data.source !== "instafy-host") return;
    onParentMessage(e);
  });

  // ---- location. Inside Studio only Studio calls the browser's geolocation: one prompt for Instafy, and Studio
  // shows which site got the position. A host that says so in its layout (caps.location === "host") answers
  // {source:"instafy-bind", v:1, type:"location-request", payload:{id, watch?, highAccuracy?}} with "location",
  // "location-error" and "location-stop" messages; anywhere else the page asks navigator.geolocation itself.
  var LOCATION_MESSAGES = {
    denied: "Location is blocked. Allow it in the browser's settings, then try again.",
    unavailable: "Your location is not available right now.",
    timeout: "Finding your location took too long. Try again.",
    stopped: "Location is off for this site · turn it on in Studio's menu for this preview.",
    framed: "Location is not available in this preview yet.",
    hidden: "This page is not on screen, so it gets no location."
  };
  var LAYOUT_WAIT_MS = 2000; // framed with ?instafy_host=: how long location() waits for the host's first layout
  var HOST_ANSWER_MS = 90000; // a one-shot request the host never answers (the person may be reading a prompt)
  var hostQuery = /[?&]instafy_host=[a-z]/.test(location.search || "");
  var hostLayout = null; // the last layout from the host frame (v1), {caps, insets, chrome, title, theme}
  var hostOrigin = null; // the origin that sent the first layout keeps the frame
  var layoutWaiters = [];
  var locationRequests = new Map(); // id -> {position(p), fail(code), end()}

  function embedded() { try { return window.parent !== window; } catch (e) { return true; } }
  function hostV1OriginOk(origin) {
    if (!origin || origin === "null" || !parentOrigins) return false;
    if (hostOrigin) return origin === hostOrigin;
    if (parentOrigins.indexOf(origin) < 0) return false;
    // where the browser names the frame's parent (ancestorOrigins), it must be the sender too
    var anc = location.ancestorOrigins;
    return !(anc && anc.length && anc[0] && anc[0] !== "null" && anc[0] !== origin);
  }
  // Studio answered "denied": Instafy itself may not use location, and Studio shows where to change that.
  var HOST_DENIED_MESSAGE = "Location is blocked for Instafy. Studio shows how to turn it on.";
  function locationError(code, fromHost) {
    if (!LOCATION_MESSAGES[code]) code = "unavailable";
    var text = fromHost && code === "denied" ? HOST_DENIED_MESSAGE : LOCATION_MESSAGES[code];
    // framed by a page that offers no location: the browser would refuse the frame, and its "allow it in your
    // settings" would send the person to fix the wrong thing. Pages see code "unavailable".
    if (code === "framed") code = "unavailable";
    var err = new Error(text);
    err.name = "LocationError";
    err.code = code;
    return err;
  }
  function num(v, min, max) { return typeof v === "number" && isFinite(v) && v >= min && v <= max ? v : null; }
  function readPosition(raw, via) {
    var c = raw && raw.coords;
    if (!c || typeof c !== "object") return null;
    var lat = num(c.latitude, -90, 90), lng = num(c.longitude, -180, 180);
    if (lat == null || lng == null) return null;
    lastFix = { lat: lat, lng: lng, at: Date.now() };
    return {
      coords: {
        latitude: lat, longitude: lng, accuracy: num(c.accuracy, 0, 1e7),
        altitude: num(c.altitude, -1e5, 1e6), heading: num(c.heading, 0, 360), speed: num(c.speed, 0, 1e4)
      },
      timestamp: num(raw.timestamp, 0, 1e15) || Date.now(),
      via: via
    };
  }
  function onHostV1(e) {
    var d = e.data;
    if (!hostV1OriginOk(e.origin)) return;
    if (d.type === "layout") {
      hostOrigin = e.origin;
      var caps = d.caps && typeof d.caps === "object" ? d.caps : {};
      hostLayout = {
        caps: {
          geolocation: caps.geolocation === true, location: caps.location === "host" ? "host" : null,
          ask: caps.ask === true ? true : typeof caps.ask === "string" && caps.ask.trim() ? caps.ask.trim().slice(0, 140) : null
        },
        insets: d.insets && typeof d.insets === "object" ? d.insets : null,
        chrome: d.chrome === "host" ? "host" : null,
        title: d.title === "shown" || d.title === "hidden" ? d.title : null,
        theme: d.theme === "light" || d.theme === "dark" ? d.theme : null
      };
      applyHostLook(hostLayout);
      syncAsks();
      var waiting = layoutWaiters;
      layoutWaiters = [];
      waiting.forEach(function (fn) { fn(); });
      emit("layout", hostLayout);
      // follow mode: tell the host this page can share and apply its view. No "insets": Studio keeps padding the frame.
      if (viewOn) toHost("layout-ack", { v: 1, supports: ["view", "tap"] });
      return;
    }
    if (d.type === "present" || d.type === "apply-view" || d.type === "apply-tap") return onFollow(d);
    if (d.type === "ask-status") return onAskStatus(d.payload && typeof d.payload === "object" ? d.payload : {});
    // location answers: hostV1OriginOk held them to the origin that sent the layout, and ids are only ever sent there
    var p = d.payload && typeof d.payload === "object" ? d.payload : {};
    var req = typeof p.id === "string" ? locationRequests.get(p.id) : null;
    if (!req) return;
    if (d.type === "location") {
      var pos = readPosition(p, "host");
      if (pos) req.position(pos);
    } else if (d.type === "location-error") {
      req.fail(typeof p.code === "string" ? p.code : "unavailable", true);
    } else if (d.type === "location-stop") {
      req.end();
    }
  }
  // Studio's look on <html>: data-theme="light|dark" (theme.css reads it; a page with data-theme-fixed keeps its own)
  // and data-host-title="shown" while Studio's bar shows the page title (theme.css then hides the page's own h1).
  function applyHostLook(l) {
    var root = document.documentElement;
    if (!root || typeof root.setAttribute !== "function") return;
    if (l.theme && !root.hasAttribute("data-theme-fixed")) root.setAttribute("data-theme", l.theme);
    if (l.title === "shown") root.setAttribute("data-host-title", "shown");
    else if (l.title === "hidden") root.removeAttribute("data-host-title");
  }
  function toHost(type, payload) {
    if (!hostOrigin || !embedded()) return false;
    try { window.parent.postMessage({ source: "instafy-bind", v: 1, type: type, payload: payload }, hostOrigin); return true; } catch (e) { return false; }
  }
  /**
   * "host" when the frame's host answers location requests; "browser" on a page of its own, or in a frame whose host
   * says the frame may ask the browser (caps.geolocation); else "framed" (no host offers it here). Waits briefly for a
   * host's first layout.
   */
  function locationRoute() {
    function decide() {
      if (!embedded()) return "browser";
      if (hostLayout && hostLayout.caps.location === "host") return "host";
      return hostLayout && hostLayout.caps.geolocation ? "browser" : "framed";
    }
    if (hostLayout || !embedded() || !hostQuery) return Promise.resolve(decide());
    return new Promise(function (resolve) {
      var done = function () { clearTimeout(timer); resolve(decide()); };
      var timer = setTimeout(function () {
        var i = layoutWaiters.indexOf(done);
        if (i >= 0) layoutWaiters.splice(i, 1);
        resolve(decide());
      }, LAYOUT_WAIT_MS);
      layoutWaiters.push(done);
    });
  }
  function locationId() {
    return "loc_" + rand36(6);
  }
  function browserCode(err) { return err && err.code === 1 ? "denied" : err && err.code === 3 ? "timeout" : "unavailable"; }
  function browserPosition(p) {
    var c = p && p.coords;
    return c ? readPosition({ coords: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, altitude: c.altitude, heading: c.heading, speed: c.speed }, timestamp: p.timestamp }, "browser") : null;
  }
  function geoOptions(opts) {
    var o = { enableHighAccuracy: !!opts.highAccuracy };
    if (typeof opts.timeout === "number") o.timeout = opts.timeout;
    if (typeof opts.maximumAge === "number") o.maximumAge = opts.maximumAge;
    return o;
  }
  function geo() { return (window.navigator || {}).geolocation || null; }

  function locateOnce(opts) {
    return locationRoute().then(function (via) {
      return new Promise(function (resolve, reject) {
        if (via === "framed") return reject(locationError("framed"));
        if (via === "browser") {
          var g = geo();
          if (!g) return reject(locationError("unavailable"));
          return g.getCurrentPosition(function (p) {
            var pos = browserPosition(p);
            pos ? resolve(pos) : reject(locationError("unavailable"));
          }, function (err) { reject(locationError(browserCode(err))); }, geoOptions(opts));
        }
        var id = locationId();
        var finish = function () { clearTimeout(timer); locationRequests.delete(id); };
        var timer = setTimeout(function () { finish(); toHost("location-stop", { id: id }); reject(locationError("timeout")); },
          typeof opts.timeout === "number" ? opts.timeout : HOST_ANSWER_MS);
        locationRequests.set(id, {
          position: function (pos) { finish(); resolve(pos); },
          fail: function (code, fromHost) { finish(); reject(locationError(code, fromHost)); },
          end: function () { finish(); reject(locationError("stopped")); }
        });
        var payload = { id: id };
        if (opts.highAccuracy) payload.highAccuracy = true;
        if (!toHost("location-request", payload)) { finish(); reject(locationError("unavailable")); }
      });
    });
  }

  /** A watch: callbacks, and an async iterator of positions (the latest unread one is kept). */
  function watchLocation(opts, onPosition, onError) {
    var stopped = false, ended = false, via = null, geoWatch = null, id = null;
    var latest = null, failure = null, waiter = null, located = false;
    function settle() {
      if (!waiter) return;
      var w = waiter;
      if (latest) { waiter = null; var p = latest; latest = null; w.resolve({ value: p, done: false }); }
      else if (failure) { waiter = null; var err = failure; failure = null; w.reject(err); }
      else if (ended) { waiter = null; w.resolve({ value: undefined, done: true }); }
    }
    function position(pos) {
      if (ended) return;
      located = true;
      latest = pos;
      if (onPosition) { try { onPosition(pos); } catch (e) { console.error("[instafy-bind] location callback failed", e); } }
      settle();
    }
    function fail(code, fromHost) {
      if (ended) return;
      var err = locationError(code, fromHost);
      if (onError) { try { onError(err); } catch (e) { console.error("[instafy-bind] location error callback failed", e); } }
      // every error the page hears ends the watch (Studio's broker sends only final ones); a page that wants to
      // retry calls location() again
      failure = err;
      if (geoWatch != null) { var g = geo(); if (g) g.clearWatch(geoWatch); geoWatch = null; }
      end();
    }
    function end() {
      if (ended) return;
      ended = true;
      if (id) locationRequests.delete(id);
      settle();
    }
    var handle = {
      get via() { return via; },
      get active() { return !ended; },
      stop: function () {
        if (stopped) return;
        stopped = true;
        if (via === "host" && id && !ended) toHost("location-stop", { id: id });
        if (geoWatch != null) { var g = geo(); if (g) g.clearWatch(geoWatch); geoWatch = null; }
        end();
      },
      next: function () {
        return new Promise(function (resolve, reject) { waiter = { resolve: resolve, reject: reject }; settle(); });
      },
      "return": function () { handle.stop(); return Promise.resolve({ value: undefined, done: true }); }
    };
    if (typeof Symbol === "function" && Symbol.asyncIterator) handle[Symbol.asyncIterator] = function () { return handle; };
    locationRoute().then(function (route) {
      if (stopped) return;
      via = route;
      if (route === "framed") { fail("framed"); return; }
      if (route === "browser") {
        var g = geo();
        if (!g) { fail("unavailable"); return; }
        geoWatch = g.watchPosition(function (p) { var pos = browserPosition(p); if (pos) position(pos); },
          function (err) {
            // the browser keeps a watch running after "unavailable" or "timeout" (a moved position, a weak signal):
            // once it has found the person, only a refusal ends it
            var code = browserCode(err);
            if (located && code !== "denied") return;
            fail(code);
          }, geoOptions(opts));
        return;
      }
      id = locationId();
      locationRequests.set(id, { position: position, fail: fail, end: end });
      var payload = { id: id, watch: true };
      if (opts.highAccuracy) payload.highAccuracy = true;
      if (!toHost("location-request", payload)) fail("unavailable");
    });
    return handle;
  }

  /**
   * The viewer's position. location({highAccuracy?, timeout?}) → Promise<{coords, timestamp, via}>, rejecting with an
   * Error whose code is denied | unavailable | timeout | stopped | hidden and whose message is fit to show.
   * location({watch: true, onPosition?, onError?}) (or location({watch: true}, onPosition, onError)) → a handle with
   * stop(), via and active, that is also an async iterator: `for await (const pos of watch) …`. Any error ends a watch
   * (the iterator rejects once); Studio pauses it, silently, while the page is hidden.
   */
  function locate(opts, onPosition, onError) {
    opts = opts && typeof opts === "object" ? opts : {};
    if (opts.watch) return watchLocation(opts, typeof opts.onPosition === "function" ? opts.onPosition : onPosition, typeof opts.onError === "function" ? opts.onError : onError);
    return locateOnce(opts);
  }
  window.addEventListener("pagehide", function () {
    locationRequests.forEach(function (_, id) { toHost("location-stop", { id: id }); });
  });


  // ---- follow mode. Studio → page: present {on, share:{location}}, apply-view {seq, payload, from,
  // smooth}, apply-tap {payload, from}; page → Studio: view {seq, payload} (≤ 2 KB, ≤ 10/s, the latest wins, with a
  // trailing send), tap {seq, payload:{x, y, at}}, interact (the person's own wheel, touch or keys). Only between the
  // page and the host that sent the layout; a presenting page never applies views, so nothing echoes.
  var VIEW_MAX_BYTES = 2048, VIEW_GAP_MS = 100, VIEW_POLL_MS = 500, TAP_GAP_MS = 200, INTERACT_GAP_MS = 300, QUIET_MS = 400;
  var HOST_PARAMS = ["instafy_host"];
  var viewOn = cfg.view !== false;
  var presenting = false, shareLocation = false, viewSeq = 0, lastView = null, lastViewAt = -Infinity, viewTimer = null, viewPoll = null;
  var following = false, touchedAt = -Infinity, lastInteract = -Infinity, lastTap = -Infinity;
  var custom = { get: null, apply: null, auto: true, locationFree: false };
  // the position location() handed this page: kept out of views unless the presenter shares it, for as long as this
  // page lives (it may still hold it in its URL or state), not for a fixed time
  var lastFix = null;
  function now() { return Date.now(); }
  function bytes(o) { try { return new TextEncoder().encode(JSON.stringify(o)).length; } catch (e) { return Infinity; } }
  function later(fn) { if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { requestAnimationFrame(fn); }); else setTimeout(fn, 32); }
  function sendFollow(msg) {
    if (!hostOrigin || !embedded()) return false;
    try { window.parent.postMessage(msg, hostOrigin); return true; } catch (e) { return false; }
  }
  /** the query's parts, as written (no re-encoding) */
  function queryParts(search) { return String(search || "").replace(/^\?/, "").split("&").filter(Boolean); }
  function isHostPart(part) { var k = part.split("=")[0]; try { k = decodeURIComponent(k); } catch (e) { /* */ } return HOST_PARAMS.indexOf(k) >= 0; }
  /** the query without the host's own markers (?instafy_host=studio): every viewer has those */
  function cleanSearch(search) {
    var parts = queryParts(search).filter(function (x) { return !isHostPart(x); });
    return parts.length ? "?" + parts.join("&") : "";
  }
  /** a presenter's query with this frame's own host markers kept */
  function withHostParams(search) {
    var parts = queryParts(cleanSearch(search)).concat(queryParts(location.search).filter(isHostPart));
    return parts.length ? "?" + parts.join("&") : "";
  }
  function scrollMax() {
    var d = document.documentElement || {}, b = document.body || {};
    return Math.max(0, Math.max(d.scrollHeight || 0, b.scrollHeight || 0) - (window.innerHeight || 0));
  }
  function scrollTop() { return window.scrollY || window.pageYOffset || 0; }
  /** fixed or sticky, itself or inside such an element: it sits in the same place whatever the scroll, so it can't say where the page is */
  function pinned(el) {
    if (typeof window.getComputedStyle !== "function") return false;
    for (var n = el, i = 0; n && i < 40 && n !== document.body && n !== document.documentElement; n = n.parentElement, i++) {
      var pos = "";
      try { pos = window.getComputedStyle(n).position; } catch (e) { /* */ }
      if (pos === "sticky" || pos === "fixed") return true;
    }
    return false;
  }
  /** the nearest element (the anchor itself or one around it) that scrolls sideways: a wide table on a phone */
  function sideScroller(el) {
    if (!el || typeof window.getComputedStyle !== "function") return null;
    for (var n = el, i = 0; n && i < 40 && n !== document.body && n !== document.documentElement; n = n.parentElement, i++) {
      if (!(n.scrollWidth > n.clientWidth + 1)) continue;
      var ox = "";
      try { ox = window.getComputedStyle(n).overflowX; } catch (e) { /* */ }
      if (ox === "auto" || ox === "scroll") return n;
    }
    return null;
  }
  /**
   * The element with an id at the top of the window (a row, a section) and where the window's top is in its heights:
   * 0..1 inside it, negative when it starts below the top. Sticky and fixed elements (a toolbar with a filter) never
   * count. At the very top of the page there is no anchor: the scroll position (0) says it all.
   */
  function anchorNow() {
    if (scrollTop() < 1) return null;
    var list = document.querySelectorAll ? document.querySelectorAll("[id]") : [];
    var H = window.innerHeight || 0, cross = [], below = [];
    for (var i = 0; i < list.length && i < 3000; i++) {
      var el = list[i];
      if (!el.id || el === document.documentElement || el === document.body || /^instafy-bind/.test(el.id)) continue;
      var r = el.getBoundingClientRect();
      if (!r || !r.height || r.bottom <= 0 || r.top >= H) continue;
      (r.top <= 0 ? cross : below).push({ el: el, r: r });
    }
    cross.sort(function (x, y) { return x.r.height - y.r.height; });
    below.sort(function (x, y) { return x.r.top - y.r.top; });
    var all = cross.concat(below);
    for (var j = 0; j < all.length && j < 50; j++) {
      var hit = all[j];
      if (pinned(hit.el)) continue;
      var o = Math.max(-1000, Math.min(1, -hit.r.top / hit.r.height));
      return { el: hit.el, a: String(hit.el.id).slice(0, 100), o: Math.round(o * 1000) / 1000 };
    }
    return null;
  }
  function numbersIn(text) { return (String(text).match(/-?\d{1,3}\.\d{3,}/g) || []).map(Number); }
  /** does the payload carry the position this page was given (lat and lng to 4 decimals, about 11 m)? */
  function hasFix(p) {
    if (shareLocation || !lastFix) return false;
    var n = numbersIn(JSON.stringify(p));
    var near = function (v) { return n.some(function (x) { return Math.abs(x - v) < 0.0001; }); };
    return near(lastFix.lat) && near(lastFix.lng);
  }
  function viewNow() {
    var p = { k: "page" };
    if (custom.auto) {
      var h = String(location.hash || "");
      p.path = String(location.pathname || "/");
      p.q = cleanSearch(location.search);
      p.h = h.length > 1 ? h : "";
      var a = anchorNow();
      if (a) {
        p.a = a.a; p.o = a.o;
        var side = sideScroller(a.el), wide = side ? side.scrollWidth - side.clientWidth : 0;
        if (wide > 0) p.sx = Math.round(Math.min(1, Math.max(0, side.scrollLeft / wide)) * 10000) / 10000;
      }
      var max = scrollMax();
      p.sy = max ? Math.round(Math.min(1, Math.max(0, scrollTop() / max)) * 10000) / 10000 : 0;
    }
    if (custom.get) {
      try { var s = custom.get(); if (s !== undefined) p.s = JSON.parse(JSON.stringify(s)); } catch (e) { console.warn("[instafy-bind] follow get() failed", e); }
    }
    // the viewer's own position stays home. Once this page was given one, the address and the page's own state may hold
    // it in any form (rounded, a geohash, custom state), so they go unless the presenter shares location or the page
    // said its view never holds it (follow({locationFree: true})); the scroll position stays
    if (lastFix && !shareLocation && !custom.locationFree) {
      if (p.q || p.h || "s" in p) p.withheld = ["location"];
      delete p.q; delete p.h; delete p.s;
    }
    if (hasFix(p)) { delete p.q; delete p.h; delete p.s; p.withheld = ["location"]; if (hasFix(p)) return null; }
    // ≤ 2 KB: the hash first, then the query, then the page's own state
    ["h", "q", "s"].forEach(function (k) { if (bytes(p) > VIEW_MAX_BYTES && k in p) { delete p[k]; p.trimmed = true; } });
    return bytes(p) <= VIEW_MAX_BYTES ? p : null;
  }
  function flushView() {
    if (!presenting) return false;
    if (viewTimer) { clearTimeout(viewTimer); viewTimer = null; }
    var p = viewNow();
    if (!p) return false;
    var key = JSON.stringify(p);
    if (key === lastView) return false;
    lastView = key; lastViewAt = now();
    return sendFollow({ source: "instafy-bind", v: 1, type: "view", seq: ++viewSeq, payload: p });
  }
  /** the view may have changed: send it, at most every 100 ms (the latest wins, with a trailing send) */
  function viewChanged() {
    if (!presenting || viewTimer) return;
    var wait = VIEW_GAP_MS - (now() - lastViewAt);
    if (wait <= 0) { flushView(); return; }
    viewTimer = setTimeout(function () { viewTimer = null; flushView(); }, wait);
  }
  function stopPresenting() {
    presenting = false; lastView = null;
    if (viewTimer) { clearTimeout(viewTimer); viewTimer = null; }
    if (viewPoll) { clearInterval(viewPoll); viewPoll = null; }
  }
  function onFollow(d) {
    if (!viewOn) return;
    if (d.type === "present") {
      if (d.on === true) {
        presenting = true; following = false; lastView = null;
        shareLocation = !!(d.share && d.share.location === true);
        // a page that changes its query with replaceState fires no event: look again twice a second
        if (!viewPoll) viewPoll = setInterval(viewChanged, VIEW_POLL_MS);
        flushView();
      } else stopPresenting();
      emit("present", { on: presenting, share: { location: shareLocation } });
      return;
    }
    if (presenting) return; // a presenter never follows, so nothing echoes
    var from = d.from && typeof d.from === "object" && typeof d.from.name === "string" ? { name: d.from.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 40) } : null;
    if (d.type === "apply-view") {
      var smooth = d.smooth !== false;
      if (smooth && now() - touchedAt < QUIET_MS) return; // one already in flight must not yank the person's own scroll
      var p = d.payload;
      if (!p || typeof p !== "object" || p.k !== "page" || bytes(p) > VIEW_MAX_BYTES) return;
      following = true;
      applyView(p, smooth, from);
      return;
    }
    if (d.type === "apply-tap") showRipple(d.payload, from);
  }
  /**
   * A presenter's path, only as a path of this same site: anything that would leave it (//host, /\\host, a tab or
   * newline the URL parser drops, a scheme) keeps the follower where it is.
   */
  function samePath(path) {
    if (typeof path !== "string" || path.length > 1024 || path.charAt(0) !== "/" || path.charAt(1) === "/" || /[\\\u0000-\u001f\u007f]/.test(path)) return location.pathname;
    try {
      var u = new URL(path, location.href);
      return u.origin === location.origin ? u.pathname : location.pathname;
    } catch (e) { return location.pathname; }
  }
  function applyView(p, smooth, from) {
    if (typeof p.path === "string" || typeof p.q === "string" || typeof p.h === "string") {
      var path = samePath(p.path);
      // the presenter's address: no query or hash in the view means none
      var q = withHostParams(typeof p.q === "string" ? p.q : "");
      var h = typeof p.h === "string" && p.h ? (p.h.charAt(0) === "#" ? p.h : "#" + p.h) : "";
      if (path + q + h !== location.pathname + location.search + location.hash) {
        // another page of a multi-page site: go there (the next view finds it); a single-page app re-renders on popstate
        if (path !== location.pathname && !custom.apply) {
          try { var to = new URL(path + q + h, location.href); if (to.origin === location.origin) location.replace(to.pathname + to.search + to.hash); } catch (e) { /* */ }
          return;
        }
        var hashOnly = path === location.pathname && q === location.search;
        try {
          history.replaceState(history.state, "", path + q + h);
          window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
          if (hashOnly) window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (e) { console.warn("[instafy-bind] apply view:", e && e.message); }
      }
    }
    if (custom.apply && "s" in p) { try { custom.apply(p.s, { from: from, smooth: smooth }); } catch (e) { console.warn("[instafy-bind] follow apply() failed", e); } }
    emit("view", { payload: p, from: from, smooth: smooth });
    if (p.a == null && typeof p.sy !== "number") return;
    // after the page re-rendered the new query: the same row at the top, else the same share of the page
    later(function () {
      var el = typeof p.a === "string" && document.getElementById ? document.getElementById(p.a) : null, top = null;
      if (el) { var r = el.getBoundingClientRect(); top = scrollTop() + r.top + (typeof p.o === "number" ? p.o : 0) * r.height; }
      else if (typeof p.sy === "number") top = p.sy * scrollMax();
      if (top != null && typeof window.scrollTo === "function") window.scrollTo({ top: Math.max(0, Math.round(top)), behavior: smooth ? "smooth" : "auto" });
      // the same columns of a wide table that scrolls sideways
      var side = el && typeof p.sx === "number" ? sideScroller(el) : null, wide = side ? side.scrollWidth - side.clientWidth : 0;
      if (wide > 0) side.scrollLeft = Math.round(Math.min(1, Math.max(0, p.sx)) * wide);
    });
  }
  var RIPPLE_CSS = ".instafy-bind-ripple{position:fixed;width:0;height:0;pointer-events:none;z-index:2147483646}" +
    ".instafy-bind-ripple i{position:absolute;left:-22px;top:-22px;width:44px;height:44px;box-sizing:border-box;border-radius:50%;" +
    "border:3px solid var(--bind-ripple,#2563eb);animation:instafy-bind-ripple 1.2s ease-out forwards}" +
    ".instafy-bind-ripple span{position:absolute;left:0;top:26px;transform:translateX(-50%);white-space:nowrap;padding:2px 8px;" +
    "border-radius:999px;background:var(--bind-ripple,#2563eb);color:#fff;font:600 12px/1.4 system-ui,sans-serif}" +
    "@keyframes instafy-bind-ripple{from{transform:scale(.35);opacity:1}to{transform:scale(1.6);opacity:0}}" +
    "@media (prefers-reduced-motion:reduce){.instafy-bind-ripple i{animation:none;opacity:.8}}";
  /** the presenter tapped: a ring with their name for 1.2 s, on the same element when this page has it */
  function showRipple(t, from) {
    if (!t || typeof t !== "object" || !document.createElement) return;
    var x = null, y = null;
    var at = t.at && typeof t.at === "object" ? t.at : null;
    var el = at && typeof at.id === "string" && document.getElementById ? document.getElementById(at.id) : null;
    if (el) { var r = el.getBoundingClientRect(); x = r.left + (num(at.fx, 0, 1) || 0) * r.width; y = r.top + (num(at.fy, 0, 1) || 0) * r.height; }
    else if (num(t.x, 0, 1) != null && num(t.y, 0, 1) != null) { x = t.x * (window.innerWidth || 0); y = t.y * (window.innerHeight || 0); }
    if (x == null) return;
    if (!document.getElementById("instafy-bind-ripple-style")) {
      var style = document.createElement("style");
      style.id = "instafy-bind-ripple-style";
      style.textContent = RIPPLE_CSS;
      document.head.appendChild(style);
    }
    var ring = document.createElement("div");
    ring.className = "instafy-bind-ripple";
    ring.setAttribute("aria-hidden", "true");
    ring.style.left = Math.round(x) + "px"; ring.style.top = Math.round(y) + "px";
    ring.appendChild(document.createElement("i"));
    if (from && from.name) { var label = document.createElement("span"); label.textContent = from.name; ring.appendChild(label); }
    document.body.appendChild(ring);
    setTimeout(function () { ring.remove(); }, 1200);
  }
  function ownGesture(e) {
    if (!e || e.isTrusted === false) return false;
    if (e.type === "keydown") return !(e.metaKey || e.ctrlKey || e.altKey) && ["Shift", "Control", "Alt", "Meta", "F6", "Tab", "CapsLock"].indexOf(e.key) < 0;
    return true;
  }
  function onGesture(e) {
    if (!ownGesture(e)) return;
    var t = now();
    touchedAt = t;
    if (!following || presenting || t - lastInteract < INTERACT_GAP_MS) return;
    lastInteract = t;
    sendFollow({ source: "instafy-bind", v: 1, type: "interact" });
  }
  function onTap(e) {
    if (!presenting || !e || e.isTrusted === false || typeof e.clientX !== "number") return;
    var t = now();
    if (t - lastTap < TAP_GAP_MS) return;
    var target = e.target && e.target.closest ? e.target : null;
    // a site marks what shows the viewer's own position with data-instafy-private: a tap there is not shared
    if (target && !shareLocation && target.closest("[data-instafy-private]")) return;
    var W = window.innerWidth || 1, H = window.innerHeight || 1, r3 = function (v) { return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000; };
    var payload = { x: r3(e.clientX / W), y: r3(e.clientY / H) };
    var host = target && target.closest("[id]");
    if (host && host !== document.body && host !== document.documentElement) {
      var r = host.getBoundingClientRect();
      if (r && r.width && r.height) payload.at = { id: String(host.id).slice(0, 100), fx: r3((e.clientX - r.left) / r.width), fy: r3((e.clientY - r.top) / r.height) };
    }
    lastTap = t;
    sendFollow({ source: "instafy-bind", v: 1, type: "tap", seq: ++viewSeq, payload: payload });
  }
  if (viewOn && document.addEventListener) {
    ["pointerdown", "wheel", "touchstart", "keydown"].forEach(function (type) { document.addEventListener(type, onGesture, { capture: true, passive: true }); });
    ["pointermove", "touchmove"].forEach(function (type) {
      document.addEventListener(type, function (e) { if (e.isTrusted !== false && (e.type === "touchmove" || e.buttons)) touchedAt = now(); }, { capture: true, passive: true });
    });
    document.addEventListener("click", onTap, { capture: true, passive: true });
    ["resize", "popstate", "hashchange"].forEach(function (type) { window.addEventListener(type, viewChanged, { passive: true }); });
    // capture: a table scrolled sideways scrolls an element, and element scrolls don't bubble
    window.addEventListener("scroll", viewChanged, { passive: true, capture: true });
  }
  /**
   * Share more than the address and scroll position: get() returns this page's own view state (JSON, small), apply(state,
   * {from, smooth}) shows a presenter's. {auto: false} leaves out the address and scroll. Returns {changed(), stop()}.
   */
  function follow(o) {
    o = o || {};
    custom.get = typeof o.get === "function" ? o.get : null;
    custom.apply = typeof o.apply === "function" ? o.apply : null;
    custom.auto = o.auto !== false;
    custom.locationFree = o.locationFree === true;
    viewChanged();
    return { changed: viewChanged, stop: function () { custom.get = null; custom.apply = null; custom.auto = true; custom.locationFree = false; } };
  }

  var api = {
    version: "0.2.0",
    ready: ready,
    base: base,
    intent: intent,
    cancel: cancel,
    on: on,
    records: function (ref) { return allRecords(ref); },
    pending: function () { return Array.from(pending.keys()); },
    pendingInfo: function (id) { var p = pending.get(id) || active.get(id); return p ? Object.assign({}, p, { cancelKey: undefined, timer: undefined }) : null; },
    /** Running intents of every viewer: [{id, name, ref, status, mine}]. */
    active: function () { return Array.from(active.values()).map(function (a) { return Object.assign({}, a); }); },
    isPending: isPending,
    age: ageSeconds,
    ageText: ageText,
    expired: expired,
    retry: retry,
    /** The binder's job list (debug view). */
    jobs: function () { return getJson(base + "jobs").then(function (b) { return (b && b.jobs) || []; }); },
    ingest: function (msg) { handleHost(msg, "api"); },
    /** The viewer's position, through the host frame when it offers that (Studio), else navigator.geolocation. */
    location: locate,
    /** The host frame's last layout ({caps, insets, chrome, title, theme}), or null when no host sent one. */
    get hostLayout() { return hostLayout ? JSON.parse(JSON.stringify(hostLayout)) : null; },
    /** The intents this binder runs, like `(await ready).names`; [] until the binder answers. Pages often read it directly. */
    get names() { return (catalog || []).map(function (d) { return d.name; }); },
    get connected() { return hostReady; },
    get hasToken() { return hasToken; },
    /** Follow mode: instafyBind.follow({get, apply, auto?}) for a page's own view state (see the header). */
    follow: follow,
    /** The same as parts: view.share(get), view.onApply(apply), view.changed() (send now), presenting / following. */
    view: {
      share: function (fn) { custom.get = typeof fn === "function" ? fn : null; viewChanged(); },
      onApply: function (fn) { custom.apply = typeof fn === "function" ? fn : null; },
      changed: function () { viewChanged(); },
      get presenting() { return presenting; },
      get following() { return following; }
    }
  };
  window.instafyBind = api;

  fetch(base + "health", { cache: "no-store", headers: authHeaders(), credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error("no binder"); return r.json(); })
    .then(function (health) {
      hostReady = true;
      setParentOrigins(health.parentOrigins);
      catalog = Array.isArray(health.catalog) ? health.catalog : (health.intents || []).map(function (name) { return { name: name }; });
      asks = (Array.isArray(health.asks) ? health.asks : []).filter(function (d) { return d && typeof d.name === "string"; });
      // Framed by a host (?instafy_host=): its first layout says whether it takes asks, so wait for it briefly.
      var layoutFirst = asks.length && embedded() && hostQuery && !hostLayout
        ? new Promise(function (resolve) {
          var done = function () { clearTimeout(timer); resolve(); };
          var timer = setTimeout(function () { var i = layoutWaiters.indexOf(done); if (i >= 0) layoutWaiters.splice(i, 1); resolve(); }, LAYOUT_WAIT_MS);
          layoutWaiters.push(done);
        })
        : null;
      return Promise.all([startSession(), layoutFirst]).then(function (both) {
        var cookieSet = both[0];
        syncAsks();
        hasToken = !health.token || cookieSet || !!health.viewer;
        finishReady({ connected: true, host: health.host, site: health.site, executors: health.executors, tokenRequired: !!health.token, hasToken: hasToken });
        openEvents(token && !cookieSet ? token : "");
        return loadRecords();
      });
    })
    .catch(function () {
      loadStaticRecords().then(function () { setParentOrigins([]); });
      // Without a binder, a parent hello (Studio pane) can still resolve ready; otherwise resolve as offline.
      setTimeout(function () { if (!catalog) { catalog = []; finishReady({ connected: false }); } }, 1500);
    })
    .then(poll);
})();
