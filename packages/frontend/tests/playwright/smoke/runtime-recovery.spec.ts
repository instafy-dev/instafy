import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  getControllerUrl,
  prepareStudio,
  requestHostedRuntime,
  requireWorkspaceProjectId,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";
import { clickQueuedSendNowIfAvailable } from "../utils/chatUi.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";
import { disableAssistantIfPossible } from "../utils/runtimeAi.js";

function resolveServiceRoleKey(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  );
}

async function runTerminalCommand(
  page: Page,
  command: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  const prompt = `/terminal ${command}`;
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const outputBlocks = page.getByTestId("chat-command-output");
  const baselineOutputBlocks = await outputBlocks.count();
  const baselineOutputTexts = new Set(
    (await outputBlocks.allInnerTexts().catch(() => []))
      .map((text) => text.trim())
      .filter((text) => text.length > 0),
  );
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();
  const baselineAssistantText =
    baselineAssistantCount > 0
      ? (await assistantBubbles.last().innerText().catch(() => "")).trim()
      : "";
  const sendQueue = page.getByTestId("chat-send-queue");

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
  await page.getByTestId("chat-send-button").click();

  let commandOutput = "";
  await expect
    .poll(
      async () => {
        const queued = await sendQueue.isVisible().catch(() => false);
        if (queued) {
          await clickQueuedSendNowIfAvailable(page);
        }

        const outputTexts = (await outputBlocks.allInnerTexts().catch(() => []))
          .map((text) => text.trim())
          .filter((text) => text.length > 0);
        const newestOutput = [...outputTexts].reverse().find((text) => !baselineOutputTexts.has(text)) ?? "";
        if (!newestOutput) {
          const outputCount = await outputBlocks.count();
          if (outputCount > baselineOutputBlocks && outputTexts.length > 0) {
            commandOutput = outputTexts[outputTexts.length - 1] ?? "";
            return commandOutput;
          }
          const assistantCount = await assistantBubbles.count();
          if (assistantCount <= 0) {
            return "";
          }
          const assistantText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
          if (!assistantText || assistantText === baselineAssistantText) {
            return "";
          }
          const hasAssistantProgress =
            assistantCount > baselineAssistantCount ||
            assistantText.toLowerCase().includes("command completed in terminal session");
          if (hasAssistantProgress) {
            commandOutput = assistantText;
            return assistantText;
          }
          return "";
        }
        commandOutput = newestOutput;
        return commandOutput;
      },
      { timeout: timeoutMs },
    )
    .not.toBe("");

  return commandOutput;
}

test.describe.serial("Runtime Recovery", () => {
  // This spec intentionally waits through runtime stop + re-ensure + another /terminal round-trip.
  // Keep the overall timeout comfortably above the per-command timeouts to avoid false negatives
  // when local Docker is slow.
  test.setTimeout(720_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      source: "runtime-recovery:cleanup",
    }).catch(() => {});
  });

  test("recovers after hosted runtime is stopped between turns", async ({ page }) => {
    const controllerUrl = getControllerUrl();
    const serviceRoleKey = resolveServiceRoleKey();
    if (!controllerUrl || !serviceRoleKey) {
      throw new Error("Controller URL and service role key are required for runtime recovery test");
    }

    await prepareStudio(page, { waitForHostedRuntime: true });
    const projectId = await requireWorkspaceProjectId(page);
    await ensureProjectCreditsReadyForChat(page, projectId, 30);
    await clearRuntimePreference(page, { projectId, source: "runtime-recovery" });

    const hostedReady = await waitForHostedRuntimeReady(page, 120_000, { projectId });
    await disableAssistantIfPossible(page);
    const runtimeId = hostedReady.runtimeId;

    const marker1 = `runtime-recovery-1-${Date.now()}`;
    const firstOutput = await runTerminalCommand(page, `echo ${marker1}`, { timeoutMs: 180_000 });
    expect(firstOutput).toContain(marker1);

    const stopRes = await page.context().request.post(`${controllerUrl}/runtime/stop`, {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: runtimeId,
        reason: "playwright:runtime-recovery",
      },
    });
    expect(stopRes.ok()).toBeTruthy();

    await expect
      .poll(
        async () => {
          const statusRes = await page.context().request.get(
            `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`,
            {
              headers: { authorization: `Bearer ${serviceRoleKey}` },
            },
          );
          if (!statusRes.ok()) {
            return null;
          }
          const payload = (await statusRes.json()) as { runtimes?: Array<Record<string, unknown>> };
          const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
          const entry = runtimes.find((candidate) => candidate?.runtimeId === runtimeId);
          return typeof entry?.status === "string" ? entry.status : null;
        },
        { timeout: 60_000 },
      )
      .toMatch(/stopped|offline/i);

    const readyAgain = await waitForHostedRuntimeReady(page, 30_000, { projectId })
      .then(() => true)
      .catch(() => false);
    if (!readyAgain) {
      await requestHostedRuntime(page, {
        projectId,
        source: "chat",
        existingRuntimeStrategy: "launch-new",
        timeoutMs: 180_000,
      }).catch(() => {});
    }
    await waitForHostedRuntimeReady(page, 180_000, { projectId });
    await ensureProjectCreditsReadyForChat(page, projectId, 30);

    // Verify that Studio can continue after churn. We expect the runtime layer to recover
    // (auto-ensure or fallback) so /terminal still completes.
    const marker2 = `runtime-recovery-2-${Date.now()}`;
    const secondOutput = await runTerminalCommand(page, `echo ${marker2}`, {
      // The first terminal dispatch after a hosted runtime is re-ensured can substantially
      // exceed the normal per-command ceiling during a long serial suite run when Docker is busy.
      timeoutMs: 420_000,
    });
    expect(secondOutput).toContain(marker2);
  });
});
