import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { StudioDialogSectionLabel } from "../../../components/aria/StudioDialogLayout";
import type { ControllerProjectMember } from "../../../sdk/instafy";

type ComposerInvitePrivateChatSectionProps = {
  conversationReady: boolean;
  loading: boolean;
  members: ControllerProjectMember[];
  participantIdSet: Set<string>;
  busyUserId: string | null;
  onInvite: (member: ControllerProjectMember) => void;
};

export function ComposerInvitePrivateChatSection({
  conversationReady,
  loading,
  members,
  participantIdSet,
  busyUserId,
  onInvite,
}: ComposerInvitePrivateChatSectionProps) {
  return (
    <section className="space-y-2.5">
      <StudioDialogSectionLabel className="text-3xs uppercase tracking-[0.24em]">
        Private chat
      </StudioDialogSectionLabel>
      {!conversationReady ? (
        <Text as="p" variant="caption" tone="muted" className="text-xs leading-snug">
          Send once to add people here.
        </Text>
      ) : loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-300">
          <Spinner aria-hidden="true" size="xs" />
          Loading people…
        </div>
      ) : members.length === 0 ? (
        <Text as="p" variant="caption" tone="muted" className="text-xs leading-snug">
          No teammates yet.
        </Text>
      ) : (
        <div
          className="studio-dark-scrollbar max-h-44 divide-y divide-slate-200/80 overflow-auto pr-1 dark:divide-slate-800"
          data-testid="composer-invite-chat-list"
        >
          {members.map((member) => {
            const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
            const email = typeof member.email === "string" ? member.email.trim() : "";
            const label = fullName || email || "Teammate";
            const subtitle = fullName && email ? email : null;
            const invited = participantIdSet.has(member.userId);
            const isBusy = busyUserId === member.userId;
            return (
              <div
                key={member.userId}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Text as="div" variant="bodyStrong" tone="primary" className="truncate text-sm">
                    {label}
                  </Text>
                  {subtitle ? (
                    <Text as="div" variant="caption" tone="muted" className="truncate text-xxs">
                      {subtitle}
                    </Text>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant={invited ? "outline" : "primary"}
                  size="xs"
                  radius="full"
                  isDisabled={invited || busyUserId !== null}
                  onPress={() => onInvite(member)}
                  className="shrink-0"
                >
                  {isBusy ? <Spinner aria-hidden="true" tone="primary" size="xs" /> : null}
                  {invited ? "In chat" : "Add"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
