import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Captured = {
  invitationBodies: Record<string, unknown>[];
  inviteLinkBodies: Record<string, unknown>[];
  memberBodies: Record<string, unknown>[];
  acceptBodies: Record<string, unknown>[];
  deletedInvitations: string[];
  deletedLinks: string[];
};

type MockOptions = {
  orgs?: Array<Record<string, unknown>>;
  members?: Array<Record<string, unknown>>;
  invitations?: Array<Record<string, unknown>>;
  inviteLinks?: Array<Record<string, unknown>>;
  inviteLinkToken?: string;
};

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function startMockController(token: string, orgId: string, options: MockOptions = {}) {
  const captured: Captured = {
    invitationBodies: [],
    inviteLinkBodies: [],
    memberBodies: [],
    acceptBodies: [],
    deletedInvitations: [],
    deletedLinks: [],
  };
  const inviteLinkToken = options.inviteLinkToken ?? randomUUID();

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "invalid token" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (method === "GET" && pathname === "/orgs") {
      json(200, { orgs: options.orgs ?? [] });
      return;
    }

    if (method === "GET" && pathname === `/orgs/${orgId}/members`) {
      json(200, {
        members: options.members ?? [],
        nextCursor: null,
        hasMore: false,
        total: (options.members ?? []).length,
      });
      return;
    }

    if (method === "POST" && pathname === `/orgs/${orgId}/members`) {
      const body = await readJsonBody(req);
      captured.memberBodies.push(body);
      json(200, {
        member: {
          userId: body.userId,
          email: "added@example.com",
          fullName: "Added User",
          role: typeof body.role === "string" ? body.role : "builder",
          invitedBy: null,
          createdAt: "2026-08-18T09:00:00Z",
        },
      });
      return;
    }

    if (method === "POST" && pathname === `/orgs/${orgId}/invitations`) {
      const body = await readJsonBody(req);
      captured.invitationBodies.push(body);
      const email = typeof body.email === "string" ? body.email : "invitee@example.com";
      if (email === "member@example.com") {
        json(400, { message: "user is already a member of this organization" });
        return;
      }
      const invitationId = randomUUID();
      json(200, {
        invitation: {
          id: invitationId,
          orgId,
          email,
          role: typeof body.role === "string" ? body.role : "builder",
          status: "pending",
          createdAt: "2026-08-18T09:00:00Z",
          expiresAt: "2026-08-25T09:00:00Z",
        },
        acceptUrl: `https://instafy.dev/invite?token=${randomUUID()}&panel=chat`,
      });
      return;
    }

    if (method === "GET" && pathname === `/orgs/${orgId}/invitations`) {
      json(200, { invitations: options.invitations ?? [] });
      return;
    }

    if (method === "POST" && pathname === `/orgs/${orgId}/invite-links`) {
      const body = await readJsonBody(req);
      captured.inviteLinkBodies.push(body);
      const role = typeof body.role === "string" ? body.role : "builder";
      json(200, {
        inviteLink: {
          id: randomUUID(),
          orgId,
          role,
          status: "active",
          token: inviteLinkToken,
          acceptPath: `/invite?token=${inviteLinkToken}&panel=chat`,
          createdAt: "2026-08-18T09:00:00Z",
          expiresAt: "2026-09-17T09:00:00Z",
        },
      });
      return;
    }

    if (method === "GET" && pathname === `/orgs/${orgId}/invite-links`) {
      json(200, { inviteLinks: options.inviteLinks ?? [] });
      return;
    }

    if (method === "POST" && pathname === "/org-invitations/accept") {
      const body = await readJsonBody(req);
      captured.acceptBodies.push(body);
      json(200, {
        orgId,
        orgSlug: "acme",
        orgName: "Acme Inc",
        role: "builder",
        projectId: null,
        conversationId: null,
      });
      return;
    }

    const deleteInvitation = pathname.match(
      new RegExp(`^/orgs/${orgId}/invitations/([0-9a-f-]+)$`),
    );
    if (method === "DELETE" && deleteInvitation) {
      captured.deletedInvitations.push(deleteInvitation[1]!);
      res.writeHead(204);
      res.end();
      return;
    }

    const deleteLink = pathname.match(
      new RegExp(`^/orgs/${orgId}/invite-links/([0-9a-f-]+)$`),
    );
    if (method === "DELETE" && deleteLink) {
      captured.deletedLinks.push(deleteLink[1]!);
      res.writeHead(204);
      res.end();
      return;
    }

    json(404, { message: "not found" });
  });

  server.listen(0);
  return { server, captured, inviteLinkToken };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
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
  const entry = path.join(packageRoot, "bin", "instafy.js");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: packageRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        NO_COLOR: "1",
        INSTAFY_STUDIO_URL: "",
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

function baseArgs(controllerUrl: string, token: string, teamId?: string): string[] {
  const args = ["--server-url", controllerUrl, "--access-token", token];
  if (teamId) {
    args.push("--team-id", teamId);
  }
  return args;
}

async function withServer<T>(
  token: string,
  orgId: string,
  options: MockOptions,
  run: (controllerUrl: string, captured: Captured, inviteLinkToken: string) => Promise<T>,
): Promise<T> {
  const { server, captured, inviteLinkToken } = startMockController(token, orgId, options);
  await once(server, "listening");
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return await run(`http://127.0.0.1:${port}`, captured, inviteLinkToken);
  } finally {
    await closeServer(server);
  }
}

describe("team cli", () => {
  const token = "controller-token";

  it("lists team members as a table and as JSON", async () => {
    const orgId = randomUUID();
    const memberId = randomUUID();
    await withServer(
      token,
      orgId,
      {
        members: [
          {
            userId: memberId,
            email: "owner@example.com",
            fullName: "Team Owner",
            role: "owner",
            invitedBy: null,
            createdAt: "2026-08-01T09:00:00Z",
          },
        ],
      },
      async (controllerUrl) => {
        const human = await execCli(["team", "members", ...baseArgs(controllerUrl, token, orgId)]);
        expect(human.code).toBe(0);
        expect(human.stdout).toContain("owner@example.com");
        expect(human.stdout).toContain("owner");
        expect(human.stdout).toContain(memberId.slice(0, 8));

        const asJson = await execCli([
          "team",
          "members",
          ...baseArgs(controllerUrl, token, orgId),
          "--json",
        ]);
        expect(asJson.code).toBe(0);
        const parsed = JSON.parse(asJson.stdout) as { members: Array<{ email: string }> };
        expect(parsed.members[0]!.email).toBe("owner@example.com");
      },
    );
  });

  it("posts the email and role for an email invitation", async () => {
    const orgId = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl, captured) => {
      const result = await execCli([
        "team",
        "invite",
        "invitee@example.com",
        "--role",
        "admin",
        ...baseArgs(controllerUrl, token, orgId),
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(captured.invitationBodies).toEqual([
        { email: "invitee@example.com", role: "admin" },
      ]);
      const parsed = JSON.parse(result.stdout) as { invitation: { email: string } };
      expect(parsed.invitation.email).toBe("invitee@example.com");
    });
  });

  it("hints at add-member when the invitee is already a member", async () => {
    const orgId = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl) => {
      const result = await execCli([
        "team",
        "invite",
        "member@example.com",
        ...baseArgs(controllerUrl, token, orgId),
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("already a member");
      expect(result.stderr).toContain("team add-member");
    });
  });

  it("builds the invite-link accept URL from the studio base and acceptPath", async () => {
    const orgId = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl, captured, inviteLinkToken) => {
      const custom = await execCli([
        "team",
        "invite-link",
        "--role",
        "builder",
        "--studio-url",
        "https://studio.example.com",
        ...baseArgs(controllerUrl, token, orgId),
        "--json",
      ]);
      expect(custom.code).toBe(0);
      expect(captured.inviteLinkBodies).toEqual([{ role: "builder" }]);
      const parsed = JSON.parse(custom.stdout) as { acceptUrl: string; inviteLink: { token: string } };
      expect(parsed.acceptUrl).toBe(
        `https://studio.example.com/invite?token=${inviteLinkToken}&panel=chat`,
      );
      expect(parsed.inviteLink.token).toBe(inviteLinkToken);

      const defaulted = await execCli([
        "team",
        "invite-link",
        ...baseArgs(controllerUrl, token, orgId),
        "--json",
      ]);
      expect(defaulted.code).toBe(0);
      const defaultParsed = JSON.parse(defaulted.stdout) as { acceptUrl: string };
      expect(defaultParsed.acceptUrl).toBe(
        `https://instafy.dev/invite?token=${inviteLinkToken}&panel=chat`,
      );
    });
  });

  it("lists pending invitations and invite links", async () => {
    const orgId = randomUUID();
    await withServer(
      token,
      orgId,
      {
        invitations: [
          {
            id: randomUUID(),
            orgId,
            email: "pending@example.com",
            role: "builder",
            status: "pending",
            createdAt: "2026-08-18T09:00:00Z",
            expiresAt: "2026-08-25T09:00:00Z",
          },
        ],
        inviteLinks: [
          {
            id: randomUUID(),
            orgId,
            role: "builder",
            status: "active",
            token: randomUUID(),
            acceptPath: "/invite?token=x&panel=chat",
            createdAt: "2026-08-18T09:00:00Z",
            expiresAt: "2026-09-17T09:00:00Z",
          },
        ],
      },
      async (controllerUrl) => {
        const human = await execCli(["team", "invites", ...baseArgs(controllerUrl, token, orgId)]);
        expect(human.code).toBe(0);
        expect(human.stdout).toContain("Email invitations");
        expect(human.stdout).toContain("pending@example.com");
        expect(human.stdout).toContain("Invite links");

        const asJson = await execCli([
          "team",
          "invites",
          ...baseArgs(controllerUrl, token, orgId),
          "--json",
        ]);
        expect(asJson.code).toBe(0);
        const parsed = JSON.parse(asJson.stdout) as {
          invitations: unknown[];
          inviteLinks: unknown[];
        };
        expect(parsed.invitations).toHaveLength(1);
        expect(parsed.inviteLinks).toHaveLength(1);
      },
    );
  });

  it("adds an existing account by user id", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl, captured) => {
      const result = await execCli([
        "team",
        "add-member",
        "--user-id",
        userId,
        "--role",
        "builder",
        ...baseArgs(controllerUrl, token, orgId),
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(captured.memberBodies).toEqual([{ userId, role: "builder" }]);
      const parsed = JSON.parse(result.stdout) as { member: { userId: string } };
      expect(parsed.member.userId).toBe(userId);
    });
  });

  it("accepts an invitation token", async () => {
    const orgId = randomUUID();
    const inviteToken = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl, captured) => {
      const result = await execCli([
        "team",
        "accept",
        inviteToken,
        ...baseArgs(controllerUrl, token, orgId),
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(captured.acceptBodies).toEqual([{ token: inviteToken }]);
      const parsed = JSON.parse(result.stdout) as { orgName: string; role: string };
      expect(parsed.orgName).toBe("Acme Inc");
      expect(parsed.role).toBe("builder");
    });
  });

  it("revokes a pending invitation with --yes and refuses without it", async () => {
    const orgId = randomUUID();
    const invitationId = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl, captured) => {
      const refused = await execCli([
        "team",
        "revoke-invite",
        invitationId,
        ...baseArgs(controllerUrl, token, orgId),
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("--yes");
      expect(captured.deletedInvitations).toHaveLength(0);

      const confirmed = await execCli([
        "team",
        "revoke-invite",
        invitationId,
        ...baseArgs(controllerUrl, token, orgId),
        "--yes",
      ]);
      expect(confirmed.code).toBe(0);
      expect(captured.deletedInvitations).toEqual([invitationId]);
    });
  });

  it("revokes an invite link with --yes", async () => {
    const orgId = randomUUID();
    const inviteLinkId = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl, captured) => {
      const confirmed = await execCli([
        "team",
        "revoke-link",
        inviteLinkId,
        ...baseArgs(controllerUrl, token, orgId),
        "--yes",
      ]);
      expect(confirmed.code).toBe(0);
      expect(captured.deletedLinks).toEqual([inviteLinkId]);
    });
  });

  it("rejects an invalid role before calling the controller", async () => {
    const orgId = randomUUID();
    await withServer(token, orgId, {}, async (controllerUrl, captured) => {
      const result = await execCli([
        "team",
        "invite",
        "invitee@example.com",
        "--role",
        "superadmin",
        ...baseArgs(controllerUrl, token, orgId),
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--role must be one of");
      expect(captured.invitationBodies).toHaveLength(0);
    });
  });

  it("errors with the team list hint when no team can be resolved", async () => {
    const orgId = randomUUID();
    await withServer(token, orgId, { orgs: [] }, async (controllerUrl) => {
      const result = await execCli(["team", "members", ...baseArgs(controllerUrl, token)]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("No teams found");
      expect(result.stderr).toContain("team list");
    });
  });
});
