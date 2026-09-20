// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSelectValue } from "../../../../test-utils/select";
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
    onRetryProjectMembers: vi.fn(),
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
      readSelectValue(document.querySelector('[data-testid="org-invite-link-role"]')),
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

  it("labels invite fields and locks their drafts while preparing an invite", async () => {
    const props = createProps();
    await act(async () => root.render(<ProjectSettingsSections {...props} />));
    const email = container.querySelector<HTMLInputElement>('[data-testid="project-member-invite-email"]')!;
    const access = container.querySelector<HTMLSelectElement>('[data-testid="project-member-invite-role"]')!;
    const linkRole = container.querySelector<HTMLSelectElement>('[data-testid="org-invite-link-role"]')!;
    expect(email.labels?.[0]?.textContent).toBe("Email");
    expect(access.labels?.[0]?.textContent).toBe("Access");
    expect(linkRole.labels?.[0]?.textContent).toBe("Access for replacement link");
    expect(email.disabled).toBe(false);
    await act(async () => root.render(<ProjectSettingsSections {...props} projectInvitePending />));
    expect(email.disabled).toBe(true);
    expect(access.disabled).toBe(true);
    await act(async () => root.render(<ProjectSettingsSections {...props} canShareProject={false} />));
    expect(email.disabled).toBe(true);
    expect(access.disabled).toBe(true);
  });

  it("labels the space name and gates submit/cancel while retaining keyboard reset", async () => {
    const props = createProps({ showProjectBasics: true, activeProjectId: null, projectNameDirty: true });
    await act(async () => root.render(<ProjectSettingsSections {...props} />));
    const input = container.querySelector<HTMLInputElement>('[data-testid="project-settings-name-input"]')!;
    expect(input.labels?.[0]?.textContent).toBe("Name");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(props.onProjectNameCancel).toHaveBeenCalledOnce();
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onProjectNameSave).toHaveBeenCalledOnce();
    await act(async () => root.render(<ProjectSettingsSections {...props} projectNameInvalid />));
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onProjectNameSave).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="project-settings-name-save"]')?.disabled).toBe(true);
  });

  it("keeps guest rows visible while refreshing the same space", async () => {
    const members = [{ userId: "guest-1", email: "guest@example.com", fullName: "A guest", role: "viewer", createdAt: "2026-09-06" }];
    await act(async () => root.render(<ProjectSettingsSections {...createProps({
      projectMembers: members,
      sortedProjectMembers: members,
      projectMembersLoading: true,
    })} />));

    const guests = container.querySelector('[data-testid="project-guests-section"]');
    expect(guests?.textContent).toContain("A guest");
    expect(guests?.querySelector('[role="status"]')?.textContent).toBe("Refreshing guests…");
    expect(guests?.textContent).not.toContain("No guests have accepted access yet");
  });

  it("shows a guest load error with Retry instead of an empty state", async () => {
    const onRetryProjectMembers = vi.fn();
    await act(async () => root.render(<ProjectSettingsSections {...createProps({
      projectMembersError: "Unable to load guests.", onRetryProjectMembers,
    })} />));

    const guests = container.querySelector('[data-testid="project-guests-section"]');
    expect(guests?.querySelector('[role="alert"]')?.textContent).toBe("Unable to load guests.");
    expect(guests?.textContent).not.toContain("No guests have accepted access yet");
    const retry = [...guests!.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    await act(async () => retry!.click());
    expect(onRetryProjectMembers).toHaveBeenCalledOnce();
  });
});
