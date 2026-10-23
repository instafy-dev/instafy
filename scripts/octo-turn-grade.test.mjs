import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REPO_ROOT,
  DEFAULT_CASES_FILE,
  EXPECT_KEYS,
  buildRollup,
  casesFileOfRun,
  caseMetrics,
  creditsQuery,
  datedLinesOf,
  detectLanguage,
  expectedCreditsOf,
  gradeCase,
  gradeRunDir,
  hasFilePaths,
  jobsQuery,
  jobsSettled,
  loadCases,
  markdownCell,
  rankRunOf,
  redactDeep,
  redactText,
  renderReport,
  renderTiming,
  replyIsQuestionOnly,
  replyStats,
  runLogOf,
  siteShapeOf,
  skillsOfCommand,
  statementsOf,
  stripSuggestionsBlock,
  timingOf,
  usageOf,
  validateCases,
} from "./octo-turn-grade.mjs";

const SENT = "2026-10-14T07:04:43.000Z";
const PROJECT = "1a0b2c12-f6dd-4a28-84b3-28bce3048bad";

function command(cmd, exit = 0, output = "") {
  return {
    type: "item.completed",
    item: { type: "command_execution", status: "completed", command: `/bin/bash -lc ${cmd}`, command_argv: ["/bin/bash", "-lc", cmd], exit_code: exit, aggregated_output: output },
  };
}

function job({ id = "job-1", role = null, parent = null, route = "direct", skills = [], commands = [], usage = [[9000, 120], [1_200_000, 11_000]], paths = ["planets/index.html", "planets/data.json"], summary = "The table compares all eight planets and sorts by any column. Moon counts change as new moons are confirmed. Open it from the card above.", completedAt = "2026-10-14T07:09:15.000Z", status = "completed", outcome = "succeeded", truncated = false, promptSections = { workspaceMemory: { chars: 50921 }, responseContract: { chars: 24118 } } } = {}) {
  const artifacts = [
    { kind: "codex/run-log", metadata: { truncated }, events: commands },
    { kind: "codex/prompt-context", metadata: { promptMode: "full", estimatedPromptTokens: 20035, promptSections } },
    { kind: "ai/task-usage", calls: usage.map(([input, output], i) => ({ phase: i === 0 ? "routing" : "main", usage: { input_tokens: input, output_tokens: output, cached_input_tokens: Math.floor(input / 2) } })) },
    { kind: "origin/apply", metadata: { paths } },
  ];
  if (route) artifacts.push({ kind: "agent/routing-preflight", route, selectedSkills: skills, confidence: 98, reason: "a page" });
  return { id, parentJobId: parent, planGroupId: parent ? "plan-1" : null, agentRole: role, status, outcome, createdAt: SENT, completedAt, summary, artifacts, modelLabel: "test-model" };
}

const BUILD_COMMANDS = [
  command("python3 -m http.server 4173 --directory planets &"),
  command("instafy preview check --port 4173"),
  command("instafy preview open --port 4173 --title Planets --json"),
];
// A skill folder in the space: any name works, nothing here is a real pack.
const SKILL = "page-builder";
const SKILL_COMMAND = command(`node .agents/skills/${SKILL}/scripts/build.mjs planets`);

const OPENED_UI = {
  previewsAvailable: true, previewsListed: 1, cardSeenMs: 208_000, cardCount: 1, pageSource: "card", opened: true,
  frameStatus: 200, siteReadyMs: 2200, siteTextChars: 900, externalLinks: 4, frameConsoleErrors: [],
  shape: { tableRows: 8, listItems: 0, orderedItems: 0, checkboxes: 0 }, siteText: "Mercury\nVenus",
};
const CHAT_UI = { previewsAvailable: true, previewsListed: 0, cardCount: 0, opened: false };

const TABLE_CASE = {
  id: "compare-table",
  kind: "table",
  expect: { route: "direct", siteRequired: true, siteShape: { tableRows: 8 }, mentionsUnverified: false },
  budget: { seconds: 600, cardSeconds: 300, inputTokens: 3_000_000, outputTokens: 60_000 },
};
const SKILL_CASE = { ...TABLE_CASE, id: "skill-table", expect: { ...TABLE_CASE.expect, skills: [SKILL] } };
const CHAT_CASE = {
  id: "negative-translate",
  kind: "negative",
  expect: { route: "direct", siteRequired: false },
  budget: { seconds: 180, inputTokens: 600_000, outputTokens: 10_000 },
};
const CHAT_USAGE = [[9000, 100], [100_000, 800]];
const chatTurn = (summary, extra = {}) => ({ sentAt: SENT, jobs: [job({ paths: [], usage: CHAT_USAGE, completedAt: "2026-10-14T07:05:30.000Z", summary, ...extra })], ui: CHAT_UI });
const built = (extra = {}, ui = OPENED_UI) => ({ sentAt: SENT, jobs: [job({ commands: BUILD_COMMANDS, ...extra })], ui });

const failed = (result) => result.checks.filter((c) => c.ok === false).map((c) => c.id);
const byId = (result, id) => result.checks.find((c) => c.id === id);

// ---------------------------------------------------------------------------------------------------------------
// Finding the page.

test("a direct turn whose page opened from its card passes every check", () => {
  const result = gradeCase(TABLE_CASE, built());
  assert.deepEqual(failed(result), []);
  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
  assert.equal(result.metrics.wallSec, 272);
  assert.equal(result.metrics.cardSec, 208);
  assert.equal(result.metrics.usage.input, 1_209_000);
  assert.equal(result.metrics.uiSummary.pageSource, "card");
});

test("a page case without a card or a page fails its musts and says what was written but not shown", () => {
  const result = gradeCase(TABLE_CASE, built({}, { previewsAvailable: true, previewsListed: 0, cardCount: 0, opened: false }));
  assert.equal(result.pass, false);
  for (const id of ["card_posted", "site_opens", "site_shape:tableRows"]) assert.ok(result.mustFailures.includes(id), id);
  assert.match(byId(result, "site_opens").detail, /no page found.*1 HTML file\(s\) written but not shown/);
});

test("a page found only through the space's previews opens, but the missing card still fails", () => {
  const ui = { ...OPENED_UI, cardCount: 0, cardSeenMs: undefined, pageSource: "previews" };
  const result = gradeCase(TABLE_CASE, built({}, ui));
  assert.equal(byId(result, "site_opens").ok, true);
  assert.match(byId(result, "site_opens").detail, /found through the previews/);
  assert.equal(byId(result, "site_shape:tableRows").ok, true);
  assert.deepEqual(result.mustFailures, ["card_posted"]);
});

test("on a server without site previews the card is n/a, and an unseen page still fails (fail closed)", () => {
  const result = gradeCase(TABLE_CASE, built({}, { previewsAvailable: false, previewsListed: 0, cardCount: 0, opened: false }));
  assert.equal(byId(result, "card_posted").ok, null);
  assert.match(byId(result, "card_posted").detail, /offers no site previews/);
  assert.equal(byId(result, "card_within_budget").ok, null);
  assert.ok(!result.mustFailures.includes("card_posted"));
  assert.ok(result.mustFailures.includes("site_opens"));
  assert.equal(result.pass, false);
});

test("a chat case fails when a page was shown or a file changed, and passes when it stayed in chat", () => {
  const reply = "Mandarin: 火车站在哪里？ (Huǒchēzhàn zài nǎlǐ?)\nJapanese: 駅はどこですか？ (Eki wa doko desu ka?)";
  const chat = gradeCase(CHAT_CASE, chatTurn(reply));
  assert.deepEqual(failed(chat), []);
  assert.equal(chat.pass, true);
  assert.equal(byId(chat, "reply_short"), undefined, "length rules only apply to replies that point at a page");
  assert.ok(gradeCase(CHAT_CASE, { ...chatTurn(reply), ui: { ...CHAT_UI, cardCount: 1 } }).mustFailures.includes("no_site"));
  assert.ok(gradeCase(CHAT_CASE, { ...chatTurn(reply), ui: { ...CHAT_UI, previewsListed: 1 } }).mustFailures.includes("no_site"), "a preview opened without a card is still a page");
  assert.ok(gradeCase(CHAT_CASE, chatTurn(reply, { commands: BUILD_COMMANDS })).mustFailures.includes("no_site"));
  const wrote = gradeCase(CHAT_CASE, chatTurn(reply, { paths: ["notes/station.md"] }));
  assert.deepEqual(wrote.mustFailures, ["no_file_changes"]);
  const allowed = { ...CHAT_CASE, expect: { ...CHAT_CASE.expect, allowFileChanges: true } };
  assert.equal(byId(gradeCase(allowed, chatTurn(reply, { paths: ["notes/station.md"] })), "no_file_changes"), undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// Skills: graded only in a space that has them.

test("a skill counts as used when a command runs something from its folder; searching or reading it does not", () => {
  assert.deepEqual([...skillsOfCommand(`node .agents/skills/${SKILL}/scripts/build.mjs x`)], [SKILL]);
  assert.deepEqual([...skillsOfCommand(`bash .agents/skills/a/run.sh && node .agents/skills/b/x.mjs`)].sort(), ["a", "b"]);
  assert.deepEqual([...skillsOfCommand(`rg -n build .agents/skills/${SKILL}/`)], []);
  assert.deepEqual([...skillsOfCommand(`cat .agents/skills/${SKILL}/SKILL.md`)], []);
  const result = gradeCase(SKILL_CASE, built({ commands: [SKILL_COMMAND, ...BUILD_COMMANDS] }));
  assert.equal(byId(result, `skill:${SKILL}`).ok, true, "used through its scripts even though the preflight did not select it");
});

test("skill checks apply only to skills the space has; an unknown skill list keeps the case's word", () => {
  const without = gradeCase(SKILL_CASE, { ...built(), spaceSkills: ["other-skill"] });
  assert.equal(byId(without, `skill:${SKILL}`).ok, null);
  assert.match(byId(without, `skill:${SKILL}`).detail, /this space has no page-builder skill/);
  assert.equal(byId(without, "prompt_carries_skills"), undefined);
  assert.equal(without.pass, true);
  const withIt = gradeCase(SKILL_CASE, { ...built(), spaceSkills: [SKILL] });
  assert.equal(byId(withIt, `skill:${SKILL}`).ok, false);
  assert.ok(withIt.mustFailures.includes(`skill:${SKILL}`));
  const unknown = gradeCase(SKILL_CASE, built());
  assert.equal(caseMetrics(built()).spaceSkills, null);
  assert.equal(byId(unknown, `skill:${SKILL}`).ok, false);

  const forbidding = { ...CHAT_CASE, expect: { ...CHAT_CASE.expect, forbiddenSkills: [SKILL] }, };
  const picked = chatTurn("Here are both translations of the sentence for you.", { skills: [SKILL] });
  assert.ok(gradeCase(forbidding, picked).mustFailures.includes(`not_skill:${SKILL}`));
  assert.equal(byId(gradeCase(forbidding, { ...picked, spaceSkills: [] }), `not_skill:${SKILL}`).ok, null);
  const anyOf = { ...TABLE_CASE, expect: { ...TABLE_CASE.expect, skillsAnyOf: ["a", "b"] } };
  assert.equal(byId(gradeCase(anyOf, { ...built(), spaceSkills: ["c"] }), "skill_any_of").ok, null);
  assert.equal(byId(gradeCase(anyOf, { ...built({ skills: ["b"] }), spaceSkills: ["b"] }), "skill_any_of").ok, true);
});

// ---------------------------------------------------------------------------------------------------------------
// Route, budgets, run log.

test("an expected team passes on workers even when the preflight said direct, and fails without them", () => {
  const TEAM = { ...TABLE_CASE, id: "team", expect: { ...TABLE_CASE.expect, route: "multi_agent_candidate", workersMin: 2, liveResearch: true } };
  const lead = job({ id: "lead", commands: [...BUILD_COMMANDS, command("curl -s https://nssdc.gsfc.nasa.gov/planetary/factsheet/")] });
  const workers = [job({ id: "w1", role: "worker", parent: "lead", route: null }), job({ id: "w2", role: "worker", parent: "lead", route: null })];
  const team = gradeCase(TEAM, { sentAt: SENT, jobs: [lead, ...workers], ui: OPENED_UI });
  assert.equal(byId(team, "route").ok, true);
  assert.equal(byId(team, "workers_spawned").ok, true);
  assert.equal(byId(team, "live_research").ok, true);
  const alone = gradeCase(TEAM, built());
  assert.ok(alone.mustFailures.includes("route"));
  assert.ok(alone.shouldFailures.includes("live_research"));
});

test("a direct expectation fails when workers were spawned", () => {
  const result = gradeCase(TABLE_CASE, { sentAt: SENT, jobs: [job({ commands: BUILD_COMMANDS }), job({ id: "w1", role: "worker", parent: "job-1", route: null })], ui: OPENED_UI });
  assert.ok(result.mustFailures.includes("route"));
});

test("budgets: over the token or time budget is a must failure", () => {
  const result = gradeCase(TABLE_CASE, built({ usage: [[9000, 120], [3_500_000, 70_000]], completedAt: "2026-10-14T07:16:00.000Z" }));
  for (const id of ["input_tokens_within_budget", "output_tokens_within_budget", "time_within_budget"]) assert.ok(result.mustFailures.includes(id), id);
});

test("usage is summed over every job of the turn", () => {
  const usage = usageOf([job(), job({ id: "w1", role: "worker", usage: [[500_000, 5_000]] })]);
  assert.equal(usage.input, 1_709_000);
  assert.equal(usage.output, 16_120);
  assert.equal(usage.byPhase.routing.input, 509_000);
});

test("a failed or timed-out turn fails job_succeeded", () => {
  assert.ok(gradeCase(TABLE_CASE, built({ status: "failed", outcome: "failed" })).mustFailures.includes("job_succeeded"));
  assert.ok(gradeCase(TABLE_CASE, { ...built(), timedOut: true }).mustFailures.includes("job_succeeded"));
});

test("runLogOf reads exit codes, preview commands and research commands", () => {
  const log = runLogOf([job({ commands: [command("curl -s https://example.org"), command("instafy preview check --port 4173", 1), command("instafy preview open --port 4173 --title X"), command("instafy browser open https://example.org"), command("http GET https://example.org/api"), command("python3 -m http.server 4173 &")] })]);
  assert.equal(log.commandCount, 6);
  assert.equal(log.failedCommands, 1);
  assert.equal(log.researchCommands, 3, "serving a page with http.server is not a lookup");
  assert.equal(log.previewCheckOk, false);
  assert.equal(log.previewOpenOk, true);
});

test("a truncated run log makes command-derived checks n/a instead of failing", () => {
  const RESEARCH = { ...TABLE_CASE, expect: { ...TABLE_CASE.expect, liveResearch: true } };
  const result = gradeCase(RESEARCH, built({ truncated: true, commands: [] }));
  assert.equal(byId(result, "live_research").ok, null);
  assert.equal(result.pass, true);
});

test("a lookup fails when it hands off to the browser card instead of fetching", () => {
  const LOOKUP = { ...CHAT_CASE, id: "lookup", expect: { ...CHAT_CASE.expect, noBrowserHandoff: true, minSources: 1 } };
  const handoff = { type: "item.completed", item: { type: "agent_message", text: '{"actions":[{"browserLocation":"auto","task":"Find the timetable","type":"request_browser"}],"files":[],"summary":"I\'ll look it up once the browser is available."}' } };
  const viaBrowser = gradeCase(LOOKUP, chatTurn("I'll look it up once the browser is available.", { commands: [handoff] }));
  assert.ok(viaBrowser.mustFailures.includes("no_browser_handoff"));
  assert.ok(viaBrowser.shouldFailures.includes("sources"));
  const fetched = gradeCase(LOOKUP, chatTurn("The fast train takes about 2 hours. Source: https://rail.example/timetable (retrieved today).", { commands: [command("curl -s https://rail.example/timetable")] }));
  assert.deepEqual(failed(fetched), []);
  // Quoting the action in skill text (a space after the colon) is not a handoff.
  assert.equal(byId(gradeCase(LOOKUP, chatTurn("Done here.", { commands: [command("cat SKILL.md", 0, '{ "type": "request_browser" }')] })), "no_browser_handoff").ok, true);
});

// ---------------------------------------------------------------------------------------------------------------
// The reply.

test("reply rules: internal URLs fail, place names with 'Tunnel' do not, dev details are flagged", () => {
  assert.equal(replyStats("Open http://localhost:4173/ to see it").forbidden, true);
  assert.equal(replyStats("Served at https://p-abc123def.preview.example.dev").forbidden, true);
  assert.equal(replyStats("The bus uses the Hsuehshan Tunnel to Yilan.").forbidden, false);
  assert.equal(replyStats("`planets/data.json` has the numbers.").devDetail, true);
  assert.equal(replyStats("The page validates successfully.").devDetail, true);
  assert.equal(replyStats("Prices aren’t verified yet.").flagsUnverified, true);
  const long = gradeCase(TABLE_CASE, built({ summary: Array.from({ length: 9 }, (_, i) => `Line ${i}.`).join("\n") }));
  assert.ok(long.shouldFailures.includes("reply_short"));
  assert.equal(long.pass, true, "reply style is a should, not a must");
});

test("an answer is judged on saying something, not on its length (a right 143-character answer passes)", () => {
  const ANSWER = { ...CHAT_CASE, id: "plain-answer", kind: "answer", expect: { route: "direct", siteRequired: false, replyAnswers: true, replyNotQuestionOnly: true } };
  const short = "A heat pump pulls what little heat is still in the outdoor air into a refrigerant, then compresses it to make it hot enough to warm your house.";
  assert.equal(short.length, 143);
  assert.deepEqual(failed(gradeCase(ANSWER, chatTurn(short))), []);
  const asked = gradeCase(ANSWER, chatTurn("Do you mean an air-source or a ground-source heat pump?"));
  assert.ok(asked.mustFailures.includes("reply_answers"));
  assert.ok(asked.mustFailures.includes("reply_not_question_only"));
  assert.ok(gradeCase(ANSWER, chatTurn("Sure! Happy to help.")).mustFailures.includes("reply_answers"));
  assert.equal(statementsOf("Es una bomba que mueve el calor de fuera hacia dentro."), 1);
  assert.equal(statementsOf("热泵把室外空气中的热量搬到室内。"), 1, "a CJK character counts as a word");
  assert.equal(statementsOf("It costs 3.5 dollars at most stores in town."), 1, "a decimal point does not end a sentence");
  assert.equal(statementsOf("Want me to add a diagram of the cycle for you?"), 0);
});

test("a build that only asks fails by default; chat cases are only checked when they opt in", () => {
  const plan = { ...TABLE_CASE, expect: { route: "direct", siteRequired: true, siteShape: { datedItems: 6 } } };
  const asked = gradeCase(plan, built({ summary: "When are you moving? How big is the flat? Who is helping?" }, { cardCount: 0 }));
  assert.ok(asked.mustFailures.includes("reply_not_question_only"));
  const optOut = { ...TABLE_CASE, expect: { ...TABLE_CASE.expect, replyNotQuestionOnly: false } };
  assert.equal(byId(gradeCase(optOut, built({ summary: "Which city?" })), "reply_not_question_only"), undefined);
  const silent = gradeCase(plan, built({ summary: "" }, { cardCount: 0 }));
  assert.ok(silent.mustFailures.includes("reply_present"));
  assert.equal(byId(silent, "reply_not_question_only"), undefined, "no reply fails once, as reply_present");
  // A translation of a question is not a question to the user.
  assert.equal(byId(gradeCase(CHAT_CASE, chatTurn("Mandarin: 火車站在哪裡?\nJapanese: 駅はどこですか?")), "reply_not_question_only"), undefined);
  // a result and an offer is not a question-only reply, in any language
  assert.equal(replyIsQuestionOnly(replyStats("Built your moving checklist: 24 items in 5 groups. Want me to add due dates?")), false);
  assert.equal(replyIsQuestionOnly(replyStats("Listo: tu lista de mudanza con 24 tareas. ¿Quieres que añada fechas?")), false);
  assert.equal(replyIsQuestionOnly(replyStats("A suggested route: Lisbon 4, Porto 3. Who's going? Beaches?")), true);
});

test("a vague ask is built on a stated Assumed: line", () => {
  const VAGUE = { ...TABLE_CASE, expect: { route: "direct", siteRequired: true, replyAssumed: true } };
  assert.equal(byId(gradeCase(VAGUE, built({ summary: "Your timeline is ready. Assumed: a one-bedroom flat, moving 30 Nov." })), "reply_assumed").ok, true);
  assert.ok(gradeCase(VAGUE, built({ summary: "Your timeline is ready. Open it from the card above." })).mustFailures.includes("reply_assumed"));
});

test("file paths in a reply fail as a must; links, Node.js and ordinary prose do not", () => {
  assert.equal(hasFilePaths("I saved it to `notes/plan.json`."), true);
  assert.equal(hasFilePaths("The page is in planets/index.html"), true);
  assert.equal(hasFilePaths("Edit data.json to change it"), true);
  assert.equal(hasFilePaths("Written to /workspace/page"), true);
  assert.equal(hasFilePaths("It lives in src/moving-timeline now."), true, "a slug after a workspace folder");
  assert.equal(hasFilePaths("Run `fetch.py` again."), true, "a file name in backticks");
  assert.equal(hasFilePaths("Source: https://data.example.org/planets.json and https://en.wikipedia.org/wiki/Planet"), false);
  assert.equal(hasFilePaths("Built with Node.js; the Hsuehshan Tunnel is 12.9 km and/or longer."), false);
  for (const prose of ["I compared booking sites/apps for you.", "Visit linear.sh for the tracker.", "Export it from the page as tasks.csv.", "The script is run.py on their site."]) {
    assert.equal(hasFilePaths(prose), false, prose);
  }
  assert.ok(gradeCase(CHAT_CASE, chatTurn("Done. See notes.md for the draft.")).mustFailures.includes("reply_no_file_paths"));
  const allow = { ...CHAT_CASE, expect: { ...CHAT_CASE.expect, allowFilePaths: true } };
  assert.equal(byId(gradeCase(allow, chatTurn("See notes.md")), "reply_no_file_paths"), undefined);
});

test("the trailing suggestions block is chips, not reply text", () => {
  const reply = "Your timeline is ready: six weeks, one step a day. Assumed: a one-bedroom flat, moving 30 Nov.\n```suggestions\nMake it four weeks?\nAdd a packing list?\n```";
  assert.equal(stripSuggestionsBlock(reply), "Your timeline is ready: six weeks, one step a day. Assumed: a one-bedroom flat, moving 30 Nov.");
  const stats = replyStats(reply);
  assert.equal(stats.questions, 0);
  assert.equal(stats.lines, 1);
  assert.equal(stripSuggestionsBlock("No chips here."), "No chips here.");
  // a block in the middle is not the trailing chips: the text after it is still graded
  assert.equal(stripSuggestionsBlock("Done.\n```suggestions\nA\n```\nMore text after"), "Done.\n```suggestions\nA\n```\nMore text after");
});

test("languages are told apart by their function words; short text is unknown", () => {
  assert.equal(detectLanguage("Aquí tienes tu plan de comidas para la semana, con la lista de la compra y las cantidades para dos personas.").language, "es");
  assert.equal(detectLanguage("Här är en promenad genom Haga och Linné med fem fikaställen, och det tar ungefär två timmar.").language, "sv");
  assert.equal(detectLanguage("Here is your plan for the week, with a shopping list and the amounts for two people.").language, "en");
  assert.equal(detectLanguage("Lunes: lentejas").language, null);
  // one-letter words count for no language ("a", "e", "o", "y", "i" are words in several)
  assert.equal(detectLanguage("a e o y i a e o y i").language, null);
});

test("a Spanish ask answered in English fails reply_language; the page's language is a should", () => {
  const es = loadCases().find((c) => c.expect.language === "es");
  const ui = { ...OPENED_UI, shape: { tableRows: 7, listItems: 20, orderedItems: 0, checkboxes: 0 }, siteText: "Lunes: lentejas con arroz y la ensalada de tomate para la cena, con pan." };
  const english = gradeCase(es, built({ summary: "Your vegetarian meal plan is ready, with a shopping list for the week. Open it from the card above." }, ui));
  assert.ok(english.mustFailures.includes("reply_language"));
  const spanish = gradeCase(es, built({ summary: "Tu plan de comidas vegetarianas está listo, con la lista de la compra para toda la semana. Ábrelo desde la tarjeta de arriba." }, ui));
  assert.equal(byId(spanish, "reply_language").ok, true);
  assert.equal(byId(spanish, "site_language").ok, true);
  assert.equal(byId(spanish, "site_language").severity, "should");
  // a correct reply too short to tell is not failed: the check is n/a
  const brief = gradeCase(es, built({ summary: "¡Hecho! Plan semanal vegetariano y lista de compras." }, ui));
  assert.equal(byId(brief, "reply_language").ok, null);
  assert.ok(!brief.mustFailures.includes("reply_language"));
});

// ---------------------------------------------------------------------------------------------------------------
// The page.

test("a ranking is read from line-leading numbers in order, however the page lays it out", () => {
  assert.equal(rankRunOf("Rank\tBuilding\tHeight\n1\tBurj Khalifa\t828 m\n2\tMerdeka 118\t679 m\n3\tShanghai Tower\t632 m"), 3);
  assert.equal(rankRunOf("#1 Burj Khalifa\n828 m · Dubai\n#2 Merdeka 118\n679 m\n#3 Shanghai Tower"), 3);
  assert.equal(rankRunOf("1\nBurj Khalifa\n828\n2\nMerdeka 118\n2010"), 2, "a height or a year on its own line is not a rank");
  assert.equal(rankRunOf("1. Pack\n3. Drive\n7. Swim"), 1, "numbers out of order are not a ranking");
  assert.equal(rankRunOf("Opened in 2010. Height 828 m."), 0);
  assert.equal(rankRunOf("1 Burj Khalifa\n2 Merdeka 118\n3 Shanghai Tower"), 3, "a bare space before a name");
  assert.equal(rankRunOf("1 cup flour\n2 eggs\n3 tbsp sugar"), 0, "a recipe's amounts are not a ranking");
});

test("dated lines count weeks, dates and countdowns, not plain numbers", () => {
  const timeline = "Week 1: book movers\nWeek 2 – declutter\nOct 26 · change address\n2 weeks before: pack books\n3 Nov: keys\n2026-11-04 move day\nBoxes: 30\nT-3 days: defrost the freezer";
  assert.equal(datedLinesOf(timeline), 7);
  assert.equal(datedLinesOf("1/2 cup oats\n3/4 tsp salt\nAdd them if you may 5 minutes later"), 0, "fractions and \"may\" are not dates");
  assert.equal(datedLinesOf("10/26/2026: movers\nMay 5: keys"), 2);
  assert.equal(datedLinesOf("Tent\nSleeping bag x2\n1.5 l water"), 0);
});

test("siteShapeOf combines what the browser counted with the page text", () => {
  const shape = siteShapeOf({ shape: { tableRows: 8, listItems: 3, orderedItems: 0, checkboxes: 0 }, siteText: "1\tMercury\n2\tVenus\n3\tEarth" });
  assert.deepEqual(shape, { tableRows: 8, listItems: 3, orderedItems: 0, rankedItems: 3, checkboxes: 0, datedItems: 0, items: 8 });
  assert.deepEqual(siteShapeOf({}), { tableRows: 0, listItems: 0, orderedItems: 0, rankedItems: 0, checkboxes: 0, datedItems: 0, items: 0 });
});

test("a page of the wrong kind fails its site shape as a must; the right kind passes", () => {
  const checklist = { ...TABLE_CASE, expect: { route: "direct", siteRequired: true, siteShape: { checkboxes: 10 } } };
  const ticks = gradeCase(checklist, built({}, { ...OPENED_UI, shape: { tableRows: 0, listItems: 24, orderedItems: 0, checkboxes: 24 } }));
  assert.equal(byId(ticks, "site_shape:checkboxes").ok, true);
  assert.equal(ticks.pass, true, ticks.mustFailures.join(","));
  const bullets = gradeCase(checklist, built({}, { ...OPENED_UI, shape: { tableRows: 0, listItems: 24, orderedItems: 0, checkboxes: 0 } }));
  assert.ok(bullets.mustFailures.includes("site_shape:checkboxes"), "a bullet list is not a checklist");
  const notOpened = gradeCase(checklist, built({}, { cardCount: 1, opened: false, shape: { checkboxes: 24 } }));
  assert.ok(notOpened.mustFailures.includes("site_shape:checkboxes"));
});

test("a map built with any map library is ready once its container rendered", () => {
  const MAP = { ...TABLE_CASE, expect: { route: "direct", siteRequired: true, map: true } };
  assert.equal(byId(gradeCase(MAP, built({}, { ...OPENED_UI, mapEngine: "leaflet" })), "map_ready").ok, true);
  assert.equal(byId(gradeCase(MAP, built({}, { ...OPENED_UI, mapEngine: "maplibre" })), "map_ready").ok, true);
  assert.equal(byId(gradeCase(MAP, built({}, { ...OPENED_UI, mapEngine: null })), "map_ready").ok, false);
});

test("sources count the page or the reply, whichever has more", () => {
  const ranked = { ...TABLE_CASE, expect: { ...TABLE_CASE.expect, minSources: 3 } };
  const reply = "Ranked by height (sources: https://a.example/1 https://b.example/2 https://c.example/3). Open it from the card above.";
  assert.equal(byId(gradeCase(ranked, built({ summary: reply }, { ...OPENED_UI, externalLinks: 1 })), "sources").ok, true);
  assert.equal(byId(gradeCase(ranked, built({}, { ...OPENED_UI, externalLinks: 4 })), "sources").ok, true);
  const none = gradeCase(ranked, built({}, { ...OPENED_UI, externalLinks: 0 }));
  assert.equal(byId(none, "sources").ok, false);
  assert.equal(byId(none, "sources").severity, "should");
});

// ---------------------------------------------------------------------------------------------------------------
// Cost.

test("credits are checked against the tokens at the ledger's own rates", () => {
  // 1 USD = 100 credits; $1.25 per 1M uncached input, $0.125 cached, $10 output.
  const pricing = { billingUnitsPerUsd: 100, inputUsdMicrosPer1k: 1250, cachedInputUsdMicrosPer1k: 125, outputUsdMicrosPer1k: 10000 };
  // job(): 1,209,000 input (604,500 cached), 11,120 output → 755.625 + 75.5625 + 111.2 ≈ $0.9424 → 95 credits.
  const turn = [job({ commands: BUILD_COMMANDS })];
  assert.deepEqual(expectedCreditsOf(turn, pricing), { units: 95, billedJobs: 1, tolerance: 15 });
  assert.equal(expectedCreditsOf(turn, {}), null);
  assert.equal(expectedCreditsOf([job({ usage: [[10, 1]] })], pricing).units, 1, "a turn that cost anything costs at least 1 credit");
  const graded = (charged) => byId(gradeCase(TABLE_CASE, { sentAt: SENT, jobs: turn, ui: OPENED_UI, credits: { charged, entries: 2, pricing } }), "credits_match_tokens");
  assert.equal(graded(95).ok, true);
  assert.equal(graded(105).ok, true, "within the rounding tolerance");
  assert.equal(graded(1).ok, false, "a flat reserve for a million tokens is under-billed");
  assert.equal(graded(400).ok, false, "over-billed");
  assert.equal(graded(1).severity, "should");
  // Without the ledger's rates, only a heavy turn billed one credit is flagged.
  const heavy = { sentAt: SENT, jobs: [job({ usage: [[9000, 120], [4_200_000, 16_000]] })], ui: OPENED_UI };
  assert.equal(byId(gradeCase(TABLE_CASE, { ...heavy, credits: { charged: 1, entries: 1 } }), "credits_charged").ok, false);
  assert.equal(byId(gradeCase(TABLE_CASE, { ...heavy, credits: { charged: 109, entries: 6 } }), "credits_charged").ok, true);
  assert.equal(byId(gradeCase(TABLE_CASE, heavy), "credits_charged"), undefined, "no credits recorded: no check");
  assert.match(creditsQuery(PROJECT, SENT), /project_id = '1a0b2c12-f6dd-4a28-84b3-28bce3048bad'/);
  assert.match(creditsQuery(PROJECT, SENT), /metadata->'pricing'/);
  assert.throws(() => creditsQuery("x' or 1=1 --", SENT));
});

// ---------------------------------------------------------------------------------------------------------------
// Collection, cases, run files.

test("redaction removes capability hosts, tokens and secret fields", () => {
  assert.equal(redactText("https://p-7f3a9c2b1d.preview.localhost:8083/x"), "https://p-<label>:8083/x");
  assert.equal(redactText("bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.c2lnbmF0dXJlMTIz"), "bearer <jwt>");
  const deep = redactDeep({ password: "hunter2", nested: [{ accessToken: "x", url: "?token=abc&y=1" }] });
  assert.deepEqual(deep, { password: "<redacted>", nested: [{ accessToken: "<redacted>", url: "?token=<redacted>&y=1" }] });
});

test("jobsQuery only accepts a uuid and an ISO UTC timestamp", () => {
  assert.match(jobsQuery(PROJECT, SENT), /project_id = '1a0b2c12-/);
  assert.throws(() => jobsQuery("x'; drop table agent_jobs; --", SENT));
  assert.throws(() => jobsQuery(PROJECT, "2026-10-14' or 1=1 --"));
});

test("a lane the controller started again after a short rate limit does not fail the case; its retry's outcome counts", () => {
  const lead = job({ id: "lead" });
  const limited = { ...job({ id: "lane-1", role: "worker", parent: "lead", route: null, status: "failed", outcome: "failed" }),
    errorMessage: "rate limit exceeded (upstream_rate_limit, 429). Please try again in 6s." };
  const retry = { ...job({ id: "lane-1-retry", role: "worker", parent: "lead", route: null }),
    planRateLimitRetry: { of: "lane-1", waitMs: 6000, holdMs: 9000, reason: "upstream_rate_limit" } };
  const report = job({ id: "lead-2", role: "lead_continuation", parent: "lead", route: null });
  const metrics = (jobs) => caseMetrics({ ...built(), jobs });
  const m = metrics([lead, limited, retry, report]);
  assert.equal(m.failedJobs, 0, "the rate-limited run was started again and succeeded");
  assert.equal(m.retriedJobs, 1);
  assert.ok(m.jobStatuses.includes("worker:failed/failed (retried)"));
  // a retry that fails too, or a failed lane nobody retried, still fails the case
  assert.equal(metrics([lead, limited, { ...retry, status: "failed", outcome: "failed" }, report]).failedJobs, 1);
  assert.equal(metrics([lead, limited, report]).failedJobs, 1);
  assert.match(jobsQuery(PROJECT, SENT), /rateLimitRetry\}' as "planRateLimitRetry"/);
});

test("jobsSettled waits for terminal jobs and a quiet period", () => {
  const done = [{ status: "completed" }, { status: "failed" }];
  assert.equal(jobsSettled([], { lastChangeAt: 0, now: 100_000 }), false);
  assert.equal(jobsSettled([{ status: "leased" }], { lastChangeAt: 0, now: 100_000 }), false);
  assert.equal(jobsSettled(done, { lastChangeAt: 90_000, now: 100_000, quietMs: 20_000 }), false);
  assert.equal(jobsSettled(done, { lastChangeAt: 70_000, now: 100_000, quietMs: 20_000 }), true);
});

test("the default set covers one of each kind of ask and names no skill, pack or length", () => {
  const cases = loadCases();
  assert.deepEqual(validateCases(cases), []);
  const kinds = new Set(cases.map((c) => c.kind));
  for (const kind of ["map", "table", "list", "plan", "checklist", "answer", "negative"]) assert.ok(kinds.has(kind), `no ${kind} case`);
  assert.ok(cases.some((c) => c.expect.language && c.expect.language !== "en"), "no non-English ask");
  for (const c of cases) {
    assert.equal(c.expect.route, "direct", c.id);
    for (const key of ["skills", "skillsAnyOf", "forbiddenSkills"]) assert.equal(c.expect[key], undefined, `${c.id} names no skill (${key})`);
  }
  for (const c of cases.filter((c) => ["answer", "negative"].includes(c.kind))) assert.equal(c.expect.siteRequired, false, c.id);
  // Every case is graded on what the person gets, with no model: the page's kind, the answer, the language.
  const CONTENT = /^(site_shape:|map_ready$|no_site$|reply_answers$|reply_language$)/;
  for (const c of cases) {
    const ids = gradeCase(c, { sentAt: SENT, jobs: [], ui: {} }).checks.map((k) => k.id);
    assert.ok(ids.some((id) => CONTENT.test(id)), `${c.id} has no content check: ${ids.join(", ")}`);
    for (const id of ["reply_no_file_paths", "reply_no_internal_urls", "time_within_budget", "input_tokens_within_budget"]) {
      assert.ok(ids.includes(id), `${c.id} lacks ${id}`);
    }
    if (!c.expect.siteRequired) assert.ok(ids.includes("no_file_changes"), `${c.id} lacks no_file_changes`);
  }
});

test("validateCases rejects broken cases and expectations the grader does not have", () => {
  const problems = validateCases([
    { id: "a", prompt: "x", expect: { route: "team", siteRequired: true }, budget: { seconds: 1, inputTokens: 1, outputTokens: 1 } },
    { id: "a", prompt: "", expect: { route: "direct", siteRequired: false, map: true, skills: ["m"], forbiddenSkills: ["m"] }, budget: {} },
  ]);
  for (const text of ["expect.route", "duplicate id", "both expected and forbidden", "budget.seconds", "map case must require a site"]) {
    assert.ok(problems.some((p) => p.includes(text)), text);
  }
  const shaped = validateCases([
    { id: "b", prompt: "x", expect: { route: "direct", siteRequired: false, siteShape: { rows: 3, checkboxes: 0 }, language: "xx", minSources: 1.5, replyMinChars: 150, allowFileChanges: true }, budget: { seconds: 1, inputTokens: 1, outputTokens: 1, wall: 3 } },
  ]);
  for (const text of ["siteShape.rows is not one of", "siteShape.checkboxes must be a positive integer", "a site shape needs a site", "expect.language", "expect.minSources", "expect.replyMinChars is not a known expectation", "budget.wall is not a known budget"]) {
    assert.ok(shaped.some((p) => p.includes(text)), text);
  }
  assert.ok(validateCases([{ id: "c", prompt: "x", expect: { route: "direct", siteRequired: true, allowFileChanges: true }, budget: { seconds: 1, inputTokens: 1, outputTokens: 1 } }])
    .some((p) => p.includes("allowFileChanges is for chat cases")));
  assert.ok(EXPECT_KEYS.has("replyAnswers"));
});

test("gradeRunDir writes report.md, grade.json and a bench-rollup shaped rollup", () => {
  const pricing = { billingUnitsPerUsd: 100, inputUsdMicrosPer1k: 1250, cachedInputUsdMicrosPer1k: 125, outputUsdMicrosPer1k: 10000 };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-turn-"));
  const runDir = path.join(root, "runs", "run-1");
  const casesFile = path.join(root, "cases.json");
  fs.writeFileSync(casesFile, JSON.stringify({ cases: [TABLE_CASE, CHAT_CASE].map((c) => ({ ...c, prompt: "p" })) }));
  fs.mkdirSync(path.join(runDir, "cases", TABLE_CASE.id), { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId: "run-1", startedAt: SENT, caseIds: [TABLE_CASE.id, CHAT_CASE.id] }));
  fs.writeFileSync(path.join(runDir, "cases", TABLE_CASE.id, "evidence.json"), JSON.stringify({ ...built(), credits: { charged: 96, entries: 2, pricing }, spaceSkills: [SKILL] }));
  const { grade, reportPath, rollup } = gradeRunDir(runDir, { casesFile, rollupDir: path.join(root, "rollup") });
  assert.equal(grade.totals.cases, 2);
  assert.equal(grade.totals.passed, 1);
  assert.equal(grade.totals.credits, 96);
  assert.deepEqual(grade.results[1].mustFailures, ["no_evidence"]);
  const report = fs.readFileSync(reportPath, "utf8");
  assert.match(report, /1\/2 cases passed/);
  assert.match(report, /\| compare-table \| yes \|/);
  assert.match(report, /\| 96 \(95\) \|/);
  assert.match(report, /space skills: page-builder/);
  const rolled = JSON.parse(fs.readFileSync(rollup.jsonPath, "utf8"));
  assert.ok(rolled.generatedAt);
  assert.deepEqual(rolled.aggregates.map((a) => a.benchKey), ["octo-turn/compare-table", "octo-turn/negative-translate"]);
  assert.equal(rolled.aggregates[0].passRate, 1);
  assert.equal(rolled.aggregates[0].creditsMedian, 96);
  fs.rmSync(root, { recursive: true, force: true });
});

test("buildRollup takes medians across runs", () => {
  const grades = [1, 2, 3].map((n) => ({ runId: `r${n}`, gradedAt: `2026-10-1${n}T00:00:00Z`, results: [{ caseId: "c", pass: n !== 2, score: n / 3, mustFailures: [], shouldFailures: [], metrics: { wallSec: n * 100, usage: { input: n * 1000, output: n } } }] }));
  const [aggregate] = buildRollup(grades).aggregates;
  assert.equal(aggregate.runCount, 3);
  assert.equal(aggregate.wallMsMedian, 200_000);
  assert.equal(aggregate.inputTokensMedian, 2000);
  assert.equal(aggregate.latest.runId, "r3");
});

test("a run is regraded against the cases file it was made from, then the default set; an unknown case is reported", () => {
  assert.equal(casesFileOfRun({}), DEFAULT_CASES_FILE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-turn-"));
  const runDir = path.join(root, "runs", "run-1");
  const own = path.join(root, "own-cases.json");
  fs.writeFileSync(own, JSON.stringify({ cases: [{ ...SKILL_CASE, id: "own-table", prompt: "p" }] }));
  for (const id of ["own-table", "compare-table", "gone-case"]) {
    fs.mkdirSync(path.join(runDir, "cases", id), { recursive: true });
    fs.writeFileSync(path.join(runDir, "cases", id, "evidence.json"), JSON.stringify(built()));
  }
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId: "run-1", startedAt: SENT, caseIds: ["own-table", "compare-table", "gone-case"], casesFile: own }));
  const fromRun = gradeRunDir(runDir, { rollup: false }).grade;
  assert.ok(byId(fromRun.results[0], `skill:${SKILL}`), "graded with the run's own case");
  assert.ok(byId(fromRun.results[1], "site_shape:tableRows"), "then the default set");
  assert.deepEqual(fromRun.results[2].mustFailures, ["unknown_case"]);
  // An explicit --cases file is the only one used; a case that is in no file is reported, not dropped.
  const explicit = gradeRunDir(runDir, { casesFile: DEFAULT_CASES_FILE, rollup: false }).grade;
  assert.deepEqual(explicit.results.map((r) => r.mustFailures.includes("unknown_case")), [true, false, true]);
  assert.match(fs.readFileSync(path.join(runDir, "report.md"), "utf8"), /not in the cases file/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// The spec and its generality.

const BENCH = path.join(REPO_ROOT, "packages/frontend/tests/playwright/bench");

test("the eval stays opt-in and uses its own runner config", () => {
  const spec = fs.readFileSync(path.join(BENCH, "octo-turn-eval.spec.ts"), "utf8");
  assert.match(spec, /PLAYWRIGHT_RUN_BENCH === "1" && process\.env\.PLAYWRIGHT_OCTO_EVAL === "1"/);
  assert.match(spec, /test\.skip\(!ENABLED/);
  const config = fs.readFileSync(path.join(BENCH, "octo-turn-eval.config.ts"), "utf8");
  assert.doesNotMatch(config, /globalSetup|globalTeardown|webServer|runtime-cleanup-reporter/);
  for (const workflow of fs.readdirSync(path.join(REPO_ROOT, ".github/workflows"))) {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", workflow), "utf8");
    // The grader's own tests (this file) run in CI; the eval itself, which calls the real model, never does.
    assert.doesNotMatch(text, /PLAYWRIGHT_OCTO_EVAL|octo-turn-eval/, `${workflow} must not run the Octo turn eval`);
  }
});

test("the spec finds the page through Studio's own preview card and the controller's previews, and counts it generically", () => {
  const spec = fs.readFileSync(path.join(BENCH, "octo-turn-eval.spec.ts"), "utf8");
  for (const id of ["preview-ready-card", "preview-ready-open", "preview-ready-status", "site-preview-frame"]) assert.ok(spec.includes(`"${id}"`) || spec.includes(`=${id}]`), `spec uses ${id}`);
  assert.match(spec, /\/projects\/\$\{projectId\}\/previews`/);
  assert.match(spec, /\/view\?tab=true/);
  for (const field of ["ui.shape", "ui.siteText", "ui.mapEngine", "previewsAvailable", "previewsListed", "pageSource", "spaceSkills"]) assert.ok(spec.includes(field), `spec saves ${field}`);
  for (const selector of [".leaflet-container", ".maplibregl-map", "input[type=checkbox]"]) assert.ok(spec.includes(selector), `spec looks for ${selector}`);
  // The test ids the spec relies on exist in Studio.
  const studio = (file) => fs.readFileSync(path.join(REPO_ROOT, "packages/frontend/src/screens/studio/components", file), "utf8");
  assert.match(studio("SitePreviewCard.tsx"), /testId="preview-ready-card"/);
  assert.match(studio("SitePreviewCard.tsx"), /testId: "preview-ready-open"/);
  assert.match(studio("SitePreviewCard.tsx"), /data-testid="preview-ready-status"/);
  assert.match(studio("SitePreviewPane.tsx"), /data-testid="site-preview-frame"/);
});

test("the default cases need no particular skill: none expects, offers or forbids one", () => {
  for (const c of loadCases(DEFAULT_CASES_FILE)) {
    for (const key of ["skills", "skillsAnyOf", "forbiddenSkills"]) {
      assert.equal(c.expect?.[key], undefined, `${c.id} sets expect.${key}`);
    }
  }
});

test("a report cell keeps a backslash before a pipe from escaping the pipe", () => {
  assert.equal(markdownCell("a\\|b"), "a\\\\\\|b");
  assert.equal(markdownCell("x|y\nz"), "x\\|y z");
  assert.equal(markdownCell(null), "-");
});

// ---------------------------------------------------------------------------------------------------------------
// Where the time went, and turns that ran out of time.

const at = (s) => new Date(Date.parse(SENT) + s * 1000).toISOString();
function teamJobs() {
  const lead = { ...job({ id: "lead", route: "multi_agent_candidate" }), createdAt: at(0), leasedAt: at(1), completedAt: at(30) };
  const lane = (id, handle, end) => ({ ...job({ id, role: "worker", parent: "lead", route: null }), agentHandle: handle,
    createdAt: at(30), leasedAt: at(31), completedAt: at(end) });
  const timings = (commands, extra = {}) => ({ kind: "agent/turn-timings", commandMs: commands.reduce((a, c) => a + c.ms, 0), commands, ...extra });
  const first = { ...job({ id: "kyoto-1", role: "worker", parent: "lead", route: null, status: "failed", outcome: "failed" }),
    agentHandle: "kyoto", createdAt: at(30), leasedAt: at(31), completedAt: at(631), errorMessage: "Codex run timed out" };
  first.artifacts = [...first.artifacts,
    timings([{ command: "fetch-sources --all", ms: 900, status: "completed" }, { command: "wait-job sources-1", ms: 50_000, status: "completed" },
      { command: "summarize --timeout 240", ms: 240_000, status: "unfinished" }], { wrapUp: { atMs: 480_000, steered: true },
      steps: [{ step: "lodging", phase: "fetch", ms: 238_000 }, { step: "transit", phase: "fetch", ms: 108_000 }, { step: "total", phase: "total", ms: 560_000 }] }),
    { kind: "agent/turn-continuation", requested: true, endedBy: "time_limit", note: "summaries left" }];
  const second = { ...job({ id: "kyoto-2", role: "worker", parent: "lead", route: null }), agentHandle: "kyoto",
    planContinuation: { of: "kyoto-1", turn: 1, last: false }, createdAt: at(632), leasedAt: at(633), completedAt: at(733) };
  const report = { ...job({ id: "lead-2", role: "lead_continuation", parent: "lead", route: null }), createdAt: at(734), leasedAt: at(735), completedAt: at(755) };
  return [lead, lane("tokyo", "tokyo", 150), first, second, report];
}

test("a lane turn that ran out of time and was continued does not fail the case; the report says where its time went", () => {
  const m = caseMetrics({ sentAt: SENT, jobs: teamJobs(), ui: OPENED_UI });
  assert.equal(m.failedJobs, 0, "the stopped turn was continued");
  assert.ok(m.jobStatuses.includes("worker:failed/failed (continued)"));
  assert.equal(m.timing.timedOut, 1);
  assert.equal(m.timing.continuations, 1);
  assert.equal(m.timing.lanesSec, 700, "Kyoto's two turns");
  const first = m.timing.jobs.find((j) => j.handle === "kyoto" && j.turn === 0);
  assert.equal(first.wrapUpSec, 480);
  assert.equal(first.continuation, "time_limit");
  assert.deepEqual(first.slowest[0], { command: "summarize --timeout 240", sec: 240, status: "unfinished" });
  assert.deepEqual(first.steps.map((t) => t.step), ["lodging", "transit"], "the total is not a step");
  assert.equal(first.stepsTotalSec, 560);
  // a failed turn nobody continued still fails
  const jobs = teamJobs().filter((j) => j.id !== "kyoto-2");
  assert.equal(caseMetrics({ sentAt: SENT, jobs, ui: OPENED_UI }).failedJobs, 1);
  assert.equal(timingOf([]).jobs.length, 0);

  const grade = { runId: "r", gradedAt: SENT, totals: { passed: 1, cases: 1, inputTokens: 1, outputTokens: 1, credits: 1, wallSec: 1 },
    results: [{ caseId: "trip", pass: true, score: 1, mustFailures: [], shouldFailures: [], checks: [], metrics: { ...m, uiSummary: {} } }] };
  const report = renderReport(grade);
  assert.match(report, /- Time: slowest lane 700 s \(all its turns\); 1 job\(s\) stopped at the turn limit; 1 continuation\(s\)/);
  assert.match(report, /worker @kyoto: failed\/failed, waited 1 s, ran 600 s, commands 290\.9 s, wrap-up at 480 s, asked to continue \(time_limit\)/);
  assert.match(report, /slowest commands: summarize --timeout 240 240 s \(unfinished\)/);
  assert.match(report, /tool steps \(560 s in all\): lodging 238 s; transit 108 s/);
  assert.match(report, /worker @kyoto \(turn 2\): completed\/succeeded/);
});

test("a continuation turn's rate-limit retry is not another continuation, and a provider timeout is not the turn limit", () => {
  const jobs = teamJobs();
  const second = jobs.find((j) => j.id === "kyoto-2");
  second.status = "failed";
  second.outcome = "failed";
  second.errorMessage = "rate limit exceeded: upstream request timed out (429). Please try again in 7s.";
  const retry = { ...job({ id: "kyoto-2r", role: "worker", parent: "lead", route: null }), agentHandle: "kyoto",
    planContinuation: { of: "kyoto-1", turn: 1, last: false }, planRateLimitRetry: { of: "kyoto-2" },
    createdAt: at(740), leasedAt: at(748), completedAt: at(800) };
  const t = timingOf([...jobs, retry]);
  assert.equal(t.continuations, 1, "kyoto-2 only");
  assert.equal(t.timedOut, 1, "kyoto-1 only");
  assert.equal(t.lanesSec, 752, "Kyoto's three runs");
});

test("the jobs query reads the continuation and the agent", () => {
  const q = jobsQuery(PROJECT, SENT);
  for (const k of ['"planContinuation"', '"agentHandle"', '"turnRateLimitRetry"']) assert.ok(q.includes(k), k);
});

test("a lead turn put back in the queue after a short rate limit says so in its timing", () => {
  const lead = { ...job({ id: "lead" }), agentHandle: "octo", createdAt: at(0), leasedAt: at(45), completedAt: at(400),
    turnRateLimitRetry: { waitMs: 29010, holdMs: 31250, error: "rate limit exceeded (upstream_rate_limit, 429). Please try again in 29.01s." } };
  const t = timingOf([lead]);
  assert.equal(t.jobs[0].requeuedHoldSec, 31.3);
  assert.match(renderTiming(t).join("\n"), /lead @octo: completed\/succeeded, waited 45 s, ran 355 s, started again after a short rate limit \(held 31\.3 s\)/);
  assert.equal(timingOf([job({ id: "plain" })]).jobs[0].requeuedHoldSec, null);
});
