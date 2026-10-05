import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];
const spaceId = randomUUID();
const conversationId = randomUUID();
const proposal = {
  key: "confirm-onboarding-copy", title: "Confirm the welcome copy",
  reason: "The conversation leaves the welcome wording undecided.",
  prompt: "Use our earlier discussion to propose the final welcome wording.",
  evidence: [{ conversationId, messageId: randomUUID() }],
};
const record = { ...proposal, id: randomUUID(), projectId: spaceId, status: "proposed", acceptedConversationId: null, createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z" };
const feedback = { recommendationId: record.id, conversationId, projectId: spaceId, title: record.title, status: "proposed", remindAt: null, timezone: null, lastRemindedAt: null };

afterEach(() => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-recommendations-"));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, ".instafy"));
  fs.writeFileSync(path.join(directory, ".instafy", "space.json"), JSON.stringify({ spaceId }));
  fs.writeFileSync(path.join(directory, "proposal.json"), JSON.stringify(proposal));
  return directory;
}

async function controller(body: unknown, status = 200) {
  const requests: { method: string; url: string; auth?: string; body: unknown }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function cli(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  const env = { ...process.env };
  for (const key of ["INSTAFY_ACCESS_TOKEN", "SUPABASE_ACCESS_TOKEN", "CONTROLLER_ACCESS_TOKEN", "CONTROLLER_BASE_URL", "RUNTIME_ACCESS_TOKEN", "RUNTIME_ID", "RUNTIME_LEASE_ID", "INSTAFY_CONVERSATION_ID", "CONVERSATION_ID", "SPACE_ID", "INSTAFY_SPACE_ID", "PROJECT_ID", "INSTAFY_PROJECT_ID", "INSTAFY_PROFILE", "INSTAFY_SERVER_URL"]) delete env[key];
  const child = spawn(process.execPath, [new URL("../bin/instafy.js", import.meta.url).pathname, "recommendations", ...args], {
    cwd, env: { ...env, HOME: cwd, ...extraEnv }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (input !== undefined) child.stdin!.end(input);
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

describe("space recommendations", () => {
  it.each(["INSTAFY_CONVERSATION_ID", "CONVERSATION_ID"])("reads current feedback with %s and the active job credential", async (name) => {
    const mock = await controller(feedback);
    const result = await cli(workspace(), ["current", "--json"], {
      RUNTIME_ID: randomUUID(), [name]: conversationId,
      CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: mock.url,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(feedback);
    expect(mock.requests).toEqual([{ method: "GET", url: `/conversations/${conversationId}/recommendation-feedback`, auth: "Bearer scoped-job-token", body: null }]);
  });

  it("saves dismissal only for the explicitly selected conversation", async () => {
    const dismissed = { ...feedback, status: "dismissed" };
    const mock = await controller(dismissed);
    const result = await cli(workspace(), ["dismiss", "--conversation", conversationId, "--json", "--server-url", mock.url, "--access-token", "user-token"], { INSTAFY_CONVERSATION_ID: randomUUID() });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(dismissed);
    expect(mock.requests).toEqual([{ method: "PATCH", url: `/conversations/${conversationId}/recommendation-feedback`, auth: "Bearer user-token", body: { action: "dismiss" } }]);
  });

  it.each(["2026-10-10T10:00", "2026-10-10T10:00:00+02:00"])("saves a reminder from %s and reports the controller's normalized time", async (runAt) => {
    const reminder = { ...feedback, remindAt: "2026-10-10T08:00:00Z", timezone: "Europe/Vienna" };
    const mock = await controller(reminder);
    const result = await cli(workspace(), ["remind", "--at", runAt, "--timezone", "Europe/Vienna", "--json"], {
      RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: conversationId,
      CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: mock.url,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(reminder);
    expect(mock.requests).toEqual([{ method: "PATCH", url: `/conversations/${conversationId}/recommendation-feedback`, auth: "Bearer scoped-job-token", body: { action: "remind", runAt, timezone: "Europe/Vienna" } }]);
  });

  it.each([
    ["remind", "--at", "tonight", "--timezone", "Europe/Vienna"],
    ["remind", "--at", "2026-10-10T10:00:00", "--timezone", "Not/A_Zone"],
    ["remind", "--at", "2026-10-10T10:00:00"],
    ["dismiss", "--conversation", "../another-conversation"],
    ["current", "--conversation", ""],
  ])("rejects invalid reminder or conversation input before a request: %j", async (args) => {
    const mock = await controller(feedback);
    const result = await cli(workspace(), [...args, "--server-url", mock.url, "--access-token", "user-token"], { INSTAFY_CONVERSATION_ID: conversationId });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(mock.requests).toHaveLength(0);
  });

  it("does not fall back from an invalid primary conversation to another environment value", async () => {
    const mock = await controller(feedback);
    const result = await cli(workspace(), ["current", "--server-url", mock.url, "--access-token", "user-token"], { INSTAFY_CONVERSATION_ID: "invalid", CONVERSATION_ID: conversationId });
    expect(result.code).not.toBe(0);
    expect(mock.requests).toHaveLength(0);
  });

  it("requires an explicit or current conversation before contacting the controller", async () => {
    const mock = await controller(feedback);
    const result = await cli(workspace(), ["current", "--server-url", mock.url, "--access-token", "user-token"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No conversation configured");
    expect(mock.requests).toHaveLength(0);
  });

  it("keeps preference commands bound to the active job's controller origin", async () => {
    const mock = await controller({ ...feedback, status: "dismissed" });
    const result = await cli(workspace(), ["dismiss", "--json", "--server-url", mock.url], {
      RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: conversationId,
      CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: "http://127.0.0.1:1",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("controller origin other than CONTROLLER_BASE_URL");
    expect(mock.requests).toHaveLength(0);
  });

  it.each([403, 404, 409])("surfaces feedback HTTP %i without a fallback mutation or acknowledgement", async (status) => {
    const mock = await controller({ message: "Preference unavailable" }, status);
    const result = await cli(workspace(), ["dismiss", "--conversation", conversationId, "--json", "--server-url", mock.url, "--access-token", "user-token"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(mock.requests).toHaveLength(1);
  });

  it.each([
    { ...feedback, conversationId: randomUUID() },
    { ...feedback, status: "proposed" },
    { ...feedback, status: "dismissed", remindAt: "2026-10-10T08:00:00Z" },
  ])("refuses to confirm dismissal when readback does not confirm it", async (response) => {
    const mock = await controller(response);
    const result = await cli(workspace(), ["dismiss", "--conversation", conversationId, "--json", "--server-url", mock.url, "--access-token", "user-token"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(mock.requests).toHaveLength(1);
  });

  it("lists all outcomes for the linked space with signed-in credentials", async () => {
    const recommendations = [record, { ...record, id: randomUUID(), status: "accepted" }, { ...record, id: randomUUID(), status: "dismissed" }];
    const mock = await controller({ recommendations });
    const result = await cli(workspace(), ["list", "--limit", "200", "--json", "--server-url", mock.url, "--access-token", "user-token"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ recommendations });
    expect(mock.requests).toEqual([{ method: "GET", url: `/projects/${spaceId}/recommendations?limit=200`, auth: "Bearer user-token", body: null }]);
  });

  it("submits only the grounded proposal through the active job's bound controller", async () => {
    const mock = await controller(record);
    const result = await cli(workspace(), ["submit", "--file", "proposal.json", "--json"], {
      RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: conversationId,
      CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: mock.url,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(record);
    expect(mock.requests).toEqual([{ method: "POST", url: `/projects/${spaceId}/recommendations`, auth: "Bearer scoped-job-token", body: proposal }]);
  });

  it("reports preserved terminal outcomes instead of claiming a dismissed recommendation was proposed again", async () => {
    const mock = await controller({ ...record, status: "dismissed" });
    const result = await cli(workspace(), ["submit", "--file", "proposal.json", "--server-url", mock.url, "--access-token", "user-token"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Kept recommendation ${record.id} [dismissed]`);
    expect(mock.requests).toHaveLength(1);
  });

  it("submits literal JSON from stdin without writing a proposal file", async () => {
    const cwd = workspace();
    fs.unlinkSync(path.join(cwd, "proposal.json"));
    const input = { ...proposal, prompt: "Explain the literal strings $(date) and `echo example` from our discussion." };
    const mock = await controller({ ...record, ...input });
    const result = await cli(cwd, ["submit", "--file", "-", "--json", "--server-url", mock.url, "--access-token", "user-token"], {}, JSON.stringify(input));
    expect(result.code, result.stderr).toBe(0);
    expect(mock.requests[0].body).toEqual(input);
    expect(fs.existsSync(path.join(cwd, "proposal.json"))).toBe(false);
    expect(JSON.parse(result.stdout).prompt).toBe(input.prompt);
  });

  it("submits one trimmed Octo opener as literal JSON and preserves scoped delivery redaction", async () => {
    const message = "The guide draft is ready, but the pilot update still needs drafting. Shall I prepare it for your review? Literal notes: $(date) and `echo example`.";
    const delivered = { ...record, message, delivered: true, deliveredConversationId: null };
    const mock = await controller(delivered);
    const result = await cli(workspace(), ["submit", "--file", "-", "--json"], {
      RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: conversationId,
      CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: mock.url,
    }, JSON.stringify({ ...proposal, message: `  ${message}\n` }));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(delivered);
    expect(mock.requests).toEqual([{ method: "POST", url: `/projects/${spaceId}/recommendations`, auth: "Bearer scoped-job-token", body: { ...proposal, message } }]);
  });

  it("lists delivered records without treating them as accepted or claiming a new chat on retry", async () => {
    const delivered = { ...record, delivered: true, deliveredConversationId: randomUUID() };
    const list = await controller({ recommendations: [delivered] });
    const listed = await cli(workspace(), ["list", "--json", "--server-url", list.url, "--access-token", "user-token"]);
    expect(JSON.parse(listed.stdout)).toEqual({ recommendations: [delivered] });
    const submit = await controller(delivered);
    const retried = await cli(workspace(), ["submit", "--file", "-", "--server-url", submit.url, "--access-token", "user-token"], {}, JSON.stringify({ ...proposal, message: "Shall I help settle the welcome wording?" }));
    expect(retried.code, retried.stderr).toBe(0);
    expect(retried.stdout).toContain(`Recommendation ${record.id} [delivered]`);
    expect(retried.stdout).not.toMatch(/accepted|created|opened/i);
    expect(submit.requests).toHaveLength(1);
  });

  it("accepts a 4000-character Unicode opener without counting encoded bytes as characters", async () => {
    const message = "\u{1f642}".repeat(4000);
    const mock = await controller({ ...record, message, delivered: true, deliveredConversationId: null });
    const result = await cli(workspace(), ["submit", "--file", "-", "--json", "--server-url", mock.url, "--access-token", "user-token"], {}, JSON.stringify({ ...proposal, message }));
    expect(result.code, result.stderr).toBe(0);
    expect(mock.requests[0].body).toEqual({ ...proposal, message });
  });

  it("surfaces the delivery limit without retrying or falling back to proposal-only submission", async () => {
    const mock = await controller({ message: "One delivery per run" }, 409);
    const result = await cli(workspace(), ["submit", "--file", "-", "--json", "--server-url", mock.url, "--access-token", "user-token"], {}, JSON.stringify({ ...proposal, message: "Shall I help settle the welcome wording?" }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("409");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body).toEqual({ ...proposal, message: "Shall I help settle the welcome wording?" });
  });

  it.each(["", "{incomplete", " ".repeat(65_537)])("rejects empty, malformed or oversized stdin before a request", async (input) => {
    const mock = await controller(record);
    const result = await cli(workspace(), ["submit", "--file", "-", "--json", "--server-url", mock.url, "--access-token", "user-token"], {}, input);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(mock.requests).toHaveLength(0);
  });

  it.each([
    { ...proposal, evidence: [] },
    { ...proposal, evidence: [{ conversationId: "missing" }] },
    { ...proposal, evidence: [{ conversationId, messageId: "missing" }] },
    { ...proposal, key: "a/path" },
    { ...proposal, title: "x".repeat(161) },
    { ...proposal, ownerUserId: randomUUID() },
    { ...proposal, message: " " },
    { ...proposal, message: null },
    { ...proposal, message: 7 },
    { ...proposal, message: "x".repeat(4001) },
  ])("rejects malformed or ungrounded submissions before contacting the controller", async (invalid) => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "proposal.json"), JSON.stringify(invalid));
    const mock = await controller(record);
    const result = await cli(cwd, ["submit", "--file", "proposal.json", "--json", "--server-url", mock.url, "--access-token", "user-token"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects files and symlink targets outside the active workspace", async () => {
    const cwd = workspace(); const outside = workspace();
    fs.symlinkSync(path.join(outside, "proposal.json"), path.join(cwd, "linked.json"));
    fs.symlinkSync(outside, path.join(cwd, "outside"));
    const mock = await controller(record);
    for (const file of [path.join(outside, "proposal.json"), "linked.json", "outside/proposal.json"]) {
      const result = await cli(cwd, ["submit", "--file", file, "--json", "--server-url", mock.url, "--access-token", "user-token"]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(mock.requests).toHaveLength(0);
  });

  it("refuses to forward the active job credential to a different controller", async () => {
    const mock = await controller(record);
    const result = await cli(workspace(), ["submit", "--file", "proposal.json", "--server-url", mock.url], {
      RUNTIME_ID: randomUUID(), INSTAFY_CONVERSATION_ID: conversationId,
      CONTROLLER_ACCESS_TOKEN: "scoped-job-token", CONTROLLER_BASE_URL: "http://127.0.0.1:1",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("controller origin other than CONTROLLER_BASE_URL");
    expect(mock.requests).toHaveLength(0);
  });

  it("surfaces an unavailable API without creating fallback recommendations", async () => {
    const mock = await controller({ message: "Not found" }, 404);
    const result = await cli(workspace(), ["list", "--json", "--server-url", mock.url, "--access-token", "user-token"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("404");
    expect(mock.requests).toHaveLength(1);
  });
});
