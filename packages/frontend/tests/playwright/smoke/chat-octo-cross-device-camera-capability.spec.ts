import { expect, test, type Page } from "@playwright/test";
import {
  gotoStudio,
  prepareStudio,
  resetRuntimeUserState,
} from "../utils/harness.js";

const DESKTOP_CAMERA_DEVICE_ID = "desktop-webcam-playwright";
const DESKTOP_CAMERA_LABEL = "Desktop webcam";

async function submitChatInput(page: Page, value: string) {
  await page.getByTestId("chat-input").fill(value);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("chat-send-button").click();
}

async function openExtensions(page: Page) {
  const dismissIntro = page.getByRole("button", { name: "Not now" }).first();
  if (await dismissIntro.isVisible().catch(() => false)) {
    await dismissIntro.click().catch(() => {});
  }

  const directEntry = page.getByTestId("sidebar-more-item-extensions").first();
  if (await directEntry.isVisible().catch(() => false)) {
    await directEntry.click({ force: true });
  } else {
    await page.getByTestId("sidebar-nav-more").click({ force: true });
    await page.getByTestId("sidebar-more-item-extensions").first().click({ force: true });
  }
  await expect(page.getByTestId("extensions-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("extensions-provider-access-section")).toBeVisible({
    timeout: 15_000,
  });
}

async function returnToChat(page: Page) {
  const chatInput = page.getByTestId("chat-input");
  if (await chatInput.isVisible().catch(() => false)) {
    return;
  }
  const conversationTab = page
    .getByTestId("workspace-tabs")
    .getByRole("button", { name: /Conversation/i })
    .first();
  if (await conversationTab.isVisible().catch(() => false)) {
    await conversationTab.click();
    if (await chatInput.isVisible().catch(() => false)) {
      return;
    }
  }
  const homeButton = page.getByTestId("sidebar-home-button").first();
  if (await homeButton.isVisible().catch(() => false)) {
    await homeButton.click();
  } else {
    await page.getByRole("button", { name: "Open home" }).first().click();
  }
  if (await conversationTab.isVisible().catch(() => false)) {
    await conversationTab.click();
  }
  await expect(chatInput).toBeVisible({ timeout: 30_000 });
}

async function installDesktopCameraRuntime(page: Page) {
  await page.addInitScript(
    ({ deviceId, deviceLabel }) => {
      const DEVICE_ID_STORAGE_KEY = "instafy.camera.desktopWebcam.deviceId";

      try {
        window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
      } catch {
        // Ignore storage failures in test setup.
      }

      Object.defineProperty(window, "instafyDesktop", {
        value: {
          version: "playwright-test",
        },
        configurable: true,
      });

      const originalPermissions = navigator.permissions;
      if (originalPermissions && typeof originalPermissions.query === "function") {
        const originalQuery = originalPermissions.query.bind(originalPermissions);
        Object.defineProperty(navigator, "permissions", {
          configurable: true,
          value: {
            ...originalPermissions,
            query: async (descriptor: PermissionDescriptor) => {
              if (descriptor?.name === "camera") {
                return {
                  state: "granted",
                  onchange: null,
                  addEventListener() {},
                  removeEventListener() {},
                  dispatchEvent() {
                    return true;
                  },
                };
              }
              return originalQuery(descriptor);
            },
          },
        });
      }

      const originalMediaDevices = navigator.mediaDevices;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          ...originalMediaDevices,
          async getUserMedia() {
            const canvas = document.createElement("canvas");
            canvas.width = 960;
            canvas.height = 720;
            const context = canvas.getContext("2d");
            if (!context) {
              throw new Error("Unable to create a fake desktop webcam canvas.");
            }

            const renderFrame = () => {
              context.fillStyle = "#dbeafe";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.fillStyle = "#0f172a";
              context.font = "bold 40px sans-serif";
              context.fillText(deviceLabel, 48, 96);
              context.font = "28px sans-serif";
              context.fillText("Instafy Playwright webcam", 48, 148);
              context.fillText(new Date().toISOString(), 48, 200);
              context.fillStyle = "#1d4ed8";
              context.fillRect(48, 250, canvas.width - 96, canvas.height - 320);
            };

            renderFrame();
            const intervalId = window.setInterval(renderFrame, 250);
            const stream = canvas.captureStream(4);
            const track = stream.getVideoTracks()[0];
            if (track) {
              try {
                Object.defineProperty(track, "label", {
                  configurable: true,
                  get: () => deviceLabel,
                });
              } catch {
                // Ignore readonly track labels.
              }
              const originalStop = track.stop.bind(track);
              track.stop = () => {
                window.clearInterval(intervalId);
                originalStop();
              };
            }
            return stream;
          },
        },
      });
    },
    {
      deviceId: DESKTOP_CAMERA_DEVICE_ID,
      deviceLabel: DESKTOP_CAMERA_LABEL,
    },
  );
}

function findCameraRow(page: Page, text?: string) {
  const locator = page.locator('[data-testid^="project-provider-row-camera"]');
  return text ? locator.filter({ hasText: text }).first() : locator.first();
}

function findAttachedCameraRow(page: Page) {
  return page
    .locator('[data-testid^="project-provider-row-camera"]')
    .filter({
      hasNot: page.locator('[data-testid^="project-provider-attach-camera"]'),
    })
    .first();
}

test.describe("Chat @octo cross-device camera capability", () => {
  test.setTimeout(240_000);

  let providerPage: Page | null = null;

  test.afterEach(async ({ page }) => {
    await providerPage?.close().catch(() => {});
    await resetRuntimeUserState(page, {
      source: "chat-octo-cross-device-camera-capability:cleanup",
    }).catch(() => {});
  });

  test("routes a camera capture from a desktop webcam provider to another client in the same project", async ({
    page,
  }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();

    providerPage = await page.context().newPage();
    await installDesktopCameraRuntime(providerPage);
    await gotoStudio(providerPage, { projectId });
    await prepareStudio(providerPage, { reuseExisting: true, waitForHostedRuntime: false });

    await openExtensions(providerPage);
    await expect(providerPage.getByText("Extension discovery issue")).toHaveCount(0);
    const providerRow = findCameraRow(providerPage);
    await expect(providerRow).toBeVisible({ timeout: 20_000 });
    const providerAttachButton = providerRow
      .locator('[data-testid^="project-provider-attach-camera"]')
      .first();
    await providerAttachButton.click();
    await expect(
      providerRow.locator('[data-testid^="project-provider-attach-camera"]'),
    ).toHaveCount(0, {
      timeout: 15_000,
    });

    await providerPage.reload({ waitUntil: "domcontentloaded" });
    await openExtensions(providerPage);
    await expect(findAttachedCameraRow(providerPage)).toBeVisible({
      timeout: 20_000,
    });

    await openExtensions(page);
    await expect(page.getByText("Extension discovery issue")).toHaveCount(0);
    const consumerRow = findAttachedCameraRow(page);
    await expect(consumerRow).toBeVisible({ timeout: 20_000 });
    await consumerRow.locator('[data-testid^="project-provider-details-toggle-camera"]').first().click();
    const remoteDevicePanel = page.locator('[data-testid^="project-provider-camera-remote-device-camera"]').first();
    await expect(remoteDevicePanel).toContainText(DESKTOP_CAMERA_LABEL, { timeout: 20_000 });
    await expect(remoteDevicePanel).toContainText("Online", { timeout: 20_000 });

    await returnToChat(page);
    await submitChatInput(page, "@octo take a photo");

    const assistantBubble = page
      .locator('[data-testid="chat-bubble-assistant"][data-message-type="local_capability_result"]')
      .last();
    await expect(assistantBubble).toContainText("captured a rear photo", { timeout: 30_000 });
    await expect(assistantBubble).toContainText(`on ${DESKTOP_CAMERA_LABEL}`, {
      timeout: 30_000,
    });
    await expect(assistantBubble).not.toContainText(/is capturing|Waiting on/i);
    await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, { timeout: 2_000 });
  });
});
