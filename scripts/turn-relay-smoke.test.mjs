import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnutilsArgs, credentialFor } from "./turn-relay-smoke.mjs";

test("derives the coturn REST HMAC-SHA1 credential", () => {
  assert.equal(
    credentialFor("0123456789abcdef0123456789abcdef", "1700000600:project:runtime"),
    "A+Biipl7EcJb/VSrxtfHS8ROjYQ=",
  );
});

test("builds isolated UDP and TLS allocation probes", () => {
  const common = {
    host: "turn.example.test",
    username: "1700000600:smoke",
    credential: "temporary",
  };
  const udp = buildTurnutilsArgs({ ...common, port: 3478, secure: false });
  const secure = buildTurnutilsArgs({ ...common, port: 443, secure: true });

  assert.equal(udp.includes("-S"), false);
  assert.equal(udp.at(-1), "turn.example.test");
  assert.deepEqual(secure.slice(5, 7), ["-t", "-S"]);
  assert.equal(secure.includes("443"), true);
  assert.equal(secure.includes("temporary"), true);
});
