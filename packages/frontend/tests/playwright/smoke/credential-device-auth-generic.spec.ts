import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";

const DEVICE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";

test.describe("Credential onboarding", () => {
  test.setTimeout(120_000);

  test("verifies ChatGPT device-auth credentials through generic test endpoint", async ({ page }) => {
    let credentialConnected = false;
    let deviceStartCalls = 0;
    let deviceStatusCalls = 0;
    let credentialTestCalls = 0;

    await page.route("**/me/credentials", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      if (!url.pathname.endsWith("/me/credentials")) {
        await route.continue();
        return;
      }

      if (!credentialConnected) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: CREDENTIAL_ID,
            kind: "codex_auth_json",
            label: "ChatGPT login",
            isDefault: true,
            metadata: {
              provider: "openai",
            },
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]),
      });
    });

    await page.route("**/me/credentials/requirements", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requiresUserCredentials: true,
          proxyBackend: "codex",
          error: null,
        }),
      });
    });

    await page.route("**/me/auth/device/**", async (route, request) => {
      const url = new URL(request.url());
      const method = request.method().toUpperCase();
      if (method === "POST" && url.pathname.endsWith("/me/auth/device/codex/start")) {
        deviceStartCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessionId: DEVICE_SESSION_ID,
            provider: "codex",
            verificationUrl: "https://chatgpt.com/device",
            userCode: "ABCD-EFGH",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            pollIntervalSeconds: 1,
          }),
        });
        return;
      }

      if (method === "GET" && url.pathname.endsWith(`/me/auth/device/${DEVICE_SESSION_ID}`)) {
        deviceStatusCalls += 1;
        credentialConnected = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessionId: DEVICE_SESSION_ID,
            provider: "codex",
            status: "completed",
            credentialId: CREDENTIAL_ID,
            error: null,
          }),
        });
        return;
      }

      if (method === "DELETE" && url.pathname.endsWith(`/me/auth/device/${DEVICE_SESSION_ID}`)) {
        await route.fulfill({ status: 204, body: "" });
        return;
      }

      await route.continue();
    });

    await page.route("**/me/credentials/*/test", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      credentialTestCalls += 1;
      const url = new URL(request.url());
      expect(url.pathname).toContain(`/${CREDENTIAL_ID}/test`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          provider: "openai",
          upstreamEndpoint: "https://chatgpt.com/backend-api/codex/responses",
          model: "gpt-5.5",
          output: "OK",
          elapsedMs: 25,
        }),
      });
    });

    await page.route("**/projects/*/runtime/status", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtimes: [
            {
              runtimeId: "33333333-3333-4333-8333-333333333333",
              status: "requesting",
              provider: "instafy-cloud",
              idleTtlSeconds: 300,
              createdAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              endpointUrl: null,
              taskRef: null,
              isLocal: false,
              isPreferred: false,
              health: "offline",
              displayName: "Instafy Cloud",
            },
          ],
          preferredRuntimeId: null,
        }),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });

    const gettingStarted = page.getByTestId("onboarding-getting-started");
    await expect(gettingStarted).toBeVisible({ timeout: 30_000 });
    await gettingStarted.getByTestId("onboarding-connect-own-ai").click();

    const credentialModal = page.getByTestId("credentials-connect-modal");
    await expect(credentialModal).toBeVisible({ timeout: 30_000 });
    await expect(credentialModal.getByText("Claude")).toHaveCount(0);

    const chatGptChoice = credentialModal.getByTestId("credentials-connect-choice-codex");
    await expect(chatGptChoice).toBeEnabled();
    await chatGptChoice.click();
    await expect(credentialModal.getByTestId("credentials-chatgpt-device-prerequisite")).toBeVisible();
    await credentialModal.getByTestId("credentials-connect-codex").click();

    await expect
      .poll(() => deviceStartCalls, {
        timeout: 30_000,
        message: "device auth should start for codex provider",
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() => deviceStatusCalls, {
        timeout: 30_000,
        message: "device auth status should be polled",
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() => credentialTestCalls, {
        timeout: 30_000,
        message: "connected credential should be verified through /test",
      })
      .toBeGreaterThan(0);
    await expect(credentialModal).toHaveCount(0);
    await expect(
      gettingStarted.getByText("Start with a tool you already use", { exact: true }),
    ).toBeVisible();
  });
});
