import kleur from "kleur";
import {
  resolveConfiguredStudioUrl,
  resolveControllerUrl,
  resolveUserAccessTokenWithSource,
  type AccessTokenSource,
} from "./config.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import {
  extractControllerErrorMessage,
  formatAuthRejectedError,
  formatAuthRequiredError,
} from "./errors.js";

const DEFAULT_STUDIO_URL = "https://instafy.dev";

const ORG_ROLES = ["owner", "admin", "builder", "viewer"] as const;
// Invite links are project-share tokens; the controller's
// normalize_project_share_role only accepts builder or viewer.
const INVITE_LINK_ROLES = ["builder", "viewer"] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TeamCommonOptions = {
  teamId?: string;
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
  cwd?: string;
};

type ControllerAuth = {
  controllerUrl: string;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile: string | null;
  cwd: string;
};

class ControllerRequestError extends Error {
  status: number;
  serverMessage: string | null;

  constructor(status: number, serverMessage: string | null, message: string) {
    super(message);
    this.name = "ControllerRequestError";
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

function requireUuid(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (!isUuid(trimmed)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return trimmed;
}

function normalizeRole(
  value: string | undefined | null,
  allowed: readonly string[],
  label: string,
): string {
  const resolved = (value ?? "").trim().toLowerCase();
  if (!resolved) {
    throw new Error(`${label} is required.`);
  }
  if (!allowed.includes(resolved)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return resolved;
}

function resolveControllerAuth(
  options: TeamCommonOptions,
  retryCommand: string,
): ControllerAuth {
  const cwd = options.cwd ?? process.cwd();
  const controllerUrl = resolveControllerUrl({
    controllerUrl: options.controllerUrl ?? null,
    cwd,
  });

  const resolved = resolveUserAccessTokenWithSource({
    accessToken: options.accessToken ?? null,
    cwd,
  });

  if (!resolved.token) {
    throw formatAuthRequiredError({
      retryCommand,
      advancedHint:
        "pass --access-token, or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN",
    });
  }

  return {
    controllerUrl,
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd,
  };
}

async function controllerJson(
  auth: ControllerAuth,
  retryCommand: string,
  params: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  },
): Promise<unknown> {
  const url = `${auth.controllerUrl.replace(/\/$/, "")}${params.path}`;
  const headers = new Headers();
  headers.set("accept", "application/json");

  let bodyText: string | undefined;
  if (params.body !== undefined) {
    headers.set("content-type", "application/json");
    bodyText = JSON.stringify(params.body);
  }

  const response = (
    await fetchWithControllerAuth({
      url,
      init: {
        method: params.method,
        headers,
        body: bodyText,
      },
      accessToken: auth.accessToken,
      tokenSource: auth.tokenSource,
      profile: auth.profile,
      cwd: auth.cwd,
    })
  ).response;

  const text = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    throw formatAuthRejectedError({
      status: response.status,
      responseBody: text,
      retryCommand,
      advancedHint: "run `instafy login`, or pass --access-token",
    });
  }
  if (!response.ok) {
    const serverMessage = extractControllerErrorMessage(text);
    throw new ControllerRequestError(
      response.status,
      serverMessage,
      `Request failed (${response.status} ${response.statusText})${
        serverMessage ? `: ${serverMessage}` : ""
      }`,
    );
  }
  return text ? JSON.parse(text) : null;
}

type OrgSummary = {
  id: string;
  slug?: string | null;
  name?: string | null;
  role?: string | null;
};

async function fetchOrgs(auth: ControllerAuth): Promise<OrgSummary[]> {
  const payload = (await controllerJson(auth, "instafy team list", {
    method: "GET",
    path: "/orgs",
  })) as { orgs?: OrgSummary[] } | null;
  return Array.isArray(payload?.orgs) ? payload!.orgs! : [];
}

/**
 * Resolve the org id to operate on.
 * - An explicit UUID is used directly.
 * - An explicit slug is resolved via `GET /orgs`.
 * - With no value, a single-team account resolves automatically; otherwise we
 *   error with the `team list` hint.
 */
async function resolveTeamId(
  auth: ControllerAuth,
  teamOpt: string | undefined,
): Promise<string> {
  const raw = teamOpt?.trim();
  if (raw && isUuid(raw)) {
    return raw;
  }

  const orgs = await fetchOrgs(auth);

  if (raw) {
    const bySlug = orgs.find(
      (org) => (org.slug ?? "").toLowerCase() === raw.toLowerCase(),
    );
    if (bySlug) return bySlug.id;
    const byId = orgs.find((org) => org.id === raw);
    if (byId) return byId.id;
    throw new Error(
      `No team matches "${raw}". Run \`instafy team list\` to see the teams you belong to.`,
    );
  }

  if (orgs.length === 1) {
    return orgs[0]!.id;
  }
  if (orgs.length === 0) {
    throw new Error(
      "No teams found for this account. Run `instafy team list` to see your teams.",
    );
  }
  throw new Error(
    "Multiple teams found. Pass --team-id <uuid|slug>. Run `instafy team list` to see the options.",
  );
}

function resolveStudioBaseUrl(
  auth: ControllerAuth,
  studioUrlOption?: string,
): string {
  return (
    normalizeBaseUrl(studioUrlOption ?? null) ??
    normalizeBaseUrl(process.env["INSTAFY_STUDIO_URL"] ?? null) ??
    normalizeBaseUrl(
      resolveConfiguredStudioUrl({ profile: auth.profile, cwd: auth.cwd }),
    ) ??
    DEFAULT_STUDIO_URL
  );
}

function shortId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const format = (cells: string[]) =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index]!)).join("  ").trimEnd();
  console.log(kleur.bold(format(headers)));
  for (const row of rows) {
    console.log(format(row));
  }
}

type OrgMember = {
  userId: string;
  email?: string | null;
  fullName?: string | null;
  role: string;
  invitedBy?: string | null;
  createdAt?: string | null;
};

type OrgInvitation = {
  id: string;
  orgId?: string;
  email: string;
  role: string;
  status?: string;
  createdAt?: string | null;
  expiresAt?: string | null;
};

type OrgInviteLink = {
  id: string;
  orgId?: string;
  role: string;
  status?: string;
  token: string;
  acceptPath: string;
  createdAt?: string | null;
  expiresAt?: string | null;
};

export async function teamMembersList(options: TeamCommonOptions): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team members");
  const orgId = await resolveTeamId(auth, options.teamId);

  const payload = (await controllerJson(auth, "instafy team members", {
    method: "GET",
    path: `/orgs/${encodeURIComponent(orgId)}/members`,
  })) as {
    members?: OrgMember[];
    nextCursor?: string | null;
    hasMore?: boolean;
    total?: number;
  } | null;

  const members = Array.isArray(payload?.members) ? payload!.members! : [];

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          members,
          nextCursor: payload?.nextCursor ?? null,
          hasMore: payload?.hasMore ?? false,
          total: payload?.total,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (members.length === 0) {
    console.log(kleur.gray("No members."));
    return;
  }

  const rows = members.map((member) => [
    shortId(member.userId),
    (member.email ?? "").trim() || "-",
    (member.fullName ?? "").trim() || "-",
    member.role,
    (member.createdAt ?? "").trim() || "-",
  ]);
  printTable(["ID", "EMAIL", "NAME", "ROLE", "JOINED"], rows);
}

export async function teamInvite(options: TeamCommonOptions & {
  email: string;
  role?: string;
}): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team invite");
  const email = options.email?.trim() ?? "";
  if (!email) {
    throw new Error("An email address is required.");
  }
  const role =
    options.role !== undefined
      ? normalizeRole(options.role, ORG_ROLES, "--role")
      : undefined;

  const orgId = await resolveTeamId(auth, options.teamId);

  const body: Record<string, unknown> = { email };
  if (role) body.role = role;

  let payload: { invitation?: OrgInvitation; acceptUrl?: string } | null;
  try {
    payload = (await controllerJson(auth, "instafy team invite", {
      method: "POST",
      path: `/orgs/${encodeURIComponent(orgId)}/invitations`,
      body,
    })) as { invitation?: OrgInvitation; acceptUrl?: string } | null;
  } catch (error) {
    if (
      error instanceof ControllerRequestError &&
      error.status >= 400 &&
      error.status < 500 &&
      /already a member|already exists|already has access/i.test(
        error.serverMessage ?? "",
      )
    ) {
      throw new Error(
        `${error.serverMessage}\n\nIf they already have an Instafy account, add them directly with:\n  instafy team add-member --user-id <uuid>${
          options.teamId ? ` --team-id ${options.teamId}` : ""
        }`,
      );
    }
    throw error;
  }

  const invitation = payload?.invitation;
  if (!invitation?.id) {
    throw new Error("Invitation response missing invitation details.");
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        { invitation, acceptUrl: payload?.acceptUrl ?? null },
        null,
        2,
      ),
    );
    return;
  }

  console.log(kleur.green(`Invitation sent to ${invitation.email}`));
  console.log(`Role: ${invitation.role}`);
  if (invitation.expiresAt) {
    console.log(`Expires: ${invitation.expiresAt}`);
  }
  console.log("");
  console.log(
    `${invitation.email} must sign in to Instafy with this email address to accept the invitation.`,
  );
}

export async function teamInviteLink(options: TeamCommonOptions & {
  role?: string;
  expires?: string;
  studioUrl?: string;
}): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team invite-link");
  const role =
    options.role !== undefined
      ? normalizeRole(options.role, INVITE_LINK_ROLES, "--role")
      : undefined;

  const orgId = await resolveTeamId(auth, options.teamId);

  const body: Record<string, unknown> = {};
  if (role) body.role = role;
  const expires = options.expires?.trim();
  if (expires) {
    // Forwarded for controllers that honor a caller-supplied expiry. The
    // response's expiresAt is authoritative for what was actually stored.
    body.expiresAt = expires;
  }

  const payload = (await controllerJson(auth, "instafy team invite-link", {
    method: "POST",
    path: `/orgs/${encodeURIComponent(orgId)}/invite-links`,
    body,
  })) as { inviteLink?: OrgInviteLink; acceptUrl?: string } | null;

  const inviteLink = payload?.inviteLink;
  if (!inviteLink?.token || !inviteLink.acceptPath) {
    throw new Error("Invite link response missing link details.");
  }

  const studioBase = resolveStudioBaseUrl(auth, options.studioUrl);
  const acceptUrl =
    (typeof payload?.acceptUrl === "string" && payload.acceptUrl.trim()) ||
    `${studioBase}${inviteLink.acceptPath}`;

  if (options.json) {
    console.log(JSON.stringify({ inviteLink, acceptUrl }, null, 2));
    return;
  }

  console.log(kleur.green("Shareable invite link created."));
  console.log(`Role: ${inviteLink.role}`);
  console.log(`Link: ${acceptUrl}`);
  console.log(`Token: ${inviteLink.token}`);
  if (inviteLink.expiresAt) {
    console.log(`Expires: ${inviteLink.expiresAt}`);
  }
  console.log("");
  console.log(
    "Anyone who opens this link and signs in (with any sign-in method) can join the team. Treat it like a shared secret.",
  );
}

export async function teamInvites(options: TeamCommonOptions): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team invites");
  const orgId = await resolveTeamId(auth, options.teamId);

  const [invitationsPayload, linksPayload] = await Promise.all([
    controllerJson(auth, "instafy team invites", {
      method: "GET",
      path: `/orgs/${encodeURIComponent(orgId)}/invitations`,
    }) as Promise<{ invitations?: OrgInvitation[] } | null>,
    controllerJson(auth, "instafy team invites", {
      method: "GET",
      path: `/orgs/${encodeURIComponent(orgId)}/invite-links`,
    }) as Promise<{ inviteLinks?: OrgInviteLink[] } | null>,
  ]);

  const invitations = Array.isArray(invitationsPayload?.invitations)
    ? invitationsPayload!.invitations!
    : [];
  const inviteLinks = Array.isArray(linksPayload?.inviteLinks)
    ? linksPayload!.inviteLinks!
    : [];

  if (options.json) {
    console.log(JSON.stringify({ invitations, inviteLinks }, null, 2));
    return;
  }

  if (invitations.length === 0 && inviteLinks.length === 0) {
    console.log(kleur.gray("No pending invitations or invite links."));
    return;
  }

  if (invitations.length > 0) {
    console.log(kleur.bold("Email invitations"));
    const rows = invitations.map((invitation) => [
      shortId(invitation.id),
      invitation.email,
      invitation.role,
      (invitation.expiresAt ?? "").trim() || "-",
    ]);
    printTable(["ID", "EMAIL", "ROLE", "EXPIRES"], rows);
  }

  if (inviteLinks.length > 0) {
    if (invitations.length > 0) console.log("");
    console.log(kleur.bold("Invite links (shareable, grant join on sign-in)"));
    const rows = inviteLinks.map((link) => [
      shortId(link.id),
      link.role,
      (link.status ?? "").trim() || "-",
      (link.expiresAt ?? "").trim() || "-",
    ]);
    printTable(["ID", "ROLE", "STATUS", "EXPIRES"], rows);
  }
}

export async function teamAddMember(options: TeamCommonOptions & {
  userId: string;
  role?: string;
}): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team add-member");
  const userId = requireUuid(options.userId, "--user-id");
  const role =
    options.role !== undefined
      ? normalizeRole(options.role, ORG_ROLES, "--role")
      : undefined;

  const orgId = await resolveTeamId(auth, options.teamId);

  const body: Record<string, unknown> = { userId };
  if (role) body.role = role;

  const payload = (await controllerJson(auth, "instafy team add-member", {
    method: "POST",
    path: `/orgs/${encodeURIComponent(orgId)}/members`,
    body,
  })) as { member?: OrgMember } | null;

  const member = payload?.member;
  if (!member?.userId) {
    throw new Error("Add member response missing member details.");
  }

  if (options.json) {
    console.log(JSON.stringify({ member }, null, 2));
    return;
  }

  const label = (member.email ?? "").trim() || member.userId;
  console.log(kleur.green(`Added ${label} as ${member.role}.`));
}

export async function teamAccept(options: TeamCommonOptions & {
  token: string;
}): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team accept");
  const token = requireUuid(options.token, "token");

  const payload = (await controllerJson(auth, "instafy team accept", {
    method: "POST",
    path: "/org-invitations/accept",
    body: { token },
  })) as {
    orgId?: string;
    orgSlug?: string;
    orgName?: string;
    role?: string;
    projectId?: string | null;
    conversationId?: string | null;
  } | null;

  if (options.json) {
    console.log(JSON.stringify(payload ?? {}, null, 2));
    return;
  }

  const name = (payload?.orgName ?? "").trim() || payload?.orgSlug || payload?.orgId || "team";
  console.log(kleur.green(`Joined ${name} as ${payload?.role ?? "member"}.`));
}

async function confirmDestructive(
  message: string,
  yes: boolean | undefined,
  json: boolean | undefined,
): Promise<void> {
  if (yes) return;

  const input = process.stdin;
  const interactive = Boolean(
    input.isTTY && process.stdout.isTTY && json !== true && process.env["CI"] !== "true",
  );
  if (!interactive) {
    throw new Error("Refusing to continue without confirmation. Re-run with --yes.");
  }

  const { confirm, isCancel } = await import("@clack/prompts");
  const proceed = await confirm({ message, initialValue: false });
  if (isCancel(proceed) || !proceed) {
    throw new Error("Cancelled.");
  }
}

export async function teamRevokeInvite(options: TeamCommonOptions & {
  invitationId: string;
  yes?: boolean;
}): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team revoke-invite");
  const invitationId = requireUuid(options.invitationId, "invitation id");
  const orgId = await resolveTeamId(auth, options.teamId);

  await confirmDestructive(
    `Revoke pending invitation ${shortId(invitationId)}?`,
    options.yes,
    options.json,
  );

  await controllerJson(auth, "instafy team revoke-invite", {
    method: "DELETE",
    path: `/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true, invitationId }, null, 2));
    return;
  }
  console.log(kleur.green(`Revoked invitation ${invitationId}.`));
}

export async function teamRevokeLink(options: TeamCommonOptions & {
  inviteLinkId: string;
  yes?: boolean;
}): Promise<void> {
  const auth = resolveControllerAuth(options, "instafy team revoke-link");
  const inviteLinkId = requireUuid(options.inviteLinkId, "invite link id");
  const orgId = await resolveTeamId(auth, options.teamId);

  await confirmDestructive(
    `Revoke invite link ${shortId(inviteLinkId)}?`,
    options.yes,
    options.json,
  );

  await controllerJson(auth, "instafy team revoke-link", {
    method: "DELETE",
    path: `/orgs/${encodeURIComponent(orgId)}/invite-links/${encodeURIComponent(inviteLinkId)}`,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true, inviteLinkId }, null, 2));
    return;
  }
  console.log(kleur.green(`Revoked invite link ${inviteLinkId}.`));
}
