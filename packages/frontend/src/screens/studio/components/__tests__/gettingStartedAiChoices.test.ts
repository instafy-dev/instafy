import { describe, expect, it } from "vitest";
import {
  canRestorePersistedAiOnboarding,
  resolveGettingStartedAiChoices,
} from "../gettingStartedAiChoices";

const managedAi = {
  enabled: true,
  available: true,
  label: "Instafy AI",
  dailyPromptLimit: 20,
  remainingPrompts: 7,
};

const managedAiOffer = {
  label: "Instafy AI",
  dailyPromptLimit: 20,
  remainingPrompts: 7,
};

function resolve(
  overrides: Partial<Parameters<typeof resolveGettingStartedAiChoices>[0]> = {},
) {
  return resolveGettingStartedAiChoices({
    runtimeControllerEnabled: true,
    hasUser: true,
    requirementsResolved: true,
    hasDefaultCredential: false,
    credentialInventoryStatus: "missing",
    managedAi,
    ...overrides,
  });
}

describe("resolveGettingStartedAiChoices", () => {
  it("offers the included and personal routes after both checks resolve", () => {
    expect(resolve()).toEqual({
      managedAiOffer,
      selectedAi: null,
      canChangeAiChoice: false,
      personalAiConnectionState: "missing",
      viewState: "choice",
    });
  });

  it.each(["unknown", "loading"] as const)(
    "keeps both AI and workspace actions inert while the personal credential inventory is %s",
    (credentialInventoryStatus) => {
      expect(resolve({ credentialInventoryStatus })).toMatchObject({
        selectedAi: null,
        personalAiConnectionState: null,
        viewState: "resolving",
      });
    },
  );

  it("does not trust a persisted managed choice until cold credential checks resolve", () => {
    expect(
      resolve({
        credentialInventoryStatus: "loading",
        managedAiSelected: true,
      }),
    ).toMatchObject({
      selectedAi: null,
      canChangeAiChoice: false,
      personalAiConnectionState: null,
      viewState: "resolving",
    });
  });

  it("uses ready inventory as positive connected evidence over a stale managed selection", () => {
    expect(
      resolve({ credentialInventoryStatus: "ready", managedAiSelected: true }),
    ).toEqual({
      managedAiOffer: null,
      selectedAi: "connected",
      canChangeAiChoice: false,
      personalAiConnectionState: null,
      viewState: "workspace",
    });
  });

  it("keeps positive managed selection evidence separate from the offer visibility", () => {
    expect(resolve({ managedAiSelected: true })).toEqual({
      managedAiOffer,
      selectedAi: "managed",
      canChangeAiChoice: true,
      personalAiConnectionState: null,
      viewState: "workspace",
    });
  });

  it("reopens the personal route if the selected included lane is exhausted", () => {
    expect(
      resolve({
        managedAiSelected: true,
        managedAi: { ...managedAi, available: false, remainingPrompts: 0 },
      }),
    ).toEqual({
      managedAiOffer: {
        label: "Instafy AI",
        dailyPromptLimit: 20,
        remainingPrompts: 0,
      },
      selectedAi: null,
      canChangeAiChoice: false,
      personalAiConnectionState: "missing",
      viewState: "choice",
    });
  });

  it("offers a choose-default action when a connection exists but is incomplete", () => {
    expect(resolve({ credentialInventoryStatus: "needs_default" })).toEqual({
      managedAiOffer,
      selectedAi: null,
      canChangeAiChoice: false,
      personalAiConnectionState: "needs_default",
      viewState: "choice",
    });
  });

  it("keeps the explicit choices available when inventory loading fails without a known default", () => {
    expect(resolve({ credentialInventoryStatus: "error" })).toEqual({
      managedAiOffer,
      selectedAi: null,
      canChangeAiChoice: false,
      personalAiConnectionState: "missing",
      viewState: "choice",
    });
  });

  it("trusts a confirmed default over a stale persisted managed selection", () => {
    expect(
      resolve({
        credentialInventoryStatus: "error",
        hasDefaultCredential: true,
        managedAiSelected: true,
      }),
    ).toEqual({
      managedAiOffer: null,
      selectedAi: "connected",
      canChangeAiChoice: false,
      personalAiConnectionState: null,
      viewState: "workspace",
    });
  });

  it("keeps an exhausted included allowance visible so the UI can explain it", () => {
    expect(
      resolve({ managedAi: { ...managedAi, available: false, remainingPrompts: 0 } }),
    ).toEqual({
      managedAiOffer: {
        label: "Instafy AI",
        dailyPromptLimit: 20,
        remainingPrompts: 0,
      },
      selectedAi: null,
      canChangeAiChoice: false,
      personalAiConnectionState: "missing",
      viewState: "choice",
    });
  });

  it("shows only the personal connection route when included AI is unavailable for another reason", () => {
    expect(resolve({ managedAi: { ...managedAi, available: false } })).toEqual({
      managedAiOffer: null,
      selectedAi: null,
      canChangeAiChoice: false,
      personalAiConnectionState: "missing",
      viewState: "choice",
    });
  });

  it("waits for live requirements and a signed-in controller session", () => {
    expect(resolve({ requirementsResolved: false }).viewState).toBe("resolving");
    expect(resolve({ hasUser: false }).viewState).toBe("resolving");
    expect(resolve({ runtimeControllerEnabled: false }).viewState).toBe("workspace");
  });

  it("does not infer a selected lane without live evidence in the active controller session", () => {
    expect(
      resolve({
        requirementsResolved: false,
        managedAiSelected: true,
      }),
    ).toMatchObject({
      managedAiOffer: null,
      selectedAi: null,
      canChangeAiChoice: false,
      viewState: "resolving",
    });
    expect(
      resolve({
        runtimeControllerEnabled: false,
        hasDefaultCredential: true,
        credentialInventoryStatus: "ready",
      }),
    ).toMatchObject({
      managedAiOffer: null,
      selectedAi: null,
      canChangeAiChoice: false,
      viewState: "workspace",
    });
  });

  it("does not restore a stale wizard when requirements already confirm a default", () => {
    expect(
      canRestorePersistedAiOnboarding({
        runtimeControllerEnabled: true,
        hasUser: true,
        requirementsResolved: true,
        requirementsHasDefaultCredential: true,
        hydratedDefaultCredentialId: null,
      }),
    ).toBe(false);
    expect(
      canRestorePersistedAiOnboarding({
        runtimeControllerEnabled: true,
        hasUser: true,
        requirementsResolved: true,
        requirementsHasDefaultCredential: false,
        hydratedDefaultCredentialId: null,
      }),
    ).toBe(true);
  });

  it("does not retain a managed selection after a personal connection disappears", () => {
    const connected = resolve({
      credentialInventoryStatus: "ready",
      managedAiSelected: false,
    });
    expect(connected.selectedAi).toBe("connected");
    expect(connected.viewState).toBe("workspace");

    const disconnected = resolve({
      credentialInventoryStatus: "missing",
      managedAiSelected: false,
    });
    expect(disconnected.selectedAi).toBeNull();
    expect(disconnected.personalAiConnectionState).toBe("missing");
    expect(disconnected.viewState).toBe("choice");
  });
});
