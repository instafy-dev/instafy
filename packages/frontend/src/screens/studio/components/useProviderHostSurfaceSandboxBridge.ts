import { useCallback, useEffect, type MutableRefObject, type RefObject } from "react";
import type { ProviderHostSurfaceSandboxDescriptor } from "../../../providers/providerHostSurfaces";
import type { SurfaceHostActionBinding } from "./ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "./ProviderHostSurfaceControls";
import { handleProviderHostSurfaceSandboxMessage } from "./providerHostSurfaceSandboxMessages";
import type {
  ProviderHostSurfaceSandboxStateProjection,
  ProviderSandboxHostResource,
} from "./providerHostSurfaceSandboxState";
import {
  resolveProviderHostSurfaceSandboxHostStateSync,
  resolveProviderHostSurfaceSandboxResourceSync,
  runProviderHostSurfaceSandboxSyncAction,
} from "./providerHostSurfaceSandboxSync";

// Thin transport bridge between the host-side sandbox projection and the iframe.
// Sync policy and message interpretation live in dedicated helpers; this hook
// only wires them to the actual window/iframe lifecycle.
type UseProviderHostSurfaceSandboxBridgeProps = {
  sandbox: ProviderHostSurfaceSandboxDescriptor | null;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  iframeLoadedRef: MutableRefObject<boolean>;
  lastHostPushSnapshotRef: MutableRefObject<string | null>;
  lastHostResourceSnapshotRef: MutableRefObject<string | null>;
  lastHostResourcesRef: MutableRefObject<ProviderSandboxHostResource[]>;
  projection: ProviderHostSurfaceSandboxStateProjection;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  setIframeHeight: (height: number) => void;
};

export function useProviderHostSurfaceSandboxBridge({
  sandbox,
  iframeRef,
  iframeLoadedRef,
  lastHostPushSnapshotRef,
  lastHostResourceSnapshotRef,
  lastHostResourcesRef,
  projection,
  hostActionBindings,
  hostControlBindings,
  setIframeHeight,
}: UseProviderHostSurfaceSandboxBridgeProps) {
  useEffect(() => {
    if (!sandbox) {
      return;
    }
    const handleMessage = (event: MessageEvent) => {
      handleProviderHostSurfaceSandboxMessage({
        event,
        targetWindow: iframeRef.current?.contentWindow ?? null,
        projection,
        hostActionBindings,
        hostControlBindings,
        setIframeHeight,
        openExternal: (url) => {
          window.open(url, "_blank", "noopener,noreferrer");
        },
      });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    hostActionBindings,
    hostControlBindings,
    iframeRef,
    projection,
    sandbox,
    setIframeHeight,
  ]);

  useEffect(() => {
    if (!sandbox) {
      return;
    }
    const targetWindow = iframeRef.current?.contentWindow ?? null;
    const nextSync = resolveProviderHostSurfaceSandboxHostStateSync({
      iframeLoaded: iframeLoadedRef.current,
      targetWindow,
      previousSnapshot: lastHostPushSnapshotRef.current,
      projection,
    });
    lastHostPushSnapshotRef.current = nextSync.nextSnapshot;
    runProviderHostSurfaceSandboxSyncAction(targetWindow, nextSync.action);
  }, [
    iframeLoadedRef,
    iframeRef,
    lastHostPushSnapshotRef,
    projection,
    sandbox,
  ]);

  useEffect(() => {
    if (!sandbox) {
      return;
    }
    const targetWindow = iframeRef.current?.contentWindow ?? null;
    const nextSync = resolveProviderHostSurfaceSandboxResourceSync({
      iframeLoaded: iframeLoadedRef.current,
      targetWindow,
      previousSnapshot: lastHostResourceSnapshotRef.current,
      previousResources: lastHostResourcesRef.current,
      projection,
    });
    lastHostResourceSnapshotRef.current = nextSync.nextSnapshot;
    lastHostResourcesRef.current = nextSync.nextResources;
    runProviderHostSurfaceSandboxSyncAction(targetWindow, nextSync.action);
  }, [
    iframeLoadedRef,
    iframeRef,
    lastHostResourceSnapshotRef,
    lastHostResourcesRef,
    projection,
    sandbox,
  ]);

  return {
    onIframeLoad: useCallback(() => {
      iframeLoadedRef.current = true;
      lastHostPushSnapshotRef.current = projection.hostPushSnapshot;
      lastHostResourceSnapshotRef.current = projection.hostResourceSnapshot;
      lastHostResourcesRef.current = projection.hostData.resources;
      runProviderHostSurfaceSandboxSyncAction(iframeRef.current?.contentWindow ?? null, {
        kind: "post_host_state",
        hostState: projection.hostState,
      });
    }, [
      iframeLoadedRef,
      iframeRef,
      lastHostPushSnapshotRef,
      lastHostResourceSnapshotRef,
      lastHostResourcesRef,
      projection,
    ]),
  };
}
