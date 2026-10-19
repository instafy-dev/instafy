import { useEffect, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ThemeProvider, useTheme } from "../../../src/theme/ThemeProvider";
import { Button } from "../../../src/components/Button";
import { Text } from "../../../src/components/Text";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { SettingsShell } from "../../../src/screens/studio/components/SettingsShell";
import { HistoryConfirmDialog } from "../../../src/screens/studio/components/HistoryConfirmDialog";
import { AgentProfileModal } from "../../../src/screens/studio/components/AgentProfileModal";
import { ComposerInviteModal } from "../../../src/screens/studio/components/ComposerInviteModal";
import { StudioNewChatButton } from "../../../src/screens/studio/components/StudioNewChatButton";
import { StudioRecentSpaces } from "../../../src/screens/studio/components/StudioRecentSpaces";
import { MobileStudioNavigationHeader } from "../../../src/screens/studio/components/MobileStudioNavigationHeader";
import { OrgMembersSettingsSections } from "../../../src/screens/studio/components/OrgMembersSettingsSections";
import { members, reportAction } from "./adapters";
import "../../../src/styles/tailwind.css";

const params = new URLSearchParams(location.search);
const spaces = ["Product", "Design", "Documentation", "Experiments", "Marketing", "Research", "Support", "Team planning"].map((name, index) => ({ id: `space-${index}`, name }));
const noAction = () => {};
const reviewInvitations = [{ id: "review-pending", orgId: "review-org", email: "documentation-review@example.test", role: "builder", status: "pending", createdAt: "2026-10-01T00:00:00Z" }];
const reviewMembers = members.slice(1, 3);

function Feedback() {
  const [scenario, setScenario] = useState(params.get("scenario") ?? "conflict");
  const [email, setEmail] = useState(params.has("long") ? "documentation-and-accessibility-review@example.test" : "review@example.test");
  const [role, setRole] = useState("admin");
  const [query, setQuery] = useState("");
  const [cancelPending, setCancelPending] = useState<string | null>(null);
  const [removePending, setRemovePending] = useState<string | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const populated = scenario === "members";
  const record = (action: string) => { setActions(previous => [...previous, action]); reportAction(`${action} selected in local review.`); };
  const props: ComponentProps<typeof OrgMembersSettingsSections> = {
    currentUserId: "review-user", canManageOrgMembers: true, canManageOwners: false,
    inviteEmail: email, inviteRole: role, invitePending: scenario === "pending", inviteError: null,
    inviteEmailValid: email.includes("@"), preparedEmailInvite: null,
    onInviteEmailChange: setEmail, onInviteRoleChange: setRole, onInviteMember: () => setScenario("conflict"),
    invitationsCountLabel: populated ? "1" : "0", invitationsError: scenario === "error" ? "Invitations could not be loaded. Try again later." : null,
    invitationsLoading: scenario === "loading", invitations: populated ? reviewInvitations : [], sortedInvitations: populated ? reviewInvitations : [], inviteCancelPendingId: cancelPending,
    onCancelInvite: id => { setCancelPending(id); record("Cancel invitation"); }, inviteRoleUpdatePendingId: null, onPendingInviteRoleChange: noAction,
    inviteRoleConflict: scenario === "conflict" || scenario === "pending" ? { invitationId: "review-invite", email, existingRole: "builder", requestedRole: "admin" } : null,
    inviteConflictPending: scenario === "pending", onApplyInviteRoleConflict: () => { reportAction("Invitation role changed in local review."); setScenario("empty"); }, onDismissInviteRoleConflict: () => setScenario("empty"),
    membersCountLabel: populated ? "2" : "0", memberQuery: query, onMemberQueryChange: setQuery,
    membersLoading: scenario === "loading", membersLoadingMore: false, members: populated ? reviewMembers : [], sortedMembers: populated ? reviewMembers.filter(member => `${member.fullName} ${member.email}`.toLowerCase().includes(query.toLowerCase())) : [], membersHasMore: false,
    onLoadMoreMembers: noAction, memberUpdatePendingId: null, memberRemovePendingId: removePending, onRoleChange: noAction, onRemoveMember: id => { setRemovePending(id); record("Remove member"); },
  };
  return <SettingsShell title="Team members" width="comfortable">
    <div className="mb-6 flex flex-wrap gap-2" data-testid="feedback-scenarios">{["conflict", "pending", "error", "loading", "empty", "members"].map(value => <Button key={value} size="sm" variant={scenario === value ? "secondary" : "ghost"} elevation="none" onPress={() => { setScenario(value); setCancelPending(null); setRemovePending(null); setActions([]); }}>{value[0].toUpperCase() + value.slice(1)}</Button>)}</div>
    <OrgMembersSettingsSections {...props} />
    <output className="sr-only" data-testid="feedback-action-count">{actions.length}</output>
  </SettingsShell>;
}

function Navigation() {
  const [activeSpace, setActiveSpace] = useState("space-0");
  const [expanded, setExpanded] = useState(false);
  return <SettingsShell title="Navigation" width="comfortable">
    <div className="space-y-8">
      <section className="space-y-3"><Text as="h2" variant="bodyStrong">Chat creation</Text><StudioNewChatButton /></section>
      <section className="space-y-3"><Text as="h2" variant="bodyStrong">Space picker</Text>
        <StudioRecentSpaces spaces={spaces} teamName="Workshop" recency={{ "space-0": 1 }} activeProjectId={activeSpace}
          onSelectSpace={setActiveSpace} onBrowseAll={() => reportAction("Browse all spaces selected in local review.")}
          collapsed={false} expanded={expanded} onExpandedChange={setExpanded} presentation="path"
          rowClassName="flex items-center gap-2" iconClassName="h-5 w-5" />
      </section>
      <section className="space-y-3"><Text as="h2" variant="bodyStrong">Compact navigation</Text>
        <div className="max-w-md"><MobileStudioNavigationHeader title="Project planning" spaceName="Product" teamName="Workshop"
          history={{ canGoBack: true, canGoForward: false, goBack: () => reportAction("Back selected in local review."), goForward: noAction }} historyInMenu
          onOpenPicker={() => reportAction("Space navigation selected in local review.")}
          onNewChat={() => reportAction("Public chat selected in local review.")}
          onNewPrivateChat={() => reportAction("Private chat selected in local review.")}
          onOpenSettings={() => reportAction("Space settings selected in local review.")} /></div>
      </section>
    </div>
  </SettingsShell>;
}

function Review() {
  const [panel, setPanel] = useState(params.get("panel") ?? "dialogs");
  const [dialog, setDialog] = useState<string | null>(null);
  const [name, setName] = useState("Writing assistant");
  const [handle, setHandle] = useState("writer");
  const [bio, setBio] = useState("Helps the team prepare concise documentation and review drafts.");
  const [guidance, setGuidance] = useState("Keep replies concise and practical.");
  const [pending, setPending] = useState(false);
  const [provider, setProvider] = useState<"openai" | "gemini">("openai");
  const [credential, setCredential] = useState("credential-1");
  const [model, setModel] = useState<string | null>("review-model");
  const [status, setStatus] = useState("");
  const [inviteBusyUser, setInviteBusyUser] = useState<string | null>(null);
  const { resolvedTheme, setThemeMode } = useTheme();
  useEffect(() => { const listener = (event: Event) => setStatus((event as CustomEvent<string>).detail); window.addEventListener("review:status", listener); return () => window.removeEventListener("review:status", listener); }, []);
  const save = () => { setPending(true); window.setTimeout(() => { setPending(false); setDialog(null); setStatus("Agent saved in local review."); }, 400); };
  return <main className="min-h-dvh bg-white text-slate-700 dark:bg-[var(--color-studio-dark-canvas)] dark:text-slate-100">
    <header className="space-y-2 border-b border-slate-200 p-3 sm:px-6 dark:border-[var(--color-studio-dark-divider)]">
      <div className="flex flex-wrap items-center justify-between gap-2"><Text as="h1" variant="bodyStrong" tone="primary">Dialogs and feedback review</Text><SegmentedControl aria-label="Theme" value={resolvedTheme} size="xs" width="fit" onChange={value => setThemeMode(value as "light" | "dark")} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /></div>
      <div className="flex flex-wrap gap-2">{["dialogs", "navigation", "feedback"].map(value => <Button key={value} size="sm" variant={panel === value ? "secondary" : "ghost"} elevation="none" onPress={() => setPanel(value)}>{value[0].toUpperCase() + value.slice(1)}</Button>)}</div>
      <Text variant="caption" tone="muted">Production components with local sample data. No messages, invitations or external requests are sent.</Text>
    </header>
    {panel === "actions" ? <SettingsShell title="Shared text action presets" width="comfortable"><div className="flex flex-wrap items-start gap-3">
      <Button preset="inline" variant="text" data-testid="text-inline-preset" onPress={() => reportAction("Inline text action selected in local review.")}>Inline text action</Button>
      <Button preset="form" variant="text" data-testid="text-form-preset" onPress={() => reportAction("Form text action selected in local review.")}>Form text action</Button>
    </div></SettingsShell> : panel === "feedback" ? <Feedback /> : panel === "navigation" ? <Navigation /> : <SettingsShell title="Dialogs" width="comfortable"><div className="flex flex-wrap gap-3">
      <Button onPress={() => setDialog("history")} data-testid="open-history">Remove history entry</Button>
      <Button onPress={() => setDialog("agent")} data-testid="open-agent">Edit agent</Button>
      <Button onPress={() => setDialog("invite")} data-testid="open-invite">Invite to chat</Button>
    </div></SettingsShell>}
    <Text role="status" variant="caption" className="px-4" data-testid="review-status">{status}</Text>
    <HistoryConfirmDialog isOpen={dialog === "history"} title="Remove history entry?" detail="Documentation review · version 24" body="This removes the saved history entry. Files in the current workspace are not changed." cancelLabel="Cancel" confirmLabel="Remove" destructive onCancel={() => setDialog(null)} onConfirm={() => { setDialog(null); setStatus("History removal selected in local review."); }} testId="review-history-confirm" />
    <AgentProfileModal isOpen={dialog === "agent"} mode="edit" title="Edit agent" subtitle="Update this agent's profile and behavior." pending={pending}
      handle={handle} onHandleChange={setHandle} handleRequired displayName={name} onDisplayNameChange={setName}
      avatarImageUrl="" onAvatarImageUrlChange={noAction} onAvatarFileChange={noAction} avatarSeed="review-writer"
      bio={bio} onBioChange={setBio} description={guidance} onDescriptionChange={setGuidance}
      providerId={provider} providerOptions={[{ id: "openai", label: "OpenAI" }, { id: "gemini", label: "Gemini" }]} onProviderChange={value => setProvider(value as "openai" | "gemini")}
      credentialId={credential} credentials={[{ id: "credential-1", kind: "openai_api_key", label: "Review connection", isDefault: true, revokedAt: null, lastUsedAt: null, createdAt: "", updatedAt: "", metadata: { provider: "openai" } }]} onCredentialChange={setCredential} onConnectCredential={() => reportAction("Connect selected in local review.")}
      modelId={model} modelOptions={[{ id: "review-model", label: "Review model" }, { id: "review-fast", label: "Review fast model" }]} onModelChange={setModel}
      onClose={() => setDialog(null)} onSave={save} />
    <ComposerInviteModal isOpen={dialog === "invite"} onOpenChange={open => { if (!open) setDialog(null); }}
      mentionableUsers={members.slice(1, 3)} inviteParticipantIdSet={new Set(["review-researcher"])} inviteParticipantBusyUserId={inviteBusyUser} inviteParticipantsLoading={false}
      onInviteTeammate={async member => { setInviteBusyUser(member.userId); reportAction(`Add ${member.fullName} selected in local review.`); }}
      activeConversationVisibility="private" activeConversationControllerId="review-conversation" activeOrgId="review-org" activeProjectId="review-space"
      canShareProject canWriteProject sharingPermissionsLoading={false} onOpenProjectSettings={() => reportAction("Space settings selected in local review.")} />
  </main>;
}
const router = createMemoryRouter([{ path: "*", element: <ThemeProvider><Review /></ThemeProvider> }], { initialEntries: ["/studio"] });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
