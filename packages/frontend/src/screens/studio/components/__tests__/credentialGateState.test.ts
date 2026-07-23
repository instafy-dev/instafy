import { describe, expect, it } from "vitest";

import { resolveAiCredentialGateState } from "../credentialGateState";

describe("resolveAiCredentialGateState", () => {
  it("does not gate an empty/non-AI input while requirements load", () => {
    expect(
      resolveAiCredentialGateState({
        runtimeControllerEnabled: true,
        inputRequiresAi: false,
        credentialsReady: false,
        currentUserId: "user-1",
        credentialRequirements: {
          requiresUserCredentials: null,
          error: null,
        },
        credentialGateStatus: {
          status: "loading",
          error: null,
        },
      }),
    ).toEqual({ state: null, detail: null });
  });

  it("returns unavailable when credential loading fails because the controller cannot be reached", () => {
    expect(
      resolveAiCredentialGateState({
        runtimeControllerEnabled: true,
        inputRequiresAi: true,
        credentialsReady: false,
        currentUserId: "user-1",
        credentialRequirements: {
          requiresUserCredentials: true,
          error: null,
        },
        credentialGateStatus: {
          status: "error",
          error: "Unable to load credentials: Failed to fetch",
        },
      }),
    ).toEqual({
      state: "unavailable",
      detail: "Retry after the local stack is ready. Your AI credentials may still be fine.",
    });
  });

  it("returns missing for signed-out users before treating failures as controller outages", () => {
    expect(
      resolveAiCredentialGateState({
        runtimeControllerEnabled: true,
        inputRequiresAi: true,
        credentialsReady: false,
        currentUserId: null,
        credentialRequirements: {
          requiresUserCredentials: null,
          error: "Unable to load credential requirements: Failed to fetch",
        },
        credentialGateStatus: {
          status: "unknown",
          error: null,
        },
      }),
    ).toEqual({
      state: "missing",
      detail: null,
    });
  });

  it("returns a generic AI setup error for non-transport credential failures", () => {
    expect(
      resolveAiCredentialGateState({
        runtimeControllerEnabled: true,
        inputRequiresAi: true,
        credentialsReady: false,
        currentUserId: "user-1",
        credentialRequirements: {
          requiresUserCredentials: true,
          error: null,
        },
        credentialGateStatus: {
          status: "error",
          error: "Missing controller session token.",
        },
      }),
    ).toEqual({
      state: "error",
      detail: "Missing controller session token.",
    });
  });

  it("returns unavailable when an AI connection check times out", () => {
    expect(
      resolveAiCredentialGateState({
        runtimeControllerEnabled: true,
        inputRequiresAi: true,
        credentialsReady: false,
        currentUserId: "user-1",
        credentialRequirements: {
          requiresUserCredentials: null,
          error: null,
        },
        credentialGateStatus: {
          status: "error",
          error: "AI connection check timed out. Retry after the local stack is ready.",
        },
      }),
    ).toEqual({
      state: "unavailable",
      detail: "Retry after the local stack is ready. Your AI credentials may still be fine.",
    });
  });
});
