import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../..");
const rollupPath = path.join(repoRoot, "tmp/bench-rollup/learn-bench-rollup.json");

const DEFAULT_BENCHES = [
  "fixture-news-search-beta",
  "fixture-news-catalog-delta",
  "fixture-news-directory-epsilon",
];
const DEFAULT_MODEL = (process.env.PLAYWRIGHT_BENCH_THRESHOLD_MODEL ?? "gpt-5.5").trim();
const REQUIRE_AI = (process.env.PLAYWRIGHT_BENCH_THRESHOLD_REQUIRE_AI ?? "1").trim() !== "0";
const DISALLOWED_AI_FLAGS = new Set(["no_assessment", "evaluation_failed"]);
const DISALLOWED_AI_BANDS = new Set(["weak", "unknown"]);

function parseBenchList(raw) {
  const values = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : DEFAULT_BENCHES;
}

function latestRecordForModel(aggregate, targetModel) {
  const records = Array.isArray(aggregate?.records) ? aggregate.records : [];
  const hinted = records.filter(
    (record) => typeof record?.requestedModelHint === "string" && record.requestedModelHint.trim().length > 0,
  );
  if (!targetModel && records.length > 0) {
    return records.at(-1) ?? null;
  }
  if (hinted.length === 0) {
    return records.at(-1) ?? null;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const modelHint =
      typeof record?.requestedModelHint === "string" && record.requestedModelHint.trim().length > 0
        ? record.requestedModelHint.trim()
        : null;
    if (!targetModel || modelHint === targetModel) {
      return record;
    }
  }
  return null;
}

function successRate(phase) {
  const count = phase?.stats?.count ?? 0;
  const successCount = phase?.stats?.successCount ?? 0;
  return count > 0 ? successCount / count : null;
}

function aiBands(record) {
  const counts = record?.aiQualityBandCounts && typeof record.aiQualityBandCounts === "object" ? record.aiQualityBandCounts : {};
  return Object.keys(counts).filter((key) => counts[key] > 0);
}

function aiFlags(record) {
  return Array.isArray(record?.aiQualityFlags) ? record.aiQualityFlags.filter((flag) => typeof flag === "string" && flag.trim()) : [];
}

function summarize(record) {
  return {
    workspaceId: record?.workspaceId ?? null,
    updatedAt: record?.updatedAt ?? null,
    requestedModelHint: record?.requestedModelHint ?? null,
    deltaWall: record?.deltaWall ?? null,
    deltaInput: record?.deltaInput ?? null,
    regressionFlags: record?.regressionFlags ?? [],
    aiQualityMean: record?.aiQualityMean ?? null,
    aiQualityFlags: aiFlags(record),
    aiQualityBands: aiBands(record),
    preSuccessRate: successRate(record?.entry?.pre),
    postSuccessRate: successRate(record?.entry?.post),
  };
}

async function main() {
  const targetBenches = parseBenchList(process.env.PLAYWRIGHT_BENCH_THRESHOLD_BENCHES);
  const parsed = JSON.parse(await fs.readFile(rollupPath, "utf8"));
  const aggregates = Array.isArray(parsed?.aggregates) ? parsed.aggregates : [];
  const failures = [];
  const passes = [];

  for (const benchKey of targetBenches) {
    const aggregate = aggregates.find((entry) => entry?.benchKey === benchKey);
    if (!aggregate) {
      failures.push(`${benchKey}: missing aggregate in ${rollupPath}`);
      continue;
    }

    const record = latestRecordForModel(aggregate, DEFAULT_MODEL);
    if (!record) {
      failures.push(`${benchKey}: no record found for requested model ${DEFAULT_MODEL}`);
      continue;
    }

    const summary = summarize(record);
    const problems = [];

    if ((summary.preSuccessRate ?? 0) < 1 || (summary.postSuccessRate ?? 0) < 1) {
      problems.push("pre/post success rate is below 100%");
    }
    if (Array.isArray(summary.regressionFlags) && summary.regressionFlags.length > 0) {
      problems.push(`regression flags=${summary.regressionFlags.join(",")}`);
    }
    if (REQUIRE_AI && summary.aiQualityMean == null) {
      problems.push("AI quality is missing");
    }
    const badAiFlags = summary.aiQualityFlags.filter((flag) => DISALLOWED_AI_FLAGS.has(flag));
    if (badAiFlags.length > 0) {
      problems.push(`AI quality flags=${badAiFlags.join(",")}`);
    }
    const badAiBands = summary.aiQualityBands.filter((band) => DISALLOWED_AI_BANDS.has(band));
    if (badAiBands.length > 0) {
      problems.push(`AI quality bands=${badAiBands.join(",")}`);
    }

    if (problems.length > 0) {
      failures.push(`${benchKey}: ${problems.join("; ")} :: ${JSON.stringify(summary)}`);
      continue;
    }

    passes.push(`${benchKey}: ${JSON.stringify(summary)}`);
  }

  for (const line of passes) {
    console.log(`PASS ${line}`);
  }

  if (failures.length > 0) {
    for (const line of failures) {
      console.error(`FAIL ${line}`);
    }
    process.exit(1);
  }

  console.log(
    `All ${passes.length}/${targetBenches.length} learn-bench thresholds passed for requested model ${DEFAULT_MODEL}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
