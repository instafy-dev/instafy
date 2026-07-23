import type { Page } from "@playwright/test";

import { readWorkspaceFileText, writeWorkspaceFile } from "../utils/harness.js";
import type { TokenUsage } from "./benchLearnUtils.js";
import type { LearnRoutingSnapshot } from "./benchRoutingDebug.js";
import { evaluateLearnedBlocksWithAi } from "./learnedBlockAiEvaluator.js";

type AttemptLike = {
  attempt: number;
  phase?: "pre" | "post";
  wallMs: number;
  success: boolean;
  failureKind?: string | null;
  mcpToolCalls?: number;
  shellCommands?: number;
  shellCommandSummaries?: string[];
  tokenUsage: TokenUsage | null;
  learnedBlockReads?: string[];
  learnedBlockReadCommands?: string[];
  learnRouterBlocks?: Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }>;
  routingSnapshot?: LearnRoutingSnapshot | null;
};

type BlockQuality = {
  path: string;
  sizeBytes: number | null;
  bulletCount: number;
  flags: string[];
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mu = mean(values);
  if (mu === null) return null;
  const variance = values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function formatTokenCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const rounded = Math.round(value / 100) / 10;
    return `${rounded}k`;
  }
  return `${Math.round(value)}`;
}

function unionBlocks(attempts: AttemptLike[]): string[] {
  const out = new Set<string>();
  for (const attempt of attempts) {
    const reads = Array.isArray(attempt.learnedBlockReads) ? attempt.learnedBlockReads : [];
    if (reads.length > 0) {
      for (const path of reads) out.add(path);
      continue;
    }
    const router = Array.isArray(attempt.learnRouterBlocks) ? attempt.learnRouterBlocks : [];
    for (const block of router) out.add(block.path);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function staticGuardrailFlagsForText(text: string): string[] {
  const flags: string[] = [];
  const sizeBytes = Buffer.byteLength(text, "utf8");
  const bulletCount = text
    .split(/\r?\n/)
    .filter((line) => /^(\s*[-*]\s+)/.test(line))
    .length;

  if (sizeBytes > 1800) flags.push("large_block");
  if (bulletCount > 8) flags.push("too_many_bullets");
  if (/```/.test(text)) flags.push("code_fence");
  if (
    /\b(?:bash -lc|NODE_PATH=|node - <<|python - <<|instafy history|instafy api)\b/.test(text) ||
    /(run exactly `|execute exactly `|copy this command:|paste this command:|use this exact command:)/i.test(
      text,
    )
  ) {
    flags.push("workflow_execution_replay");
  }
  if (/(produced token `|returned token `|example produced token `|learned example produced token `)/i.test(text)) {
    flags.push("stores_example_output_value");
  }
  if (
    !/(^|\n)#+\s*Verify\b/.test(text) &&
    !/(^|\n)#+\s*Stop\/verify\b/i.test(text) &&
    !/(^|\n)#+\s*Stop condition\b/i.test(text) &&
    !/(^|\n)#+\s*Stop when\b/i.test(text) &&
    !/(^|\n)\s*Verify\s*:/.test(text) &&
    !/(^|\n)\s*Stop\/verify\s*:/i.test(text) &&
    !/(^|\n)\s*Stop condition\s*:/i.test(text) &&
    !/(^|\n)\s*Stop when\s*:/i.test(text) &&
    !/(^|\n)\s*[-*]\s*Verify\s*:/.test(text) &&
    !/(^|\n)\s*[-*]\s*Stop\/verify\s*:/.test(text) &&
    !/(^|\n)\s*[-*]\s*Stop condition\s*:/i.test(text) &&
    !/(^|\n)\s*[-*]\s*Stop when\s*:/i.test(text)
  ) {
    flags.push("missing_verify_section");
  }

  return flags;
}

async function inspectBlocks(
  page: Page,
  projectId: string,
  blockPaths: string[],
): Promise<BlockQuality[]> {
  const out: BlockQuality[] = [];
  const unique = [...new Set(blockPaths)].sort((a, b) => a.localeCompare(b));
  for (const blockPath of unique) {
    const text = await readWorkspaceFileText(page, blockPath, { projectId }).catch(() => null);
    const sizeBytes = text === null ? null : Buffer.byteLength(text, "utf8");
    const bulletCount =
      text === null
        ? 0
        : text
            .split(/\r?\n/)
            .filter((line) => /^(\s*[-*]\s+)/.test(line))
            .length;
    out.push({
      path: blockPath,
      sizeBytes,
      bulletCount,
      flags: text === null ? ["missing_block"] : staticGuardrailFlagsForText(text),
    });
  }
  return out;
}

function snapshotSummary(snapshot: LearnRoutingSnapshot | null | undefined): Record<string, number | null> {
  if (!snapshot) {
    return {
      instafyMdBytes: null,
      learnedIndexBytes: null,
      learnedUsageBytes: null,
      learnedBlockCount: null,
      learnedBlockTotalBytes: null,
    };
  }
  return {
    instafyMdBytes: snapshot.instafyMdBytes ?? null,
    learnedIndexBytes: snapshot.learnedIndexBytes ?? null,
    learnedUsageBytes: snapshot.learnedUsageBytes ?? null,
    learnedBlockCount: snapshot.learnedBlockCount ?? null,
    learnedBlockTotalBytes: snapshot.learnedBlockTotalBytes ?? null,
  };
}

function formatDiff(before: number | null, after: number | null): string {
  if (before === null || after === null) return "-";
  const delta = after - before;
  const sign = delta >= 0 ? "+" : "";
  return `${after} (${sign}${delta})`;
}

function max(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((current, value) => Math.max(current, value), values[0] ?? null);
}

function regressionFlags(options: {
  preWallMean: number | null;
  postWallMean: number | null;
  preInputMean: number | null;
  postInputMean: number | null;
  preShellMean: number | null;
  postShellMean: number | null;
  postWallMax: number | null;
  postAttempts: AttemptLike[];
}): string[] {
  const flags: string[] = [];
  const { preWallMean, postWallMean, preInputMean, postInputMean, preShellMean, postShellMean, postWallMax, postAttempts } =
    options;
  const wallRegressed = !!(preWallMean && postWallMean && postWallMean > preWallMean * 1.2);
  const inputRegressed = !!(preInputMean && postInputMean && postInputMean > preInputMean * 1.2);
  const shellRegressed = !!(preShellMean !== null && postShellMean !== null && postShellMean > preShellMean + 1);

  if (wallRegressed) {
    const message = `Post mean wall time regressed by ${Math.round(((postWallMean! / preWallMean!) - 1) * 100)}%.`;
    if (!inputRegressed && !shellRegressed) {
      flags.push(`${message} Tokens/shell stayed flat, so treat this as a low-confidence timing-only regression.`);
    } else {
      flags.push(message);
    }
  }
  if (inputRegressed) {
    flags.push(`Post mean input tokens regressed by ${Math.round(((postInputMean! / preInputMean!) - 1) * 100)}%.`);
  }
  if (shellRegressed) {
    flags.push(`Post mean shell-command count increased from ${preShellMean!.toFixed(1)} to ${postShellMean!.toFixed(1)}.`);
  }
  if (preWallMean && postWallMax && postWallMax > preWallMean * 2) {
    flags.push(`Post has an outlier wall time (${formatMs(postWallMax)}) above 2x pre mean (${formatMs(preWallMean)}).`);
  }
  const repeatedShellRetry = postAttempts.find((attempt) => {
    const summaries = Array.isArray(attempt.shellCommandSummaries) ? attempt.shellCommandSummaries : [];
    if (summaries.length < 3) return false;
    const unique = new Set(summaries.map((value) => value.trim()).filter((value) => value.length > 0));
    return unique.size === 1;
  });
  if (repeatedShellRetry) {
    const count = repeatedShellRetry.shellCommandSummaries?.length ?? 0;
    flags.push(`Post repeated the same shell-based browser command ${count} times in a single attempt.`);
  }

  if (flags.length === 0) {
    flags.push("No obvious regression signal from phase means.");
  }
  return flags;
}

export async function writeLearnBenchDiagnostics(
  page: Page,
  options: {
    projectId: string;
    benchDir: string;
    attempts: AttemptLike[];
  },
): Promise<Awaited<ReturnType<typeof evaluateLearnedBlocksWithAi>> | null> {
  const preAttempts = options.attempts.filter((attempt) => attempt.phase === "pre");
  const postAttempts = options.attempts.filter((attempt) => attempt.phase === "post");
  if (preAttempts.length === 0 || postAttempts.length === 0) {
    return null;
  }

  const preWall = preAttempts.map((a) => a.wallMs).filter((v) => Number.isFinite(v));
  const postWall = postAttempts.map((a) => a.wallMs).filter((v) => Number.isFinite(v));
  const preIn = preAttempts
    .map((a) => a.tokenUsage?.inputTokens ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const postIn = postAttempts
    .map((a) => a.tokenUsage?.inputTokens ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const preOut = preAttempts
    .map((a) => a.tokenUsage?.outputTokens ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const postOut = postAttempts
    .map((a) => a.tokenUsage?.outputTokens ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const preShell = preAttempts
    .map((a) => (typeof a.shellCommands === "number" && Number.isFinite(a.shellCommands) ? a.shellCommands : null))
    .filter((v): v is number => typeof v === "number");
  const postShell = postAttempts
    .map((a) => (typeof a.shellCommands === "number" && Number.isFinite(a.shellCommands) ? a.shellCommands : null))
    .filter((v): v is number => typeof v === "number");

  const preBlocks = unionBlocks(preAttempts);
  const postBlocks = unionBlocks(postAttempts);
  const newBlocks = postBlocks.filter((block) => !preBlocks.includes(block));

  const preSnapshot = snapshotSummary(preAttempts[preAttempts.length - 1]?.routingSnapshot ?? null);
  const postSnapshot = snapshotSummary(postAttempts[0]?.routingSnapshot ?? null);
  const quality = await inspectBlocks(page, options.projectId, unionBlocks(options.attempts));
  const aiQuality = await evaluateLearnedBlocksWithAi(page, {
    projectId: options.projectId,
    benchKey: options.benchDir.split("/").pop() ?? options.benchDir,
    benchDir: options.benchDir,
    attempts: options.attempts,
  }).catch(() => null);

  const lines: string[] = [];
  lines.push("# Diagnostics");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Phase Stats");
  lines.push("");
  lines.push(`Pre: mean wall ${formatMs(mean(preWall))} ±${formatMs(stdev(preWall))}, mean in ${formatTokenCompact(mean(preIn))}, mean out ${formatTokenCompact(mean(preOut))}`);
  lines.push(
    `Post: mean wall ${formatMs(mean(postWall))} ±${formatMs(stdev(postWall))}, mean in ${formatTokenCompact(mean(postIn))}, mean out ${formatTokenCompact(mean(postOut))}`,
  );
  lines.push("");
  lines.push("## Learned Blocks");
  lines.push("");
  lines.push(`Pre union: ${preBlocks.length}`);
  lines.push(`Post union: ${postBlocks.length}`);
  lines.push(`New in post: ${newBlocks.length}`);
  if (newBlocks.length > 0) {
    lines.push("");
    lines.push("New blocks:");
    for (const block of newBlocks.slice(0, 25)) {
      lines.push(`- ${block}`);
    }
    if (newBlocks.length > 25) {
      lines.push(`- ... (${newBlocks.length - 25} more)`);
    }
  }
  lines.push("");
  lines.push("## Router Snapshot (last pre vs first post)");
  lines.push("");
  lines.push(`INSTAFY.md bytes: ${formatDiff(preSnapshot.instafyMdBytes, postSnapshot.instafyMdBytes)}`);
  lines.push(`learned index bytes: ${formatDiff(preSnapshot.learnedIndexBytes, postSnapshot.learnedIndexBytes)}`);
  lines.push(`learned usage bytes: ${formatDiff(preSnapshot.learnedUsageBytes, postSnapshot.learnedUsageBytes)}`);
  lines.push(`learned block count: ${formatDiff(preSnapshot.learnedBlockCount, postSnapshot.learnedBlockCount)}`);
  lines.push(`learned block bytes: ${formatDiff(preSnapshot.learnedBlockTotalBytes, postSnapshot.learnedBlockTotalBytes)}`);
  lines.push("");
  lines.push("## Regression Signals");
  lines.push("");
  for (const flag of regressionFlags({
    preWallMean: mean(preWall),
    postWallMean: mean(postWall),
    preInputMean: mean(preIn),
    postInputMean: mean(postIn),
    preShellMean: mean(preShell),
    postShellMean: mean(postShell),
    postWallMax: max(postWall),
    postAttempts,
  })) {
    lines.push(`- ${flag}`);
  }
  lines.push("");
  lines.push("## AI Learned Block Evaluation");
  lines.push("");
  if (!aiQuality) {
    lines.push("- AI evaluator failed before producing an artifact.");
  } else if (aiQuality.skippedReason) {
    lines.push(`- Skipped: ${aiQuality.skippedReason}`);
  } else {
    lines.push(`- Mean quality: ${aiQuality.aggregate.meanQuality === null ? "-" : Math.round(aiQuality.aggregate.meanQuality)}`);
    lines.push(
      `- Quality bands: ${
        Object.entries(aiQuality.aggregate.qualityBands ?? {})
          .map(([band, count]) => `${band}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- Impact counts: ${
        Object.entries((aiQuality.aggregate as any).impactCounts ?? {})
          .map(([impact, count]) => `${impact}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(`- Replay-memory count: ${aiQuality.aggregate.replayMemoryCount}`);
    lines.push(`- Rewrite-needed count: ${aiQuality.aggregate.rewriteNeededCount}`);
    lines.push(`- Aggregate flags: ${aiQuality.aggregate.qualityFlags.join(", ") || "-"}`);
    lines.push("");
    for (const evaluation of aiQuality.evaluations) {
      const flags = evaluation.qualityFlags.join(", ") || "ok";
      const impactFlags = (evaluation as any).impactFlags?.join(", ") || "ok";
      const issues = evaluation.issues.join("; ") || "-";
      const strengths = evaluation.strengths.join("; ") || "-";
      lines.push(
        `- ${evaluation.path}: quality=${evaluation.quality ?? "-"}, band=${(evaluation as any).qualityBand ?? "-"}, impact=${(evaluation as any).impact ?? "-"}, kind=${evaluation.kind}, rewrite=${
          evaluation.rewriteNeeded == null ? "-" : evaluation.rewriteNeeded ? "yes" : "no"
        }, flags=${flags}, impactFlags=${impactFlags}, issues=${issues}, strengths=${strengths}, summary=${(evaluation as any).impactSummary ?? evaluation.summary ?? evaluation.error ?? "-"}`,
      );
    }
  }
  lines.push("");
  lines.push("## Static Learned Block Guardrails");
  lines.push("");
  lines.push("- These checks are cheap structural guardrails only. Treat the AI evaluation above as the primary semantic quality signal.");
  if (quality.length === 0) {
    lines.push("- No learned blocks were loaded in these attempts.");
  } else {
    for (const block of quality) {
      const flags = block.flags.length ? block.flags.join(", ") : "ok";
      lines.push(`- ${block.path}: size=${block.sizeBytes ?? "-"} bytes, bullets=${block.bulletCount}, flags=${flags}`);
    }
  }
  lines.push("");
  lines.push("## Attempts");
  lines.push("");
  lines.push("| Phase | Attempt | OK | Wall | In | Out | MCP | Shell | Blocks | Example read cmds |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const attempt of options.attempts) {
    const inTok = attempt.tokenUsage?.inputTokens ?? null;
    const outTok = attempt.tokenUsage?.outputTokens ?? null;
    const mcpToolCalls = typeof attempt.mcpToolCalls === "number" && Number.isFinite(attempt.mcpToolCalls) ? attempt.mcpToolCalls : 0;
    const shellCommands = typeof attempt.shellCommands === "number" && Number.isFinite(attempt.shellCommands) ? attempt.shellCommands : 0;
    const blocks = Array.isArray(attempt.learnedBlockReads) ? attempt.learnedBlockReads.length : 0;
    const cmds = Array.isArray(attempt.learnedBlockReadCommands) ? attempt.learnedBlockReadCommands.slice(0, 2).join(" · ") : "";
    lines.push(
      `| ${attempt.phase ?? "-"} | ${attempt.attempt} | ${attempt.success ? "OK" : "FAIL"} | ${formatMs(attempt.wallMs)} | ${formatTokenCompact(
        inTok,
      )} | ${formatTokenCompact(outTok)} | ${mcpToolCalls} | ${shellCommands} | ${blocks} | ${cmds.replace(/\|/g, " ")} |`,
    );
  }
  lines.push("");

  await writeWorkspaceFile(page, `${options.benchDir}/diagnostics.md`, lines.join("\n"), {
    createDirectories: true,
    projectId: options.projectId,
  }).catch(() => {});

  return aiQuality;
}
