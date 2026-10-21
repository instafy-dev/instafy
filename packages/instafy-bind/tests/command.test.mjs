import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanup, eventsUrl, intentMessage, makeSite, openSse, postIntent, simpleParams, startBinder } from "./helpers.mjs";

const HANDLER = `const kit = await import(process.env.BIND_KIT); await kit.readInput(); kit.done("ran");`;

function site() {
  return makeSite({
    "index.html": "x",
    "handlers/h.mjs": HANDLER,
    "bound.json": {
      version: 1,
      intents: {
        plain: { label: "Plain", params: simpleParams(), handler: "handlers/h.mjs" },
        careful: { label: "Careful", params: simpleParams(), handler: "handlers/h.mjs", confirm: true },
      },
    },
  });
}

const post = (binder, endpoint, body, headers = {}) =>
  fetch(`${binder.url}/__bind/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("commands need the admin token; viewers receive them over SSE", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const admin = fs.readFileSync(path.join(dir, ".bind/admin-token"), "utf8").trim();
    assert.equal(admin, binder.adminToken);
    assert.equal((fs.statSync(path.join(dir, ".bind/admin-token")).mode & 0o777).toString(8), "600");
    assert.equal((fs.statSync(path.join(dir, ".bind")).mode & 0o777).toString(8), "700");

    const command = { name: "highlight", args: { refs: ["products:a"], ms: 2000 } };
    assert.equal((await post(binder, "command", command)).status, 401, "no token");
    assert.equal((await post(binder, "command", command, { authorization: `Bearer ${binder.sites[0].token}` })).status, 401, "viewer token is not enough");
    assert.equal((await post(binder, "command", command, { "x-bind-token": binder.sites[0].token })).status, 401);
    assert.equal((await post(binder, "command", command, { authorization: "Bearer wrong-wrong-wrong-wrong" })).status, 401);
    assert.equal((await post(binder, "command", { name: "eval", args: {} }, { authorization: `Bearer ${admin}` })).status, 400, "only whitelisted names");
    assert.equal((await post(binder, "command", { name: "toast", args: [] }, { authorization: `Bearer ${admin}` })).status, 400);
    const ok = await post(binder, "command", command, { authorization: `Bearer ${admin}` });
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).viewers, 1);
    const event = await sse.waitFor((e) => e.event === "command");
    assert.deepEqual(event.data.command, command);
    assert.equal((await post(binder, "command", { name: "toast", args: { text: "x" } }, { "x-bind-admin": admin })).status, 202);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("confirm: needs_confirm jobs wait for the admin; decline gives error policy", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const a = intentMessage("careful", { name: "a" });
    const res = await postIntent(binder, a);
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "needs_confirm");
    assert.equal((await post(binder, "confirm", { job: res.body.job })).status, 401, "confirm needs the admin token");
    const confirmed = await post(binder, "confirm", { job: res.body.job }, { authorization: `Bearer ${binder.adminToken}` });
    assert.equal(confirmed.status, 200);
    await sse.waitFor((e) => e.event === "done" && e.data.id === a.id);

    const b = intentMessage("careful", { name: "b" });
    const rb = await postIntent(binder, b);
    await post(binder, "confirm", { job: rb.body.job, ok: false }, { authorization: `Bearer ${binder.adminToken}` });
    const error = await sse.waitFor((e) => e.event === "error" && e.data.id === b.id);
    assert.equal(error.data.error.code, "policy");
    assert.equal((await post(binder, "confirm", { job: "all" }, { authorization: `Bearer ${binder.adminToken}` })).status, 404);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("--confirm makes every intent wait", async () => {
  const dir = site();
  const binder = await startBinder(dir, { confirm: true });
  try {
    const res = await postIntent(binder, intentMessage("plain", { name: "a" }));
    assert.equal(res.body.status, "needs_confirm");
  } finally {
    await binder.close();
    cleanup(dir);
  }
});
