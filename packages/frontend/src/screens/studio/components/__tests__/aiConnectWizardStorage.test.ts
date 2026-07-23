// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultAiConnectWizardState,
  readAiConnectWizardState,
  writeAiConnectWizardState,
} from "../aiConnectWizardStorage";

const STORAGE_KEY = "test.ai-connect-wizard";

describe("aiConnectWizardStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists the personal-only first-run origin across reloads", () => {
    writeAiConnectWizardState(STORAGE_KEY, {
      ...defaultAiConnectWizardState(),
      open: true,
      mode: "personal_only",
      step: "openai-auth",
      provider: "openai",
      updatedAt: Date.now(),
    });

    expect(readAiConnectWizardState(STORAGE_KEY)).toMatchObject({
      open: true,
      mode: "personal_only",
      step: "openai-auth",
      provider: "openai",
    });
  });

  it("keeps old version-1 records compatible by using the default mode", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        open: true,
        provider: null,
        step: "provider",
        deviceAuthSession: null,
        deviceAuthError: null,
        updatedAt: Date.now(),
      }),
    );

    expect(readAiConnectWizardState(STORAGE_KEY)?.mode).toBe("default");
  });
});
