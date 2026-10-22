#!/usr/bin/env node
/**
 * Model-free grader for the Octo turn eval (docs/Octo-Turn-Eval.md).
 *
 * Reads what the eval spec saved for each case (the case's agent_jobs rows with their artifacts, the credit ledger,
 * and what the browser saw on the page Octo built, found through the space's site previews) and checks it against
 * the case's expectations in a cases file (default: octo-turn-cases.json). No model is called: every check is a rule
 * over the stored routing preflight, prompt context, task usage, run log, applied paths, credits, the reply and the
 * page's text and shape. Nothing assumes a particular skill pack: a check that names a skill is graded only when the
 * space has that skill.
 *
 * Usage:
 *   node scripts/octo-turn-grade.mjs <runDir> [--cases <file>] [--rollup-dir <dir>] [--no-rollup]
 *   node scripts/octo-turn-grade.mjs --check-cases [--cases <file>]
 *
 * Without --cases a run is graded against the cases file its run.json names, then the default set.
 *
 * Writes <runDir>/report.md and <runDir>/grade.json, then rebuilds tmp/bench-rollup/octo-turn-rollup.{json,md}
 * from every tmp/octo-turn/<run>/grade.json (the same {generatedAt, aggregates[{benchKey, runCount, records}]}
 * shape as the /learn bench rollup).
 *
 * Exit code: 0 when every graded case passed, 1 when any case failed, 2 on usage or input errors.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const BENCH_DIR = path.join(REPO_ROOT, "packages/frontend/tests/playwright/bench");
export const DEFAULT_CASES_FILE = path.join(BENCH_DIR, "octo-turn-cases.json");
export const DEFAULT_RUNS_DIR = path.join(REPO_ROOT, "tmp/octo-turn");
export const DEFAULT_ROLLUP_DIR = path.join(REPO_ROOT, "tmp/bench-rollup");
export const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);
export const ROUTES = new Set(["direct", "multi_agent_candidate", "cross_chat_lookup", "write_coordination_required"]);

// ---------------------------------------------------------------------------------------------------------------
// Redaction: the saved evidence and the report never carry capability hosts, tokens or keys.

const REDACTIONS = [
  [/\bp-[a-z0-9]{6,}[a-z0-9.-]*/gi, "p-<label>"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "<jwt>"],
  [/\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}/g, "<key>"],
  [/([?&](token|access_token|key|sig|signature|capability)=)[^&\s"']+/gi, "$1<redacted>"],
  [/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1<redacted>"],
];

export function redactText(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function redactDeep(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (/^(accessToken|refreshToken|password|localStorageValue|authorization|apiKey|secret)$/i.test(key)) {
        out[key] = "<redacted>";
      } else {
        out[key] = redactDeep(inner);
      }
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Collection from the local database (used by the eval spec; the grader itself only reads saved evidence).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function jobsQuery(projectId, sinceIso) {
  if (!UUID_RE.test(String(projectId))) throw new Error(`not a project uuid: ${projectId}`);
  if (!ISO_RE.test(String(sinceIso))) throw new Error(`not an ISO UTC timestamp: ${sinceIso}`);
  return `select coalesce(json_agg(j order by j."createdAt"), '[]'::json) from (
    select id, parent_job_id as "parentJobId", plan_group_id as "planGroupId", agent_role as "agentRole",
           status, outcome, intent, created_at as "createdAt", leased_at as "leasedAt", completed_at as "completedAt",
           summary, error_message as "errorMessage", artifacts,
           payload #> '{metadata,managedAiModelLabel}' as "modelLabel",
           payload #> '{metadata,multiAgentPlan,continuation}' as "planContinuation",
           payload #> '{metadata,multiAgentPlan,rateLimitRetry}' as "planRateLimitRetry",
           payload #>> '{metadata,agent,handle}' as "agentHandle"
    from agent_jobs where project_id = '${projectId}' and created_at >= '${sinceIso}') j`;
}

/** Credits the turn's project was charged since `sinceIso` (managed AI prompts and token adjustments, refunds
 *  netted), and the token rates the controller billed them at (the `pricing` it writes on each reconciled row).
 *  Same input checks as jobsQuery. */
export function creditsQuery(projectId, sinceIso) {
  jobsQuery(projectId, sinceIso);
  return `select json_build_object('charged', coalesce(-sum(delta), 0), 'entries', count(*),
      'pricing', (array_agg(metadata->'pricing' order by created_at desc) filter (where metadata ? 'pricing'))[1])
    from org_credit_ledger
    where project_id = '${projectId}' and created_at >= '${sinceIso}'
      and reason in ('managed_ai_prompt', 'managed_ai_adjustment', 'managed_ai_refund')`;
}

export function collectCredits({ projectId, sinceIso, dbUrl = process.env.OCTO_EVAL_DB_URL || DEFAULT_DB_URL }) {
  const out = execFileSync("psql", [dbUrl, "-tA", "-c", creditsQuery(projectId, sinceIso)], { encoding: "utf8" });
  return JSON.parse(out.trim() || "null");
}

export function collectJobs({ projectId, sinceIso, dbUrl = process.env.OCTO_EVAL_DB_URL || DEFAULT_DB_URL }) {
  const out = execFileSync("psql", [dbUrl, "-tA", "-c", jobsQuery(projectId, sinceIso)], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return redactDeep(JSON.parse(out.trim() || "[]"));
}

/** True when every job is terminal and nothing new appeared for `quietMs`.
 *  @param {{ status: string }[]} jobs @param {{ lastChangeAt?: number, now?: number, quietMs?: number }} [options] */
export function jobsSettled(jobs, { lastChangeAt, now = Date.now(), quietMs = 20_000 } = {}) {
  if (!jobs.length) return false;
  if (!jobs.every((job) => TERMINAL_JOB_STATUSES.has(job.status))) return false;
  return now - (lastChangeAt ?? 0) >= quietMs;
}

// ---------------------------------------------------------------------------------------------------------------
// Artifact readers.

export function artifactsOf(job, kind) {
  return (Array.isArray(job?.artifacts) ? job.artifacts : []).filter((artifact) => artifact?.kind === kind);
}

export function rootJob(jobs) {
  return jobs.find((job) => !job.parentJobId && job.agentRole !== "worker") ?? jobs[0] ?? null;
}

/** The job whose summary is the reply the user reads: the last completed non-worker job. */
export function replyJob(jobs) {
  const leads = jobs.filter((job) => job.agentRole !== "worker" && job.summary);
  return leads.at(-1) ?? rootJob(jobs);
}

export function preflightOf(job) {
  const artifact = artifactsOf(job, "agent/routing-preflight")[0];
  if (!artifact) return null;
  return {
    route: typeof artifact.route === "string" ? artifact.route : null,
    selectedSkills: Array.isArray(artifact.selectedSkills) ? artifact.selectedSkills.map(String) : [],
    confidence: typeof artifact.confidence === "number" ? artifact.confidence : null,
    reason: typeof artifact.reason === "string" ? artifact.reason : null,
    requiresWorkspaceFileChanges: artifact.requiresWorkspaceFileChanges === true,
  };
}

export function promptContextOf(job) {
  const meta = artifactsOf(job, "codex/prompt-context")[0]?.metadata;
  if (!meta) return null;
  const sections = meta.promptSections && typeof meta.promptSections === "object" ? meta.promptSections : {};
  return {
    promptMode: meta.promptMode ?? meta.mode ?? null,
    estimatedPromptTokens: meta.estimatedPromptTokens ?? null,
    sections: Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, value?.chars ?? 0])),
    finalOutputMode: meta.finalOutputMode?.mode ?? null,
  };
}

export function usageOf(jobs) {
  const total = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };
  const byPhase = {};
  let reported = false;
  for (const job of jobs) {
    for (const artifact of artifactsOf(job, "ai/task-usage")) {
      for (const call of artifact.calls ?? []) {
        const usage = call?.usage ?? {};
        reported = true;
        const phase = String(call?.phase ?? "unknown");
        const bucket = (byPhase[phase] ??= { input: 0, cachedInput: 0, output: 0 });
        const input = Number(usage.input_tokens ?? 0);
        const cached = Number(usage.cached_input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        total.input += input;
        total.cachedInput += cached;
        total.output += output;
        total.reasoningOutput += Number(usage.reasoning_output_tokens ?? 0);
        bucket.input += input;
        bucket.cachedInput += cached;
        bucket.output += output;
      }
    }
  }
  return { reported, ...total, byPhase };
}

const SEARCH_COMMAND_RE = /^\s*(rg|grep|find|fd|ls|cat\s+\S*SKILL\.md\s*$)\b/;

/** The skills one shell command used: it runs something from a skill's folder (`.agents/skills/<name>/`). Searching
 *  for a skill's files or reading only its SKILL.md is not using it. Exported for the tests. */
export function skillsOfCommand(command) {
  const used = new Set();
  if (SEARCH_COMMAND_RE.test(String(command))) return used;
  for (const match of String(command).matchAll(/\.agents\/skills\/([\w.-]+)\//g)) used.add(match[1]);
  return used;
}

// Looking something up live: an HTTP client (curl, wget, HTTPie's `http`), the CLI's browser or fetch commands, or
// fetch() in a script. Serving a page (`python3 -m http.server`) is not a lookup.
const RESEARCH_COMMAND_RE = /\b(curl|wget)\b|(?:^|[;&|]\s*)https?\s|\binstafy\s+(browser|fetch|web|search)\b|\bfetch\(/;

// A `request_browser` action in a turn's final output (the run log keeps it as compact JSON, often inside an
// escaped string). Skill text quoting the action has a space after the colon and does not match.
const BROWSER_HANDOFF_RE = /\\?"type\\?":\\?"request_browser\\?"/;

/** Whether any job of the turn handed the task to Studio's browser instead of doing it. */
export function browserHandoffOf(jobs) {
  return jobs.some((job) => artifactsOf(job, "codex/run-log").some((artifact) => BROWSER_HANDOFF_RE.test(JSON.stringify(artifact))));
}

/** Public https links in a reply (internal preview/tunnel/localhost URLs are not sources). */
export function replySourceLinks(text) {
  return [...new Set(String(text ?? "").match(/https:\/\/[^\s)>\]"'`]+/g) ?? [])]
    .filter((url) => !REPLY_FORBIDDEN_RE.test(url));
}

/** Commands, skills touched through commands, and research activity from every job's run log. */
export function runLogOf(jobs) {
  const commands = [];
  let truncated = false;
  let toolCalls = 0;
  for (const job of jobs) {
    for (const artifact of artifactsOf(job, "codex/run-log")) {
      if (artifact.metadata?.truncated) truncated = true;
      for (const event of artifact.events ?? []) {
        if (event?.type === "instafy.run_log.compacted" || event?.kind === "runtime/payload-array-truncated") {
          truncated = true;
        }
        if (event?.type === "tool.activity" && event.phase === "call") toolCalls += 1;
        const item = event?.item;
        if (event?.type !== "item.completed" || item?.type !== "command_execution") continue;
        const argv = Array.isArray(item.command_argv) ? item.command_argv : null;
        const command = String(argv?.at(-1) ?? item.command ?? "");
        commands.push({
          jobId: job.id,
          role: job.agentRole ?? "lead",
          command: redactText(command).slice(0, 400),
          exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
          output: redactText(String(item.aggregated_output ?? "")).slice(0, 600),
        });
      }
    }
  }
  const skillsUsed = new Set();
  for (const { command } of commands) for (const skill of skillsOfCommand(command)) skillsUsed.add(skill);
  const ok = (re) => commands.some((c) => re.test(c.command) && c.exitCode === 0);
  return {
    truncated,
    toolCalls,
    commandCount: commands.length,
    failedCommands: commands.filter((c) => c.exitCode !== null && c.exitCode !== 0).length,
    researchCommands: commands.filter((c) => RESEARCH_COMMAND_RE.test(c.command)).length,
    skillsUsed: [...skillsUsed].sort(),
    previewOpenOk: ok(/\binstafy\s+preview\s+open\b/),
    previewCheckOk: ok(/\binstafy\s+preview\s+check\b/),
    commands,
  };
}

export function appliedPathsOf(jobs) {
  const paths = new Set();
  for (const job of jobs) {
    for (const artifact of artifactsOf(job, "origin/apply")) {
      for (const p of artifact.metadata?.paths ?? []) paths.add(String(p));
    }
    for (const artifact of artifactsOf(job, "apply/files")) {
      for (const file of artifact.files ?? []) if (file?.path) paths.add(String(file.path));
    }
  }
  return [...paths].sort();
}

// ---------------------------------------------------------------------------------------------------------------
// Reply rules: what the person reads in chat.

const REPLY_FORBIDDEN_RE =
  /\blocalhost\b|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b|preview\.localhost|\bp-<label>|\bp-[a-z0-9]{6,}\b|\b[\w-]+\.tunnel\.|\btunnel (?:url|link|address)\b|:\d{4,5}\//i;
const REPLY_DEV_DETAIL_RE =
  /(?:^|[\s`(])[\w.-]+\/[\w./-]+\.(?:json|geojson|html|m?js|css|md|ts)\b|\bvalidat(?:e|es|ed|ion)\b/i;
const REPLY_UNVERIFIED_RE =
  /unverified|not verified|haven[’']?t verified|aren[’']?t verified|isn[’']?t verified|not (?:yet )?(?:checked|confirmed)|check (?:the |current |live )?(?:prices?|times?|timetables?|availability)|estimate|approximate/i;

const REPLY_ASSUMED_RE = /\bassumed(?:\*\*|_)?\s*:/i;

/** A reply that mostly asks: more than half its sentences are questions. "Built your checklist: 24 items. Want due
 *  dates?" is a result with an offer, not a question-only reply. */
export function replyIsQuestionOnly(stats) {
  return stats.questions > 0 && stats.questions * 2 > stats.sentences;
}

/** A reply's trailing ```suggestions block is one-tap chips, not text the user reads (Studio hides it). Only a block
 *  at the very end: one in the middle of a reply is left alone, so the text after it is still graded. */
export function stripSuggestionsBlock(text) {
  return String(text ?? "").replace(/\n?```suggestions[^\n]*\n(?:(?!```)[\s\S])*(?:```)?\s*$/, "").trimEnd();
}

const URL_RE = /\bhttps?:\/\/[^\s)>\]"'`]+/g;
// File and folder names a person should never read: a workspace folder with a path after it (src/app/,
// tmp/notes.json, .agents/skills), absolute workspace or home paths, a path ending in a file name, a bare file
// name with a code or data extension, or any file name in backticks. Links are removed first, so a source URL ending
// in .json is not a path; "Node.js" is not a file name, "booking sites/apps" is not a folder, and a bare name whose
// extension is also a domain or an export ("linear.sh", "tasks.csv", "run.py") is prose unless it is in backticks.
// A bare ".md" stays a path: in a reply it is almost always the agent's own notes file.
export const FILE_PATH_RE = new RegExp([
  String.raw`(?:^|[\s\x60'"(\[])(?:\.{1,2}\/)?(?:tmp|src|workspace|node_modules|\.agents|\.instafy|\.codex)\/(?:[\w.-]+\/|[\w-]+\.\w{1,8}\b|[a-z0-9]+(?:-[a-z0-9]+)+\b)`,
  String.raw`(?:^|[\s\x60'"(\[])\/(?:workspace|home|tmp|Users|var|opt|app)\/`,
  String.raw`\b[\w-]+(?:\/[\w.-]+)+\.(?:json|geojson|html?|m?js|cjs|tsx?|jsx|css|md|ya?ml|csv|py|sh)\b`,
  String.raw`\b[\w-]+\.(?:json|geojson|mjs|cjs|tsx?|jsx|ya?ml|md|html?|css)\b`,
  String.raw`\x60[\w.-]+\.(?:csv|py|sh|txt|js)\x60`,
].join("|"), "i");

/** Whether text shows a file or folder path (links excluded). */
export function hasFilePaths(text) {
  return FILE_PATH_RE.test(String(text ?? "").replace(URL_RE, " "));
}

// Short, common function words per language. Enough to tell which language a reply or page is written in; a text
// with fewer than LANGUAGE_MIN_HITS of them is too short to tell. No one-letter words: "a", "e", "o", "y" and "i" are
// words in several of these languages and made short texts tie or pick the wrong one.
const STOPWORDS = {
  en: "the and of to is in for with you your it this that are on be can or from at have will an",
  es: "el la los las de del en un que para con por una es se tu tus su puedes está más como lo al muy también",
  pt: "os as de do da dos das que em um para com uma não você seu sua mais como ao também muito",
  fr: "le la les et de des du en un que pour avec une est vous votre pas plus sur au aux ce cette dans",
  de: "der die das und zu den von mit für ist ein eine nicht sie du auf im dem des auch wir in",
  it: "il la gli le di della che per con un una non sono più come al anche questo nel alla in",
  nl: "de het een en van te dat in is voor met op niet je zijn ook aan bij naar",
  sv: "och att det som en ett är på för med av till inte du har kan om den vi",
};
const STOPWORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(" "))]));
export const LANGUAGES = new Set(Object.keys(STOPWORDS));
const LANGUAGE_MIN_HITS = 4;

/** The language a text is written in, by its function words; null when it is too short to tell. */
export function detectLanguage(text) {
  const words = String(text ?? "").replace(URL_RE, " ").toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = Object.fromEntries(Object.keys(STOPWORD_SETS).map((lang) => [lang, 0]));
  for (const word of words) for (const [lang, set] of Object.entries(STOPWORD_SETS)) if (set.has(word)) scores[lang] += 1;
  const [top, second] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (top[1] < LANGUAGE_MIN_HITS || top[1] === second[1]) return { language: null, hits: top[1], scores };
  return { language: top[0], hits: top[1], scores };
}

/** How many words a sentence needs to say something ("Sure!" or "Done." does not). A CJK character counts as a word. */
export const STATEMENT_MIN_WORDS = 6;
const WORD_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu;

/** The statements in a reply: sentences or lines that are not questions and have at least STATEMENT_MIN_WORDS words.
 *  Only what the reply says counts, not how long it is: a one-sentence answer to "keep it short" is an answer. */
export function statementsOf(text) {
  const body = stripSuggestionsBlock(text).replace(URL_RE, " ");
  return body.split(/(?<=[.!?])\s+|(?<=[。！？])|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !/[?？]\W*$/u.test(sentence))
    .filter((sentence) => (sentence.match(WORD_RE) ?? []).length >= STATEMENT_MIN_WORDS).length;
}

export function replyStats(text) {
  const body = stripSuggestionsBlock(text).trim();
  return {
    chars: body.length,
    lines: body ? body.split(/\r?\n/).filter((line) => line.trim()).length : 0,
    sentences: body ? body.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length : 0,
    forbidden: REPLY_FORBIDDEN_RE.test(body),
    devDetail: REPLY_DEV_DETAIL_RE.test(body),
    flagsUnverified: REPLY_UNVERIFIED_RE.test(body),
    // Questions put to the user: sentences that end in a question mark (ASCII or full-width).
    questions: body ? (body.match(/[?？](?=\s|$|\*|\))/g) ?? []).length : 0,
    // What a vague ask was built on, stated in one line ("Assumed: 2 adults, mid-range, …").
    assumedLine: REPLY_ASSUMED_RE.test(body),
    filePaths: hasFilePaths(body),
    statements: statementsOf(body),
    language: detectLanguage(body).language,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What kind of page the site is, from what the browser counted (ui.shape) and the page's own text (ui.siteText).

export const SITE_SHAPE_KEYS = ["tableRows", "listItems", "orderedItems", "rankedItems", "checkboxes", "datedItems", "items"];

/** The longest run 1, 2, 3, … of numbers that start lines ("1. Burj Khalifa", "#2 Merdeka 118", "3\tShanghai Tower"):
 *  a ranking, however it is laid out (ordered list, table, cards). */
export function rankRunOf(text) {
  let best = 0;
  let next = 1;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    // "1. Burj Khalifa", "#2 Merdeka 118", "3\tShanghai Tower", "1 Burj Khalifa"; not "1 cup flour" (a bare space needs a
    // capitalised name or a digit after it)
    const match = /^\s*(?:#\s?|No\.\s?)?(\d{1,3})(?:[.):\t]|\s+[\p{Lu}\d]|\s*$)/u.exec(line);
    if (!match) continue;
    const n = Number(match[1]);
    if (n === next) next += 1;
    else if (n === 1) next = 2;
    else continue;
    best = Math.max(best, next - 1);
  }
  return best;
}

// "may" is a month only as "May" (DATED_MAY_RE): "may 5 people come" is not a date
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATED_MAY_RE = /\bMay\.?\s+\d{1,2}\b|\b\d{1,2}\s+May\b/;
const DATED_RE = new RegExp([
  String.raw`\b\d{4}-\d{2}-\d{2}\b`,
  // "10/26/2026", not "1/2 cup" or "3/4 tsp": a bare N/N is a fraction
  String.raw`\b\d{1,2}\/\d{1,2}\/\d{2,4}\b`,
  String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}\b`,
  String.raw`\b\d{1,2}\s+(?:${MONTHS})\b`,
  String.raw`\b(?:week|wk|day|month)\s*\d{1,2}\b`,
  String.raw`\b\d{1,2}\s+(?:weeks?|days?|months?)\s+(?:before|after|out|ahead|to go|left)\b`,
  String.raw`\bT\s?[-−]\s?\d{1,3}\b`,
].join("|"), "i");

/** Lines of the page that carry a date or a step in time ("Week 2", "Oct 26", "2 weeks before"): a plan or timeline. */
export function datedLinesOf(text) {
  return String(text ?? "").split(/\r?\n/).filter((line) => DATED_RE.test(line) || DATED_MAY_RE.test(line)).length;
}

export function siteShapeOf(ui) {
  const shape = ui?.shape && typeof ui.shape === "object" ? ui.shape : {};
  const text = typeof ui?.siteText === "string" ? ui.siteText : "";
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const out = {
    tableRows: n(shape.tableRows),
    listItems: n(shape.listItems),
    orderedItems: n(shape.orderedItems),
    rankedItems: Math.max(n(shape.orderedItems), rankRunOf(text)),
    checkboxes: n(shape.checkboxes),
    datedItems: datedLinesOf(text),
  };
  out.items = Math.max(out.tableRows, out.listItems, out.rankedItems, out.checkboxes);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Cost: credits against tokens, at the rates the controller wrote on the ledger (credits.rs
// calculate_managed_ai_usage_charge: uncached input, cached input and output priced per 1k tokens, rounded up per
// turn, at least 1 credit for a turn that cost anything).

const costMicros = (tokens, microsPer1k) => (tokens > 0 && microsPer1k > 0 ? Math.ceil((tokens * microsPer1k) / 1000) : 0);

/** The credits a turn's jobs should have cost at `pricing`, job by job; null without usable rates. */
export function expectedCreditsOf(jobs, pricing) {
  const unitsPerUsd = Number(pricing?.billingUnitsPerUsd ?? 0);
  if (!(unitsPerUsd > 0)) return null;
  let units = 0;
  let billedJobs = 0;
  for (const job of jobs) {
    let input = 0;
    let cached = 0;
    let output = 0;
    let reported = false;
    for (const artifact of artifactsOf(job, "ai/task-usage")) {
      for (const call of artifact.calls ?? []) {
        reported = true;
        input += Number(call?.usage?.input_tokens ?? 0);
        cached += Number(call?.usage?.cached_input_tokens ?? 0);
        output += Number(call?.usage?.output_tokens ?? 0);
      }
    }
    if (!reported) continue;
    billedJobs += 1;
    cached = Math.min(cached, input);
    const micros = costMicros(input - cached, Number(pricing.inputUsdMicrosPer1k ?? 0))
      + costMicros(cached, Number(pricing.cachedInputUsdMicrosPer1k ?? 0))
      + costMicros(output, Number(pricing.outputUsdMicrosPer1k ?? 0));
    if (micros > 0) units += Math.max(1, Math.ceil((micros * unitsPerUsd) / 1_000_000));
  }
  return { units, billedJobs, tolerance: Math.max(billedJobs + 1, Math.ceil(units * 0.15)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Grading.

function check(checks, id, severity, ok, detail) {
  checks.push({ id, severity, ok, detail: detail === undefined ? null : String(detail) });
}

/** Jobs the controller started again after a short provider rate limit (`multiAgentPlan.rateLimitRetry.of`). */
export function retriedJobIdsOf(jobs) {
  return new Set(jobs.map((job) => job.planRateLimitRetry?.of).filter((id) => typeof id === "string"));
}

/** Jobs that ran out of turn time and were continued by a later turn (`multiAgentPlan.continuation.of`). */
export function continuedJobIdsOf(jobs) {
  return new Set(jobs.map((job) => job.planContinuation?.of).filter((id) => typeof id === "string"));
}

const secs = (ms) => (Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null);
const spanSec = (from, to) => { const a = Date.parse(from ?? ""), b = Date.parse(to ?? ""); return Number.isFinite(a) && Number.isFinite(b) ? secs(b - a) : null; };

/** Where a case's time went, from each job's lease and completion times and its `agent/turn-timings` artifact
 *  (every command's duration, the wrap-up, and the steps tools reported). */
export function timingOf(jobs) {
  const perJob = jobs.map((job) => {
    const timings = artifactsOf(job, "agent/turn-timings")[0] ?? null;
    const commands = Array.isArray(timings?.commands) ? timings.commands : [];
    const steps = Array.isArray(timings?.steps) ? timings.steps : [];
    return {
      role: job.agentRole ?? "lead",
      handle: job.agentHandle ?? null,
      turn: job.planContinuation?.turn ?? 0,
      status: `${job.status}/${job.outcome ?? "-"}`,
      timedOut: /timed out/i.test(job.errorMessage ?? ""),
      queueSec: spanSec(job.createdAt, job.leasedAt),
      wallSec: spanSec(job.leasedAt, job.completedAt),
      commandSec: timings ? secs(timings.commandMs) : null,
      wrapUpSec: timings?.wrapUp?.atMs != null ? secs(timings.wrapUp.atMs) : null,
      continuation: (artifactsOf(job, "agent/turn-continuation")[0] ?? null)?.endedBy ?? null,
      slowest: [...commands].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5)
        .map((c) => ({ command: redactText(String(c.command ?? "")).slice(0, 120), sec: secs(c.ms), status: c.status ?? null })),
      steps: steps.filter((t) => t.step !== "total" && t.phase !== "job").sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 8)
        .map((t) => ({ step: redactText(String(t.step ?? "")).slice(0, 80), phase: t.phase ?? null, sec: secs(t.ms) })),
      stepsTotalSec: secs(steps.find((t) => t.step === "total")?.ms),
    };
  });
  const lanes = perJob.filter((j) => j.role === "worker");
  return {
    timedOut: perJob.filter((j) => j.timedOut).length,
    continuations: jobs.filter((job) => job.planContinuation).length,
    lanesSec: lanes.length ? Math.max(...lanes.map((j) => j.wallSec ?? 0)) : null,
    jobs: perJob,
  };
}

export function caseMetrics(evidence) {
  const jobs = Array.isArray(evidence?.jobs) ? evidence.jobs : [];
  const root = rootJob(jobs);
  const reply = replyJob(jobs);
  const preflight = root ? preflightOf(root) : null;
  const promptContext = root ? promptContextOf(root) : null;
  const usage = usageOf(jobs);
  const runLog = runLogOf(jobs);
  const appliedPaths = appliedPathsOf(jobs);
  const workers = jobs.filter((job) => job.agentRole === "worker");
  const sentAt = evidence?.sentAt ? Date.parse(evidence.sentAt) : null;
  const completedTimes = jobs.map((job) => (job.completedAt ? Date.parse(job.completedAt) : null)).filter(Number.isFinite);
  const lastCompleted = completedTimes.length ? Math.max(...completedTimes) : null;
  const ui = evidence?.ui ?? {};
  const modelLabel = jobs.map((job) => job.modelLabel).find((label) => typeof label === "string" && label) ?? null;
  const replyText = reply?.summary ? stripSuggestionsBlock(redactText(reply.summary)) : "";
  // a turn that ran out of time and was continued by a later turn of the same agent did not fail the case, nor
  // did a run the controller started again after a short rate limit (the retry's own outcome counts instead)
  const continued = continuedJobIdsOf(jobs);
  const retried = retriedJobIdsOf(jobs);
  return {
    jobCount: jobs.length,
    jobStatuses: jobs.map((job) => `${job.agentRole ?? "lead"}:${job.status}/${job.outcome ?? "-"}${continued.has(job.id) ? " (continued)" : ""}${retried.has(job.id) ? " (retried)" : ""}`),
    allTerminal: jobs.length > 0 && jobs.every((job) => TERMINAL_JOB_STATUSES.has(job.status)),
    rootOutcome: root ? `${root.status}/${root.outcome ?? "-"}` : null,
    failedJobs: jobs.filter((job) => (job.status === "failed" || job.outcome === "failed") && !continued.has(job.id) && !retried.has(job.id)).length,
    retriedJobs: retried.size,
    timing: timingOf(jobs),
    modelLabel,
    route: preflight?.route ?? null,
    routeConfidence: preflight?.confidence ?? null,
    routeReason: preflight?.reason ?? null,
    selectedSkills: preflight?.selectedSkills ?? [],
    skillsUsed: runLog.skillsUsed,
    // The skills the space had (the spec lists its skills folder); null when it could not tell.
    spaceSkills: Array.isArray(evidence?.spaceSkills) ? evidence.spaceSkills.map(String) : null,
    workerJobs: workers.length,
    multiAgentObserved: workers.length > 0 || jobs.some((job) => job.planGroupId),
    promptMode: promptContext?.promptMode ?? null,
    promptSections: promptContext?.sections ?? {},
    estimatedPromptTokens: promptContext?.estimatedPromptTokens ?? null,
    usage,
    wallSec: sentAt && lastCompleted ? Math.round((lastCompleted - sentAt) / 100) / 10 : null,
    cardSec: typeof ui.cardSeenMs === "number" ? Math.round(ui.cardSeenMs / 100) / 10 : null,
    runLog: { ...runLog, commands: undefined },
    commands: runLog.commands,
    appliedPaths,
    builtPages: appliedPaths.filter((p) => /\.html?$/i.test(p)),
    reply: replyText,
    replyStats: replyStats(replyText),
    replySourceLinks: replySourceLinks(replyText),
    siteShape: siteShapeOf(ui),
    siteLanguage: typeof ui.siteText === "string" ? detectLanguage(ui.siteText).language : null,
    siteFilePaths: typeof ui.siteText === "string" ? hasFilePaths(ui.siteText) : null,
    credits: creditsOf(evidence, jobs, usage),
    browserHandoff: browserHandoffOf(jobs),
    ui,
    timedOut: evidence?.timedOut === true,
  };
}

/** What the turn was charged and what its tokens should have cost (null when the evidence has no credits). */
function creditsOf(evidence, jobs, usage) {
  const recorded = evidence?.credits;
  if (!recorded || typeof recorded.charged !== "number") return null;
  const expected = expectedCreditsOf(jobs, recorded.pricing);
  return {
    charged: recorded.charged,
    expected: expected?.units ?? null,
    tolerance: expected?.tolerance ?? null,
    perMillionInput: usage.input > 0 ? Math.round((recorded.charged / usage.input) * 1e6 * 10) / 10 : null,
  };
}

/** A check's result is `true`, `false` or `null` (n/a: it does not apply here). A case passes when no must is false. */
export function gradeCase(caseDef, evidence) {
  const expect = caseDef.expect ?? {};
  const budget = caseDef.budget ?? {};
  const m = caseMetrics(evidence);
  const checks = [];
  const skillsSeen = new Set([...m.selectedSkills, ...m.skillsUsed]);
  const ui = m.ui ?? {};

  check(checks, "job_succeeded", "must", m.allTerminal && !m.timedOut && m.rootOutcome === "completed/succeeded" && m.failedJobs === 0,
    `${m.jobStatuses.join(", ") || "no jobs"}${m.timedOut ? " (timed out)" : ""}`);

  if (expect.route) {
    const ok = expect.route === "multi_agent_candidate"
      ? m.route === "multi_agent_candidate" || m.multiAgentObserved
      : m.route === expect.route && !m.multiAgentObserved;
    // A team whose planning job stored no preflight still shows its route in the worker jobs that ran.
    const observedTeam = expect.route === "multi_agent_candidate" && !m.route && m.workerJobs > 0;
    check(checks, "route", "must", m.route || observedTeam ? ok : false,
      `expected ${expect.route}, preflight ${m.route ?? "missing"} (${m.routeConfidence ?? "?"}%), workers ${m.workerJobs}`);
  }
  if (expect.route === "multi_agent_candidate" && expect.workersMin) {
    check(checks, "workers_spawned", "should", m.workerJobs >= expect.workersMin, `${m.workerJobs} worker jobs, want >= ${expect.workersMin}`);
  }

  // A check about a skill applies only to a space that has the skill. When the spec could not list the space's skills,
  // the case's word is taken that the skill is there.
  const hasSkill = (skill) => m.spaceSkills === null || m.spaceSkills.includes(skill);
  const seen = `selected [${m.selectedSkills.join(", ")}], used [${m.skillsUsed.join(", ")}]`;
  const absent = (skills) => `this space has no ${skills.join(" or ")} skill`;
  for (const skill of expect.skills ?? []) {
    check(checks, `skill:${skill}`, "must", hasSkill(skill) ? skillsSeen.has(skill) : null, hasSkill(skill) ? seen : absent([skill]));
  }
  if (expect.skillsAnyOf?.length) {
    const offered = expect.skillsAnyOf.filter(hasSkill);
    check(checks, "skill_any_of", "must", offered.length ? offered.some((skill) => skillsSeen.has(skill)) : null,
      offered.length ? `want one of [${offered.join(", ")}]; ${seen}` : absent(expect.skillsAnyOf));
  }
  for (const skill of expect.forbiddenSkills ?? []) {
    check(checks, `not_skill:${skill}`, "must", hasSkill(skill) ? !skillsSeen.has(skill) : null, hasSkill(skill) ? seen : absent([skill]));
  }
  if ([...(expect.skills ?? []), ...(expect.skillsAnyOf ?? [])].some(hasSkill)) {
    const sections = m.promptSections;
    const carries = (sections.skillsIndex ?? 0) > 0 || (sections.routedWorkflowSkills ?? 0) > 0
      || (m.promptMode === "full" && (sections.workspaceMemory ?? 0) > 0);
    check(checks, "prompt_carries_skills", "should", m.promptMode ? carries : null,
      `mode ${m.promptMode ?? "?"}; sections ${Object.keys(sections).join(", ") || "none"}`);
  }

  const cards = ui.cardCount ?? 0;
  const listed = ui.previewsListed ?? 0;
  if (expect.siteRequired) {
    // A person finds the page on the card Octo posts. A server that offers no site previews cannot post one, so the
    // card is n/a there; the page still has to be found and opened (through the space's previews), or site_opens fails.
    const noPreviews = ui.previewsAvailable === false;
    check(checks, "card_posted", "must", noPreviews ? null : cards > 0,
      noPreviews ? "this server offers no site previews" : `cards ${cards}, previews listed ${listed}; preview open in run log: ${m.runLog.previewOpenOk}`);
    const siteOk = ui.opened === true && (ui.frameStatus == null || ui.frameStatus < 400) && (ui.siteTextChars ?? 0) > 0;
    const unseen = !ui.opened && m.builtPages.length ? `; ${m.builtPages.length} HTML file(s) written but not shown` : "";
    check(checks, "site_opens", "must", siteOk,
      `${ui.pageSource ? `found through the ${ui.pageSource}` : "no page found"}, opened ${ui.opened ?? false}, status ${ui.frameStatus ?? "?"}, text ${ui.siteTextChars ?? 0} chars, ready ${ui.siteReadyMs ?? "?"} ms${unseen}`);
    check(checks, "site_console_clean", "should", Array.isArray(ui.frameConsoleErrors) ? ui.frameConsoleErrors.length === 0 : null,
      `${(ui.frameConsoleErrors ?? []).length} console errors in the site`);
    if (budget.cardSeconds) {
      check(checks, "card_within_budget", "should", noPreviews ? null : m.cardSec == null ? false : m.cardSec <= budget.cardSeconds,
        `card at ${m.cardSec ?? "?"} s, budget ${budget.cardSeconds} s`);
    }
  } else if (expect.siteRequired === false) {
    check(checks, "no_site", "must", cards === 0 && listed === 0 && !m.runLog.previewOpenOk,
      `cards ${cards}, previews listed ${listed}, preview open in run log: ${m.runLog.previewOpenOk}`);
    if (!expect.allowFileChanges) {
      // A chat answer changes nothing in the space.
      check(checks, "no_file_changes", "must", m.appliedPaths.length === 0,
        m.appliedPaths.length ? `${m.appliedPaths.length} file(s) changed` : "none");
    }
  }
  if (expect.siteRequired && ui.opened) {
    check(checks, "site_no_file_paths", "should", m.siteFilePaths === null ? null : !m.siteFilePaths,
      m.siteFilePaths ? "the page shows a file or folder path" : m.siteFilePaths === null ? "page text not saved" : "clean");
  }
  for (const [key, min] of Object.entries(expect.siteShape ?? {})) {
    // The kind of page asked for: a table, a ranking, a checklist, a timeline. Counted, not judged.
    check(checks, `site_shape:${key}`, "must", ui.opened === true && m.siteShape[key] >= min,
      `${m.siteShape[key]} ${key}, want >= ${min}${ui.opened ? "" : " (site not opened)"}`);
  }
  if (expect.map) {
    // Any map library counts once its container rendered with a size.
    check(checks, "map_ready", "must", Boolean(ui.mapEngine), `engine ${ui.mapEngine ?? "none"} after ${ui.siteReadyMs ?? "?"} ms`);
  }
  if (expect.liveResearch) {
    check(checks, "live_research", "should", m.runLog.researchCommands > 0 ? true : m.runLog.truncated ? null : false,
      `${m.runLog.researchCommands} research commands`);
  }
  if (expect.minSources) {
    // Sources the person can follow: links on the page or in the reply, whichever has more.
    const links = Math.max(ui.externalLinks ?? 0, m.replySourceLinks.length);
    check(checks, "sources", "should", links >= expect.minSources,
      `${links} public https sources (page ${ui.externalLinks ?? 0}, reply ${m.replySourceLinks.length}); want >= ${expect.minSources}`);
  }
  // Turns are billed by tokens. With the ledger's rates the charge must match the tokens; without them, a flat
  // 1-credit charge for a heavy turn is still a billing bug.
  if (m.credits && m.credits.expected !== null && m.usage.reported) {
    const { charged, expected, tolerance } = m.credits;
    check(checks, "credits_match_tokens", "should", Math.abs(charged - expected) <= tolerance,
      `${charged} credits charged, ${expected} expected from ${m.usage.input} input (${m.usage.cachedInput} cached) and ${m.usage.output} output tokens at the ledger's rates (±${tolerance})`);
  } else if (evidence?.credits && typeof evidence.credits.charged === "number") {
    const heavy = m.usage.reported && m.usage.input > 500_000;
    check(checks, "credits_charged", "should", heavy ? evidence.credits.charged > 1 : evidence.credits.charged >= 0,
      `${evidence.credits.charged} credits for ${m.usage.input} input tokens`);
  }

  if (expect.noBrowserHandoff) {
    check(checks, "no_browser_handoff", "must", !m.browserHandoff,
      m.browserHandoff ? "emitted request_browser (a consent card) instead of fetching the page" : "fetched without a browser handoff");
  }

  check(checks, "reply_present", "must", m.replyStats.chars > 0, `${m.replyStats.chars} chars`);
  check(checks, "reply_no_internal_urls", "must", !m.replyStats.forbidden, m.replyStats.forbidden ? "localhost/preview/tunnel/p-label in reply" : "clean");
  if (!expect.allowFilePaths) {
    check(checks, "reply_no_file_paths", "must", !m.replyStats.filePaths, m.replyStats.filePaths ? "a file or folder path in the reply" : "clean");
  }
  if (expect.replyAnswers) {
    // An answer says something: at least one plain statement, however short the reply ("Keep it short" is honoured).
    check(checks, "reply_answers", "must", m.replyStats.statements > 0,
      `${m.replyStats.statements} statement(s) of ${STATEMENT_MIN_WORDS}+ words in ${m.replyStats.chars} chars`);
  }
  if (expect.language) {
    // A question asked in Spanish gets its answer in Spanish. A site reply is short by design: one too short to tell
    // is not graded (n/a), rather than failed.
    if (m.replyStats.language === null) check(checks, "reply_language", "should", null, `reply too short to tell, want ${expect.language}`);
    else check(checks, "reply_language", "must", m.replyStats.language === expect.language,
      `reply reads as ${m.replyStats.language}, want ${expect.language}`);
    if (expect.siteRequired && ui.opened) {
      check(checks, "site_language", "should", m.siteLanguage === null ? null : m.siteLanguage === expect.language,
        `page reads as ${m.siteLanguage ?? "unknown"}, want ${expect.language}`);
    }
  }
  if (expect.siteRequired) {
    const maxLines = expect.replyMaxLines ?? 6;
    const maxChars = expect.replyMaxChars ?? 1000;
    const short = Math.max(m.replyStats.lines, Math.ceil(m.replyStats.sentences / 2)) <= maxLines && m.replyStats.chars <= maxChars;
    check(checks, "reply_short", "should", short,
      `${m.replyStats.lines} lines, ${m.replyStats.sentences} sentences, ${m.replyStats.chars} chars (max ${maxLines} lines, ${maxChars} chars)`);
    check(checks, "reply_no_dev_details", "should", !m.replyStats.devDetail, m.replyStats.devDetail ? "a file path or 'validates' in the reply" : "clean");
  }
  // A build that only asks leaves the user with nothing; chat cases opt in. `replyNotQuestionOnly: false` opts out.
  // No reply at all already fails reply_present.
  if ((expect.replyNotQuestionOnly ?? expect.siteRequired === true) && m.replyStats.chars > 0) {
    // A vague ask is built on stated defaults; a reply that only asks leaves the user with nothing (minimize approvals).
    const questionOnly = replyIsQuestionOnly(m.replyStats);
    check(checks, "reply_not_question_only", "must", !questionOnly,
      `${m.replyStats.questions} question(s) in ${m.replyStats.sentences} sentences`);
  }
  if (expect.replyAssumed) {
    check(checks, "reply_assumed", "must", m.replyStats.assumedLine,
      m.replyStats.assumedLine ? "states what it assumed" : "no 'Assumed:' line in the reply");
  }
  if (expect.mentionsUnverified) {
    check(checks, "reply_flags_unverified", "should", m.replyStats.flagsUnverified, m.replyStats.flagsUnverified ? "says what is unverified" : "no unverified/estimate wording");
  }

  if (budget.seconds) {
    check(checks, "time_within_budget", "must", m.wallSec != null && m.wallSec <= budget.seconds, `${m.wallSec ?? "?"} s, budget ${budget.seconds} s`);
  }
  if (budget.inputTokens) {
    check(checks, "input_tokens_within_budget", "must", m.usage.reported && m.usage.input <= budget.inputTokens,
      `${m.usage.input} input (${m.usage.cachedInput} cached), budget ${budget.inputTokens}`);
  }
  if (budget.outputTokens) {
    check(checks, "output_tokens_within_budget", "must", m.usage.reported && m.usage.output <= budget.outputTokens,
      `${m.usage.output} output, budget ${budget.outputTokens}`);
  }

  const graded = checks.filter((c) => c.ok !== null);
  const passedCount = graded.filter((c) => c.ok).length;
  const mustFailures = checks.filter((c) => c.severity === "must" && c.ok === false).map((c) => c.id);
  return {
    caseId: caseDef.id,
    kind: caseDef.kind ?? null,
    tier: caseDef.tier ?? null,
    pass: mustFailures.length === 0,
    score: graded.length ? Math.round((passedCount / graded.length) * 1000) / 1000 : 0,
    mustFailures,
    shouldFailures: checks.filter((c) => c.severity === "should" && c.ok === false).map((c) => c.id),
    checks,
    metrics: { ...m, commands: undefined, ui: undefined, uiSummary: summarizeUi(ui) },
    commands: m.commands,
  };
}

function summarizeUi(ui) {
  return {
    previewsAvailable: ui.previewsAvailable ?? null,
    previewsListed: ui.previewsListed ?? 0,
    cardCount: ui.cardCount ?? 0,
    cardTitle: ui.cardTitle ?? null,
    cardState: ui.cardState ?? null,
    pageSource: ui.pageSource ?? null,
    opened: ui.opened ?? false,
    frameStatus: ui.frameStatus ?? null,
    siteReadyMs: ui.siteReadyMs ?? null,
    mapEngine: ui.mapEngine ?? null,
    shape: ui.shape ? siteShapeOf(ui) : null,
    siteTitle: ui.siteTitle ?? null,
    siteTextChars: ui.siteTextChars ?? 0,
    externalLinks: ui.externalLinks ?? 0,
    frameConsoleErrors: (ui.frameConsoleErrors ?? []).length,
    screenshot: ui.screenshot ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Run files, report and rollup.

export function loadCases(file = DEFAULT_CASES_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases)) throw new Error(`${file}: no cases array`);
  return cases;
}

/** Every key a case's `expect` and `budget` may hold: anything else is a typo or a rule this grader does not have. */
export const EXPECT_KEYS = new Set([
  "route", "siteRequired", "map", "siteShape", "minSources", "liveResearch", "noBrowserHandoff", "workersMin",
  "skills", "skillsAnyOf", "forbiddenSkills", "allowFilePaths", "allowFileChanges", "language", "replyAnswers",
  "replyAssumed", "replyNotQuestionOnly", "replyMaxLines", "replyMaxChars", "mentionsUnverified",
]);
export const BUDGET_KEYS = new Set(["seconds", "cardSeconds", "inputTokens", "outputTokens"]);

export function validateCases(cases) {
  const problems = [];
  const ids = new Set();
  for (const c of cases) {
    if (!c?.id || !/^[a-z0-9-]+$/.test(c.id)) problems.push(`bad id ${c?.id}`);
    if (ids.has(c.id)) problems.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!c.prompt || typeof c.prompt !== "string") problems.push(`${c.id}: missing prompt`);
    const e = c.expect ?? {};
    for (const key of Object.keys(e)) if (!EXPECT_KEYS.has(key)) problems.push(`${c.id}: expect.${key} is not a known expectation`);
    if (!ROUTES.has(e.route)) problems.push(`${c.id}: expect.route must be one of ${[...ROUTES].join("|")}`);
    if (typeof e.siteRequired !== "boolean") problems.push(`${c.id}: expect.siteRequired must be boolean`);
    for (const s of e.skills ?? []) if ((e.forbiddenSkills ?? []).includes(s)) problems.push(`${c.id}: ${s} both expected and forbidden`);
    const b = c.budget ?? {};
    for (const key of Object.keys(b)) if (!BUDGET_KEYS.has(key)) problems.push(`${c.id}: budget.${key} is not a known budget`);
    for (const key of ["seconds", "inputTokens", "outputTokens"]) {
      if (!(Number.isFinite(b[key]) && b[key] > 0)) problems.push(`${c.id}: budget.${key} must be a positive number`);
    }
    if (e.map && !e.siteRequired) problems.push(`${c.id}: a map case must require a site`);
    for (const [key, min] of Object.entries(e.siteShape ?? {})) {
      if (!SITE_SHAPE_KEYS.includes(key)) problems.push(`${c.id}: expect.siteShape.${key} is not one of ${SITE_SHAPE_KEYS.join("|")}`);
      if (!(Number.isInteger(min) && min > 0)) problems.push(`${c.id}: expect.siteShape.${key} must be a positive integer`);
    }
    if (e.siteShape && !e.siteRequired) problems.push(`${c.id}: a site shape needs a site`);
    if (e.allowFileChanges && e.siteRequired) problems.push(`${c.id}: allowFileChanges is for chat cases`);
    if (e.language !== undefined && !LANGUAGES.has(e.language)) problems.push(`${c.id}: expect.language must be one of ${[...LANGUAGES].join("|")}`);
    for (const key of ["minSources", "workersMin", "replyMaxLines", "replyMaxChars"]) {
      if (e[key] !== undefined && !(Number.isInteger(e[key]) && e[key] > 0)) problems.push(`${c.id}: expect.${key} must be a positive integer`);
    }
  }
  return problems;
}

export function readRun(runDir) {
  const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
  const casesDir = path.join(runDir, "cases");
  const evidence = {};
  for (const id of fs.existsSync(casesDir) ? fs.readdirSync(casesDir) : []) {
    const file = path.join(casesDir, id, "evidence.json");
    if (fs.existsSync(file)) evidence[id] = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return { run, evidence };
}

export function gradeRun({ run, evidence, cases }) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = [];
  for (const id of run.caseIds ?? Object.keys(evidence)) {
    const caseDef = byId.get(id);
    if (!caseDef) {
      // Graded against the wrong cases file: say so instead of reporting 0 cases.
      results.push({ caseId: id, kind: null, tier: null, pass: false, score: 0, mustFailures: ["unknown_case"], shouldFailures: [], checks: [], metrics: null });
      continue;
    }
    if (!evidence[id]) {
      results.push({ caseId: id, kind: caseDef.kind, tier: caseDef.tier, pass: false, score: 0, mustFailures: ["no_evidence"], shouldFailures: [], checks: [], metrics: null });
      continue;
    }
    results.push(gradeCase(caseDef, evidence[id]));
  }
  const totals = {
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    inputTokens: results.reduce((n, r) => n + (r.metrics?.usage?.input ?? 0), 0),
    outputTokens: results.reduce((n, r) => n + (r.metrics?.usage?.output ?? 0), 0),
    credits: results.reduce((n, r) => n + (r.metrics?.credits?.charged ?? 0), 0),
    wallSec: Math.round(results.reduce((n, r) => n + (r.metrics?.wallSec ?? 0), 0) * 10) / 10,
  };
  return { schema: "instafy.octo-turn-grade@1", runId: run.runId, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null, gradedAt: new Date().toISOString(), totals, results };
}

const fmtNum = (n) => (n == null || !Number.isFinite(n) ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
/** Text for one markdown table cell: backslashes and pipes escaped, line breaks flattened. */
export function markdownCell(s) {
  return String(s ?? "-").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
const cell = markdownCell;

export function renderReport(grade) {
  const lines = [];
  const t = grade.totals;
  lines.push(`# Octo turn eval: ${grade.runId}`, "");
  lines.push(`${t.passed}/${t.cases} cases passed. ${fmtNum(t.inputTokens)} input and ${fmtNum(t.outputTokens)} output tokens, ${t.credits ?? 0} credits, ${t.wallSec} s of turns. Graded ${grade.gradedAt} (no model).`, "");
  lines.push("| Case | Pass | Score | Route (conf.) | Skills selected / used | Wall s | Card s | Input | Output | Credits (expected) | Failed musts | Failed shoulds |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of grade.results) {
    const m = r.metrics ?? {};
    lines.push(`| ${cell(r.caseId)} | ${r.pass ? "yes" : "**no**"} | ${r.score} | ${cell(m.route)} (${m.routeConfidence ?? "-"}) | ${cell((m.selectedSkills ?? []).join(", "))} / ${cell((m.skillsUsed ?? []).join(", "))} | ${m.wallSec ?? "-"} | ${m.cardSec ?? "-"} | ${fmtNum(m.usage?.input)} | ${fmtNum(m.usage?.output)} | ${m.credits ? `${m.credits.charged} (${m.credits.expected ?? "-"})` : "-"} | ${cell(r.mustFailures.join(", ") || "none")} | ${cell(r.shouldFailures.join(", ") || "none")} |`);
  }
  for (const r of grade.results) {
    const m = r.metrics ?? {};
    lines.push("", `## ${r.caseId}`, "");
    if (!r.metrics) { lines.push(r.mustFailures.includes("unknown_case") ? "This case is not in the cases file it was graded against (pass --cases)." : "No evidence was saved for this case."); continue; }
    lines.push(`- Jobs: ${cell(m.jobStatuses.join(", "))}; model ${cell(m.modelLabel)}; prompt mode ${cell(m.promptMode)} (~${fmtNum(m.estimatedPromptTokens)} tokens)`);
    lines.push(`- Route reason: ${cell(m.routeReason)}`);
    lines.push(`- Commands: ${m.runLog.commandCount} (${m.runLog.failedCommands} failed), research ${m.runLog.researchCommands}, preview open ${m.runLog.previewOpenOk}, preview check ${m.runLog.previewCheckOk}${m.runLog.truncated ? ", run log truncated" : ""}`);
    lines.push(`- Site: ${cell(JSON.stringify(m.uiSummary))}`);
    lines.push(`- Applied paths: ${m.appliedPaths.length}${m.builtPages.length ? `, HTML pages ${m.builtPages.length}` : ""}; space skills: ${m.spaceSkills ? cell(m.spaceSkills.join(", ") || "none") : "not listed"}`);
    lines.push(...renderTiming(m.timing));
    lines.push("", "Reply:", "", ...String(m.reply || "(none)").split(/\r?\n/).map((l) => `> ${l}`), "");
    lines.push("| Check | Severity | Result | Detail |", "|---|---|---|---|");
    for (const c of r.checks) lines.push(`| ${cell(c.id)} | ${c.severity} | ${c.ok === null ? "n/a" : c.ok ? "pass" : "**fail**"} | ${cell(c.detail)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** "Where the time went": per job, its wait, its turn, its commands' share, the wrap-up and its slowest commands and
 *  tool steps. Empty for evidence without job times. */
export function renderTiming(timing) {
  if (!timing?.jobs?.length) return [];
  const lines = [`- Time: slowest lane ${timing.lanesSec ?? "-"} s; ${timing.timedOut} job(s) stopped at the turn limit; ${timing.continuations} continuation(s)`];
  for (const j of timing.jobs) {
    const head = `  - ${j.role}${j.handle ? ` @${j.handle}` : ""}${j.turn ? ` (turn ${j.turn + 1})` : ""}: ${j.status}, waited ${j.queueSec ?? "-"} s, ran ${j.wallSec ?? "-"} s`
      + `${j.commandSec != null ? `, commands ${j.commandSec} s` : ""}${j.wrapUpSec != null ? `, wrap-up at ${j.wrapUpSec} s` : ""}${j.continuation ? `, asked to continue (${j.continuation})` : ""}`;
    lines.push(cell(head).replace(/^ {2}- /, "  - "));
    if (j.slowest.length) lines.push(`    - slowest commands: ${cell(j.slowest.map((c) => `${c.command} ${c.sec} s${c.status === "unfinished" ? " (unfinished)" : ""}`).join("; "))}`);
    if (j.steps.length) lines.push(`    - tool steps${j.stepsTotalSec != null ? ` (${j.stepsTotalSec} s in all)` : ""}: ${cell(j.steps.map((t) => `${t.step} ${t.sec} s`).join("; "))}`);
  }
  return lines;
}

export function buildRollup(grades) {
  const byCase = new Map();
  for (const grade of grades) {
    for (const r of grade.results) {
      const bucket = byCase.get(r.caseId) ?? [];
      bucket.push({
        runId: grade.runId,
        updatedAt: grade.gradedAt,
        pass: r.pass,
        score: r.score,
        route: r.metrics?.route ?? null,
        selectedSkills: r.metrics?.selectedSkills ?? [],
        wallMs: r.metrics?.wallSec != null ? Math.round(r.metrics.wallSec * 1000) : null,
        cardMs: r.metrics?.cardSec != null ? Math.round(r.metrics.cardSec * 1000) : null,
        inputTokens: r.metrics?.usage?.input ?? null,
        outputTokens: r.metrics?.usage?.output ?? null,
        credits: r.metrics?.credits?.charged ?? null,
        mustFailures: r.mustFailures,
        shouldFailures: r.shouldFailures,
        modelLabel: r.metrics?.modelLabel ?? null,
      });
      byCase.set(r.caseId, bucket);
    }
  }
  const median = (values) => {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const aggregates = [...byCase.entries()].map(([caseId, records]) => {
    records.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    return {
      benchKey: `octo-turn/${caseId}`,
      runCount: records.length,
      passRate: records.filter((r) => r.pass).length / records.length,
      scoreMedian: median(records.map((r) => r.score)),
      wallMsMedian: median(records.map((r) => r.wallMs)),
      cardMsMedian: median(records.map((r) => r.cardMs)),
      inputTokensMedian: median(records.map((r) => r.inputTokens)),
      outputTokensMedian: median(records.map((r) => r.outputTokens)),
      creditsMedian: median(records.map((r) => r.credits)),
      latest: records.at(-1),
      records,
    };
  }).sort((a, b) => a.benchKey.localeCompare(b.benchKey));
  return { generatedAt: new Date().toISOString(), aggregates };
}

export function renderRollup(rollup) {
  const lines = ["# Octo turn eval rollup", "", `Generated ${rollup.generatedAt}.`, ""];
  lines.push("| Bench | Runs | Pass rate | Median score | Median wall | Median card | Median input | Median output | Median credits | Latest failures |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const a of rollup.aggregates) {
    const latest = a.latest ?? {};
    lines.push(`| ${a.benchKey} | ${a.runCount} | ${Math.round(a.passRate * 100)}% | ${a.scoreMedian ?? "-"} | ${a.wallMsMedian != null ? Math.round(a.wallMsMedian / 1000) + " s" : "-"} | ${a.cardMsMedian != null ? Math.round(a.cardMsMedian / 1000) + " s" : "-"} | ${fmtNum(a.inputTokensMedian)} | ${fmtNum(a.outputTokensMedian)} | ${a.creditsMedian ?? "-"} | ${cell([...(latest.mustFailures ?? []), ...(latest.shouldFailures ?? [])].join(", ") || "none")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeRollup({ runsDir = DEFAULT_RUNS_DIR, rollupDir = DEFAULT_ROLLUP_DIR } = {}) {
  const grades = [];
  for (const entry of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    const file = path.join(runsDir, entry, "grade.json");
    if (fs.existsSync(file)) {
      try { grades.push(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* skip a broken run */ }
    }
  }
  const rollup = buildRollup(grades);
  fs.mkdirSync(rollupDir, { recursive: true });
  const jsonPath = path.join(rollupDir, "octo-turn-rollup.json");
  const mdPath = path.join(rollupDir, "octo-turn-rollup.md");
  fs.writeFileSync(jsonPath, JSON.stringify(rollup, null, 2));
  fs.writeFileSync(mdPath, renderRollup(rollup));
  return { jsonPath, mdPath, rollup };
}

/** The cases file a run was made from (run.json's casesFile, relative to the repo), else the default set. */
export function casesFileOfRun(run) {
  return typeof run?.casesFile === "string" && run.casesFile ? path.resolve(REPO_ROOT, run.casesFile) : DEFAULT_CASES_FILE;
}

/** The cases to grade a run with: `casesFile` alone when given; else the run's own file, then the default set (a run
 *  whose cases file is gone still grades). The first file that has an id wins. */
export function casesForRun(run, casesFile = null) {
  if (casesFile) return loadCases(casesFile);
  const seen = new Set();
  const out = [];
  for (const file of [casesFileOfRun(run), DEFAULT_CASES_FILE]) {
    if (!fs.existsSync(file)) continue;
    for (const c of loadCases(file)) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

/** @param {string} runDir @param {{ casesFile?: string | null, rollup?: boolean, rollupDir?: string }} [options] */
export function gradeRunDir(runDir, { casesFile = null, rollup = true, rollupDir = DEFAULT_ROLLUP_DIR } = {}) {
  const { run, evidence } = readRun(runDir);
  const cases = casesForRun(run, casesFile);
  const grade = gradeRun({ run, evidence, cases });
  fs.writeFileSync(path.join(runDir, "grade.json"), JSON.stringify(grade, null, 2));
  fs.writeFileSync(path.join(runDir, "report.md"), renderReport(grade));
  const rolled = rollup ? writeRollup({ runsDir: path.dirname(path.resolve(runDir)), rollupDir }) : null;
  return { grade, reportPath: path.join(runDir, "report.md"), rollup: rolled };
}

function parseArgs(argv) {
  const options = { runDir: null, casesFile: null, rollup: true, rollupDir: DEFAULT_ROLLUP_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cases") options.casesFile = path.resolve(argv[++i]);
    else if (arg === "--rollup-dir") options.rollupDir = path.resolve(argv[++i]);
    else if (arg === "--no-rollup") options.rollup = false;
    else if (arg === "--check-cases") options.checkCases = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.runDir) options.runDir = path.resolve(arg);
    else throw new Error(`unexpected argument ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(String(error.message)); process.exit(2); }
  if (options.help || (!options.runDir && !options.checkCases)) {
    console.log("usage: node scripts/octo-turn-grade.mjs <runDir> [--cases <file>] [--rollup-dir <dir>] [--no-rollup]\n       node scripts/octo-turn-grade.mjs --check-cases [--cases <file>]");
    process.exit(options.help ? 0 : 2);
  }
  if (options.checkCases) {
    const files = [options.casesFile ?? DEFAULT_CASES_FILE];
    let bad = false;
    for (const file of files) {
      const cases = loadCases(file);
      const problems = validateCases(cases);
      if (problems.length) { bad = true; console.error(`${path.relative(REPO_ROOT, file)}:\n${problems.join("\n")}`); }
      else console.log(`cases ok: ${cases.length} in ${path.relative(REPO_ROOT, file)}`);
    }
    if (bad) process.exit(2);
    return;
  }
  const { grade, reportPath, rollup } = gradeRunDir(options.runDir, options);
  console.log(`${grade.totals.passed}/${grade.totals.cases} passed; report ${reportPath}${rollup ? `; rollup ${rollup.jsonPath}` : ""}`);
  process.exit(grade.totals.passed === grade.totals.cases ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
