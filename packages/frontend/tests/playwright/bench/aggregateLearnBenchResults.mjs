import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../..");
const workspacesRoot = path.join(repoRoot, "tmp/origin-gateway-workspaces");
const outputDir = path.join(repoRoot, "tmp/bench-rollup");
const RECENT_WINDOW_SIZE = Number.parseInt(process.env.PLAYWRIGHT_BENCH_RECENT_WINDOW ?? "5", 10) || 5;

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function formatNum(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value)}`;
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function normalizeModelHint(entry) {
  const requested =
    typeof entry?.requestedModelHint === "string" && entry.requestedModelHint.trim().length > 0
      ? entry.requestedModelHint.trim()
      : null;
  if (requested) return requested;
  const post = typeof entry?.post?.stats?.model === "string" && entry.post.stats.model.trim().length > 0 ? entry.post.stats.model.trim() : null;
  if (post) return post;
  const pre = typeof entry?.pre?.stats?.model === "string" && entry.pre.stats.model.trim().length > 0 ? entry.pre.stats.model.trim() : null;
  return pre;
}

function unique(values) {
  return [...new Set(values)];
}

function countBy(records, keyFn) {
  return Object.fromEntries(
    unique(records.flatMap((record) => keyFn(record)))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, records.filter((record) => keyFn(record).includes(key)).length]),
  );
}

function sumBy(records, keyFn) {
  return Object.fromEntries(
    unique(records.flatMap((record) => Object.keys(keyFn(record) ?? {})))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [
        key,
        records.reduce((total, record) => total + (keyFn(record)?.[key] ?? 0), 0),
      ]),
  );
}

function extractShellMean(phase) {
  const values = (phase?.attempts ?? [])
    .map((attempt) => (typeof attempt.shellCommands === "number" ? attempt.shellCommands : null))
    .filter((value) => typeof value === "number");
  return mean(values);
}

function extractSuccessRate(phase) {
  const count = phase?.stats?.count ?? 0;
  const successCount = phase?.stats?.successCount ?? 0;
  if (!count) return null;
  return successCount / count;
}

function listRegressionFlags(entry) {
  const flags = [];
  const preWall = entry.pre?.stats?.wallMsMean ?? null;
  const postWall = entry.post?.stats?.wallMsMean ?? null;
  const preIn = entry.pre?.stats?.inputTokensMean ?? null;
  const postIn = entry.post?.stats?.inputTokensMean ?? null;
  const preShell = extractShellMean(entry.pre);
  const postShell = extractShellMean(entry.post);
  const repeatedShellLoop = [...(entry?.post?.attempts ?? [])].some((attempt) => {
    const summaries = Array.isArray(attempt?.shellCommandSummaries) ? attempt.shellCommandSummaries : [];
    if (summaries.length < 3) return false;
    const normalized = summaries.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
    if (normalized.length < 3) return false;
    return new Set(normalized).size === 1;
  });

  const wall = !!(preWall && postWall && postWall > preWall * 1.2);
  const input = !!(preIn && postIn && postIn > preIn * 1.2);
  const shell = !!(preShell != null && postShell != null && postShell > preShell + 1);

  if (wall && !input && !shell) flags.push("wall_low_confidence");
  else if (wall) flags.push("wall");
  if (input) flags.push("input");
  if (shell) flags.push("shell");
  if (repeatedShellLoop) flags.push("repeat_shell");
  return flags;
}

function staticGuardrailFlagsForText(text) {
  const flags = [];
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
    !/(^|\n)\s*[-*]\s*Stop\/verify\s*:/i.test(text) &&
    !/(^|\n)\s*[-*]\s*Stop condition\s*:/i.test(text) &&
    !/(^|\n)\s*[-*]\s*Stop when\s*:/i.test(text)
  ) {
    flags.push("missing_verify_section");
  }

  return { flags, sizeBytes, bulletCount };
}

function extractLoadedBlockPaths(entry) {
  const attempts = [...(entry?.pre?.attempts ?? []), ...(entry?.post?.attempts ?? [])];
  const paths = [];
  for (const attempt of attempts) {
    for (const blockPath of attempt?.learnedBlockReads ?? []) {
      if (typeof blockPath === "string" && blockPath.trim()) {
        paths.push(blockPath.trim());
      }
    }
  }
  return unique(paths).sort((a, b) => a.localeCompare(b));
}

async function inspectLearnedBlocksForRecord(workspaceId, entry) {
  const blockPaths = extractLoadedBlockPaths(entry);
  const workspaceRoot = path.join(workspacesRoot, workspaceId);
  const blockReports = [];

  for (const relPath of blockPaths) {
    const fullPath = path.join(workspaceRoot, relPath);
    try {
      const text = await fs.readFile(fullPath, "utf8");
      const quality = staticGuardrailFlagsForText(text);
      blockReports.push({
        path: relPath,
        sizeBytes: quality.sizeBytes,
        bulletCount: quality.bulletCount,
        flags: quality.flags,
      });
    } catch {
      blockReports.push({
        path: relPath,
        sizeBytes: null,
        bulletCount: 0,
        flags: ["missing_block"],
      });
    }
  }

  return {
    loadedBlockPaths: blockPaths,
    blockReports,
    qualityFlags: unique(blockReports.flatMap((report) => report.flags)).sort((a, b) => a.localeCompare(b)),
  };
}

async function readAiQualityForRecord(workspaceId, entry) {
  const benchDir = typeof entry?.benchDir === "string" ? entry.benchDir.trim() : "";
  if (!benchDir) return null;
  const artifactPath = path.join(workspacesRoot, workspaceId, benchDir, "ai-quality.json");
  try {
    const raw = await fs.readFile(artifactPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function findLearnSummaries(root) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceId = entry.name;
    const summaryPath = path.join(root, workspaceId, "bench/learn-summary.json");
    try {
      await fs.access(summaryPath);
      out.push({ workspaceId, summaryPath });
    } catch {
      // ignore
    }
  }
  return out;
}

async function findLoopSeriesRuns(root) {
  const out = [];
  let workspaceEntries = [];
  try {
    workspaceEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory()) continue;
    const workspaceId = workspaceEntry.name;
    const benchRoot = path.join(root, workspaceId, "bench");
    let benchEntries = [];
    try {
      benchEntries = await fs.readdir(benchRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const benchEntry of benchEntries) {
      if (!benchEntry.isDirectory() || !benchEntry.name.endsWith("-loops")) continue;
      const benchDir = path.join(benchRoot, benchEntry.name);
      let fileEntries = [];
      try {
        fileEntries = await fs.readdir(benchDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const loopFiles = fileEntries
        .filter((fileEntry) => fileEntry.isFile() && /^loop-\d+\.json$/i.test(fileEntry.name))
        .map((fileEntry) => path.join(benchDir, fileEntry.name));

      if (!loopFiles.length) continue;
      out.push({
        workspaceId,
        benchKey: benchEntry.name,
        benchDir: path.relative(path.join(root, workspaceId), benchDir),
        loopFiles: loopFiles.sort((a, b) => a.localeCompare(b)),
      });
    }
  }

  return out;
}

function buildMarkdown(aggregates) {
  const lines = [];
  lines.push("# Learn Bench Rollup");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Recent window: last ${RECENT_WINDOW_SIZE} completed loops per bench.`);
  lines.push("");
  lines.push("| Bench | Runs | Latest | Latest loop | Recent Δ wall | Recent Δ in | Recent regressions | Latest AI | Recent AI | Latest workspace |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const aggregate of aggregates) {
    const latestLoopFlags = aggregate.latestLoop.regressionFlags.length
      ? aggregate.latestLoop.regressionFlags.join(",")
      : "ok";
    const latestAiFlags = Object.entries(aggregate.latestLoop.aiQualityFlagCounts ?? {})
      .map(([flag, count]) => `${flag}:${count}`)
      .join(" ");
    const latestAiBands = Object.entries(aggregate.latestLoop.aiQualityBandCounts ?? {})
      .map(([band, count]) => `${band}:${count}`)
      .join(" ");
    const latestAiImpactCounts = Object.entries(aggregate.latestLoop.aiImpactCounts ?? {})
      .map(([impact, count]) => `${impact}:${count}`)
      .join(" ");
    const recentQualitySummary = Object.entries(aggregate.recent.aiQualityFlagCounts ?? {})
      .map(([flag, count]) => `${flag}:${count}`)
      .join(" ");
    const recentQualityBands = Object.entries(aggregate.recent.aiQualityBandCounts ?? {})
      .map(([band, count]) => `${band}:${count}`)
      .join(" ");
    const recentImpactCounts = Object.entries(aggregate.recent.aiImpactCounts ?? {})
      .map(([impact, count]) => `${impact}:${count}`)
      .join(" ");
    lines.push(
      `| ${aggregate.benchKey} | ${aggregate.runCount} | ${aggregate.latestUpdatedAt ?? "-"} | ${formatMs(
        aggregate.latestLoop.deltaWall,
      )} / ${formatNum(aggregate.latestLoop.deltaInput)} / ${latestLoopFlags} | ${formatMs(
        aggregate.recent.deltaWallMedian,
      )} | ${formatNum(aggregate.recent.deltaInputMedian)} | wall:${aggregate.recent.wallRegressions} in:${aggregate.recent.inputRegressions} shell:${aggregate.recent.shellRegressions} repeat:${aggregate.recent.repeatShellRegressions} | ${
        aggregate.latestLoop.aiQualityMean == null ? "-" : Math.round(aggregate.latestLoop.aiQualityMean)
      } (${latestAiBands || "-"}) / ${latestAiImpactCounts || "-"} / ${latestAiFlags || "-"} | ${
        aggregate.recent.aiQualityMeanMedian == null ? "-" : Math.round(aggregate.recent.aiQualityMeanMedian)
      } (${recentQualityBands || "-"}) / ${recentImpactCounts || "-"} / ${recentQualitySummary || "-"} | ${aggregate.latestWorkspaceId ?? "-"} |`,
    );
  }
  lines.push("");
  for (const aggregate of aggregates) {
    lines.push(`## ${aggregate.benchKey}`);
    lines.push("");
    lines.push(`- Runs: ${aggregate.runCount}`);
    lines.push(`- Latest workspace: ${aggregate.latestWorkspaceId ?? "-"}`);
    lines.push(`- Latest updated: ${aggregate.latestUpdatedAt ?? "-"}`);
    lines.push(`- Latest loop delta wall: ${formatMs(aggregate.latestLoop.deltaWall)}`);
    lines.push(`- Latest loop delta input tokens: ${formatNum(aggregate.latestLoop.deltaInput)}`);
    lines.push(`- Latest loop regressions: ${aggregate.latestLoop.regressionFlags.join(", ") || "-"}`);
    lines.push(`- All-time median delta wall: ${formatMs(aggregate.deltaWallMedian)}`);
    lines.push(`- Recent median delta wall (last ${aggregate.recent.runCount}): ${formatMs(aggregate.recent.deltaWallMedian)}`);
    lines.push(`- All-time median delta input tokens: ${formatNum(aggregate.deltaInputMedian)}`);
    lines.push(`- Recent median delta input tokens (last ${aggregate.recent.runCount}): ${formatNum(aggregate.recent.deltaInputMedian)}`);
    lines.push(`- All-time median delta output tokens: ${formatNum(aggregate.deltaOutputMedian)}`);
    lines.push(`- Recent median delta output tokens (last ${aggregate.recent.runCount}): ${formatNum(aggregate.recent.deltaOutputMedian)}`);
    lines.push(
      `- All-time regressions: wall=${aggregate.wallRegressions}, input=${aggregate.inputRegressions}, shell=${aggregate.shellRegressions}, repeat_shell=${aggregate.repeatShellRegressions}`,
    );
    lines.push(
      `- Recent regressions (last ${aggregate.recent.runCount}): wall=${aggregate.recent.wallRegressions}, input=${aggregate.recent.inputRegressions}, shell=${aggregate.recent.shellRegressions}, repeat_shell=${aggregate.recent.repeatShellRegressions}`,
    );
    lines.push(`- All-time AI mean quality (median): ${aggregate.aiQualityMeanMedian == null ? "-" : Math.round(aggregate.aiQualityMeanMedian)}`);
    lines.push(`- Recent AI mean quality (median): ${aggregate.recent.aiQualityMeanMedian == null ? "-" : Math.round(aggregate.recent.aiQualityMeanMedian)}`);
    lines.push(`- Latest loop AI mean quality: ${aggregate.latestLoop.aiQualityMean == null ? "-" : Math.round(aggregate.latestLoop.aiQualityMean)}`);
    lines.push(
      `- All-time AI quality bands: ${
        Object.entries(aggregate.aiQualityBandCounts ?? {})
          .map(([band, count]) => `${band}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- Recent AI quality bands: ${
        Object.entries(aggregate.recent.aiQualityBandCounts ?? {})
          .map(([band, count]) => `${band}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- All-time AI impact counts: ${
        Object.entries(aggregate.aiImpactCounts ?? {})
          .map(([impact, count]) => `${impact}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- Recent AI impact counts: ${
        Object.entries(aggregate.recent.aiImpactCounts ?? {})
          .map(([impact, count]) => `${impact}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(`- AI replay-memory loops: ${aggregate.aiReplayMemoryLoops}`);
    lines.push(`- AI rewrite-needed loops: ${aggregate.aiRewriteNeededLoops}`);
    lines.push(
      `- All-time AI quality flags: ${
        Object.entries(aggregate.aiQualityFlagCounts ?? {})
          .map(([flag, count]) => `${flag}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- Recent AI quality flags: ${
        Object.entries(aggregate.recent.aiQualityFlagCounts ?? {})
          .map(([flag, count]) => `${flag}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- Latest loop AI quality flags: ${
        Object.entries(aggregate.latestLoop.aiQualityFlagCounts ?? {})
          .map(([flag, count]) => `${flag}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- All-time static guardrails: ${
        Object.entries(aggregate.qualityFlagCounts ?? {})
          .map(([flag, count]) => `${flag}=${count}`)
          .join(", ") || "-"
      }`,
    );
    lines.push(
      `- Recent static guardrails: ${
        Object.entries(aggregate.recent.qualityFlagCounts ?? {})
          .map(([flag, count]) => `${flag}=${count}`)
          .join(", ") || "-"
      }`,
    );
    if (aggregate.latestEntry) {
      lines.push(`- Latest pre: ${formatMs(aggregate.latestEntry.pre?.stats?.wallMsMean ?? null)} / in ${formatNum(aggregate.latestEntry.pre?.stats?.inputTokensMean ?? null)}`);
      lines.push(`- Latest post: ${formatMs(aggregate.latestEntry.post?.stats?.wallMsMean ?? null)} / in ${formatNum(aggregate.latestEntry.post?.stats?.inputTokensMean ?? null)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildLineageMarkdown(aggregates) {
  const lines = [];
  lines.push("# Learn Bench Lineage");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Each row is one completed learn loop for a benchmark family, ordered oldest to newest.");
  lines.push("");

  for (const aggregate of aggregates) {
    lines.push(`## ${aggregate.benchKey}`);
    lines.push("");
    lines.push("| Loop | Updated | Workspace | Pre success | Post success | Pre wall | Post wall | Δ wall | Pre in | Post in | Δ in | Pre shell | Post shell | Flags | AI quality | AI band | AI impact | AI flags |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const record of aggregate.lineage) {
      const preWall = record.entry?.pre?.stats?.wallMsMean ?? null;
      const postWall = record.entry?.post?.stats?.wallMsMean ?? null;
      const preIn = record.entry?.pre?.stats?.inputTokensMean ?? null;
      const postIn = record.entry?.post?.stats?.inputTokensMean ?? null;
      const preShell = extractShellMean(record.entry?.pre ?? null);
      const postShell = extractShellMean(record.entry?.post ?? null);
      const flags = record.regressionFlags.length ? record.regressionFlags.join(",") : "-";
      const quality = record.aiQualityMean == null ? "-" : Math.round(record.aiQualityMean);
      const qualityBand = record.aiQualityBandCounts && Object.keys(record.aiQualityBandCounts).length
        ? Object.entries(record.aiQualityBandCounts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
        : "-";
      const impactBand = record.aiImpactCounts && Object.keys(record.aiImpactCounts).length
        ? Object.entries(record.aiImpactCounts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
        : "-";
      const aiFlags = record.aiQualityFlags.length ? record.aiQualityFlags.join(",") : "-";
      lines.push(
        `| ${record.loopIndex} | ${record.updatedAt ?? "-"} | ${record.workspaceId} | ${formatPercent(
          extractSuccessRate(record.entry?.pre ?? null),
        )} | ${formatPercent(extractSuccessRate(record.entry?.post ?? null))} | ${formatMs(preWall)} | ${formatMs(
          postWall,
        )} | ${formatMs(record.deltaWall)} | ${formatNum(preIn)} | ${formatNum(postIn)} | ${formatNum(
          record.deltaInput,
        )} | ${formatNum(preShell)} | ${formatNum(postShell)} | ${flags} | ${quality} | ${qualityBand} | ${impactBand} | ${aiFlags} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildLoopSeriesMarkdown(aggregates) {
  const lines = [];
  lines.push("# Learn Bench Loop Series");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Each row is one learn loop inside the same project/workspace.");
  lines.push("");

  for (const aggregate of aggregates) {
    lines.push(`## ${aggregate.benchKey}`);
    lines.push("");
    lines.push(`- Workspaces: ${aggregate.runCount}`);
    lines.push(`- Median per-loop Δ wall: ${formatMs(aggregate.deltaWallMedian)}`);
    lines.push(`- Median per-loop Δ input: ${formatNum(aggregate.deltaInputMedian)}`);
    lines.push(`- Median per-loop Δ shell: ${formatNum(aggregate.deltaShellMedian)}`);
    lines.push("");
    for (const workspace of aggregate.workspaces) {
      lines.push(`### ${workspace.workspaceId}`);
      lines.push("");
      lines.push("| Loop | Pre | Post | Δ wall | Δ input | Δ shell | Learn signal |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- |");
      for (const loop of workspace.loops) {
        lines.push(
          `| ${loop.loopIndex} | ${loop.pre.success ? "OK" : `FAIL (${loop.pre.failureKind ?? "-"})`} ${formatMs(loop.pre.wallMs)} | ${
            loop.post.success ? "OK" : `FAIL (${loop.post.failureKind ?? "-"})`
          } ${formatMs(loop.post.wallMs)} | ${formatMs(loop.deltaWallMs)} | ${formatNum(
            loop.deltaInputTokens,
          )} | ${formatNum(loop.deltaShellCommands)} | ${(loop.learn?.signal ?? "-").replace(/\|/g, " ")} |`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function main() {
  const summaries = await findLearnSummaries(workspacesRoot);
  const loopSeriesRuns = await findLoopSeriesRuns(workspacesRoot);
  const grouped = new Map();

  for (const { workspaceId, summaryPath } of summaries) {
    const raw = await fs.readFile(summaryPath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = parsed?.entries ?? {};
    for (const [benchKey, entry] of Object.entries(entries)) {
      const preWall = entry?.pre?.stats?.wallMsMean ?? null;
      const postWall = entry?.post?.stats?.wallMsMean ?? null;
      const preIn = entry?.pre?.stats?.inputTokensMean ?? null;
      const postIn = entry?.post?.stats?.inputTokensMean ?? null;
      const preOut = entry?.pre?.stats?.outputTokensMean ?? null;
      const postOut = entry?.post?.stats?.outputTokensMean ?? null;
      const deltaWall = preWall != null && postWall != null ? postWall - preWall : null;
      const deltaInput = preIn != null && postIn != null ? postIn - preIn : null;
      const deltaOutput = preOut != null && postOut != null ? postOut - preOut : null;
      const quality = await inspectLearnedBlocksForRecord(workspaceId, entry);
      const aiQuality = await readAiQualityForRecord(workspaceId, entry);
      const record = {
        workspaceId,
        summaryPath,
        benchKey,
        updatedAt: entry?.updatedAt ?? parsed?.generatedAt ?? null,
        requestedModelHint: normalizeModelHint(entry),
        entry,
        deltaWall,
        deltaInput,
        deltaOutput,
        regressionFlags: listRegressionFlags(entry),
        qualityFlags: quality.qualityFlags,
        aiQualityFlags: Array.isArray(aiQuality?.aggregate?.qualityFlags)
          ? unique(
              aiQuality.aggregate.qualityFlags.filter((flag) => typeof flag === "string" && flag.trim().length > 0),
            ).sort((a, b) => a.localeCompare(b))
          : [],
        aiQualityBandCounts:
          aiQuality?.aggregate?.qualityBands && typeof aiQuality.aggregate.qualityBands === "object"
            ? Object.fromEntries(
                Object.entries(aiQuality.aggregate.qualityBands)
                  .filter(([band, count]) => typeof band === "string" && typeof count === "number" && Number.isFinite(count))
                  .map(([band, count]) => [band, count]),
              )
            : {},
        aiImpactCounts:
          aiQuality?.aggregate?.impactCounts && typeof aiQuality.aggregate.impactCounts === "object"
            ? Object.fromEntries(
                Object.entries(aiQuality.aggregate.impactCounts)
                  .filter(([impact, count]) => typeof impact === "string" && typeof count === "number" && Number.isFinite(count))
                  .map(([impact, count]) => [impact, count]),
              )
            : {},
        aiQualityMean:
          typeof aiQuality?.aggregate?.meanQuality === "number" && Number.isFinite(aiQuality.aggregate.meanQuality)
            ? aiQuality.aggregate.meanQuality
            : null,
        aiReplayMemoryCount:
          typeof aiQuality?.aggregate?.replayMemoryCount === "number" && Number.isFinite(aiQuality.aggregate.replayMemoryCount)
            ? aiQuality.aggregate.replayMemoryCount
            : 0,
        aiRewriteNeededCount:
          typeof aiQuality?.aggregate?.rewriteNeededCount === "number" && Number.isFinite(aiQuality.aggregate.rewriteNeededCount)
            ? aiQuality.aggregate.rewriteNeededCount
            : 0,
        loadedBlockPaths: quality.loadedBlockPaths,
        blockReports: quality.blockReports,
        aiEvaluations: Array.isArray(aiQuality?.evaluations) ? aiQuality.evaluations : [],
      };
      const bucket = grouped.get(benchKey) ?? [];
      bucket.push(record);
      grouped.set(benchKey, bucket);
    }
  }

  const aggregates = [...grouped.entries()]
    .map(([benchKey, records]) => {
      records.sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
      const deltaWalls = records.map((record) => record.deltaWall).filter((value) => value != null);
      const deltaInputs = records.map((record) => record.deltaInput).filter((value) => value != null);
      const deltaOutputs = records.map((record) => record.deltaOutput).filter((value) => value != null);
      const latest = records[records.length - 1] ?? null;
      const lineage = records.map((record, index) => ({
        ...record,
        loopIndex: index + 1,
      }));
      const recentRecords = records.slice(-Math.min(RECENT_WINDOW_SIZE, records.length));
      const latestRecord = records.at(-1) ?? null;
      return {
        benchKey,
        runCount: records.length,
        latestUpdatedAt: latest?.updatedAt ?? null,
        latestWorkspaceId: latest?.workspaceId ?? null,
        latestEntry: latest?.entry ?? null,
        deltaWallMedian: median(deltaWalls),
        deltaInputMedian: median(deltaInputs),
        deltaOutputMedian: median(deltaOutputs),
        wallRegressions: records.filter((record) => record.regressionFlags.includes("wall")).length,
        inputRegressions: records.filter((record) => record.regressionFlags.includes("input")).length,
        shellRegressions: records.filter((record) => record.regressionFlags.includes("shell")).length,
        repeatShellRegressions: records.filter((record) => record.regressionFlags.includes("repeat_shell")).length,
        qualityFlagCounts: Object.fromEntries(
          unique(records.flatMap((record) => record.qualityFlags))
            .sort((a, b) => a.localeCompare(b))
            .map((flag) => [flag, records.filter((record) => record.qualityFlags.includes(flag)).length]),
        ),
        aiQualityFlagCounts: Object.fromEntries(
          unique(records.flatMap((record) => record.aiQualityFlags))
            .sort((a, b) => a.localeCompare(b))
            .map((flag) => [flag, records.filter((record) => record.aiQualityFlags.includes(flag)).length]),
        ),
        aiQualityBandCounts: Object.fromEntries(
          unique(records.flatMap((record) => Object.keys(record.aiQualityBandCounts ?? {})))
            .sort((a, b) => a.localeCompare(b))
            .map((band) => [
              band,
              records.reduce((total, record) => total + (record.aiQualityBandCounts?.[band] ?? 0), 0),
            ]),
        ),
        aiImpactCounts: Object.fromEntries(
          unique(records.flatMap((record) => Object.keys(record.aiImpactCounts ?? {})))
            .sort((a, b) => a.localeCompare(b))
            .map((impact) => [
              impact,
              records.reduce((total, record) => total + (record.aiImpactCounts?.[impact] ?? 0), 0),
            ]),
        ),
        aiQualityMeanMedian: median(records.map((record) => record.aiQualityMean).filter((value) => value != null)),
        aiReplayMemoryLoops: records.filter((record) => record.aiReplayMemoryCount > 0).length,
        aiRewriteNeededLoops: records.filter((record) => record.aiRewriteNeededCount > 0).length,
        latestLoop: {
          deltaWall: latestRecord?.deltaWall ?? null,
          deltaInput: latestRecord?.deltaInput ?? null,
          regressionFlags: latestRecord?.regressionFlags ?? [],
          requestedModelHint: latestRecord?.requestedModelHint ?? null,
          aiQualityMean: latestRecord?.aiQualityMean ?? null,
          aiQualityFlagCounts: countBy(latestRecord ? [latestRecord] : [], (record) => record.aiQualityFlags),
          aiQualityBandCounts: sumBy(latestRecord ? [latestRecord] : [], (record) => record.aiQualityBandCounts),
          aiImpactCounts: sumBy(latestRecord ? [latestRecord] : [], (record) => record.aiImpactCounts),
        },
        recent: {
          runCount: recentRecords.length,
          deltaWallMedian: median(recentRecords.map((record) => record.deltaWall).filter((value) => value != null)),
          deltaInputMedian: median(recentRecords.map((record) => record.deltaInput).filter((value) => value != null)),
          deltaOutputMedian: median(recentRecords.map((record) => record.deltaOutput).filter((value) => value != null)),
          wallRegressions: recentRecords.filter((record) => record.regressionFlags.includes("wall")).length,
          inputRegressions: recentRecords.filter((record) => record.regressionFlags.includes("input")).length,
          shellRegressions: recentRecords.filter((record) => record.regressionFlags.includes("shell")).length,
          repeatShellRegressions: recentRecords.filter((record) => record.regressionFlags.includes("repeat_shell")).length,
          qualityFlagCounts: countBy(recentRecords, (record) => record.qualityFlags),
          aiQualityFlagCounts: countBy(recentRecords, (record) => record.aiQualityFlags),
          aiQualityBandCounts: sumBy(recentRecords, (record) => record.aiQualityBandCounts),
          aiImpactCounts: sumBy(recentRecords, (record) => record.aiImpactCounts),
          aiQualityMeanMedian: median(recentRecords.map((record) => record.aiQualityMean).filter((value) => value != null)),
          modelHints: countBy(recentRecords, (record) => (record.requestedModelHint ? [record.requestedModelHint] : [])),
          latestWorkspaceId: recentRecords.at(-1)?.workspaceId ?? null,
          latestUpdatedAt: recentRecords.at(-1)?.updatedAt ?? null,
        },
        records,
        lineage,
      };
    })
    .sort((a, b) => a.benchKey.localeCompare(b.benchKey));

  const loopSeriesGrouped = new Map();
  for (const run of loopSeriesRuns) {
    const loops = [];
    for (const loopPath of run.loopFiles) {
      try {
        const raw = await fs.readFile(loopPath, "utf8");
        const parsed = JSON.parse(raw);
        loops.push(parsed);
      } catch {
        // ignore malformed loop artifacts
      }
    }
    if (!loops.length) continue;
    loops.sort((a, b) => Number(a.loopIndex ?? 0) - Number(b.loopIndex ?? 0));

    const workspaceRecord = {
      workspaceId: run.workspaceId,
      benchDir: run.benchDir,
      updatedAt:
        loops
          .map((loop) => loop?.post?.completedAt ?? loop?.post?.startedAt ?? loop?.learn?.completedAt ?? null)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
      loops,
    };

    const bucket = loopSeriesGrouped.get(run.benchKey) ?? [];
    bucket.push(workspaceRecord);
    loopSeriesGrouped.set(run.benchKey, bucket);
  }

  const loopSeriesAggregates = [...loopSeriesGrouped.entries()]
    .map(([benchKey, workspaceRecords]) => {
      workspaceRecords.sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
      const flatLoops = workspaceRecords.flatMap((workspace) => workspace.loops);
      return {
        benchKey,
        runCount: workspaceRecords.length,
        deltaWallMedian: median(flatLoops.map((loop) => loop?.deltaWallMs).filter((value) => value != null)),
        deltaInputMedian: median(flatLoops.map((loop) => loop?.deltaInputTokens).filter((value) => value != null)),
        deltaShellMedian: median(flatLoops.map((loop) => loop?.deltaShellCommands).filter((value) => value != null)),
        workspaces: workspaceRecords,
      };
    })
    .sort((a, b) => a.benchKey.localeCompare(b.benchKey));

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "learn-bench-rollup.json");
  const mdPath = path.join(outputDir, "learn-bench-rollup.md");
  const lineageJsonPath = path.join(outputDir, "learn-bench-lineage.json");
  const lineageMdPath = path.join(outputDir, "learn-bench-lineage.md");
  const loopSeriesJsonPath = path.join(outputDir, "learn-bench-loop-series.json");
  const loopSeriesMdPath = path.join(outputDir, "learn-bench-loop-series.md");
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), aggregates }, null, 2), "utf8");
  await fs.writeFile(mdPath, buildMarkdown(aggregates), "utf8");
  await fs.writeFile(
    lineageJsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        lineages: aggregates.map((aggregate) => ({
          benchKey: aggregate.benchKey,
          runCount: aggregate.runCount,
          lineage: aggregate.lineage,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(lineageMdPath, buildLineageMarkdown(aggregates), "utf8");
  await fs.writeFile(
    loopSeriesJsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        aggregates: loopSeriesAggregates,
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(loopSeriesMdPath, buildLoopSeriesMarkdown(loopSeriesAggregates), "utf8");

  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
  console.log(`wrote ${lineageJsonPath}`);
  console.log(`wrote ${lineageMdPath}`);
  console.log(`wrote ${loopSeriesJsonPath}`);
  console.log(`wrote ${loopSeriesMdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
