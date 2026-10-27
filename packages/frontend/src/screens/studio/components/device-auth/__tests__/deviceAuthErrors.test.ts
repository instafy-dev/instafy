import { describe, expect, it } from "vitest";
import { isChatGptDeviceCodeLoginDisabledError } from "../deviceAuthErrors";

// The controller's CODEX_DEVICE_AUTH_FORBIDDEN_MESSAGE, verbatim.
const CONTROLLER_MESSAGE =
  "ChatGPT device-code login is not enabled. Enable it in ChatGPT Settings → Security, or ask your workspace admin to allow it in workspace permissions, then generate a new code.";

describe("isChatGptDeviceCodeLoginDisabledError", () => {
  it("recognizes the controller's device-code refusal", () => {
    expect(isChatGptDeviceCodeLoginDisabledError(CONTROLLER_MESSAGE)).toBe(true);
  });

  it("leaves every other device login failure alone", () => {
    for (const message of [
      "Device login failed.",
      "device auth failed with status 500",
      "Device login timed out. Generate a new code and try again.",
      "This device login session ended. Generate a new code and try again.",
      "",
      null,
      undefined,
    ]) {
      expect(isChatGptDeviceCodeLoginDisabledError(message)).toBe(false);
    }
  });
});
