// Inert data boundaries only. Visible dialogs, navigation and feedback are production components.
export const reportAction = (message: string) => { window.dispatchEvent(new CustomEvent("review:status", { detail: message })); };
const ok = async () => ({ success: true });
export const members = [
  { userId: "review-user", email: "owner@example.test", fullName: "Review Owner", role: "owner", createdAt: "2026-10-01T00:00:00Z" },
  { userId: "review-teammate", email: "teammate@example.test", fullName: "Taylor Morgan", role: "builder", createdAt: "2026-10-01T00:00:00Z" },
  { userId: "review-researcher", email: "research@example.test", fullName: "Alex Rivera", role: "viewer", createdAt: "2026-10-01T00:00:00Z" },
  ...Array.from({ length: 15 }, (_, index) => ({ userId: `review-member-${index + 3}`, email: `teammate-${index + 3}@example.test`, fullName: `Team member ${String(index + 3).padStart(2, "0")}`, role: "builder", createdAt: "2026-10-01T00:00:00Z" })),
];
const projects = [
  { id: "review-space", orgId: "review-org", name: "Product" },
  { id: "review-design", orgId: "review-org", name: "Design" },
];
const auth = { user: { id: "review-user", email: "owner@example.test" }, session: null };
export const useAuth = () => auth;
export const useStatus = () => ({ showStatus: reportAction });
export const useProjects = () => ({ activeProjectId: "review-space", activeProject: projects[0], projectList: projects });
const controls = {
  showChatActions: true,
  onStartNewConversation: () => reportAction("Public chat selected in local review."),
  onStartPrivateConversation: ({ displayName }: { displayName: string }) => reportAction(`Private chat selected: ${displayName}.`),
  onOpenProjectSettings: () => reportAction("Space settings selected in local review."),
};
export const useWorkspaceControls = () => controls;
export const controllerClient = {
  organizations: { listMembers: async () => members },
  projects: { listMembers: async () => members },
};
const invitations = [{ id: "review-invitation", email: "guest@example.test", role: "viewer", status: "pending", orgId: "review-org", createdAt: "2026-10-01T00:00:00Z" }];
const links = [{ id: "review-link", role: "builder", acceptPath: "/invite/inert-review-link", createdAt: "2026-10-01T00:00:00Z" }];
const invitationActions = {
  invitations, loading: false, error: null, refresh: async () => invitations,
  createInvitation: async (email: string, role: string) => ({ success: true, invitation: { ...invitations[0], email, role }, acceptUrl: "https://review.example.test/invite/inert-email-link" }),
  cancelInvitation: ok, updateInvitationRole: ok,
};
const linkActions = {
  links, loading: false, error: null, refresh: async () => links,
  createLink: async (role: string) => ({ success: true, link: { ...links[0], role } }), revokeLink: ok,
};
export const useOrgInvitations = () => invitationActions;
export const useOrgInviteLinks = () => linkActions;
export const writeClipboardText = async () => reportAction("Copy selected in local review.");
export const canUseNearbyInviteShare = () => false;
export const isNearbyInviteShareDismissalError = () => false;
export const nearbyInviteShareRequiresPreparedUrl = () => true;
export const shareNearbyInvite = async () => reportAction("Share selected in local review.");
export const buildNearbyInviteSharePayload = async (payload: unknown) => payload;
