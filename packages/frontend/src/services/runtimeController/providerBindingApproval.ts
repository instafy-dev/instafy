import type {
  ProjectContentCapability,
  ProviderProjectAccessDescriptor,
  ProviderProjectBinding,
  ProviderProjectBindingStore,
} from "@instafy/sdk/provider-project-binding";
import { readProjectProviderBindingStore } from "./providerBindings";
import {
  PROVIDER_BINDING_RESULT_EVENT,
  dispatchProviderBindingRequest,
  type ProviderBindingResultDetail,
} from "../../screens/studio/components/providerBindingEvents";

type EnsureProjectProviderCapabilityParams = {
  projectId: string;
  providerId: string;
  projectAccess: ProviderProjectAccessDescriptor;
  requiredCapability: ProjectContentCapability;
  timeoutMs?: number;
};

type RequestProjectProviderBindingParams = {
  projectId: string;
  providerId: string;
  projectAccess: ProviderProjectAccessDescriptor;
  timeoutMs?: number;
};

function matchesBindingResult(
  detail: ProviderBindingResultDetail | null | undefined,
  projectId: string,
  providerId: string,
): boolean {
  if (!detail) {
    return false;
  }
  const detailProviderId = typeof detail.providerId === "string" ? detail.providerId.trim() : "";
  const detailProjectId = typeof detail.projectId === "string" ? detail.projectId.trim() : "";
  return detailProviderId === providerId && detailProjectId === projectId;
}

export function providerBindingHasCapability(
  binding: ProviderProjectBinding | null | undefined,
  capability: ProjectContentCapability,
): boolean {
  return Boolean(binding?.grantedCapabilities?.includes(capability));
}

export async function requestProjectProviderBinding(
  params: RequestProjectProviderBindingParams,
): Promise<ProviderProjectBinding> {
  const projectId = params.projectId.trim();
  const providerId = params.providerId.trim();
  if (!projectId) {
    throw new Error("Select or create a project before approving provider access.");
  }
  if (!providerId) {
    throw new Error("Provider id is required.");
  }
  if (typeof window === "undefined") {
    throw new Error("Provider binding approval requires a browser context.");
  }

  const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 30_000;

  return new Promise<ProviderProjectBinding>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener(PROVIDER_BINDING_RESULT_EVENT, handleResult as EventListener);
      window.clearTimeout(timeoutId);
    };

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const handleResult = (event: Event) => {
      const custom = event as CustomEvent<ProviderBindingResultDetail>;
      const detail = custom.detail;
      if (!matchesBindingResult(detail, projectId, providerId)) {
        return;
      }
      finalize(() => {
        if (detail.approved && detail.binding) {
          resolve(detail.binding);
          return;
        }
        reject(
          new Error(
            detail.error?.trim() || `Provider access was not approved for ${providerId}.`,
          ),
        );
      });
    };

    const timeoutId = window.setTimeout(() => {
      finalize(() => {
        reject(new Error(`Timed out waiting for ${providerId} access approval.`));
      });
    }, timeoutMs);

    window.addEventListener(PROVIDER_BINDING_RESULT_EVENT, handleResult as EventListener);
    dispatchProviderBindingRequest({
      providerId,
      projectId,
      projectAccess: params.projectAccess,
    });
  });
}

export async function ensureProjectProviderCapability(
  params: EnsureProjectProviderCapabilityParams,
): Promise<ProviderProjectBinding> {
  const projectId = params.projectId.trim();
  const providerId = params.providerId.trim();
  if (!projectId) {
    throw new Error("Select or create a project before continuing.");
  }
  if (!providerId) {
    throw new Error("Provider id is required.");
  }

  let store: ProviderProjectBindingStore;
  try {
    store = await readProjectProviderBindingStore({ projectId });
  } catch {
    store = { version: 1, bindings: {} };
  }
  const existing = store.bindings[providerId] ?? null;
  if (providerBindingHasCapability(existing, params.requiredCapability)) {
    return existing;
  }

  const requestedCapabilities = new Set(params.projectAccess.requestedCapabilities);
  requestedCapabilities.add(params.requiredCapability);
  const binding = await requestProjectProviderBinding({
    projectId,
    providerId,
    timeoutMs: params.timeoutMs,
    projectAccess: {
      ...params.projectAccess,
      requestedCapabilities: Array.from(requestedCapabilities),
    },
  });

  if (!providerBindingHasCapability(binding, params.requiredCapability)) {
    throw new Error(
      `Provider ${providerId} is missing ${params.requiredCapability} access for this project.`,
    );
  }

  return binding;
}
