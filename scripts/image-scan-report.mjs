#!/usr/bin/env node
// Renders the results of .github/workflows/image-scan.yml: one job summary per
// image cell, and the body and comments of the nightly tracking issue. It only
// formats; the workflow's Trivy gate decides pass or fail, and every GitHub
// call stays in the workflow.
//
//   node scripts/image-scan-report.mjs cell
//   node scripts/image-scan-report.mjs issue <jobs.json> <results-dir>
//   node scripts/image-scan-report.mjs comment <jobs.json>
//
// cell reads CELL_IMAGE, CELL_SOURCE, CELL_TARGET, CELL_PLATFORM, BUILD_OUTCOME,
// SCAN_OUTCOME, SMOKE_OUTCOME, SMOKE_REQUIRED, FINDINGS_FILE and RESULT_FILE.
// It appends to GITHUB_STEP_SUMMARY and, for a failed cell only, writes a JSON
// record to RESULT_FILE; the workflow names each record's artifact after the
// run attempt so the report reads only the current attempt's failures. issue and comment read REPOSITORY_URL, RUN_URL and
// SOURCE_SHA, plus the run's jobs as listed by the Actions API.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "Nightly image scan failing";
export const SUMMARY_ROW_LIMIT = 100;
export const ISSUE_ROW_LIMIT = 10;
export const ISSUE_BODY_LIMIT = 60_000;
export const ISSUE_MARKER = "<!-- instafy-image-scan-tracking -->";

const severityRank = { CRITICAL: 0, HIGH: 1 };

// One Markdown table cell: single line, no pipe that would split the row.
function tableCell(value) {
  const text = String(value ?? "")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/`/gu, "'")
    .trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function code(value) {
  return `\`${String(value ?? "").replace(/[`\r\n]/gu, "")}\``;
}

// Workflow-command data must not carry a line break or an escape sequence.
function commandData(value) {
  return String(value).replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

// Every finding in a Trivy JSON report: vulnerabilities, then secrets.
export function scanFindings(report) {
  const rows = [];
  for (const result of Array.isArray(report?.Results) ? report.Results : []) {
    for (const vulnerability of Array.isArray(result?.Vulnerabilities) ? result.Vulnerabilities : []) {
      rows.push({
        severity: String(vulnerability.Severity ?? ""),
        id: String(vulnerability.VulnerabilityID ?? ""),
        package: String(vulnerability.PkgName ?? ""),
        installed: String(vulnerability.InstalledVersion ?? ""),
        fixed: String(vulnerability.FixedVersion ?? ""),
        target: String(result.Target ?? ""),
      });
    }
    for (const secret of Array.isArray(result?.Secrets) ? result.Secrets : []) {
      const line = Number.isSafeInteger(secret.StartLine) ? `:${secret.StartLine}` : "";
      rows.push({
        severity: String(secret.Severity ?? ""),
        id: `secret ${secret.RuleID ?? "unknown"}`,
        package: String(secret.Category ?? "secret"),
        installed: "",
        fixed: "",
        target: `${result.Target ?? ""}${line}`,
      });
    }
  }
  return rows.sort((left, right) =>
    (severityRank[left.severity] ?? 2) - (severityRank[right.severity] ?? 2)
    || left.package.localeCompare(right.package)
    || left.id.localeCompare(right.id)
    || left.target.localeCompare(right.target));
}

// Scanner values go in code spans: an npm scope such as @npmcli would
// otherwise mention a GitHub account from the tracking issue.
function codeCell(value) {
  const text = tableCell(value);
  return text ? `\`${text}\`` : "";
}

function findingTable(findings, limit) {
  const lines = [
    "| Severity | Finding | Package | Installed | Fixed in | Target |",
    "| --- | --- | --- | --- | --- | --- |",
    ...findings.slice(0, limit).map((row) =>
      `| ${[tableCell(row.severity), ...[row.id, row.package, row.installed, row.fixed, row.target].map(codeCell)].join(" | ")} |`),
  ];
  if (findings.length > limit) lines.push("", `${findings.length - limit} more findings are in the job log.`);
  return lines.join("\n");
}

const outcomeText = {
  success: "passed",
  failure: "failed",
  cancelled: "cancelled (time limit or manual cancel)",
  skipped: "not run, an earlier step failed",
};

// Builds the record for one image cell from its step outcomes and, when the
// gate failed, the JSON listing of what it found.
export function cellResult({ image, source, target = "", platform, build, scan, smoke, smokeRequired, findings }) {
  const checks = [
    { name: "Build", outcome: build || "" },
    { name: "Trivy scan (fixable HIGH and CRITICAL, secrets)", outcome: scan || "" },
  ];
  if (smokeRequired) checks.push({ name: "Shared Browser starts", outcome: smoke || "" });
  const passed = checks.every((check) => check.outcome === "success");
  const reasons = [];
  if (build !== "success") {
    reasons.push(build === "failure"
      ? "The image did not build; the build step log shows the failing instruction."
      : "The build did not run; an earlier step (checkout, disk or tool setup) failed or the job was cancelled.");
  }
  if (scan === "failure") {
    if (findings === null) {
      reasons.push("The Trivy gate failed without a findings list; the scan step log shows why, for example a vulnerability database download error.");
    } else {
      const packages = [...new Set(findings.map((row) => row.package))];
      reasons.push(`Trivy found ${findings.length} fixable HIGH or CRITICAL ${findings.length === 1 ? "finding" : "findings"} in ${packages.length === 1 ? "package" : "packages"} ${packages.map(code).join(", ")}.`);
    }
  }
  if (smokeRequired && smoke === "failure") {
    reasons.push("Headed Chromium did not answer on its CDP port; the Shared Browser step log shows the entrypoint and Chromium output.");
  }
  return {
    schemaVersion: 1,
    image,
    source,
    target,
    platform,
    passed,
    checks,
    reasons,
    findings: findings ?? [],
  };
}

function heading(result, level) {
  return `${"#".repeat(level)} Image scan ${result.passed ? "passed" : "failed"}: ${tableCell(result.image)} (${tableCell(result.platform)})`;
}

export function cellMarkdown(result, rowLimit = SUMMARY_ROW_LIMIT, level = 3) {
  const target = result.target ? ` target ${code(result.target)}` : "";
  const lines = [heading(result, level), "",
    `Built from ${code(result.source)}${target} for ${code(result.platform)}. Nothing was pushed or tagged in a registry.`, ""];
  lines.push("| Check | Result |", "| --- | --- |");
  for (const check of result.checks) lines.push(`| ${check.name} | ${outcomeText[check.outcome] ?? "not run"} |`);
  if (result.reasons.length) lines.push("", ...result.reasons);
  if (result.findings.length) lines.push("", findingTable(result.findings, rowLimit));
  return `${lines.join("\n")}\n`;
}

function failedJobs(jobs) {
  const list = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  return list
    .filter((job) => job && typeof job.conclusion === "string" && !["success", "skipped", "neutral"].includes(job.conclusion))
    .map((job) => ({
      name: String(job.name ?? "unnamed job"),
      conclusion: job.conclusion,
      step: (Array.isArray(job.steps) ? job.steps : []).find((step) => step?.conclusion && !["success", "skipped"].includes(step.conclusion))?.name ?? "",
      url: typeof job.html_url === "string" && /^https:\/\/github\.com\//u.test(job.html_url) ? job.html_url : "",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function readResults(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")))
    .filter((result) => result?.schemaVersion === 1 && result.passed === false);
}

export function issueBody({ repositoryUrl, runUrl, sha, jobs, results }) {
  const failed = failedJobs(jobs);
  const lines = [
    ISSUE_MARKER,
    `The nightly image scan of ${code("main")} at ${code(sha)} failed in [this run](${runUrl}).`,
    "It builds and scans the release images exactly as the publishers do, so publishing these images would fail the same way.",
    "",
  ];
  if (failed.length) {
    lines.push("| Job | Result | Failed step |", "| --- | --- | --- |");
    for (const job of failed) {
      const name = job.url ? `[${tableCell(job.name)}](${job.url})` : tableCell(job.name);
      lines.push(`| ${name} | ${tableCell(job.conclusion)} | ${tableCell(job.step) || "see the log"} |`);
    }
  } else {
    lines.push("The run's job list was unavailable; open the run for the failing jobs.");
  }
  const footer = [
    "",
    `Each job's summary names the image and lists every finding. What to do: [Nightly image scan](${repositoryUrl}/blob/main/docs/Testing.md#nightly-image-scan).`,
    "This issue is updated by each failing scheduled or manual run on `main` and closed by the next passing one.",
  ].join("\n");
  // Whole cell sections only: cutting inside one could leave a code span open
  // and let a scanner value render as Markdown or a mention.
  const budget = ISSUE_BODY_LIMIT - lines.join("\n").length - footer.length - 200;
  let sections = "";
  let omitted = 0;
  for (const result of results) {
    const section = `\n${cellMarkdown(result, ISSUE_ROW_LIMIT, 3)}`;
    if (omitted === 0 && sections.length + section.length <= budget) sections += section;
    else omitted += 1;
  }
  if (omitted) sections += `\n${omitted} more failed ${omitted === 1 ? "image is" : "images are"} not shown here; the job summaries list every finding.\n`;
  return `${lines.join("\n")}\n${sections}${footer}\n`;
}

export function issueComment({ runUrl, sha, jobs }) {
  const names = failedJobs(jobs).map((job) => job.name);
  return `Still failing at ${code(sha)} in [this run](${runUrl})${names.length ? `: ${names.map(tableCell).join(", ")}` : ""}. The issue body shows the current findings.\n`;
}

function readFindings(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return scanFindings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function runCell(env) {
  const result = cellResult({
    image: env.CELL_IMAGE ?? "unknown image",
    source: env.CELL_SOURCE ?? "",
    target: env.CELL_TARGET ?? "",
    platform: env.CELL_PLATFORM ?? "",
    build: env.BUILD_OUTCOME ?? "",
    scan: env.SCAN_OUTCOME ?? "",
    smoke: env.SMOKE_OUTCOME ?? "",
    smokeRequired: env.SMOKE_REQUIRED === "true",
    findings: env.SCAN_OUTCOME === "failure" ? readFindings(env.FINDINGS_FILE) : [],
  });
  const markdown = cellMarkdown(result);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(markdown);
  if (!result.passed) {
    const reason = result.reasons[0] ?? "a check did not pass";
    process.stdout.write(`::error title=Image scan failed::${commandData(`${result.image} (${result.platform}): ${reason}`)}\n`);
    if (env.RESULT_FILE) {
      fs.mkdirSync(path.dirname(env.RESULT_FILE), { recursive: true });
      fs.writeFileSync(env.RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
    }
  }
}

function readJobs(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { jobs: [] };
  }
}

function main(argv, env) {
  const [command, ...args] = argv;
  if (command === "cell" && args.length === 0) return runCell(env);
  if (command === "issue" && args.length === 2) {
    process.stdout.write(issueBody({ repositoryUrl: env.REPOSITORY_URL, runUrl: env.RUN_URL, sha: env.SOURCE_SHA,
      jobs: readJobs(args[0]), results: readResults(args[1]) }));
    return;
  }
  if (command === "comment" && args.length === 1) {
    process.stdout.write(issueComment({ runUrl: env.RUN_URL, sha: env.SOURCE_SHA, jobs: readJobs(args[0]) }));
    return;
  }
  throw new Error("Usage: image-scan-report.mjs cell | issue <jobs.json> <results-dir> | comment <jobs.json>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env);
}
