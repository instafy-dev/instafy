import { expect, test } from "@playwright/test";

import {
  clearRuntimePreference,
  prepareStudio,
  readWorkspaceFileText,
  resetRuntimeUserState,
  selectPrimaryAgentModel,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { attemptApplyLearn, summarizeBenchSignal } from "./benchLearnUtils.js";
import { collectLearnRoutingSnapshot } from "./benchRoutingDebug.js";
import { FIXTURE_BENCH_MODEL, ensureHostedRuntimeReadyForBench } from "./fixtureBenchShared.js";

const BLOATED_BLOCK_COUNT = 4;
const OVERSIZE_INSTAFY_LINES = 60;

function buildOversizeInstafy(): string {
  const lines = [
    "# INSTAFY.md",
    "",
    "This file is intentionally oversized for the anti-bloat bench.",
    "",
  ];
  for (let i = 0; i < OVERSIZE_INSTAFY_LINES; i += 1) {
    lines.push(`- repeated-note-${i}: this memory line is intentionally verbose and should not survive in this exact form across /learn optimization passes.`);
  }
  return lines.join("\n");
}

function buildBloatedLearnedIndex(): string {
  const lines = [
    "---",
    "name: instafy-learned",
    "description: Index and routing hints for learned memory blocks produced by /learn (kept small; open blocks on demand).",
    "---",
    "",
    "# Learned memory blocks (index)",
    "",
    "Never prune: yes",
    "",
    "This skill is a **small index** into learned memory blocks created by `/learn`.",
    "",
    "Size budget (hard):",
    "- Keep this file under ~6k bytes.",
    "- Index at most ~20 blocks.",
    "- Keep each entry to a single line; put details in the block's `SKILL.md` / `DETAILS.md`.",
    "",
    "## Where learned blocks live",
    "",
    "- `.agents/skills/instafy-learned/blocks/<name>/SKILL.md`",
    "- Optional deep details: `.agents/skills/instafy-learned/blocks/<name>/DETAILS.md`",
    "",
    "Do not load every block. Open only what applies to the current request.",
    "",
    "## How to use (strict)",
    "",
    "1. Read this index and pick **at most 2** blocks that match the user’s current request.",
    "2. Open those block skill files and follow the procedure.",
    "3. If blocked, open `DETAILS.md` for that block (only then).",
    "",
    "## Blocks (managed by /learn)",
    "",
    "<!-- /learn will keep this section short and updated. -->",
    "",
  ];
  const repeatedTail =
    " This bullet is intentionally verbose and low-signal so the optimizer should shrink the visible routing surface aggressively.";
  for (let i = 1; i <= BLOATED_BLOCK_COUNT; i += 1) {
    const name = `bloated-block-${String(i).padStart(2, "0")}`;
    lines.push(
      `- [\`${name}\`](./blocks/${name}/SKILL.md) — A verbose, repetitive routing hint for benchmark cleanup item ${i} that should be compressed into a smaller index.${repeatedTail.repeat(
        3,
      )}`,
    );
  }
  return lines.join("\n");
}

function buildBlockSkill(name: string, idx: number): string {
  return [
    "---",
    `name: ${name}`,
    `description: Oversized benchmark block ${idx}.`,
    "---",
    "",
    `# ${name}`,
    "",
    "Apply when: any browser-like task, any memory question, or any vaguely similar activity.",
    "",
    "Procedure:",
    "1. Start by considering many possible options.",
    "2. If unsure, continue considering options before acting.",
    "",
    "Stop/verify conditions:",
    "- Stop eventually.",
    "- Verify vaguely.",
    "",
    `Notes: This is synthetic anti-bloat content block ${idx}.`,
  ].join("\n");
}

test.describe("Bench: /learn anti-bloat optimizer (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );

  test.describe.configure({ timeout: 30 * 60_000, retries: 0 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:learn-anti-bloat-seeded:cleanup" }).catch(() => {});
  });

  test("seed oversized memory, run /learn, assert optimizer compresses routing surface", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 2").trim() || "/learn 2";
    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for anti-bloat bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:learn-anti-bloat-seeded" }).catch(() => {});
    await ensureHostedRuntimeReadyForBench(page, projectId);
    await selectPrimaryAgentModel(page, FIXTURE_BENCH_MODEL);

    const benchDir = "bench/learn-anti-bloat-seeded";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Seeded anti-bloat /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    await writeWorkspaceFile(page, "INSTAFY.md", buildOversizeInstafy(), {
      createDirectories: true,
      projectId,
    });
    await writeWorkspaceFile(page, ".agents/skills/instafy-learned/SKILL.md", buildBloatedLearnedIndex(), {
      createDirectories: true,
      projectId,
    });
    await writeWorkspaceFile(page, ".agents/skills/instafy-learned/USAGE.json", JSON.stringify({ version: 1, updated_at_ms: 0, blocks: {} }, null, 2), {
      createDirectories: true,
      projectId,
    });

    for (let i = 1; i <= BLOATED_BLOCK_COUNT; i += 1) {
      const name = `bloated-block-${String(i).padStart(2, "0")}`;
      await writeWorkspaceFile(
        page,
        `.agents/skills/instafy-learned/blocks/${name}/SKILL.md`,
        buildBlockSkill(name, i),
        {
          createDirectories: true,
          projectId,
        },
      );
    }

    await page.getByTestId("chat-input").fill("Answer with exactly: ANSWER: 2");
    await page.getByTestId("chat-send-button").click();
    await expect
      .poll(async () => {
        const bubbles = page.locator('[data-testid="chat-bubble-assistant"]');
        const count = await bubbles.count();
        if (count === 0) return "";
        return (await bubbles.last().innerText().catch(() => "")).trim();
      }, { timeout: 120_000 })
      .toContain("ANSWER");

    const beforeSnapshot = await collectLearnRoutingSnapshot(page, projectId, { maxBlocks: 60 });
    const beforeIndexText = await readWorkspaceFileText(page, ".agents/skills/instafy-learned/SKILL.md", { projectId });
    const beforeInstafyText = await readWorkspaceFileText(page, "INSTAFY.md", { projectId });
    const beforeBulletCount = beforeIndexText.split(/\r?\n/).filter((line) => line.trimStart().startsWith("- [`")).length;
    const seededBlockNames = Array.from({ length: BLOATED_BLOCK_COUNT }, (_, idx) => `bloated-block-${String(idx + 1).padStart(2, "0")}`);

    const learnOutcome = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true });

    const afterSnapshot = await collectLearnRoutingSnapshot(page, projectId, { maxBlocks: 60 });
    const afterIndexText = await readWorkspaceFileText(page, ".agents/skills/instafy-learned/SKILL.md", { projectId });
    const afterInstafyText = await readWorkspaceFileText(page, "INSTAFY.md", { projectId });
    const archiveText = await readWorkspaceFileText(page, ".agents/skills/instafy-learned/ARCHIVE.md", { projectId }).catch(() => null);
    const afterBulletCount = afterIndexText.split(/\r?\n/).filter((line) => line.trimStart().startsWith("- [`")).length;
    const activeSeededAfter = seededBlockNames.filter((name) => afterIndexText.includes(`[\`${name}\`]`));

    const report = [
      "# Seeded anti-bloat /learn benchmark",
      "",
      `Model: ${FIXTURE_BENCH_MODEL}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Before",
      "",
      `INSTAFY.md bytes: ${beforeSnapshot.instafyMdBytes ?? "-"}`,
      `Learned index bytes: ${beforeSnapshot.learnedIndexBytes ?? "-"}`,
      `Learned block count: ${beforeSnapshot.learnedBlockCount}`,
      `Index bullets: ${beforeBulletCount}`,
      "",
      "## After",
      "",
      `INSTAFY.md bytes: ${afterSnapshot.instafyMdBytes ?? "-"}`,
      `Learned index bytes: ${afterSnapshot.learnedIndexBytes ?? "-"}`,
      `Learned block count: ${afterSnapshot.learnedBlockCount}`,
      `Index bullets: ${afterBulletCount}`,
      `Archive present: ${archiveText ? "yes" : "no"}`,
      "",
      "## /learn outcome",
      "",
      `Command: \`${learnCommand}\``,
      `Wall: ${learnOutcome.wallMs ? `${Math.round(learnOutcome.wallMs / 1000)}s` : "-"}`,
      `Signal: ${summarizeBenchSignal(learnOutcome.signal ?? "-")}`,
      `Error: ${((learnOutcome.error ?? "-") as string).replace(/\|/g, " ")}`,
      "",
    ].join("\n");

    await writeWorkspaceFile(page, `${benchDir}/report.md`, report, {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const instafyShrank = afterInstafyText.length < beforeInstafyText.length;
    const indexShrank = afterIndexText.length < beforeIndexText.length;

    expect(indexShrank || instafyShrank).toBeTruthy();
    expect(afterBulletCount).toBeLessThanOrEqual(20);
    const archivedOrPruned =
      (archiveText && archiveText.includes("bloated-block-")) ||
      activeSeededAfter.length === 0;
    expect(activeSeededAfter.length).toBe(0);
    expect(afterSnapshot.learnedBlockCount).toBeGreaterThanOrEqual(1);
    expect(archivedOrPruned).toBeTruthy();
  });
});
