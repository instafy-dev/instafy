import { Buffer } from "node:buffer";
import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test.describe("Chat image upload (multiple)", () => {
  test("attaches multiple images in the composer and allows removing one", async ({ page }) => {
    // This spec only validates client-side image attachment UI (no assistant call),
    // so don't block on starting a hosted runtime (can exceed the default 30s test timeout).
    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("chat-image-upload-input").setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
      { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
    ]);

    await expect(page.getByTestId("chat-image-upload-preview")).toBeVisible();
    await expect(page.getByTestId("chat-image-upload-preview-item-0")).toBeVisible();
    await expect(page.getByTestId("chat-image-upload-preview-item-1")).toBeVisible();

    await page.getByTestId("chat-image-upload-remove").first().click();
    await expect(page.getByTestId("chat-image-upload-preview-item-0")).toBeVisible();
    await expect(page.getByTestId("chat-image-upload-preview-item-1")).toHaveCount(0);
  });
});
