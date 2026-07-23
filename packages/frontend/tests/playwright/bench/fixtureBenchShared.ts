import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

import {
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";

type BenchAttemptLike = {
  attempt: number;
  phase?: "pre" | "post";
  success: boolean;
  failureKind?: string | null;
  wallMs: number | null;
};

type BenchAiEvaluationLike = {
  error: string | null;
  quality: number | null;
};

type BenchAiArtifactLike = {
  skippedReason: string | null;
  evaluations: BenchAiEvaluationLike[];
};

export const FIXTURE_BENCH_MODEL =
  (process.env.PLAYWRIGHT_BENCH_MODEL ?? process.env.PLAYWRIGHT_LEARN_MODEL ?? process.env.PLAYWRIGHT_RETRO_MODEL ?? "gpt-5.5").trim() ||
  "gpt-5.5";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");
const instafyAssetsRoot = path.join(repoRoot, "packages/runtime-agent/assets/instafy");

type RepoWorkspaceSeedFile = {
  workspacePath: string;
  content: string;
};

export type SeededLearnedBlock = {
  name: string;
  description: string;
  content: string;
};

let cachedRepoPinnedSeedFiles: RepoWorkspaceSeedFile[] | null = null;
const DEFAULT_BENCH_RECYCLE_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_BENCH_RECYCLE_TIMEOUT_MS ?? "90000",
  10,
);
const PLAYWRIGHT_BENCH_RECYCLE_RUNTIME = (process.env.PLAYWRIGHT_BENCH_RECYCLE_RUNTIME ?? "0").trim() === "1";

async function withBenchTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectRepoPinnedSeedFiles(): RepoWorkspaceSeedFile[] {
  if (cachedRepoPinnedSeedFiles) {
    return cachedRepoPinnedSeedFiles;
  }

  const files: RepoWorkspaceSeedFile[] = [];
  const pushTextFile = (assetRelativePath: string) => {
    const absolutePath = path.join(instafyAssetsRoot, assetRelativePath);
    const content = fs.readFileSync(absolutePath, "utf8");
    files.push({
      workspacePath: assetRelativePath.split(path.sep).join("/"),
      content,
    });
  };

  pushTextFile("AGENTS.md");
  pushTextFile("AGENTS.py");
  pushTextFile("learnings/_pinned/learning-policy.md");

  const skillsRoot = path.join(instafyAssetsRoot, ".agents/skills");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      const relativeFromSkillsRoot = path.relative(skillsRoot, absolutePath).split(path.sep).join("/");
      if (relativeFromSkillsRoot === "instafy-learned" || relativeFromSkillsRoot.startsWith("instafy-learned/")) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const assetRelativePath = path.relative(instafyAssetsRoot, absolutePath).split(path.sep).join("/");
      pushTextFile(assetRelativePath);
    }
  };
  walk(skillsRoot);

  cachedRepoPinnedSeedFiles = files;
  return files;
}

export async function seedRepoPinnedSkillsIntoWorkspace(page: Page, projectId: string) {
  for (const file of collectRepoPinnedSeedFiles()) {
    await writeWorkspaceFile(page, file.workspacePath, file.content, {
      createDirectories: true,
      projectId,
    });
  }
}

export async function seedLearnedBlocksIntoWorkspace(
  page: Page,
  projectId: string,
  blocks: SeededLearnedBlock[],
) {
  const normalized = blocks.map((block) => ({
    ...block,
    name: block.name.trim(),
    description: block.description.trim(),
    content: block.content.trim(),
  }));

  const indexBody =
    [
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
      ...normalized.map(
        (block) =>
          `- [\`${block.name}\`](blocks/${block.name}/SKILL.md): ${block.description}`,
      ),
      "",
    ].join("\n") + "\n";

  await writeWorkspaceFile(page, ".agents/skills/instafy-learned/SKILL.md", indexBody, {
    createDirectories: true,
    projectId,
  });

  await writeWorkspaceFile(
    page,
    ".agents/skills/instafy-learned/USAGE.json",
    JSON.stringify(
      {
        version: 1,
        updatedAtMs: Date.now(),
        blocks: {},
      },
      null,
      2,
    ),
    {
      createDirectories: true,
      projectId,
    },
  );

  for (const block of normalized) {
    await writeWorkspaceFile(
      page,
      `.agents/skills/instafy-learned/blocks/${block.name}/SKILL.md`,
      `${block.content}\n`,
      {
        createDirectories: true,
        projectId,
      },
    );
  }
}

export async function ensureHostedRuntimeReadyForBench(page: Page, projectId: string) {
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

export async function hideBrowserSessionIfVisible(page: Page) {
  const modal = page.getByTestId("browser-session-modal");
  const visible = await modal.isVisible().catch(() => false);
  if (!visible) return;
  const hideButton = modal.getByRole("button", { name: /hide browser session/i });
  if (await hideButton.isVisible().catch(() => false)) {
    await hideButton.click().catch(() => {});
  }
  await expect(modal).toBeHidden({ timeout: 30_000 }).catch(() => {});
}

export async function recycleHostedRuntimeForBench(page: Page, projectId: string, source: string) {
  if (!PLAYWRIGHT_BENCH_RECYCLE_RUNTIME) {
    await hideBrowserSessionIfVisible(page).catch(() => {});
    return;
  }
  const timeoutMs =
    Number.isFinite(DEFAULT_BENCH_RECYCLE_TIMEOUT_MS) && DEFAULT_BENCH_RECYCLE_TIMEOUT_MS > 0
      ? DEFAULT_BENCH_RECYCLE_TIMEOUT_MS
      : 90_000;
  await hideBrowserSessionIfVisible(page).catch(() => {});
  await withBenchTimeout(
    resetRuntimeUserState(page, {
      source,
      projectIds: [projectId],
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[recycleHostedRuntimeForBench] reset failed: ${message}`);
    }),
    timeoutMs,
    "bench runtime reset",
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[recycleHostedRuntimeForBench] ${message}`);
  });
  await withBenchTimeout(ensureHostedRuntimeReadyForBench(page, projectId), timeoutMs, "bench runtime ready").catch(
    async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[recycleHostedRuntimeForBench] ${message}`);
      await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 15_000 });
    },
  );
}

export function assertDeterministicBenchCompleted(options: {
  attempts: BenchAttemptLike[];
  aiQuality?: BenchAiArtifactLike | null;
  requireAiEvaluation?: boolean;
  postMaxShellCommands?: number | null;
  postMustNotExceedPreBy?: number | null;
  allowNoLearnedBlocks?: boolean;
}) {
  const {
    attempts,
    aiQuality,
    requireAiEvaluation = (process.env.PLAYWRIGHT_BENCH_AI_EVAL ?? "1").trim() !== "0",
    postMaxShellCommands = null,
    postMustNotExceedPreBy = null,
    allowNoLearnedBlocks = true,
  } = options;

  expect(attempts.length).toBeGreaterThan(0);

  for (const attempt of attempts) {
    expect.soft(
      attempt.success,
      `Attempt ${attempt.phase ?? "-"}#${attempt.attempt} should succeed but failed with ${attempt.failureKind ?? "unknown"}.`,
    ).toBe(true);
    expect.soft(
      typeof attempt.wallMs === "number" && Number.isFinite(attempt.wallMs) && attempt.wallMs > 0,
      `Attempt ${attempt.phase ?? "-"}#${attempt.attempt} should have finite wallMs.`,
    ).toBe(true);
  }

  if (postMaxShellCommands !== null) {
    const overLimit = attempts.filter((attempt) => {
      if (attempt.phase !== "post") return false;
      const shellCommands = (attempt as BenchAttemptLike & { shellCommands?: number | null }).shellCommands;
      return typeof shellCommands === "number" && Number.isFinite(shellCommands) && shellCommands > postMaxShellCommands;
    });
    expect.soft(
      overLimit.length,
      `Post attempts should stay within ${postMaxShellCommands} shell command(s); offending attempts: ${overLimit
        .map((attempt) => {
          const shellCommands = (attempt as BenchAttemptLike & { shellCommands?: number | null }).shellCommands;
          return `${attempt.phase ?? "-"}#${attempt.attempt}=${shellCommands ?? "?"}`;
        })
        .join(", ") || "-"}.`,
    ).toBe(0);
  }

  if (postMustNotExceedPreBy !== null) {
    const preShells = attempts
      .filter((attempt) => attempt.phase === "pre")
      .map((attempt) => (attempt as BenchAttemptLike & { shellCommands?: number | null }).shellCommands)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const postShells = attempts
      .filter((attempt) => attempt.phase === "post")
      .map((attempt) => (attempt as BenchAttemptLike & { shellCommands?: number | null }).shellCommands)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (preShells.length > 0 && postShells.length > 0) {
      const preMean = preShells.reduce((sum, value) => sum + value, 0) / preShells.length;
      const postMean = postShells.reduce((sum, value) => sum + value, 0) / postShells.length;
      expect.soft(
        postMean - preMean,
        `Post shell-command mean should not exceed pre mean by more than ${postMustNotExceedPreBy}; observed pre=${preMean.toFixed(
          2,
        )}, post=${postMean.toFixed(2)}.`,
      ).toBeLessThanOrEqual(postMustNotExceedPreBy);
    }
  }

  if (!requireAiEvaluation) return;
  expect(aiQuality, "AI quality artifact should be produced when evaluation is enabled.").not.toBeNull();
  const skippedReason = aiQuality?.skippedReason ?? null;
  if (allowNoLearnedBlocks && skippedReason === "No learned blocks were loaded in this benchmark.") {
    return;
  }
  expect(skippedReason, "AI quality evaluation should not be skipped.").toBeNull();
  expect((aiQuality?.evaluations?.length ?? 0) > 0, "AI quality evaluation should include at least one block.").toBe(true);
  for (const [index, evaluation] of (aiQuality?.evaluations ?? []).entries()) {
    expect.soft(evaluation.error, `AI evaluation ${index} should parse cleanly.`).toBeNull();
    expect.soft(
      typeof evaluation.quality === "number" && Number.isFinite(evaluation.quality),
      `AI evaluation ${index} should have a numeric quality score.`,
    ).toBe(true);
  }
}

export async function writeBenchProgressMarker(
  page: Page,
  options: {
    projectId: string;
    benchDir: string;
    step: string;
    details?: Record<string, unknown>;
  },
) {
  const payload = {
    step: options.step,
    updatedAt: new Date().toISOString(),
    ...(options.details ?? {}),
  };
  await writeWorkspaceFile(page, `${options.benchDir}/progress.json`, JSON.stringify(payload, null, 2), {
    createDirectories: true,
    projectId: options.projectId,
  }).catch(() => {});
}

export async function abortBenchIfNoSuccessfulPreAttempt(
  page: Page,
  options: {
    projectId: string;
    benchDir: string;
    attempts: BenchAttemptLike[];
  },
) {
  const preAttempts = options.attempts.filter((attempt) => attempt.phase === "pre");
  if (preAttempts.some((attempt) => attempt.success)) {
    return;
  }

  const failureSummary = preAttempts
    .map((attempt) => `${attempt.attempt}:${attempt.failureKind ?? "unknown"}`)
    .join(", ");

  await writeBenchProgressMarker(page, {
    projectId: options.projectId,
    benchDir: options.benchDir,
    step: "pre-failed",
    details: {
      reason: "no-successful-pre-attempt",
      attempts: preAttempts.length,
      failures: failureSummary,
    },
  });

  throw new Error(
    `Bench aborted before /learn because no pre attempt succeeded${failureSummary ? ` (${failureSummary})` : ""}.`,
  );
}
