import { InlineNotice } from "@instafy/frontend/feature-api/ui";
import type { KnoshDesktopOperatorHint } from "./knoshDesktopOperatorHints";

type KnoshDesktopNoticeStackProps = {
  runtimeId: "native_desktop_ble" | "web_bluetooth" | null;
  showDeveloperDetails: boolean;
  hints: KnoshDesktopOperatorHint[];
  buildTestId: (suffix: string) => string;
};

export function KnoshDesktopNoticeStack({
  runtimeId,
  showDeveloperDetails,
  hints,
  buildTestId,
}: KnoshDesktopNoticeStackProps) {
  if (!runtimeId) {
    return null;
  }

  const visibleHints = hints.filter((hint) => showDeveloperDetails || !hint.developerOnly);
  const showOperatorNote = showDeveloperDetails;

  return (
    <>
      {showOperatorNote ? (
        <InlineNotice
          tone={runtimeId === "native_desktop_ble" ? "info" : "warning"}
          title="Desktop Knosh operator note"
          data-testid={buildTestId("desktop-operator-note")}
        >
          If desktop BLE behaves strangely, validate the native bridge before blaming the Electron UI:
          {" "}
          `pnpm --filter @instafy/desktop-app smoke:knosh:native:release`
          {" "}
          That release smoke runs the direct native, reconnect, and helper-recovery checks in order against the macOS CoreBluetooth bridge.
        </InlineNotice>
      ) : null}

      {visibleHints.length > 0 ? (
        <div className="space-y-2">
          {visibleHints.map((hint) => (
            <InlineNotice
              key={`${hint.title}-${hint.tone}`}
              tone={hint.tone}
              title={hint.title}
              data-testid={buildTestId(
                `desktop-hint-${hint.title.toLowerCase().replace(/\s+/g, "-")}`,
              )}
            >
              {hint.body}
              {showDeveloperDetails && hint.details ? ` ${hint.details}` : ""}
            </InlineNotice>
          ))}
        </div>
      ) : null}
    </>
  );
}
