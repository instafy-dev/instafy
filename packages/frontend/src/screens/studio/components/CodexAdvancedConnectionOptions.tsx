import { useEffect, useRef, useState } from "react";
import { Computer, FloppyDisk, NavArrowDown, ShareAndroid, Upload } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import {
  canShareDesktopSetupLink,
  INSTAFY_DESKTOP_INSTALL_URL,
  shareDesktopSetupLink,
} from "../../../desktop/install";
import { isNearbyInviteShareDismissalError } from "../../../sharing/nearbyInviteShare";
import { theme } from "../../../styles/theme";
import { openExternalUrl } from "../../../utils/openExternalUrl";

type CodexAdvancedConnectionOptionsProps = {
  allowAuthJsonImport: boolean;
  expanded: boolean;
  label: string;
  onExpandedChange: (expanded: boolean) => void;
  onLabelChange: (label: string) => void;
  onChooseAuthJson: () => void;
  // Dev-only: seed this machine's Codex login. Handled by the connect flow so
  // completion (loadCredentials + close) and busy state match every other path.
  canDevSeed?: boolean;
  busy?: boolean;
  onDevSeed?: () => void;
};

const ADVANCED_OPTIONS_ID = "credentials-codex-advanced-options";

export function CodexAdvancedConnectionOptions({
  allowAuthJsonImport,
  expanded,
  label,
  onExpandedChange,
  onLabelChange,
  onChooseAuthJson,
  canDevSeed = false,
  busy = false,
  onDevSeed,
}: CodexAdvancedConnectionOptionsProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [desktopSetupShareFailed, setDesktopSetupShareFailed] = useState(false);
  const canShareDesktopSetup =
    !desktopSetupShareFailed && canShareDesktopSetupLink();

  useEffect(() => {
    if (!expanded || typeof panelRef.current?.scrollIntoView !== "function") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          onPress={() => onExpandedChange(!expanded)}
          variant="ghost"
          size="xs"
          radius="full"
          aria-controls={ADVANCED_OPTIONS_ID}
          aria-expanded={expanded}
          data-testid="credentials-codex-advanced-toggle"
        >
          Advanced options
          <NavArrowDown
            className={[
              "h-4 w-4 transition-transform duration-150",
              expanded ? "rotate-180" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-hidden="true"
          />
        </Button>
      </div>

      {expanded ? (
        <div
          ref={panelRef}
          id={ADVANCED_OPTIONS_ID}
          data-testid="credentials-codex-advanced-options"
          className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-900/40"
        >
          {allowAuthJsonImport ? (
            <>
              {canDevSeed && onDevSeed ? (
                <div className="space-y-1.5 border-b border-slate-200 pb-3 dark:border-slate-800">
                  <div className="space-y-0.5">
                    <Text variant="bodyStrong" tone="secondary" className="text-sm">
                      Seed from this machine (dev)
                    </Text>
                    <Text variant="caption" tone="muted">
                      Connects ~/.codex/auth.json via the local dev server and makes
                      it the default, replacing any earlier dev seed. Always current
                      — no upload needed.
                    </Text>
                  </div>
                  <Button
                    type="button"
                    onPress={onDevSeed}
                    variant="outline"
                    size="sm"
                    radius="full"
                    isDisabled={busy}
                    className="min-h-11 w-full sm:w-auto"
                    data-testid="credentials-codex-dev-seed"
                  >
                    <FloppyDisk className="h-4 w-4" aria-hidden="true" />
                    {busy ? "Seeding…" : "Use local Codex login (dev)"}
                  </Button>
                </div>
              ) : null}
              <div className="space-y-0.5">
                <Text variant="bodyStrong" tone="secondary" className="text-sm">
                  Import an existing Codex login
                </Text>
                <Text variant="caption" tone="muted">
                  Choose a Codex auth.json file from this device instead of device-code login.
                </Text>
              </div>

              <Field
                label="Imported connection label (optional)"
                htmlFor="credentials-codex-label"
                className="w-full"
              >
                <Input
                  id="credentials-codex-label"
                  value={label}
                  onChange={(event) => onLabelChange(event.target.value)}
                  placeholder="Work, Personal…"
                  size="sm"
                  radius="xl"
                  autoComplete="off"
                  data-testid="credentials-codex-label-input"
                  data-lpignore="true"
                  data-bwignore="true"
                  data-1p-ignore="true"
                />
              </Field>

              <Button
                type="button"
                onPress={onChooseAuthJson}
                variant="outline"
                size="sm"
                radius="full"
                className="min-h-11 w-full sm:w-auto"
                data-testid="credentials-codex-auth-json-upload"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                Choose auth.json
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-0.5">
                <Text variant="bodyStrong" tone="secondary" className="text-sm">
                  Continue on your computer
                </Text>
                <Text variant="caption" tone="muted">
                  Download Instafy Desktop to connect Codex once, then use it on this phone.
                </Text>
              </div>
              <a
                href={INSTAFY_DESKTOP_INSTALL_URL}
                target="_blank"
                rel="noreferrer"
                className={`${theme.button.secondary} min-h-11 w-full gap-2 px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40`}
                data-testid="credentials-codex-desktop-install"
                onClick={(event) => {
                  event.preventDefault();
                  if (!canShareDesktopSetup) {
                    void openExternalUrl(INSTAFY_DESKTOP_INSTALL_URL);
                    return;
                  }
                  void shareDesktopSetupLink().catch((error: unknown) => {
                    if (!isNearbyInviteShareDismissalError(error)) {
                      setDesktopSetupShareFailed(true);
                    }
                  });
                }}
              >
                {canShareDesktopSetup ? (
                  <ShareAndroid className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Computer className="h-4 w-4" aria-hidden="true" />
                )}
                {canShareDesktopSetup ? "Send setup link" : "Open Desktop setup"}
              </a>
              {desktopSetupShareFailed ? (
                <Text role="status" variant="caption" tone="danger">
                  Sharing was unavailable. Tap Open Desktop setup instead.
                </Text>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
