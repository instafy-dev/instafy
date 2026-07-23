export type ProjectContentCapability =
  | "project_content_read"
  | "project_content_write";

export interface ProviderProjectAccessDescriptor {
  required: boolean;
  purpose: string;
  requestedCapabilities: ProjectContentCapability[];
  preferredPrefix?: string | null;
}

export type ProviderProjectBindingStatus =
  | "unbound"
  | "bound_read_only"
  | "bound_read_write";

export interface ProviderInitializeProjectContext {
  projectId?: string | null;
  rootUri?: string | null;
  grantedCapabilities?: ProjectContentCapability[];
  grantedPrefix?: string | null;
}

export interface ProviderProjectBinding extends ProviderInitializeProjectContext {
  providerId: string;
  purpose?: string | null;
  status: ProviderProjectBindingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProjectBindingStore {
  version: 1;
  bindings: Record<string, ProviderProjectBinding>;
}
