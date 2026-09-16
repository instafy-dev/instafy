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

async function openSkillsDiscoverTab(page: Page): Promise<void> {
  await openSkillsPanel(page);
  const discoverTab = page.getByTestId("skills-tab-discover");
  if (await discoverTab.isVisible().catch(() => false)) {
    await discoverTab.click();
  }
  await expect(page.getByTestId("skills-discovery-query")).toBeVisible({ timeout: 60_000 });
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

function buildExpectedSkillImportLine(params: {
  expectedSource: string;
  expectedSkillName?: string;
}): string {
  return [
    "/skills import",
    params.expectedSource,
    params.expectedSkillName ? `--name ${params.expectedSkillName}` : null,
    "--start",
  ]
    .filter(Boolean)
    .join(" ");
}

async function countConversationTabs(page: Page): Promise<number> {
  return page
    .getByTestId("workspace-tabs")
    .locator("[data-tab-kind='conversation']")
    .count()
    .catch(() => 0);
}

// Every skills send lands as the user's own one-line message in the
// conversation that was already active: no new conversation, no tab switch.
// Callers run with an existing active conversation, so the tab count is a
// valid invariant here.
async function expectSkillImportTaskConversation(
  page: Page,
  params: {
    expectedSource: string;
    expectedSkillName?: string;
    tabCountBefore: number;
  },
): Promise<void> {
  const expectedLine = buildExpectedSkillImportLine(params);
  await expect
    .poll(async () => (await page.getByTestId("chat-bubble-user").last().innerText().catch(() => "")).trim(), {
      timeout: 90_000,
    })
    .toContain(expectedLine);
  expect(await countConversationTabs(page)).toBe(params.tabCountBefore);
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
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "skills-import" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyInUi(page, projectId);
    await page.getByTestId("sidebar-nav-chat").click();

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
      /Imported skill\s+`?playwright-imported-skill`?/i,
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
    await page.getByTestId("sidebar-nav-chat").click();
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

  test("discovery Playwright install is idempotent and opens installed skill", async ({
    page,
  }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for discovery install test.");
    }
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "skills-discovery" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyInUi(page, projectId);
    await page.getByTestId("sidebar-nav-chat").click();

    await page.route("**/projects/*/skills/discover**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const query = (requestUrl.searchParams.get("q") ?? "").trim().toLowerCase();

      if (query.includes("playwright")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            query,
            results: [
              {
                id: "github:community:playwright-skill",
                title: "Playwright Browser",
                description: "Automate browser checks, screenshots, and e2e flows with a community skill.",
                lane: "curated",
                provenance: "github-repo-shim",
                isInstallable: true,
                source: "github",
                sourceLabel: "GitHub",
                installSource:
                  "https://github.com/lackeyjb/playwright-skill/tree/main/skills/playwright-skill",
                suggestedName: "playwright-skill",
                homepage:
                  "https://github.com/lackeyjb/playwright-skill/tree/main/skills/playwright-skill",
                repo: "lackeyjb/playwright-skill",
                category: "Browser & Automation",
                tags: ["playwright", "browser", "automation"],
                stars: 100,
              },
            ],
            laneCounts: {
              curated: 1,
              registry: 0,
              longTail: 0,
            },
            curatedCategories: [{ name: "Browser & Automation", count: 1 }],
            warnings: [],
            cached: false,
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          query,
          results: [],
          laneCounts: {
            curated: 0,
            registry: 0,
            longTail: 0,
          },
          curatedCategories: [],
          warnings: [],
          cached: false,
        }),
      });
    });

    await openSkillsDiscoverTab(page);
    await page.getByTestId("skills-discovery-query").fill("playwright browser");
    await page.getByTestId("skills-discovery-search").click();
    const installButton = page.getByTestId("skills-discovery-install-github:community:playwright-skill");
    await expect(installButton).toBeVisible({ timeout: 60_000 });
    const tabCountBeforeInstall = await countConversationTabs(page);
    await installButton.click();
    // Settings stays put: the line lands in the active chat; the panel does not switch.
    await expect(page.getByTestId("skills-panel")).toBeVisible();
    await page.getByTestId("sidebar-nav-chat").click();
    await expectSkillImportTaskConversation(page, {
      expectedSource: "https://github.com/lackeyjb/playwright-skill/tree/main/skills/playwright-skill",
      expectedSkillName: "playwright-skill",
      tabCountBefore: tabCountBeforeInstall,
    });

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(page, ".agents/skills/playwright-skill/SKILL.md", {
              projectId,
            })
          )?.trim(),
        { timeout: 180_000 }
      )
      .toContain("# Playwright Browser Automation");

    await expect
      .poll(
        async () =>
          (
            await readWorkspaceFileText(page, ".agents/skills/playwright-skill/SKILL.md", {
              projectId,
            })
          )?.trim(),
        { timeout: 180_000 }
      )
      .toContain("## Instafy Compatibility");

    await openSkillsDiscoverTab(page);
    await page.getByTestId("skills-discovery-query").fill("playwright browser");
    await page.getByTestId("skills-discovery-search").click();
    const openButton = page.getByTestId("skills-discovery-open-github:community:playwright-skill");
    await expect(openButton).toBeVisible({ timeout: 60_000 });
    await openButton.click();

    await expect(
      page
        .getByRole("heading", { name: "SKILL.md" })
        .or(page.getByText(".agents/skills/playwright-skill/SKILL.md"))
        .first()
    ).toBeVisible({
      timeout: 60_000,
    });
  });

  test("discovery WhatsApp install opens import task conversation and transitions to installed controls", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    await page.route("**/projects/*/skills/discover**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const query = (requestUrl.searchParams.get("q") ?? "").trim().toLowerCase();

      if (query === "whatsapp") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            query: "whatsapp",
            results: [
              {
                id: "github:openclaw:whatsapp-concierge",
                title: "WhatsApp Concierge",
                description: "Automate WhatsApp customer messaging workflows.",
                lane: "curated",
                provenance: "openclaw-awesome",
                isInstallable: true,
                source: "github",
                sourceLabel: "GitHub",
                installSource:
                  "https://github.com/openclaw/skills/tree/main/whatsapp-concierge/SKILL.md",
                suggestedName: "whatsapp-concierge",
                homepage:
                  "https://github.com/openclaw/skills/tree/main/whatsapp-concierge/SKILL.md",
                repo: "openclaw/skills",
                category: "<h3 style=\"display:inline\">Communication</h3>",
                tags: ["messaging"],
                stars: 100,
              },
              {
                id: "github:openclaw:openclaw-whatsapp",
                title: "OpenClaw WhatsApp",
                description: "Integrate OpenClaw agents with WhatsApp messaging.",
                lane: "registry",
                provenance: "playbooks-api",
                isInstallable: true,
                source: "playbooks",
                sourceLabel: "Playbooks",
                installSource:
                  "https://github.com/openclaw/skills/tree/main/openclaw-whatsapp/SKILL.md",
                suggestedName: "openclaw-whatsapp",
                homepage:
                  "https://github.com/openclaw/skills/tree/main/openclaw-whatsapp/SKILL.md",
                repo: "openclaw/skills",
                category: "Communication",
                tags: ["messaging"],
                stars: 50,
              },
            ],
            laneCounts: {
              curated: 1,
              registry: 1,
              longTail: 0,
            },
            curatedCategories: [
              { name: "<h3 style=\"display:inline\">Communication</h3>", count: 2 },
            ],
            warnings: [],
            cached: false,
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          query,
          results: [],
          laneCounts: {
            curated: 0,
            registry: 0,
            longTail: 0,
          },
          curatedCategories: [],
          warnings: [],
          cached: false,
        }),
      });
    });

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for discovery search test.");
    }
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "skills-discovery-whatsapp" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyInUi(page, projectId);
    await page.getByTestId("sidebar-nav-chat").click();

    await openSkillsDiscoverTab(page);
    await expect(page.getByTestId("skills-discovery-query")).toHaveValue("");
    await page.getByTestId("skills-discovery-query").fill("whatsapp");
    await page.getByTestId("skills-discovery-search").click();

    const discoveryRows = page
      .getByTestId("skills-discovery-list")
      .locator('[data-testid^="skills-discovery-item-"]');
    const firstDiscoveryCard = discoveryRows.first();
    await expect(firstDiscoveryCard).toBeVisible({ timeout: 60_000 });
    await expect(firstDiscoveryCard).toContainText("WhatsApp Concierge");
    await expect(firstDiscoveryCard).toContainText("Communication");
    await expect(firstDiscoveryCard).toContainText("GitHub");
    await expect(firstDiscoveryCard).toContainText("★ 100");
    await expect(firstDiscoveryCard.getByText("Installable now")).toHaveCount(0);
    await expect(page.getByTestId("skills-discovery-category-select")).toContainText("Communication (2)");
    await expect(page.locator("text=/^<h3 style=\\\"display:inline\\\">/")).toHaveCount(0);

    const firstInstallButton = firstDiscoveryCard.getByRole("button", { name: "Install" });
    await expect(firstInstallButton).toBeVisible({ timeout: 60_000 });
    const tabCountBeforeInstall = await countConversationTabs(page);
    await firstInstallButton.click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();
    await page.getByTestId("sidebar-nav-chat").click();
    await expectSkillImportTaskConversation(page, {
      expectedSource: "https://github.com/openclaw/skills/tree/main/whatsapp-concierge/SKILL.md",
      expectedSkillName: "whatsapp-concierge",
      tabCountBefore: tabCountBeforeInstall,
    });

    const installedSkillContent = [
      "---",
      "name: whatsapp-concierge",
      "description: WhatsApp automation skill fixture.",
      "---",
      "",
      "# WhatsApp Concierge",
      "",
      "Use this skill to automate WhatsApp workflows in tests.",
      "",
    ].join("\n");
    await writeWorkspaceFile(
      page,
      ".agents/skills/whatsapp-concierge/SKILL.md",
      installedSkillContent,
      { projectId },
    );

    await openSkillsDiscoverTab(page);
    await page.getByTestId("skills-discovery-query").fill("whatsapp");
    await page.getByTestId("skills-discovery-search").click();
    await expect(
      page.getByTestId("skills-discovery-item-github:openclaw:whatsapp-concierge"),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("skills-refresh").click();
    await expect(
      page.getByTestId("skills-discovery-toggle-github:openclaw:whatsapp-concierge"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByTestId("skills-discovery-open-github:openclaw:whatsapp-concierge"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByTestId("skills-discovery-install-github:openclaw:whatsapp-concierge"),
    ).toHaveCount(0);

    const askButton = page.getByTestId("skills-discovery-ask-github:openclaw:whatsapp-concierge");
    await expect(askButton).toBeVisible({ timeout: 60_000 });
    await askButton.click();

    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible({ timeout: 60_000 });
    // "Ask" is a prefill the user completes in the composer; nothing is sent.
    await expect(chatInput).toContainText("/skills start whatsapp-concierge");
    await expect(chatInput).not.toContainText("I just installed");
  });

  test("connect a tool from the composer menu through Paste a skill link", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for composer connect test.");
    }
    // `--start` continues into a model turn, so the AI lane must be ready.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "skills-connect" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyInUi(page, projectId);
    await page.getByTestId("sidebar-nav-chat").click();

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
    const tabCountBefore = await countConversationTabs(page);

    await page.getByTestId("composer-action-menu-trigger").click();
    await page.getByTestId("composer-action-menu-connect").click();

    // Connect sub-view: the featured rows plus Browse all tools, and nothing sent.
    for (const id of ["slack", "notion", "discord", "github", "browse"]) {
      await expect(page.getByTestId(`composer-action-menu-connect-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("composer-action-menu-connect-freefinance")).toHaveCount(0);
    await expect(page.getByTestId("composer-action-menu-connect-other")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    // Skill packs that are not published yet: the row is disabled with a Soon
    // Badge and opens no confirm sheet. GitHub stays live.
    for (const id of ["slack", "notion", "discord"]) {
      const row = page.getByTestId(`composer-action-menu-connect-${id}`);
      await expect(row).toBeDisabled();
      await expect(row).toContainText("Soon");
    }
    await expect(page.getByTestId("composer-action-menu-connect-github")).toBeEnabled();
    await page.getByTestId("composer-action-menu-connect-slack").click({ force: true });
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    await expect(page.getByTestId("composer-action-menu-connect-browse")).toBeVisible();
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    // "Browse all tools" opens the sheet's browse stage; "Paste a skill link" in its
    // footer opens the import modal; "Add and start" sends the one line.
    await page.getByTestId("composer-action-menu-connect-browse").click();
    await expect(page.getByRole("dialog", { name: "Connect a tool" })).toBeVisible();
    await expect(page.getByTestId("connect-search")).toBeVisible();
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
    await page.getByTestId("connect-paste-link").click();
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    await expect(page.getByTestId("skills-add-modal")).toBeVisible();
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
      .toMatch(/Imported 1 skill/i);

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

    expect(await countConversationTabs(page)).toBe(tabCountBefore);
  });

  test("Browse all tools searches by keyword and Escape sends nothing", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for browse tools test.");
    }
    await page.getByTestId("sidebar-nav-chat").click();

    const userBubbles = page.getByTestId("chat-bubble-user");
    const userBubbleCountBefore = await userBubbles.count();

    await page.getByTestId("composer-action-menu-trigger").click();
    await page.getByTestId("composer-action-menu-connect").click();
    await page.getByTestId("composer-action-menu-connect-browse").click();

    // Browse stage: search and the category rows. Popular stays hidden while
    // GitHub is the only featured tool that can be selected; the unpublished
    // packs are listed disabled with a Soon Badge.
    await expect(page.getByRole("dialog", { name: "Connect a tool" })).toBeVisible();
    await expect(page.getByTestId("connect-popular")).toHaveCount(0);
    await expect(page.getByTestId("connect-popular-slack")).toHaveCount(0);
    await expect(page.getByTestId("connect-row-github")).toBeEnabled();
    for (const id of ["slack", "notion", "discord"]) {
      await expect(page.getByTestId(`connect-row-${id}`)).toBeDisabled();
      await expect(page.getByTestId(`connect-row-${id}-meta`)).toHaveText("Soon");
    }

    // A keyword narrows the list to the niche tool, still greyed.
    await page.getByTestId("connect-search").fill("buch");
    await expect(page.getByTestId("connect-row-freefinance")).toBeVisible();
    await expect(page.getByTestId("connect-row-freefinance")).toBeEnabled();
    await expect(page.getByTestId("connect-row-freefinance-meta")).toHaveText("Austria");
    await expect(page.getByTestId("connect-row-slack")).toHaveCount(0);
    await expect(page.getByTestId("connect-popular-slack")).toHaveCount(0);
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
  });

  test("Import a GitHub repo on the getting-started card opens the GitHub flow", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for GitHub import test.");
    }
    await page.getByTestId("sidebar-nav-chat").click();

    const userBubbles = page.getByTestId("chat-bubble-user");
    const userBubbleCountBefore = await userBubbles.count();

    const importAction = page
      .getByTestId("onboarding-getting-started")
      .getByTestId("onboarding-action-import-github-repo");
    await expect(importAction).toBeVisible({ timeout: 60_000 });
    await importAction.click();

    // The card switches to its GitHub mode: repo import plus device login.
    await expect(page.getByTestId("onboarding-github-connect-button")).toBeVisible();
    await expect(page.getByTestId("onboarding-github-repo-input")).toBeVisible();
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);
  });

  test("a soon card chip opens nothing, More tools browses and Escape sends nothing", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for card chip test.");
    }
    await page.getByTestId("sidebar-nav-chat").click();

    const userBubbles = page.getByTestId("chat-bubble-user");
    const userBubbleCountBefore = await userBubbles.count();

    const card = page.getByTestId("onboarding-getting-started");
    const slackChip = card.getByTestId("connect-chip-slack");
    await expect(slackChip).toBeVisible({ timeout: 60_000 });
    // Featured skills only: no niche chip, no GitHub chip, no paste link on the card.
    await expect(card.getByTestId("connect-chip-freefinance")).toHaveCount(0);
    await expect(card.getByTestId("connect-chip-github")).toHaveCount(0);
    await expect(card.getByTestId("connect-chip-other")).toHaveCount(0);
    await expect(card.getByTestId("connect-more-tools")).toBeVisible();

    // Every shipped chip is a skill whose pack is not published yet: disabled,
    // with a Soon Badge, and a press opens no sheet.
    for (const id of ["slack", "notion", "discord"]) {
      const chip = card.getByTestId(`connect-chip-${id}`);
      await expect(chip).toBeDisabled();
      await expect(chip).toHaveAttribute("aria-label", /, coming soon$/);
      await expect(card.getByTestId(`connect-chip-${id}-soon`)).toHaveText("Soon");
    }
    await slackChip.click({ force: true });
    await expect(page.getByTestId("connect-sheet")).toHaveCount(0);
    await expect(page.getByTestId("connect-confirm-submit")).toHaveCount(0);
    expect(await userBubbles.count()).toBe(userBubbleCountBefore);

    // "More tools" opens the browse stage; the soon rows are disabled there
    // too and the GitHub row leads to the card's GitHub mode.
    await card.getByTestId("connect-more-tools").click();
    await expect(page.getByRole("dialog", { name: "Connect a tool" })).toBeVisible();
    await expect(page.getByTestId("connect-row-notion")).toBeDisabled();
    await expect(page.getByTestId("connect-row-notion-meta")).toHaveText("Soon");
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

  test("live GitHub discovery resolves Nice-Wolf-Studio agent-discord-skills", async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_SKILLS_LIVE_GITHUB ?? "").trim() !== "1",
      "Enable with PLAYWRIGHT_SKILLS_LIVE_GITHUB=1 to run live GitHub discovery coverage.",
    );

    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for live GitHub discovery test.");
    }

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "skills-discovery-live-github" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyInUi(page, projectId);
    await page.getByTestId("sidebar-nav-chat").click();

    await openSkillsDiscoverTab(page);
    await page.getByTestId("skills-discovery-query").fill("Nice-Wolf-Studio agent-discord-skills");
    await page.getByTestId("skills-discovery-search").click();

    await expect(page.getByTestId("skills-discovery-list")).toBeVisible({ timeout: 90_000 });

    const targetRepositoryText = page
      .getByTestId("skills-discovery-list")
      .getByText(/Nice-Wolf-Studio\/agent-discord-skills|agent-discord-skills/i)
      .first();
    await expect(targetRepositoryText).toBeVisible({ timeout: 90_000 });

    const githubSourceHint = page
      .getByTestId("skills-discovery-list")
      .getByText(/GitHub|github\.com/i)
      .first();
    await expect(githubSourceHint).toBeVisible({ timeout: 90_000 });
  });
});
