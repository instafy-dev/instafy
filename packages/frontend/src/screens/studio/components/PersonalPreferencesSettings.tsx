import { Checkbox } from "../../../components/Checkbox";
import { Text } from "../../../components/Text";
import { SettingsFormLayout } from "../../../components/SettingsFormLayout";
import { SettingsSection } from "./SettingsSection";

interface PersonalPreferencesSettingsProps {
  gitAutoSyncAfterApply: boolean;
  onGitAutoSyncChange: (enabled: boolean) => void;
}

export function PersonalPreferencesSettings({ gitAutoSyncAfterApply, onGitAutoSyncChange }: PersonalPreferencesSettingsProps) {
  return (
    <SettingsFormLayout data-testid="personal-preferences-settings">
      <SettingsSection title="Preferences" description="Choose how Instafy handles assistant file changes.">
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
    </SettingsFormLayout>
  );
}
