import { QrCode, SendDiagonal } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";

type ComposerInviteDeviceHandoffProps = {
  browserUrl: string | null;
  appUrl: string | null;
  shareAvailable: boolean;
  sharePending: boolean;
  onCopy: () => void;
  onShowQr: () => void;
  onShare: () => void;
};

export function ComposerInviteDeviceHandoff({
  browserUrl,
  appUrl,
  shareAvailable,
  sharePending,
  onCopy,
  onShowQr,
  onShare,
}: ComposerInviteDeviceHandoffProps) {
  return (
    <div
      className="space-y-2.5 rounded-2xl border border-white/10 bg-white/[0.035] p-3"
      data-testid="composer-device-handoff"
    >
      <div className="min-w-0">
        <Text variant="bodyStrong" tone="primary" className="text-sm">
          Open on my other device
        </Text>
        <Text as="p" variant="caption" tone="muted" className="mt-1 text-xs leading-snug">
          Scan to open the app, or copy the browser link. Both use your existing account and grant no
          access.
        </Text>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          radius="full"
          onPress={onCopy}
          isDisabled={!browserUrl}
          className="min-w-0 flex-1 justify-start px-3"
          data-testid="composer-device-handoff-copy"
        >
          Copy device link
        </Button>
        <div className="flex shrink-0 items-center gap-2">
          <IconButton
            type="button"
            variant="outline"
            size="sm"
            radius="full"
            onPress={onShowQr}
            isDisabled={!appUrl}
            data-testid="composer-device-handoff-show-qr"
            aria-label="Show device QR code"
            title="Show device QR code"
          >
            <QrCode className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          {shareAvailable ? (
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              radius="full"
              onPress={onShare}
              isDisabled={!browserUrl || sharePending}
              data-testid="composer-device-handoff-share"
              aria-label="Share device link"
              title="Share device link"
            >
              {sharePending ? (
                <Spinner aria-hidden="true" tone="primary" size="xs" />
              ) : (
                <SendDiagonal className="h-4 w-4" aria-hidden="true" />
              )}
            </IconButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
