// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOrganizationInviteRole,
  isProjectInviteRole,
  resolveInviteLinkUrl,
  type AccessInviteScope,
  type InviteScope,
  useScopedInvitationActions,
  useScopedInviteLinkActions,
} from "../useInviteActions";

const mocks = vi.hoisted(() => ({
  cancelInvitation: vi.fn(),
  createInvitation: vi.fn(),
  updateInvitationRole: vi.fn(),
  createLink: vi.fn(),
  refreshInvitations: vi.fn(),
  refreshInviteLinks: vi.fn(),
  revokeLink: vi.fn(),
  useOrgInvitations: vi.fn(),
  useOrgInviteLinks: vi.fn(),
  invitations: [] as Array<{
    createdAt: string;
    email: string;
    id: string;
    orgId: string;
    role: string;
    status: string;
  }>,
  links: [] as Array<{
    acceptPath: string;
    createdAt: string;
    expiresAt: string | null;
    id: string;
    orgId: string;
    projectId: string;
    role: string;
    status: string;
    token: string;
  }>,
}));

vi.mock("../useOrgInvitations", () => ({
  useOrgInvitations: (
    orgId: string | null,
    projectId: string | null,
    conversationId: string | null,
  ) => {
    mocks.useOrgInvitations(orgId, projectId, conversationId);
    return {
      invitations: mocks.invitations,
      loading: false,
      error: null,
      refresh: mocks.refreshInvitations,
      createInvitation: mocks.createInvitation,
      cancelInvitation: mocks.cancelInvitation,
      updateInvitationRole: mocks.updateInvitationRole,
    };
  },
}));

vi.mock("../useOrgInviteLinks", () => ({
  useOrgInviteLinks: (
    orgId: string | null,
    projectId: string | null,
    conversationId: string | null,
  ) => {
    mocks.useOrgInviteLinks(orgId, projectId, conversationId);
    return {
      links: mocks.links,
      loading: false,
      error: null,
      refresh: mocks.refreshInviteLinks,
      createLink: mocks.createLink,
      revokeLink: mocks.revokeLink,
    };
  },
}));

vi.mock("../../utils/publicAppUrl", () => ({
  resolvePublicAppUrl: (path: string) => `https://instafy.dev${path}`,
}));

type InvitationActions = ReturnType<typeof useScopedInvitationActions<InviteScope>>;
type InviteLinkActions = ReturnType<typeof useScopedInviteLinkActions>;

let invitationActions: InvitationActions | null = null;
let inviteLinkActions: InviteLinkActions | null = null;

function InvitationHarness({ scope }: { scope: InviteScope | null }) {
  invitationActions = useScopedInvitationActions(scope);
  return null;
}

function InviteLinkHarness({ scope }: { scope: AccessInviteScope | null }) {
  inviteLinkActions = useScopedInviteLinkActions(scope);
  return null;
}

function createLink(overrides: Partial<(typeof mocks.links)[number]> = {}) {
  return {
    acceptPath: "/invite?token=link-token",
    createdAt: "2026-07-16T08:00:00.000Z",
    expiresAt: null,
    id: "link-1",
    orgId: "org-1",
    projectId: "project-1",
    role: "builder",
    status: "active",
    token: "link-token",
    ...overrides,
  };
}

describe("useInviteActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    invitationActions = null;
    inviteLinkActions = null;
    mocks.invitations = [];
    mocks.links = [];
    mocks.cancelInvitation.mockReset();
    mocks.cancelInvitation.mockResolvedValue({ success: true });
    mocks.updateInvitationRole.mockReset();
    mocks.updateInvitationRole.mockResolvedValue({ success: true });
    mocks.createInvitation.mockReset();
    mocks.createLink.mockReset();
    mocks.refreshInvitations.mockReset();
    mocks.refreshInviteLinks.mockReset();
    mocks.refreshInviteLinks.mockResolvedValue([]);
    mocks.revokeLink.mockReset();
    mocks.revokeLink.mockResolvedValue({ success: true });
    mocks.useOrgInvitations.mockReset();
    mocks.useOrgInviteLinks.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("preserves organization, project, and conversation query scopes exactly", async () => {
    await act(async () => {
      root.render(
        <InvitationHarness scope={{ kind: "organization", orgId: "org-1" }} />,
      );
    });
    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith("org-1", null, null);

    await act(async () => {
      root.render(
        <InvitationHarness
          scope={{ kind: "project", orgId: "org-1", projectId: "project-1" }}
        />,
      );
    });
    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith(
      "org-1",
      "project-1",
      null,
    );

    await act(async () => {
      root.render(
        <InvitationHarness
          scope={{
            kind: "conversation",
            orgId: "org-1",
            projectId: "project-1",
            conversationId: "conversation-1",
          }}
        />,
      );
    });
    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith(
      "org-1",
      "project-1",
      "conversation-1",
    );
  });

  it("disables an incomplete project scope instead of falling back to organization invites", async () => {
    await act(async () => {
      root.render(
        <InvitationHarness
          scope={{ kind: "project", orgId: "org-1", projectId: " " }}
        />,
      );
    });

    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith(null, null, null);
  });

  it("maps a successful creation response to the shared prepared-invite shape", async () => {
    mocks.createInvitation.mockResolvedValue({
      success: true,
      acceptUrl: "https://instafy.dev/invite?token=email-token",
      invitation: {
        createdAt: "2026-07-16T08:00:00.000Z",
        email: "person@example.com",
        id: "invitation-1",
        orgId: "org-1",
        role: "builder",
        status: "pending",
      },
    });
    await act(async () => {
      root.render(
        <InvitationHarness
          scope={{ kind: "project", orgId: "org-1", projectId: "project-1" }}
        />,
      );
    });

    const result = await invitationActions?.prepareEmailInvite(
      "person@example.com",
      "builder",
    );

    expect(result).toEqual({
      success: true,
      invitation: expect.objectContaining({ id: "invitation-1" }),
      preparedInvite: {
        acceptUrl: "https://instafy.dev/invite?token=email-token",
        email: "person@example.com",
        role: "builder",
      },
    });
  });

  it("turns an incomplete creation response into the existing secure-link error", async () => {
    mocks.createInvitation.mockResolvedValue({
      success: true,
      invitation: {
        createdAt: "2026-07-16T08:00:00.000Z",
        email: "person@example.com",
        id: "invitation-1",
        orgId: "org-1",
        role: "viewer",
        status: "pending",
      },
    });
    await act(async () => {
      root.render(
        <InvitationHarness scope={{ kind: "organization", orgId: "org-1" }} />,
      );
    });

    await expect(
      invitationActions?.prepareEmailInvite("person@example.com", "viewer"),
    ).resolves.toEqual({
      success: false,
      error: "The server did not return a secure invite link. Try again.",
    });
  });

  it("reuses an active link with the requested role without rotating it", async () => {
    const existing = createLink();
    mocks.refreshInviteLinks.mockResolvedValue([existing]);
    await act(async () => {
      root.render(
        <InviteLinkHarness
          scope={{ kind: "project", orgId: "org-1", projectId: "project-1" }}
        />,
      );
    });

    await expect(inviteLinkActions?.ensureInviteLink("builder")).resolves.toEqual({
      success: true,
      link: existing,
      rotated: false,
    });
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("rotates the exact link scope when the requested role differs", async () => {
    const existing = createLink({ role: "viewer" });
    const replacement = createLink({ id: "link-2", role: "builder" });
    mocks.refreshInviteLinks.mockResolvedValue([existing]);
    mocks.createLink.mockResolvedValue({ success: true, link: replacement });
    await act(async () => {
      root.render(
        <InviteLinkHarness
          scope={{
            kind: "conversation",
            orgId: "org-1",
            projectId: "project-1",
            conversationId: "conversation-1",
          }}
        />,
      );
    });

    await expect(inviteLinkActions?.ensureInviteLink("builder")).resolves.toEqual({
      success: true,
      link: replacement,
      rotated: true,
    });
    expect(mocks.useOrgInviteLinks).toHaveBeenLastCalledWith(
      "org-1",
      "project-1",
      "conversation-1",
    );
    expect(mocks.createLink).toHaveBeenCalledWith("builder");
  });

  it("updates a pending invitation's role through the scoped action", async () => {
    await act(async () => {
      root.render(
        <InvitationHarness scope={{ kind: "organization", orgId: "org-1" }} />,
      );
    });

    await expect(
      invitationActions?.updatePendingInvitationRole("invitation-1", "admin"),
    ).resolves.toEqual({ success: true });
    expect(mocks.updateInvitationRole).toHaveBeenCalledWith("invitation-1", "admin");
  });

  it("relays the server's reason when a role update is rejected", async () => {
    // The message matters: owner-gating and expiry must surface as
    // themselves, not as a generic failure.
    mocks.updateInvitationRole.mockResolvedValue({
      success: false,
      error: "Only organization owners can assign the owner role.",
    });
    await act(async () => {
      root.render(
        <InvitationHarness scope={{ kind: "organization", orgId: "org-1" }} />,
      );
    });

    await expect(
      invitationActions?.updatePendingInvitationRole("invitation-1", "owner"),
    ).resolves.toEqual({
      success: false,
      error: "Only organization owners can assign the owner role.",
    });
  });

  it("keeps conversation identity in resolved invite URLs", () => {
    const scope = {
      kind: "conversation",
      orgId: "org-1",
      projectId: "project-1",
      conversationId: "conversation-1",
    } as const;

    const url = new URL(resolveInviteLinkUrl(scope, "/invite?token=token-1"));

    expect(url.searchParams.get("token")).toBe("token-1");
    expect(url.searchParams.get("conversationControllerId")).toBe("conversation-1");
  });

  it("recognizes only roles allowed by each scope", () => {
    expect(isProjectInviteRole("viewer")).toBe(true);
    expect(isProjectInviteRole("admin")).toBe(false);
    expect(isOrganizationInviteRole("admin")).toBe(true);
    expect(isOrganizationInviteRole("owner")).toBe(true);
    expect(isOrganizationInviteRole("unknown")).toBe(false);
  });
});
