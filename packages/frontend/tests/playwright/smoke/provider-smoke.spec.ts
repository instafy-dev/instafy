import { test, expect } from "@playwright/test";

function resolveHealthUrl() {
  const endpoint =
    process.env.PROVIDER_HEALTH_URL ||
    process.env.DEV_PROVIDER_ENDPOINT ||
    process.env.PROVIDER_ENDPOINT ||
    "http://127.0.0.1:9090";
  if (!endpoint) return null;
  const base = endpoint.trim().replace(/\/+$/, "");
  return `${base}/healthz`;
}

function resolveAuthToken() {
  return (
    process.env.PROVIDER_AUTH_TOKEN ||
    process.env.DEV_PROVIDER_AUTH_TOKEN ||
    "dev-provider-token"
  );
}

const healthUrl = resolveHealthUrl();
const authToken = resolveAuthToken();

const describeImpl =
  process.env.PROVIDER_SMOKE === "0" || !healthUrl ? test.describe.skip : test.describe;

describeImpl("runtime provider smoke", () => {
  test.beforeAll(() => {
    test.skip(!healthUrl, "No provider endpoint configured");
  });

  test("provider healthz responds 200", async ({ request }) => {
    expect(healthUrl).toBeTruthy();
    const response = await request.get(healthUrl!, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    expect(response.ok()).toBeTruthy();
  });
});
