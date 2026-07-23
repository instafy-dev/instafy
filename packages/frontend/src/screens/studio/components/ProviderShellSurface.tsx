import {
  resolveProviderHostSurfacePolicy,
  type ProviderHostSurfaceEntry,
} from "../../../providers/providerHostSurfaces";
import type { SurfaceHostActionBinding } from "./ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "./ProviderHostSurfaceControls";
import type { SurfaceHostSectionBinding } from "./ProviderHostSurfaceCard";
import { ProviderHostSurfaceCard } from "./ProviderHostSurfaceCard";
import { ProviderHostSurfaceSandboxContainer } from "./ProviderHostSurfaceSandboxContainer";

type ProviderShellSurfaceProps = {
  entry: ProviderHostSurfaceEntry | null | undefined;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  hostSectionBindings?: Record<string, SurfaceHostSectionBinding>;
  presentation?: "default" | "embedded";
};

export function ProviderShellSurface({
  entry,
  hostActionBindings,
  hostControlBindings,
  hostSectionBindings,
  presentation = "default",
}: ProviderShellSurfaceProps) {
  if (!entry) {
    return null;
  }

  const surfacePolicy = resolveProviderHostSurfacePolicy(entry);
  if (surfacePolicy.renderMode === "sandboxed") {
    return (
      <ProviderHostSurfaceSandboxContainer
        entry={entry}
        hostActionBindings={hostActionBindings}
        hostControlBindings={hostControlBindings}
        hostSectionBindings={hostSectionBindings}
      />
    );
  }

  return (
    <ProviderHostSurfaceCard
      entry={entry}
      hostActionBindings={hostActionBindings}
      hostControlBindings={hostControlBindings}
      hostSectionBindings={hostSectionBindings}
      presentation={presentation}
    />
  );
}
