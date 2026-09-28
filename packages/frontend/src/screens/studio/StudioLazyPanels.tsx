import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Xmark } from "iconoir-react";
import { IconButton } from "../../components/Button";
import { DrawerHeader } from "../../components/DrawerHeader";
import { lazyStudioPanel } from "../../workspace/lazyStudioPanel";
import type { MobilePageHeader } from "./components/MobileStudioNavigationHeader";
import type { TeamPanelProps } from "./components/TeamPanel";

function PanelFallback({ children, title, onClose, tabs, headerPortalTarget, actionsPortalTarget, renderMobileHeader }: {
  children: ReactNode;
  title: string;
  onClose?: (() => void) | null;
  tabs?: ReactNode;
  headerPortalTarget?: HTMLElement | null;
  actionsPortalTarget?: HTMLElement | null;
  renderMobileHeader?: (header: MobilePageHeader) => ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {tabs}
      {renderMobileHeader ? renderMobileHeader({ title, actions: null }) : actionsPortalTarget ? null : onClose ? (
        <DrawerHeader portalTarget={headerPortalTarget} actionsPortalTarget={actionsPortalTarget} title={title} pageTitle={title === "Files" || title === "Changes"} frame="rail" actions={
          <IconButton variant="ghost" size="sm" radius="full" aria-label={`Close ${title.toLowerCase()}`} onPress={onClose}>
            <Xmark className="h-4 w-4" />
          </IconButton>
        } />
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export const FilesPanel = lazyStudioPanel(
  "Files",
  async () => ({ default: (await import("./components/FilesPanel")).FilesPanel }),
  (content, props) => {
    const explorer = props.showExplorer !== false && props.explorerPortalTarget
      ? createPortal(<PanelFallback title="Files" onClose={props.onRequestCloseExplorer}
        headerPortalTarget={props.explorerHeaderPortalTarget} renderMobileHeader={props.renderMobileExplorerHeader}>{content}</PanelFallback>, props.explorerPortalTarget)
      : null;
    if (props.renderMode === "portal") return explorer;
    return <><PanelFallback title="Files" tabs={props.tabsSlot} renderMobileHeader={explorer ? undefined : props.renderMobileExplorerHeader}>{content}</PanelFallback>{explorer}</>;
  },
);
export const GitDiffView = lazyStudioPanel(
  "Changes", async () => ({ default: (await import("./components/GitDiffView")).GitDiffView }),
);
export const GitReviewView = lazyStudioPanel(
  "Review", async () => ({ default: (await import("./components/GitReviewView")).GitReviewView }),
  (content, props) => <PanelFallback title="Review" onClose={props.onRequestClose}>{content}</PanelFallback>,
);
export const SourceControlDrawer = lazyStudioPanel(
  "Changes", async () => ({ default: (await import("./components/SourceControlDrawer")).SourceControlDrawer }),
  (content, props) => <PanelFallback title="Changes" headerPortalTarget={props.headerPortalTarget} actionsPortalTarget={props.actionsPortalTarget} onClose={props.onRequestClose}>{content}</PanelFallback>,
);
export const CreditsPanel = lazyStudioPanel(
  "Credits", async () => ({ default: (await import("./components/CreditsPanel")).CreditsPanel }),
);
export const ExtensionsPanel = lazyStudioPanel(
  "Extensions", async () => ({ default: (await import("./components/ExtensionsPanel")).ExtensionsPanel }),
);
export const SettingsPanel = lazyStudioPanel(
  "Settings", async () => ({ default: (await import("./components/SettingsPanel")).SettingsPanel }),
);
export const SkillsPanel = lazyStudioPanel(
  "Skills", async () => ({ default: (await import("./components/SkillsPanel")).SkillsPanel }),
);
export const SecretsPanel = lazyStudioPanel(
  "Secrets", async () => ({ default: (await import("./components/SecretsPanel")).SecretsPanel }),
);
export const AiPanel = lazyStudioPanel(
  "AI settings", async () => ({ default: (await import("./components/AiPanel")).AiPanel }),
);
export const AutomationsPanel = lazyStudioPanel(
  "Automations", async () => ({ default: (await import("./components/AutomationsPanel")).AutomationsPanel }),
);
export const TeamPanel = lazyStudioPanel<TeamPanelProps>(
  "Team", async () => ({ default: (await import("./components/TeamPanel")).TeamPanel }),
);
export const MachinesPanel = lazyStudioPanel(
  "Machines", async () => ({ default: (await import("./components/MachinesPanel")).MachinesPanel }),
);
