import {
  resolveEmbeddedProviderSandboxMessage,
  type EmbeddedProviderSandboxMessageTransition,
  type EmbeddedProviderSandboxState,
} from "./providerSandboxEmbeddedMessages";
import {
  createProviderSandboxSnapshot,
  type ProviderSandboxSnapshot,
} from "./providerSandboxSnapshot";

// Internal embedded-runtime model: one reducer-owned state object plus
// snapshot derivation for the sandbox page/runtime boundary.
export type EmbeddedProviderSandboxRuntimeState = EmbeddedProviderSandboxState;

export function createEmbeddedProviderSandboxRuntimeState(): EmbeddedProviderSandboxRuntimeState {
  return {
    hostState: null,
    pendingInvalidatedResourceIds: [],
  };
}

export function createEmbeddedProviderSandboxRuntimeSnapshot(
  state: EmbeddedProviderSandboxRuntimeState,
  input: {
    fallbackProviderId?: string | null;
    fallbackSurfaceId?: string | null;
  },
): ProviderSandboxSnapshot {
  return createProviderSandboxSnapshot({
    hostState: state.hostState,
    fallbackProviderId: input.fallbackProviderId,
    fallbackSurfaceId: input.fallbackSurfaceId,
    pendingInvalidatedResourceIds: state.pendingInvalidatedResourceIds,
  });
}

export function resolveEmbeddedProviderSandboxRuntimeMessage(
  state: EmbeddedProviderSandboxRuntimeState,
  event: MessageEvent,
): EmbeddedProviderSandboxMessageTransition {
  return resolveEmbeddedProviderSandboxMessage(state, event);
}
