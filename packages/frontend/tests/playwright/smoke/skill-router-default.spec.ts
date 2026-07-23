import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  prepareStudio,
  readWorkspaceFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000)
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
}

test.describe("Default skills scaffold", () => {
  test.describe.configure({ timeout: 180_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "skill-router-default:cleanup" }).catch(() => {});
  });

  test("scaffolds instafy-skill-router", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    if (!projectId) {
      throw new Error("Project id missing for skill-router scaffold test.");
    }
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "skill-router-default" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    // Trigger a runtime-agent turn so the memory scaffold (including default skills) is materialized.
    await page.getByTestId("chat-input").fill("Scaffold check");
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-bubble-user").last()).toContainText("Scaffold check", {
      timeout: 60_000,
    });

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(page, ".agents/skills/instafy-skill-router/SKILL.md", {
              projectId,
            })
          )?.trim(),
        { timeout: 120_000 },
      )
      .toContain("Skill router");

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(page, ".agents/skills/instafy-persistent-contexts/SKILL.md", {
              projectId,
            })
          )?.trim(),
        { timeout: 120_000 },
      )
      .toContain("Persistent contexts");

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(page, ".agents/skills/instafy-agent-collaboration/SKILL.md", {
              projectId,
            })
          )?.trim(),
        { timeout: 120_000 },
      )
      .toContain("inline references");

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(page, ".agents/skills/instafy-group-participation/SKILL.md", {
              projectId,
            })
          )?.trim(),
        { timeout: 120_000 },
      )
      .toContain("Group conversation participation");

    // Guardrail: skill router must be aware of /learn learned blocks so it can apply
    // small, routable memory updates across turns.
    const routerText = (
      await readWorkspaceFileText(page, ".agents/skills/instafy-skill-router/SKILL.md", { projectId })
    )?.trim();
    expect(routerText).toContain("Learned blocks (/learn)");
    expect(routerText).toContain("instafy-learned");
  });
});
