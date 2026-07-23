import { CredentialsSettingsCard } from "./CredentialsSettingsCard";
import { SettingsShell } from "./SettingsShell";

export function AiPanel() {
  return (
    <SettingsShell testId="ai-panel" title="AI & Providers" hideTitle>
      <CredentialsSettingsCard />
    </SettingsShell>
  );
}
