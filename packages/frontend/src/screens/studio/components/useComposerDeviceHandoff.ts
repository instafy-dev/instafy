import { useCallback, useMemo, useState } from "react";
import { buildNativeStudioDeepLink } from "../../../native/nativeDeepLinks";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import {
  canUseNearbyInviteShare,
  isNearbyInviteShareDismissalError,
  shareNearbyInvite,
} from "../../../sharing/nearbyInviteShare";
import { useStatus } from "../../../status/useStatus";
import { resolvePublicAppUrl } from "../../../utils/publicAppUrl";
import type { ComposerInviteDeviceHandoff } from "./ComposerInviteDeviceHandoff";

type ComposerInviteDeviceHandoffViewModel = React.ComponentProps<
  typeof ComposerInviteDeviceHandoff
>;

type UseComposerDeviceHandoffOptions = {
  activeConversationControllerId: string | null;
  activeProjectId: string | null;
  onOpenQr: () => void;
};

export function buildAuthenticatedDeviceHandoffUrl(
  projectId: string,
  conversationControllerId: string | null,
): string {
  const url = new URL(resolvePublicAppUrl("/studio"));
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("panel", "chat");
  if (conversationControllerId) {
    url.searchParams.set("conversationControllerId", conversationControllerId);
  }
  return url.toString();
}

export function useComposerDeviceHandoff({
  activeConversationControllerId,
  activeProjectId,
  onOpenQr,
}: UseComposerDeviceHandoffOptions) {
  const { showStatus } = useStatus();
  const [sharePending, setSharePending] = useState(false);
  const shareAvailable = canUseNearbyInviteShare();
  const browserUrl = useMemo(
    () =>
      activeProjectId
        ? buildAuthenticatedDeviceHandoffUrl(
            activeProjectId,
            activeConversationControllerId,
          )
        : null,
    [activeConversationControllerId, activeProjectId],
  );
  const appUrl = useMemo(
    () =>
      activeProjectId
        ? buildNativeStudioDeepLink({
            projectId: activeProjectId,
            conversationControllerId: activeConversationControllerId,
            panel: "chat",
          })
        : null,
    [activeConversationControllerId, activeProjectId],
  );

  const copy = useCallback(async () => {
    if (!browserUrl) {
      showStatus("Select a space before opening it on another device.", "warning", 3000);
      return;
    }
    try {
      await writeClipboardText(browserUrl);
      showStatus("Device link copied.", "success", 2200, {
        presentation: "confirmation",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy device link.";
      showStatus(message, "error", 3500);
    }
  }, [browserUrl, showStatus]);

  const share = useCallback(async () => {
    if (!browserUrl) {
      showStatus("Select a space before opening it on another device.", "warning", 3000);
      return;
    }
    if (!shareAvailable) {
      showStatus("Sharing isn't available on this device.", "warning", 3000);
      return;
    }
    if (sharePending) {
      return;
    }
    setSharePending(true);
    try {
      await shareNearbyInvite({
        title: "Open my Instafy space",
        text: "Open this space while signed in to my Instafy account. This link grants no new access.",
        url: browserUrl,
        dialogTitle: "Open on another device",
      });
    } catch (error) {
      if (!isNearbyInviteShareDismissalError(error)) {
        const message = error instanceof Error ? error.message : "Unable to share this device link.";
        showStatus(message, "error", 3500);
      }
    } finally {
      setSharePending(false);
    }
  }, [browserUrl, shareAvailable, sharePending, showStatus]);

  const sectionProps: ComposerInviteDeviceHandoffViewModel = {
    browserUrl,
    appUrl,
    shareAvailable,
    sharePending,
    onCopy: () => void copy(),
    onShowQr: onOpenQr,
    onShare: () => void share(),
  };

  return {
    sectionProps,
    qr: {
      inviteUrl: appUrl,
      shareAvailable,
      sharePending,
      copy: () => void copy(),
      share: () => void share(),
    },
  };
}
