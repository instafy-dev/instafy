import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  prepareStudio,
  getControllerUrl,
  requireWorkspaceProjectId,
  createControllerOrgAndProject,
  attachControllerProjectToStudio,
} from "../utils/harness.js";
import { openCreditsPanel } from "../utils/sidebar.js";

function resolveServiceRoleKey(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SERVICE_ROLE_KEY?.trim() ||
    ""
  );
}

async function resolveUserId(page: import("@playwright/test").Page): Promise<string> {
  const userId = await page.evaluate(async () => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (!client?.auth?.getUser) {
      return null;
    }
    const result = await client.auth.getUser();
    return result?.data?.user?.id ?? null;
  });
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Unable to resolve authenticated user id for credits test.");
  }
  return userId.trim();
}

function markWorkspaceProject(projectId: string) {
  const workspaceRoot = process.env.WORKSPACE_ROOT?.trim();
  if (!workspaceRoot) {
    return;
  }
  try {
    const projectDir = path.join(workspaceRoot, projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "playwright-credits.txt"), "cleanup marker");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[credits-billing] Unable to create cleanup marker: ${message}`);
  }
}

test.describe.serial("Org credits", () => {
  test.setTimeout(180_000);

  const starterDailyCreditLimit = 200;

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test("supports amount and activity view toggles", async ({ page }) => {
    await openCreditsPanel(page);

    await expect(page.getByTestId("credits-balance-row")).toBeVisible();
    await expect(page.getByTestId("credits-amount-view-units")).toBeVisible();
    await expect(page.getByTestId("credits-amount-view-usd")).toBeVisible();
    await expect(page.getByTestId("credits-balance")).not.toContainText("$");
    await expect(page.getByTestId("credits-starter-budget")).toContainText("credits daily");

    await page.getByTestId("credits-amount-view-usd").click();
    await expect(page.getByTestId("credits-balance")).toContainText("$");
    await expect(page.getByTestId("credits-limit")).toContainText("$");
    await expect(page.getByTestId("credits-starter-budget")).toContainText("$");

    await expect(page.getByTestId("credits-activity-view-log")).toBeVisible();
    await expect(page.getByTestId("credits-activity-view-graph")).toBeVisible();
    await page.getByTestId("credits-activity-view-graph").click();
    await expect(page.getByTestId("credits-graph-range-7d")).toBeVisible();
    await expect(page.getByTestId("credits-graph-range-30d")).toBeVisible();
    await page.getByTestId("credits-graph-range-30d").click();
    await page.getByTestId("credits-graph-range-7d").click();

    // A fresh org (fresh CI database) has no ledger entries yet, in which
    // case the panel shows the no-activity message instead of the graph.
    const graph = page.getByTestId("credit-activity-graph");
    const emptyGraph = page.getByTestId("credit-activity-graph-empty");
    const noActivity = page.getByText("No balance activity recorded yet");
    await expect(graph.or(emptyGraph).or(noActivity)).toBeVisible();
    const graphSvg = page.getByTestId("credit-activity-graph-svg");
    await expect(graphSvg.or(emptyGraph).or(noActivity)).toBeVisible();

    await page.getByTestId("credits-activity-view-log").click();
    await expect(page.getByText("Recent balance activity")).toBeVisible();
  });

  test("fills daily buffer once per day", async ({ page }) => {
    const controllerUrl = getControllerUrl();
    const serviceRoleKey = resolveServiceRoleKey();
    if (!controllerUrl || !serviceRoleKey) {
      test.skip(true, "Controller URL and service role key are required.");
    }

    const userId = await resolveUserId(page);
    const orgSlug = `playwright-credits-${Date.now()}`;

    const { projectId, orgId, orgName } = await createControllerOrgAndProject(
      page.context().request,
      {
        controllerUrl,
        accessToken: serviceRoleKey,
        ownerUserId: userId,
        orgSlug,
        orgName: "Playwright Credits",
        projectType: "customer"
      }
    );

    await attachControllerProjectToStudio(page, {
      projectId,
      orgId,
      orgName,
      projectName: "Credits Test Project",
    });

    const activeProject = await requireWorkspaceProjectId(page).catch(() => null);
    expect(activeProject).toBe(projectId);

    markWorkspaceProject(projectId);

    const checkout = await page.context().request.post(`${controllerUrl}/billing/checkout`, {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json"
      },
      data: {
        projectId,
        action: "checkout",
        planId: "starter",
        processor: "dev",
        successUrl: "https://instafy.dev/studio",
        cancelUrl: "https://instafy.dev/studio"
      }
    });
    if (!checkout.ok()) {
      const body = await checkout.text().catch(() => "");
      throw new Error(
        `Checkout request failed (${checkout.status()} ${checkout.statusText()}): ${body}`
      );
    }

    await openCreditsPanel(page);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible();

    const creditLimitLocator = page.getByTestId("credits-limit");
    await expect
      .poll(async () => Number((await creditLimitLocator.textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(starterDailyCreditLimit);

    const creditBalanceLocator = page.getByTestId("credits-balance");
    await expect
      .poll(async () => Number((await creditBalanceLocator.textContent())?.trim() ?? NaN))
      .toBeGreaterThanOrEqual(0);

    const burnPhase1 = await page.context().request.post(`${controllerUrl}/credits`, {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json"
      },
      data: {
        requestId: `burn-${Date.now()}-a`,
        action: "burn",
        projectId,
        amount: 20,
        reason: "playwright_burn_phase1",
        metadata: { source: "playwright" }
      }
    });
    if (!burnPhase1.ok()) {
      const body = await burnPhase1.text().catch(() => "");
      throw new Error(
        `Burn phase 1 failed (${burnPhase1.status()} ${burnPhase1.statusText()}): ${body}`
      );
    }

    const statusAfterRefill = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );
    if (!statusAfterRefill.ok()) {
      const body = await statusAfterRefill.text().catch(() => "");
      throw new Error(
        `Credit status after refill failed (${statusAfterRefill.status()} ${statusAfterRefill.statusText()}): ${body}`
      );
    }
    const statusPayload = (await statusAfterRefill.json()) as {
      balance?: number;
      creditLimit?: number;
    };
    expect(statusPayload.balance).toBe(starterDailyCreditLimit);
    expect(statusPayload.creditLimit).toBe(starterDailyCreditLimit);

    const burnPhase2 = await page.context().request.post(`${controllerUrl}/credits`, {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json"
      },
      data: {
        requestId: `burn-${Date.now()}-b`,
        action: "burn",
        projectId,
        amount: starterDailyCreditLimit,
        reason: "playwright_burn_phase2",
        metadata: { source: "playwright" }
      }
    });
    if (!burnPhase2.ok()) {
      const body = await burnPhase2.text().catch(() => "");
      throw new Error(
        `Burn phase 2 failed (${burnPhase2.status()} ${burnPhase2.statusText()}): ${body}`
      );
    }

    const statusAfterBurn = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );
    if (!statusAfterBurn.ok()) {
      const body = await statusAfterBurn.text().catch(() => "");
      throw new Error(
        `Credit status after burn failed (${statusAfterBurn.status()} ${statusAfterBurn.statusText()}): ${body}`
      );
    }
    const burnedPayload = (await statusAfterBurn.json()) as { balance?: number };
    expect(burnedPayload.balance).toBe(0);

    await expect
      .poll(async () => Number((await creditBalanceLocator.textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(0);

    const burnPhase3 = await page.context().request.post(`${controllerUrl}/credits`, {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json"
      },
      data: {
        requestId: `burn-${Date.now()}-c`,
        action: "burn",
        projectId,
        amount: 5,
        reason: "playwright_burn_phase3",
        metadata: { source: "playwright" }
      }
    });
    expect(burnPhase3.status()).toBe(400);

    const ledger = await page.context().request.get(
      `${controllerUrl}/credits/ledger?projectId=${encodeURIComponent(projectId)}&limit=50`,
      {
        headers: {
          authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );
    if (!ledger.ok()) {
      const body = await ledger.text().catch(() => "");
      throw new Error(`Ledger request failed (${ledger.status()}): ${body}`);
    }
    const payload = (await ledger.json()) as { entries?: Array<{ reason?: string }> };
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const dailyRefills = entries.filter((entry) => entry.reason === "auto_refill_daily");
    expect(dailyRefills).toHaveLength(1);

    await expect(page.getByTestId("credit-ledger-entry").first()).toBeVisible({ timeout: 20_000 });
  });
});
