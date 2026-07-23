import { once } from "node:events";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type MockSecret = {
  id: string;
  name: string;
  value: string;
  description: string | null;
  agentHandles: string[];
  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function toListItem(secret: MockSecret) {
  return {
    id: secret.id,
    name: secret.name,
    description: secret.description,
    agentIds: [],
    agentHandles: secret.agentHandles,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function startMockController(token: string) {
  const projectId = randomUUID();
  const state: { secrets: MockSecret[] } = {
    secrets: [
      {
        id: randomUUID(),
        name: "TOKEN",
        value: "initial-token",
        description: "GitHub issues token",
        agentHandles: ["octo"],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ],
  };

  const server = http.createServer(async (req, res) => {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "invalid token" }));
      return;
    }

    const listPath = `/projects/${projectId}/secrets`;
    if (req.method === "GET" && req.url === listPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.secrets.map(toListItem)));
      return;
    }

    if (req.method === "POST" && req.url === listPath) {
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim().toUpperCase() : "";
      const value = typeof body.value === "string" ? body.value.trim() : "";
      if (!name || !value) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "name/value required" }));
        return;
      }
      if (state.secrets.some((secret) => secret.name === name)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "secret name already exists" }));
        return;
      }

      const created: MockSecret = {
        id: randomUUID(),
        name,
        value,
        description:
          typeof body.description === "string" && body.description.trim()
            ? body.description.trim()
            : null,
        agentHandles: Array.isArray(body.agentHandles)
          ? body.agentHandles.filter((entry): entry is string => typeof entry === "string")
          : ["octo"],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.secrets.push(created);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: created.id }));
      return;
    }

    const patchMatch = req.url?.match(new RegExp(`^/projects/${projectId}/secrets/([^/]+)$`));
    if (req.method === "PATCH" && patchMatch) {
      const id = decodeURIComponent(patchMatch[1] ?? "");
      const secret = state.secrets.find((entry) => entry.id === id);
      if (!secret) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "secret not found" }));
        return;
      }

      const body = await readJsonBody(req);
      if (typeof body.value === "string" && body.value.trim()) {
        secret.value = body.value.trim();
      }
      if (typeof body.description === "string") {
        secret.description = body.description.trim() || null;
      }
      if (Array.isArray(body.agentHandles)) {
        secret.agentHandles = body.agentHandles
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
      secret.updatedAt = nowIso();

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(toListItem(secret)));
      return;
    }

    if (req.method === "DELETE" && patchMatch) {
      const id = decodeURIComponent(patchMatch[1] ?? "");
      const index = state.secrets.findIndex((entry) => entry.id === id);
      if (index === -1) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "secret not found" }));
        return;
      }
      state.secrets.splice(index, 1);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  server.listen(0);
  return { server, projectId, state };
}

async function execCli(args: string[], env?: NodeJS.ProcessEnv) {
  const entry = "dist/index.js";
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn(
      "node",
      [entry, ...args],
      {
        env: { ...process.env, HOME: tmpHome, ...env },
        cwd: new URL("../", import.meta.url).pathname,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stdoutPromise = readAll(child.stdout);
    const stderrPromise = readAll(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    return { code, stdout, stderr };
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("secrets cli", () => {
  it("lists and gets secret metadata without exposing values", async () => {
    const token = "controller-token";
    const { server, projectId } = startMockController(token);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const listed = await execCli([
        "secrets",
        "list",
        "--space",
        projectId,
        "--controller-url",
        controllerUrl,
        "--controller-access-token",
        token,
        "--json",
      ]);
      expect(listed.code).toBe(0);
      const listPayload = JSON.parse(listed.stdout) as {
        projectId: string;
        secrets: Array<Record<string, unknown>>;
      };
      expect(listPayload.projectId).toBe(projectId);
      expect(listPayload.secrets.length).toBe(1);
      expect(listPayload.secrets[0]?.name).toBe("TOKEN");
      expect(listPayload.secrets[0]?.value).toBeUndefined();

      const got = await execCli([
        "secrets",
        "get",
        "token",
        "--space",
        projectId,
        "--controller-url",
        controllerUrl,
        "--controller-access-token",
        token,
        "--json",
      ]);
      expect(got.code).toBe(0);
      const getPayload = JSON.parse(got.stdout) as {
        secret: Record<string, unknown>;
      };
      expect(getPayload.secret.name).toBe("TOKEN");
      expect(getPayload.secret.value).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("upserts by name and can revoke by name", async () => {
    const token = "controller-token";
    const { server, projectId, state } = startMockController(token);
    await once(server, "listening");

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const updated = await execCli([
        "secrets",
        "put",
        "TOKEN",
        "--value",
        "updated-token",
        "--description",
        "GitHub PAT",
        "--space",
        projectId,
        "--controller-url",
        controllerUrl,
        "--controller-access-token",
        token,
        "--json",
      ]);
      expect(updated.code).toBe(0);
      const updatedPayload = JSON.parse(updated.stdout) as { mode: string };
      expect(updatedPayload.mode).toBe("updated");
      expect(state.secrets[0]?.value).toBe("updated-token");
      expect(state.secrets[0]?.description).toBe("GitHub PAT");

      const created = await execCli([
        "secrets",
        "put",
        "SECOND_TOKEN",
        "--value",
        "second",
        "--space",
        projectId,
        "--controller-url",
        controllerUrl,
        "--controller-access-token",
        token,
        "--json",
      ]);
      expect(created.code).toBe(0);
      const createdPayload = JSON.parse(created.stdout) as { mode: string; name: string };
      expect(createdPayload.mode).toBe("created");
      expect(createdPayload.name).toBe("SECOND_TOKEN");

      const revoked = await execCli([
        "secrets",
        "revoke",
        "SECOND_TOKEN",
        "--space",
        projectId,
        "--controller-url",
        controllerUrl,
        "--controller-access-token",
        token,
        "--json",
      ]);
      expect(revoked.code).toBe(0);
      const revokedPayload = JSON.parse(revoked.stdout) as {
        revoked: { name: string };
      };
      expect(revokedPayload.revoked.name).toBe("SECOND_TOKEN");
      expect(state.secrets.some((secret) => secret.name === "SECOND_TOKEN")).toBe(false);
    } finally {
      server.close();
    }
  });
});
