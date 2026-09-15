import assert from "node:assert/strict";
import test from "node:test";
import { messageContextPath, messageSearchPath } from "../src/conversationSearch.ts";

test("message search encodes literal queries and opaque cursors without leaking AbortSignal", () => {
  const signal = new AbortController().signal;
  const path = messageSearchPath({ query: "a&b %_ /😀", projectId: "space", personal: true, cursor: "opaque+/=", limit: 30, signal });
  const url = new URL(path, "https://controller.example");
  assert.equal(url.pathname, "/search/messages");
  assert.equal(url.searchParams.get("q"), "a&b %_ /😀");
  assert.equal(url.searchParams.get("cursor"), "opaque+/=");
  assert.equal(url.searchParams.get("projectId"), "space");
  assert.equal(url.searchParams.get("personal"), "true");
  assert.equal(url.searchParams.has("signal"), false);
  assert.deepEqual([...new URL(messageSearchPath({ query: "needle" }), url).searchParams.keys()], ["q"]);
});

test("context allows zero-side windows for bounded older/newer pagination", () => {
  const path = messageContextPath({ conversationId: "chat/id", messageId: "exact&message", before: 0, after: 40 });
  const url = new URL(path, "https://controller.example");
  assert.equal(url.pathname, "/conversations/chat%2Fid/messages/context");
  assert.equal(url.searchParams.get("messageId"), "exact&message");
  assert.equal(url.searchParams.get("before"), "0");
  assert.equal(url.searchParams.get("after"), "40");
});
