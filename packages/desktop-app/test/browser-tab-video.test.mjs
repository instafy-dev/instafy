import assert from "node:assert/strict";
import test from "node:test";
import { parseTabVideoRequest } from "../dist/browserTabVideo.js";

const request = {
  id: "11111111-1111-4111-8111-111111111111",
  viewId: null,
  viewport: { width: 390, height: 650, dpr: 2 },
  configuration: { iceServers: [], iceTransportPolicy: "all" },
};

test("native video accepts bounded tab requests and only TURN relay configuration", () => {
  assert.equal(parseTabVideoRequest(request).maxFramerate, 30);
  const configuration = {
    iceServers: [
      {
        urls: ["turn:relay.example:3478?transport=udp", "turns:relay.example:5349?transport=tcp"],
        username: "short-lived",
        credential: "test-only",
      },
    ],
    iceTransportPolicy: "relay",
  };
  assert.deepEqual(
    parseTabVideoRequest({ ...request, configuration, maxFramerate: 60 }).configuration,
    configuration,
  );
  for (const changed of [
    { id: "arbitrary" },
    { viewId: "screen:0" },
    { maxFramerate: 120 },
    { viewport: { ...request.viewport, width: 10000 } },
    { viewport: { ...request.viewport, dpr: NaN } },
    { configuration: { iceServers: [{ urls: "https://example.com" }], iceTransportPolicy: "all" } },
    {
      configuration: {
        iceServers: [{ urls: "turn:user:pass@relay.example" }],
        iceTransportPolicy: "all",
      },
    },
  ])
    assert.throws(() => parseTabVideoRequest({ ...request, ...changed }));
});

test("renderer cannot choose a capture source or inject worker options", () => {
  const parsed = parseTabVideoRequest({
    ...request,
    sourceId: "screen:0",
    script: "bad",
    configuration: { ...request.configuration, certificates: ["bad"], bundlePolicy: "max-compat" },
  });
  assert.equal(parsed.sourceId, undefined);
  assert.equal(parsed.script, undefined);
  assert.deepEqual(parsed.configuration, request.configuration);
});
