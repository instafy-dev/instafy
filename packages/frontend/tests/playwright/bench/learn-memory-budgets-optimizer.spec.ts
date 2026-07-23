import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  readWorkspaceFileText,
  listWorkspaceEntries,
} from "../utils/harness.js";
import { attemptApplyLearn, formatMs } from "./benchLearnUtils.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  const hosted = await waitForHostedRuntimeReady(page, 120_000, { projectId });
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
  return hosted;
}

async function runTerminalCommand(
  page: Page,
  command: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  const prompt = `/terminal ${command}`;
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const outputBlocks = page.getByTestId("chat-command-output");
  const baselineOutputBlocks = await outputBlocks.count().catch(() => 0);
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count().catch(() => 0);
  const baselineAssistantText =
    baselineAssistantCount > 0 ? (await assistantBubbles.last().innerText().catch(() => "")).trim() : "";

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-send-button").click();
  // Multiline /terminal commands are rendered collapsed in the user bubble; only assert the prefix.
  await expect(page.getByTestId("chat-bubble-user").last()).toContainText("/terminal");

  let commandOutput = "";
  await expect
    .poll(
      async () => {
        const outputCount = await outputBlocks.count().catch(() => baselineOutputBlocks);
        if (outputCount <= baselineOutputBlocks) {
          // Compatibility path: some controller/runtime combos only surface terminal completion
          // via assistant thread text instead of a structured output block.
          const assistantCount = await assistantBubbles.count().catch(() => baselineAssistantCount);
          if (assistantCount <= 0) {
            return "";
          }
          const assistantText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
          if (!assistantText || assistantText === baselineAssistantText) {
            return "";
          }
          const hasNewAssistantMessage = assistantCount > baselineAssistantCount;
          if (
            hasNewAssistantMessage &&
            assistantText.toLowerCase().includes("command completed in terminal session")
          ) {
            commandOutput = assistantText;
            return assistantText;
          }
          return "";
        }
        const text = await outputBlocks.last().innerText().catch(() => "");
        commandOutput = text.trim();
        return commandOutput;
      },
      { timeout: timeoutMs },
    )
    .not.toBe("");

  return commandOutput;
}

function byteLen(text: string | null): number {
  if (!text) return 0;
  return Buffer.byteLength(text, "utf8");
}

function countIndexBullets(text: string | null): number {
  return (text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith("- [`"))
    .length;
}

test.describe("Bench: /learn optimizer enforces memory budgets (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );

  // Bench specs are expensive and can burn through provider quota; avoid auto-retries that add
  // noise to timing and make failures harder to interpret.
  test.describe.configure({ timeout: 15 * 60_000, retries: 0 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:learn-budgets:cleanup" }).catch(() => {});
  });

  test("caps INSTAFY.md and learned index after /learn", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for learn budgets bench.");
    }

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:learn-budgets" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    // Seed oversized memory directly inside the hosted runtime workspace so /learn sees it
    // immediately (avoid origin-sync races).
    await runTerminalCommand(
      page,
      [
        "python - <<'PY'",
        "import os",
        "from pathlib import Path",
        "",
        "root = Path('.')",
        "instafy = ['# INSTAFY.md', '']",
        "for i in range(2500):",
        "    instafy.append(f'- line {i}: ' + ('x'*12))",
        "root.joinpath('INSTAFY.md').write_text('\\n'.join(instafy) + '\\n', encoding='utf-8')",
        "",
        "index_path = root / '.agents' / 'skills' / 'instafy-learned' / 'SKILL.md'",
        "index_path.parent.mkdir(parents=True, exist_ok=True)",
        "index_path.write_text('X'*20000, encoding='utf-8')",
        "",
        "blocks_root = root / '.agents' / 'skills' / 'instafy-learned' / 'blocks'",
        "for i in range(1, 31):",
        "    name = f'block-{i:02d}'",
        "    d = blocks_root / name",
        "    d.mkdir(parents=True, exist_ok=True)",
        "    content = \"---\\n\" + f\"description: Deterministic block {i}\\n\" + \"---\\n\\n\" + f\"# {name}\\n\\nApply when: test harness wants deterministic blocks.\\n\"",
        "    (d / 'SKILL.md').write_text(content, encoding='utf-8')",
        "",
        "print('seeded')",
        "PY",
      ].join("\n"),
      { timeoutMs: 180_000 },
    );

    const learnStartedAt = Date.now();
    const learnOutcome = await attemptApplyLearn(page, "/learn 1");
    if (learnOutcome.error) {
      throw new Error(`learn failed: ${learnOutcome.error}`);
    }

    // The /learn execution commits back to the workspace origin asynchronously. Poll until the
    // committed files reflect budget caps.
    await expect
      .poll(async () => byteLen(await readWorkspaceFileText(page, "INSTAFY.md", { projectId })), { timeout: 60_000 })
      .toBeLessThanOrEqual(12_000);
    await expect
      .poll(
        async () => byteLen(await readWorkspaceFileText(page, ".agents/skills/instafy-learned/SKILL.md", { projectId })),
        { timeout: 60_000 },
      )
      .toBeLessThanOrEqual(6_500);

    const instafyAfter = await readWorkspaceFileText(page, "INSTAFY.md", { projectId });
    const indexAfter = await readWorkspaceFileText(page, ".agents/skills/instafy-learned/SKILL.md", { projectId });

    // These are "hard-ish" budgets enforced by the runtime optimizer. Allow a small
    // tail for truncation markers and metadata.
    expect(byteLen(instafyAfter)).toBeLessThanOrEqual(12_000);
    expect(byteLen(indexAfter)).toBeLessThanOrEqual(6_500);
    expect(countIndexBullets(indexAfter)).toBeLessThanOrEqual(20);

    // Verify the learned index was actually refactored back to the canonical template,
    // not just truncated. This is the "skills refactor" aspect of the optimizer.
    expect(indexAfter ?? "").toContain("name: instafy-learned");
    expect(indexAfter ?? "").toContain("# Learned memory blocks (index)");
    expect(indexAfter ?? "").toContain("Blocks (managed by /learn)");
    expect(indexAfter ?? "").toMatch(/^- \[`/m);

    const blocks = await listWorkspaceEntries(page, ".agents/skills/instafy-learned/blocks", { projectId });
    const blockDirs = blocks?.filter((entry) => (entry.hasChildren ?? false) || (entry.kind ?? "").toLowerCase() === "dir") ?? [];
    // The optimizer may create a details-only overflow directory (no SKILL.md), so exclude it when
    // validating that every SKILL block is either indexed or archived.
    const skillBlockCount = blockDirs.filter((entry) => entry.name !== "instafy-memory-overflow").length;
    expect(skillBlockCount).toBeGreaterThanOrEqual(30);

    const archive = await readWorkspaceFileText(page, ".agents/skills/instafy-learned/ARCHIVE.md", { projectId });
    if (archive) {
      const archiveCount = archive
        .split(/\r?\n/)
        .filter((line) => line.trimStart().startsWith("- `"))
        .length;
      const indexed = countIndexBullets(indexAfter);
      expect(archiveCount).toBeGreaterThanOrEqual(Math.max(0, skillBlockCount - indexed));
    }

    const overflow = await readWorkspaceFileText(
      page,
      ".agents/skills/instafy-learned/blocks/instafy-memory-overflow/DETAILS.md",
      { projectId },
    );
    if (overflow) {
      expect(instafyAfter ?? "").toContain("Truncated by `/learn` optimizer");
      expect(overflow.length).toBeGreaterThan(50);
    }

    const learnWallMs = Date.now() - learnStartedAt;
    test.info().annotations.push({
      type: "learn",
      description: `learn wall: ${formatMs(learnWallMs)} signal=${learnOutcome.signal ?? "-"}`,
    });
  });
});
