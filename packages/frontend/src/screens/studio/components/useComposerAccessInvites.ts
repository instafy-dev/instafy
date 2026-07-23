import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import {
  type AccessInviteScope,
  useScopedInviteLinkActions,
} from "../../../org/useInviteActions";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import {
  buildNearbyInviteSharePayload,
  isNearbyInviteShareDismissalError,
  nearbyInviteShareRequiresPreparedUrl,
  shareNearbyInvite,
} from "../../../sharing/nearbyInviteShare";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import { useStatus } from "../../../status/useStatus";
import type { ComposerInviteRole } from "./ComposerInviteAccessControls";
import { ComposerInviteProjectAccessSection } from "./ComposerInviteProjectAccessSection";
import { useComposerInviteEmail } from "./useComposerInviteEmail";

type ComposerAccessSectionViewModel = ComponentProps<
  typeof ComposerInviteProjectAccessSection
>;

type UseComposerAccessInvitesOptions = {
  accessQrRole: ComposerInviteRole | null;
  activeConversationControllerId: string | null;
  activeConversationVisibility: string | null;
  activeOrgId: string | null;
  activeProjectId: string | null;
  canShareProject: boolean;
  canWriteProject: boolean;
  isOpen: boolean;
  nearbyShareAvailable: boolean;
  onCloseAccessQr: () => void;
  onOpenAccessQr: (role: ComposerInviteRole) => void;
  onPreparedEmailInviteConsumed: (() => void) | null;
  requestedPreparedEmailInvite: PreparedEmailInvite | null;
  sharingPermissionsLoading: boolean;
};

const EMPTY_NEARBY_INVITE_URLS: Record<ComposerInviteRole, string | null> = {
  viewer: null,
  builder: null,
};

export function useComposerAccessInvites({
  accessQrRole,
  activeConversationControllerId,
  activeConversationVisibility,
  activeOrgId,
  activeProjectId,
  canShareProject,
  canWriteProject,
  isOpen,
  nearbyShareAvailable,
  onCloseAccessQr,
  onOpenAccessQr,
  onPreparedEmailInviteConsumed,
  requestedPreparedEmailInvite,
  sharingPermissionsLoading,
}: UseComposerAccessInvitesOptions) {
  const { showStatus } = useStatus();
  const [accessRole, setAccessRole] = useState<ComposerInviteRole>("builder");
  const [copyPendingRole, setCopyPendingRole] = useState<ComposerInviteRole | null>(null);
  const [nearbyQrPendingRole, setNearbyQrPendingRole] =
    useState<ComposerInviteRole | null>(null);
  const [nearbySharePendingRole, setNearbySharePendingRole] =
    useState<ComposerInviteRole | null>(null);
  const [nearbyInviteUrls, setNearbyInviteUrls] = useState<
    Record<ComposerInviteRole, string | null>
  >({ ...EMPTY_NEARBY_INVITE_URLS });
  const [inviteLinkRevokePendingId, setInviteLinkRevokePendingId] =
    useState<string | null>(null);
  const canInviteIntoChat = activeConversationVisibility === "private";
  const inviteConversationId = canInviteIntoChat ? activeConversationControllerId : null;
  const sharingTargetReady = !canInviteIntoChat || Boolean(inviteConversationId);
  const sharingEnabled =
    isOpen && canShareProject && !sharingPermissionsLoading && sharingTargetReady;
  const inviteScope = useMemo<AccessInviteScope | null>(() => {
    if (!sharingEnabled || !activeOrgId || !activeProjectId) {
      return null;
    }
    if (inviteConversationId) {
      return {
        kind: "conversation",
        orgId: activeOrgId,
        projectId: activeProjectId,
        conversationId: inviteConversationId,
      };
    }
    return {
      kind: "project",
      orgId: activeOrgId,
      projectId: activeProjectId,
    };
  }, [activeOrgId, activeProjectId, inviteConversationId, sharingEnabled]);
  const { links, ensureInviteLink, resolveLinkUrl, revokeInviteLink } =
    useScopedInviteLinkActions(inviteScope);
  const email = useComposerInviteEmail({
    accessRole,
    activeConversationControllerId,
    activeOrgId,
    activeProjectId,
    canInviteIntoChat,
    canShareProject,
    inviteConversationId,
    inviteScope,
    isOpen,
    onPreparedEmailInviteConsumed,
    requestedPreparedEmailInvite,
  });
  const activeInviteLink = useMemo(
    () => links.find((entry) => entry.role === accessRole) ?? null,
    [accessRole, links],
  );
  const currentInviteLink = links[0] ?? null;
  const activeNearbyInviteUrl = nearbyInviteUrls[accessRole];

  useEffect(() => {
    setNearbyInviteUrls({ ...EMPTY_NEARBY_INVITE_URLS });
    setInviteLinkRevokePendingId(null);
  }, [activeConversationControllerId, activeOrgId, activeProjectId]);

  useEffect(() => {
    setNearbyInviteUrls((current) => {
      const next = { ...current };
      let changed = false;
      for (const role of ["viewer", "builder"] as const) {
        if (!current[role]) {
          continue;
        }
        const matchingLink = links.find((entry) => entry.role === role && entry.acceptPath);
        const nextUrl = matchingLink ? resolveLinkUrl(matchingLink) : null;
        if (nextUrl !== current[role]) {
          next[role] = nextUrl;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [links, resolveLinkUrl]);

  useEffect(() => {
    if (accessQrRole && !nearbyInviteUrls[accessQrRole]) {
      onCloseAccessQr();
    }
  }, [accessQrRole, nearbyInviteUrls, onCloseAccessQr]);

  useEffect(() => {
    if (!isOpen) {
      setInviteLinkRevokePendingId(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (canShareProject) {
      return;
    }
    setNearbyInviteUrls({ ...EMPTY_NEARBY_INVITE_URLS });
    onCloseAccessQr();
  }, [canShareProject, onCloseAccessQr]);

  const ensureInviteLinkForRole = useCallback(
    async (role: ComposerInviteRole) => {
      if (canInviteIntoChat && !inviteConversationId) {
        throw new Error("Wait for this private chat to finish syncing before sharing it.");
      }
      const result = await ensureInviteLink(role);
      if (!result.success) {
        throw new Error(result.error ?? "Unable to create invite link.");
      }
      return result.link;
    },
    [canInviteIntoChat, ensureInviteLink, inviteConversationId],
  );

  const copyInviteLink = useCallback(async () => {
    if (!activeOrgId || !activeProjectId) {
      showStatus("Select a space before sharing it.", "warning", 3000);
      return;
    }
    if (!canShareProject) {
      showStatus("Your current role cannot manage sharing for this space.", "error", 3500);
      return;
    }
    if (canInviteIntoChat && !inviteConversationId) {
      showStatus(
        "Wait for this private chat to finish syncing before inviting someone.",
        "warning",
        3500,
      );
      return;
    }
    if (copyPendingRole) {
      return;
    }
    setCopyPendingRole(accessRole);
    try {
      const created = await ensureInviteLinkForRole(accessRole);
      const inviteUrl = resolveLinkUrl(created);
      if (!inviteUrl) {
        throw new Error("Unable to resolve invite link.");
      }
      await writeClipboardText(inviteUrl);
      showStatus(
        accessRole === "builder" ? "Edit link copied." : "Read link copied.",
        "success",
        2200,
        { presentation: "confirmation" },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy invite link.";
      showStatus(message, "error", 3500);
    } finally {
      setCopyPendingRole(null);
    }
  }, [
    accessRole,
    activeOrgId,
    activeProjectId,
    canInviteIntoChat,
    canShareProject,
    copyPendingRole,
    ensureInviteLinkForRole,
    inviteConversationId,
    resolveLinkUrl,
    showStatus,
  ]);

  const ensureNearbyInviteUrl = useCallback(
    async (role: ComposerInviteRole) => {
      const created = await ensureInviteLinkForRole(role);
      const inviteUrl = resolveLinkUrl(created);
      if (!inviteUrl) {
        throw new Error("Unable to resolve invite link.");
      }
      setNearbyInviteUrls((current) =>
        current[role] === inviteUrl ? current : { ...current, [role]: inviteUrl },
      );
      return inviteUrl;
    },
    [ensureInviteLinkForRole, resolveLinkUrl],
  );

  const showNearbyQr = useCallback(async () => {
    if (!activeOrgId || !activeProjectId) {
      showStatus("Select a space before sharing it.", "warning", 3000);
      return;
    }
    if (!canShareProject) {
      showStatus("Your current role cannot manage sharing for this space.", "error", 3500);
      return;
    }
    if (nearbyQrPendingRole) {
      return;
    }
    setNearbyQrPendingRole(accessRole);
    try {
      await ensureNearbyInviteUrl(accessRole);
      onOpenAccessQr(accessRole);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to prepare the QR invite.";
      showStatus(message, "error", 3500);
    } finally {
      setNearbyQrPendingRole(null);
    }
  }, [
    accessRole,
    activeOrgId,
    activeProjectId,
    canShareProject,
    ensureNearbyInviteUrl,
    nearbyQrPendingRole,
    onOpenAccessQr,
    showStatus,
  ]);

  const copyPreparedInvite = useCallback(async () => {
    if (!accessQrRole) {
      return;
    }
    const inviteUrl = nearbyInviteUrls[accessQrRole];
    if (!inviteUrl) {
      showStatus("This invite is still being prepared.", "warning", 2500);
      return;
    }
    try {
      await writeClipboardText(inviteUrl);
      showStatus(
        accessQrRole === "builder" ? "Edit link copied." : "Read link copied.",
        "success",
        2200,
        { presentation: "confirmation" },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy invite link.";
      showStatus(message, "error", 3500);
    }
  }, [accessQrRole, nearbyInviteUrls, showStatus]);

  const revokeLink = useCallback(async () => {
    if (!currentInviteLink || inviteLinkRevokePendingId) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm("Revoke this invite link? Anyone who has not joined yet will lose access.")
    ) {
      return;
    }
    setInviteLinkRevokePendingId(currentInviteLink.id);
    try {
      const result = await revokeInviteLink(currentInviteLink.id);
      if (!result.success) {
        throw new Error(result.error ?? "Unable to revoke invite link.");
      }
      setNearbyInviteUrls({ ...EMPTY_NEARBY_INVITE_URLS });
      onCloseAccessQr();
      showStatus("Invite link revoked.", "success", 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to revoke invite link.";
      showStatus(message, "error", 3500);
    } finally {
      setInviteLinkRevokePendingId(null);
    }
  }, [
    currentInviteLink,
    inviteLinkRevokePendingId,
    onCloseAccessQr,
    revokeInviteLink,
    showStatus,
  ]);

  const nearbyShare = useCallback(async () => {
    const shareRole = accessQrRole ?? accessRole;
    if (!activeOrgId || !activeProjectId) {
      showStatus("Select a space before sharing it.", "warning", 3000);
      return;
    }
    if (!canShareProject) {
      showStatus("Your current role cannot manage sharing for this space.", "error", 3500);
      return;
    }
    if (!nearbyShareAvailable) {
      showStatus("Sharing isn't available on this device.", "warning", 3000);
      return;
    }
    if (nearbySharePendingRole) {
      return;
    }
    setNearbySharePendingRole(shareRole);
    try {
      let inviteUrl = nearbyInviteUrls[shareRole];
      if (!inviteUrl && nearbyInviteShareRequiresPreparedUrl()) {
        inviteUrl = await ensureNearbyInviteUrl(shareRole);
        onOpenAccessQr(shareRole);
        showStatus("Invite ready. Tap Share in the QR screen.", "info", 3000);
        return;
      }
      inviteUrl = inviteUrl ?? (await ensureNearbyInviteUrl(shareRole));
      await shareNearbyInvite(
        buildNearbyInviteSharePayload({
          role: shareRole,
          url: inviteUrl,
        }),
      );
    } catch (error) {
      if (!isNearbyInviteShareDismissalError(error)) {
        const message = error instanceof Error ? error.message : "Unable to share this invite.";
        showStatus(message, "error", 3500);
      }
    } finally {
      setNearbySharePendingRole(null);
    }
  }, [
    accessQrRole,
    accessRole,
    activeOrgId,
    activeProjectId,
    canShareProject,
    ensureNearbyInviteUrl,
    nearbyInviteUrls,
    nearbyShareAvailable,
    nearbySharePendingRole,
    onOpenAccessQr,
    showStatus,
  ]);

  const sectionProps: ComposerAccessSectionViewModel = {
    accessRole,
    activeInviteLink,
    activeNearbyInviteUrl,
    canInviteIntoChat,
    canShareProject,
    canWriteProject,
    copyPendingRole,
    currentInviteLink,
    emailInputRef: email.emailInputRef,
    emailInvitePending: email.emailInvitePending,
    emailValid: email.emailValid,
    emailValue: email.emailValue,
    inviteCancelPendingId: email.inviteCancelPendingId,
    inviteLinkRevokePendingId,
    nearbyQrPendingRole,
    nearbyShareAvailable,
    nearbySharePendingRole,
    pendingInvitations: email.pendingInvitations,
    preparedEmailInvite: email.preparedEmailInvite,
    preparedEmailInviteRef: email.preparedEmailInviteRef,
    sharingPermissionsLoading,
    sharingTargetReady,
    onAccessRoleChange: setAccessRole,
    onCancelInvitation: email.cancelInvitation,
    onCopyInviteLink: () => void copyInviteLink(),
    onEmailValueChange: email.setEmailValue,
    onInviteByEmail: email.inviteByEmail,
    onNearbyShare: () => void nearbyShare(),
    onRevokeInviteLink: () => void revokeLink(),
    onShowNearbyQr: () => void showNearbyQr(),
  };

  return {
    sectionProps,
    qr: {
      inviteUrl: accessQrRole ? nearbyInviteUrls[accessQrRole] : null,
      sharePending:
        accessQrRole !== null && nearbySharePendingRole === accessQrRole,
      copy: () => void copyPreparedInvite(),
      share: () => void nearbyShare(),
    },
  };
}
