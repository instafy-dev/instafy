// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsSections } from "../ProjectSettingsSections";

function createProps(
  overrides: Partial<ComponentProps<typeof ProjectSettingsSections>> = {},
): ComponentProps<typeof ProjectSettingsSections> {
  return {
    activeInviteLinkRole: "builder",
    activeProjectId: "project-1",
    activeProjectName: "Demo space",
    canShareProject: true,
    canWriteProject: true,
    currentUserId: "user-1",
    inviteLinkPending: false,
    inviteLinkRole: "viewer",
    inviteLinkUrl: "https://instafy.dev/invite?token=current",
    inviteLinksError: null,
    inviteLinksLoading: false,
    onCancelProjectInvite: vi.fn(),
    onCopyInviteLink: vi.fn(),
    onCreateInviteLink: vi.fn(),
    onInviteLinkRoleChange: vi.fn(),
    onInviteProjectMember: vi.fn(),
    onProjectInviteEmailChange: vi.fn(),
    onProjectInviteRoleChange: vi.fn(),
    onProjectNameCancel: vi.fn(),
    onProjectNameChange: vi.fn(),
    onProjectNameSave: vi.fn(),
    onProjectRoleChange: vi.fn(),
    onRefreshProjectDefaults: vi.fn(),
    onRemoveProjectMember: vi.fn(),
    onRevokeInviteLink: vi.fn(),
    projectAccessPanel: "guests",
    projectDefaultsRefreshPending: false,
    projectInviteCancelPendingId: null,
    projectInviteRoleUpdatePendingId: null,
    onPendingProjectInviteRoleChange: vi.fn(),
    projectInviteRoleConflict: null,
    projectInviteConflictPending: false,
    onApplyProjectInviteRoleConflict: vi.fn(),
    onDismissProjectInviteRoleConflict: vi.fn(),
    projectInviteEmail: "",
    projectInviteEmailValid: false,
    projectInviteError: null,
    projectInvitePending: false,
    projectInviteRole: "builder",
    preparedEmailInvite: null,
    projectInvitations: [],
    projectInvitationsError: null,
    projectInvitationsLoading: false,
    projectMemberRemovePendingId: null,
    projectMemberUpdatePendingId: null,
    projectMembers: [],
    projectMembersError: null,
    projectMembersLoading: false,
    projectNameDirty: false,
    projectNameDraft: "Demo space",
    projectNameInvalid: false,
    projectNameSaving: false,
    runtimeControllerEnabled: true,
    showProjectBasics: false,
    sortedProjectInvitations: [],
    sortedProjectMembers: [],
    ...overrides,
  };
}

describe("ProjectSettingsSections", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", () => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("distinguishes the current link role from the proposed replacement", async () => {
    await act(async () => {
      root.render(<ProjectSettingsSections {...createProps()} />);
    });

    const currentLink = document.querySelector(
      '[data-testid="org-invite-link-current"]',
    );
    expect(document.body.textContent).toContain("Access for replacement link");
    expect(currentLink?.textContent).toContain("Current link · Read & write");
    expect(currentLink?.textContent).toContain("Copy current link");
    expect(
      document.querySelector<HTMLSelectElement>(
        '[data-testid="org-invite-link-role"]',
      )?.value,
    ).toBe("viewer");
  });

  it("disables project mutations for read-only members", async () => {
    await act(async () => {
      root.render(
        <ProjectSettingsSections
          {...createProps({
            canWriteProject: false,
            canShareProject: false,
            showProjectBasics: true,
          })}
        />,
      );
    });

    expect(
      document.querySelector<HTMLInputElement>('[data-testid="project-settings-name-input"]')?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="project-defaults-refresh"]')?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="project-member-invite-submit"]')?.disabled,
    ).toBe(true);
  });
});
