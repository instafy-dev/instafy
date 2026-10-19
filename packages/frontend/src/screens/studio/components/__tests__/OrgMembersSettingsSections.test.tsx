// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgMembersSettingsSections } from "../OrgMembersSettingsSections";

function createProps(
  overrides: Partial<ComponentProps<typeof OrgMembersSettingsSections>> = {},
): ComponentProps<typeof OrgMembersSettingsSections> {
  return {
    currentUserId: "review-user",
    canManageOrgMembers: true,
    canManageOwners: false,
    inviteEmail: "review@example.test",
    inviteRole: "admin",
    invitePending: false,
    inviteError: null,
    inviteEmailValid: true,
    preparedEmailInvite: null,
    onInviteEmailChange: vi.fn(),
    onInviteRoleChange: vi.fn(),
    onInviteMember: vi.fn(),
    invitationsCountLabel: "0",
    invitationsError: null,
    invitationsLoading: false,
    invitations: [],
    sortedInvitations: [],
    inviteCancelPendingId: null,
    onCancelInvite: vi.fn(),
    inviteRoleUpdatePendingId: null,
    onPendingInviteRoleChange: vi.fn(),
    inviteRoleConflict: null,
    inviteConflictPending: false,
    onApplyInviteRoleConflict: vi.fn(),
    onDismissInviteRoleConflict: vi.fn(),
    membersCountLabel: "0",
    memberQuery: "",
    onMemberQueryChange: vi.fn(),
    membersLoading: false,
    membersLoadingMore: false,
    members: [],
    sortedMembers: [],
    membersHasMore: false,
    onLoadMoreMembers: vi.fn(),
    memberUpdatePendingId: null,
    memberRemovePendingId: null,
    onRoleChange: vi.fn(),
    onRemoveMember: vi.fn(),
    ...overrides,
  };
}

describe("organization member feedback", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps both conflict choices in the announced notice and locks them while updating", async () => {
    const props = createProps({
      inviteRoleConflict: { invitationId: "review-invite", email: "review@example.test", existingRole: "builder", requestedRole: "admin" },
    });
    await act(async () => root.render(<OrgMembersSettingsSections {...props} />));
    const notice = container.querySelector('[data-testid="org-invite-role-conflict"]')!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("review@example.test already has a pending builder invite");
    const apply = notice.querySelector<HTMLButtonElement>('[data-testid="org-invite-role-conflict-apply"]')!;
    const keep = notice.querySelector<HTMLButtonElement>('[data-testid="org-invite-role-conflict-dismiss"]')!;
    await act(async () => { apply.click(); keep.click(); });
    expect(props.onApplyInviteRoleConflict).toHaveBeenCalledOnce();
    expect(props.onDismissInviteRoleConflict).toHaveBeenCalledOnce();
    await act(async () => root.render(<OrgMembersSettingsSections {...props} inviteConflictPending />));
    expect(apply.textContent).toBe("Updating…");
    expect(apply.disabled).toBe(true);
    expect(keep.disabled).toBe(true);
    await act(async () => { apply.click(); keep.click(); });
    expect(props.onApplyInviteRoleConflict).toHaveBeenCalledOnce();
    expect(props.onDismissInviteRoleConflict).toHaveBeenCalledOnce();
  });

  it("announces invite failures without presenting an empty-list success state", async () => {
    await act(async () => root.render(<OrgMembersSettingsSections {...createProps({
      inviteError: "This invitation could not be prepared.",
      invitationsError: "Invitations could not be loaded.",
    })} />));
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map(node => node.textContent);
    expect(alerts).toEqual(["This invitation could not be prepared.", "Invitations could not be loaded."]);
    expect(container.textContent).not.toContain("No pending invitations.");
  });

  it("announces loading separately from empty invitation and member lists", async () => {
    await act(async () => root.render(<OrgMembersSettingsSections {...createProps({ invitationsLoading: true, membersLoading: true })} />));
    expect(Array.from(container.querySelectorAll('[role="status"]')).map(node => node.textContent)).toEqual([
      "Loading invitations…", "Loading members…",
    ]);
    expect(container.textContent).not.toContain("No pending invitations.");
    expect(container.textContent).not.toContain("No people have access yet.");
  });

  it("does not expose invite feedback actions to members without management access", async () => {
    await act(async () => root.render(<OrgMembersSettingsSections {...createProps({
      canManageOrgMembers: false,
      inviteRoleConflict: { invitationId: "review-invite", email: "review@example.test", existingRole: "builder", requestedRole: "admin" },
      invitationsError: "Invitations could not be loaded.",
    })} />));
    expect(container.querySelector('[data-testid="org-invite-role-conflict"]')).toBeNull();
    expect(container.querySelector('[data-testid="org-member-invite-submit"]')).toBeNull();
    expect(container.textContent).not.toContain("Invitations could not be loaded.");
    expect(container.textContent).toContain("Only owners and admins can invite people.");
  });
});
