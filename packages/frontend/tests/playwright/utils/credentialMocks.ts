import { type Page } from "@playwright/test";

export const DEFAULT_MOCK_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
export const DEFAULT_MOCK_OCTO_AGENT_ID = "33333333-3333-4333-8333-333333333333";

type MockDefaultAiCredentialOptions = {
  provider?: string;
  credentials?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  requiresUserCredentials?: boolean;
};

export async function mockDefaultAiCredential(
  page: Page,
  options?: MockDefaultAiCredentialOptions,
): Promise<void> {
  const now = new Date().toISOString();
  const provider = (options?.provider ?? "openai").trim() || "openai";
  const credentials =
    options?.credentials ??
    [
      {
        id: DEFAULT_MOCK_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: provider === "openai" ? "Primary" : provider,
        isDefault: true,
        metadata: { provider },
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  const agents =
    options?.agents ??
    [
      {
        id: DEFAULT_MOCK_OCTO_AGENT_ID,
        handle: "octo",
        displayName: "Octo",
        description: null,
        avatarSeed: "octo",
        provider: "assistant",
        model: null,
        credentialId: DEFAULT_MOCK_CREDENTIAL_ID,
        runtimeId: null,
        createdAt: now,
        updatedAt: now,
      },
    ];

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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentials),
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
        requiresUserCredentials: options?.requiresUserCredentials ?? true,
        proxyBackend: "codex",
        error: null,
      }),
    });
  });

  await page.route("**/me/agents", async (route, request) => {
    if (request.method().toUpperCase() !== "GET") {
      await route.continue();
      return;
    }
    const url = new URL(request.url());
    if (!url.pathname.endsWith("/me/agents")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(agents),
    });
  });
}
