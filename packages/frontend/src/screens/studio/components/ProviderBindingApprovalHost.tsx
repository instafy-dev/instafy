import { useEffect, useRef, useState } from "react";
import type { ProviderProjectBinding } from "@instafy/sdk/provider-project-binding";
import { useProject } from "../../../projects/useProject";
import { readProjectProviderBindingStore } from "../../../services/runtimeController/providerBindings";
import { useStatus } from "../../../status/useStatus";
import { ProviderBindingApprovalModal } from "./ProviderBindingApprovalModal";
import {
  PROVIDER_BINDING_REQUEST_EVENT,
  dispatchProviderBindingResult,
  type ProviderBindingRequestDetail,
} from "./providerBindingEvents";

type PendingProviderBindingRequest = ProviderBindingRequestDetail & {
  existingBinding?: ProviderProjectBinding | null;
};

export function ProviderBindingApprovalHost() {
  const { activeProjectId } = useProject();
  const { showStatus } = useStatus();
  const [pendingRequest, setPendingRequest] = useState<PendingProviderBindingRequest | null>(null);
  const handledRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleRequest = (event: Event) => {
      const custom = event as CustomEvent<ProviderBindingRequestDetail>;
      const detail = custom.detail;
      if (!detail || typeof detail.providerId !== "string" || !detail.providerId.trim()) {
        return;
      }
      const requestedProjectId =
        typeof detail.projectId === "string" && detail.projectId.trim().length > 0
          ? detail.projectId.trim()
          : null;
      if (requestedProjectId && activeProjectId && requestedProjectId !== activeProjectId) {
        const message = "Switch to the requested project before approving provider access.";
        showStatus(message, "warning", 3500);
        dispatchProviderBindingResult({
          providerId: detail.providerId,
          projectId: requestedProjectId,
          approved: false,
          error: message,
        });
        return;
      }
      const resolvedProjectId = requestedProjectId ?? activeProjectId ?? null;
      handledRef.current = false;
      void (async () => {
        let existingBinding: ProviderProjectBinding | null = null;
        if (resolvedProjectId != null) {
          try {
            existingBinding =
              (await readProjectProviderBindingStore({ projectId: resolvedProjectId })).bindings[
                detail.providerId.trim()
              ] ?? null;
          } catch {
            existingBinding = null;
          }
        }
        setPendingRequest({
          ...detail,
          projectId: resolvedProjectId,
          existingBinding,
        });
      })();
    };

    window.addEventListener(PROVIDER_BINDING_REQUEST_EVENT, handleRequest as EventListener);
    return () => {
      window.removeEventListener(PROVIDER_BINDING_REQUEST_EVENT, handleRequest as EventListener);
    };
  }, [activeProjectId, showStatus]);

  if (!pendingRequest) {
    return null;
  }

  const targetProjectId =
    typeof pendingRequest.projectId === "string" && pendingRequest.projectId.trim().length > 0
      ? pendingRequest.projectId.trim()
      : activeProjectId;

  const handleClose = () => {
    if (!handledRef.current) {
      dispatchProviderBindingResult({
        providerId: pendingRequest.providerId,
        projectId: targetProjectId,
        approved: false,
      });
    }
    setPendingRequest(null);
    handledRef.current = false;
  };

  const handleSaved = (binding: ProviderProjectBinding) => {
    handledRef.current = true;
    dispatchProviderBindingResult({
      providerId: binding.providerId,
      projectId: binding.projectId ?? targetProjectId,
      approved: true,
      binding,
    });
  };

  return (
    <ProviderBindingApprovalModal
      isOpen={Boolean(pendingRequest)}
      projectId={targetProjectId ?? null}
      defaults={{
        providerId: pendingRequest.providerId,
        purpose: pendingRequest.projectAccess.purpose,
        preferredPrefix: pendingRequest.projectAccess.preferredPrefix ?? "",
        capabilities: pendingRequest.projectAccess.requestedCapabilities,
        existingBinding: pendingRequest.existingBinding ?? null,
        providerIdLocked: true,
        title: `Allow ${pendingRequest.providerId}`,
        description: pendingRequest.projectAccess.purpose,
        saveLabel: "Allow access",
      }}
      onClose={handleClose}
      onSaved={handleSaved}
    />
  );
}
