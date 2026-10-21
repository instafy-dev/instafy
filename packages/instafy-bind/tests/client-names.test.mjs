// instafyBind.names: a generated page called instafyBind.names.includes(...) in its click handler, but names existed
// only on the object `ready` resolves to, so every "Check prices" click threw and no intent was sent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");

function load() {
  const window = { addEventListener() {}, parent: null, location: { href: "http://localhost:4180/", pathname: "/", search: "", hash: "" } };
  window.parent = window;
  const context = {
    window,
    document: { title: "Shoes", currentScript: null, createElement: () => ({ setAttribute() {}, remove() {} }), body: { appendChild() {} } },
    location: window.location,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console,
    // the binder never answers: names comes from the hello below
    fetch: () => new Promise(() => {}),
    EventSource: undefined,
  };
  vm.runInNewContext(SOURCE, context);
  return window.instafyBind;
}

test("instafyBind.names is [] before the binder answers and the runnable intents after", async () => {
  const bind = load();
  assert.deepEqual([...bind.names], []);
  assert.equal(bind.names.includes("check_price"), false);
  bind.ingest({ source: "instafy-host", v: 2, type: "hello", capabilities: { intents: ["check_price", "ask_octo"] } });
  const ready = await bind.ready;
  assert.deepEqual([...bind.names], ["check_price", "ask_octo"]);
  assert.deepEqual([...bind.names], [...ready.names]);
  assert.equal(bind.names.includes("check_price"), true);
});

test("retry() does not re-send a search whose position the binder withheld", async () => {
  const bind = load();
  bind.ingest({ source: "instafy-host", v: 2, type: "hello", capabilities: { intents: ["find_stores", "check_price"] } });
  await bind.ready;
  const near = { ref: "stores:nearby", prov: { intent: { name: "find_stores", params: { ref: "stores:nearby" }, id: "int_1", withheld: ["lat", "lon"] } } };
  assert.equal(bind.retry(near), null);
  const price = { ref: "shoes:a", prov: { intent: { name: "check_price", params: { ref: "shoes:a" }, id: "int_2" } } };
  assert.equal(typeof bind.retry(price), "string");
});
