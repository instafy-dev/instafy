import type { Page } from "@playwright/test";
import { readWorkspaceFileText, writeWorkspaceFile } from "../utils/harness.js";
import type { TokenUsage } from "./benchLearnUtils.js";

export type LearnBenchAttempt = {
  attempt: number;
  phase?: "pre" | "post";
  wallMs: number;
  success: boolean;
  failureKind?: string | null;
  assistantTurns: number;
  conversationControllerId?: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
  shellCommandSummaries?: string[];
  searchFieldCue?: string | null;
  submitControlCue?: string | null;
  resultEntryCue?: string | null;
  pageAdvanceCue?: string | null;
  readbackLabelCue?: string | null;
  learnedBlockReads?: string[];
  learnedBlockReadCommands?: string[];
  learnRouterBlocks?: Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }>;
};

type PhaseAttempt = LearnBenchAttempt;

type PhaseStats = {
  count: number;
  successCount: number;
  wallMsMean: number | null;
  wallMsStdev: number | null;
  inputTokensMean: number | null;
  inputTokensStdev: number | null;
  outputTokensMean: number | null;
  outputTokensStdev: number | null;
  cachedInputTokensMean: number | null;
  model: string | null;
};

type BenchSummaryEntryV1 = {
  benchKey: string;
  benchDir: string;
  updatedAt: string;
  before: {
    success: boolean;
    failureKind?: string | null;
    wallMs: number;
    assistantTurns: number;
    tokenUsage: TokenUsage | null;
    mcpToolCalls: number;
    shellCommands: number;
  };
  after: {
    success: boolean;
    failureKind?: string | null;
    wallMs: number;
    assistantTurns: number;
    tokenUsage: TokenUsage | null;
    mcpToolCalls: number;
    shellCommands: number;
  };
};

type BenchSummaryEntry = {
  benchKey: string;
  benchDir: string;
  updatedAt: string;
  requestedModelHint?: string | null;
  pre: {
    attempts: PhaseAttempt[];
    stats: PhaseStats;
  };
  post: {
    attempts: PhaseAttempt[];
    stats: PhaseStats;
  };
};

type BenchSummaryFileV1 = {
  version: 1;
  generatedAt: string;
  entries: Record<string, BenchSummaryEntryV1>;
};

type BenchSummaryFile = {
  version: 2;
  generatedAt: string;
  entries: Record<string, BenchSummaryEntry>;
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const sign = ms < 0 ? "-" : "";
  const absMs = Math.abs(ms);
  if (absMs < 1000) return `${sign}${Math.round(absMs)}ms`;
  const seconds = Math.round(absMs / 1000);
  if (seconds < 60) return `${sign}${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${sign}${minutes}m ${rem}s`;
}

function formatTokenCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const rounded = Math.round(value / 100) / 10; // 1 decimal k
    return `${rounded}k`;
  }
  return `${Math.round(value)}`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mu = mean(values);
  if (mu === null) return null;
  const variance = values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mostCommonModel(attempts: PhaseAttempt[]): string | null {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    const model = attempt.tokenUsage?.model ?? null;
    if (!model) continue;
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of counts.entries()) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

function buildPhaseStats(attempts: PhaseAttempt[]): PhaseStats {
  const count = attempts.length;
  const successCount = attempts.filter((attempt) => attempt.success).length;
  const wallValues = attempts.map((attempt) => attempt.wallMs).filter((v) => Number.isFinite(v));
  const inputValues = attempts
    .map((attempt) => attempt.tokenUsage?.inputTokens ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const cachedValues = attempts
    .map((attempt) => attempt.tokenUsage?.cachedInputTokens ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const outputValues = attempts
    .map((attempt) => attempt.tokenUsage?.outputTokens ?? null)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  return {
    count,
    successCount,
    wallMsMean: mean(wallValues),
    wallMsStdev: stdev(wallValues),
    inputTokensMean: mean(inputValues),
    inputTokensStdev: stdev(inputValues),
    outputTokensMean: mean(outputValues),
    outputTokensStdev: stdev(outputValues),
    cachedInputTokensMean: mean(cachedValues),
    model: mostCommonModel(attempts),
  };
}

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function formatPhaseSummary(phase: { attempts: PhaseAttempt[]; stats: PhaseStats }): string {
  const ok = `${phase.stats.successCount}/${phase.stats.count}`;
  const wall = phase.stats.wallMsMean === null ? "-" : formatMs(phase.stats.wallMsMean);
  const wallSigma = phase.stats.wallMsStdev === null ? "" : `±${formatMs(phase.stats.wallMsStdev)}`;
  const input = formatTokenCompact(phase.stats.inputTokensMean);
  const inputSigma = phase.stats.inputTokensStdev === null ? "" : `±${formatTokenCompact(phase.stats.inputTokensStdev)}`;
  const output = formatTokenCompact(phase.stats.outputTokensMean);
  const outputSigma = phase.stats.outputTokensStdev === null ? "" : `±${formatTokenCompact(phase.stats.outputTokensStdev)}`;
  const cached = formatTokenCompact(phase.stats.cachedInputTokensMean);
  return `OK(${ok}) · ${wall}${wallSigma} · in ${input}${inputSigma} cached ${cached} out ${output}${outputSigma}`;
}

function buildMarkdown(summary: BenchSummaryFile): string {
  const keys = Object.keys(summary.entries).sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  lines.push("# /learn bench summary");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push("");
  lines.push("| Bench | Pre | Post | Δ wall(mean) | Δ in(mean) | Δ out(mean) | Model | Requested model |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const key of keys) {
    const entry = summary.entries[key]!;

    const pre = formatPhaseSummary(entry.pre);
    const post = formatPhaseSummary(entry.post);

    const deltaWall =
      entry.pre.stats.wallMsMean !== null && entry.post.stats.wallMsMean !== null
        ? entry.post.stats.wallMsMean - entry.pre.stats.wallMsMean
        : null;
    const deltaIn =
      entry.pre.stats.inputTokensMean !== null && entry.post.stats.inputTokensMean !== null
        ? entry.post.stats.inputTokensMean - entry.pre.stats.inputTokensMean
        : null;
    const deltaOut =
      entry.pre.stats.outputTokensMean !== null && entry.post.stats.outputTokensMean !== null
        ? entry.post.stats.outputTokensMean - entry.pre.stats.outputTokensMean
        : null;

    lines.push(
      `| ${entry.benchKey} | ${pre} | ${post} | ${deltaWall === null ? "-" : formatMs(deltaWall)} | ${
        deltaIn === null ? "-" : Math.round(deltaIn)
      } | ${deltaOut === null ? "-" : Math.round(deltaOut)} | ${entry.post.stats.model ?? entry.pre.stats.model ?? "-"} | ${
        entry.requestedModelHint ?? "-"
      } |`,
    );
  }
  lines.push("");
  lines.push("Notes:");
  lines.push("- Token values are means across attempts in each phase. `cached` shows mean cached-input tokens.");
  lines.push("- Variance is shown as `mean±stdev` (wall time + input/output tokens when available).");
  lines.push("- Deltas compare post mean vs pre mean for wall time and input/output tokens.");
  return lines.join("\n");
}

export async function updateLearnBenchSummary(
  page: Page,
  options: {
    projectId: string;
    benchKey: string;
    benchDir: string;
    attempts: LearnBenchAttempt[];
    requestedModelHint?: string | null;
  },
): Promise<void> {
  if (options.attempts.length === 0) {
    return;
  }

  const jsonPath = "bench/learn-summary.json";
  const mdPath = "bench/learn-summary.md";
  const existingRaw = await readWorkspaceFileText(page, jsonPath, { projectId: options.projectId }).catch(() => null);
  const parsedV2 = safeParseJson<BenchSummaryFile>(existingRaw);
  const parsedV1 = safeParseJson<BenchSummaryFileV1>(existingRaw);

  const summary: BenchSummaryFile = parsedV2 && typeof parsedV2 === "object" && parsedV2.version === 2 && parsedV2.entries
    ? parsedV2
    : parsedV1 && typeof parsedV1 === "object" && parsedV1.version === 1 && parsedV1.entries
      ? {
          version: 2,
          generatedAt: parsedV1.generatedAt,
          entries: Object.fromEntries(
            Object.entries(parsedV1.entries).map(([key, entry]) => {
              const preAttempt: PhaseAttempt = {
                attempt: 1,
                wallMs: entry.before.wallMs,
                success: entry.before.success,
                failureKind: entry.before.failureKind ?? null,
                assistantTurns: entry.before.assistantTurns,
                tokenUsage: entry.before.tokenUsage,
                mcpToolCalls: entry.before.mcpToolCalls,
                shellCommands: entry.before.shellCommands,
              };
              const postAttempt: PhaseAttempt = {
                attempt: 2,
                wallMs: entry.after.wallMs,
                success: entry.after.success,
                failureKind: entry.after.failureKind ?? null,
                assistantTurns: entry.after.assistantTurns,
                tokenUsage: entry.after.tokenUsage,
                mcpToolCalls: entry.after.mcpToolCalls,
                shellCommands: entry.after.shellCommands,
              };
              const preAttempts = [preAttempt];
              const postAttempts = [postAttempt];
              const next: BenchSummaryEntry = {
                benchKey: entry.benchKey,
                benchDir: entry.benchDir,
                updatedAt: entry.updatedAt,
                requestedModelHint: null,
                pre: {
                  attempts: preAttempts,
                  stats: buildPhaseStats(preAttempts),
                },
                post: {
                  attempts: postAttempts,
                  stats: buildPhaseStats(postAttempts),
                },
              };
              return [key, next];
            }),
          ),
        }
      : { version: 2, generatedAt: new Date().toISOString(), entries: {} };

  const updatedAt = new Date().toISOString();
  summary.generatedAt = updatedAt;

  const preAttempts = options.attempts.filter((attempt) => attempt.phase === "pre");
  const postAttempts = options.attempts.filter((attempt) => attempt.phase === "post");
  const fallbackPre = [options.attempts[0]!];
  const fallbackPost = [options.attempts[options.attempts.length - 1]!];
  const pre = preAttempts.length > 0 ? preAttempts : fallbackPre;
  const post = postAttempts.length > 0 ? postAttempts : fallbackPost;

  summary.entries[options.benchKey] = {
    benchKey: options.benchKey,
    benchDir: options.benchDir,
    updatedAt,
    requestedModelHint: options.requestedModelHint?.trim() || null,
    pre: {
      attempts: pre,
      stats: buildPhaseStats(pre),
    },
    post: {
      attempts: post,
      stats: buildPhaseStats(post),
    },
  };

  await writeWorkspaceFile(page, jsonPath, JSON.stringify(summary, null, 2), {
    createDirectories: true,
    projectId: options.projectId,
  }).catch(() => {});

  await writeWorkspaceFile(page, mdPath, buildMarkdown(summary), {
    createDirectories: true,
    projectId: options.projectId,
  }).catch(() => {});
}
