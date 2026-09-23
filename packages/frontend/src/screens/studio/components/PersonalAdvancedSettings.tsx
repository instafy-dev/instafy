import { Button } from "../../../components/Button";
import { ControlChevron } from "../../../components/ControlChevron";
import { SettingsFormLayout } from "../../../components/SettingsFormLayout";
import { useWorkspaceControls } from "../workspaceControls";
import { SettingsSection } from "./SettingsSection";

export function PersonalAdvancedSettings() {
  const { onOpenDiagnostics } = useWorkspaceControls();
  return (
    <SettingsFormLayout data-testid="personal-advanced-settings">
      <SettingsSection title="Advanced" description="Tools for troubleshooting Instafy on this device.">
        <details className="group/developer" data-testid="settings-developer-tools">
          <summary className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm font-medium text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:text-slate-100">
            Developer tools
            <span className="ml-auto transition-transform group-open/developer:rotate-180 motion-reduce:transition-none"><ControlChevron /></span>
          </summary>
          <div className="space-y-3 px-2 pb-2 pt-3">
            <p className="text-sm text-slate-500 dark:text-slate-400">Inspect app and runtime logs, build information, connections, and layout overrides.</p>
            <Button variant="outline" isDisabled={!onOpenDiagnostics} onPress={onOpenDiagnostics} data-testid="settings-open-diagnostics">Open diagnostics</Button>
          </div>
        </details>
      </SettingsSection>
    </SettingsFormLayout>
  );
}
