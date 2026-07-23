import { expect, type Page } from "@playwright/test";

import { getControllerUrl, getSupabaseAuthHeaders } from "./harness.js";
import { openCreditsPanel } from "./sidebar.js";
import { focusLastConversationTab } from "./chatUi.js";

export async function ensureProjectCredits(page: Page, projectId: string, minimumBalance = 15) {
  const controllerUrl = getControllerUrl().replace(/\/+$/, "");
  const headers = getSupabaseAuthHeaders();
  const serviceRole = headers.authorization ?? "";
  if (!controllerUrl || !serviceRole) {
    return;
  }

  const statusResponse = await page.context().request.get(
    `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: {
        authorization: serviceRole,
      },
    },
  );
  if (!statusResponse.ok()) {
    const body = await statusResponse.text().catch(() => "");
    throw new Error(`Failed to load credit status (${statusResponse.status()}): ${body.slice(0, 200)}`);
  }

  const payload = (await statusResponse.json()) as { balance?: number };
  const balance = Number(payload.balance ?? 0);
  if (Number.isFinite(balance) && balance >= minimumBalance) {
    return;
  }

  const adjustResponse = await page.context().request.post(
    `${controllerUrl}/operator/projects/${encodeURIComponent(projectId)}/credits/adjust`,
    {
      headers: {
        authorization: serviceRole,
        "content-type": "application/json",
      },
      data: {
        action: "set",
        amount: minimumBalance,
        note: "playwright project credit restore",
      },
    },
  );
  if (!adjustResponse.ok()) {
    const body = await adjustResponse.text().catch(() => "");
    throw new Error(`Failed to restore project credits (${adjustResponse.status()}): ${body.slice(0, 200)}`);
  }
}

export async function refreshCreditsInUi(page: Page, minimumBalance = 15) {
  await openCreditsPanel(page);
  await expect(page.getByTestId("credits-balance-row")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("credits-amount-view-units").click();
  await expect
    .poll(
      async () => {
        const text = await page.getByTestId("credits-balance").textContent().catch(() => "");
        const parsed = Number.parseInt((text ?? "").replace(/[^\d-]/g, ""), 10);
        return Number.isFinite(parsed) ? parsed : -1;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(minimumBalance);
}

export async function ensureProjectCreditsReadyInUi(page: Page, projectId: string, minimumBalance = 15) {
  await ensureProjectCredits(page, projectId, minimumBalance);
  await refreshCreditsInUi(page, minimumBalance);
}

export async function ensureProjectCreditsReadyForChat(
  page: Page,
  projectId: string,
  minimumBalance = 15,
) {
  await ensureProjectCreditsReadyInUi(page, projectId, minimumBalance);
  await focusLastConversationTab(page);
}
