import type {
  ProviderProjectAccessDescriptor,
  ProviderProjectBinding,
} from "@instafy/sdk/provider-project-binding";

export const PROVIDER_BINDING_REQUEST_EVENT = "instafy:provider-binding-request";
export const PROVIDER_BINDING_RESULT_EVENT = "instafy:provider-binding-result";

export interface ProviderBindingRequestDetail {
  providerId: string;
  projectId?: string | null;
  projectAccess: ProviderProjectAccessDescriptor;
}

export interface ProviderBindingResultDetail {
  providerId: string;
  projectId?: string | null;
  approved: boolean;
  binding?: ProviderProjectBinding | null;
  error?: string | null;
}

export function dispatchProviderBindingRequest(detail: ProviderBindingRequestDetail) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ProviderBindingRequestDetail>(PROVIDER_BINDING_REQUEST_EVENT, {
      detail,
    }),
  );
}

export function dispatchProviderBindingResult(detail: ProviderBindingResultDetail) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ProviderBindingResultDetail>(PROVIDER_BINDING_RESULT_EVENT, {
      detail,
    }),
  );
}
