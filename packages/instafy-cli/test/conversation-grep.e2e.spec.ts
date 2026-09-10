import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
type Request = { path: string; authorization: string | undefined; method: string | undefined };
async function controller(response: (request: Request) => { status?: number; body: unknown }) {
  const requests: Request[] = [];
  const server = http.createServer((req, res) => {
    const request = { path: req.url!, authorization: req.headers.authorization, method: req.method };
    requests.push(request);
    const result = response(request);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return { url, requests, close: () => { server.closeAllConnections(); server.close(); } };
}
async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
async function cli(args: string[], options: { linkedSpace?: string; env?: NodeJS.ProcessEnv; config?: object } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-conversation-grep-"));
  const workspace = path.join(temporary, "workspace");
  const configHome = path.join(temporary, "home");
  fs.mkdirSync(path.join(workspace, ".instafy"), { recursive: true });
  fs.mkdirSync(path.join(configHome, ".instafy"), { recursive: true });
  if (options.linkedSpace) fs.writeFileSync(path.join(workspace, ".instafy/space.json"), JSON.stringify({ spaceId: options.linkedSpace }));
  if (options.config) fs.writeFileSync(path.join(configHome, ".instafy/config.json"), JSON.stringify(options.config));
  try {
    const child = spawn(process.execPath, [path.join(packageRoot, "dist/cli.js"), "conversation", ...args], {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: configHome, USERPROFILE: configHome, NO_COLOR: "1", FORCE_COLOR: "0", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = readAll(child.stdout); const stderr = readAll(child.stderr);
    const [code] = await once(child, "exit");
    return { code, stdout: await stdout, stderr: await stderr };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function match(projectId: string) {
  return { messageId: randomUUID(), conversationId: randomUUID(), projectId, orgId: null,
    projectName: "Space", orgName: null, conversationTitle: "Old repair", role: "assistant",
    createdAt: "2024-01-01T00:00:00Z", snippet: "Needle from old history", matchRanges: [{ start: 0, end: 6 }] };
}

describe("conversation grep and context", () => {
  it("searches persisted content once with linked space, literal query, cursor and user auth", async () => {
    const space = randomUUID();
    const result = match(space);
    const page = { matches: [result], nextCursor: "opaque-next", hasMore: true };
    const mock = await controller(() => ({ body: page }));
    try {
      const output = await cli(["grep", "50%_ & café", "--limit", "17", "--cursor", "opaque+/=", "--json", "--server-url", mock.url, "--access-token", "user-token"], { linkedSpace: space });
      expect(output.code, output.stderr).toBe(0);
      expect(output.stderr).toBe("");
      expect(JSON.parse(output.stdout)).toEqual(page);
      expect(output.stdout).not.toContain("user-token");
      expect(mock.requests).toHaveLength(1);
      const url = new URL(mock.requests[0].path, mock.url);
      expect(url.pathname).toBe("/search/messages");
      expect(Object.fromEntries(url.searchParams)).toEqual({ q: "50%_ & café", projectId: space, cursor: "opaque+/=", limit: "17" });
      expect(mock.requests[0].authorization).toBe("Bearer user-token");
    } finally { mock.close(); }
  });

  it.each([["--all"], ["--personal"], ["--org", "org"]])("explicit scope %s overrides the linked space", async (...scope) => {
    const org = randomUUID();
    const args = scope.map((value) => value === "org" ? org : value);
    const mock = await controller(() => ({ body: { matches: [], nextCursor: null, hasMore: false } }));
    try {
      const output = await cli(["grep", "needle", ...args, "--server-url", mock.url, "--access-token", "user-token"], { linkedSpace: randomUUID() });
      expect(output.code).toBe(1);
      expect(output.stdout).toBe(""); expect(output.stderr).toBe("");
      const url = new URL(mock.requests[0].path, mock.url);
      expect(url.searchParams.has("projectId")).toBe(false);
      expect(url.searchParams.get("orgId")).toBe(args[0] === "--org" ? org : null);
      expect(url.searchParams.get("personal")).toBe(args[0] === "--personal" ? "true" : null);
    } finally { mock.close(); }
  });

  it("keeps JSON no-match results machine readable while exiting 1", async () => {
    const page = { matches: [], nextCursor: null, hasMore: false };
    const mock = await controller(() => ({ body: page }));
    try {
      const output = await cli(["grep", "needle", "--all", "--json", "--server-url", mock.url, "--access-token", "user-token"]);
      expect(output.code).toBe(1); expect(JSON.parse(output.stdout)).toEqual(page);
    } finally { mock.close(); }
  });

  it("prints one safe locatable line per match and paging hints on stderr", async () => {
    const result = { ...match(randomUUID()), snippet: "Needle\nnext\u001b]0;bad\u0007" };
    const mock = await controller(() => ({ body: { matches: [result], nextCursor: "opaque-next", hasMore: true } }));
    try {
      const output = await cli(["grep", "needle", "--all", "--server-url", mock.url, "--access-token", "user-token"]);
      expect(output.code, output.stderr).toBe(0);
      expect(output.stdout).toBe(`${result.projectId}:${result.conversationId}:${result.messageId}:assistant:2024-01-01T00:00:00Z: Needle\\nnext\\u001b]0;bad\\u0007\n`);
      expect(output.stderr).toContain("--cursor opaque-next");
    } finally { mock.close(); }
  });

  it("ignores runtime/service token envs, and uses a saved login when available", async () => {
    const mock = await controller(() => ({ body: { matches: [], nextCursor: null, hasMore: false } }));
    try {
      const args = ["grep", "needle", "--all", "--server-url", mock.url];
      const env = { CONTROLLER_ACCESS_TOKEN: "runtime-token", CONTROLLER_TOKEN: "runtime-token", INSTAFY_SERVICE_TOKEN: "service-token" };
      const denied = await cli(args, { env });
      expect(denied.code).toBe(2); expect(denied.stdout).toBe("");
      expect(denied.stderr).toContain("signed-in user"); expect(mock.requests).toHaveLength(0);
      const accepted = await cli(args, { env, config: { controllerUrl: mock.url, accessToken: "saved-user-token" } });
      expect(accepted.code, accepted.stderr).toBe(1);
      expect(mock.requests[0].authorization).toBe("Bearer saved-user-token");
    } finally { mock.close(); }
  });

  it("refuses to send saved auth to a different origin", async () => {
    const mock = await controller(() => ({ body: {} }));
    try {
      const output = await cli(["grep", "needle", "--all", "--server-url", mock.url], { config: { controllerUrl: "https://saved.example.invalid", accessToken: "saved-user-token" } });
      expect(output.code).toBe(2); expect(output.stdout).toBe("");
      expect(output.stderr).toContain("different controller origin"); expect(mock.requests).toHaveLength(0);
    } finally { mock.close(); }
  });

  it("reports old controllers explicitly, with error exit2 and empty stdout", async () => {
    const mock = await controller(() => ({ status: 404, body: { message: "Not found" } }));
    try {
      const output = await cli(["grep", "needle", "--all", "--json", "--server-url", mock.url, "--access-token", "user-token"]);
      expect(output.code).toBe(2); expect(output.stdout).toBe("");
      expect(output.stderr).toContain("Message search is unavailable at this controller");
    } finally { mock.close(); }
  });

  it.each([["--limit", "51"], ["--limit", "1.5"], ["--all", "--personal"]])("rejects invalid bounds/scope before HTTP: %s", async (...args) => {
    const mock = await controller(() => ({ body: {} }));
    try {
      const output = await cli(["grep", "needle", ...args, "--server-url", mock.url, "--access-token", "user-token"]);
      expect(output.code).toBe(2); expect(output.stdout).toBe(""); expect(mock.requests).toHaveLength(0);
    } finally { mock.close(); }
  });

  it.each([
    { args: ["grep"] },
    { args: ["grep", "needle", "--limit"] },
    { args: ["grep", "needle", "--limt", "3"] },
    { args: ["context"] },
    { args: ["context", randomUUID(), randomUUID(), "--after"] },
    { args: ["context", randomUUID(), randomUUID(), "--befor", "3"] },
  ])("uses error exit2 for malformed invocation $args", async ({ args }) => {
    const output = await cli(args);
    expect(output.code).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("error:");
  });

  it.each(["grep", "context"])("keeps %s help successful without auth", async (command) => {
    const output = await cli([command, "--help"]);
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain(`Usage: instafy conversation ${command}`);
  });

  it("loads exact old context directly without listing chats or pulling latest messages", async () => {
    const conversationId = randomUUID(); const messageId = randomUUID();
    const page = { anchorMessageId: messageId, messages: [{ id: messageId, conversationId, projectId: randomUUID(), role: "user", content: "Old context", createdAt: "2024-01-01T00:00:00Z" }], olderCursor: null, newerCursor: messageId, hasOlder: false, hasNewer: true };
    const mock = await controller(() => ({ body: page }));
    try {
      const output = await cli(["context", conversationId.toUpperCase(), messageId.toUpperCase(), "--before", "0", "--after", "40", "--json", "--server-url", mock.url, "--access-token", "user-token"]);
      expect(output.code, output.stderr).toBe(0); expect(JSON.parse(output.stdout)).toEqual(page);
      expect(mock.requests).toHaveLength(1);
      const url = new URL(mock.requests[0].path, mock.url);
      expect(url.pathname).toBe(`/conversations/${conversationId}/messages/context`);
      expect(Object.fromEntries(url.searchParams)).toEqual({ messageId, before: "0", after: "40" });
    } finally { mock.close(); }
  });

  it("rejects denied or mismatched context without printing another conversation", async () => {
    const conversationId = randomUUID(); const messageId = randomUUID();
    const mock = await controller(() => ({ body: { anchorMessageId: messageId, messages: [{ id: messageId, conversationId: randomUUID(), content: "private content", role: "user", createdAt: "now" }], olderCursor: null, newerCursor: null, hasOlder: false, hasNewer: false } }));
    try {
      const output = await cli(["context", conversationId, messageId, "--json", "--server-url", mock.url, "--access-token", "user-token"]);
      expect(output.code).toBe(2); expect(output.stdout).toBe(""); expect(output.stderr).not.toContain("private content");
    } finally { mock.close(); }
  });
});
