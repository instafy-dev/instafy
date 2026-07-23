import { ProviderSurfaceSandboxFallback } from "./ProviderSurfaceSandboxFallback";
import { ProviderSurfaceSandboxHeader } from "./ProviderSurfaceSandboxHeader";
import { resolveProviderSandboxPanel } from "./providerSandboxPanelRegistry";
import { useProviderSandboxSurfaceInfo } from "./providerSandboxSdk";

export function ProviderSurfaceSandboxShell() {
  const { providerId, surfaceId } = useProviderSandboxSurfaceInfo();
  const ProviderSandboxPanel = resolveProviderSandboxPanel(providerId, surfaceId);

  return (
    <>
      <ProviderSurfaceSandboxHeader />
      {ProviderSandboxPanel ? <ProviderSandboxPanel /> : <ProviderSurfaceSandboxFallback />}
    </>
  );
}
