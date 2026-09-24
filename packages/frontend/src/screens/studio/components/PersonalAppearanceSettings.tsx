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
          <p id="appearance-theme-label" className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">Theme</p>
          <div role="group" aria-labelledby="appearance-theme-label">
            <SegmentedControl<ThemeMode>
              value={themeMode}
              onChange={setThemeMode}
              size="sm"
              className="[&_button]:min-h-11"
              options={[
                { value: "system", label: "System", testId: "profile-preference-theme-system" },
                { value: "light", label: "Light", testId: "profile-preference-theme-light" },
                { value: "dark", label: "Dark", testId: "profile-preference-theme-dark" },
              ]}
            />
          </div>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">System follows your device’s light or dark appearance.</p>
        </div>
      </SettingsSection>
    </SettingsFormLayout>
  );
}
