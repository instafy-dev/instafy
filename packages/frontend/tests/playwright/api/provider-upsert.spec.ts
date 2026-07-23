import { expect } from "@playwright/test";
import {
  privateRuntimeTest as test,
  registerPrivateRuntime,
} from "../utils/privateRuntimeHarness.js";

function serviceRoleKey(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SERVICE_ROLE_KEY?.trim() ||
    ""
  );
}

const RUN_PROVIDER_UPSERT = process.env.PROVIDER_UPSERT === "1";
const describeImpl =
  process.env.PROVIDER_UPSERT === "0" ? test.describe.skip : test.describe;

describeImpl("Provider upsert API", () => {
  test("creates a self-hosted provider and accepts owner runtime login", async ({
    request,
    privateRuntimeOwnerProject,
  }) => {
    const {
      accessToken,
      controllerUrl: controller,
      projectId,
    } = privateRuntimeOwnerProject;
    const serviceRole = serviceRoleKey();
    if (!serviceRole) {
      test.skip(true, "service role key is required");
    }

    const providerId = "playwright-self-hosted-api";
    const upsertResponse = await request.post(`${controller}/providers`, {
      headers: {
        authorization: `Bearer ${serviceRole}`,
        "content-type": "application/json",
      },
      data: {
        id: providerId,
        displayName: "Playwright Self Hosted",
        kind: "self-hosted",
      },
    });
    expect(upsertResponse.ok()).toBeTruthy();

    const providersResponse = await request.get(`${controller}/providers`, {
      headers: { authorization: `Bearer ${serviceRole}` },
    });
    expect(providersResponse.ok()).toBeTruthy();
    const providers = (await providersResponse.json()) as Array<Record<string, unknown>>;
    const created = providers.find((entry) => entry.id === providerId);
    expect(created).toBeTruthy();
    expect(created?.kind).toBe("self-hosted");

    const { runtimeId } = await registerPrivateRuntime(request, {
      controllerUrl: controller,
      accessToken,
      projectId,
      provider: providerId,
      displayName: "Playwright Self Hosted",
    });

    const statusResponse = await request.get(
      `${controller}/projects/${encodeURIComponent(projectId)}/runtime/status`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
    );
    expect(statusResponse.ok()).toBeTruthy();
    const statusPayload = (await statusResponse.json()) as {
      runtimes?: Array<{ runtimeId?: string; provider?: string }>;
    };
    const runtime = statusPayload.runtimes?.find(
      (entry) => entry.runtimeId === runtimeId,
    );
    expect(runtime?.provider?.toLowerCase()).toBe(providerId.toLowerCase());
  });
});
