import { Button } from "../../../components/Button";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";

export type ComposerInviteRole = "viewer" | "builder";

export function ComposerInviteRoleToggle({
  value,
  onChange,
  viewerLabel,
  builderLabel,
  testIdPrefix,
}: {
  value: ComposerInviteRole;
  onChange: (value: ComposerInviteRole) => void;
  viewerLabel: string;
  builderLabel: string;
  testIdPrefix: string;
}) {
  return (
    <SegmentedControl<ComposerInviteRole>
      value={value}
      onChange={onChange}
      options={[
        {
          value: "viewer",
          label: viewerLabel,
          testId: `${testIdPrefix}-viewer`,
        },
        {
          value: "builder",
          label: builderLabel,
          testId: `${testIdPrefix}-builder`,
        },
      ]}
      size="sm"
      tone="inverse"
      width="fit"
    />
  );
}

type PendingInvitation = {
  email: string;
  id: string;
  role: string;
};

export function ComposerPendingInvitationList({
  invitations,
  pendingId,
  onCancel,
}: {
  invitations: PendingInvitation[];
  pendingId: string | null;
  onCancel: (invitation: PendingInvitation) => void;
}) {
  if (invitations.length === 0) {
    return null;
  }

  return (
    <div
      className="divide-y divide-slate-800/80 rounded-xl border border-white/10 px-3"
      data-testid="composer-invite-pending-list"
    >
      {invitations.map((invitation) => (
        <div
          key={invitation.id}
          className="flex items-center justify-between gap-3 py-2"
          data-testid={`composer-invite-pending-${invitation.id}`}
        >
          <div className="min-w-0">
            <Text as="div" variant="caption" tone="primary" className="truncate text-xs">
              {invitation.email}
            </Text>
            <Text as="div" variant="caption" tone="muted" className="text-xxs">
              {invitation.role === "builder" ? "Edit" : "Read"} access
            </Text>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            radius="full"
            onPress={() => onCancel(invitation)}
            isDisabled={pendingId !== null}
            data-testid={`composer-invite-cancel-${invitation.id}`}
          >
            {pendingId === invitation.id ? (
              <Spinner aria-hidden="true" tone="primary" size="xs" />
            ) : null}
            Cancel
          </Button>
        </div>
      ))}
    </div>
  );
}
