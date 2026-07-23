export type ProviderUiSurfaceSandboxCapability =
  | "resize"
  | "open_external"
  | "host_actions"
  | "host_controls"
  | "host_sections"
  | "host_resources"
  | "host_resource_deltas";

export type ProviderUiSurfaceSandboxCapabilitySource =
  | ProviderUiSurfaceSandboxCapability[]
  | Pick<ProviderUiSurfaceSandboxContainer, "capabilities">
  | Pick<ProviderUiSurfaceSandboxHostState, "grantedCapabilities">;

export type ProviderUiSurfaceSandboxCapabilityProfile = {
  capabilities: ProviderUiSurfaceSandboxCapability[];
  canResize: boolean;
  canOpenExternal: boolean;
  canInvokeHostActions: boolean;
  canUpdateHostControls: boolean;
  canReadHostSections: boolean;
  canReadHostResources: boolean;
  canReadHostData: boolean;
  canMutateHost: boolean;
  supportsHostResourceDeltas: boolean;
};

export const PROVIDER_UI_SURFACE_SANDBOX_CAPABILITIES: readonly ProviderUiSurfaceSandboxCapability[];

export type ProviderUiSurfaceSandboxResourceBinding = {
  hostBindingId: string;
};

export type ProviderUiSurfaceSandboxResource = {
  id: string;
  title?: string;
  description?: string;
  binding: ProviderUiSurfaceSandboxResourceBinding;
};

export type ProviderUiSurfaceSandboxContainer = {
  kind: "iframe";
  src: string;
  title?: string;
  allow?: string;
  capabilities?: ProviderUiSurfaceSandboxCapability[];
  resources?: ProviderUiSurfaceSandboxResource[];
};

export type ProviderUiSurfaceSandboxResolvedTheme = "light" | "dark";

export type ProviderUiSurfaceSandboxHostAction = {
  id: string;
  label: string;
  description?: string;
  variant?: "primary" | "outline" | "ghost";
  disabled?: boolean;
};

export type ProviderUiSurfaceSandboxHostControl = {
  id: string;
  kind: "readonly" | "toggle" | "select";
  label: string;
  description?: string;
  value?: string | boolean;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  options?: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
};

export type ProviderUiSurfaceSandboxHostSection = {
  id: string;
  title?: string;
  description?: string;
  facts?: Array<{ label: string; value: string }>;
  items?: string[];
};

export type ProviderUiSurfaceSandboxHostResource = {
  id: string;
  title?: string;
  description?: string;
  facts?: Array<{ label: string; value: string }>;
  items?: string[];
};

export type ProviderUiSurfaceSandboxHostResourceDeltaPayload = {
  resources?: ProviderUiSurfaceSandboxHostResource[];
  removedResourceIds?: string[];
  stateToken?: string;
};

export type ProviderUiSurfaceSandboxHostResourceInvalidationPayload = {
  resourceIds: string[];
  stateToken?: string;
};

export type ProviderUiSurfaceSandboxHostState = {
  version: 1;
  stateToken?: string;
  providerId: string;
  providerTitle: string;
  familyId: string;
  surfaceId: string;
  resolvedTheme: ProviderUiSurfaceSandboxResolvedTheme;
  grantedCapabilities: ProviderUiSurfaceSandboxCapability[];
  hostActions?: ProviderUiSurfaceSandboxHostAction[];
  hostControls?: ProviderUiSurfaceSandboxHostControl[];
  hostSections?: ProviderUiSurfaceSandboxHostSection[];
  hostResources?: ProviderUiSurfaceSandboxHostResource[];
};

export type ProviderUiSurfaceSandboxBridgeMessage =
  | {
      type: "instafy:providerSandboxReady";
    }
  | {
      type: "instafy:providerSandboxRequestHostState";
    }
  | {
      type: "instafy:providerSandboxHostResourcesInvalidated";
      payload: ProviderUiSurfaceSandboxHostResourceInvalidationPayload;
    }
  | {
      type: "instafy:providerSandboxHostResourceDelta";
      payload: ProviderUiSurfaceSandboxHostResourceDeltaPayload;
    }
  | {
      type: "instafy:providerSandboxResize";
      payload: {
        height: number;
      };
    }
  | {
      type: "instafy:providerSandboxOpenExternal";
      url: string;
    }
  | {
      type: "instafy:providerSandboxInvokeHostAction";
      payload: {
        actionId: string;
      };
    }
  | {
      type: "instafy:providerSandboxUpdateHostControl";
      payload: {
        controlId: string;
        value: string | boolean;
      };
    }
  | {
      type: "instafy:providerSandboxHostState";
      payload: ProviderUiSurfaceSandboxHostState;
    };

export function createProviderUiSurfaceSandboxContainer(
  input: Partial<ProviderUiSurfaceSandboxContainer> | null | undefined,
): ProviderUiSurfaceSandboxContainer | undefined;
export function isProviderUiSurfaceSandboxCapability(
  value: unknown,
): value is ProviderUiSurfaceSandboxCapability;
export function normalizeProviderUiSurfaceSandboxCapabilities(
  values: unknown,
): ProviderUiSurfaceSandboxCapability[] | undefined;
export function providerUiSurfaceSandboxHasCapability(
  input: ProviderUiSurfaceSandboxCapabilitySource | null | undefined,
  capability: ProviderUiSurfaceSandboxCapability,
): boolean;
export function createProviderUiSurfaceSandboxCapabilityProfile(
  input: ProviderUiSurfaceSandboxCapabilitySource | null | undefined,
): ProviderUiSurfaceSandboxCapabilityProfile;
export function createProviderUiSurfaceSandboxHostState(
  input: Partial<ProviderUiSurfaceSandboxHostState> | null | undefined,
): ProviderUiSurfaceSandboxHostState | undefined;
export function createProviderUiSurfaceSandboxHostResourceInvalidationPayload(
  input: Partial<ProviderUiSurfaceSandboxHostResourceInvalidationPayload> | null | undefined,
): ProviderUiSurfaceSandboxHostResourceInvalidationPayload | undefined;
export function createProviderUiSurfaceSandboxHostResourceDeltaPayload(
  input: Partial<ProviderUiSurfaceSandboxHostResourceDeltaPayload> | null | undefined,
): ProviderUiSurfaceSandboxHostResourceDeltaPayload | undefined;
export function createProviderUiSurfaceSandboxBridgeMessage(
  input: Partial<ProviderUiSurfaceSandboxBridgeMessage> | null | undefined,
): ProviderUiSurfaceSandboxBridgeMessage | undefined;
