import { Button } from "../components/Button";
import { Text } from "../components/Text";
import {
  NativeExtensionActionRow,
  NativeExtensionDetailCard,
  NativeExtensionDeviceCard,
} from "../extensions/nativeExtensionSetupUi";

export type CameraAttachedDeviceListItem = {
  providerId: string;
  label: string;
  platformLabel: string | null;
  summaryText: string;
  freshnessText: string | null;
  tone: "secondary" | "warning";
  presenceStatus: "online" | "offline";
  isDefault: boolean;
  isCurrentDevice: boolean;
  onMakeDefault?: (() => void) | null;
};

type CameraAttachedDeviceListPanelProps = {
  items: CameraAttachedDeviceListItem[];
  testId?: string;
};

export function CameraAttachedDeviceListPanel({
  items,
  testId = "project-provider-camera-attached-devices",
}: CameraAttachedDeviceListPanelProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <NativeExtensionDetailCard
      className="space-y-3 rounded-2xl bg-transparent dark:bg-transparent"
      testId={testId}
    >
      <div className="space-y-1">
        <Text variant="caption" tone="muted">
          Camera devices
        </Text>
        <Text variant="caption" tone="muted">
          Photo requests use the preferred device.
        </Text>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <NativeExtensionDeviceCard
            key={item.providerId}
            title={item.label}
            className="rounded-2xl bg-transparent dark:bg-transparent"
            testId={`${testId}-${item.providerId}`}
            meta={[
              [
                item.isDefault ? "Preferred" : null,
                item.isCurrentDevice ? "This device" : null,
                item.presenceStatus === "online" ? "Online" : "Offline",
                item.platformLabel,
              ]
                .filter(Boolean)
                .join(" · "),
            ]}
            summary={item.summaryText}
            summaryTone={item.tone === "warning" ? "warning" : "secondary"}
          >
            <NativeExtensionActionRow>
              {item.freshnessText ? (
                <Text variant="caption" tone="muted">
                  {item.freshnessText}
                </Text>
              ) : null}
              {!item.isDefault && item.onMakeDefault ? (
                <Button
                  variant="secondary"
                  size="xs"
                  radius="full"
                  onPress={item.onMakeDefault}
                  data-testid={`${testId}-make-default-${item.providerId}`}
                >
                  Use for new photos
                </Button>
              ) : null}
            </NativeExtensionActionRow>
          </NativeExtensionDeviceCard>
        ))}
      </div>
    </NativeExtensionDetailCard>
  );
}
