import assert from "node:assert/strict";
import test from "node:test";
import { startLocalProviderHost } from "./local-provider-host-server.mjs";

async function listenForTest(provider) {
  const server = startLocalProviderHost({
    providers: [provider],
    defaultProviderId: provider.id,
    host: "127.0.0.1",
    port: 0,
    serviceName: "local-provider-host-test",
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("the host passes a sanitized initialization context separately to callTool", async () => {
  const calls = [];
  const provider = {
    id: "example",
    summary: { id: "example", title: "Example" },
    async callTool(...args) {
      calls.push(args);
      return { ok: true, name: args[0], value: { saved: true } };
    },
  };
  const { server, baseUrl } = await listenForTest(provider);

  try {
    const response = await fetch(`${baseUrl}/providers/example/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "example.write",
        arguments: { value: 1 },
        initialization: {
          providerId: "example",
          projectId: " project-1 ",
          rootUri: " file:///workspace ",
          grantedCapabilities: ["project_content_write"],
          grantedPrefix: " .instafy/providers/example/ ",
          status: "bound_read_write",
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      [
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
      ],
    ]);
  } finally {
    await closeServer(server);
  }
});

test("the host rejects invalid initialization before calling a provider", async () => {
  let callCount = 0;
  const provider = {
    id: "example",
    summary: { id: "example", title: "Example" },
    async callTool() {
      callCount += 1;
      return { ok: true };
    },
  };
  const { server, baseUrl } = await listenForTest(provider);

  try {
    const response = await fetch(`${baseUrl}/providers/example/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "example.write",
        arguments: {},
        initialization: {
          grantedCapabilities: ["project_content_delete"],
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /unsupported provider initialization capability/);
    assert.equal(callCount, 0);
  } finally {
    await closeServer(server);
  }
});

test("the host passes sanitized initialization to resource reads from a POST body", async () => {
  const calls = [];
  const provider = {
    id: "example",
    summary: { id: "example", title: "Example" },
    async readResource(...args) {
      calls.push(args);
      return { ok: true, uri: args[0], value: { ready: true } };
    },
  };
  const { server, baseUrl } = await listenForTest(provider);

  try {
    const response = await fetch(`${baseUrl}/providers/example/resources/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uri: "example://project/status",
        initialization: {
          providerId: "not-forwarded",
          projectId: " project-1 ",
          rootUri: " file:///workspace ",
          grantedCapabilities: ["project_content_read"],
          grantedPrefix: " .instafy/providers/example/ ",
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      [
        "example://project/status",
        {
          initialization: {
            projectId: "project-1",
            rootUri: "file:///workspace",
            grantedCapabilities: ["project_content_read"],
            grantedPrefix: ".instafy/providers/example/",
          },
        },
      ],
    ]);
  } finally {
    await closeServer(server);
  }
});

test("the host rejects invalid resource initialization before calling a provider", async () => {
  let readCount = 0;
  const provider = {
    id: "example",
    summary: { id: "example", title: "Example" },
    async readResource() {
      readCount += 1;
      return { ok: true };
    },
  };
  const { server, baseUrl } = await listenForTest(provider);

  try {
    const response = await fetch(`${baseUrl}/providers/example/resources/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uri: "example://project/status",
        initialization: {
          grantedCapabilities: ["project_content_delete"],
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /unsupported provider initialization capability/);
    assert.equal(readCount, 0);
  } finally {
    await closeServer(server);
  }
});

test("the host reflects approved origins and rejects every other browser origin", async () => {
  let callCount = 0;
  const provider = {
    id: "example",
    summary: { id: "example", title: "Example" },
    async callTool(name) {
      callCount += 1;
      return { ok: true, name };
    },
  };
  const server = startLocalProviderHost({
    providers: [provider],
    defaultProviderId: provider.id,
    host: "127.0.0.1",
    port: 0,
    serviceName: "local-provider-host-origin-test",
    allowedOrigins: ["https://app.example.test"],
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const rejected = await fetch(`${baseUrl}/providers/example/tools/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ name: "example.write", arguments: {} }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
    assert.equal(callCount, 0);

    const accepted = await fetch(`${baseUrl}/providers/example/tools/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: JSON.stringify({ name: "example.write", arguments: {} }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(
      accepted.headers.get("access-control-allow-origin"),
      "https://app.example.test",
    );
    assert.equal(callCount, 1);
  } finally {
    await closeServer(server);
  }
});
