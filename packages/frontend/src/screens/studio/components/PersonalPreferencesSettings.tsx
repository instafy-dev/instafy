import { Checkbox } from "../../../components/Checkbox";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { Text } from "../../../components/Text";
import { useTheme, type ThemeMode } from "../../../theme/ThemeProvider";
import { SettingsSection } from "./SettingsSection";
import { SettingsSurface } from "./SettingsSurface";

interface PersonalPreferencesSettingsProps {
  gitAutoSyncAfterApply: boolean;
  onGitAutoSyncChange: (enabled: boolean) => void;
}

export function PersonalPreferencesSettings({ gitAutoSyncAfterApply, onGitAutoSyncChange }: PersonalPreferencesSettingsProps) {
  const { themeMode, setThemeMode } = useTheme();
  return (
    <SettingsSurface className="space-y-6" data-testid="personal-preferences-settings">
      <SettingsSection title="Appearance" description="Choose how Instafy looks on this device.">
        <div role="group" aria-label="Theme" className="max-w-sm">
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
      </SettingsSection>
      <SettingsSection title="Assistant file changes">
        <Checkbox
          isSelected={gitAutoSyncAfterApply}
          onChange={onGitAutoSyncChange}
          label="Auto-save assistant file changes"
          description="When enabled, assistant edits are synced to the canonical workspace after each run."
          data-testid="profile-preference-git-auto-sync"
        />
        <Text variant="caption" tone="muted" className="pl-6">
          If auto-save fails, the run stays complete and you can finish from Changes.
        </Text>
      </SettingsSection>
    </SettingsSurface>
  );
}
