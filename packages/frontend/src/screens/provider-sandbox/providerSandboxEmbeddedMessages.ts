import {
  mergeSandboxHostResourceDeltaIntoState,
  parseProviderSandboxHostState,
  parseSandboxHostResourceDeltaPayload,
  parseSandboxInvalidatedResourceIds,
} from "./providerSandboxHostState";
import type { ProviderSandboxHostStatePayload } from "../../utils/providerSandboxBridge";

// Pure embedded-side reducer input/output layer.
// It translates bridge messages into next runtime state plus explicit effects.
export type EmbeddedProviderSandboxState = {
  hostState: ProviderSandboxHostStatePayload | null;
  pendingInvalidatedResourceIds: string[];
};

export type EmbeddedProviderSandboxRuntimeEffect =
  | { type: "request_host_state" }
  | { type: "apply_theme"; theme: "light" | "dark" };

export type EmbeddedProviderSandboxMessageTransition = {
  handled: boolean;
  nextState: EmbeddedProviderSandboxState;
  effects: EmbeddedProviderSandboxRuntimeEffect[];
};

function readMessageData(event: MessageEvent) {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null;
}

export function resolveEmbeddedProviderSandboxMessage(
  currentState: EmbeddedProviderSandboxState,
  event: MessageEvent,
): EmbeddedProviderSandboxMessageTransition {
  const data = readMessageData(event);
  if (!data) {
    return {
      handled: false,
      nextState: currentState,
      effects: [],
    };
  }

  if (data.type === "instafy:providerSandboxHostState") {
    const nextHostState = parseProviderSandboxHostState(data.payload);
    if (!nextHostState) {
      return {
        handled: true,
        nextState: currentState,
        effects: [],
      };
    }
    return {
      handled: true,
      nextState: {
        hostState: nextHostState,
        pendingInvalidatedResourceIds: [],
      },
      effects: [{ type: "apply_theme", theme: nextHostState.resolvedTheme }],
    };
  }

  if (data.type === "instafy:providerSandboxHostResourceDelta") {
    const { resources: changedResources, removedResourceIds, stateToken } =
      parseSandboxHostResourceDeltaPayload(data.payload);
    if (changedResources.length === 0 && removedResourceIds.length === 0) {
      return {
        handled: true,
        nextState: currentState,
        effects: [],
      };
    }
    if (!currentState.hostState) {
      return {
        handled: true,
        nextState: currentState,
        effects: [{ type: "request_host_state" }],
      };
    }

    const affectedResourceIds = new Set([
      ...changedResources.map((resource) => resource.id),
      ...removedResourceIds,
    ]);
    const nextHostState: ProviderSandboxHostStatePayload = mergeSandboxHostResourceDeltaIntoState({
      currentState: currentState.hostState,
      changedResources,
      removedResourceIds,
      stateToken,
    });

    return {
      handled: true,
      nextState: {
        hostState: nextHostState,
        pendingInvalidatedResourceIds: currentState.pendingInvalidatedResourceIds.filter(
          (resourceId) => !affectedResourceIds.has(resourceId),
        ),
      },
      effects: [],
    };
  }

  if (data.type === "instafy:providerSandboxHostResourcesInvalidated") {
    const resourceIds = parseSandboxInvalidatedResourceIds(data.payload);
    if (resourceIds.length === 0) {
      return {
        handled: true,
        nextState: currentState,
        effects: [],
      };
    }
    return {
      handled: true,
      nextState: {
        hostState: currentState.hostState,
        pendingInvalidatedResourceIds: Array.from(
          new Set([...currentState.pendingInvalidatedResourceIds, ...resourceIds]),
        ),
      },
      effects: [{ type: "request_host_state" }],
    };
  }

  return {
    handled: false,
    nextState: currentState,
    effects: [],
  };
}
