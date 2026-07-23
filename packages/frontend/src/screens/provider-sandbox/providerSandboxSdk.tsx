import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react";
import type {
  ProviderUiSurfaceSandboxHostAction,
  ProviderUiSurfaceSandboxHostControl,
  ProviderUiSurfaceSandboxHostResource,
  ProviderUiSurfaceSandboxHostSection,
} from "@instafy/provider-contract";
import {
  requestProviderSandboxHostState,
  requestProviderSandboxInvokeHostAction,
  requestProviderSandboxOpenExternal,
  requestProviderSandboxUpdateHostControl,
} from "../../utils/providerSandboxBridge";
import type { ProviderSandboxSnapshot } from "./providerSandboxSnapshot";

type ProviderSandboxClient = {
  snapshot: ProviderSandboxSnapshot;
  refreshHostState: () => void;
  invokeHostAction: (actionId: string) => boolean;
  updateHostControl: (controlId: string, value: string | boolean) => boolean;
  openExternal: (url: string, options?: { fallbackToWindow?: boolean }) => boolean;
};

export type ProviderSandboxHostData = {
  pendingInvalidatedResourceIds: string[];
  sections: ProviderUiSurfaceSandboxHostSection[];
  resources: ProviderUiSurfaceSandboxHostResource[];
  canReadHostData: boolean;
  canReadHostSections: boolean;
  canReadHostResources: boolean;
  supportsHostResourceDeltas: boolean;
  refreshHostState: () => void;
};

export type ProviderSandboxHostMutations = {
  actions: ProviderUiSurfaceSandboxHostAction[];
  controls: ProviderUiSurfaceSandboxHostControl[];
  canMutateHost: boolean;
  canInvokeHostActions: boolean;
  canUpdateHostControls: boolean;
  canOpenExternal: boolean;
  invokeHostAction: (actionId: string) => boolean;
  updateHostControl: (controlId: string, value: string | boolean) => boolean;
  openExternal: (url: string, options?: { fallbackToWindow?: boolean }) => boolean;
};

const ProviderSandboxClientContext = createContext<ProviderSandboxClient | null>(null);

export function ProviderSandboxSdkProvider({
  snapshot,
  children,
}: PropsWithChildren<{
  snapshot: ProviderSandboxSnapshot;
}>) {
  const client = useMemo<ProviderSandboxClient>(
    () => {
      return {
        snapshot,
        refreshHostState: () => {
          requestProviderSandboxHostState();
        },
        invokeHostAction: (actionId) => requestProviderSandboxInvokeHostAction(actionId),
        updateHostControl: (controlId, value) =>
          requestProviderSandboxUpdateHostControl(controlId, value),
        openExternal: (url, options) => {
          const didPost = requestProviderSandboxOpenExternal(url);
          if (!didPost && options?.fallbackToWindow !== false && typeof window !== "undefined") {
            window.open(url, "_blank", "noopener,noreferrer");
          }
          return didPost;
        },
      };
    },
    [snapshot],
  );

  return (
    <ProviderSandboxClientContext.Provider value={client}>
      {children}
    </ProviderSandboxClientContext.Provider>
  );
}

function useProviderSandboxClientContext() {
  const client = useContext(ProviderSandboxClientContext);
  if (!client) {
    throw new Error(
      "provider sandbox hooks must be used within ProviderSandboxSdkProvider",
    );
  }
  return client;
}

export function useProviderSandboxSurfaceInfo() {
  const sandbox = useProviderSandboxClientContext();
  return {
    providerId: sandbox.snapshot.providerId,
    providerTitle: sandbox.snapshot.providerTitle,
    familyId: sandbox.snapshot.familyId,
    surfaceId: sandbox.snapshot.surfaceId,
    resolvedTheme: sandbox.snapshot.resolvedTheme,
    stateToken: sandbox.snapshot.stateToken,
  };
}

export function useProviderSandboxCapabilityProfile() {
  const sandbox = useProviderSandboxClientContext();
  return sandbox.snapshot.capabilityProfile;
}

export function useProviderSandboxHostData(): ProviderSandboxHostData {
  const sandbox = useProviderSandboxClientContext();
  const { capabilityProfile, hostData, pendingInvalidatedResourceIds } = sandbox.snapshot;
  return {
    pendingInvalidatedResourceIds,
    sections: capabilityProfile.canReadHostSections ? hostData.sections : [],
    resources: capabilityProfile.canReadHostResources ? hostData.resources : [],
    canReadHostData: capabilityProfile.canReadHostData,
    canReadHostSections: capabilityProfile.canReadHostSections,
    canReadHostResources: capabilityProfile.canReadHostResources,
    supportsHostResourceDeltas: capabilityProfile.supportsHostResourceDeltas,
    refreshHostState: sandbox.refreshHostState,
  };
}

export function useProviderSandboxHostMutations(): ProviderSandboxHostMutations {
  const sandbox = useProviderSandboxClientContext();
  const { capabilityProfile, hostMutations } = sandbox.snapshot;
  return {
    actions: capabilityProfile.canInvokeHostActions ? hostMutations.actions : [],
    controls: capabilityProfile.canUpdateHostControls ? hostMutations.controls : [],
    canMutateHost: capabilityProfile.canMutateHost,
    canInvokeHostActions: capabilityProfile.canInvokeHostActions,
    canUpdateHostControls: capabilityProfile.canUpdateHostControls,
    canOpenExternal: capabilityProfile.canOpenExternal,
    invokeHostAction: sandbox.invokeHostAction,
    updateHostControl: sandbox.updateHostControl,
    openExternal: sandbox.openExternal,
  };
}
