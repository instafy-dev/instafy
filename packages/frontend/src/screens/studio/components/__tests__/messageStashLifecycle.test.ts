import { describe, expect, it } from "vitest";
import {
  resolveMessageStashRestoreBlock,
  shouldDeleteRestoredMessageStashAfterAction,
} from "../messageStashLifecycle";

describe("shouldDeleteRestoredMessageStashAfterAction", () => {
  it.each(["send", "queue", "steer"] as const)(
    "deletes a restored stash after a successful %s action",
    (action) => {
      expect(
        shouldDeleteRestoredMessageStashAfterAction({ submitted: true, action }),
      ).toBe(true);
    },
  );

  it("retains the stash when the action fails", () => {
    expect(
      shouldDeleteRestoredMessageStashAfterAction({ submitted: false, action: "queue" }),
    ).toBe(false);
  });
});

describe("resolveMessageStashRestoreBlock", () => {
  it("refuses to overwrite a non-empty composer draft", () => {
    expect(
      resolveMessageStashRestoreBlock({
        composerText: "Keep my current draft",
        attachmentCount: 0,
      }),
    ).toBe("composer_text");
  });

  it("allows an empty or whitespace-only composer", () => {
    expect(
      resolveMessageStashRestoreBlock({ composerText: "  \n", attachmentCount: 0 }),
    ).toBeNull();
  });

  it("keeps the image-attachment guard as the first blocker", () => {
    expect(
      resolveMessageStashRestoreBlock({
        composerText: "also has text",
        attachmentCount: 1,
      }),
    ).toBe("attachments");
  });
});
