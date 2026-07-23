import type { AiCredentialsGateState } from "./AiCredentialsStatusBubble";
import {
  formatControllerUnavailableDetail,
  isLikelyControllerConnectionError,
} from "../../../runtime/controllerConnectionErrors";

export interface CredentialRequirementStateLike {
  requiresUserCredentials: boolean | null;
  error: string | null;
}

export interface CredentialGateStatusStateLike {
  status: "unknown" | "loading" | "ready" | "missing" | "needs_default" | "error";
  error: string | null;
}

interface ResolveAiCredentialGateInput {
  runtimeControllerEnabled: boolean;
  inputRequiresAi: boolean;
  credentialsReady: boolean;
  currentUserId: string | null;
  credentialRequirements: CredentialRequirementStateLike;
  credentialGateStatus: CredentialGateStatusStateLike;
}

interface ResolveAiCredentialGateResult {
  state: AiCredentialsGateState | null;
  detail: string | null;
}

export function resolveAiCredentialGateState({
  runtimeControllerEnabled,
  inputRequiresAi,
  credentialsReady,
  currentUserId,
  credentialRequirements,
  credentialGateStatus,
}: ResolveAiCredentialGateInput): ResolveAiCredentialGateResult {
  if (!runtimeControllerEnabled || !inputRequiresAi || credentialsReady) {
    return { state: null, detail: null };
  }

  if (!currentUserId) {
    return { state: "missing", detail: null };
  }

  const controllerUnavailableMessage =
    [credentialGateStatus.error, credentialRequirements.error].find(
      isLikelyControllerConnectionError,
    ) ?? null;
  if (controllerUnavailableMessage) {
    return {
      state: "unavailable",
      detail: formatControllerUnavailableDetail(controllerUnavailableMessage),
    };
  }

  if (credentialGateStatus.status === "error") {
    return {
      state: "error",
      detail: credentialGateStatus.error ?? "Unable to load credentials.",
    };
  }

  if (credentialRequirements.requiresUserCredentials === null) {
    return { state: "checking", detail: null };
  }

  if (
    credentialGateStatus.status === "loading" ||
    credentialGateStatus.status === "unknown"
  ) {
    return { state: "checking", detail: null };
  }

  if (credentialGateStatus.status === "needs_default") {
    return { state: "needs_default", detail: null };
  }

  if (credentialGateStatus.status === "missing") {
    return { state: "missing", detail: null };
  }

  return { state: "checking", detail: null };
}
