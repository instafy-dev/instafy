import { useState } from "react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import {
  buildPreparedEmailInviteSharePayload,
  openPreparedEmailInviteComposer,
  type PreparedEmailInvite,
} from "../../../sharing/preparedEmailInvite";
import {
  canUseNearbyInviteShare,
  isNearbyInviteShareDismissalError,
  shareNearbyInvite,
} from "../../../sharing/nearbyInviteShare";
import { useStatus } from "../../../status/useStatus";

type PreparedEmailInviteNoticeProps = {
  invite: PreparedEmailInvite;
  testIdPrefix: string;
};

export function PreparedEmailInviteNotice({
  invite,
  testIdPrefix,
}: PreparedEmailInviteNoticeProps) {
  const { showStatus } = useStatus();
  const [copyPending, setCopyPending] = useState(false);
  const [sharePending, setSharePending] = useState(false);
  const shareAvailable = canUseNearbyInviteShare();

  const handleCopy = async () => {
    if (copyPending) {
      return;
    }
    setCopyPending(true);
    try {
      await writeClipboardText(invite.acceptUrl);
      showStatus(
        "Invite link copied. Instafy has not sent an email.",
        "success",
        3500,
        { presentation: "confirmation" },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy invite link.";
      showStatus(message, "error", 3500);
    } finally {
      setCopyPending(false);
    }
  };

  const handleShare = async () => {
    if (sharePending) {
      return;
    }
    setSharePending(true);
    try {
      if (shareAvailable) {
        await shareNearbyInvite(buildPreparedEmailInviteSharePayload(invite));
      } else {
        openPreparedEmailInviteComposer(invite);
      }
    } catch (error) {
      if (!isNearbyInviteShareDismissalError(error)) {
        const message = error instanceof Error ? error.message : "Unable to share invite.";
        showStatus(message, "error", 3500);
      }
    } finally {
      setSharePending(false);
    }
  };

  return (
    <div
      className="space-y-2.5 rounded-2xl border border-amber-300/50 bg-amber-50/80 p-3 dark:border-amber-300/20 dark:bg-amber-300/[0.06]"
      data-testid={`${testIdPrefix}-prepared`}
    >
      <div className="min-w-0">
        <Text variant="bodyStrong" tone="primary" className="truncate text-sm">
          Invite prepared for {invite.email}
        </Text>
        <Text as="p" variant="caption" tone="muted" className="mt-1 leading-snug">
          Instafy has not sent an email. Share it now or copy the secure accept link.
        </Text>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="primary"
          size="sm"
          radius="full"
          onPress={() => void handleShare()}
          isDisabled={sharePending}
          data-testid={`${testIdPrefix}-share`}
        >
          {sharePending ? <Spinner aria-hidden="true" tone="primary" size="xs" /> : null}
          {shareAvailable ? "Share invite" : "Open email"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          radius="full"
          onPress={() => void handleCopy()}
          isDisabled={copyPending}
          data-testid={`${testIdPrefix}-copy`}
        >
          {copyPending ? <Spinner aria-hidden="true" tone="primary" size="xs" /> : null}
          Copy link
        </Button>
      </div>
    </div>
  );
}
