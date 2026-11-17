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
      updatedAt: Date.now(),
    });

    expect(readAiConnectWizardState(STORAGE_KEY)).toMatchObject({
      open: true,
      mode: "personal_only",
    });
  });

  it("reads a record without a mode as the default mode", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        open: true,
        updatedAt: Date.now(),
      }),
    );

    expect(readAiConnectWizardState(STORAGE_KEY)?.mode).toBe("default");
  });
});
