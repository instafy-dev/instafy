import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderHostClient,
  normalizeProviderInitializationContext,
  resolveProviderHealthSnapshot,
} from "./index.js";

test("provider initialization keeps only the generic project context", () => {
  assert.deepEqual(
    normalizeProviderInitializationContext({
      providerId: "private-provider",
      projectId: " project-1 ",
      rootUri: " file:///workspace ",
      grantedCapabilities: ["project_content_write", "project_content_write"],
      grantedPrefix: " .instafy/providers/private-provider/ ",
      status: "bound_read_write",
      createdAt: "2026-07-23T00:00:00.000Z",
    }),
    {
      projectId: "project-1",
      rootUri: "file:///workspace",
      grantedCapabilities: ["project_content_write"],
      grantedPrefix: ".instafy/providers/private-provider/",
    },
  );
});

test("provider initialization rejects malformed or unknown capabilities", () => {
  assert.throws(
    () =>
      normalizeProviderInitializationContext({
        grantedCapabilities: ["project_content_delete"],
      }),
    /unsupported provider initialization capability/,
  );
  assert.throws(
    () => normalizeProviderInitializationContext({ rootUri: "" }),
    /rootUri must be a non-empty string or null/,
  );
});

test("tool calls send initialization separately from tool arguments", async () => {
  let capturedRequest = null;
  const client = createProviderHostClient({
    baseUrl: "http://127.0.0.1:8797",
    fetch: async (input, init) => {
      capturedRequest = { input, init };
      return {
        ok: true,
        async json() {
          return { ok: true, name: "example.write" };
        },
      };
    },
  });

  await client.callProviderTool(
    "example",
    "example.write",
    { value: 1 },
    {
      initialization: {
        projectId: "project-1",
        rootUri: "file:///workspace",
        grantedCapabilities: ["project_content_write"],
        grantedPrefix: ".instafy/providers/example/",
      },
    },
  );

  assert.equal(
    capturedRequest.input,
    "http://127.0.0.1:8797/providers/example/tools/call",
  );
  assert.deepEqual(JSON.parse(capturedRequest.init.body), {
    name: "example.write",
    arguments: { value: 1 },
    initialization: {
      projectId: "project-1",
      rootUri: "file:///workspace",
      grantedCapabilities: ["project_content_write"],
      grantedPrefix: ".instafy/providers/example/",
    },
  });
});

test("resource reads send sanitized initialization in a POST body", async () => {
  let capturedRequest = null;
  const client = createProviderHostClient({
    baseUrl: "http://127.0.0.1:8797",
    fetch: async (input, init) => {
      capturedRequest = { input, init };
      return {
        ok: true,
        async json() {
          return { ok: true, uri: "example://project/status" };
        },
      };
    },
  });

  await client.readProviderResource(
    "example",
    "example://project/status",
    {
      initialization: {
        providerId: "not-forwarded",
        projectId: " project-1 ",
        rootUri: " file:///workspace ",
        grantedCapabilities: ["project_content_read"],
        grantedPrefix: " .instafy/providers/example/ ",
      },
    },
  );

  assert.equal(
    capturedRequest.input,
    "http://127.0.0.1:8797/providers/example/resources/read",
  );
  assert.equal(capturedRequest.init.method, "POST");
  assert.deepEqual(JSON.parse(capturedRequest.init.body), {
    uri: "example://project/status",
    initialization: {
      projectId: "project-1",
      rootUri: "file:///workspace",
      grantedCapabilities: ["project_content_read"],
      grantedPrefix: ".instafy/providers/example/",
    },
  });
});

test("health snapshots honor provider-advertised resource aliases", async () => {
  const requests = [];
  const client = createProviderHostClient({
    baseUrl: "http://127.0.0.1:8797",
    fetch: async (input) => {
      requests.push(String(input));
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            uri: "device://runtime/status",
            value: { connection: "ready" },
          };
        },
      };
    },
  });

  const snapshot = await resolveProviderHealthSnapshot(client, {
    id: "example-device",
    discoverable: true,
    resourceUris: [],
    resourceAliases: {
      runtimeStatus: "device://runtime/status",
    },
  });

  assert.equal(snapshot.source, "resource");
  assert.equal(snapshot.resourceUri, "device://runtime/status");
  assert.deepEqual(snapshot.value, { connection: "ready" });
  assert.deepEqual(requests, [
    "http://127.0.0.1:8797/providers/example-device/discover",
    "http://127.0.0.1:8797/providers/example-device/resources/read",
  ]);
});
