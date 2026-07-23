import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

type MockMember = {
  userId: string;
  email: string;
  role: string;
};

type MockInvitation = {
  id: string;
  email: string;
  role: string;
  status?: string;
};

function startMockController(
  orgId: string,
  options: {
    members?: MockMember[];
    invitations?: MockInvitation[];
  } = {},
) {
  const invitationRequests: Record<string, unknown>[] = [];
  const memberRoleRequests: Array<{ userId: string; role: string | null }> = [];
  const members = [...(options.members ?? [])];
  const invitations = [...(options.invitations ?? [])];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === `/orgs/${orgId}/members`) {
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const filtered =
        query.length > 0
          ? members.filter((member) => member.email.toLowerCase().includes(query))
          : members;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          members: filtered.map((member) => ({
            userId: member.userId,
            email: member.email,
            role: member.role,
            createdAt: "2026-03-11T00:00:00.000Z",
          })),
          nextCursor: null,
          hasMore: false,
          total: filtered.length,
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === `/orgs/${orgId}/invitations`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          invitations: invitations.map((invitation) => ({
            id: invitation.id,
            orgId,
            email: invitation.email,
            role: invitation.role,
            status: invitation.status ?? "pending",
            createdAt: "2026-03-11T00:00:00.000Z",
            expiresAt: "2026-03-18T00:00:00.000Z",
          })),
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === `/orgs/${orgId}/invitations`) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      req.on("end", () => {
        const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        invitationRequests.push(requestBody);
        const requestedEmail =
          typeof requestBody.email === "string" ? requestBody.email : "unknown@example.com";
        const requestedRole =
          typeof requestBody.role === "string" ? requestBody.role : "builder";
        const existingIndex = invitations.findIndex(
          (invitation) => invitation.email.toLowerCase() === requestedEmail.toLowerCase(),
        );
        const invitation =
          existingIndex >= 0
            ? {
                ...invitations[existingIndex],
                role: requestedRole,
                status: "pending",
              }
            : {
                id: randomUUID(),
                email: requestedEmail,
                role: requestedRole,
                status: "pending",
              };
        if (existingIndex >= 0) {
          invitations[existingIndex] = invitation;
        } else {
          invitations.push(invitation);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            invitation: {
              id: invitation.id,
              orgId,
              email: invitation.email,
              role: invitation.role,
              status: invitation.status,
              createdAt: "2026-03-11T00:00:00.000Z",
              expiresAt: "2026-03-18T00:00:00.000Z",
            },
          }),
        );
      });
      return;
    }

    const memberRoleMatch = url.pathname.match(
      new RegExp(`^/orgs/${orgId}/members/([^/]+)$`),
    );
    if (req.method === "PATCH" && memberRoleMatch) {
      const userId = decodeURIComponent(memberRoleMatch[1] ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      req.on("end", () => {
        const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        const role = typeof requestBody.role === "string" ? requestBody.role : null;
        memberRoleRequests.push({ userId, role });
        const memberIndex = members.findIndex((member) => member.userId === userId);
        if (memberIndex === -1 || !role) {
          res.writeHead(404);
          res.end();
          return;
        }
        members[memberIndex] = {
          ...members[memberIndex],
          role,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            member: {
              userId,
              email: members[memberIndex]?.email ?? null,
              role,
              createdAt: "2026-03-11T00:00:00.000Z",
            },
          }),
        );
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  return {
    server,
    getInvitationRequests: () => invitationRequests,
    getMemberRoleRequests: () => memberRoleRequests,
  };
}

async function execCli(args: string[], env?: NodeJS.ProcessEnv) {
  const entry = "dist/index.js";
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, ...env },
      cwd: new URL("../", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

describe("space invite", () => {
  it("invites a teammate using the linked space manifest org id", async () => {
    const orgId = randomUUID();
    const projectId = randomUUID();
    const { server, getInvitationRequests } = startMockController(orgId);
    await once(server, "listening");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-space-invite-"));
    try {
      const manifestDir = path.join(tmpDir, ".instafy");
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(
        path.join(manifestDir, "space.json"),
        JSON.stringify({
          spaceId: projectId,
          orgId,
          orgName: "Invite Test Org",
        }),
      );

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "space",
        "invite",
        "teammate@instafy.dev",
        "--path",
        tmpDir,
        "--controller-url",
        controllerUrl,
        "--access-token",
        "controller-token",
        "--role",
        "viewer",
      ]);

      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);
      expect(stdout).toContain("Invitation sent to teammate@instafy.dev");
      expect(stdout).toContain("Role: viewer");
      expect(getInvitationRequests()[0]).toMatchObject({
        email: "teammate@instafy.dev",
        role: "viewer",
        projectId,
      });
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("updates an existing member role by email", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const { server, getInvitationRequests, getMemberRoleRequests } = startMockController(orgId, {
      members: [
        {
          userId,
          email: "teammate@instafy.dev",
          role: "viewer",
        },
      ],
    });
    await once(server, "listening");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-space-role-member-"));
    try {
      const manifestDir = path.join(tmpDir, ".instafy");
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(
        path.join(manifestDir, "space.json"),
        JSON.stringify({
          spaceId: randomUUID(),
          orgId,
          orgName: "Invite Test Org",
        }),
      );

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "space",
        "role",
        "teammate@instafy.dev",
        "builder",
        "--path",
        tmpDir,
        "--controller-url",
        controllerUrl,
        "--access-token",
        "controller-token",
      ]);

      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);
      expect(stdout).toContain("Updated teammate@instafy.dev to builder");
      expect(stdout).toContain("Target: member");
      expect(getMemberRoleRequests()).toEqual([{ userId, role: "builder" }]);
      expect(getInvitationRequests()).toHaveLength(0);
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refreshes a pending invite role by email", async () => {
    const orgId = randomUUID();
    const projectId = randomUUID();
    const invitationId = randomUUID();
    const { server, getInvitationRequests, getMemberRoleRequests } = startMockController(orgId, {
      invitations: [
        {
          id: invitationId,
          email: "teammate@instafy.dev",
          role: "viewer",
        },
      ],
    });
    await once(server, "listening");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-space-role-invite-"));
    try {
      const manifestDir = path.join(tmpDir, ".instafy");
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(
        path.join(manifestDir, "space.json"),
        JSON.stringify({
          spaceId: projectId,
          orgId,
          orgName: "Invite Test Org",
        }),
      );

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const controllerUrl = `http://127.0.0.1:${port}`;

      const { code, stdout, stderr } = await execCli([
        "space",
        "role",
        "teammate@instafy.dev",
        "builder",
        "--path",
        tmpDir,
        "--controller-url",
        controllerUrl,
        "--access-token",
        "controller-token",
      ]);

      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);
      expect(stdout).toContain("Updated pending invite for teammate@instafy.dev to builder");
      expect(stdout).toContain("Target: pending invitation");
      expect(getInvitationRequests()).toHaveLength(1);
      expect(getInvitationRequests()[0]).toMatchObject({
        email: "teammate@instafy.dev",
        role: "builder",
        projectId,
      });
      expect(getMemberRoleRequests()).toHaveLength(0);
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
