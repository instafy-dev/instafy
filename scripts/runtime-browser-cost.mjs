#!/usr/bin/env node
// Turns scripts/runtime-browser-cost.sh measurements into the browser host
// cost report, checks its gates and rewrites the measured section of
// docs/Runtime-Image-Builds.md:
//
//   node scripts/runtime-browser-cost.mjs <measurements.json> <Runtime-Image-Builds.md> <output-dir>
//
// It writes <output-dir>/report.md and <output-dir>/Runtime-Image-Builds.md
// (the doc with the section replaced, ready to commit), appends the report to
// GITHUB_STEP_SUMMARY when set, and exits 1 when a gate fails. It never edits
// the checkout's doc in place.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SECTION_START = "<!-- runtime-browser-cost:start -->";
export const SECTION_END = "<!-- runtime-browser-cost:end -->";

const MIB = 1024 * 1024;
const MB = 1000 * 1000;

// The plan's acceptance gates. CPU during screencast is reported, not gated.
export const GATES = [
  { key: "imageDelta", label: "Image size increase", limit: 400 * MB, unit: "bytes" },
  { key: "bootDelta", label: "Boot time increase (median)", limit: 500, unit: "ms" },
  { key: "idleDelta", label: "Idle memory increase, browser never started", limit: 16 * MIB, unit: "bytes" },
  { key: "startP95", label: "Browser host start to CDP ready, p95", limit: 15_000, unit: "ms" },
];

// Nearest-rank percentile: the smallest value with at least p percent of the
// values at or below it.
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("percentile needs values");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function median(values) {
  return percentile(values, 50);
}

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function numbers(values, name) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${name} must be a non-empty list`);
  return values.map((value, index) => finite(value, `${name}[${index}]`));
}

export function evaluate(measurements) {
  if (measurements?.schemaVersion !== 1) throw new Error("unsupported measurements schema");
  const bootBefore = numbers(measurements.bootMs?.before, "bootMs.before");
  const bootAfter = numbers(measurements.bootMs?.after, "bootMs.after");
  const starts = numbers(measurements.hostStartMs, "hostStartMs");
  const values = {
    imageDelta: finite(measurements.imageBytes?.after, "imageBytes.after") - finite(measurements.imageBytes?.before, "imageBytes.before"),
    bootDelta: median(bootAfter) - median(bootBefore),
    idleDelta: finite(measurements.idleMemoryBytes?.after, "idleMemoryBytes.after")
      - finite(measurements.idleMemoryBytes?.before, "idleMemoryBytes.before"),
    startP95: percentile(starts, 95),
  };
  const gates = GATES.map((gate) => ({ ...gate, value: values[gate.key], passed: values[gate.key] <= gate.limit }));
  return {
    measurements,
    bootMedian: { before: median(bootBefore), after: median(bootAfter) },
    start: { first: starts[0], p50: percentile(starts, 50), p95: percentile(starts, 95), p99: percentile(starts, 99), runs: starts.length },
    gates,
    passed: gates.every((gate) => gate.passed),
  };
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "not measured";
  const sign = bytes < 0 ? "-" : "";
  const value = Math.abs(bytes);
  if (value >= 1000 * MB) return `${sign}${(value / (1000 * MB)).toFixed(2)} GB`;
  if (value >= MB) return `${sign}${(value / MB).toFixed(1)} MB`;
  return `${sign}${(value / 1000).toFixed(0)} kB`;
}

function formatMib(bytes) {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return "not measured";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function formatGate(gate) {
  if (gate.unit === "ms") return { value: formatMs(gate.value), limit: formatMs(gate.limit) };
  return gate.key === "idleDelta"
    ? { value: formatMib(gate.value), limit: formatMib(gate.limit) }
    : { value: formatBytes(gate.value), limit: formatBytes(gate.limit) };
}

// Image references come from workflow inputs; keep them inside code spans.
function code(value) {
  return `\`${String(value).replace(/[`\r\n|]/gu, "")}\``;
}

export function renderMarkdown(result, { measuredAt = new Date().toISOString().slice(0, 10), runUrl = "", hosted = false } = {}) {
  const m = result.measurements;
  const where = hosted ? "a GitHub-hosted runner" : "a local machine, not a release measurement";
  const lines = [
    `Measured ${measuredAt} on ${where}${runUrl ? ` ([run](${runUrl}))` : ""}:`,
    `before ${code(m.beforeImage)}, after ${code(m.afterImage)}.`,
    "",
    "| gate | measured | limit | result |",
    "|---|---|---|---|",
    ...result.gates.map((gate) => {
      const shown = formatGate(gate);
      return `| ${gate.label} | ${shown.value} | ${shown.limit} | ${gate.passed ? "pass" : "**fail**"} |`;
    }),
    "",
    "| measurement | before | after |",
    "|---|---|---|",
    `| Image size | ${formatBytes(m.imageBytes.before)} | ${formatBytes(m.imageBytes.after)} |`,
    `| Cold pull | ${formatMs(m.coldPullMs?.before)} | ${formatMs(m.coldPullMs?.after)} |`,
    `| Boot to the runtime-agent exec line, median of ${m.bootMs.after.length} | ${formatMs(result.bootMedian.before)} | ${formatMs(result.bootMedian.after)} |`,
    `| Memory after ${m.idleSeconds} s idle, browser never started | ${formatMib(m.idleMemoryBytes.before)} | ${formatMib(m.idleMemoryBytes.after)} |`,
    "",
    "| browser host (after image) | value |",
    "|---|---|",
    `| Start to CDP ready over ${result.start.runs} starts on one profile: first, p50, p95, p99 | ${formatMs(result.start.first)}, ${formatMs(result.start.p50)}, ${formatMs(result.start.p95)}, ${formatMs(result.start.p99)} |`,
    `| Container memory at about:blank | ${formatMib(m.memoryBytes.aboutBlank)} |`,
    `| After a 5,000-row table page | ${formatMib(m.memoryBytes.denseTable)} |`,
    `| After an animated canvas page | ${formatMib(m.memoryBytes.canvas)} |`,
    `| Container CPU during ${m.screencast.seconds} s of CDP screencast (reported, not gated) | ${m.screencast.cores.toFixed(2)} cores, ${m.screencast.frames} frames |`,
    `| \`/tmp\` growth across all starts | ${m.tmpKib.after - m.tmpKib.before} KiB |`,
    `| Persisted profile size afterwards | ${m.profileKib} KiB |`,
    "",
    result.passed ? "Every gate passed." : "At least one gate failed; the browser host should not be enabled for every space yet.",
  ];
  return `${lines.join("\n")}\n`;
}

export function replaceSection(doc, body) {
  const start = doc.indexOf(SECTION_START);
  const end = doc.indexOf(SECTION_END);
  if (start < 0 || end < start || doc.indexOf(SECTION_START, start + 1) >= 0) {
    throw new Error("the doc must contain the runtime-browser-cost section markers exactly once, in order");
  }
  return `${doc.slice(0, start + SECTION_START.length)}\n${body}${doc.slice(end)}`;
}

function main(argv, env) {
  const [measurementsFile, docFile, outputDir] = argv;
  if (!measurementsFile || !docFile || !outputDir) {
    throw new Error("usage: runtime-browser-cost.mjs <measurements.json> <Runtime-Image-Builds.md> <output-dir>");
  }
  const result = evaluate(JSON.parse(fs.readFileSync(measurementsFile, "utf8")));
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "";
  const markdown = renderMarkdown(result, { runUrl, hosted: env.RUNNER_ENVIRONMENT === "github-hosted" });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "report.md"), markdown);
  fs.writeFileSync(path.join(outputDir, path.basename(docFile)), replaceSection(fs.readFileSync(docFile, "utf8"), markdown));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Browser host cost\n\n${markdown}`);
  process.stdout.write(markdown);
  for (const gate of result.gates.filter((candidate) => !candidate.passed)) {
    process.stdout.write(`::error title=Browser host cost gate failed::${gate.label}: ${formatGate(gate).value} is over ${formatGate(gate).limit}\n`);
  }
  return result.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
