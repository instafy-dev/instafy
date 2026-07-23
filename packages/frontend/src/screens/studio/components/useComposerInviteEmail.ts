import { useCallback, useEffect, useRef, useState } from "react";
import { isLikelyInviteEmail } from "../../../conversations/inviteCommand";
import {
  type AccessInviteScope,
  useScopedInvitationActions,
} from "../../../org/useInviteActions";
import type { PreparedEmailInvite } from "../../../sharing/preparedEmailInvite";
import { useStatus } from "../../../status/useStatus";
import type { ComposerInviteRole } from "./ComposerInviteAccessControls";

type UseComposerInviteEmailOptions = {
  accessRole: ComposerInviteRole;
  activeConversationControllerId: string | null;
  activeOrgId: string | null;
  activeProjectId: string | null;
  canInviteIntoChat: boolean;
  canShareProject: boolean;
  inviteConversationId: string | null;
  inviteScope: AccessInviteScope | null;
  isOpen: boolean;
  onPreparedEmailInviteConsumed: (() => void) | null;
  requestedPreparedEmailInvite: PreparedEmailInvite | null;
};

export function useComposerInviteEmail({
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
}: UseComposerInviteEmailOptions) {
  const { showStatus } = useStatus();
  const [emailValue, setEmailValue] = useState("");
  const [emailInvitePending, setEmailInvitePending] = useState(false);
  const [preparedEmailInvite, setPreparedEmailInvite] =
    useState<PreparedEmailInvite | null>(null);
  const [inviteCancelPendingId, setInviteCancelPendingId] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const preparedEmailInviteRef = useRef<HTMLDivElement | null>(null);
  const { invitations, prepareEmailInvite, cancelPendingInvitation } =
    useScopedInvitationActions(inviteScope);
  const pendingInvitations = invitations.filter((entry) => entry.status === "pending");
  const trimmedEmail = emailValue.trim();
  const emailValid = isLikelyInviteEmail(trimmedEmail);

  useEffect(() => {
    setInviteCancelPendingId(null);
    setPreparedEmailInvite(null);
  }, [activeConversationControllerId, activeOrgId, activeProjectId]);

  useEffect(() => {
    if (!isOpen) {
      setInviteCancelPendingId(null);
      setPreparedEmailInvite(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !requestedPreparedEmailInvite) {
      return;
    }
    setPreparedEmailInvite(requestedPreparedEmailInvite);
    onPreparedEmailInviteConsumed?.();
  }, [isOpen, onPreparedEmailInviteConsumed, requestedPreparedEmailInvite]);

  useEffect(() => {
    if (!isOpen || !preparedEmailInvite || typeof window === "undefined") {
      return;
    }
    emailInputRef.current?.blur();
    const frame = window.requestAnimationFrame(() => {
      const preparedInvite = preparedEmailInviteRef.current;
      preparedInvite
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: true });
      preparedInvite?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, preparedEmailInvite]);

  useEffect(() => {
    if (!isOpen || typeof window === "undefined" || !window.visualViewport) {
      return;
    }

    const keepFocusedControlVisible = () => {
      const focusedControl = document.activeElement;
      const inviteOverlay = document.querySelector('[data-testid="chat-invite-modal"]');
      if (!(focusedControl instanceof HTMLElement) || !inviteOverlay?.contains(focusedControl)) {
        return;
      }
      window.requestAnimationFrame(() => {
        focusedControl.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };

    window.visualViewport.addEventListener("resize", keepFocusedControlVisible);
    return () => {
      window.visualViewport?.removeEventListener("resize", keepFocusedControlVisible);
    };
  }, [isOpen]);

  const cancelInvitation = useCallback(
    async (invitationId: string, email: string) => {
      if (inviteCancelPendingId) {
        return;
      }
      if (
        typeof window !== "undefined" &&
        !window.confirm(`Cancel the invitation for ${email}?`)
      ) {
        return;
      }
      setInviteCancelPendingId(invitationId);
      try {
        const result = await cancelPendingInvitation(invitationId);
        if (!result.success) {
          throw new Error(result.error ?? "Unable to cancel invitation.");
        }
        showStatus(`Canceled invitation for ${email}.`, "success", 2500);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to cancel invitation.";
        showStatus(message, "error", 3500);
      } finally {
        setInviteCancelPendingId(null);
      }
    },
    [cancelPendingInvitation, inviteCancelPendingId, showStatus],
  );

  const inviteByEmail = useCallback(async () => {
    if (!activeOrgId || !activeProjectId) {
      showStatus("Select a space before inviting people.", "warning", 3000);
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
    if (!emailValid) {
      showStatus("Enter a valid email address.", "error", 3000);
      return;
    }
    if (emailInvitePending) {
      return;
    }
    setPreparedEmailInvite(null);
    setEmailInvitePending(true);
    try {
      const result = await prepareEmailInvite(trimmedEmail, accessRole);
      if (!result.success) {
        throw new Error(result.error ?? "Unable to create email invite.");
      }
      setPreparedEmailInvite(result.preparedInvite);
      showStatus(
        `Invite prepared for ${trimmedEmail}. Instafy has not sent an email.`,
        "success",
        4500,
      );
      setEmailValue("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create email invite.";
      showStatus(message, "error", 3500);
    } finally {
      setEmailInvitePending(false);
    }
  }, [
    accessRole,
    activeOrgId,
    activeProjectId,
    canInviteIntoChat,
    canShareProject,
    emailInvitePending,
    emailValid,
    inviteConversationId,
    prepareEmailInvite,
    showStatus,
    trimmedEmail,
  ]);

  return {
    emailInputRef,
    emailInvitePending,
    emailValid,
    emailValue,
    inviteCancelPendingId,
    pendingInvitations,
    preparedEmailInvite,
    preparedEmailInviteRef,
    setEmailValue,
    cancelInvitation: (invitationId: string, email: string) =>
      void cancelInvitation(invitationId, email),
    inviteByEmail: () => void inviteByEmail(),
  };
}
