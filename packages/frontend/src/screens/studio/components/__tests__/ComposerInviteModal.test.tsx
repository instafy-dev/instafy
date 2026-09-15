// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerInviteModal } from "../ComposerInviteModal";

const mocks = vi.hoisted(() => ({
  cancelInvitation: vi.fn(),
  createInvitation: vi.fn(),
  createLink: vi.fn(),
  buildNearbyInviteSharePayload: vi.fn(),
  nearbyShareAvailable: false,
  refreshInviteLinks: vi.fn(),
  revokeLink: vi.fn(),
  shareNearbyInvite: vi.fn(),
  showStatus: vi.fn(),
  writeClipboardText: vi.fn(),
  invitations: [] as Array<{
    createdAt: string;
    email: string;
    id: string;
    orgId: string;
    role: string;
    status: string;
  }>,
  inviteLinks: [] as Array<{
    acceptPath: string;
    id: string;
    role: string;
  }>,
  useOrgInvitations: vi.fn(),
  useOrgInviteLinks: vi.fn(),
  nativeBackEnabled: false,
  nativeBackHandler: null as (() => void) | null,
}));

vi.mock("../../../../native/useNativeBackButtonAction", () => ({
  useNativeBackButtonAction: (enabled: boolean, onBack: () => void) => {
    mocks.nativeBackEnabled = enabled;
    mocks.nativeBackHandler = onBack;
  },
}));

vi.mock("../../../../org/useOrgInviteLinks", () => ({
  useOrgInviteLinks: (
    orgId: string | null,
    projectId: string | null,
    conversationId: string | null,
  ) => {
    mocks.useOrgInviteLinks(orgId, projectId, conversationId);
    return {
      createLink: mocks.createLink,
      links: mocks.inviteLinks,
      refresh: mocks.refreshInviteLinks,
      revokeLink: mocks.revokeLink,
    };
  },
}));

vi.mock("../../../../org/useOrgInvitations", () => ({
  useOrgInvitations: (
    orgId: string | null,
    projectId: string | null,
    conversationId: string | null,
  ) => {
    mocks.useOrgInvitations(orgId, projectId, conversationId);
    return {
      createInvitation: mocks.createInvitation,
      cancelInvitation: mocks.cancelInvitation,
      updateInvitationRole: vi.fn().mockResolvedValue({ success: true }),
      invitations: mocks.invitations,
    };
  },
}));

vi.mock("../../../../sharing/nearbyInviteShare", () => ({
  buildNearbyInviteSharePayload: mocks.buildNearbyInviteSharePayload,
  canUseNearbyInviteShare: () => mocks.nearbyShareAvailable,
  isNearbyInviteShareDismissalError: () => false,
  nearbyInviteShareRequiresPreparedUrl: () => true,
  shareNearbyInvite: mocks.shareNearbyInvite,
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
}));

vi.mock("../../../../runtime/runtimeMenuShared", () => ({
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../../../utils/publicAppUrl", () => ({
  resolvePublicAppUrl: (path: string) => `https://instafy.dev${path}`,
}));

vi.mock("react-qr-code", () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="mock-qr-code">{value}</div>
  ),
}));

function createProps(
  overrides: Partial<ComponentProps<typeof ComposerInviteModal>> = {},
): ComponentProps<typeof ComposerInviteModal> {
  return {
    activeConversationControllerId: "conversation-1",
    activeConversationVisibility: "private",
    activeOrgId: "org-1",
    activeProjectId: "project-1",
    canShareProject: true,
    canWriteProject: true,
    inviteParticipantBusyUserId: null,
    inviteParticipantIdSet: new Set(),
    inviteParticipantsLoading: false,
    isOpen: true,
    mentionableUsers: [
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "teammate@example.com",
        fullName: "Team Mate",
        role: "builder",
        userId: "user-2",
      },
    ],
    onInviteTeammate: vi.fn().mockResolvedValue(undefined),
    onOpenChange: vi.fn(),
    sharingPermissionsLoading: false,
    ...overrides,
  };
}

describe("ComposerInviteModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.inviteLinks = [];
    mocks.invitations = [];
    mocks.cancelInvitation.mockReset();
    mocks.cancelInvitation.mockResolvedValue({ success: true });
    mocks.createLink.mockReset();
    mocks.buildNearbyInviteSharePayload.mockReset();
    mocks.buildNearbyInviteSharePayload.mockImplementation(
      ({ role, url }: { role: string; url: string }) => ({ role, url }),
    );
    mocks.createInvitation.mockReset();
    mocks.createInvitation.mockResolvedValue({
      acceptUrl: "https://instafy.dev/invite?token=email-token",
      invitation: {
        createdAt: "2026-07-14T12:00:00.000Z",
        email: "teammate@example.com",
        id: "invite-email-1",
        orgId: "org-1",
        role: "builder",
        status: "pending",
      },
      success: true,
    });
    mocks.refreshInviteLinks.mockReset();
    mocks.refreshInviteLinks.mockImplementation(async () => mocks.inviteLinks);
    mocks.revokeLink.mockReset();
    mocks.revokeLink.mockResolvedValue({ success: true });
    mocks.shareNearbyInvite.mockReset();
    mocks.shareNearbyInvite.mockResolvedValue(undefined);
    mocks.showStatus.mockReset();
    mocks.writeClipboardText.mockReset();
    mocks.writeClipboardText.mockResolvedValue(undefined);
    mocks.nearbyShareAvailable = false;
    mocks.nativeBackEnabled = false;
    mocks.nativeBackHandler = null;
    mocks.useOrgInvitations.mockReset();
    mocks.useOrgInviteLinks.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps a viewer read-only while still offering a same-account device handoff", async () => {
    await act(async () => {
      root.render(
        <ComposerInviteModal
          {...createProps({ canShareProject: false, canWriteProject: false })}
        />,
      );
    });

    expect(
      document.querySelector(
        '[data-testid="composer-invite-permission-message"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="composer-invite-copy-link"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="composer-invite-email-input"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="composer-invite-nearby-show-qr"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain("Open on my other device");
    expect(document.body.textContent).toContain("grant no access");
    expect(document.body.textContent).not.toContain("Private chat");
    expect(document.body.textContent).not.toContain("Team Mate");
    expect(mocks.useOrgInviteLinks).toHaveBeenLastCalledWith(null, null, null);
    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith(null, null, null);
  });

  it("activates dark descendant styles for both always-dark invite surfaces", async () => {
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    const inviteDialog = document.querySelector<HTMLElement>(
      '[data-testid="chat-invite-modal"] [role="dialog"]',
    );
    expect(inviteDialog?.parentElement?.classList.contains("dark")).toBe(true);

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-device-handoff-show-qr"]')
        ?.click();
    });

    const qrDialog = document.querySelector<HTMLElement>(
      '[data-testid="composer-invite-nearby-qr-modal"] [role="dialog"]',
    );
    expect(qrDialog?.parentElement?.classList.contains("dark")).toBe(true);
  });

  it("shows visible confirmation after copying a same-account device link", async () => {
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-device-handoff-copy"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.writeClipboardText).toHaveBeenCalledWith(
      expect.stringMatching(
        /^https:\/\/instafy\.dev\/studio\?[^#]*projectId=project-1/,
      ),
    );
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "Device link copied.",
      "success",
      2200,
      { presentation: "confirmation" },
    );
  });

  it.each([false, true])(
    "labels the access-granting link as an invitation (ready: %s)",
    async (ready) => {
      if (ready) {
        mocks.inviteLinks = [
          { acceptPath: "/invite?token=example", id: "link-1", role: "builder" },
        ];
      }
      await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

      const copyButton = document.querySelector<HTMLElement>(
        '[data-testid="composer-invite-copy-link"]',
      );
      const linkRow = copyButton?.parentElement?.parentElement;
      expect(linkRow?.querySelector("p")?.textContent).toBe("Invite link");
      expect(linkRow?.textContent).toContain(ready ? "Ready" : "Create");
      expect(copyButton?.textContent).toBe("Copy");
    },
  );

  it("shows visible confirmation after copying an edit-access link", async () => {
    mocks.createLink.mockResolvedValue({
      link: {
        acceptPath: "/invite?token=edit-link",
        id: "link-edit",
        role: "builder",
      },
      success: true,
    });
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-invite-copy-link"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.writeClipboardText).toHaveBeenCalledWith(
      expect.stringContaining("token=edit-link"),
    );
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "Edit link copied.",
      "success",
      2200,
      { presentation: "confirmation" },
    );
  });

  it("shows visible confirmation after copying an access link from its QR sheet", async () => {
    mocks.inviteLinks = [
      { id: "link-edit", role: "builder", acceptPath: "/invite?token=qr-edit" },
    ];
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="composer-invite-nearby-show-qr"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="composer-invite-nearby-copy-from-qr"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.writeClipboardText).toHaveBeenCalledWith(
      expect.stringContaining("token=qr-edit"),
    );
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "Edit link copied.",
      "success",
      2200,
      { presentation: "confirmation" },
    );
  });

  it("adopts a one-time prepared slash-command invite and exposes its secure share actions", async () => {
    const onPreparedEmailInviteConsumed = vi.fn();
    await act(async () => {
      root.render(
        <ComposerInviteModal
          {...createProps({
            onPreparedEmailInviteConsumed,
            preparedEmailInvite: {
              acceptUrl: "https://instafy.dev/invite?token=command-token",
              email: "command@example.com",
              role: "viewer",
            },
          })}
        />,
      );
    });

    expect(document.body.textContent).toContain("Invite prepared for command@example.com");
    expect(onPreparedEmailInviteConsumed).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("command-token");

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-email-invite-copy"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.writeClipboardText).toHaveBeenCalledWith(
      "https://instafy.dev/invite?token=command-token",
    );
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "Invite link copied. Instafy has not sent an email.",
      "success",
      3500,
      { presentation: "confirmation" },
    );
  });

  it("builds a token-free same-account QR link for the active chat", async () => {
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-device-handoff-show-qr"]')
        ?.click();
    });

    const qrValue = document.querySelector('[data-testid="mock-qr-code"]')?.textContent ?? "";
    const url = new URL(qrValue);
    expect(url.protocol).toBe("instafy:");
    expect(url.hostname).toBe("studio");
    expect(url.searchParams.get("projectId")).toBe("project-1");
    expect(url.searchParams.get("conversationControllerId")).toBe("conversation-1");
    expect(url.searchParams.get("panel")).toBe("chat");
    expect(qrValue).not.toContain("token=");
    expect(qrValue).not.toContain("role=");
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("keeps the same-account device QR open when sharing permission is removed", async () => {
    const props = createProps();
    await act(async () => root.render(<ComposerInviteModal {...props} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-device-handoff-show-qr"]')
        ?.click();
    });
    expect(
      document.querySelector('[data-testid="composer-invite-nearby-qr-modal"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(<ComposerInviteModal {...props} canShareProject={false} />);
    });

    expect(
      document.querySelector('[data-testid="composer-invite-nearby-qr-modal"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="mock-qr-code"]')?.textContent).toContain(
      "projectId=project-1",
    );
  });

  it("uses Android Back to close the QR layer before the parent invite", async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(<ComposerInviteModal {...createProps({ onOpenChange })} />);
    });

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-device-handoff-show-qr"]')
        ?.click();
    });
    expect(mocks.nativeBackEnabled).toBe(true);
    expect(
      document.querySelector('[data-testid="composer-invite-nearby-qr-modal"]'),
    ).not.toBeNull();

    await act(async () => mocks.nativeBackHandler?.());
    expect(
      document.querySelector('[data-testid="composer-invite-nearby-qr-modal"]'),
    ).toBeNull();
    expect(document.querySelector('[data-testid="chat-invite-modal"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    act(() => mocks.nativeBackHandler?.());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shares a prepared device link without creating an invitation", async () => {
    mocks.nearbyShareAvailable = true;
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-device-handoff-share"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.shareNearbyInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        dialogTitle: "Open on another device",
        url: expect.stringContaining("projectId=project-1"),
      }),
    );
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it("waits for permission resolution before loading protected invite resources", async () => {
    await act(async () => {
      root.render(
        <ComposerInviteModal
          {...createProps({ sharingPermissionsLoading: true })}
        />,
      );
    });

    expect(
      document.querySelector(
        '[data-testid="composer-invite-permissions-loading"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="composer-invite-copy-link"]'),
    ).toBeNull();
    expect(mocks.useOrgInviteLinks).toHaveBeenLastCalledWith(null, null, null);
    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith(null, null, null);
  });

  it("replaces a displayed QR URL when the active invite link rotates", async () => {
    mocks.inviteLinks = [
      { id: "link-old", role: "builder", acceptPath: "/invite?token=old" },
    ];
    const props = createProps();

    await act(async () => root.render(<ComposerInviteModal {...props} />));
    expect(mocks.useOrgInviteLinks).toHaveBeenLastCalledWith(
      "org-1",
      "project-1",
      "conversation-1",
    );
    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith(
      "org-1",
      "project-1",
      "conversation-1",
    );
    const showQr = document.querySelector<HTMLElement>(
      '[data-testid="composer-invite-nearby-show-qr"]',
    );
    await act(async () => {
      showQr?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="composer-invite-nearby-url"]')
        ?.textContent,
    ).toContain("token=old");

    mocks.inviteLinks = [
      { id: "link-new", role: "builder", acceptPath: "/invite?token=new" },
    ];
    await act(async () => root.render(<ComposerInviteModal {...props} />));

    expect(
      document.querySelector('[data-testid="composer-invite-nearby-url"]')
        ?.textContent,
    ).toContain("token=new");
    expect(
      document.querySelector('[data-testid="composer-invite-nearby-url"]')
        ?.textContent,
    ).not.toContain("token=old");
  });

  it("explains that a private-chat invite grants both space and chat access", async () => {
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    expect(
      document.querySelector('[data-testid="composer-invite-scope"]')?.textContent,
    ).toBe("New people get access to this space and this private chat.");
  });

  it("prepares an unsent email invite and exposes email and copy actions", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="composer-invite-email-input"]',
    );
    const form = input?.closest("form");

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "teammate@example.com");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.focus();
    });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    });

    expect(mocks.createInvitation).toHaveBeenCalledWith(
      "teammate@example.com",
      "builder",
    );
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "Invite prepared for teammate@example.com. Instafy has not sent an email.",
      "success",
      4500,
    );
    expect(
      document.querySelector('[data-testid="composer-email-invite-prepared"]')?.textContent,
    ).toContain("Instafy has not sent an email");
    expect(document.activeElement).not.toBe(input);

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-email-invite-share"]')
        ?.click();
      await Promise.resolve();
    });
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^mailto:teammate%40example\.com\?/),
      "_blank",
      "noopener,noreferrer",
    );
    expect(String(openSpy.mock.calls[0]?.[0])).toContain("email-token");

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-email-invite-copy"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.writeClipboardText).toHaveBeenCalledWith(
      "https://instafy.dev/invite?token=email-token",
    );
  });

  it("prefers the share sheet for a prepared email invite when available", async () => {
    mocks.nearbyShareAvailable = true;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="composer-invite-email-input"]',
    );

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "teammate@example.com");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-email-invite-share"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.shareNearbyInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        dialogTitle: "Share prepared invite",
        url: "https://instafy.dev/invite?token=email-token",
      }),
    );
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("lets the inviter revoke the current scoped link", async () => {
    mocks.inviteLinks = [
      { id: "link-1", role: "builder", acceptPath: "/invite?token=current" },
    ];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-invite-revoke-link"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.revokeLink).toHaveBeenCalledWith("link-1");
  });

  it("shows and cancels pending scoped email invites", async () => {
    mocks.invitations = [
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "pending@example.com",
        id: "invitation-1",
        orgId: "org-1",
        role: "viewer",
        status: "pending",
      },
    ];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    expect(document.body.textContent).toContain("pending@example.com");
    expect(document.body.textContent).toContain("Read access");
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="composer-invite-cancel-invitation-1"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.cancelInvitation).toHaveBeenCalledWith("invitation-1");
  });

  it("does not load or enable scoped sharing before a private chat is synced", async () => {
    await act(async () =>
      root.render(
        <ComposerInviteModal
          {...createProps({ activeConversationControllerId: null })}
        />,
      ),
    );

    expect(mocks.useOrgInviteLinks).toHaveBeenLastCalledWith(null, null, null);
    expect(mocks.useOrgInvitations).toHaveBeenLastCalledWith(null, null, null);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="composer-invite-copy-link"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="composer-invite-email-input"]',
      )?.disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      "Send the first message before inviting someone to this private chat.",
    );
  });

  it("prepares a browser invite before asking for a second share gesture", async () => {
    mocks.nearbyShareAvailable = true;
    mocks.createLink.mockResolvedValue({
      link: {
        acceptPath: "/invite?token=prepared",
        id: "link-prepared",
        role: "builder",
      },
      success: true,
    });
    await act(async () => root.render(<ComposerInviteModal {...createProps()} />));

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="composer-invite-nearby-share"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.createLink).toHaveBeenCalledWith("builder");
    expect(mocks.shareNearbyInvite).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="composer-invite-nearby-qr-modal"]'),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="composer-invite-nearby-share-from-qr"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.shareNearbyInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "builder",
        url: expect.stringContaining("token=prepared"),
      }),
    );
  });
});
