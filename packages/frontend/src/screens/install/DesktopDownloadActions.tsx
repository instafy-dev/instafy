import { Button } from "../../components/Button";
import { Text } from "../../components/Text";
import { theme } from "../../styles/theme";
import type { DesktopReleaseLookup } from "../../updates/desktopReleaseManifest";

export function DesktopDownloadActions({
  lookup,
  onRetry,
}: {
  lookup: DesktopReleaseLookup;
  onRetry: () => void;
}) {
  if (lookup.status === "available") {
    const downloads = lookup.manifest.artifacts;
    // Platforms we do not ship yet, named in one quiet sentence so the page
    // reads as a deliberate choice rather than missing buttons. They used to
    // be dashed outlined chips sitting at the same visual weight as the real
    // download, which made the one action on this page look like one option
    // among disabled equals.
    const comingSoon: { label: string; testId: string }[] = [];
    if (!downloads.windowsExe) {
      comingSoon.push({ label: "Windows", testId: "desktop-download-windows-coming-soon" });
    }
    if (downloads.macArch === "arm64") {
      comingSoon.push({ label: "macOS Intel", testId: "desktop-download-mac-intel-coming-soon" });
    }
    return (
      <div
        className="mt-5 flex flex-col gap-3"
        data-testid="desktop-downloads-available"
        aria-live="polite"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {/* The one primary action on the page. */}
          <a
            className={theme.button.primary}
            href={downloads.macDmg}
            target="_blank"
            rel="noreferrer"
          >
            {downloads.macArch === "arm64"
              ? "Download for macOS (Apple silicon)"
              : "Download for macOS (Intel)"}
          </a>
          {downloads.windowsExe ? (
            <a
              className={theme.button.secondary}
              href={downloads.windowsExe}
              target="_blank"
              rel="noreferrer"
            >
              Windows (EXE)
            </a>
          ) : null}
        </div>
        {comingSoon.length > 0 ? (
          <Text variant="caption" tone="muted">
            {comingSoon.map((item, index) => (
              <span key={item.testId} data-testid={item.testId}>
                {index > 0 ? " and " : ""}
                {item.label}
              </span>
            ))}
            {comingSoon.length > 1 ? " builds are" : " build is"} coming soon.
          </Text>
        ) : null}
      </div>
    );
  }

  if (lookup.status === "loading") {
    return (
      <Text
        variant="caption"
        tone="muted"
        className="mt-5"
        role="status"
        aria-live="polite"
        data-testid="desktop-downloads-loading"
      >
        Checking for signed desktop installers…
      </Text>
    );
  }

  if (lookup.status === "unavailable") {
    return (
      <div
        className="mt-5 space-y-2"
        role="status"
        data-testid="desktop-downloads-unavailable"
      >
        <Text variant="caption" tone="muted">
          Signed desktop installers are not published yet. This page checks again automatically.
        </Text>
        <Button onPress={onRetry} variant="outline" size="sm" radius="full">
          Check again
        </Button>
      </div>
    );
  }

  const errorMessage =
    lookup.reason === "invalid_manifest"
      ? "Desktop download information could not be verified."
      : lookup.reason === "timeout"
        ? "Desktop downloads took too long to respond."
        : "Desktop downloads are temporarily unavailable.";
  return (
    <div className="mt-5 space-y-2" role="status" data-testid="desktop-downloads-error">
      <Text variant="caption" tone="muted">
        {errorMessage}
      </Text>
      <Button onPress={onRetry} variant="outline" size="sm" radius="full">
        Retry downloads
      </Button>
    </div>
  );
}
