import * as capabilities from "@instafy/sdk/capabilities";
import * as builtInAgents from "../../assistants/localBuiltInAssistantCatalog";
import { controllerClient } from "./controllerClient";

export const clearControllerAccessTokenOverride = controllerClient.core.clearAccessTokenOverride;
export const resolveControllerAccessToken = controllerClient.core.resolveAccessToken;
export const resolveControllerRequestContext = controllerClient.core.resolveRequestContext;
export const readControllerError = controllerClient.core.readError;
export const CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT =
  controllerClient.core.runtimeIdleTtlSecondsDefault;
export const CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_MIN =
  controllerClient.core.runtimeIdleTtlSecondsMin;
export const CONTROLLER_AUTH_ERROR_EVENT = controllerClient.core.authErrorEvent;

export const instafySdk = Object.freeze({
  controller: controllerClient,
  agents: builtInAgents,
  capabilities,
});

export type InstafySdk = typeof instafySdk;

export * from "./controllerClient";
export {
  mapLocalWorkspacePresenceFromPayload,
  mapOriginSummaryFromPayload,
  mapOriginSummaryToLocalWorkspacePresence,
  mapTunnelGrantFromPayload,
} from "../../services/runtimeControllerService";
export type * from "../../services/runtimeControllerService";
export type * from "../../services/runtimeController/browserSession";
export type * from "../../services/runtimeController/browserApproval";
export type { ControllerAuthErrorDetail } from "../../services/runtimeController/core";
export {
  controllerBaseUrl,
  runtimeControllerEnabled,
} from "../../services/runtimeController/core";
export type { ControllerRequestContext } from "../../services/runtimeController/core";
export * from "@instafy/sdk/capabilities";
export * from "@instafy/sdk/controller-client";
export * from "../../assistants/localBuiltInAssistantCatalog";
