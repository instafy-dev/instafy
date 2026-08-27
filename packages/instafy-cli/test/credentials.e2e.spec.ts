import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type MockCredential = Record<string, unknown> & { id: string };

// Fixed ids so prefix resolution is deterministic: "aaaa1111" is unique, "bbbb" is shared by
// two active credentials, and "cccc" belongs only to a revoked credential.
const ACTIVE_DEFAULT_ID = "aaaa1111-0000-4000-8000-000000000001";
const ACTIVE_SECOND_ID = "bbbb2222-0000-4000-8000-000000000002";
const ACTIVE_THIRD_ID = "bbbb3333-0000-4000-8000-000000000003";
const REVOKED_ID = "cccc4444-0000-4000-8000-000000000004";

function credentialPayload(overrides: Record<string, unknown> = {}): MockCredential {
  return {
    id: ACTIVE_DEFAULT_ID,
    kind: "openai_api_key",
    label: null,
    isDefault: false,
    metadata: {
      source: "codex_cli",
      provider: "openai",
      default_model: "gpt-5",
      upstream_endpoint: "https://api.openai.com/v1/responses",
      // Never returned by the real controller; present here to prove the CLI does not echo
      // unknown metadata keys.
      would_be_secret: "sk-should-never-print",
    },
    lastUsedAt: "2026-08-17T10:15:00Z",
    revokedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-17T10:15:00Z",
    ...overrides,
  };
}

function seedCredentials(): MockCredential[] {
  return [
    credentialPayload({ id: ACTIVE_DEFAULT_ID, isDefault: true, label: "work key" }),
    credentialPayload({
      id: ACTIVE_SECOND_ID,
      kind: "codex_auth_json",
      metadata: { provider: "openai", default_model: "gpt-5-codex" },
      lastUsedAt: null,
    }),
    credentialPayload({
      id: ACTIVE_THIRD_ID,
      metadata: { provider: "deepseek", default_model: "deepseek-chat" },
    }),
    credentialPayload({
      id: REVOKED_ID,
      metadata: { provider: "gemini", default_model: "gemini-2.5-pro" },
      revokedAt: "2026-08-10T00:00:00Z",
    }),
  ];
}

type MockControllerOptions = {
  credentials?: MockCredential[];
  testResponses?: Record<string, Record<string, unknown>>;
};

function startMockController(token: string, options: MockControllerOptions = {}) {
  const state = {
    credentials: options.credentials ?? seedCredentials(),
    requests: [] as Array<{ method: string; url: string }>,
    testResponses: options.testResponses ?? {},
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "";
    const url = req.url ?? "";
    state.requests.push({ method, url });

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "invalid token" }));
      return;
    }

    if (method === "GET" && url === "/me/credentials") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.credentials));
      return;
    }

    if (method === "DELETE" && url === "/me/credentials/default") {
      for (const credential of state.credentials) {
        credential.isDefault = false;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hasDefaultCredential: false }));
      return;
    }

    const testMatch = /^\/me\/credentials\/([^/]+)\/test$/.exec(url);
    if (method === "POST" && testMatch) {
      const id = decodeURIComponent(testMatch[1]!);
      const credential = state.credentials.find((entry) => entry.id === id && !entry.revokedAt);
      if (!credential) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "credential not found" }));
        return;
      }
      const body = state.testResponses[id] ?? {
        ok: true,
        provider: "openai",
        upstreamEndpoint: "https://api.openai.com/v1/responses",
        model: "gpt-5",
        output: "OK",
        elapsedMs: 421,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    const defaultMatch = /^\/me\/credentials\/([^/]+)\/default$/.exec(url);
    if (method === "POST" && defaultMatch) {
      const id = decodeURIComponent(defaultMatch[1]!);
      const credential = state.credentials.find((entry) => entry.id === id && !entry.revokedAt);
      if (!credential) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "credential not found" }));
        return;
      }
      for (const entry of state.credentials) {
        entry.isDefault = entry.id === id;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ credentialId: id, kind: credential.kind, isDefault: true }));
      return;
    }

    const revokeMatch = /^\/me\/credentials\/([^/]+)$/.exec(url);
    if (method === "DELETE" && revokeMatch) {
      const id = decodeURIComponent(revokeMatch[1]!);
      const credential = state.credentials.find((entry) => entry.id === id && !entry.revokedAt);
      if (!credential) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "credential not found" }));
        return;
      }
      credential.revokedAt = new Date().toISOString();
      credential.isDefault = false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  server.listen(0);
  return { server, state };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function execCli(args: string[]) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "dist", "index.js");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: packageRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        // Keep kleur from emitting ANSI codes so assertions can match plain text.
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutPromise = readAll(child.stdout);
    const stderrPromise = readAll(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    return {
      code,
      stdout: await stdoutPromise,
      stderr: await stderrPromise,
    };
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

async function withController(
  options: MockControllerOptions,
  run: (context: {
    args: string[];
    state: ReturnType<typeof startMockController>["state"];
  }) => Promise<void>,
) {
  const token = "controller-token";
  const { server, state } = startMockController(token, options);
  await once(server, "listening");
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const args = ["--server-url", `http://127.0.0.1:${port}`, "--access-token", token];
    await run({ args, state });
  } finally {
    await closeServer(server);
  }
}

describe("credentials cli", () => {
  it("lists active credentials by default and includes revoked ones with --all", async () => {
    await withController({}, async ({ args }) => {
      const human = await execCli(["credentials", "list", ...args]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("aaaa1111");
      expect(human.stdout).toContain("bbbb2222");
      expect(human.stdout).toContain("bbbb3333");
      expect(human.stdout).not.toContain("cccc4444");
      expect(human.stdout).toContain("1 revoked hidden (use --all to show).");
      expect(human.stdout).toContain("openai_api_key");
      expect(human.stdout).toContain("deepseek");
      expect(human.stdout).toContain("gpt-5-codex");
      expect(human.stdout).toContain("work key");
      // Never echo unknown metadata or anything secret-shaped.
      expect(human.stdout).not.toContain("sk-should-never-print");
      expect(human.stdout).not.toContain("would_be_secret");

      const all = await execCli(["credentials", "list", "--all", ...args]);
      expect(all.code).toBe(0);
      expect(all.stdout).toContain("cccc4444");
      expect(all.stdout).toContain("gemini");
      expect(all.stdout).not.toContain("revoked hidden");
      expect(all.stdout).not.toContain("sk-should-never-print");
    });
  });

  it("emits a whitelisted JSON shape for list", async () => {
    await withController({}, async ({ args }) => {
      const json = await execCli(["credentials", "list", "--json", ...args]);
      expect(json.code).toBe(0);
      const records = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
      expect(records.map((record) => record.id)).toEqual([
        ACTIVE_DEFAULT_ID,
        ACTIVE_SECOND_ID,
        ACTIVE_THIRD_ID,
      ]);
      expect(Object.keys(records[0]!).sort()).toEqual(
        [
          "createdAt",
          "defaultModel",
          "id",
          "isDefault",
          "kind",
          "label",
          "lastUsedAt",
          "provider",
          "revokedAt",
          "updatedAt",
        ].sort(),
      );
      expect(records[0]).toMatchObject({
        id: ACTIVE_DEFAULT_ID,
        kind: "openai_api_key",
        label: "work key",
        provider: "openai",
        defaultModel: "gpt-5",
        isDefault: true,
        revokedAt: null,
      });
      expect(json.stdout).not.toContain("sk-should-never-print");

      const jsonAll = await execCli(["credentials", "list", "--json", "--all", ...args]);
      expect(jsonAll.code).toBe(0);
      const allRecords = JSON.parse(jsonAll.stdout) as Array<Record<string, unknown>>;
      expect(allRecords).toHaveLength(4);
      expect(allRecords[3]).toMatchObject({ id: REVOKED_ID, revokedAt: "2026-08-10T00:00:00Z" });
    });
  });

  it("tests a credential by prefix and reports ok", async () => {
    await withController({}, async ({ args, state }) => {
      const human = await execCli(["credentials", "test", "aaaa1111", ...args]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("ok  aaaa1111");
      expect(human.stdout).toContain("provider openai · model gpt-5");
      expect(human.stdout).toContain("output OK");
      expect(state.requests).toContainEqual({
        method: "POST",
        url: `/me/credentials/${ACTIVE_DEFAULT_ID}/test`,
      });

      const json = await execCli(["credentials", "test", "aaaa1111", "--json", ...args]);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        credentialId: ACTIVE_DEFAULT_ID,
        ok: true,
        provider: "openai",
        model: "gpt-5",
        output: "OK",
        upstreamEndpoint: "https://api.openai.com/v1/responses",
        elapsedMs: 421,
      });
    });
  });

  it("exits 1 when the probe fails and truncates long output", async () => {
    const longOutput = "x".repeat(1000);
    await withController(
      {
        testResponses: {
          [ACTIVE_THIRD_ID]: {
            ok: false,
            provider: "deepseek",
            model: "deepseek-chat",
            output: longOutput,
            elapsedMs: 12,
          },
        },
      },
      async ({ args }) => {
        const human = await execCli(["credentials", "test", "bbbb3333", ...args]);
        expect(human.code).toBe(1);
        expect(human.stdout).toContain("failed  bbbb3333");
        expect(human.stdout).toContain("provider deepseek · model deepseek-chat");
        expect(human.stdout).toContain(`${"x".repeat(300)}…`);
        expect(human.stdout).not.toContain("x".repeat(301));

        const json = await execCli(["credentials", "test", "bbbb3333", "--json", ...args]);
        expect(json.code).toBe(1);
        const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
        expect(parsed.ok).toBe(false);
        expect(parsed.credentialId).toBe(ACTIVE_THIRD_ID);
        expect(parsed.output).toBe(longOutput);
      },
    );
  });

  it("sets and clears the default credential", async () => {
    await withController({}, async ({ args, state }) => {
      const set = await execCli(["credentials", "default", "bbbb2222", ...args]);
      expect(set.code).toBe(0);
      expect(set.stdout).toContain("Default set:");
      expect(set.stdout).toContain("bbbb2222");
      expect(state.requests).toContainEqual({
        method: "POST",
        url: `/me/credentials/${ACTIVE_SECOND_ID}/default`,
      });
      expect(state.credentials.find((entry) => entry.id === ACTIVE_SECOND_ID)?.isDefault).toBe(true);
      expect(state.credentials.find((entry) => entry.id === ACTIVE_DEFAULT_ID)?.isDefault).toBe(false);

      const setJson = await execCli([
        "credentials",
        "default",
        ACTIVE_DEFAULT_ID,
        "--json",
        ...args,
      ]);
      expect(setJson.code).toBe(0);
      expect(JSON.parse(setJson.stdout)).toEqual({
        ok: true,
        credentialId: ACTIVE_DEFAULT_ID,
        kind: "openai_api_key",
        isDefault: true,
      });

      const clear = await execCli(["credentials", "default", "--clear", ...args]);
      expect(clear.code).toBe(0);
      expect(clear.stdout).toContain("Default cleared.");
      expect(state.requests).toContainEqual({ method: "DELETE", url: "/me/credentials/default" });
      expect(state.credentials.every((entry) => entry.isDefault === false)).toBe(true);

      const clearJson = await execCli(["credentials", "default", "--clear", "--json", ...args]);
      expect(clearJson.code).toBe(0);
      expect(JSON.parse(clearJson.stdout)).toEqual({ ok: true, hasDefaultCredential: false });

      const both = await execCli(["credentials", "default", "aaaa1111", "--clear", ...args]);
      expect(both.code).toBe(1);
      expect(both.stderr).toContain("not both");

      const neither = await execCli(["credentials", "default", ...args]);
      expect(neither.code).toBe(1);
      expect(neither.stderr).toContain("or pass --clear");
    });
  });

  it("revokes with --yes and refuses without confirmation when not interactive", async () => {
    await withController({}, async ({ args, state }) => {
      const refused = await execCli(["credentials", "revoke", "bbbb3333", ...args]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("Re-run with --yes");
      expect(state.requests.filter((entry) => entry.method === "DELETE")).toHaveLength(0);
      expect(state.credentials.find((entry) => entry.id === ACTIVE_THIRD_ID)?.revokedAt).toBeNull();

      const revoked = await execCli(["credentials", "revoke", "bbbb3333", "--yes", ...args]);
      expect(revoked.code).toBe(0);
      expect(revoked.stdout).toContain("Revoked:");
      expect(revoked.stdout).toContain("bbbb3333");
      expect(state.requests).toContainEqual({
        method: "DELETE",
        url: `/me/credentials/${ACTIVE_THIRD_ID}`,
      });
      expect(state.credentials.find((entry) => entry.id === ACTIVE_THIRD_ID)?.revokedAt).not.toBeNull();

      const again = await execCli(["credentials", "revoke", "bbbb3333", "--yes", ...args]);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("revoked");

      const revokedJson = await execCli([
        "credentials",
        "revoke",
        "aaaa1111",
        "--yes",
        "--json",
        ...args,
      ]);
      expect(revokedJson.code).toBe(0);
      expect(JSON.parse(revokedJson.stdout)).toEqual({ ok: true, credentialId: ACTIVE_DEFAULT_ID });
    });
  });

  it("rejects ambiguous, unknown and revoked-only prefixes with clear errors", async () => {
    await withController({}, async ({ args, state }) => {
      const ambiguous = await execCli(["credentials", "test", "bbbb", ...args]);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stderr).toContain('prefix "bbbb" is ambiguous');
      expect(ambiguous.stderr).toContain("bbbb2222");
      expect(ambiguous.stderr).toContain("bbbb3333");

      const unknown = await execCli(["credentials", "default", "ffff", ...args]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('No credential matches "ffff"');

      const revokedOnly = await execCli(["credentials", "test", "cccc", ...args]);
      expect(revokedOnly.code).toBe(1);
      expect(revokedOnly.stderr).toContain("only matches revoked credentials");
      expect(revokedOnly.stderr).toContain("--all");

      const revokedExact = await execCli(["credentials", "test", REVOKED_ID, ...args]);
      expect(revokedExact.code).toBe(1);
      expect(revokedExact.stderr).toContain("is revoked and cannot be tested");

      // None of the failed resolutions reached a mutating or probing route.
      expect(
        state.requests.filter((entry) => entry.method !== "GET" || entry.url !== "/me/credentials"),
      ).toHaveLength(0);
    });
  });
});
