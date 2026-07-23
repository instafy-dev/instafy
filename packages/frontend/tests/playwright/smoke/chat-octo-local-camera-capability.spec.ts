import { expect, test } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.describe("Chat @octo local camera capability", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-octo-local-camera-capability:cleanup" }).catch(() => {});
  });

  async function submitChatInput(page: import("@playwright/test").Page, value: string) {
    await page.getByTestId("chat-input").fill(value);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("chat-send-button").click();
  }

  async function openExtensions(page: import("@playwright/test").Page) {
    const directEntry = page.getByTestId("sidebar-more-item-extensions").first();
    if (await directEntry.isVisible().catch(() => false)) {
      await directEntry.click();
    } else {
      await page.getByTestId("sidebar-nav-more").click();
      await page.getByTestId("sidebar-more-item-extensions").first().click();
    }
    await expect(page.getByTestId("extensions-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("extensions-provider-access-section")).toBeVisible({
      timeout: 15_000,
    });
  }

  async function returnToChat(page: import("@playwright/test").Page) {
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

  async function attachCameraProviderToProject(page: import("@playwright/test").Page) {
    await openExtensions(page);
    const cameraRow = page.getByTestId("project-provider-row-camera");
    await expect(cameraRow).toBeVisible({ timeout: 15_000 });
    await expect(cameraRow).not.toContainText("backend:");
    await expect(page.getByTestId("project-provider-attach-camera")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("project-provider-attach-camera").click();
    await expect(page.getByTestId("project-provider-details-toggle-camera")).toBeVisible({
      timeout: 15_000,
    });
    await returnToChat(page);
  }

  async function mockCameraLocalProviderHost(
    page: import("@playwright/test").Page,
    handler: (options: {
      route: import("@playwright/test").Route;
      request: import("@playwright/test").Request;
      url: URL;
      body: Record<string, unknown> | null;
      corsHeaders: Record<string, string>;
    }) => Promise<boolean>,
  ) {
    await page.route("http://127.0.0.1:8797/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
      };

      if (request.method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: corsHeaders,
        });
        return;
      }

      if (request.method() === "GET" && url.pathname === "/providers") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({
            ok: true,
            providers: [
              {
                id: "camera",
                title: "Camera",
                description: "First-party camera observation provider",
                kind: "sensor",
                providerType: "phone_camera",
                rootUri: "instafy://camera",
                capabilityIds: ["camera_observation"],
                toolIds: ["instafy.camera.capture_photo", "instafy.camera.capture_photo_series"],
                resourceUris: [
                  "instafy://camera/status",
                  "instafy://camera/lenses",
                  "instafy://camera/latest-capture",
                ],
              },
            ],
          }),
        });
        return;
      }

      const body =
        request.method() === "POST" ? (request.postDataJSON() as Record<string, unknown>) : null;
      const handled = await handler({ route, request, url, body, corsHeaders });
      if (handled) {
        return;
      }

      await route.fulfill({
        status: request.method() === "POST" ? 404 : 405,
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: request.method() === "POST" ? "not_found" : "method_not_allowed",
        }),
      });
    });
  }

  async function mockCameraProjectAttachmentPolicy(
    page: import("@playwright/test").Page,
    projectId: string,
  ) {
    type MockIntegration = {
      id: string;
      projectId: string;
      provider: string;
      status: string;
      connectionType: string;
      credentialId: string | null;
      metadata: Record<string, unknown>;
      requiredScopes: string[];
      capabilities: string[];
      createdBy: string | null;
      createdAt: string;
      updatedAt: string;
    };

    let integration: MockIntegration | null = null;

    await page.route("**/projects/*/integrations", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const expectedPathSuffix = `/projects/${encodeURIComponent(projectId)}/integrations`;
      if (request.method() !== "GET" || !url.pathname.endsWith(expectedPathSuffix)) {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(integration ? [integration] : []),
      });
    });

    await page.route("**/projects/*/integrations/camera", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const expectedPathSuffix = `/projects/${encodeURIComponent(projectId)}/integrations/camera`;
      if (request.method() !== "PUT" || !url.pathname.endsWith(expectedPathSuffix)) {
        await route.fallback();
        return;
      }

      const body = request.postDataJSON() as Record<string, unknown>;
      const now = new Date().toISOString();
      integration = {
        id: integration?.id ?? `integration-${projectId}-camera`,
        projectId,
        provider: "camera",
        status: typeof body.status === "string" ? body.status : integration?.status ?? "attached",
        connectionType:
          typeof body.connectionType === "string"
            ? body.connectionType
            : integration?.connectionType ?? "local_provider",
        credentialId:
          typeof body.credentialId === "string" ? body.credentialId : integration?.credentialId ?? null,
        metadata:
          body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : integration?.metadata ?? {},
        requiredScopes: Array.isArray(body.requiredScopes)
          ? body.requiredScopes.filter((value): value is string => typeof value === "string")
          : integration?.requiredScopes ?? [],
        capabilities: Array.isArray(body.capabilities)
          ? body.capabilities.filter((value): value is string => typeof value === "string")
          : integration?.capabilities ?? [],
        createdBy: null,
        createdAt: integration?.createdAt ?? now,
        updatedAt: now,
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(integration),
      });
    });
  }

  test("requires project attachment before routing a photo request through the camera provider", async ({
    page,
  }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    await mockCameraProjectAttachmentPolicy(page, projectId);

    const toolCallBodies: Array<Record<string, unknown>> = [];
    const recordedConversationMessages: Array<Record<string, unknown>> = [];
    let sawControllerAssistantDispatch = false;

    await mockCameraLocalProviderHost(page, async ({ route, url, body, corsHeaders }) => {
      if (
        url.pathname === "/providers/camera/resources/read" &&
        body?.uri === "instafy://camera/status"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({
            ok: true,
            providerId: "camera",
            uri: "instafy://camera/status",
            value: {
              supported: true,
              platform: "local_provider_host",
              backend: "phone_camera",
              permission: "granted",
              permissionGranted: true,
              canCapture: true,
              availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
              selectedLens: "rear",
              lastCapture: null,
            },
          }),
        });
        return true;
      }

      if (
        url.pathname === "/providers/camera/tools/call" &&
        body &&
        typeof body === "object" &&
        body.name === "instafy.camera.capture_photo"
      ) {
        toolCallBodies.push(body);
        const toolArgs = body.arguments as Record<string, unknown> | undefined;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({
            ok: true,
            providerId: "camera",
            name: "instafy.camera.capture_photo",
            value: {
              supported: true,
              platform: "local_provider_host",
              backend: "phone_camera",
              permission: "granted",
              permissionGranted: true,
              canCapture: true,
              availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
              selectedLens: toolArgs?.lens ?? "rear",
              lastCapture: null,
              capture: {
                captureId: "capture-1",
                backend: "phone_camera",
                lens: toolArgs?.lens ?? "rear",
                capturedAt: new Date(0).toISOString(),
                filePath: "/tmp/capture-1.jpg",
              },
            },
          }),
        });
        return true;
      }

      return false;
    });

    page.on("request", (request) => {
      if (request.method() !== "POST") {
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return;
      }
      const pathname = url.pathname;
      if (/\/projects\/[^/]+\/conversations$/.test(pathname)) {
        sawControllerAssistantDispatch = true;
      }
      if (/\/conversations\/[^/]+\/messages$/.test(pathname)) {
        sawControllerAssistantDispatch = true;
      }
      if (/\/conversations\/[^/]+\/messages\/record$/.test(pathname)) {
        recordedConversationMessages.push((request.postDataJSON() as Record<string, unknown>) ?? {});
      }
    });

    const prompt = "@octo take a photo";
    await submitChatInput(page, prompt);

    await expect(page.getByText("Octo cannot use Camera in this project yet.")).toBeVisible({
      timeout: 15_000,
    });
    expect(toolCallBodies).toHaveLength(0);

    await attachCameraProviderToProject(page);
    await openExtensions(page);
    const cameraRow = page.getByTestId("project-provider-row-camera");
    await expect(cameraRow).toBeVisible({
      timeout: 15_000,
    });
    await expect(cameraRow).not.toContainText("backend:");
    await expect(page.getByTestId("project-provider-camera-native-camera-summary")).toHaveCount(0);
    await returnToChat(page);
    await submitChatInput(page, prompt);

    await expect
      .poll(() => toolCallBodies.length, {
        timeout: 15_000,
        message: "Expected @octo photo prompt to hit the camera provider",
      })
      .toBe(1);

    expect(toolCallBodies[0]).toEqual({
      name: "instafy.camera.capture_photo",
      arguments: {
        lens: "rear",
      },
    });

    await expect(page.getByText("Octo captured a rear photo from Camera.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('[data-testid="chat-bubble-assistant"][data-message-type="local_capability_result"]').last(),
    ).toContainText("Octo captured a rear photo from Camera.");
    await expect
      .poll(() => recordedConversationMessages.length, {
        timeout: 15_000,
        message: "Expected the provider-backed camera action to be mirrored into controller conversation history",
      })
      .toBe(4);

    expect(recordedConversationMessages[0]).toMatchObject({
      role: "user",
      content: prompt,
    });
    expect(recordedConversationMessages[1]).toMatchObject({
      role: "assistant",
      content: "Octo cannot use Camera in this project yet. Open Extensions and attach or enable it there before asking for that real-world action.",
    });
    expect(recordedConversationMessages[2]).toMatchObject({
      role: "user",
      content: prompt,
    });
    expect(recordedConversationMessages[3]).toMatchObject({
      role: "assistant",
      content: "Octo captured a rear photo from Camera.",
      metadata: {
        kind: "local_capability_result",
        localCapability: {
          id: "camera_observation",
          status: "completed",
        },
        cameraObservation: {
          lens: "rear",
          completedCount: 1,
          capture: {
            captureId: "capture-1",
          },
        },
        provider: {
          id: "camera",
          title: "Camera",
        },
      },
    });
    await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, { timeout: 2_000 });
    expect(sawControllerAssistantDispatch).toBeFalsy();
  });
});
