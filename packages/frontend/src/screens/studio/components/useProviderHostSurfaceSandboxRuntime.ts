import { useMemo, useRef, useState, type RefObject } from "react";
import {
  resolveProviderHostSurfacePolicy,
  resolveProviderHostSurfaceSandboxDescriptor,
  type ProviderHostSurfaceEntry,
  type ProviderHostSurfaceResolvedPolicy,
  type ProviderHostSurfaceSandboxDescriptor,
} from "../../../providers/providerHostSurfaces";
import {
  buildProviderSandboxFrameSrc,
} from "../../../utils/providerSandboxBridge";
import type { SurfaceHostActionBinding } from "./ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "./ProviderHostSurfaceControls";
import type { SurfaceHostSectionBinding } from "./ProviderHostSurfaceCard";
import {
  buildProviderHostSurfaceSandboxState,
  type ProviderSandboxHostResource,
} from "./providerHostSurfaceSandboxState";
import { useProviderHostSurfaceSandboxBridge } from "./useProviderHostSurfaceSandboxBridge";

export type UseProviderHostSurfaceSandboxRuntimeProps = {
  entry: ProviderHostSurfaceEntry;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  hostSectionBindings?: Record<string, SurfaceHostSectionBinding>;
};

export type UseProviderHostSurfaceSandboxRuntimeResult = {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  iframeHeight: number;
  iframeSrc: string;
  onIframeLoad: () => void;
  policy: ProviderHostSurfaceResolvedPolicy;
  sandbox: ProviderHostSurfaceSandboxDescriptor | null;
};

export function useProviderHostSurfaceSandboxRuntime({
  entry,
  hostActionBindings,
  hostControlBindings,
  hostSectionBindings,
}: UseProviderHostSurfaceSandboxRuntimeProps): UseProviderHostSurfaceSandboxRuntimeResult {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeLoadedRef = useRef(false);
  const lastHostPushSnapshotRef = useRef<string | null>(null);
  const lastHostResourceSnapshotRef = useRef<string | null>(null);
  const lastHostResourcesRef = useRef<ProviderSandboxHostResource[]>([]);
  const [iframeHeight, setIframeHeight] = useState(320);

  const sandbox = resolveProviderHostSurfaceSandboxDescriptor(entry);
  const policy = resolveProviderHostSurfacePolicy(entry);
  const resolvedTheme =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";

  const iframeSrc = useMemo(
    () =>
      buildProviderSandboxFrameSrc(sandbox?.src ?? "", {
        providerId: entry.provider.id,
        surfaceId: entry.surface.surface,
      }),
    [entry.provider.id, entry.surface.surface, sandbox?.src],
  );

  const projection = useMemo(
    () =>
      buildProviderHostSurfaceSandboxState({
        entry,
        sandbox,
        resolvedTheme,
        hostActionBindings,
        hostControlBindings,
        hostSectionBindings,
      }),
    [
      entry,
      hostActionBindings,
      hostControlBindings,
      hostSectionBindings,
      resolvedTheme,
      sandbox,
    ],
  );

  const { onIframeLoad } = useProviderHostSurfaceSandboxBridge({
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
  });

  return {
    iframeRef,
    iframeHeight,
    iframeSrc,
    onIframeLoad,
    policy,
    sandbox,
  };
}
