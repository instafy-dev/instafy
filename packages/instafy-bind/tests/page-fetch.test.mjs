// Page reads (src/page-fetch.mjs): a site that is down is "unavailable", never a missing page.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isUnavailable, pageFetch } from "../src/page-fetch.mjs";

test("a 404 is an answer; a 5xx or a refused connection is unavailable; a policy refusal stays a refusal", async () => {
  const server = http.createServer((req, res) => { res.statusCode = req.url === "/gone" ? 404 : 503; res.end("<html>busy</html>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await pageFetch(`${base}/gone`, { allowLocal: true })).status, 404, "a missing page is an answer");
    await assert.rejects(pageFetch(`${base}/busy`, { allowLocal: true }), (e) => e.code === "unavailable" && /HTTP 503/.test(e.message));
    assert.equal((await pageFetch(`${base}/busy`, { allowLocal: true, answerAnyStatus: true })).status, 503, "robots.txt keeps a 5xx as an answer");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // nothing listens on port 9 of loopback
  await assert.rejects(pageFetch("http://127.0.0.1:9/x", { allowLocal: true }), (e) => e.code === "unavailable" && /did not answer/.test(e.message));
  await assert.rejects(pageFetch("http://127.0.0.1:9/x"), (e) => e.code === "policy", "loopback without --allow-local is refused, not unavailable");
  assert.equal(isUnavailable(Object.assign(new Error("x"), { code: "upstream", cause: { code: "ECONNRESET" } })), true);
  assert.equal(isUnavailable(Object.assign(new Error("x"), { code: "upstream" })), false);
});
