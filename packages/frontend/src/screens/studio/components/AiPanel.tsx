import { CredentialsSettingsCard } from "./CredentialsSettingsCard";
import { SettingsShell } from "./SettingsShell";

export function AiPanel() {
  return (
    <SettingsShell testId="ai-panel" title="Your AI">
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">Your personal connections and agent profiles. Open Team to see people, agents and shared work.</p>
      <CredentialsSettingsCard />
    </SettingsShell>
  );
}
