import { useEffect, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "../../../src/theme/ThemeProvider";
import { Text } from "../../../src/components/Text";
import { ProjectSettingsSections } from "../../../src/screens/studio/components/ProjectSettingsSections";
import { NotificationPreferencesSettings } from "../../../src/notifications/NotificationPreferencesSettings";
import { PersonalAppearanceSettings } from "../../../src/screens/studio/components/PersonalAppearanceSettings";
import { NotificationsNudgeBubble } from "../../../src/screens/studio/components/NotificationsNudgeBubble";
import { reportAction } from "./adapters";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "invite-conflict";
localStorage.setItem("instafy.themeMode", params.get("theme") === "dark" ? "dark" : "light");
const invitedEmail = "alexandria.montgomery@example.test";
const invitations = [
  { id: "pending-1", orgId: "review-org", email: invitedEmail, role: "viewer", status: "pending", createdAt: "2026-10-20T12:00:00Z", expiresAt: "2026-11-20T12:00:00Z" },
  { id: "pending-2", orgId: "review-org", email: "sam@example.test", role: "builder", status: "pending", createdAt: "2026-10-20T12:00:00Z" },
];
const members = [{ userId: "review-guest", email: "taylor@example.test", fullName: "Taylor Chen", role: "builder", createdAt: "2026-10-19T12:00:00Z" }];

function InvitationReview() {
  const [email, setEmail] = useState(invitedEmail);
  const [role, setRole] = useState("builder");
  const [conflict, setConflict] = useState(surface === "invite-conflict");
  const [pending, setPending] = useState(surface === "invite-pending");
  const [prepared, setPrepared] = useState(surface === "invite-prepared");
  const [error, setError] = useState(surface === "invite-error");
  const [rows, setRows] = useState(invitations);
  const props: ComponentProps<typeof ProjectSettingsSections> = {
    activeInviteLinkRole: "builder", activeProjectId: "review-project", activeProjectName: "Review space",
    canShareProject: true, canWriteProject: true, currentUserId: "review-self",
    inviteLinkPending: false, inviteLinkRole: "viewer", inviteLinkUrl: "https://example.test/invite/inert",
    inviteLinksError: null, inviteLinksLoading: false,
    onCancelProjectInvite: (id) => setRows((old) => old.filter((row) => row.id !== id)),
    onCopyInviteLink: () => reportAction("Copy link selected."), onCreateInviteLink: () => reportAction("Create link selected."),
    onInviteLinkRoleChange: () => reportAction("Link access changed."),
    onInviteProjectMember: () => { setPending(true); setTimeout(() => { setPending(false); setPrepared(true); }, 650); },
    onProjectInviteEmailChange: setEmail, onProjectInviteRoleChange: setRole,
    onProjectNameCancel: () => {}, onProjectNameChange: () => {}, onProjectNameSave: () => {},
    onProjectRoleChange: () => reportAction("Guest access changed."), onRefreshProjectDefaults: () => {},
    onRemoveProjectMember: () => reportAction("Remove guest selected."), onRevokeInviteLink: () => reportAction("Revoke link selected."),
    projectAccessPanel: "guests", projectDefaultsRefreshPending: false,
    projectInviteCancelPendingId: null, projectInviteRoleUpdatePendingId: null,
    onPendingProjectInviteRoleChange: (id, nextRole) => setRows((old) => old.map((row) => row.id === id ? { ...row, role: nextRole } : row)),
    projectInviteRoleConflict: conflict ? { invitationId: "pending-1", existingRole: "viewer", requestedRole: "builder", email } : null,
    projectInviteConflictPending: false,
    onApplyProjectInviteRoleConflict: () => { setConflict(false); reportAction("Pending invite changed to builder."); },
    onDismissProjectInviteRoleConflict: () => { setConflict(false); reportAction("Kept the existing viewer invite."); },
    projectInviteEmail: email, projectInviteEmailValid: email.includes("@"), projectInviteError: error ? "This invitation could not be prepared. Please try again." : null,
    projectInvitePending: pending, projectInviteRole: role,
    preparedEmailInvite: prepared ? { email, role, acceptUrl: "https://example.test/invite/inert" } : null,
    projectInvitations: rows, sortedProjectInvitations: rows,
    projectInvitationsError: error ? "Unable to load pending invitations. Please try again." : null,
    projectInvitationsLoading: false,
    projectMemberRemovePendingId: null, projectMemberUpdatePendingId: null,
    projectMembers: members, sortedProjectMembers: members,
    projectMembersError: error ? "Unable to refresh guests. Please try again." : null,
    onRetryProjectMembers: () => setError(false), projectMembersLoading: false,
    projectNameDirty: false, projectNameDraft: "Review space", projectNameInvalid: false,
    projectNameSaving: false, runtimeControllerEnabled: true, showProjectBasics: false,
  };
  return <ProjectSettingsSections {...props} />;
}

function NudgeReview() {
  const [attempt, setAttempt] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return <Text role="status">Notification prompt dismissed.</Text>;
  return <NotificationsNudgeBubble
    title="Enable notifications for new assistant messages?"
    onDismiss={() => setDismissed(true)}
    onEnable={async () => {
      setAttempt((value) => value + 1);
      if (surface === "nudge-pending") return new Promise<boolean>(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 650));
      if (surface === "nudge-error" && attempt === 0) throw new Error("Permission could not be requested. Check your browser settings and try again.");
      return true;
    }}
  />;
}

function Review() {
  const [action, setAction] = useState("");
  useEffect(() => {
    const listener = (event: Event) => setAction((event as CustomEvent<string>).detail);
    window.addEventListener("settings-review-action", listener);
    return () => window.removeEventListener("settings-review-action", listener);
  }, []);
  return <main className="review-page @container/settings-content" data-testid="settings-review" data-surface={surface}>
    {surface.startsWith("invite-") ? <InvitationReview />
      : surface === "appearance" ? <PersonalAppearanceSettings />
        : surface.startsWith("notifications") ? <NotificationPreferencesSettings userId="review-user" accessToken="inert-review-token" />
          : <NudgeReview />}
    <Text variant="caption" tone="muted" role="status" className="mt-4" data-testid="review-action">{action}</Text>
  </main>;
}

createRoot(document.getElementById("root")!).render(<ThemeProvider><Review /></ThemeProvider>);
