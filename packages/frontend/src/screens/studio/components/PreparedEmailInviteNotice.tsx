import { useState } from "react";
import { Button } from "../../../components/Button";
import { InlineNotice } from "../../../components/InlineNotice";
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
    <InlineNotice
      tone="warning"
      role="status"
      title={<span className="break-words">Invite prepared for {invite.email}</span>}
      data-testid={`${testIdPrefix}-prepared`}
      actions={<>
        <Button
          type="button"
          variant="primary"
          preset="inline"
          onPress={() => void handleShare()}
          isPending={sharePending}
          data-testid={`${testIdPrefix}-share`}
        >
          {shareAvailable ? "Share invite" : "Open email"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          preset="inline"
          onPress={() => void handleCopy()}
          isPending={copyPending}
          data-testid={`${testIdPrefix}-copy`}
        >
          Copy link
        </Button>
      </>}
    >
      Instafy has not sent an email. Share it now or copy the secure accept link.
    </InlineNotice>
  );
}
