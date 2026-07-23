import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState, writeWorkspaceFile } from "../utils/harness.js";
import { disableAssistantIfPossible } from "../utils/runtimeAi.js";

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => {
    const chatScroller = document.querySelector('[data-testid="chat-message-scroll"]') as HTMLElement | null;
    const viewportWidth = window.innerWidth;
    const overflowingElements = Array.from(document.querySelectorAll("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const htmlElement = element as HTMLElement;
        return {
          className: htmlElement.className?.toString() ?? "",
          right: Math.ceil(rect.right),
          scrollWidth: htmlElement.scrollWidth,
          clientWidth: htmlElement.clientWidth,
          tagName: htmlElement.tagName,
          testId: htmlElement.getAttribute("data-testid"),
          text: (htmlElement.textContent ?? "").trim().slice(0, 96),
        };
      })
      .filter((entry) => entry.right > viewportWidth + 1 || entry.scrollWidth > entry.clientWidth + 1)
      .slice(0, 8);

    return {
      bodyDelta: document.body.scrollWidth - document.body.clientWidth,
      chatScrollerDelta: chatScroller ? chatScroller.scrollWidth - chatScroller.clientWidth : 0,
      documentDelta: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overflowingElements,
    };
  });

  expect(metrics, JSON.stringify(metrics, null, 2)).toMatchObject({
    bodyDelta: 0,
    chatScrollerDelta: 0,
    documentDelta: 0,
  });
}

test.describe("Chat file links", () => {
  test.describe.configure({ timeout: 180_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-file-links:cleanup" }).catch(() => {});
  });

  test("clicking a file reference opens the file in the editor", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for chat file links test.");
    }

    const targetPath = "INSTAFY.md";
    await writeWorkspaceFile(page, targetPath, "hello", { projectId });

    await page.getByTestId("sidebar-nav-chat").click();
    await disableAssistantIfPossible(page);

    await page.getByTestId("chat-input").fill(`Learn review complete; [Instafy.md] already reflects the workspace rules.`);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("chat-send-button").click();

    const fileLink = page
      .getByTestId("chat-bubble-user")
      .last()
      .getByTestId("chat-message-file-reference-inline")
      .filter({ hasText: "Instafy.md" })
      .first();
    await expect(fileLink).toBeVisible();
    await fileLink.click();

    await expect(page.getByRole("heading", { name: targetPath })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-input")).toHaveCount(0);
  });

  test("long workspace file references do not create mobile horizontal overflow", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for chat file overflow test.");
    }
    await disableAssistantIfPossible(page);

    const longPath = "repos/instafy-dev-demo/firmware/esp32/rust/src/runtime_telemetry.rs";
    const longPathWithLine = "repos/instafy-dev-demo/firmware/esp32/rust/src/esp_idf_backend.rs:42";
    const veryLongFileName =
      "generated_controller_snapshot_with_a_very_long_descriptive_filename_that_should_not_widen_chat.rs";
    const veryLongFilePath = `repos/instafy-dev-demo/firmware/esp32/rust/src/${veryLongFileName}`;
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("chat-input").fill(`Inspect ${longPath}, ${longPathWithLine}, and ${veryLongFilePath}.`);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("chat-send-button").click();

    const latestUserBubble = page.getByTestId("chat-bubble-user").last();
    await expect(latestUserBubble).toContainText("runtime_telemetry.rs");
    await expect(latestUserBubble).toContainText("esp_idf_backend.rs:42");
    await expect(latestUserBubble).toContainText(veryLongFileName);
    await expect(latestUserBubble.getByTestId("chat-message-file-reference-inline").first()).toHaveAttribute(
      "title",
      `firmware/esp32/rust/src/runtime_telemetry.rs - Imported repo: instafy-dev-demo. Workspace path: ${longPath}`,
    );
    await expect(latestUserBubble.getByTestId("chat-message-file-reference-inline").filter({ hasText: veryLongFileName })).toHaveAttribute(
      "title",
      `firmware/esp32/rust/src/${veryLongFileName} - Imported repo: instafy-dev-demo. Workspace path: ${veryLongFilePath}`,
    );

    await expectNoHorizontalOverflow(page);
  });
});
