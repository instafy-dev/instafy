import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const modulePath = path.join(packageRoot, "dist", "personalBrowserControlServer.js");
const { PersonalBrowserControlServer } = await import(modulePath);

function requestJson(url, options = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body) request.end(JSON.stringify(options.body));
    else request.end();
  });
}

test("Personal Browser control server binds exact token, project, Host, and route contracts", async () => {
  const calls = [];
  const server = new PersonalBrowserControlServer({
    handle: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === "status" ? { status: { state: "ready" } } : { accepted: true };
    },
  });
  const credentials = await server.bindProject("project-1");
  const target = new URL(credentials.controlUrl);
  const validHeaders = {
    Authorization: `Bearer ${credentials.token}`,
    Host: target.host,
    "X-Instafy-Project-Id": "project-1",
  };

  try {
    const accepted = await requestJson(`${credentials.controlUrl}/v1/status`, {
      headers: validHeaders,
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.body.ok, true);
    assert.equal(accepted.body.status.state, "ready");
    assert.deepEqual(calls, [{ operation: "status", payload: {} }]);

    const wrongToken = await requestJson(`${credentials.controlUrl}/v1/status`, {
      headers: { ...validHeaders, Authorization: `Bearer ${"x".repeat(43)}` },
    });
    assert.equal(wrongToken.statusCode, 401);
    assert.equal(wrongToken.body.error.code, "invalid_token");

    const wrongProject = await requestJson(`${credentials.controlUrl}/v1/status`, {
      headers: { ...validHeaders, "X-Instafy-Project-Id": "project-2" },
    });
    assert.equal(wrongProject.statusCode, 403);
    assert.equal(wrongProject.body.error.code, "project_mismatch");

    const wrongHost = await requestJson(`${credentials.controlUrl}/v1/status`, {
      headers: { ...validHeaders, Host: "attacker.test" },
    });
    assert.equal(wrongHost.statusCode, 403);
    assert.equal(wrongHost.body.error.code, "invalid_host");

    const browserOrigin = await requestJson(`${credentials.controlUrl}/v1/status`, {
      headers: { ...validHeaders, Origin: "https://attacker.test" },
    });
    assert.equal(browserOrigin.statusCode, 403);
    assert.equal(browserOrigin.body.error.code, "browser_origin_blocked");

    const query = await requestJson(`${credentials.controlUrl}/v1/status?target=all`, {
      headers: validHeaders,
    });
    assert.equal(query.statusCode, 400);
    assert.equal(query.body.error.code, "invalid_route");

    const navigate = await requestJson(`${credentials.controlUrl}/v1/navigate`, {
      method: "POST",
      headers: { ...validHeaders, "Content-Type": "application/json" },
      body: { url: "https://example.test" },
    });
    assert.equal(navigate.statusCode, 200);
    assert.equal(navigate.body.accepted, true);
    assert.deepEqual(calls.at(-1), {
      operation: "navigate",
      payload: { url: "https://example.test" },
    });
  } finally {
    await server.stop();
  }
});

test("rotating a Personal Browser project immediately invalidates old credentials", async () => {
  const server = new PersonalBrowserControlServer({ handle: async () => ({}) });
  const first = await server.bindProject("project-1");
  const second = await server.bindProject("project-2");
  const target = new URL(second.controlUrl);

  try {
    const stale = await requestJson(`${first.controlUrl}/v1/status`, {
      headers: {
        Authorization: `Bearer ${first.token}`,
        Host: target.host,
        "X-Instafy-Project-Id": "project-1",
      },
    });
    assert.equal(stale.statusCode, 401);
    assert.equal(stale.body.error.code, "invalid_token");
  } finally {
    await server.stop();
  }
});

test("revoking a Personal Browser binding immediately returns 401 to the old runtime token", async () => {
  const server = new PersonalBrowserControlServer({ handle: async () => ({}) });
  const credentials = await server.bindProject("project-1");
  const target = new URL(credentials.controlUrl);
  server.clearBinding();

  try {
    const revoked = await requestJson(`${credentials.controlUrl}/v1/status`, {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        Host: target.host,
        "X-Instafy-Project-Id": "project-1",
      },
    });
    assert.equal(revoked.statusCode, 401);
    assert.equal(revoked.body.error.code, "browser_not_bound");
  } finally {
    await server.stop();
  }
});

test("Personal Browser exposes only its bounded operations as authenticated MCP tools", async () => {
  const calls = [];
  const server = new PersonalBrowserControlServer({
    handle: async (operation, payload) => {
      calls.push({ operation, payload });
      return { status: { state: "ready", url: "https://example.test/" } };
    },
  });
  const credentials = await server.bindProject("project-1");
  const target = new URL(credentials.controlUrl);
  const headers = {
    Authorization: `Bearer ${credentials.token}`,
    Host: target.host,
    "X-Instafy-Project-Id": "project-1",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  try {
    const initialized = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST",
      headers,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
    });
    assert.equal(initialized.statusCode, 200);
    assert.equal(initialized.body.result.serverInfo.name, "instafy-personal-browser");

    const listed = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST",
      headers,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    assert.deepEqual(
      listed.body.result.tools.map((tool) => tool.name),
      ["request_human_input", "status", "snapshot", "navigate", "click", "type", "press", "scroll"],
    );
    for (const name of ["click", "type", "press"]) {
      const tool = listed.body.result.tools.find((candidate) => candidate.name === name);
      assert.deepEqual(tool.inputSchema.required.includes("index"), true);
      assert.equal(Object.hasOwn(tool.inputSchema.properties, "selector"), false);
    }

    const called = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST",
      headers,
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "navigate", arguments: { url: "https://example.test" } },
      },
    });
    assert.equal(called.statusCode, 200);
    assert.equal(called.body.result.isError, false);
    assert.equal(called.body.result.structuredContent.status.state, "ready");
    assert.deepEqual(calls, [
      { operation: "navigate", payload: { url: "https://example.test" } },
    ]);

    const arbitrary = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST",
      headers,
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "evaluate", arguments: { expression: "process.env" } },
      },
    });
    assert.equal(arbitrary.body.error.code, -32602);

    const unknownArgument = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST",
      headers,
      body: {
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "navigate",
          arguments: { url: "https://example.test", evaluate: "process.env" },
        },
      },
    });
    assert.equal(unknownArgument.body.error.code, -32602);
    assert.equal(calls.length, 1);

    const selectorArgument = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST",
      headers,
      body: {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "click", arguments: { selector: "button" } },
      },
    });
    assert.equal(selectorArgument.body.error.code, -32602);
    assert.equal(calls.length, 1);

    const missingProject = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, "X-Instafy-Project-Id": "project-2" },
      body: { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
    });
    assert.equal(missingProject.statusCode, 403);
    assert.equal(missingProject.body.error.code, "project_mismatch");
  } finally {
    await server.stop();
  }
});

test("binding rotation while a request body is streaming prevents operation dispatch", async () => {
  const calls = [];
  const server = new PersonalBrowserControlServer({
    handle: async (operation) => {
      calls.push(operation);
      return {};
    },
  });
  const first = await server.bindProject("project-1");
  const target = new URL(first.controlUrl);

  try {
    const responsePromise = new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: "/v1/navigate",
          method: "POST",
          headers: {
            Authorization: `Bearer ${first.token}`,
            Host: target.host,
            "X-Instafy-Project-Id": "project-1",
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          });
        },
      );
      request.on("error", reject);
      request.write('{"url":');
      setTimeout(async () => {
        await server.bindProject("project-2");
        request.end('"https://example.test"}');
      }, 25);
    });

    const response = await responsePromise;
    assert.equal(response.statusCode, 401);
    assert.equal(["stale_token", "invalid_token"].includes(response.body.error.code), true);
    assert.deepEqual(calls, []);
  } finally {
    await server.stop();
  }
});

test("human input acknowledges its own revocation and rejects every later old-token request", async () => {
  const calls = [];
  const server = new PersonalBrowserControlServer({ handle: async (operation) => {
    calls.push(operation);
    if (operation === "request_human_input") {
      server.clearBinding();
      return { humanInputRequired: true };
    }
    return {};
  } });
  const credentials = await server.bindProject("manual-project");
  const headers = { Authorization: `Bearer ${credentials.token}`, "X-Instafy-Project-Id": "manual-project", "Content-Type": "application/json" };
  try {
    const handoff = await requestJson(`${credentials.controlUrl}/mcp`, {
      method: "POST", headers, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_human_input", arguments: { indices: [0] } } },
    });
    assert.equal(handoff.body.result.structuredContent.humanInputRequired, true);
    assert.equal(handoff.body.result.isError, false);
    const oldToken = await requestJson(`${credentials.controlUrl}/v1/snapshot`, { headers });
    assert.equal(oldToken.statusCode, 401);
    assert.deepEqual(calls, ["request_human_input"]);
  } finally { await server.stop(); }
});
