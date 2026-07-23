import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resolvePlaywrightControllerUrl } from "../utils/controllerUrl.js";
import { readWorkspaceFileText, writeWorkspaceFile } from "../utils/harness.js";

type AttemptLike = {
  phase?: "pre" | "post";
  wallMs: number;
  shellCommands?: number;
  tokenUsage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    model?: string | null;
  } | null;
  learnedBlockReads?: string[];
  learnRouterBlocks?: Array<{ path: string }>;
};

export type LearnedBlockAiEvaluation = {
  path: string;
  quality: number | null;
  qualityBand: "excellent" | "good" | "mixed" | "weak" | "unknown";
  impact: "positive" | "neutral" | "negative" | "uncertain" | "unknown";
  kind: "strategy_memory" | "mixed" | "replay_memory" | "unknown";
  issues: string[];
  strengths: string[];
  rewriteNeeded: boolean | null;
  qualityFlags: string[];
  summary: string | null;
  impactFlags: string[];
  impactSummary: string | null;
  rawReply: string | null;
  error: string | null;
};

export type LearnedBlockAiEvaluationArtifact = {
  generatedAt: string;
  evaluator: "instafy-cli-chat";
  benchKey: string;
  skippedReason: string | null;
  promptModelHint: string | null;
  evaluations: LearnedBlockAiEvaluation[];
  aggregate: {
    meanQuality: number | null;
    qualityFlags: string[];
    qualityBands: Record<string, number>;
    impactCounts: Record<string, number>;
    replayMemoryCount: number;
    rewriteNeededCount: number;
  };
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cliBinPath = path.join(repoRoot, "packages/instafy-cli/bin/instafy.js");

function resolveControllerUrl(): string | null {
  const value =
    process.env.CONTROLLER_BASE_URL?.trim() || resolvePlaywrightControllerUrl(process.env);
  return value.length > 0 ? value.replace(/\/+$/, "") : null;
}

function resolveServiceToken(): string | null {
  const raw =
    process.env.SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    "";
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function unionBlocks(attempts: AttemptLike[]): string[] {
  const out = new Set<string>();
  for (const attempt of attempts) {
    for (const blockPath of attempt.learnedBlockReads ?? []) {
      if (typeof blockPath === "string" && blockPath.trim().length > 0) {
        out.add(blockPath.trim());
      }
    }
    for (const block of attempt.learnRouterBlocks ?? []) {
      if (typeof block?.path === "string" && block.path.trim().length > 0) {
        out.add(block.path.trim());
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [text, stripMarkdownCodeFence(text)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function parseKeyValueEvaluation(text: string): Record<string, unknown> | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const values = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values.set(match[1].trim(), match[2].trim());
  }
  if (!values.has("quality") || !values.has("kind")) {
    return null;
  }
  const splitList = (raw: string | undefined): string[] => {
    const value = (raw ?? "").trim();
    if (!value || value === "-" || /^none$/i.test(value)) return [];
    return value
      .split(/[;,|]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  };
  const bool = (raw: string | undefined): boolean | null => {
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "true" || value === "yes") return true;
    if (value === "false" || value === "no") return false;
    return null;
  };
  return {
    quality: Number(values.get("quality")),
    qualityBand: values.get("qualityBand") ?? "",
    impact: values.get("impact") ?? "",
    kind: values.get("kind") ?? "",
    rewriteNeeded: bool(values.get("rewriteNeeded")),
    qualityFlags: splitList(values.get("qualityFlags")),
    impactFlags: splitList(values.get("impactFlags")),
    issues: splitList(values.get("issues")),
    strengths: splitList(values.get("strengths")),
    blockSummary: values.get("blockSummary") ?? values.get("summary") ?? "",
    impactSummary: values.get("impactSummary") ?? "",
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
}

function parseEvaluation(pathname: string, rawReply: string): LearnedBlockAiEvaluation {
  const parsed = parseJsonObject(rawReply) ?? parseKeyValueEvaluation(rawReply);
  if (!parsed) {
    return {
      path: pathname,
      quality: null,
      qualityBand: "unknown",
      impact: "unknown",
      kind: "unknown",
      issues: [],
      strengths: [],
      rewriteNeeded: null,
      qualityFlags: [],
      summary: null,
      impactFlags: [],
      impactSummary: null,
      rawReply,
      error: "Unable to parse evaluator reply as JSON.",
    };
  }

  const qualityRaw = parsed["quality"];
  const quality =
    typeof qualityRaw === "number" && Number.isFinite(qualityRaw)
      ? Math.max(0, Math.min(100, Math.round(qualityRaw)))
      : null;
  const qualityBandRaw =
    typeof parsed["qualityBand"] === "string" ? parsed["qualityBand"].trim() : "";
  const qualityBand =
    qualityBandRaw === "excellent" ||
    qualityBandRaw === "good" ||
    qualityBandRaw === "mixed" ||
    qualityBandRaw === "weak"
      ? qualityBandRaw
      : quality == null
        ? "unknown"
        : quality >= 90
          ? "excellent"
          : quality >= 70
            ? "good"
            : quality >= 40
            ? "mixed"
              : "weak";
  const impactRaw = typeof parsed["impact"] === "string" ? parsed["impact"].trim() : "";
  const impact =
    impactRaw === "positive" ||
    impactRaw === "neutral" ||
    impactRaw === "negative" ||
    impactRaw === "uncertain"
      ? impactRaw
      : "unknown";
  const kindRaw = typeof parsed["kind"] === "string" ? parsed["kind"].trim() : "";
  const kind =
    kindRaw === "strategy_memory" || kindRaw === "mixed" || kindRaw === "replay_memory"
      ? kindRaw
      : "unknown";
  const rewriteNeededRaw = parsed["rewriteNeeded"];
  const rewriteNeeded =
    typeof rewriteNeededRaw === "boolean" ? rewriteNeededRaw : null;

  return {
    path: pathname,
    quality,
    qualityBand,
    impact,
    kind,
    issues: normalizeStringArray(parsed["issues"]),
    strengths: normalizeStringArray(parsed["strengths"]),
    rewriteNeeded,
    qualityFlags: normalizeStringArray(parsed["qualityFlags"]),
    summary:
      typeof parsed["blockSummary"] === "string"
        ? parsed["blockSummary"].trim() || null
        : typeof parsed["summary"] === "string"
          ? parsed["summary"].trim() || null
          : null,
    impactFlags: normalizeStringArray(parsed["impactFlags"]),
    impactSummary:
      typeof parsed["impactSummary"] === "string" ? parsed["impactSummary"].trim() || null : null,
    rawReply,
    error: null,
  };
}

function buildRepairPrompt(rawReply: string): string {
  return [
    "Convert the following evaluation into exactly one minified JSON object.",
    "",
    "Return ONLY one JSON object with these keys and no surrounding prose, markdown, or explanation:",
    '{"quality":0,"qualityBand":"excellent|good|mixed|weak","impact":"positive|neutral|negative|uncertain","kind":"strategy_memory|mixed|replay_memory","rewriteNeeded":false,"qualityFlags":["..."],"impactFlags":["..."],"issues":["..."],"strengths":["..."],"blockSummary":"one sentence","impactSummary":"one sentence"}',
    "",
    "Allowed kind values: strategy_memory, mixed, replay_memory",
    "Allowed qualityBand values: excellent, good, mixed, weak",
    "Allowed impact values: positive, neutral, negative, uncertain",
    "Use the full 0-100 scale. 90-100 means excellent, 70-89 good, 40-69 mixed, 0-39 weak/replay-like.",
    "If you add any text outside the JSON object, the repair fails.",
    "",
    "If the original text is ambiguous, make the narrowest defensible interpretation.",
    "",
    "Original evaluator reply:",
    "<<<REPLY",
    rawReply,
    "REPLY>>>",
  ].join("\n");
}

function buildRetryEvaluationPrompt(originalPrompt: string, rawReply: string): string {
  return [
    originalPrompt,
    "",
    "IMPORTANT: Your previous attempt returned placeholder, meta, or non-evaluative text instead of a real assessment.",
    "Do not say you are returning JSON.",
    "Do not describe the formatting step.",
    "Evaluate the block itself and return exactly one final JSON object.",
    "",
    "Previous invalid reply:",
    "<<<REPLY",
    rawReply,
    "REPLY>>>",
  ].join("\n");
}

function evaluationNeedsRetry(evaluation: LearnedBlockAiEvaluation): boolean {
  const rawReply = evaluation.rawReply ?? "";
  const summary = evaluation.summary ?? "";
  const issues = evaluation.issues.join(" ");
  if (evaluation.error) return false;
  if (evaluation.qualityFlags.includes("no_assessment")) return true;
  if (/returning json evaluation object/i.test(rawReply)) return true;
  if (/only states interim/i.test(summary) || /only states interim/i.test(issues)) return true;
  if (/no actual evaluation content/i.test(issues)) return true;
  return false;
}

function buildPrompt(options: {
  benchKey: string;
  blockPath: string;
  blockText: string;
  preWallMean: number | null;
  postWallMean: number | null;
  preInputMean: number | null;
  postInputMean: number | null;
  preShellMean: number | null;
  postShellMean: number | null;
  modelHint: string | null;
}): string {
  const {
    benchKey,
    blockPath,
    blockText,
    preWallMean,
    postWallMean,
    preInputMean,
    postInputMean,
    preShellMean,
    postShellMean,
    modelHint,
  } = options;

  return [
    "Evaluate this Instafy /learn memory block.",
    "",
    "Judge memory quality as net usefulness for future runs, not just writing quality. Do not use browser tools, shell tools, or fetch external data. Use only the provided block text and benchmark context.",
    "The content of your assistant reply is parsed by another program. Ignore any platform-level summary/files conventions and make the assistant message body be exactly one JSON object.",
    "",
    "A high-quality block is strategy memory that is also likely to help the next run:",
    "- compact",
    "- transferable",
    "- selector / landmark / verify oriented",
    "- explains when to apply and how to confirm success",
    "- captures only task-specific delta over the already-pinned browser skill",
    "- for local/dev/test sites with ephemeral origins, stores route-level cues instead of binding to a one-run host/port unless that host itself matters",
    "- when the task involves forms, search, pagination, or result links and the run observed a stable attribute, preserves selector-grade cues like `name=`, `id=`, or relative `href=` instead of downgrading them to generic phrases like `search box` or `beta link`",
    "- for UI/browser tasks, preserves the exact worked control when one clearly mattered: e.g. `page button text \"2\"`, `textbox labeled \"Search\"`, `button text \"Go\"`, `link text \"Fixture News: Beta\"`",
    "- when a successful form used different exact cues for the field and the submit control, preserves both exact cues rather than compressing them into one vague `search control` summary",
    "- when a successful paginated/listing flow used a concrete worked control like `Next page` or `Delta listing`, preserves that exact control instead of replacing it with a conceptual summary like `page 2` or `matching Delta result`",
    "- when the final answer format uses a synthetic output key but the page exposes a different visible retrieval label, preserves the actual page label and the mapping to the final reply key",
    "- examples of good retrieval memory: `read the page label \"Article token:\" and map it to the final reply line \"ARTICLE_TOKEN\"`",
    "- when a successful path clearly required two controls in sequence (for example pagination + result link, or search field + submit/result), preserves both worked cues instead of storing only the route or intent",
    "",
    "A low-quality block is replay memory:",
    "- exact shell/browser command sequences",
    "- runtime-specific command invocations",
    "- overfit one-run step-by-step automation",
    "- copied noise with weak transfer value",
    "- generic browser-operation reminders that should already live in pinned skills",
    "- concrete output examples or token values from one successful run when future runs only need to know how to find them again",
    "- memorizing ephemeral local origins (`localhost`, `127.0.0.1`, `host.docker.internal`, changing ports) when the route or visible cue is the real learned fact",
    "- omitting an available selector-grade cue on workflows that clearly depend on one stable field or link",
    "- collapsing paired exact cues like `textbox labeled \"Search\"` plus `button text \"Go\"` into a vague phrase like `search control` or `visible submit control`",
    "- replacing an actual worked pagination/result cue like `link text \"Next page\"` or `link text \"Delta listing\"` with a looser paraphrase like `page 2` or `matching Delta result`",
    "- omitting one of two clearly required worked controls on search/pagination/listing flows, leaving only route-level memory",
    "- keeping only route- or intent-level summaries like `use page 2`, `search for beta`, or `open the matching result` when the run clearly depended on one exact control cue",
    "- storing only the requested output field name when the page used a different visible retrieval label",
    "",
    "Also judge likely benchmark impact using the observed pre/post metrics:",
    "- positive = likely helped the run get faster/cleaner or guided a better path",
    "- neutral = probably fine but effect is unclear",
    "- negative = likely contributed to slower execution, extra shell branching, or over-exploration",
    "- uncertain = evidence is mixed or too weak",
    "- if post wall time regresses but input tokens and shell branching stay effectively flat, prefer `uncertain` or `neutral` over `negative` unless there is another concrete quality defect in the block",
    "- if impact is negative and a concrete missing cue is obvious, set `rewriteNeeded` to true",
    "- if impact is negative and the block still compresses an exact worked control into a vague submit/result phrase, do not return `good` or `excellent`; mark the block `mixed` or `weak` and set `rewriteNeeded` to true",
    "- if `missing_selector_grade_cue` applies, set `rewriteNeeded` to true",
    "",
    "Score quality on a 0-100 scale where quality should track expected usefulness. If observed impact is clearly negative, quality should usually be capped to mixed/weak unless the metrics are obviously noisy:",
    "- 90-100 = excellent, highly reusable strategy memory",
    "- 70-89 = good strategy memory with small issues",
    "- 40-69 = mixed / partially useful",
    "- 0-39 = weak or replay-like memory",
    "",
    `Benchmark: ${benchKey}`,
    `Model hint: ${modelHint ?? "unknown"}`,
    `Observed pre wall mean ms: ${preWallMean ?? "null"}`,
    `Observed post wall mean ms: ${postWallMean ?? "null"}`,
    `Observed pre input mean: ${preInputMean ?? "null"}`,
    `Observed post input mean: ${postInputMean ?? "null"}`,
    `Observed pre shell mean: ${preShellMean ?? "null"}`,
    `Observed post shell mean: ${postShellMean ?? "null"}`,
    "",
    `Block path: ${blockPath}`,
    "",
    "Return ONLY one minified JSON object, with no prose before or after:",
    '{"quality":0,"qualityBand":"excellent|good|mixed|weak","impact":"positive|neutral|negative|uncertain","kind":"strategy_memory|mixed|replay_memory","rewriteNeeded":false,"qualityFlags":["..."],"impactFlags":["..."],"issues":["..."],"strengths":["..."],"blockSummary":"one sentence","impactSummary":"one sentence"}',
    "",
    "Do not emit markdown fences. Do not emit explanations. Do not restate the task. If you output anything outside the JSON object, the evaluation fails.",
    "",
    "Allowed qualityBand values: excellent, good, mixed, weak",
    "Allowed impact values: positive, neutral, negative, uncertain",
    "Allowed kind values: strategy_memory, mixed, replay_memory",
    "Allowed qualityFlags examples: over_procedural, too_specific, missing_verify, weak_routing_signal, too_verbose, runtime_replay, duplicates_pinned_skill, stores_example_output_value, ephemeral_origin_binding, missing_selector_grade_cue",
    "Use `missing_selector_grade_cue` when the block missed an exact worked control or missed the actual visible retrieval label that the run depended on.",
    "Allowed impactFlags examples: slower_post_run, higher_input_tokens, more_shell_branching, likely_overexploration, likely_helped_navigation, duplicates_baseline_skill, overfit_success_example",
    "",
    "Block text follows:",
    "<<<BLOCK",
    blockText,
    "BLOCK>>>",
  ].join("\n");
}

function renderMarkdown(artifact: LearnedBlockAiEvaluationArtifact): string {
  const lines: string[] = [];
  lines.push("# AI Learned Block Evaluation");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Bench: ${artifact.benchKey}`);
  lines.push(`Model hint: ${artifact.promptModelHint ?? "-"}`);
  lines.push("");
  if (artifact.skippedReason) {
    lines.push(`Skipped: ${artifact.skippedReason}`);
    return lines.join("\n");
  }

  lines.push(`Mean quality: ${artifact.aggregate.meanQuality ?? "-"}`);
  lines.push(
    `Quality bands: ${
      Object.entries(artifact.aggregate.qualityBands)
        .map(([band, count]) => `${band}=${count}`)
        .join(", ") || "-"
    }`,
  );
  lines.push(
    `Impact counts: ${
      Object.entries(artifact.aggregate.impactCounts)
        .map(([impact, count]) => `${impact}=${count}`)
        .join(", ") || "-"
    }`,
  );
  lines.push(`Replay-memory count: ${artifact.aggregate.replayMemoryCount}`);
  lines.push(`Rewrite-needed count: ${artifact.aggregate.rewriteNeededCount}`);
  lines.push(`Aggregate flags: ${artifact.aggregate.qualityFlags.join(", ") || "-"}`);
  lines.push("");
  lines.push("| Block | Quality | Band | Impact | Kind | Rewrite | Flags | Impact flags | Summary |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const evaluation of artifact.evaluations) {
    lines.push(
      `| ${evaluation.path.replace(/\|/g, " ")} | ${evaluation.quality ?? "-"} | ${evaluation.qualityBand} | ${evaluation.impact} | ${evaluation.kind} | ${
        evaluation.rewriteNeeded == null ? "-" : evaluation.rewriteNeeded ? "yes" : "no"
      } | ${(evaluation.qualityFlags.join(", ") || "-").replace(/\|/g, " ")} | ${(evaluation.impactFlags.join(", ") || "-").replace(/\|/g, " ")} | ${(
        evaluation.impactSummary ?? evaluation.summary ?? evaluation.error ?? "-"
      ).replace(/\|/g, " ")} |`,
    );
  }
  return lines.join("\n");
}

function runInstafyChat(prompt: string, options: { projectId: string; controllerUrl: string; serviceToken: string }) {
  return spawnSync(
    process.execPath,
    [
      cliBinPath,
      "chat",
      prompt,
      "--project",
      options.projectId,
      "--controller-url",
      options.controllerUrl,
      "--service-token",
      options.serviceToken,
      "--intent",
      "question",
      "--accept-status-reply",
      "--json",
      "--timeout-ms",
      "120000",
      "--poll-ms",
      "1000",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      env: {
        ...process.env,
        CONTROLLER_BASE_URL: options.controllerUrl,
      },
    },
  );
}

export async function evaluateLearnedBlocksWithAi(
  page: Page,
  options: {
    projectId: string;
    benchKey: string;
    benchDir: string;
    attempts: AttemptLike[];
  },
): Promise<LearnedBlockAiEvaluationArtifact> {
  const enabled = (process.env.PLAYWRIGHT_BENCH_AI_EVAL ?? "1").trim() !== "0";
  const controllerUrl = resolveControllerUrl();
  const serviceToken = resolveServiceToken();
  const blockPaths = unionBlocks(options.attempts);

  const preAttempts = options.attempts.filter((attempt) => attempt.phase === "pre");
  const postAttempts = options.attempts.filter((attempt) => attempt.phase === "post");
  const promptModelHint =
    postAttempts[0]?.tokenUsage?.model ??
    preAttempts[0]?.tokenUsage?.model ??
    null;

  const preWallMean = mean(preAttempts.map((attempt) => attempt.wallMs).filter((value) => Number.isFinite(value)));
  const postWallMean = mean(postAttempts.map((attempt) => attempt.wallMs).filter((value) => Number.isFinite(value)));
  const preInputMean = mean(
    preAttempts
      .map((attempt) => attempt.tokenUsage?.inputTokens ?? null)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
  const postInputMean = mean(
    postAttempts
      .map((attempt) => attempt.tokenUsage?.inputTokens ?? null)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
  const preShellMean = mean(
    preAttempts
      .map((attempt) => (typeof attempt.shellCommands === "number" ? attempt.shellCommands : null))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
  const postShellMean = mean(
    postAttempts
      .map((attempt) => (typeof attempt.shellCommands === "number" ? attempt.shellCommands : null))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );

  const baseArtifact: LearnedBlockAiEvaluationArtifact = {
    generatedAt: new Date().toISOString(),
    evaluator: "instafy-cli-chat",
    benchKey: options.benchKey,
    skippedReason: null,
    promptModelHint,
    evaluations: [],
    aggregate: {
      meanQuality: null,
      qualityFlags: [],
      qualityBands: {},
      impactCounts: {},
      replayMemoryCount: 0,
      rewriteNeededCount: 0,
    },
  };

  if (!enabled) {
    baseArtifact.skippedReason = "PLAYWRIGHT_BENCH_AI_EVAL=0";
    return baseArtifact;
  }
  if (!controllerUrl || !serviceToken) {
    baseArtifact.skippedReason = "Missing controller URL or service token.";
    return baseArtifact;
  }
  if (blockPaths.length === 0) {
    baseArtifact.skippedReason = "No learned blocks were loaded in this benchmark.";
    return baseArtifact;
  }

  const evaluations: LearnedBlockAiEvaluation[] = [];
  for (const blockPath of blockPaths) {
    const blockText = await readWorkspaceFileText(page, blockPath, {
      projectId: options.projectId,
    }).catch(() => null);
    if (!blockText) {
      evaluations.push({
        path: blockPath,
        quality: null,
        qualityBand: "unknown",
        impact: "unknown",
        kind: "unknown",
        issues: [],
        strengths: [],
        rewriteNeeded: null,
        qualityFlags: ["missing_block"],
        summary: null,
        impactFlags: ["missing_block"],
        impactSummary: null,
        rawReply: null,
        error: "Unable to read learned block from workspace.",
      });
      continue;
    }

    const prompt = buildPrompt({
      benchKey: options.benchKey,
      blockPath,
      blockText,
      preWallMean,
      postWallMean,
      preInputMean,
      postInputMean,
      preShellMean,
      postShellMean,
      modelHint: promptModelHint,
    });

    const result = runInstafyChat(prompt, {
      projectId: options.projectId,
      controllerUrl,
      serviceToken,
    });

    if (result.status !== 0) {
      evaluations.push({
        path: blockPath,
        quality: null,
        qualityBand: "unknown",
        impact: "unknown",
        kind: "unknown",
        issues: [],
        strengths: [],
        rewriteNeeded: null,
        qualityFlags: ["evaluation_failed"],
        summary: null,
        impactFlags: ["evaluation_failed"],
        impactSummary: null,
        rawReply: (result.stdout || "").trim() || null,
        error: (result.stderr || "").trim() || `instafy chat exited with status ${result.status}`,
      });
      continue;
    }

    const rawJson = parseJsonObject(result.stdout || "");
    const reply = typeof rawJson?.["reply"] === "string" ? (rawJson["reply"] as string) : (result.stdout || "").trim();
    let parsed = parseEvaluation(blockPath, reply);
    if (parsed.error) {
      const repair = runInstafyChat(buildRepairPrompt(reply), {
        projectId: options.projectId,
        controllerUrl,
        serviceToken,
      });
      if (repair.status === 0) {
        const repairedJson = parseJsonObject(repair.stdout || "");
        const repairedReply =
          typeof repairedJson?.["reply"] === "string" ? (repairedJson["reply"] as string) : (repair.stdout || "").trim();
        const repaired = parseEvaluation(blockPath, repairedReply);
        if (!repaired.error) {
          parsed = repaired;
        } else {
          parsed.rawReply = repairedReply;
        }
      }
    }
    if (evaluationNeedsRetry(parsed)) {
      const retry = runInstafyChat(buildRetryEvaluationPrompt(prompt, parsed.rawReply ?? reply), {
        projectId: options.projectId,
        controllerUrl,
        serviceToken,
      });
      if (retry.status === 0) {
        const retriedJson = parseJsonObject(retry.stdout || "");
        const retriedReply =
          typeof retriedJson?.["reply"] === "string" ? (retriedJson["reply"] as string) : (retry.stdout || "").trim();
        const retried = parseEvaluation(blockPath, retriedReply);
        if (!retried.error) {
          parsed = retried;
        } else {
          parsed.rawReply = retriedReply;
        }
      }
    }
    evaluations.push(parsed);
  }

  const qualityValues = evaluations
    .map((evaluation) => evaluation.quality)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const qualityBands = evaluations.reduce<Record<string, number>>((acc, evaluation) => {
    acc[evaluation.qualityBand] = (acc[evaluation.qualityBand] ?? 0) + 1;
    return acc;
  }, {});
  const impactCounts = evaluations.reduce<Record<string, number>>((acc, evaluation) => {
    acc[evaluation.impact] = (acc[evaluation.impact] ?? 0) + 1;
    return acc;
  }, {});
  const aggregateFlags = [...new Set(evaluations.flatMap((evaluation) => evaluation.qualityFlags))]
    .sort((a, b) => a.localeCompare(b));

  const artifact: LearnedBlockAiEvaluationArtifact = {
    ...baseArtifact,
    evaluations,
    aggregate: {
      meanQuality: mean(qualityValues),
      qualityFlags: aggregateFlags,
      qualityBands,
      impactCounts,
      replayMemoryCount: evaluations.filter((evaluation) => evaluation.kind === "replay_memory").length,
      rewriteNeededCount: evaluations.filter((evaluation) => evaluation.rewriteNeeded === true).length,
    },
  };

  await writeWorkspaceFile(page, `${options.benchDir}/ai-quality.json`, JSON.stringify(artifact, null, 2), {
    createDirectories: true,
    projectId: options.projectId,
  }).catch(() => {});
  await writeWorkspaceFile(page, `${options.benchDir}/ai-quality.md`, renderMarkdown(artifact), {
    createDirectories: true,
    projectId: options.projectId,
  }).catch(() => {});

  return artifact;
}
