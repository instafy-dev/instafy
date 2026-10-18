import { useProjects } from "../../../projects/useProjects";
import { ProjectSecretsCard } from "./ProjectSecretsCard";
import { SettingsShell } from "./SettingsShell";

export function SecretsPanel() {
  const { activeProjectId } = useProjects();

  return (
    <SettingsShell testId="secrets-panel" title="Secrets" hideTitle width="comfortable">
      <ProjectSecretsCard projectId={activeProjectId ?? null} />
    </SettingsShell>
  );
}
