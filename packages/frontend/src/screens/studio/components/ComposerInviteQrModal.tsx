import { SendDiagonal } from "iconoir-react";
import QRCode from "react-qr-code";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  StudioDialogBody,
  StudioDialogHeader,
} from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";

type ComposerInviteQrModalProps = {
  inviteUrl: string | null;
  onClose: () => void;
  onCopy: () => void;
  onShare: () => void;
  role: "viewer" | "builder" | "device" | null;
  shareAvailable: boolean;
  sharePending: boolean;
};

export function ComposerInviteQrModal({
  inviteUrl,
  onClose,
  onCopy,
  onShare,
  role,
  shareAvailable,
  sharePending,
}: ComposerInviteQrModalProps) {
  return (
    <StudioDialogModal
      isOpen={role !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      isDismissable
      appearance="dark"
      backdrop="opaque"
      dialogAriaLabel="Invite QR code"
      data-testid="composer-invite-nearby-qr-modal"
      modalClassName="h-full w-full max-w-none overflow-hidden rounded-none border-none p-0 shadow-none sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-sm sm:rounded-[2rem] sm:border sm:shadow-modal"
      dialogClassName="flex h-full min-h-0 flex-col sm:h-auto sm:max-h-[calc(100dvh-2rem)]"
    >
      <StudioDialogHeader
        title={
          role === "device"
            ? "Open on My Device"
            : role === "builder"
              ? "Edit Invite"
              : "Read Invite"
        }
        onClose={onClose}
        closeLabel="Close QR code"
        className="border-[rgba(255,255,255,0.08)]"
        titleClassName="text-slate-50"
      />
      <StudioDialogBody className="studio-dark-scrollbar min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-5 pb-8 pt-4">
        <div className="flex min-h-full items-center justify-center py-2">
          <div className="w-full space-y-5">
            <div className="flex justify-center">
              <div
                className="rounded-[1.5rem] bg-white p-4 shadow-modal"
                data-testid="composer-invite-nearby-qr"
                role="img"
                aria-label={
                  role === "device"
                    ? "QR code to open this space on another signed-in device"
                    : role === "builder"
                    ? "QR code for an edit-access invitation"
                    : "QR code for a read-access invitation"
                }
              >
                {inviteUrl ? (
                  <QRCode
                    value={inviteUrl}
                    size={240}
                    bgColor="#ffffff"
                    fgColor="#0f172a"
                    level="M"
                    style={{ height: "auto", width: "min(15rem, 62vw, 50svh)" }}
                  />
                ) : null}
              </div>
            </div>
            <Text
              as="p"
              variant="caption"
              tone="muted"
              className="text-center text-sm text-slate-400"
            >
              {role === "device"
                ? "Scan while signed in to the same account. This link grants no new access."
                : "Scan on the other device."}
            </Text>
            {inviteUrl ? (
              <Text
                as="p"
                variant="caption"
                tone="muted"
                className="sr-only"
                data-testid="composer-invite-nearby-url"
              >
                {inviteUrl}
              </Text>
            ) : null}
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                radius="full"
                onPress={onCopy}
                className="border-white/15 text-slate-100 hover:bg-white/10 data-[hovered]:bg-white/10"
                data-testid="composer-invite-nearby-copy-from-qr"
              >
                Copy link
              </Button>
              {shareAvailable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  radius="full"
                  onPress={onShare}
                  isDisabled={sharePending}
                  className="text-slate-100 hover:bg-white/10 data-[hovered]:bg-white/10"
                  data-testid="composer-invite-nearby-share-from-qr"
                >
                  {sharePending ? (
                    <Spinner aria-hidden="true" tone="primary" size="xs" />
                  ) : (
                    <SendDiagonal className="h-4 w-4" aria-hidden="true" />
                  )}
                  Share instead
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </StudioDialogBody>
    </StudioDialogModal>
  );
}
