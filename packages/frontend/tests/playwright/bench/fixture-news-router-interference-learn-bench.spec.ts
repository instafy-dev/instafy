import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  listWorkspaceEntries,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  selectPrimaryAgentModel,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { attemptApplyLearn, openNewConversation } from "./benchLearnUtils.js";
import { collectLearnRoutingSnapshot } from "./benchRoutingDebug.js";
import { seedRepoPinnedSkillsIntoWorkspace } from "./fixtureBenchShared.js";
import { startBenchFixtureSite, type BenchFixtureSite } from "./fixtureSiteHarness.js";
import { runFixtureNewsAttempt, runFixtureNewsTokenAttempt } from "./benchTasks.js";

const BENCH_MODEL =
  (process.env.PLAYWRIGHT_BENCH_MODEL ?? process.env.PLAYWRIGHT_LEARN_MODEL ?? process.env.PLAYWRIGHT_RETRO_MODEL ?? "gpt-5.5").trim() ||
  "gpt-5.5";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000)
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

async function hideBrowserSessionIfVisible(page: Page) {
  const modal = page.getByTestId("browser-session-modal");
  const visible = await modal.isVisible().catch(() => false);
  if (!visible) return;
  const hideButton = modal.getByRole("button", { name: /hide browser session/i });
  if (await hideButton.isVisible().catch(() => false)) {
    await hideButton.click().catch(() => {});
  }
  await expect(modal).toBeHidden({ timeout: 30_000 }).catch(() => {});
}

async function listLearnedBlockSkillPaths(page: Page, projectId: string): Promise<string[]> {
  const blocksRoot = ".agents/skills/instafy-learned/blocks";
  const entries = await listWorkspaceEntries(page, blocksRoot, { projectId }).catch(() => null);
  const dirs = (entries ?? [])
    .filter((entry) => (entry.kind ?? "").toLowerCase() !== "file")
    .map((entry) => `${entry.path}/SKILL.md`)
    .filter((value) => value && value.startsWith(blocksRoot))
    .sort((a, b) => a.localeCompare(b));
  return dirs;
}

function diffNewBlocks(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((path) => !beforeSet.has(path));
}

function unionSelectedBlocks(attempt: {
  learnedBlockReads?: string[];
  learnRouterBlocks?: Array<{ path: string }>;
}): string[] {
  const out = new Set<string>();
  const reads = Array.isArray(attempt.learnedBlockReads) ? attempt.learnedBlockReads : [];
  for (const path of reads) out.add(path);
  const router = Array.isArray(attempt.learnRouterBlocks) ? attempt.learnRouterBlocks : [];
  for (const block of router) {
    const path = (block?.path ?? "").trim();
    if (path) out.add(path);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

test.describe("Bench: /learn router interference guardrail (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.skip(
    (process.env.INSTAFY_ENABLE_BROWSER_SESSION ?? "").trim() !== "1",
    "Browser session disabled (set INSTAFY_ENABLE_BROWSER_SESSION=1 and use runtime-webdev image target).",
  );

  test.describe.configure({ timeout: 60 * 60_000, retries: 0 });
  let fixtureSite: BenchFixtureSite;

  test.beforeAll(async () => {
    fixtureSite = await startBenchFixtureSite("fixture-news-router-interference");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-router-interference:cleanup" }).catch(() => {});
  });

  test("learn A and B, then assert router keeps learned-block selection small", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "210");
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;

    const alpha = {
      expectedPathname: "/article/alpha",
      prompt: [
        "Benchmark task A (alpha):",
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/`,
        'If a cookie dialog appears, click "I agree".',
        "Open the first visible story/article on the homepage (alpha).",
        "Wait for the article page to load, then read the article heading and the current URL from the browser.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "",
        "In your final reply, include lines exactly like:",
        "ARTICLE_TITLE: <title>",
        "ARTICLE_URL: <url>",
      ].join("\n"),
    };

    const beta = {
      expectedPathname: "/article/beta",
      expectedToken: "BETA-TOKEN-2a4e19",
      prompt: [
        "Benchmark task B (beta):",
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/`,
        'If a cookie dialog appears, click "I agree".',
        `Use the Search page (either click "Search" or navigate to ${fixtureBaseUrl}/search).`,
        'Search for "beta" and submit.',
        'Open the Beta result (it should lead to /article/beta).',
        "Wait for the article page to load, then read the article heading, the current URL, and the article token from the browser.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "",
        "In your final reply, include lines exactly like:",
        "ARTICLE_TITLE: <title>",
        "ARTICLE_URL: <url>",
        "ARTICLE_TOKEN: <token>",
      ].join("\n"),
    };

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-router-interference bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-router-interference" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-router-interference";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news router interference /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    // Conversation 1: solve alpha, then learn.
    const blocks0 = await listLearnedBlockSkillPaths(page, projectId);
    const alphaAttempt1 = await runFixtureNewsAttempt(page, 1, alpha.prompt, budgetSec, {
      expectedOrigin,
      expectedPathname: alpha.expectedPathname,
    });
    await writeWorkspaceFile(page, `${benchDir}/attempt-alpha-1.json`, JSON.stringify(alphaAttempt1, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    const blocksBeforeLearnA = await listLearnedBlockSkillPaths(page, projectId);
    const learnAOutcome = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true }).catch(() => ({
      signal: null,
      error: "learn command failed",
      wallMs: null,
      assistantSummary: null,
    }));
    const blocksAfterLearnA = await listLearnedBlockSkillPaths(page, projectId);
    const learnedA = diffNewBlocks(blocksBeforeLearnA, blocksAfterLearnA);

    await writeWorkspaceFile(
      page,
      `${benchDir}/learn-alpha.json`,
      JSON.stringify(
        {
          blocks0Count: blocks0.length,
          blocksBefore: blocksBeforeLearnA.length,
          blocksAfter: blocksAfterLearnA.length,
          learnedBlocks: learnedA,
          outcome: { command: learnCommand, ...learnAOutcome },
          routingSnapshot: await collectLearnRoutingSnapshot(page, projectId).catch(() => null),
        },
        null,
        2,
      ),
      { createDirectories: true, projectId },
    ).catch(() => {});

    // Conversation 2: solve beta, then learn (only beta context).
    await openNewConversation(page);

    const blocksBeforeLearnB0 = await listLearnedBlockSkillPaths(page, projectId);
    const betaAttempt1 = await runFixtureNewsTokenAttempt(page, 2, beta.prompt, budgetSec, {
      expectedOrigin,
      expectedPathname: beta.expectedPathname,
      expectedToken: beta.expectedToken,
    });
    await writeWorkspaceFile(page, `${benchDir}/attempt-beta-1.json`, JSON.stringify(betaAttempt1, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    const blocksBeforeLearnB = await listLearnedBlockSkillPaths(page, projectId);
    const learnBOutcome = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true }).catch(() => ({
      signal: null,
      error: "learn command failed",
      wallMs: null,
      assistantSummary: null,
    }));
    const blocksAfterLearnB = await listLearnedBlockSkillPaths(page, projectId);
    const learnedB = diffNewBlocks(blocksBeforeLearnB, blocksAfterLearnB);

    await writeWorkspaceFile(
      page,
      `${benchDir}/learn-beta.json`,
      JSON.stringify(
        {
          blocksBeforeRun: blocksBeforeLearnB0.length,
          blocksBefore: blocksBeforeLearnB.length,
          blocksAfter: blocksAfterLearnB.length,
          learnedBlocks: learnedB,
          outcome: { command: learnCommand, ...learnBOutcome },
          routingSnapshot: await collectLearnRoutingSnapshot(page, projectId).catch(() => null),
        },
        null,
        2,
      ),
      { createDirectories: true, projectId },
    ).catch(() => {});

    // Guardrail assertions:
    // - /learn should create *some* learned blocks overall (or this benchmark has nothing to validate).
    // - beta may reasonably update an existing learned block, but after both learns the router
    //   must not cross-load alpha and beta memory indiscriminately.
    expect(learnedA.length, "Expected /learn after alpha to create at least one learned block.").toBeGreaterThan(0);
    const learnedAll = diffNewBlocks(blocks0, blocksAfterLearnB);
    expect(learnedAll.length, "Expected learned blocks to exist after two /learn runs.").toBeGreaterThan(0);

    const MAX_SELECTED_BLOCKS = 3;

    // Conversation 3: rerun alpha and assert router selects alpha block (and not beta block).
    await openNewConversation(page);
    const alphaAttempt2 = await runFixtureNewsAttempt(page, 3, alpha.prompt, budgetSec, {
      expectedOrigin,
      expectedPathname: alpha.expectedPathname,
    });
    await hideBrowserSessionIfVisible(page);
    const alphaSelected = unionSelectedBlocks(alphaAttempt2);
    await writeWorkspaceFile(
      page,
      `${benchDir}/attempt-alpha-2.json`,
      JSON.stringify({ ...alphaAttempt2, selectedBlocks: alphaSelected }, null, 2),
      { createDirectories: true, projectId },
    ).catch(() => {});

    const alphaSelectedHits = learnedA.filter((path) => alphaSelected.includes(path));
    const alphaSelectedBeta = learnedB.filter((path) => alphaSelected.includes(path));
    expect(alphaSelectedHits.length, "Expected follow-up alpha run to read at least one alpha learned block.").toBeGreaterThan(0);
    expect(alphaSelectedBeta, "Expected follow-up alpha run to NOT read beta learned blocks.").toEqual([]);
    expect(
      alphaSelected.length,
      `Expected follow-up alpha run to load <= ${MAX_SELECTED_BLOCKS} learned blocks (avoid bloat).`,
    ).toBeLessThanOrEqual(MAX_SELECTED_BLOCKS);

    // Conversation 4: rerun beta and assert router selects beta block (and not alpha block).
    await openNewConversation(page);
    const betaAttempt2 = await runFixtureNewsTokenAttempt(page, 4, beta.prompt, budgetSec, {
      expectedOrigin,
      expectedPathname: beta.expectedPathname,
      expectedToken: beta.expectedToken,
    });
    await hideBrowserSessionIfVisible(page);
    const betaSelected = unionSelectedBlocks(betaAttempt2);
    await writeWorkspaceFile(
      page,
      `${benchDir}/attempt-beta-2.json`,
      JSON.stringify({ ...betaAttempt2, selectedBlocks: betaSelected }, null, 2),
      { createDirectories: true, projectId },
    ).catch(() => {});

    const betaSelectedHits = learnedB.filter((path) => betaSelected.includes(path));
    const betaSelectedAlpha = learnedA.filter((path) => betaSelected.includes(path));
    expect(betaSelectedHits.length, "Expected follow-up beta run to read at least one beta learned block.").toBeGreaterThan(0);
    expect(betaSelectedAlpha, "Expected follow-up beta run to NOT read alpha learned blocks.").toEqual([]);
    expect(
      betaSelected.length,
      `Expected follow-up beta run to load <= ${MAX_SELECTED_BLOCKS} learned blocks (avoid bloat).`,
    ).toBeLessThanOrEqual(MAX_SELECTED_BLOCKS);

    const reportLines: string[] = [];
    reportLines.push("# Fixture news router interference /learn benchmark");
    reportLines.push("");
    reportLines.push(`Fixture: ${fixtureBaseUrl}`);
    reportLines.push(`Model: ${BENCH_MODEL}`);
    reportLines.push(`Generated: ${new Date().toISOString()}`);
    reportLines.push("");
    reportLines.push("## Learned blocks");
    reportLines.push("");
    reportLines.push(`Alpha new blocks (after learn A): ${learnedA.length}`);
    for (const block of learnedA) reportLines.push(`- ${block}`);
    reportLines.push("");
    reportLines.push(`Beta new blocks (after learn B): ${learnedB.length}`);
    for (const block of learnedB) reportLines.push(`- ${block}`);
    reportLines.push("");
    reportLines.push(`All learned blocks (after both learns): ${learnedAll.length}`);
    for (const block of learnedAll) reportLines.push(`- ${block}`);
    reportLines.push("");
    reportLines.push("## Selection checks");
    reportLines.push("");
    reportLines.push(`Alpha follow-up selected: ${alphaSelected.length} blocks`);
    reportLines.push(`Beta follow-up selected: ${betaSelected.length} blocks`);
    reportLines.push("");

    await writeWorkspaceFile(page, `${benchDir}/report.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    expect(true).toBeTruthy();
  });
});
