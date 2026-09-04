import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Coins, Cpu, Group, NavArrowDown, Settings, Xmark } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Checkbox } from "../../../components/Checkbox";
import { EntityRow } from "../../../components/EntityRow";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { useAuth } from "../../../providers/AuthProvider";
import { useProjects } from "../../../projects/useProjects";
import { useProject } from "../../../projects/useProject";
import { useProjectMembers } from "../../../projects/useProjectMembers";
import { useOrgMembers } from "../../../org/useOrgMembers";
import {
  isOrganizationInviteRole,
  isProjectInviteRole,
  type OrganizationInviteRole,
  type OrgInvitationRoleConflict,
  type OrganizationInviteScope,
  type ProjectInviteRole,
  type ProjectInviteScope,
  useScopedInvitationActions,
  useScopedInviteLinkActions,
} from "../../../org/useInviteActions";
import { getOrgDisplayName, isPersonalOrgName } from "../../../org/orgNaming";
import { useStatus } from "../../../status/useStatus";
import { ProfileEditor } from "../../../profile/ProfileEditor";
import { SettingsSection } from "./SettingsSection";
import { OrgAvatarEditor } from "./OrgAvatarEditor";
import { OrgMembersSettingsSections } from "./OrgMembersSettingsSections";
import {
  ProjectAiOverridesSettings,
  listProjectAiOverrideItems,
} from "./ProjectAiOverridesSettings";
import { ProjectSettingsSections } from "./ProjectSettingsSections";
import { SettingsSurface } from "./SettingsSurface";
import { SettingsShell, type SettingsCategory } from "./SettingsShell";
import {
  getGitAutoSyncAfterApplyPreference,
  setGitAutoSyncAfterApplyPreference,
} from "../../../conversations/gitAutoSyncPreference";
import { type ProjectSpeechMode } from "../../../voice/speechPreference";
import { useProjectSpeechCapabilityState } from "../../../voice/useProjectSpeechCapabilityState";
import { useProjectSpeechPreferencesState } from "../../../voice/useProjectSpeechPreferencesState";
import { useDesktopSpeechHostState } from "../../../voice/useDesktopSpeechHostState";
import { useHostAudioDiagnostics } from "../../../audio/useHostAudioDiagnostics";
import { useHostMicrophonePermissionAction } from "../../../audio/useHostMicrophonePermissionAction";
import { useHostAudioSessionState } from "../../../audio/useHostAudioSessionState";
import { controllerBaseUrl } from "../../../services/runtimeController/core";
import {
  isLocalProviderHostUnavailableOnThisClient,
  listLocalProviders,
  type LocalProviderSummary,
} from "../../../capabilities/localProviderHostClient";
import type { SettingsTab, StudioPanel } from "../types";
import { controllerClient } from "../../../sdk/instafy";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import { suppressProjectAutoCreate } from "../../../projects/projectAutoCreate";
import {
  desktopSpeechTunnelBridgeAvailable,
} from "../../../desktop/voiceTunnel/client";
import { desktopVoiceHostBridgeAvailable } from "../../../desktop/voiceHost/client";
import { listProviderSettingsSurfaceEntries } from "../../../providers/providerSettingsSurfaces";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";
import {
  buildProjectSettingsCategorySearch,
  resolveProjectSettingsCategory,
  type ProjectSettingsCategory,
} from "../settingsRoute";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import { isLikelyInviteEmail } from "../../../conversations/inviteCommand";

const runtimeControllerEnabled = controllerClient.core.enabled;

interface SettingsPanelProps {
  activeTab: SettingsTab;
}

export function SettingsPanel({ activeTab }: SettingsPanelProps) {
  const isLargeScreen = useStudioDesktopLayout();
  const { user } = useAuth();
  const {
    projectList,
    activeProjectId,
    switchProject,
    renameProject,
    removeProject,
    removeProjectsByOrgId,
  } = useProjects();
  const {
    projectCapabilitiesResolved,
    canWriteProject: serverCanWriteProject,
    canShareProject: serverCanShareProject,
    canManageProject: serverCanManageProject,
  } = useProject();
  const { showStatus } = useStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationInviteRole>("builder");
  const [invitePending, setInvitePending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [preparedOrgEmailInvite, setPreparedOrgEmailInvite] =
    useState<PreparedEmailInvite | null>(null);
  const [inviteCancelPendingId, setInviteCancelPendingId] = useState<string | null>(null);
  const [inviteRoleUpdatePendingId, setInviteRoleUpdatePendingId] = useState<string | null>(null);
  const [inviteRoleConflict, setInviteRoleConflict] = useState<
    (OrgInvitationRoleConflict & { email: string }) | null
  >(null);
  const [projectInviteRoleConflict, setProjectInviteRoleConflict] = useState<
    (OrgInvitationRoleConflict & { email: string }) | null
  >(null);
  const [inviteConflictPending, setInviteConflictPending] = useState(false);
  const [projectInviteConflictPending, setProjectInviteConflictPending] = useState(false);
  const [inviteLinkRole, setInviteLinkRole] = useState<ProjectInviteRole>("builder");
  const [inviteLinkPending, setInviteLinkPending] = useState(false);
  const [projectInviteEmail, setProjectInviteEmail] = useState("");
  const [projectInviteRole, setProjectInviteRole] = useState<ProjectInviteRole>("builder");
  const [projectInvitePending, setProjectInvitePending] = useState(false);
  const [projectInviteError, setProjectInviteError] = useState<string | null>(null);
  const [preparedProjectEmailInvite, setPreparedProjectEmailInvite] =
    useState<PreparedEmailInvite | null>(null);
  const [projectInviteCancelPendingId, setProjectInviteCancelPendingId] = useState<string | null>(null);
  const [projectInviteRoleUpdatePendingId, setProjectInviteRoleUpdatePendingId] = useState<
    string | null
  >(null);
  const [memberUpdatePendingId, setMemberUpdatePendingId] = useState<string | null>(null);
  const [memberRemovePendingId, setMemberRemovePendingId] = useState<string | null>(null);
  const [projectMemberUpdatePendingId, setProjectMemberUpdatePendingId] = useState<string | null>(null);
  const [projectMemberRemovePendingId, setProjectMemberRemovePendingId] = useState<string | null>(null);
  const [projectDeletePending, setProjectDeletePending] = useState(false);
  const [orgDeletePending, setOrgDeletePending] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projectNameSaving, setProjectNameSaving] = useState(false);
  const [projectDefaultsRefreshPending, setProjectDefaultsRefreshPending] = useState(false);
  const [settingsProviders, setSettingsProviders] = useState<LocalProviderSummary[]>([]);
  const [orgCategory, setOrgCategory] = useState<"members" | "ai" | "billing" | "danger">("members");
  const [projectCategory, setProjectCategory] = useState<ProjectSettingsCategory>(
    () => resolveProjectSettingsCategory(location.search) ?? "overview",
  );
  const [projectAiItemId, setProjectAiItemId] = useState<string | null>(null);
  const [profileCategory, setProfileCategory] = useState<"account" | "preferences">("account");
  const [gitAutoSyncAfterApply, setGitAutoSyncAfterApply] = useState<boolean>(() =>
    getGitAutoSyncAfterApplyPreference()
  );
  const settingsProvidersRequestVersionRef = useRef(0);
  const orgSelectorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const audioDiagnosticsEnabled = activeTab === "project" && projectCategory === "ai";
  const desktopVoiceHostBridgeEnabled = audioDiagnosticsEnabled && desktopVoiceHostBridgeAvailable();
  const desktopSpeechTunnelEnabled =
    audioDiagnosticsEnabled &&
    desktopSpeechTunnelBridgeAvailable() &&
    Boolean(activeProjectId?.trim()) &&
    controllerBaseUrl.trim().length > 0;
  const {
    mode: projectSpeechMode,
    providerVoiceId: projectProviderVoiceId,
    deviceVoiceId: projectDeviceVoiceId,
    source: speechPreferenceSource,
    setMode: setProjectSpeechMode,
    setProviderVoiceId: setProjectSpeechProviderVoiceId,
    setDeviceVoiceId: setProjectSpeechDeviceVoiceId,
  } = useProjectSpeechPreferencesState(activeProjectId);
  const {
    speechDependencyStatus,
    setSpeechDependencyStatus,
    providerSpeechVoices,
    browserSpeechVoices,
    providerDefaultVoiceId,
    selectedProviderVoice,
    selectedDeviceVoice,
  } = useProjectSpeechCapabilityState({
    projectId: activeProjectId,
    enabled: activeTab === "project" && projectCategory === "ai",
    providerVoiceId: projectProviderVoiceId,
    deviceVoiceId: projectDeviceVoiceId,
  });
  const {
    desktopVoiceHostStatus,
    desktopVoiceHostLifecycle,
    desktopVoiceHostToggleBusy,
    desktopVoiceHostRestarting,
    desktopVoiceHostBootstrapBusy,
    desktopVoiceHostRemoveBusy,
    desktopVoiceHostBootstrapResult,
    desktopSpeechTunnelStatus,
    desktopSpeechTunnelLifecycle,
    desktopSpeechTunnelBusy,
    handleSetDesktopVoiceHostEnabled,
    handleRestartDesktopVoiceHost,
    handleBootstrapDesktopVoiceHost,
    handleRemoveDesktopVoiceRuntime,
    handleStartDesktopSpeechTunnel,
  } = useDesktopSpeechHostState({
    projectId: activeProjectId,
    desktopVoiceHostBridgeEnabled,
    desktopSpeechTunnelEnabled,
    runtimeControllerEnabled,
    setSpeechDependencyStatus,
    showStatus,
  });
  const localProviderHostUnavailableOnThisClient = isLocalProviderHostUnavailableOnThisClient();
  const {
    value: hostAudioDiagnostics,
    loading: hostAudioDiagnosticsLoading,
    error: hostAudioDiagnosticsError,
    refresh: refreshHostAudioDiagnostics,
  } = useHostAudioDiagnostics({
    enabled: audioDiagnosticsEnabled,
    refreshIntervalMs: audioDiagnosticsEnabled ? 15000 : 0,
  });
  const {
    requesting: microphonePermissionRequesting,
    error: microphonePermissionRequestError,
    requestPermission: requestMicrophonePermission,
  } = useHostMicrophonePermissionAction({
    refresh: refreshHostAudioDiagnostics,
  });
  const { value: hostAudioSessionState } = useHostAudioSessionState({
    enabled: audioDiagnosticsEnabled,
    diagnostics: hostAudioDiagnostics,
    voiceState: "idle",
  });

  const activeProject = useMemo(
    () => projectList.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projectList]
  );
  const activeOrgId = activeProject?.orgId ?? null;
  const activeOrgName = getOrgDisplayName(activeProject?.orgName);
  const activeOrgIsPersonal = isPersonalOrgName(activeProject?.orgName);
  const orgContainerLabel = activeOrgIsPersonal ? "personal space" : "team";
  const orgDeleteLabel = activeOrgIsPersonal ? "Delete personal space" : "Delete team";
  const orgSelectOptions = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const project of projectList) {
      if (!project.orgId) {
        continue;
      }
      if (!seen.has(project.orgId)) {
        seen.set(project.orgId, {
          id: project.orgId,
          name: getOrgDisplayName(project.orgName),
        });
      }
    }
    const list = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    const nameCounts = new Map<string, number>();
    list.forEach((org) => {
      nameCounts.set(org.name, (nameCounts.get(org.name) ?? 0) + 1);
    });
    return list.map((org) => {
      if ((nameCounts.get(org.name) ?? 0) <= 1) {
        return { ...org, label: org.name };
      }
      return { ...org, label: `${org.name} • ${org.id.slice(0, 8)}` };
    });
  }, [projectList]);
  const selectedOrgOption = useMemo(
    () => orgSelectOptions.find((org) => org.id === activeOrgId) ?? null,
    [activeOrgId, orgSelectOptions],
  );
  const [orgRole, setOrgRole] = useState<string | null>(null);
  const [, setOrgRoleLoading] = useState(false);
  const [orgRoleChecked, setOrgRoleChecked] = useState(false);

  useEffect(() => {
    setProjectNameDraft(activeProject?.name ?? "");
  }, [activeProject?.name, activeProjectId]);

  const handleRequestMicrophonePermission = useCallback(async () => {
    const permission = await requestMicrophonePermission();
    if (permission === "granted") {
      showStatus("Microphone permission granted. Voice capture is ready to try again.", "success", 3200);
      return;
    }
    if (permission === "denied") {
      showStatus("Microphone permission is still denied on this device.", "warning", 3600);
      return;
    }
    if (permission === "prompt") {
      showStatus("Approve the microphone prompt on the device, then try again.", "warning", 3600);
      return;
    }
    if (permission === "unsupported") {
      showStatus("This client cannot request microphone permission automatically.", "warning", 3600);
    }
  }, [requestMicrophonePermission, showStatus]);

  useEffect(() => {
    let cancelled = false;
    const requestVersion = settingsProvidersRequestVersionRef.current + 1;
    settingsProvidersRequestVersionRef.current = requestVersion;
    if (activeTab !== "project" || projectCategory !== "ai" || localProviderHostUnavailableOnThisClient) {
      setSettingsProviders([]);
      return () => {
        cancelled = true;
      };
    }

    void listLocalProviders()
      .then((result) => {
        if (!cancelled && settingsProvidersRequestVersionRef.current === requestVersion) {
          setSettingsProviders(result.providers ?? []);
        }
      })
      .catch(() => {
        if (!cancelled && settingsProvidersRequestVersionRef.current === requestVersion) {
          setSettingsProviders([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, localProviderHostUnavailableOnThisClient, projectCategory]);

  useEffect(() => {
    let cancelled = false;
    if (!runtimeControllerEnabled || !activeOrgId) {
      setOrgRole(null);
      setOrgRoleLoading(false);
      setOrgRoleChecked(false);
      return () => {
        cancelled = true;
      };
    }

    setOrgRoleLoading(true);
    setOrgRoleChecked(false);
    controllerClient.organizations.list()
      .then((orgs) => {
        if (cancelled) {
          return;
        }
        const match = orgs.find((org) => org.id === activeOrgId) ?? null;
        const role = match?.role;
        setOrgRole(typeof role === "string" && role.trim().length > 0 ? role.trim() : null);
      })
      .finally(() => {
        if (!cancelled) {
          setOrgRoleLoading(false);
          setOrgRoleChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrgId]);

  const isOrgMember = Boolean(activeOrgId && orgRole);
  const canManageOrgMembers = orgRole === "owner" || orgRole === "admin";
  const canManageOwners = orgRole === "owner";
  const legacyCanShareProject = orgRole === "owner" || orgRole === "admin" || orgRole === "builder";
  const legacyCanManageProject = orgRole === "owner" || orgRole === "admin";
  const canWriteProject =
    projectCapabilitiesResolved === false ? false : serverCanWriteProject !== false;
  const canShareProject =
    projectCapabilitiesResolved === true
      ? serverCanShareProject === true
      : projectCapabilitiesResolved === false
        ? false
        : legacyCanShareProject;
  const canManageProject =
    projectCapabilitiesResolved === true
      ? serverCanManageProject === true
      : projectCapabilitiesResolved === false
        ? false
        : legacyCanManageProject;
  const canLoadOrgSettings = runtimeControllerEnabled && Boolean(activeOrgId) && isOrgMember;
  const canLoadProjectSettings = runtimeControllerEnabled && Boolean(activeProjectId);
  const canAttemptProjectDelete =
    runtimeControllerEnabled &&
    Boolean(activeProjectId) &&
    Boolean(user?.id) &&
    canManageProject &&
    (!activeOrgId || isOrgMember);
  const canAttemptOrgDelete = runtimeControllerEnabled && Boolean(activeOrgId) && orgRole === "owner";
  const projectNameDirty =
    Boolean(activeProjectId) &&
    projectNameDraft.trim() !== (activeProject?.name ?? "").trim();
  const projectNameInvalid = projectNameDraft.trim().length === 0;

  const showOrgMembers = activeTab === "org" && orgCategory === "members";
  const showProjectAccess =
    activeTab === "project" && projectCategory === "access";
  const showScopeHint =
    activeTab === "project" && projectCategory === "access";

  const activeCategoryId =
    activeTab === "org" ? orgCategory : activeTab === "project" ? projectCategory : profileCategory;

  const orgMembersOrgId = showOrgMembers && canLoadOrgSettings ? activeOrgId : null;
  const orgInvitesOrgId =
    showOrgMembers && runtimeControllerEnabled && Boolean(activeOrgId) && canManageOrgMembers
      ? activeOrgId
      : null;
  const projectInvitesOrgId =
    showProjectAccess &&
    runtimeControllerEnabled &&
    Boolean(activeOrgId) &&
    Boolean(activeProjectId) &&
    canShareProject
      ? activeOrgId
      : null;
  const projectInvitesProjectId = projectInvitesOrgId ? activeProjectId : null;
  const orgInviteScope = useMemo<OrganizationInviteScope | null>(
    () =>
      orgInvitesOrgId
        ? { kind: "organization", orgId: orgInvitesOrgId }
        : null,
    [orgInvitesOrgId],
  );
  const projectInviteScope = useMemo<ProjectInviteScope | null>(
    () =>
      projectInvitesOrgId && projectInvitesProjectId
        ? {
            kind: "project",
            orgId: projectInvitesOrgId,
            projectId: projectInvitesProjectId,
          }
        : null,
    [projectInvitesOrgId, projectInvitesProjectId],
  );
  const projectMembersProjectId = showProjectAccess ? activeProjectId : null;
  const {
    members,
    loading: membersLoading,
    loadingMore: membersLoadingMore,
    error: membersError,
    query: memberQuery,
    setQuery: setMemberQuery,
    hasMore: membersHasMore,
    total: membersTotal,
    refresh: refreshMembers,
    loadMore: loadMoreMembers,
    updateMemberRole,
    removeMember
  } = useOrgMembers(orgMembersOrgId);
  const {
    invitations,
    loading: invitationsLoading,
    error: invitationsError,
    refresh: refreshInvitations,
    prepareEmailInvite: prepareOrgEmailInvite,
    cancelPendingInvitation: cancelInvitation,
    updatePendingInvitationRole,
    retargetPendingInvitation,
  } = useScopedInvitationActions(orgInviteScope);
  const {
    invitations: projectInvitations,
    loading: projectInvitationsLoading,
    error: projectInvitationsError,
    refresh: refreshProjectInvitations,
    prepareEmailInvite: prepareProjectEmailInvite,
    cancelPendingInvitation: cancelProjectInvitation,
    updatePendingInvitationRole: updatePendingProjectInvitationRole,
    retargetPendingInvitation: retargetPendingProjectInvitation,
  } = useScopedInvitationActions(projectInviteScope);
  const {
    loading: inviteLinksLoading,
    error: inviteLinksError,
    refresh: refreshInviteLinks,
    currentLink: activeInviteLink,
    currentLinkUrl: inviteLinkUrl,
    rotateInviteLink,
    revokeInviteLink,
  } = useScopedInviteLinkActions(projectInviteScope);
  const {
    members: projectMembers,
    loading: projectMembersLoading,
    error: projectMembersError,
    refresh: refreshProjectMembers,
    updateMemberRole: updateProjectMemberRole,
    removeMember: removeProjectMember
  } = useProjectMembers(projectMembersProjectId);
  const inviteEmailValid = isLikelyInviteEmail(inviteEmail);
  const projectInviteEmailValid = isLikelyInviteEmail(projectInviteEmail);
  const invitationsCountLabel = `${invitations.length}`;
  const canSwitchOrg = runtimeControllerEnabled && orgSelectOptions.length > 1;

  useEffect(() => {
    setPreparedOrgEmailInvite(null);
  }, [orgInvitesOrgId]);

  useEffect(() => {
    setPreparedProjectEmailInvite(null);
  }, [projectInvitesOrgId, projectInvitesProjectId]);

  useEffect(() => {
    if (!showOrgMembers || !canLoadOrgSettings) {
      return;
    }
    if (!runtimeControllerEnabled) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refreshMembers({ force: true });
      void refreshInvitations({ force: true });
    }, 10_000);
    return () => window.clearInterval(intervalId);
  }, [canLoadOrgSettings, refreshInvitations, refreshMembers, showOrgMembers]);

  useEffect(() => {
    if (!showProjectAccess) {
      return;
    }
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!activeProjectId) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refreshProjectMembers({ force: true });
      void refreshProjectInvitations({ force: true });
      void refreshInviteLinks({ force: true });
    }, 10_000);
    return () => window.clearInterval(intervalId);
  }, [
    activeProjectId,
    refreshInviteLinks,
    refreshProjectInvitations,
    refreshProjectMembers,
    showProjectAccess,
  ]);

  const handleSelectOrg = useCallback(
    (nextOrgId: string) => {
      const trimmed = nextOrgId.trim();
      if (!trimmed || trimmed === activeOrgId) {
        return;
      }
      const nextProject = projectList.find((project) => project.orgId === trimmed) ?? null;
      if (nextProject) {
        switchProject(nextProject.id);
      }
    },
    [activeOrgId, projectList, switchProject],
  );

  const handleCancelProjectName = useCallback(() => {
    setProjectNameDraft(activeProject?.name ?? "");
  }, [activeProject?.name]);

  const handleSaveProjectName = useCallback(async () => {
    if (!activeProjectId) {
      return;
    }
    if (projectNameSaving) {
      return;
    }
    if (!canWriteProject) {
      showStatus("This space is read-only. Ask an admin for edit access.", "warning", 3500);
      return;
    }
    const trimmed = projectNameDraft.trim();
    if (!trimmed) {
      showStatus("Space name is required.", "error", 4000);
      return;
    }
    if (trimmed === (activeProject?.name ?? "").trim()) {
      return;
    }

    setProjectNameSaving(true);
    try {
      const result = await renameProject(activeProjectId, trimmed);
      if (!result.success) {
        showStatus(result.error ?? "Unable to rename space.", "error", 4000);
        return;
      }
      showStatus("Space renamed.", "success", 2500);
    } finally {
      setProjectNameSaving(false);
    }
  }, [activeProject?.name, activeProjectId, canWriteProject, projectNameDraft, projectNameSaving, renameProject, showStatus]);

  const sortedInvitations = useMemo(() => {
    return [...invitations].sort((a, b) => {
      const timestampA = Date.parse(a.createdAt);
      const timestampB = Date.parse(b.createdAt);
      if (!Number.isNaN(timestampA) && !Number.isNaN(timestampB)) {
        return timestampB - timestampA;
      }
      return 0;
    });
  }, [invitations]);

  const sortedProjectInvitations = useMemo(() => {
    return [...projectInvitations].sort((a, b) => {
      const timestampA = Date.parse(a.createdAt);
      const timestampB = Date.parse(b.createdAt);
      if (!Number.isNaN(timestampA) && !Number.isNaN(timestampB)) {
        return timestampB - timestampA;
      }
      return 0;
    });
  }, [projectInvitations]);

  const sortedMembers = useMemo(() => {
    const roleOrder: Record<string, number> = { owner: 0, admin: 1, builder: 2, viewer: 3 };
    return [...members].sort((a, b) => {
      const orderA = roleOrder[a.role] ?? 99;
      const orderB = roleOrder[b.role] ?? 99;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      const labelA = (a.fullName || a.email || a.userId).toLowerCase();
      const labelB = (b.fullName || b.email || b.userId).toLowerCase();
      return labelA.localeCompare(labelB);
    });
  }, [members]);

  const membersCountLabel = useMemo(() => {
    if (typeof membersTotal === "number") {
      return `Showing ${members.length} of ${membersTotal}`;
    }
    if (membersHasMore) {
      return `Showing ${members.length}+`;
    }
    return members.length === 1 ? "1 member" : `${members.length} members`;
  }, [members.length, membersHasMore, membersTotal]);

  const sortedProjectMembers = useMemo(() => {
    const roleOrder: Record<string, number> = { builder: 0, viewer: 1 };
    return [...projectMembers].sort((a, b) => {
      const orderA = roleOrder[a.role] ?? 99;
      const orderB = roleOrder[b.role] ?? 99;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      const labelA = (a.fullName || a.email || a.userId).toLowerCase();
      const labelB = (b.fullName || b.email || b.userId).toLowerCase();
      return labelA.localeCompare(labelB);
    });
  }, [projectMembers]);

  const handleInviteMember = useCallback(async () => {
    const trimmedEmail = inviteEmail.trim();
    if (!trimmedEmail) {
      setInviteError("Enter an email address to invite.");
      return;
    }
    setInviteError(null);
    setPreparedOrgEmailInvite(null);
    setInviteRoleConflict(null);
    setInvitePending(true);
    try {
      const result = await prepareOrgEmailInvite(trimmedEmail, inviteRole);
      if (!result.success) {
        if (result.conflict) {
          // A pending invite already holds a different role; offer the
          // in-place retarget instead of surfacing a dead-end error.
          setInviteRoleConflict({ ...result.conflict, email: trimmedEmail });
        } else {
          setInviteError(result.error);
        }
      } else {
        setPreparedOrgEmailInvite(result.preparedInvite);
        showStatus(
          `Invite prepared for ${trimmedEmail}. Instafy has not sent an email.`,
          "success",
          4500,
        );
        setInviteEmail("");
      }
    } finally {
      setInvitePending(false);
    }
  }, [inviteEmail, inviteRole, prepareOrgEmailInvite, showStatus]);

  const handleCancelInvite = useCallback(
    async (invitationId: string, label: string) => {
      if (typeof window !== "undefined") {
        const ok = window.confirm(`Cancel invitation for ${label}?`);
        if (!ok) {
          return;
        }
      }
      setInviteCancelPendingId(invitationId);
      const result = await cancelInvitation(invitationId);
      if (!result.success) {
        showStatus(result.error ?? "Unable to cancel invitation.", "error", 4000);
      } else {
        showStatus(`Canceled invitation for ${label}.`, "success", 3000);
      }
      setInviteCancelPendingId(null);
    },
    [cancelInvitation, showStatus]
  );

  const handleApplyInviteRoleConflict = useCallback(async () => {
    if (!inviteRoleConflict || !isOrganizationInviteRole(inviteRoleConflict.requestedRole)) {
      return;
    }
    setInviteConflictPending(true);
    const result = await retargetPendingInvitation(
      inviteRoleConflict.invitationId,
      inviteRoleConflict.requestedRole,
    );
    if (!result.success) {
      setInviteError(result.error);
    } else {
      setPreparedOrgEmailInvite(result.preparedInvite);
      showStatus(
        `Updated the pending invite for ${inviteRoleConflict.email} to ${inviteRoleConflict.requestedRole}. The original link still works.`,
        "success",
        4500,
      );
      setInviteEmail("");
    }
    setInviteRoleConflict(null);
    setInviteConflictPending(false);
  }, [inviteRoleConflict, retargetPendingInvitation, showStatus]);

  const handleApplyProjectInviteRoleConflict = useCallback(async () => {
    if (
      !projectInviteRoleConflict ||
      !isProjectInviteRole(projectInviteRoleConflict.requestedRole)
    ) {
      return;
    }
    setProjectInviteConflictPending(true);
    const result = await retargetPendingProjectInvitation(
      projectInviteRoleConflict.invitationId,
      projectInviteRoleConflict.requestedRole,
    );
    if (!result.success) {
      setProjectInviteError(result.error);
    } else {
      setPreparedProjectEmailInvite(result.preparedInvite);
      showStatus(
        `Updated the pending invite for ${projectInviteRoleConflict.email} to ${projectInviteRoleConflict.requestedRole}. The original link still works.`,
        "success",
        4500,
      );
      setProjectInviteEmail("");
    }
    setProjectInviteRoleConflict(null);
    setProjectInviteConflictPending(false);
  }, [projectInviteRoleConflict, retargetPendingProjectInvitation, showStatus]);

  // No window.confirm here: unlike cancel, a role change is reversible from
  // the same select, and the accept link the invitee holds stays valid.
  const handlePendingInviteRoleChange = useCallback(
    async (invitationId: string, nextRole: string, label: string) => {
      if (!isOrganizationInviteRole(nextRole)) {
        return;
      }
      setInviteRoleUpdatePendingId(invitationId);
      const result = await updatePendingInvitationRole(invitationId, nextRole);
      if (!result.success) {
        showStatus(result.error ?? "Unable to update the invitation role.", "error", 4000);
      } else {
        showStatus(`Updated invitation for ${label} to ${nextRole}.`, "success", 3000);
      }
      // Clear only our own slot: a change started on another row while this
      // one was in flight must keep that row disabled until IT finishes.
      setInviteRoleUpdatePendingId((current) => (current === invitationId ? null : current));
    },
    [showStatus, updatePendingInvitationRole]
  );

  const handleInviteProjectMember = useCallback(async () => {
    const trimmedEmail = projectInviteEmail.trim();
    if (!trimmedEmail) {
      setProjectInviteError("Enter an email address to invite.");
      return;
    }
    setProjectInviteError(null);
    setPreparedProjectEmailInvite(null);
    setProjectInviteRoleConflict(null);
    setProjectInvitePending(true);
    try {
      const result = await prepareProjectEmailInvite(trimmedEmail, projectInviteRole);
      if (!result.success) {
        if (result.conflict) {
          setProjectInviteRoleConflict({ ...result.conflict, email: trimmedEmail });
        } else {
          setProjectInviteError(result.error);
        }
      } else {
        setPreparedProjectEmailInvite(result.preparedInvite);
        showStatus(
          `Invite prepared for ${trimmedEmail}. Instafy has not sent an email.`,
          "success",
          4500,
        );
        setProjectInviteEmail("");
      }
    } finally {
      setProjectInvitePending(false);
    }
  }, [prepareProjectEmailInvite, projectInviteEmail, projectInviteRole, showStatus]);

  const handleCancelProjectInvite = useCallback(
    async (invitationId: string, label: string) => {
      if (typeof window !== "undefined") {
        const ok = window.confirm(`Cancel invitation for ${label}?`);
        if (!ok) {
          return;
        }
      }
      setProjectInviteCancelPendingId(invitationId);
      const result = await cancelProjectInvitation(invitationId);
      if (!result.success) {
        showStatus(result.error ?? "Unable to cancel invitation.", "error", 4000);
      } else {
        showStatus(`Canceled invitation for ${label}.`, "success", 3000);
      }
      setProjectInviteCancelPendingId(null);
    },
    [cancelProjectInvitation, showStatus],
  );

  const handlePendingProjectInviteRoleChange = useCallback(
    async (invitationId: string, nextRole: string, label: string) => {
      if (!isProjectInviteRole(nextRole)) {
        return;
      }
      setProjectInviteRoleUpdatePendingId(invitationId);
      const result = await updatePendingProjectInvitationRole(invitationId, nextRole);
      if (!result.success) {
        showStatus(result.error ?? "Unable to update the invitation role.", "error", 4000);
      } else {
        showStatus(`Updated invitation for ${label} to ${nextRole}.`, "success", 3000);
      }
      setProjectInviteRoleUpdatePendingId((current) =>
        current === invitationId ? null : current,
      );
    },
    [showStatus, updatePendingProjectInvitationRole],
  );

  const handleCreateInviteLink = useCallback(async () => {
    if (!activeOrgId || !activeProjectId) {
      showStatus("Select a space before creating an invite link.", "warning", 3000);
      return;
    }
    if (!canShareProject) {
      showStatus("You do not have permission to share this space.", "error", 3500);
      return;
    }
    if (activeInviteLink && typeof window !== "undefined") {
      const currentAccess = activeInviteLink.role === "builder" ? "Read & write" : "Read-only";
      const nextAccess = inviteLinkRole === "builder" ? "Read & write" : "Read-only";
      const ok = window.confirm(
        `Rotate the current ${currentAccess} link and replace it with a ${nextAccess} link? The old link will stop working.`,
      );
      if (!ok) {
        return;
      }
    }
    setInviteLinkPending(true);
    const result = await rotateInviteLink(inviteLinkRole);
    if (!result.success) {
      showStatus(result.error ?? "Unable to create invite link.", "error", 4000);
    } else {
      showStatus(activeInviteLink ? "Invite link rotated." : "Invite link created.", "success", 2500);
    }
    setInviteLinkPending(false);
  }, [
    activeInviteLink,
    activeOrgId,
    activeProjectId,
    canShareProject,
    inviteLinkRole,
    rotateInviteLink,
    showStatus,
  ]);

  const handleRevokeInviteLink = useCallback(async () => {
    if (!activeInviteLink) {
      return;
    }
    if (!canShareProject) {
      showStatus("You do not have permission to revoke invite links.", "error", 3500);
      return;
    }
    if (typeof window !== "undefined") {
      const ok = window.confirm("Revoke this invite link? Anyone with the link will lose access.");
      if (!ok) {
        return;
      }
    }
    setInviteLinkPending(true);
    const result = await revokeInviteLink(activeInviteLink.id);
    if (!result.success) {
      showStatus(result.error ?? "Unable to revoke invite link.", "error", 4000);
    } else {
      showStatus("Invite link revoked.", "success", 2500);
    }
    setInviteLinkPending(false);
  }, [activeInviteLink, canShareProject, revokeInviteLink, showStatus]);

  const handleCopyInviteLink = useCallback(async () => {
    if (!inviteLinkUrl) {
      return;
    }
    try {
      await writeClipboardText(inviteLinkUrl);
      showStatus("Invite link copied.", "success", 2000, { presentation: "confirmation" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy invite link.";
      showStatus(message, "error", 3000);
    }
  }, [inviteLinkUrl, showStatus]);

  const handleRoleChange = useCallback(
    async (userId: string, nextRole: string) => {
      setMemberUpdatePendingId(userId);
      const result = await updateMemberRole(userId, nextRole);
      if (!result.success) {
        showStatus(result.error ?? "Unable to update member role.", "error", 4000);
      }
      setMemberUpdatePendingId(null);
    },
    [showStatus, updateMemberRole]
  );

  const handleProjectRoleChange = useCallback(
    async (userId: string, nextRole: string) => {
      setProjectMemberUpdatePendingId(userId);
      const result = await updateProjectMemberRole(userId, nextRole);
      if (!result.success) {
        showStatus(result.error ?? "Unable to update space guest role.", "error", 4000);
      }
      setProjectMemberUpdatePendingId(null);
    },
    [showStatus, updateProjectMemberRole]
  );

  const handleRemoveMember = useCallback(
    async (userId: string, label: string) => {
      if (typeof window !== "undefined") {
        const ok = window.confirm(`Remove ${label} from ${activeOrgName}?`);
        if (!ok) {
          return;
        }
      }
      setMemberRemovePendingId(userId);
      const result = await removeMember(userId);
      if (!result.success) {
        showStatus(result.error ?? "Unable to remove member.", "error", 4000);
      } else {
        showStatus(`Removed ${label}.`, "success", 3000);
      }
      setMemberRemovePendingId(null);
    },
    [activeOrgName, removeMember, showStatus]
  );

  const handleRemoveProjectMember = useCallback(
    async (userId: string, label: string) => {
      if (typeof window !== "undefined") {
        const ok = window.confirm(`Remove ${label} from this space?`);
        if (!ok) {
          return;
        }
      }
      setProjectMemberRemovePendingId(userId);
      const result = await removeProjectMember(userId);
      if (!result.success) {
        showStatus(result.error ?? "Unable to remove this person from the space.", "error", 4000);
      } else {
        showStatus(`Removed ${label} from the space.`, "success", 3000);
      }
      setProjectMemberRemovePendingId(null);
    },
    [removeProjectMember, showStatus]
  );

  const settingsTitle =
    activeTab === "profile"
      ? "Profile settings"
      : activeTab === "project"
        ? "Space settings"
        : activeOrgIsPersonal
          ? "Personal settings"
          : "Team settings";

      const settingsSubtitle =
        activeTab === "org"
      ? orgCategory === "members"
        ? "Members"
        : orgCategory === "ai"
          ? "AI & Providers"
          : orgCategory === "billing"
            ? "Billing"
            : "Danger zone"
      : activeTab === "project"
        ? projectCategory === "overview"
          ? "Overview"
          : projectCategory === "access"
            ? "People"
            : projectCategory === "providers"
              ? "Connections"
              : projectCategory === "ai"
                ? "Voice & audio"
                : "Danger zone"
            : profileCategory === "account"
              ? "Account"
              : "Preferences";

  const settingsScope =
    activeTab === "profile" ? (
      <Text variant="caption" tone="muted">
        {user?.email ?? "Guest"}
      </Text>
    ) : activeTab === "org" ? (
      <div className="flex flex-wrap items-end gap-3">
        {activeOrgId ? (
          <OrgAvatarEditor
            orgId={activeOrgId}
            orgName={activeOrgName}
            canEdit={canManageOrgMembers}
          />
        ) : null}
        {runtimeControllerEnabled && orgSelectOptions.length > 0 ? (
          <div className="min-w-[240px]">
            <Text variant="caption" tone="muted">
              Team
            </Text>
            <div className="mt-1">
              <MenuTrigger>
                <EntityRow
                  ref={orgSelectorTriggerRef}
                  title={selectedOrgOption?.label ?? activeOrgName}
                  end={<NavArrowDown className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
                  pressable
                  isDisabled={!canSwitchOrg}
                  data-testid="org-settings-org-selector"
                  aria-label="Select team"
                  surface="outlined"
                  className="min-h-12 text-sm"
                />
                <StudioPopover
                  triggerRef={orgSelectorTriggerRef}
                  placement="bottom start"
                  offset={6}
                  className="min-w-[var(--trigger-width)] p-2"
                  data-testid="org-settings-org-selector-menu"
                >
                  <StudioMenu
                    aria-label="Select team"
                    selectionMode="single"
                    selectedKeys={activeOrgId ? new Set([activeOrgId]) : new Set()}
                    onAction={(key) => {
                      handleSelectOrg(String(key));
                    }}
                    className="space-y-1"
                  >
                    {orgSelectOptions.map((org) => (
                      <StudioMenuItem key={org.id} id={org.id}>
                        {org.label}
                      </StudioMenuItem>
                    ))}
                  </StudioMenu>
                </StudioPopover>
              </MenuTrigger>
            </div>
          </div>
        ) : (
          <Text variant="caption" tone="muted" className="truncate">
            {activeOrgName}
          </Text>
        )}
      </div>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        {activeProject?.name ? (
          <>
            <Text variant="caption" tone="muted" className="truncate">
              {activeProject.name}
            </Text>
            <Text variant="caption" tone="muted" aria-hidden="true">
              ·
            </Text>
          </>
        ) : null}
        <Text variant="caption" tone="muted" className="truncate">
          {activeOrgName}
        </Text>
      </div>
    );

  const handleOpenProjectsPanel = useCallback((options?: { projectId?: string | null }) => {
    try {
      const params = new URLSearchParams(location.search);
      params.set("panel", "projects");
      params.delete("conversationId");
      params.delete("conversationControllerId");
      if (typeof options?.projectId === "string" && options.projectId.trim().length > 0) {
        params.set("projectId", options.projectId.trim());
      } else if (options && "projectId" in options) {
        params.delete("projectId");
      }
      const search = params.toString();
      navigate(
        {
          pathname: location.pathname,
          search: search.length > 0 ? `?${search}` : "",
        },
        { replace: true },
      );
    } catch {
      // ignore malformed URLs
    }
  }, [location.pathname, location.search, navigate]);

  const handleOpenPanel = useCallback(
    (panel: StudioPanel) => {
      try {
        const params = new URLSearchParams(location.search);
        params.set("panel", panel);
        const search = params.toString();
        navigate(
          {
            pathname: location.pathname,
            search: search.length > 0 ? `?${search}` : "",
          },
          { replace: true },
        );
      } catch {
        // ignore malformed URLs
      }
    },
    [location.pathname, location.search, navigate],
  );

  const handleGitAutoSyncChange = useCallback(
    (enabled: boolean) => {
      setGitAutoSyncAfterApply(enabled);
      setGitAutoSyncAfterApplyPreference(enabled);
      showStatus(
        enabled
          ? "Auto-save is on for assistant file changes."
          : "Auto-save is off. Assistant changes stay in Changes until you save version.",
        "info",
        3000
      );
    },
    [showStatus]
  );

  const handleProjectSpeechModeChange = useCallback(
    async (nextValue: string) => {
      if (nextValue !== "auto" && nextValue !== "provider" && nextValue !== "device") {
        return;
      }
      const nextMode = nextValue as ProjectSpeechMode;
      const result = await setProjectSpeechMode(nextMode);
      if (!result.success) {
        showStatus(
          result.error?.trim().length
            ? `${result.error} Saved on this device only for now.`
            : "Unable to save the shared speech setting right now. Saved on this device only.",
          "warning",
          4200,
        );
        return;
      }
      showStatus(
        nextMode === "provider"
          ? "Project speech now prefers the shared speech host."
          : nextMode === "device"
            ? "Project speech now stays on this device."
            : "Project speech now chooses automatically.",
        "info",
        3200,
      );
    },
    [setProjectSpeechMode, showStatus],
  );

  const handleProjectProviderVoiceChange = useCallback(
    async (nextValue: string) => {
      const nextVoiceId = nextValue.trim() || null;
      const result = await setProjectSpeechProviderVoiceId(nextVoiceId);
      if (!result.success) {
        showStatus(
          result.error?.trim().length
            ? `${result.error} Saved on this device only for now.`
            : "Unable to save the shared provider voice right now. Saved on this device only.",
          "warning",
          4200,
        );
        return;
      }
      showStatus(
        nextVoiceId
          ? "Provider voice updated for this space."
          : "Provider voice reset to the provider default for this space.",
        "info",
        3200,
      );
    },
    [setProjectSpeechProviderVoiceId, showStatus],
  );

  const handleProjectDeviceVoiceChange = useCallback(
    async (nextValue: string) => {
      const nextVoiceId = nextValue.trim() || null;
      const result = await setProjectSpeechDeviceVoiceId(nextVoiceId);
      if (!result.success) {
        showStatus(
          result.error?.trim().length
            ? `${result.error} Saved on this device only for now.`
            : "Unable to save the shared device voice right now. Saved on this device only.",
          "warning",
          4200,
        );
        return;
      }
      showStatus(
        nextVoiceId
          ? "Device voice updated for this space."
          : "Device voice reset to this device's default voice.",
        "info",
        3200,
      );
    },
    [setProjectSpeechDeviceVoiceId, showStatus],
  );

  const providerSettingsSurfaceEntries = useMemo(
    () =>
      listProviderSettingsSurfaceEntries({
        settingsProviders,
        speechDependencyStatus,
        desktopVoiceHostStatus,
        desktopVoiceHostLifecycle,
        desktopVoiceHostToggleBusy,
        onToggleDesktopVoiceHost: desktopVoiceHostBridgeEnabled ? handleSetDesktopVoiceHostEnabled : null,
        desktopVoiceHostRestarting,
        onRestartDesktopVoiceHost: desktopVoiceHostBridgeEnabled ? handleRestartDesktopVoiceHost : null,
        desktopVoiceHostBootstrapBusy,
        desktopVoiceHostRemoveBusy,
        desktopVoiceHostBootstrapResult,
        onBootstrapDesktopVoiceHost: desktopVoiceHostBridgeEnabled ? handleBootstrapDesktopVoiceHost : null,
        onRemoveDesktopVoiceRuntime: desktopVoiceHostBridgeEnabled ? handleRemoveDesktopVoiceRuntime : null,
        desktopSpeechTunnelStatus,
        desktopSpeechTunnelLifecycle,
        desktopSpeechTunnelBusy,
        onEnsureDesktopSpeechTunnel: desktopSpeechTunnelEnabled ? handleStartDesktopSpeechTunnel : null,
        projectSpeechMode,
        speechPreferenceSource,
        onProjectSpeechModeChange: handleProjectSpeechModeChange,
        providerSpeechVoices,
        providerDefaultVoiceId,
        selectedProviderVoice,
        onProviderVoiceChange: handleProjectProviderVoiceChange,
        projectProviderVoiceId,
        browserSpeechVoices,
        selectedDeviceVoice,
        onDeviceVoiceChange: handleProjectDeviceVoiceChange,
        projectDeviceVoiceId,
      }),
    [
      browserSpeechVoices,
      desktopSpeechTunnelBusy,
      desktopSpeechTunnelEnabled,
      desktopSpeechTunnelLifecycle,
      desktopSpeechTunnelStatus,
      desktopVoiceHostBootstrapBusy,
      desktopVoiceHostBootstrapResult,
      desktopVoiceHostBridgeEnabled,
      desktopVoiceHostLifecycle,
      desktopVoiceHostRemoveBusy,
      desktopVoiceHostRestarting,
      desktopVoiceHostStatus,
      desktopVoiceHostToggleBusy,
      handleProjectDeviceVoiceChange,
      handleProjectProviderVoiceChange,
      handleProjectSpeechModeChange,
      handleRemoveDesktopVoiceRuntime,
      handleRestartDesktopVoiceHost,
      handleSetDesktopVoiceHostEnabled,
      handleStartDesktopSpeechTunnel,
      handleBootstrapDesktopVoiceHost,
      projectDeviceVoiceId,
      projectProviderVoiceId,
      projectSpeechMode,
      speechPreferenceSource,
      providerDefaultVoiceId,
      providerSpeechVoices,
      selectedDeviceVoice,
      selectedProviderVoice,
      settingsProviders,
      speechDependencyStatus,
    ],
  );

  const projectAiItems = useMemo(
    () =>
      listProjectAiOverrideItems({
        providerSettingsSurfaceEntries,
        speechDependencyStatus,
        speechPreferenceSource,
        hostAudioDiagnostics,
        hostAudioSessionState,
        hostAudioDiagnosticsLoading,
        hostAudioDiagnosticsError,
      }),
    [
      hostAudioDiagnostics,
      hostAudioDiagnosticsError,
      hostAudioDiagnosticsLoading,
      hostAudioSessionState,
      speechPreferenceSource,
      providerSettingsSurfaceEntries,
      speechDependencyStatus,
    ],
  );

  useEffect(() => {
    if (activeTab !== "project" || projectCategory !== "ai") {
      return;
    }
    if (projectAiItems.length === 0) {
      if (projectAiItemId !== null) {
        setProjectAiItemId(null);
      }
      return;
    }
    const currentItemStillExists = projectAiItems.some((item) => item.id === projectAiItemId);
    if (!currentItemStillExists) {
      setProjectAiItemId(projectAiItems[0]?.id ?? null);
    }
  }, [activeTab, projectAiItemId, projectAiItems, projectCategory]);

  const categories = useMemo<SettingsCategory[]>(() => {
    if (activeTab === "org") {
      return [
        { id: "members", label: "Members", icon: Group, testId: "settings-category-org-members" },
        { id: "ai", label: "AI & Providers", icon: Cpu, testId: "settings-category-org-ai" },
        { id: "billing", label: "Billing", icon: Coins, testId: "settings-category-org-billing" },
        { id: "danger", label: "Danger zone", icon: Xmark, danger: true, testId: "settings-category-org-danger" },
      ];
    }
    if (activeTab === "project") {
      return [
        { id: "overview", label: "Overview", testId: "settings-category-project-overview" },
        {
          id: "access",
          label: "People",
          testId: "settings-category-project-access",
        },
        {
          id: "providers",
          label: "Connections",
          testId: "settings-category-project-providers",
        },
        {
          id: "ai",
          label: "Voice & audio",
          testId: "settings-category-project-ai",
          children: projectAiItems.map((item) => ({
            id: item.id,
            label: item.label,
            testId: `settings-category-project-ai-${item.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          })),
        },
        { id: "danger", label: "Danger zone", danger: true, testId: "settings-category-project-danger" },
      ];
    }
    return [
      { id: "account", label: "Account", testId: "settings-category-profile-account" },
      { id: "preferences", label: "Preferences", testId: "settings-category-profile-preferences" },
    ];
  }, [activeTab, projectAiItems]);

  const syncSettingsCategoryParam = useCallback(
    (category: ProjectSettingsCategory) => {
      try {
        const search = buildProjectSettingsCategorySearch(location.search, category);
        if (search === location.search.replace(/^\?/, "")) {
          return;
        }
        navigate(
          {
            pathname: location.pathname,
            search: search.length > 0 ? `?${search}` : "",
          },
          { replace: true },
        );
      } catch {
        // ignore malformed URLs
      }
    },
    [location.pathname, location.search, navigate],
  );

  useEffect(() => {
    const category = resolveProjectSettingsCategory(location.search);
    if (category && category !== projectCategory) {
      setProjectCategory(category);
      if (category !== "ai") {
        setProjectAiItemId(null);
      }
    }
  }, [location.search, projectCategory]);

  const handleCategoryChange = useCallback(
    (next: string) => {
      if (activeTab === "org") {
        if (next === "members" || next === "ai" || next === "billing" || next === "danger") {
          setOrgCategory(next);
        }
        return;
      }
      if (activeTab === "project") {
        if (next === "overview" || next === "access" || next === "providers" || next === "ai" || next === "danger") {
          setProjectCategory(next);
          if (next !== "ai") {
            setProjectAiItemId(null);
          }
          syncSettingsCategoryParam(next);
        }
        return;
      }
      if (next === "account" || next === "preferences") {
        setProfileCategory(next);
      }
    },
    [activeTab, syncSettingsCategoryParam],
  );

  const handleProjectAiItemChange = useCallback((nextItemId: string) => {
    setProjectAiItemId(nextItemId);
  }, []);

  const handleRefreshProjectDefaults = useCallback(async () => {
    const projectId = activeProjectId?.trim() ?? "";
    if (!projectId) {
      showStatus("Select a project first.", "warning", 3000);
      return;
    }
    if (!runtimeControllerEnabled) {
      showStatus("Connect the runtime controller before refreshing defaults.", "error", 4000);
      return;
    }
    if (!canWriteProject) {
      showStatus("This space is read-only. Managed defaults cannot be changed.", "warning", 3500);
      return;
    }

    setProjectDefaultsRefreshPending(true);
    try {
      const result = await controllerClient.projects.bootstrapMemory({
        projectId,
      });
      if (!result) {
        throw new Error("Unable to reach project defaults service.");
      }

      if (result.seeded) {
        showStatus(
          `Defaults refreshed${result.fileCount > 0 ? ` (${result.fileCount} ${result.fileCount === 1 ? "file" : "files"})` : ""}.`,
          "success",
          3500,
        );
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId } }));
        }
      } else if (result.reason === "already-present") {
        showStatus("No default files changed.", "info", 3000);
      } else if (result.reason === "workspace-busy") {
        showStatus("Workspace is busy. Retry in a moment.", "warning", 3500);
      } else if (result.reason === "no-origin") {
        showStatus("Start or connect a runtime before refreshing defaults.", "warning", 3500);
      } else {
        throw new Error(result.reason ?? "Unable to refresh project defaults.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh project defaults.";
      showStatus(message, "error", 4500);
    } finally {
      setProjectDefaultsRefreshPending(false);
    }
  }, [activeProjectId, canWriteProject, showStatus]);

  const handleDeleteProject = useCallback(async () => {
    if (!runtimeControllerEnabled) {
      showStatus("Connect the runtime controller to delete spaces.", "warning", 3500);
      return;
    }
    if (!activeProjectId) {
      showStatus("Select a space before deleting it.", "warning", 3000);
      return;
    }
    if (!canAttemptProjectDelete) {
      showStatus("You do not have permission to delete this space.", "error", 3500);
      return;
    }
    if (typeof window !== "undefined") {
      const label = activeProject?.name ?? "this space";
      const ok = window.confirm(
        `Delete ${label}? This can’t be undone and guests will lose access.`,
      );
      if (!ok) {
        return;
      }
    }
    setProjectDeletePending(true);
    const deletedProjectId = activeProjectId;
    const ok = await controllerClient.projects.delete(deletedProjectId);
    if (!ok) {
      showStatus("Unable to delete this space right now.", "error", 4000);
      setProjectDeletePending(false);
      return;
    }
    const nextProject =
      projectList.find(
        (project) => project.id !== deletedProjectId && project.orgId === activeOrgId,
      ) ??
      projectList.find((project) => project.id !== deletedProjectId) ??
      null;

    if (nextProject) {
      handleOpenProjectsPanel({ projectId: nextProject.id });
      switchProject(nextProject.id);
      removeProject(deletedProjectId);
    } else {
      handleOpenProjectsPanel({ projectId: null });
      suppressProjectAutoCreate();
      removeProject(deletedProjectId);
      showStatus("Space deleted. Create a new space to continue.", "warning", 4000);
      setProjectDeletePending(false);
      return;
    }

    showStatus("Space deleted.", "success", 2500);
    setProjectDeletePending(false);
  }, [
    activeProject?.name,
    activeProjectId,
    canAttemptProjectDelete,
    removeProject,
    projectList,
    activeOrgId,
    switchProject,
    handleOpenProjectsPanel,
    showStatus,
  ]);

  const handleDeleteOrganization = useCallback(async () => {
    if (!runtimeControllerEnabled) {
      showStatus("Connect the runtime controller to delete teams.", "warning", 3500);
      return;
    }
    if (!activeOrgId) {
      showStatus("Select a team before deleting it.", "warning", 3000);
      return;
    }
    if (!canAttemptOrgDelete) {
      showStatus(
        activeOrgIsPersonal ? "Only the owner can delete this personal space." : "Only team owners can delete teams.",
        "error",
        3500,
      );
      return;
    }
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `Delete ${activeOrgName}? This deletes the ${orgContainerLabel} and all of its spaces.`,
      );
      if (!ok) {
        return;
      }
    }
    setOrgDeletePending(true);
    const deletedOrgId = activeOrgId;
    const ok = await controllerClient.organizations.delete(deletedOrgId);
    if (!ok) {
      showStatus("Unable to delete this team right now.", "error", 4000);
      setOrgDeletePending(false);
      return;
    }
    const nextProject = projectList.find((project) => project.orgId !== deletedOrgId) ?? null;
    if (nextProject) {
      handleOpenProjectsPanel({ projectId: nextProject.id });
      switchProject(nextProject.id);
    } else {
      handleOpenProjectsPanel({ projectId: null });
      suppressProjectAutoCreate();
      showStatus(
        activeOrgIsPersonal ? "Personal space deleted. Create a new space to continue." : "Team deleted. Create a new space to continue.",
        "warning",
        4000,
      );
      setOrgDeletePending(false);
      removeProjectsByOrgId(deletedOrgId);
      return;
    }

    removeProjectsByOrgId(deletedOrgId);
    showStatus(activeOrgIsPersonal ? "Personal space deleted." : "Team deleted.", "success", 2500);
    setOrgDeletePending(false);
  }, [
    activeOrgId,
    activeOrgIsPersonal,
    activeOrgName,
    canAttemptOrgDelete,
    handleOpenProjectsPanel,
    orgContainerLabel,
    projectList,
    removeProjectsByOrgId,
    showStatus,
    switchProject,
  ]);

  const renderProjectSettingsSections = (
    showProjectBasics: boolean,
    projectAccessPanel: "guests" | "providers" | null,
  ) => (
    <ProjectSettingsSections
      activeProjectId={activeProjectId}
      activeProjectName={activeProject?.name ?? null}
      canShareProject={canShareProject}
      canWriteProject={canWriteProject}
      runtimeControllerEnabled={runtimeControllerEnabled}
      currentUserId={user?.id ?? null}
      showProjectBasics={showProjectBasics}
      projectAccessPanel={projectAccessPanel}
      projectInviteEmail={projectInviteEmail}
      projectInviteRole={projectInviteRole}
      projectInvitePending={projectInvitePending}
      projectInviteError={projectInviteError}
      projectInviteEmailValid={projectInviteEmailValid}
      preparedEmailInvite={preparedProjectEmailInvite}
      onProjectInviteEmailChange={(value) => {
        setProjectInviteEmail(value);
        if (projectInviteError) {
          setProjectInviteError(null);
        }
      }}
      onProjectInviteRoleChange={(value) => {
        if (!isProjectInviteRole(value)) {
          return;
        }
        setProjectInviteRole(value);
        if (projectInviteError) {
          setProjectInviteError(null);
        }
      }}
      onInviteProjectMember={() => void handleInviteProjectMember()}
      projectInvitationsError={projectInvitationsError}
      projectInvitationsLoading={projectInvitationsLoading}
      projectInvitations={projectInvitations}
      sortedProjectInvitations={sortedProjectInvitations}
      projectInviteCancelPendingId={projectInviteCancelPendingId}
      onCancelProjectInvite={(invitationId, label) => void handleCancelProjectInvite(invitationId, label)}
      projectInviteRoleUpdatePendingId={projectInviteRoleUpdatePendingId}
      onPendingProjectInviteRoleChange={(invitationId, nextRole, label) =>
        void handlePendingProjectInviteRoleChange(invitationId, nextRole, label)
      }
      projectInviteRoleConflict={projectInviteRoleConflict}
      projectInviteConflictPending={projectInviteConflictPending}
      onApplyProjectInviteRoleConflict={() => void handleApplyProjectInviteRoleConflict()}
      onDismissProjectInviteRoleConflict={() => setProjectInviteRoleConflict(null)}
      inviteLinkRole={inviteLinkRole}
      activeInviteLinkRole={activeInviteLink?.role ?? null}
      inviteLinkPending={inviteLinkPending}
      inviteLinksError={inviteLinksError}
      inviteLinksLoading={inviteLinksLoading}
      inviteLinkUrl={inviteLinkUrl}
      onInviteLinkRoleChange={(value) => {
        if (isProjectInviteRole(value)) {
          setInviteLinkRole(value);
        }
      }}
      onCreateInviteLink={() => void handleCreateInviteLink()}
      onCopyInviteLink={() => void handleCopyInviteLink()}
      onRevokeInviteLink={() => void handleRevokeInviteLink()}
      projectMembersLoading={projectMembersLoading}
      projectMembers={projectMembers}
      sortedProjectMembers={sortedProjectMembers}
      projectMembersError={projectMembersError}
      projectMemberUpdatePendingId={projectMemberUpdatePendingId}
      projectMemberRemovePendingId={projectMemberRemovePendingId}
      onProjectRoleChange={(userId, nextRole) => void handleProjectRoleChange(userId, nextRole)}
      onRemoveProjectMember={(userId, label) => void handleRemoveProjectMember(userId, label)}
      projectNameDraft={projectNameDraft}
      projectNameSaving={projectNameSaving}
      projectNameDirty={projectNameDirty}
      projectNameInvalid={projectNameInvalid}
      onProjectNameChange={setProjectNameDraft}
      onProjectNameSave={() => void handleSaveProjectName()}
      onProjectNameCancel={handleCancelProjectName}
      projectDefaultsRefreshPending={projectDefaultsRefreshPending}
      onRefreshProjectDefaults={() => void handleRefreshProjectDefaults()}
    />
  );
  return (
    <SettingsShell
      testId="settings-panel"
      title={settingsTitle}
      subtitle={settingsSubtitle}
      hideTitle={!isLargeScreen}
      scope={settingsScope}
      categories={categories}
      activeCategoryId={activeCategoryId}
      onCategoryChange={handleCategoryChange}
      activeChildCategoryId={
        activeTab === "project" && projectCategory === "ai"
          ? projectAiItemId
          : null
      }
      onChildCategoryChange={
        activeTab === "project" && projectCategory === "ai"
          ? handleProjectAiItemChange
          : undefined
      }
    >
      {showScopeHint ? (
        <div className="flex items-start gap-2 px-1">
          <Settings className="mt-0.5 text-base text-slate-400" aria-hidden="true" />
          <Text variant="caption" tone="muted" className="leading-relaxed">
            Guests can access only{" "}
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {activeProject?.name ?? "this space"}
            </span>
            . People with access to{" "}
            <span className="font-medium text-slate-700 dark:text-slate-200">{activeOrgName}</span> can access all
            spaces.
          </Text>
        </div>
      ) : null}

        {activeTab === "profile" ? (
          <div className="space-y-4" data-testid="profile-settings-section">
            {profileCategory === "account" ? (
            <ProfileEditor variant="panel" />
          ) : (
            <Card tone="default" radius="2xl" shadow="none" padding="sm" className="py-2.5">
              <Text variant="bodyStrong" tone="secondary">
                Preferences
              </Text>
              <div className="mt-3 space-y-2">
                <Checkbox
                  isSelected={gitAutoSyncAfterApply}
                  onChange={handleGitAutoSyncChange}
                  label="Auto-save assistant file changes"
                  description="When enabled, assistant edits are synced to the canonical workspace after each run."
                  data-testid="profile-preference-git-auto-sync"
                />
                <Text variant="caption" tone="muted" className="pl-6">
                  If auto-save fails, the run stays complete and you can finish from Changes.
                </Text>
              </div>
            </Card>
          )}
        </div>
        ) : activeTab === "project" ? (
          <div className="space-y-4" data-testid="project-settings-section">
            {!canWriteProject ? (
              <SettingsSurface data-testid="project-settings-read-only-notice">
                <Text variant="bodyStrong" tone="primary">Read-only space</Text>
                <Text variant="caption" tone="muted" className="mt-1">
                  You can review settings and access, but only a builder, admin, or owner can change this space.
                </Text>
              </SettingsSurface>
            ) : null}
            {projectCategory === "ai" ? (
              canWriteProject ? <ProjectAiOverridesSettings
                selectedItemId={projectAiItemId}
                speechDependencyStatus={speechDependencyStatus}
                speechPreferenceSource={speechPreferenceSource}
                providerSettingsSurfaceEntries={providerSettingsSurfaceEntries}
                hostAudioDiagnostics={hostAudioDiagnostics}
                hostAudioSessionState={hostAudioSessionState}
                hostAudioDiagnosticsLoading={hostAudioDiagnosticsLoading}
                hostAudioDiagnosticsError={hostAudioDiagnosticsError}
                microphonePermissionRequesting={microphonePermissionRequesting}
                microphonePermissionError={microphonePermissionRequestError}
                onRequestMicrophonePermission={handleRequestMicrophonePermission}
              /> : null
            ) : projectCategory === "danger" ? (
            <div className="space-y-3" data-testid="settings-danger-zone">
              <div className="px-1">
                <Text variant="bodyStrong" tone="danger">
                  Danger zone
                </Text>
              </div>

              <Card tone="default" radius="2xl" shadow="none" padding="sm" className="py-2.5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <Text variant="bodyStrong" tone="secondary">
                      Delete space
                    </Text>
                    <Text variant="caption" tone="muted" className="mt-1">
                      Delete this space and revoke access for guests.
                    </Text>
                    {!runtimeControllerEnabled ? (
                      <Text variant="caption" tone="muted" className="mt-1">
                        Connect the runtime controller to manage deletions.
                      </Text>
                    ) : null}
                    {runtimeControllerEnabled &&
                    activeProjectId &&
                    orgRoleChecked &&
                    !canAttemptProjectDelete ? (
                      <Text variant="caption" tone="muted" className="mt-1">
                        Only people with access to {activeOrgName} can delete spaces.
                      </Text>
                    ) : null}
                  </div>
                  <Button
                    onPress={handleDeleteProject}
                    isDisabled={!canAttemptProjectDelete || projectDeletePending}
                    variant="danger"
                    size="sm"
                    radius="xl"
                    data-testid="danger-delete-project"
                    className="w-full sm:w-auto"
                  >
                    {projectDeletePending ? "Deleting…" : "Delete space"}
                  </Button>
                </div>
              </Card>
            </div>
          ) : projectCategory === "access" ? (
            <div className="space-y-4" data-testid="project-access-section">
              {!runtimeControllerEnabled ? (
                <SettingsSurface tone="warning">
                  <Text variant="body" tone="warning">
                    Connect the runtime controller to share spaces and manage guests.
                  </Text>
                </SettingsSurface>
              ) : null}

              {!activeProjectId ? (
                <SettingsSurface>
                  <Text variant="body" tone="secondary">
                    Select a space to manage guest access and invite links.
                  </Text>
                </SettingsSurface>
              ) : null}

              {canLoadProjectSettings ? (
                renderProjectSettingsSections(false, "guests")
              ) : null}
            </div>
          ) : projectCategory === "providers" ? (
            <div className="space-y-4" data-testid="project-providers-section">
              {!runtimeControllerEnabled ? (
                <SettingsSurface tone="warning">
                  <Text variant="body" tone="warning">
                    Connect the runtime controller to manage provider and device grants.
                  </Text>
                </SettingsSurface>
              ) : null}

              {!activeProjectId ? (
                <SettingsSurface>
                  <Text variant="body" tone="secondary">
                    Select a space to manage provider and device access.
                  </Text>
                </SettingsSurface>
              ) : null}

              {canLoadProjectSettings ? (
                renderProjectSettingsSections(false, "providers")
              ) : null}
            </div>
          ) : (<> 
          {!runtimeControllerEnabled ? (
            <SettingsSurface tone="warning">
              <Text variant="body" tone="warning">
                Connect the runtime controller to share spaces and manage guests.
              </Text>
            </SettingsSurface>
          ) : null}

          {!activeProjectId ? (
            <SettingsSurface>
              <Text variant="body" tone="secondary">
                Select a space to manage guest access and invite links.
              </Text>
            </SettingsSurface>
          ) : null}

          {membersError && canLoadOrgSettings ? (
            <SettingsSurface tone="danger">
              <Text variant="body" tone="danger" className="font-medium">
                {membersError}
              </Text>
            </SettingsSurface>
          ) : null}

          {canLoadProjectSettings ? (
            renderProjectSettingsSections(true, null)
          ) : null}
          </>)}
        </div>
      ) : (
          <div className="space-y-4" data-testid="org-settings-section">
              {orgCategory === "ai" ? (
                <SettingsSection
                  title="AI & Providers"
                  description={
                    <>
                      Configure default providers, models, and fallbacks for {activeOrgIsPersonal ? "your personal space" : "this team"}. Spaces can optionally apply
                      overrides for specific runs.
                      <span className="mt-1 block">Secrets are managed per space.</span>
                    </>
                  }
                  data-testid="org-settings-ai"
                >
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onPress={() => handleOpenPanel("ai")}
                      variant="outline"
                      size="sm"
                      radius="xl"
                      data-testid="settings-open-org-ai-manager"
                    >
                      Open AI manager
                    </Button>
                  </div>
                </SettingsSection>
              ) : orgCategory === "billing" ? (
                <SettingsSection
                  title="Billing & credits"
                  description={`Credits are tracked for ${activeOrgIsPersonal ? "your personal space" : "this team"}. Use this section to review balances and manage billing.`}
                  data-testid="org-settings-billing"
                >
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onPress={() => handleOpenPanel("credits")}
                      variant="outline"
                      size="sm"
                      radius="xl"
                      data-testid="settings-open-usage-credits"
                    >
                      Open credits
                    </Button>
                  </div>
                </SettingsSection>
              ) : orgCategory === "danger" ? (
            <div className="space-y-3" data-testid="settings-danger-zone">
              <div className="px-1">
                <Text variant="bodyStrong" tone="danger">
                  Danger zone
                </Text>
              </div>

              <Card tone="default" radius="2xl" shadow="none" padding="sm" className="py-2.5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <Text variant="bodyStrong" tone="secondary">
                      {orgDeleteLabel}
                    </Text>
                    <Text variant="caption" tone="muted" className="mt-1">
                      {activeOrgIsPersonal
                        ? "Delete your personal space and all of its spaces."
                        : "Delete this team and all of its spaces."}
                    </Text>
                    {!runtimeControllerEnabled ? (
                      <Text variant="caption" tone="muted" className="mt-1">
                        Connect the runtime controller to manage deletions.
                      </Text>
                    ) : null}
                    {runtimeControllerEnabled && activeOrgId && orgRoleChecked && !canAttemptOrgDelete ? (
                      <Text variant="caption" tone="muted" className="mt-1">
                        {activeOrgIsPersonal
                          ? "Only the owner can delete this personal space."
                          : "Only team owners can delete teams."}
                      </Text>
                    ) : null}
                  </div>
                  <Button
                    onPress={handleDeleteOrganization}
                    isDisabled={!canAttemptOrgDelete || orgDeletePending}
                    variant="danger"
                    size="sm"
                    radius="xl"
                    data-testid="danger-delete-org"
                    className="w-full sm:w-auto"
                  >
                    {orgDeletePending ? "Deleting…" : orgDeleteLabel}
                  </Button>
                </div>
              </Card>
            </div>
          ) : (
            <>
              {!runtimeControllerEnabled ? (
                <SettingsSurface tone="warning">
                  <Text variant="body" tone="warning">
                    Connect the runtime controller to manage people and invites.
                  </Text>
                </SettingsSurface>
              ) : null}

              {!activeOrgId ? (
                <SettingsSurface>
                  <Text variant="body" tone="secondary">
                    Select a team to manage people.
                  </Text>
                </SettingsSurface>
              ) : null}

              {runtimeControllerEnabled && activeOrgId && !orgRoleChecked ? (
                <SettingsSurface>
                  <Text variant="body" tone="secondary">
                    Loading access…
                  </Text>
                </SettingsSurface>
              ) : null}

              {runtimeControllerEnabled && activeOrgId && orgRoleChecked && !orgRole ? (
                <SettingsSurface>
                  <Text variant="body" tone="secondary">
                    You have access to this space as a guest. Ask an owner or admin to invite
                    you by email to view people with access.
                  </Text>
                </SettingsSurface>
              ) : null}

              {membersError && canLoadOrgSettings ? (
                <SettingsSurface tone="danger">
                  <Text variant="body" tone="danger" className="font-medium">
                    {membersError}
                  </Text>
                </SettingsSurface>
              ) : null}

              {canLoadOrgSettings ? (
                <OrgMembersSettingsSections
                  currentUserId={user?.id ?? null}
                  canManageOrgMembers={canManageOrgMembers}
                  canManageOwners={canManageOwners}
                  inviteEmail={inviteEmail}
                  inviteRole={inviteRole}
                  invitePending={invitePending}
                  inviteError={inviteError}
                  inviteEmailValid={inviteEmailValid}
                  preparedEmailInvite={preparedOrgEmailInvite}
                  onInviteEmailChange={(value) => {
                    setInviteEmail(value);
                    if (inviteError) {
                      setInviteError(null);
                    }
                  }}
                  onInviteRoleChange={(value) => {
                    if (!isOrganizationInviteRole(value)) {
                      return;
                    }
                    setInviteRole(value);
                    if (inviteError) {
                      setInviteError(null);
                    }
                  }}
                  onInviteMember={() => void handleInviteMember()}
                  invitationsCountLabel={invitationsCountLabel}
                  invitationsError={invitationsError}
                  invitationsLoading={invitationsLoading}
                  invitations={invitations}
                  sortedInvitations={sortedInvitations}
                  inviteCancelPendingId={inviteCancelPendingId}
                  onCancelInvite={(invitationId, label) => void handleCancelInvite(invitationId, label)}
                  inviteRoleUpdatePendingId={inviteRoleUpdatePendingId}
                  onPendingInviteRoleChange={(invitationId, nextRole, label) =>
                    void handlePendingInviteRoleChange(invitationId, nextRole, label)
                  }
                  inviteRoleConflict={inviteRoleConflict}
                  inviteConflictPending={inviteConflictPending}
                  onApplyInviteRoleConflict={() => void handleApplyInviteRoleConflict()}
                  onDismissInviteRoleConflict={() => setInviteRoleConflict(null)}
                  membersCountLabel={membersCountLabel}
                  memberQuery={memberQuery}
                  onMemberQueryChange={setMemberQuery}
                  membersLoading={membersLoading}
                  membersLoadingMore={membersLoadingMore}
                  members={members}
                  sortedMembers={sortedMembers}
                  membersHasMore={membersHasMore}
                  onLoadMoreMembers={() => void loadMoreMembers()}
                  memberUpdatePendingId={memberUpdatePendingId}
                  memberRemovePendingId={memberRemovePendingId}
                  onRoleChange={(userId, nextRole) => void handleRoleChange(userId, nextRole)}
                  onRemoveMember={(userId, label) => void handleRemoveMember(userId, label)}
                />
              ) : null}
            </>
          )}
        </div>
      )}
    </SettingsShell>
  );
}
