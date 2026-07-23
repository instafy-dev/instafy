import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { controllerClient } from "../../../sdk/instafy";
import type { StatusIntent } from "../../../status/useStatus";

const {
  addParticipant: addControllerConversationParticipant,
  listParticipants: listControllerConversationParticipants,
} = controllerClient.conversations;

type ShowStatus = (message: string, intent: StatusIntent, durationMs?: number) => void;

type MentionableUser = {
  email?: string | null;
  fullName?: string | null;
  userId?: string | null;
};

type ActiveConversationLike = {
  controllerId?: string | null;
  visibility?: string | null;
};

export function useChatConversationInviteState({
  activeConversation,
  activeConversationId,
  addMenuOpen,
  clearConversationInvite,
  pendingConversationInviteId,
  setAddMenuOpen,
  showStatus,
}: {
  activeConversation: ActiveConversationLike | null;
  activeConversationId: string | null;
  addMenuOpen: boolean;
  clearConversationInvite: () => void;
  pendingConversationInviteId: string | null;
  setAddMenuOpen: Dispatch<SetStateAction<boolean>>;
  showStatus: ShowStatus;
}) {
  const [inviteParticipantsLoading, setInviteParticipantsLoading] = useState(false);
  const [inviteParticipantUserIds, setInviteParticipantUserIds] = useState<string[] | null>(null);
  const [inviteParticipantBusyUserId, setInviteParticipantBusyUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!addMenuOpen) {
      setInviteParticipantBusyUserId(null);
      setInviteParticipantUserIds(null);
      setInviteParticipantsLoading(false);
    }
  }, [addMenuOpen]);

  useEffect(() => {
    if (!pendingConversationInviteId || pendingConversationInviteId !== activeConversationId) {
      return;
    }
    if (!addMenuOpen) {
      setAddMenuOpen(true);
    }
    clearConversationInvite();
  }, [
    activeConversationId,
    addMenuOpen,
    clearConversationInvite,
    pendingConversationInviteId,
    setAddMenuOpen,
  ]);

  const inviteParticipantIdSet = useMemo(
    () => new Set(inviteParticipantUserIds ?? []),
    [inviteParticipantUserIds],
  );

  useEffect(() => {
    if (!addMenuOpen) {
      return;
    }
    if (activeConversation?.visibility !== "private" || !activeConversation.controllerId) {
      setInviteParticipantUserIds(null);
      setInviteParticipantsLoading(false);
      return;
    }
    let cancelled = false;
    setInviteParticipantsLoading(true);
    void (async () => {
      const participants = await listControllerConversationParticipants({
        conversationId: activeConversation.controllerId ?? "",
        accessToken: null,
      });
      if (cancelled) {
        return;
      }
      setInviteParticipantUserIds(
        participants ? participants.map((participant) => participant.userId) : [],
      );
      setInviteParticipantsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversation?.controllerId, activeConversation?.visibility, addMenuOpen]);

  const handleInviteTeammate = useCallback(
    async (member: MentionableUser) => {
      const controllerId = activeConversation?.controllerId ?? null;
      if (!controllerId) {
        showStatus("Start a private chat before inviting teammates here.", "info", 4000);
        return;
      }
      const targetUserId = typeof member.userId === "string" ? member.userId.trim() : "";
      if (!targetUserId || inviteParticipantBusyUserId) {
        return;
      }

      setInviteParticipantBusyUserId(targetUserId);
      try {
        const result = await addControllerConversationParticipant({
          conversationId: controllerId,
          userId: targetUserId,
          role: "member",
          accessToken: null,
        });
        if (!result) {
          throw new Error("Invite failed. Try again.");
        }
        setInviteParticipantUserIds(result.map((participant) => participant.userId));
        const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
        const email = typeof member.email === "string" ? member.email.trim() : "";
        showStatus(`Invited ${fullName || email || "teammate"}.`, "success", 2500);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(message, "error", 4500);
      } finally {
        setInviteParticipantBusyUserId(null);
      }
    },
    [activeConversation?.controllerId, inviteParticipantBusyUserId, showStatus],
  );

  return {
    inviteParticipantBusyUserId,
    inviteParticipantIdSet,
    inviteParticipantsLoading,
    handleInviteTeammate,
  };
}
