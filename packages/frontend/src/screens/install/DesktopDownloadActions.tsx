import { Button } from "../../components/Button";
import { Text } from "../../components/Text";
import { theme } from "../../styles/theme";
import type { DesktopReleaseLookup } from "../../updates/desktopReleaseManifest";

const SECONDARY_BUTTON_CLASSNAME = [
  theme.button.secondary,
  "dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:text-slate-50",
].join(" ");

// A platform we do not ship yet, shown so the page reads as a deliberate
// choice rather than a missing button. Not a link: there is nothing to
// download, and a disabled-looking anchor invites clicking anyway.
function ComingSoon({ label, testId }: { label: string; testId: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
      data-testid={testId}
    >
      {label}
      <span className="text-xs uppercase tracking-wide">Coming soon</span>
    </span>
  );
}

export function DesktopDownloadActions({
  lookup,
  onRetry,
}: {
  lookup: DesktopReleaseLookup;
  onRetry: () => void;
}) {
  if (lookup.status === "available") {
    const downloads = lookup.manifest.artifacts;
    return (
      <div
        className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
        data-testid="desktop-downloads-available"
        aria-live="polite"
      >
        <a
          className={SECONDARY_BUTTON_CLASSNAME}
          href={downloads.macDmg}
          target="_blank"
          rel="noreferrer"
        >
          {downloads.macArch === "arm64"
            ? "macOS Apple silicon (DMG)"
            : "macOS Intel (DMG)"}
        </a>
        {downloads.windowsExe ? (
          <a
            className={SECONDARY_BUTTON_CLASSNAME}
            href={downloads.windowsExe}
            target="_blank"
            rel="noreferrer"
          >
            Windows (EXE)
          </a>
        ) : (
          <ComingSoon label="Windows" testId="desktop-download-windows-coming-soon" />
        )}
        {downloads.macArch === "arm64" ? (
          <ComingSoon
            label="macOS Intel"
            testId="desktop-download-mac-intel-coming-soon"
          />
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
