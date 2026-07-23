import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../runtimeController/core", () => ({
  controllerBaseUrl: "http://controller.test",
  normalizeUuidParam: (value: string | null | undefined) => value ?? null,
  readControllerError: readControllerErrorMock,
  resolveControllerAccessToken: resolveControllerAccessTokenMock,
  runtimeControllerEnabled: true,
}));

import {
  acceptControllerOrgInvitation,
  createControllerOrgInvitationStrict,
  createControllerOrgInviteLink,
  listControllerOrgInviteLinks,
} from "../runtimeController/projects";

describe("createControllerOrgInvitationStrict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resolveControllerAccessTokenMock.mockReset();
    readControllerErrorMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
    readControllerErrorMock.mockResolvedValue("Unable to send invitation");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts invitations successfully", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        acceptUrl: "https://instafy.dev/invite?token=invite-1",
        invitation: {
          id: "invite-1",
          email: "teammate@instafy.dev",
          role: "builder",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createControllerOrgInvitationStrict({
        orgId: "org-1",
        email: "teammate@instafy.dev",
      }),
    ).resolves.toMatchObject({
      id: "invite-1",
      email: "teammate@instafy.dev",
      role: "builder",
      acceptUrl: "https://instafy.dev/invite?token=invite-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.body).toBe(JSON.stringify({ email: "teammate@instafy.dev" }));
  });

  it("posts project-scoped invitations when projectId is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        acceptUrl: "https://instafy.dev/invite?token=invite-2",
        invitation: {
          id: "invite-2",
          email: "guest@instafy.dev",
          role: "viewer",
          projectId: "project-1",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createControllerOrgInvitationStrict({
        orgId: "org-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        email: "guest@instafy.dev",
        role: "viewer",
      }),
    ).resolves.toMatchObject({
      id: "invite-2",
      email: "guest@instafy.dev",
      role: "viewer",
      projectId: "project-1",
      acceptUrl: "https://instafy.dev/invite?token=invite-2",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.body).toBe(
      JSON.stringify({
        email: "guest@instafy.dev",
        role: "viewer",
        projectId: "project-1",
        conversationId: "conversation-1",
      }),
    );
  });

  it("binds project share links to the requested private conversation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        inviteLink: {
          id: "link-1",
          projectId: "project-1",
          conversationId: "conversation-1",
          role: "viewer",
          acceptPath: "/invite?token=token-1",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createControllerOrgInviteLink({
        orgId: "org-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        role: "viewer",
      }),
    ).resolves.toMatchObject({ id: "link-1", conversationId: "conversation-1" });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.body).toBe(
      JSON.stringify({
        role: "viewer",
        projectId: "project-1",
        conversationId: "conversation-1",
      }),
    );
  });

  it("lists only links for the requested private conversation scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ inviteLinks: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await listControllerOrgInviteLinks({
      orgId: "org-1",
      projectId: "project-1",
      conversationId: "conversation-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("projectId=project-1");
    expect(url).toContain("conversationId=conversation-1");
  });

  it("returns the server-bound project and conversation after acceptance", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        orgId: "org-1",
        orgSlug: "team-one",
        orgName: "Team One",
        role: "viewer",
        projectId: "project-1",
        conversationId: "conversation-1",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(acceptControllerOrgInvitation({ token: "invite-token" })).resolves.toEqual({
      orgId: "org-1",
      orgSlug: "team-one",
      orgName: "Team One",
      role: "viewer",
      projectId: "project-1",
      conversationId: "conversation-1",
    });
  });

  it("fails fast when invitation creation hangs", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = createControllerOrgInvitationStrict({
      orgId: "org-1",
      email: "teammate@instafy.dev",
    }).then(
      () => null,
      (error) => error,
    );

    await vi.advanceTimersByTimeAsync(12_000);

    await expect(result).resolves.toMatchObject({
      message: "Invitation request timed out. Try again.",
    });
  });
});
