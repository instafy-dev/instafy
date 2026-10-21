// Test helpers: temp sites, a started binder, an SSE reader and intent messages.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createBinder } from "../src/server.mjs";
import { newIntentId } from "../src/protocol.mjs";

export const nowIso = () => new Date().toISOString();

/** Create a temp site folder from {relPath: string|object}. Objects are written as JSON. */
export function makeSite(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Start a binder on a free port with a clean environment (no Instafy login is picked up). */
export async function startBinder(root, options = {}) {
  const logs = [];
  const binder = createBinder({
    root,
    port: 0,
    env: {},
    log: (level, text) => logs.push({ level, text }),
    ...options,
  });
  await binder.listen();
  binder.logs = logs;
  return binder;
}

export function intentMessage(name, params, extra = {}) {
  return { source: "instafy-site", v: 2, type: "intent", id: newIntentId(), name, params, at: nowIso(), ...extra };
}

/** POST an intent with the site's token. */
export async function postIntent(binder, msg, { site = binder.sites[0], headers = {}, token = site.token } = {}) {
  const response = await fetch(`${binder.url}${site.prefix}/__bind/intent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-bind-token": token } : {}), ...headers },
    body: typeof msg === "string" ? msg : JSON.stringify(msg),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Minimal SSE reader. events: [{id, event, data}]. */
export function openSse(url, { lastEventId = null } = {}) {
  const events = [];
  const waiters = [];
  let buffer = "";
  const check = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const found = events.find(waiters[i].predicate);
      if (found) {
        waiters[i].resolve(found);
        waiters.splice(i, 1);
      }
    }
  };
  let request;
  const opened = new Promise((resolve, reject) => {
    request = http.get(url, { headers: lastEventId ? { "last-event-id": String(lastEventId) } : {} }, (res) => {
      if (res.statusCode !== 200) {
        reject(Object.assign(new Error(`SSE status ${res.statusCode}`), { status: res.statusCode }));
        res.resume();
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = { id: null, event: "message", data: null };
          for (const line of frame.split("\n")) {
            if (line.startsWith("id: ")) event.id = Number(line.slice(4));
            else if (line.startsWith("event: ")) event.event = line.slice(7);
            else if (line.startsWith("data: ")) event.data = JSON.parse(line.slice(6));
          }
          if (event.data) events.push(event);
        }
        check();
      });
      resolve();
    });
    request.on("error", reject);
  });
  return {
    events,
    opened,
    waitFor(predicate, timeoutMs = 5000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`SSE wait timed out; got ${events.map((e) => `${e.event}:${e.data?.status ?? e.data?.error?.code ?? ""}`).join(", ")}`));
          }
        }, timeoutMs);
      });
    },
    close() {
      request.destroy();
    },
  };
}

export function eventsUrl(binder, site = binder.sites[0]) {
  return `${binder.url}${site.prefix}/__bind/events${site.token ? `?k=${site.token}` : ""}`;
}

/** A params schema with one string. */
export const simpleParams = (extra = {}) => ({
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", maxLength: 40 }, ref: { type: "string", maxLength: 120 }, ...extra },
});

/** A claim record a handler might emit. */
export function claim(overrides = {}) {
  const { prov, ...rest } = overrides;
  return {
    type: "claim",
    cid: "clm_test",
    ref: "things:a",
    attr: "colour",
    value: "red",
    basis: "editorial",
    ...rest,
    prov: { source: "test", lane: "local", observed_at: nowIso(), ttl_s: 60, ...(prov || {}) },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
