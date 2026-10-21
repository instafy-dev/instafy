import { useCallback, useEffect, useState } from "react";
import { SettingsFormLayout } from "../../../components/SettingsFormLayout";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { LOCATION_SITES_DESCRIPTION, LocationSitesList, MACOS_LOCATION_SETTINGS } from "./previewHost/PreviewLocation";
import { SettingsSection } from "./SettingsSection";

type DesktopLocationState = InstafyDesktopLocationPermissionState;

const DESKTOP_STATE_TEXT: Record<DesktopLocationState, string> = {
  granted: "Allowed. Sites in previews still ask Instafy, and you see 📍 when one gets it.",
  denied: "Not allowed. Sites in previews can't get your location. Reset to be asked again, here or with the Location Permission… menu item.",
  ask: "Not asked yet. The first time a site asks, Instafy asks you once.",
  system: `macOS asks you the first time a site wants it. Change it in ${MACOS_LOCATION_SETTINGS}.`,
};

/**
 * The desktop app's own answer to "Allow Instafy to use your location?". Only Reset is offered:
 * the native question is the only way to allow it. On macOS the system asks instead, so this
 * only says where to change it.
 */
function DesktopLocationPermission() {
  const desktop = typeof window === "undefined" ? undefined : window.instafyDesktop;
  const readStatus = desktop?.locationPermissionStatus;
  const reset = desktop?.resetLocationPermission;
  const [state, setState] = useState<DesktopLocationState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!readStatus) return;
    let cancelled = false;
    readStatus().then(
      result => { if (!cancelled) setState(result.state); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [readStatus]);

  const onReset = useCallback(() => {
    if (!reset) return;
    reset().then(result => { setState(result.state); setFailed(false); }, () => setFailed(true));
  }, [reset]);

  if (!readStatus) return null;
  return (
    <SettingsSection title="Instafy app" description="Whether this app may use your location at all." data-testid="desktop-location-permission">
      <div className="flex min-h-12 items-center gap-3">
        <Text variant="caption" tone="muted" className="min-w-0 flex-1" data-testid="desktop-location-state">
          {failed ? "Couldn't read this app's location permission." : state ? DESKTOP_STATE_TEXT[state] : "Checking…"}
        </Text>
        {reset && (state === "granted" || state === "denied") ? (
          <Button variant="outline" size="sm" radius="lg" data-testid="desktop-location-reset" onPress={onReset}>Reset</Button>
        ) : null}
      </div>
    </SettingsSection>
  );
}

/** Profile → Location: the sites in previews that received your location on this device, with Stop. */
export function PersonalLocationSettings() {
  return (
    <SettingsFormLayout data-testid="personal-location-settings">
      <DesktopLocationPermission />
      <SettingsSection title="Sites that can see your location" description={LOCATION_SITES_DESCRIPTION}>
        <LocationSitesList />
      </SettingsSection>
    </SettingsFormLayout>
  );
}
