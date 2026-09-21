import { useCallback, useState } from "react";
import { CredentialsSettingsCard, type AiSettingsSection } from "./CredentialsSettingsCard";
import { SettingsShell, type SettingsCategory } from "./SettingsShell";

const categories: SettingsCategory[] = [
  { id: "connections", label: "Connections", testId: "ai-category-connections" },
  { id: "agents", label: "Agents", testId: "ai-category-agents" },
];

export function AiPanel() {
  const [section, setSection] = useState<AiSettingsSection>("connections");
  const showAgents = useCallback(() => setSection("agents"), []);
  return (
    <SettingsShell
      testId="ai-panel"
      title="Your AI"
      categories={categories}
      activeCategoryId={section}
      onCategoryChange={(next) => {
        if (next === "connections" || next === "agents") setSection(next);
      }}
      navLabel="Sections"
      navTestId="ai-category-nav"
    >
      <CredentialsSettingsCard section={section} onOpenAgentProfile={showAgents} />
    </SettingsShell>
  );
}
