import { Text } from "../../../components/Text";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { SettingsFormLayout } from "../../../components/SettingsFormLayout";
import { useTheme, type ThemeMode } from "../../../theme/ThemeProvider";
import { SettingsSection } from "./SettingsSection";

export function PersonalAppearanceSettings() {
  const { themeMode, setThemeMode } = useTheme();
  return (
    <SettingsFormLayout data-testid="personal-appearance-settings">
      <SettingsSection title="Appearance" description="Choose how Instafy looks on this device. Changes apply immediately.">
        <div className="max-w-sm">
          <Text id="appearance-theme-label" variant="bodyStrong" tone="primary" className="mb-2">Theme</Text>
          <SegmentedControl<ThemeMode>
            aria-labelledby="appearance-theme-label"
            value={themeMode}
            onChange={setThemeMode}
            size="sm"
            options={[
              { value: "system", label: "System", testId: "profile-preference-theme-system" },
              { value: "light", label: "Light", testId: "profile-preference-theme-light" },
              { value: "dark", label: "Dark", testId: "profile-preference-theme-dark" },
            ]}
          />
          <Text variant="body" tone="muted" className="mt-2">System follows your device’s light or dark appearance.</Text>
        </div>
      </SettingsSection>
    </SettingsFormLayout>
  );
}
