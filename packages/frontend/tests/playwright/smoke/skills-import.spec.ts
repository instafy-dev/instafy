import { activeConversationId, returnToConversation } from "../utils/conversationNavigation.js";
import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  prepareStudio,
  readWorkspaceFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { ensureProjectCreditsReadyInUi } from "../utils/projectCredits.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
}

async function openSkillsPanel(page: Page): Promise<void> {
  if (
    !(await page.getByTestId("sidebar-nav-more").isVisible().catch(() => false)) &&
    !(await page.getByTestId("sidebar-more-item-skills").first().isVisible().catch(() => false))
  ) {
    await page.getByTestId("topbar-sidebar-toggle").click();
  }
  await openSidebarSecondaryItem(page, "skills");
  await expect(page.getByTestId("skills-panel")).toBeVisible({ timeout: 60_000 });
}

async function runSkillsCommandAndWait(
  page: Page,
  command: string,
  expectedPattern: RegExp,
  timeoutMs = 180_000
): Promise<string> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  await page.getByTestId("chat-input").fill(command);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-bubble-user").last()).toContainText(command, {
    timeout: timeoutMs,
  });

  const newAssistant = assistantBubbles.nth(baselineAssistantCount);
  await expect(newAssistant).toBeVisible({ timeout: timeoutMs });
  await expect
    .poll(async () => (await newAssistant.innerText().catch(() => "")).trim(), {
      timeout: timeoutMs,
    })
    .toMatch(expectedPattern);

  return (await newAssistant.innerText().catch(() => "")).trim();
}

function parseSkillCount(summaryText: string): number {
  const match = summaryText.match(/(\d+)\s+skill\(s\)\s+available/i);
  if (!match) {
    return -1;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : -1;
}

test.describe("Skills command", () => {
  test.describe.configure({ timeout: 240_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "skills-import:cleanup" }).catch(() => {});
  });

  test("imports a local skill and lists it", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for skills import test.");
    }
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await returnToConversation(page);
    await clearRuntimePreference(page, { projectId, source: "skills-import" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyInUi(page, projectId);
    await returnToConversation(page);

    const fixturePath = "playwright/skill-import-fixture/SKILL.md";
    const fixtureContent = [
      "---",
      "name: playwright-imported-skill",
      "description: skill imported by Playwright e2e",
      "---",
      "",
      "# Playwright imported skill",
      "",
      "Use this skill when testing deterministic slash-command behavior.",
      "",
    ].join("\n");

    await writeWorkspaceFile(page, fixturePath, fixtureContent, { projectId });

    const initialListSummary = await runSkillsCommandAndWait(
      page,
      "/skills list",
      /skill\(s\)\s+available/i,
      120_000
    );
    const initialSkillCount = parseSkillCount(initialListSummary);
    expect(initialSkillCount).toBeGreaterThan(0);

    await runSkillsCommandAndWait(
      page,
      "/skills import playwright/skill-import-fixture",
      /Playwright imported skill is ready\./i,
      180_000
    );

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(
              page,
              ".agents/skills/playwright-imported-skill/SKILL.md",
              {
                projectId,
              }
            )
          )?.trim(),
        { timeout: 120_000 }
      )
      .toContain("# Playwright imported skill");

    const postImportListSummary = await runSkillsCommandAndWait(
      page,
      "/skills list",
      /skill\(s\)\s+available/i,
      120_000
    );
    const postImportSkillCount = parseSkillCount(postImportListSummary);
    expect(postImportSkillCount).toBe(initialSkillCount + 1);
  });

  test("uninstalls an installed skill from Skills panel", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for skills uninstall test.");
    }
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await returnToConversation(page);
    await clearRuntimePreference(page, { projectId, source: "skills-uninstall" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const skillSlug = "playwright-remove-e2e";
    const skillPath = `.agents/skills/${skillSlug}/SKILL.md`;
    const skillContent = [
      "---",
      `name: ${skillSlug}`,
      "description: skill uninstall test fixture",
      "---",
      "",
      "# Playwright remove e2e",
      "",
      "Use this fixture for uninstall behavior coverage.",
      "",
    ].join("\n");

    await writeWorkspaceFile(page, skillPath, skillContent, { projectId });

    await openSkillsPanel(page);
    await page.getByTestId("skills-actions").click();
    await page.getByTestId("skills-refresh").click();

    const skillCard = page.getByTestId(`skills-item-${skillSlug}`);
    await expect(skillCard).toBeVisible({ timeout: 60_000 });

    const uninstallButton = page.getByTestId(`skills-uninstall-${skillSlug}`);
    await expect(uninstallButton).toBeVisible({ timeout: 60_000 });
    await uninstallButton.click();

    await expect(skillCard).toHaveCount(0, { timeout: 60_000 });
    await expect(
      page.getByTestId(`skills-uninstall-${skillSlug}`),
    ).toHaveCount(0, { timeout: 60_000 });

    await expect
      .poll(
        async () =>
          await readWorkspaceFileText(page, skillPath, {
            projectId,
          }),
        { timeout: 60_000 },
      )
      .toBeNull();
  });

  test("connect a tool from the composer menu through Import custom skill", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for composer connect test.");
    }
    // `--start` continues into a model turn, so the AI lane must be ready.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await returnToConversation(page);
    await clearRuntimePreference(page, { projectId, source: "skills-connect" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyInUi(page, projectId);
    await returnToConversation(page);

    const fixturePath = "playwright/skill-import-fixture/SKILL.md";
    const fixtureContent = [
      "---",
      "name: playwright-imported-skill",
      "description: skill imported by Playwright e2e",
      "---",
      "",
      "# Playwright imported skill",
      "",
      "Use this skill when testing deterministic slash-command behavior.",
      "",
    ].join("\n");
    await writeWorkspaceFile(page, fixturePath, fixtureContent, { projectId });

    const userBubbles = page.getByTestId("chat-bubble-user");
    const userBubbleCountBefore = await userBubbles.count();
    const conversationIdBefore = await activeConversationId(page);

    await page.getByTestId("composer-action-menu-trigger").click();
    await page.getByTestId("composer-action-menu-connect").click();

    // Connect sub-view: only the featured rows that can be selected today
    // (GitHub, Notion, FreeFinance) plus Browse all tools, and nothing sent.
    // Skill packs that are not published yet are not rows here; the sheet
    // names them with a Soon Badge.
    for (const id of ["notion", "github", "freefinance", "browse"]) {
      await expect(page.getByTestId(`composer-action-menu-connect-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("composer-action-menu-connect-other")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    // Skill packs that are not published yet get no row at all; Notion
    // (published) and GitHub stay live, and nothing here reads Soon.
    for (const id of ["slack", "discord"]) {
      await expect(page.getByTestId(`composer-action-menu-connect-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("composer-action-menu-connect-notion")).toBeEnabled();
    await expect(page.getByTestId("composer-action-menu")).not.toContainText("Soon");
    await expect(page.getByTestId("composer-action-menu-connect-github")).toBeEnabled();
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    // "Browse all tools" opens the sheet's browse stage; "Import custom skill" in its
    // footer opens the import modal; "Add and start" sends the one line.
    await page.getByTestId("composer-action-menu-connect-browse").click();
    await expect(page.getByRole("dialog", { name: "Connect a tool" })).toBeVisible();
    await expect(page.getByTestId("connect-search")).toBeVisible();
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
    await page.getByTestId("connect-paste-link").click();
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Import custom skill", exact: true })).toBeVisible();
    await page.getByTestId("skills-import-source").fill("playwright/skill-import-fixture");
    const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
    const baselineAssistantCount = await assistantBubbles.count();
    await page.getByTestId("skills-import-submit").click();

    await expect(page.getByTestId("skills-add-modal")).toHaveCount(0);
    await expect
      .poll(async () => (await userBubbles.last().innerText().catch(() => "")).trim(), {
        timeout: 90_000,
      })
      .toContain("/skills import playwright/skill-import-fixture --start");
    expect(await userBubbles.count()).toBe(userBubbleCountBefore + 1);

    // Stop at the import card; the model's kickoff reply is not awaited.
    const importCard = assistantBubbles.nth(baselineAssistantCount);
    await expect(importCard).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(async () => (await importCard.innerText().catch(() => "")).trim(), { timeout: 180_000 })
      .toMatch(/ is ready\./i);

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(page, ".agents/skills/playwright-imported-skill/SKILL.md", {
              projectId,
            })
          )?.trim(),
        { timeout: 120_000 },
      )
      .toContain("# Playwright imported skill");

    expect(await activeConversationId(page)).toBe(conversationIdBefore);
  });

  test("Browse all tools searches by keyword and Escape sends nothing", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for browse tools test.");
    }
    await returnToConversation(page);

    const userBubbles = page.getByTestId("chat-bubble-user");
    const userBubbleCountBefore = await userBubbles.count();

    await page.getByTestId("composer-action-menu-trigger").click();
    await page.getByTestId("composer-action-menu-connect").click();
    await page.getByTestId("composer-action-menu-connect-browse").click();

    // Browse stage: search, the Popular row of the three selectable featured
    // tools (GitHub, Notion and FreeFinance, as bare marks) and the category
    // rows; the unpublished packs are listed disabled with a Soon Badge.
    await expect(page.getByRole("dialog", { name: "Connect a tool" })).toBeVisible();
    await expect(page.getByTestId("connect-popular")).toBeVisible();
    await expect(page.getByTestId("connect-popular-notion")).toBeEnabled();
    await expect(page.getByTestId("connect-popular-github")).toBeEnabled();
    await expect(page.getByTestId("connect-popular-freefinance")).toBeEnabled();
    await expect(page.getByTestId("connect-popular-slack")).toHaveCount(0);
    await expect(page.getByTestId("connect-popular-discord")).toHaveCount(0);
    await expect(page.getByTestId("connect-row-github")).toBeEnabled();
    await expect(page.getByTestId("connect-row-notion")).toBeEnabled();
    await expect(page.getByTestId("connect-row-notion-meta")).toHaveCount(0);
    for (const id of ["slack", "discord"]) {
      await expect(page.getByTestId(`connect-row-${id}`)).toBeDisabled();
      await expect(page.getByTestId(`connect-row-${id}-meta`)).toHaveText("Soon");
    }

    // A keyword narrows the list to the niche tool and hides Popular.
    await page.getByTestId("connect-search").fill("buch");
    await expect(page.getByTestId("connect-row-freefinance")).toBeVisible();
    await expect(page.getByTestId("connect-row-freefinance")).toBeEnabled();
    await expect(page.getByTestId("connect-row-freefinance-meta")).toHaveText("Austria");
    await expect(page.getByTestId("connect-row-slack")).toHaveCount(0);
    await expect(page.getByTestId("connect-row-notion")).toHaveCount(0);
    await expect(page.getByTestId("connect-popular")).toHaveCount(0);
    await expect(page.getByTestId("connect-popular-notion")).toHaveCount(0);
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
  });

  test("the GitHub chip on the getting-started card opens the GitHub flow", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for GitHub import test.");
    }
    await returnToConversation(page);

    const userBubbles = page.getByTestId("chat-bubble-user");
    const userBubbleCountBefore = await userBubbles.count();

    const importChip = page
      .getByTestId("onboarding-getting-started")
      .getByTestId("connect-chip-github");
    await expect(importChip).toBeVisible({ timeout: 60_000 });
    await expect(importChip).toHaveAttribute("aria-label", "Import from GitHub");
    await importChip.click();

    // The card switches to its GitHub mode: repo import plus device login.
    await expect(page.getByTestId("onboarding-github-connect-button")).toBeVisible();
    await expect(page.getByTestId("onboarding-github-repo-input")).toBeVisible();
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
  });

  test("the card row confirms a skill, keeps soon tools out, browses and sends nothing", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for card chip test.");
    }
    await returnToConversation(page);

    const userBubbles = page.getByTestId("chat-bubble-user");
    const userBubbleCountBefore = await userBubbles.count();

    const card = page.getByTestId("onboarding-getting-started");
    const notionChip = card.getByTestId("connect-chip-notion");
    await expect(notionChip).toBeVisible({ timeout: 60_000 });
    // The row is every featured tool that can be picked today: GitHub, then
    // Notion and FreeFinance. Slack and Discord (unpublished) get no chip and
    // no Soon badge here; the sheet names them. No paste link, no pending
    // line: every entry on the card leads somewhere.
    await expect(card.locator('button[data-testid^="connect-chip-"]')).toHaveCount(3);
    await expect(card.getByTestId("connect-chip-github")).toBeEnabled();
    await expect(card.getByTestId("connect-chip-freefinance")).toBeEnabled();
    for (const id of ["slack", "discord", "other"]) {
      await expect(card.getByTestId(`connect-chip-${id}`)).toHaveCount(0);
    }
    await expect(card.getByTestId("connect-coming-soon")).toHaveCount(0);
    await expect(card).not.toContainText("Soon");
    await expect(card.getByTestId("connect-more-tools")).toBeVisible();
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    // Notion's pack is published: the chip is live and opens the confirm
    // stage straight away (no Back, since it did not come from the list);
    // nothing is sent until Connect, and Escape sends nothing.
    await expect(notionChip).toBeEnabled();
    await expect(notionChip).toHaveAttribute("aria-label", "Connect Notion");
    await expect(card.getByTestId("connect-chip-notion-soon")).toHaveCount(0);
    await notionChip.click();
    await expect(page.getByRole("dialog", { name: "Connect Notion" })).toBeVisible();
    await expect(page.getByTestId("connect-confirm-submit")).toBeVisible();
    await expect(page.getByTestId("connect-confirm-back")).toHaveCount(0);
    // The sheet renders before the pack is installed, so it names no value:
    // what Notion calls this one is the pack's to say, on the secret card in
    // the setup conversation this Connect button starts.
    await expect(page.getByTestId("connect-confirm-needs-line")).toContainText(
      "Setup will ask you for whatever Notion needs, one value at a time",
    );
    await expect(page.getByTestId("connect-confirm-needs-line")).not.toContainText(
      "Installation access token",
    );
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    // "More tools" opens the browse stage; the soon rows are disabled there
    // too, the Notion row is live, and the GitHub row leads to the card's
    // GitHub mode.
    await card.getByTestId("connect-more-tools").click();
    await expect(page.getByRole("dialog", { name: "Connect a tool" })).toBeVisible();
    await expect(page.getByTestId("connect-row-slack")).toBeDisabled();
    await expect(page.getByTestId("connect-row-slack-meta")).toHaveText("Soon");
    await expect(page.getByTestId("connect-row-notion")).toBeEnabled();
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    await card.getByTestId("connect-more-tools").click();
    await expect(page.getByRole("dialog", { name: "Connect a tool" })).toBeVisible();
    await page.getByTestId("connect-row-github").click();
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-github-connect-button")).toBeVisible();
    await expect(page.getByTestId("onboarding-github-repo-input")).toBeVisible();
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
  });

});
