//! The routing check: fixed messages, each with the chat it was sent in, and the route the
//! routing step should give each. A small change of wording in a skill, AGENTS.md, the run
//! instructions or a prompt section can move a route, and this shows it before the change
//! merges.
//!
//! Everything a case reads is the runtime's own: its routing input is built by the job's code
//! ([`super::routing_preflight_request`]) in a new space's folder holding the files this
//! checkout ships, it runs with the routing step's own run options and settings, and its answer
//! is read by the job's parser, as the job then acts on it. The command is the harness-less test
//! target `routing_check` (docs/Octo-Turn-Eval.md, "Routing check").

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, ensure};
use runtime_contracts::multi_agent::AgentRuntimeSettings;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use uuid::Uuid;

use super::{AgentRoutingPreflightRoute, learn};
use crate::codex::{CodexClient, CodexRunOptions};
use crate::controller::LeaseJob;
use crate::task_usage::{TaskUsage, UsagePhase};

/// The routes a routing answer can give, as its schema names them.
pub const ROUTES: &[&str] = &[
    "direct",
    "multi_agent_candidate",
    "cross_chat_lookup",
    "write_coordination_required",
    "browser",
    "browser_then_build",
];

/// What a routing answer can say a turn must change in the space.
const FILE_CHANGE_REQUIREMENTS: &[&str] = &["none", "conditional", "required"];

/// The browser skill, whose "Routing preflight" section says when a message goes straight to
/// Instafy's browser.
pub const BROWSER_SKILL: &str = ".agents/skills/instafy-browser-automation/SKILL.md";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseFile {
    /// What the file is, for whoever reads it.
    #[serde(rename = "about")]
    _about: Option<String>,
    cases: Vec<Case>,
}

/// A message, the chat it was sent in, and the route it should get.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Case {
    pub id: String,
    /// The person's message.
    pub message: String,
    /// The chat's earlier entries, as the runtime receives them in a job's
    /// `conversation_history`. The message is added after them.
    #[serde(default)]
    pub history: Vec<JsonValue>,
    pub expect: Expect,
    /// Why that route is right.
    pub why: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expect {
    pub route: String,
    /// When set, a run also needs one of these: what the turn after it must change in the space.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_file_change_requirement: Option<Vec<String>>,
}

impl Case {
    /// Whether a run's answer is the one this case expects.
    pub fn answered_by(&self, answer: &Answer) -> bool {
        answer.route == self.expect.route
            && self
                .expect
                .workspace_file_change_requirement
                .as_ref()
                .is_none_or(|allowed| {
                    answer
                        .workspace_file_change_requirement
                        .as_ref()
                        .is_some_and(|requirement| allowed.contains(requirement))
                })
    }

    /// The expected answer in a few words.
    pub fn expected(&self) -> String {
        match &self.expect.workspace_file_change_requirement {
            Some(allowed) => format!("{} (change: {})", self.expect.route, allowed.join(" or ")),
            None => self.expect.route.clone(),
        }
    }
}

fn is_case_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The cases of a case file, refused whole if one is not right.
pub fn parse_cases(text: &str) -> Result<Vec<Case>> {
    let file: CaseFile = serde_json::from_str(text).context("the case file is not valid")?;
    ensure!(!file.cases.is_empty(), "the case file has no cases");
    let mut ids = HashSet::new();
    for case in &file.cases {
        let id = &case.id;
        ensure!(
            is_case_id(id),
            "case id {id:?}: use lowercase letters, digits and dashes"
        );
        ensure!(ids.insert(id.as_str()), "case id {id} is used twice");
        ensure!(
            !case.message.trim().is_empty(),
            "case {id}: the message is empty"
        );
        ensure!(!case.why.trim().is_empty(), "case {id}: say why");
        ensure!(
            ROUTES.contains(&case.expect.route.as_str()),
            "case {id}: {:?} is not a route (one of {})",
            case.expect.route,
            ROUTES.join(", ")
        );
        if let Some(allowed) = &case.expect.workspace_file_change_requirement {
            ensure!(
                !allowed.is_empty()
                    && allowed
                        .iter()
                        .all(|value| FILE_CHANGE_REQUIREMENTS.contains(&value.as_str())),
                "case {id}: workspaceFileChangeRequirement takes {}",
                FILE_CHANGE_REQUIREMENTS.join(", ")
            );
        }
        for (index, entry) in case.history.iter().enumerate() {
            ensure!(
                matches!(
                    entry.get("role").and_then(JsonValue::as_str),
                    Some("user" | "assistant")
                ) && entry.get("content").is_some_and(JsonValue::is_string),
                "case {id}: history entry {index} needs a role (user or assistant) and a content"
            );
        }
    }
    Ok(file.cases)
}

pub fn load_cases(path: &Path) -> Result<Vec<Case>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    parse_cases(&text).with_context(|| format!("in {}", path.display()))
}

/// A new space's folder holding the files this checkout ships, as the runtime writes them.
pub fn prepare_workspace(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
    learn::ensure_project_memory_scaffold_in(dir, learn::ScaffoldScope::Local);
    ensure!(
        dir.join(BROWSER_SKILL).is_file(),
        "the space's files were not written in {}",
        dir.display()
    );
    Ok(())
}

/// The job the person's message makes in this chat, as the runtime leases it: their chat turn,
/// with the chat's entries and then the message itself.
fn case_job(case: &Case) -> LeaseJob {
    let mut history = case.history.clone();
    history.push(json!({"role": "user", "content": case.message, "runId": "run-latest"}));
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(Uuid::new_v4()),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(Uuid::new_v4()),
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": case.message,
            "conversation_history": history,
            "metadata": {},
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
        lease_attempts: 1,
        grants: Vec::new(),
        grant_token: None,
    }
}

/// What the routing step sends the model for a case.
#[derive(Debug, Clone)]
pub struct RoutingInput {
    /// The routing prompt, exactly as the job sends it.
    pub prompt: String,
    /// Whether the job offered the browser routes.
    pub browser_routes_offered: bool,
    /// The history projection's counts.
    pub history_metrics: JsonValue,
}

/// A case's routing input, built by the job's own code in `workspace`.
pub fn routing_input(case: &Case, workspace: &Path) -> Result<RoutingInput> {
    let job = case_job(case);
    ensure!(
        super::should_run_agent_routing_preflight_for_execution(&job, &case.message),
        "case {}: a turn would skip the routing step",
        case.id
    );
    let request = super::routing_preflight_request(&job, workspace, &case.message, None);
    Ok(RoutingInput {
        prompt: request.prompt,
        browser_routes_offered: request.browser_routes.is_some(),
        history_metrics: request.history_metrics,
    })
}

/// A routing answer, read as the job reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// The route the job takes, or `invalid` for an answer it cannot use.
    pub route: String,
    pub workspace_file_change_requirement: Option<String>,
    /// The router's own reason.
    pub reason: String,
}

/// Reads a routing answer with the job's parser. A browser route the job could not take runs
/// `direct`, as in the job. An answer whose change requirement is not valid fails a turn, and
/// one with a route the runtime does not know runs `direct` with a warning: both are `invalid`
/// here.
pub fn read_answer(final_json: &JsonValue, case: &Case, input: &RoutingInput) -> Answer {
    let invalid = |reason: &str| Answer {
        route: "invalid".to_string(),
        workspace_file_change_requirement: None,
        reason: reason.to_string(),
    };
    if super::parse_workspace_file_change_requirement(final_json).is_err() {
        return invalid("the answer has no valid workspaceFileChangeRequirement");
    }
    let Some(mut preflight) = super::parse_agent_routing_preflight(final_json) else {
        return invalid("the answer names no route the runtime knows");
    };
    if let AgentRoutingPreflightRoute::Browser { continue_building } = preflight.route
        && !(input.browser_routes_offered
            && super::routed_browser_execution(&case.message, continue_building, JsonValue::Null)
                .is_some())
    {
        preflight.route = AgentRoutingPreflightRoute::Direct;
    }
    let artifact = super::agent_routing_preflight_artifact(&preflight);
    Answer {
        route: artifact["route"].as_str().unwrap_or("invalid").to_string(),
        workspace_file_change_requirement: artifact["workspaceFileChangeRequirement"]
            .as_str()
            .map(str::to_string),
        reason: preflight.reason,
    }
}

/// The tokens one routing step used, from its usage receipts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: i64,
    pub cached_input: i64,
    pub output: i64,
}

impl Tokens {
    fn from_usage(artifact: Option<JsonValue>) -> Self {
        let mut tokens = Self::default();
        for call in artifact
            .as_ref()
            .and_then(|artifact| artifact["calls"].as_array())
            .into_iter()
            .flatten()
        {
            let usage = &call["usage"];
            tokens.input += usage["input_tokens"].as_i64().unwrap_or(0);
            tokens.cached_input += usage["cached_input_tokens"].as_i64().unwrap_or(0);
            tokens.output += usage["output_tokens"].as_i64().unwrap_or(0);
        }
        tokens
    }

    fn add(&mut self, other: Self) {
        self.input += other.input;
        self.cached_input += other.cached_input;
        self.output += other.output;
    }
}

/// One routing step of a case.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub answer: Option<Answer>,
    pub error: Option<String>,
    pub tokens: Tokens,
    pub seconds: f64,
}

/// Runs a case's routing step once, as a job's routing step runs: its input, the routing step's
/// run options, a job's default settings, the model the environment names (`CODEX_MODEL`) at
/// the endpoint it names (`OPENAI_BASE_URL`), and the answer read by the job's parser.
pub async fn route_once(
    workspace: &Path,
    case: &Case,
    input: &RoutingInput,
    timeout: Duration,
) -> Run {
    let started = Instant::now();
    let usage = TaskUsage::default();
    let options = CodexRunOptions {
        usage_observer: Some(usage.call(UsagePhase::Routing)),
        run_timeout: Some(timeout),
        ..super::routing_preflight_run_options(false)
    };
    let output = match CodexClient::from_env(workspace) {
        Some(codex) => {
            crate::job_runtime_settings::scope(
                AgentRuntimeSettings::default(),
                Box::pin(async move {
                    codex
                        .execute_with_options(&input.prompt, None, options)
                        .await
                }),
            )
            .await
        }
        None => Err(anyhow!("Codex is turned off in this environment")),
    };
    let tokens = Tokens::from_usage(usage.artifact());
    let seconds = started.elapsed().as_secs_f64();
    match output {
        Ok(output) => Run {
            answer: Some(read_answer(&output.final_json, case, input)),
            error: None,
            tokens,
            seconds,
        },
        Err(error) => Run {
            answer: None,
            error: Some(format!("{error:#}")),
            tokens,
            seconds,
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Pass,
    /// It passes, with a run against it.
    Unsteady,
    Wrong,
}

impl Verdict {
    pub fn label(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Unsteady => "unsteady",
            Self::Wrong => "WRONG",
        }
    }
}

/// A case passes when more than half of its runs give the expected answer. One that passes with
/// a run against it (2 of 3) is unsteady.
pub fn verdict(right: usize, runs: usize) -> Verdict {
    if right * 2 <= runs {
        Verdict::Wrong
    } else if right < runs {
        Verdict::Unsteady
    } else {
        Verdict::Pass
    }
}

/// A case and its runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    pub id: String,
    pub expected: String,
    pub runs: Vec<Run>,
    pub verdict: Verdict,
}

impl CaseResult {
    pub fn new(case: &Case, runs: Vec<Run>) -> Self {
        let right = runs
            .iter()
            .filter(|run| {
                run.answer
                    .as_ref()
                    .is_some_and(|answer| case.answered_by(answer))
            })
            .count();
        Self {
            id: case.id.clone(),
            expected: case.expected(),
            verdict: verdict(right, runs.len()),
            runs,
        }
    }
}

fn run_label(case_expects_requirement: bool, run: &Run) -> String {
    match &run.answer {
        None => "error".to_string(),
        Some(answer) => match (
            case_expects_requirement,
            &answer.workspace_file_change_requirement,
        ) {
            (true, Some(requirement)) => format!("{} ({requirement})", answer.route),
            _ => answer.route.clone(),
        },
    }
}

/// `count` and `noun`, with an `s` unless it is one.
pub fn plural(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

fn table_cell(text: &str, max_chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cell: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        cell.push('…');
    }
    cell.replace('|', "\\|")
}

/// The results as a table: each case, what it expects, the route of each run, its verdict and
/// the router's own reason (from a run against the expected answer, when there is one), then
/// the totals.
pub fn table(cases: &[Case], results: &[CaseResult]) -> String {
    let mut out = String::from(
        "| Case | Expected | Route per run | Verdict | The router's reason |\n|---|---|---|---|---|\n",
    );
    let mut tokens = Tokens::default();
    let mut seconds = 0.0;
    let mut calls = 0;
    for (case, result) in cases.iter().zip(results) {
        let expects_requirement = case.expect.workspace_file_change_requirement.is_some();
        let routes = result
            .runs
            .iter()
            .map(|run| run_label(expects_requirement, run))
            .collect::<Vec<_>>()
            .join(", ");
        let telling = result
            .runs
            .iter()
            .find(|run| {
                !run.answer
                    .as_ref()
                    .is_some_and(|answer| case.answered_by(answer))
            })
            .or_else(|| result.runs.last());
        let reason = telling
            .map(|run| match (&run.answer, &run.error) {
                (Some(answer), _) => answer.reason.clone(),
                (None, Some(error)) => error.clone(),
                (None, None) => String::new(),
            })
            .unwrap_or_default();
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} |",
            result.id,
            table_cell(&result.expected, 60),
            routes,
            result.verdict.label(),
            table_cell(&reason, 140)
        );
        for run in &result.runs {
            tokens.add(run.tokens);
            seconds += run.seconds;
            calls += 1;
        }
    }
    let count = |verdict: Verdict| results.iter().filter(|r| r.verdict == verdict).count();
    let _ = writeln!(
        out,
        "\n{}: {} pass, {} unsteady, {} wrong. {} took {:.0} s and {} tokens in ({} of them cached) and {} out.",
        plural(results.len(), "case"),
        count(Verdict::Pass),
        count(Verdict::Unsteady),
        count(Verdict::Wrong),
        plural(calls, "routing step"),
        seconds,
        tokens.input,
        tokens.cached_input,
        tokens.output,
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const SHIPPED_CASES: &str = include_str!("../../tests/fixtures/routing-check-cases.json");
    const SHIPPED_BROWSER_SKILL: &str =
        include_str!("../../assets/instafy/.agents/skills/instafy-browser-automation/SKILL.md");

    fn shipped() -> Vec<Case> {
        parse_cases(SHIPPED_CASES).expect("the shipped case file parses")
    }

    fn case(cases: &[Case], id: &str) -> Case {
        cases
            .iter()
            .find(|case| case.id == id)
            .unwrap_or_else(|| panic!("case {id}"))
            .clone()
    }

    #[test]
    fn the_shipped_case_file_parses() {
        let cases = shipped();
        assert!(cases.len() >= 11, "{} cases", cases.len());
        for route in ["direct", "browser", "browser_then_build"] {
            assert!(
                cases.iter().any(|case| case.expect.route == route),
                "no case expects {route}"
            );
        }
        assert!(cases.iter().any(|case| case.history.is_empty()));
        assert!(cases.iter().any(|case| !case.history.is_empty()));
    }

    #[test]
    fn a_case_file_with_a_mistake_is_refused() {
        let file = |case: JsonValue| json!({"cases": [case]}).to_string();
        let good = json!({
            "id": "a-case", "message": "Plan a weekend on a map",
            "expect": {"route": "direct"}, "why": "A map."
        });
        assert_eq!(parse_cases(&file(good.clone())).unwrap().len(), 1);
        for (change, mistake) in [
            (json!({"route": "maybe"}), "is not a route"),
            (json!({"extra": true}), "unknown field"),
            (json!({"id": "A Case"}), "use lowercase"),
            (json!({"message": " "}), "message is empty"),
            (
                json!({"history": [{"role": "system", "content": "x"}]}),
                "history entry 0",
            ),
            (json!({"history": [{"role": "user"}]}), "history entry 0"),
            (
                json!({"expect": {"route": "direct", "workspaceFileChangeRequirement": ["some"]}}),
                "workspaceFileChangeRequirement takes",
            ),
        ] {
            let mut bad = good.clone();
            if let Some(route) = change.get("route") {
                bad["expect"]["route"] = route.clone();
            } else {
                for (key, value) in change.as_object().unwrap() {
                    bad[key] = value.clone();
                }
            }
            let error = format!("{:#}", parse_cases(&file(bad)).unwrap_err());
            assert!(error.contains(mistake), "{mistake}: {error}");
        }
        let twice = json!({"cases": [good.clone(), good]}).to_string();
        assert!(format!("{:#}", parse_cases(&twice).unwrap_err()).contains("used twice"));
        assert!(parse_cases(r#"{"cases": []}"#).is_err());
    }

    #[test]
    fn the_majority_decides_and_two_of_three_is_unsteady() {
        assert_eq!(verdict(3, 3), Verdict::Pass);
        assert_eq!(verdict(2, 3), Verdict::Unsteady);
        assert_eq!(verdict(1, 3), Verdict::Wrong);
        assert_eq!(verdict(0, 3), Verdict::Wrong);
        assert_eq!(verdict(1, 1), Verdict::Pass);
        assert_eq!(verdict(0, 1), Verdict::Wrong);
        // Half is no majority.
        assert_eq!(verdict(1, 2), Verdict::Wrong);
        assert_eq!(verdict(3, 5), Verdict::Unsteady);
        assert_eq!(verdict(0, 0), Verdict::Wrong);

        let cases = shipped();
        let map = case(&cases, "map-trip");
        let run = |route: &str| Run {
            answer: Some(Answer {
                route: route.to_string(),
                workspace_file_change_requirement: Some("required".to_string()),
                reason: format!("routed {route}"),
            }),
            error: None,
            tokens: Tokens {
                input: 9_000,
                cached_input: 0,
                output: 120,
            },
            seconds: 5.0,
        };
        let failed = Run {
            answer: None,
            error: Some("unreachable".to_string()),
            tokens: Tokens::default(),
            seconds: 1.0,
        };
        let steady = CaseResult::new(&map, vec![run("direct"), run("direct"), run("direct")]);
        assert_eq!(steady.verdict, Verdict::Pass);
        let unsteady = CaseResult::new(
            &map,
            vec![run("direct"), run("browser_then_build"), run("direct")],
        );
        assert_eq!(unsteady.verdict, Verdict::Unsteady);
        let wrong = CaseResult::new(
            &map,
            vec![run("browser_then_build"), failed.clone(), run("direct")],
        );
        assert_eq!(wrong.verdict, Verdict::Wrong);

        // A case that also asks what must change counts a run only with an allowed answer.
        let after_undo = case(&cases, "keep-going-after-stop-and-undo");
        let mut conditional = run("direct");
        conditional
            .answer
            .as_mut()
            .unwrap()
            .workspace_file_change_requirement = Some("conditional".to_string());
        assert!(after_undo.answered_by(conditional.answer.as_ref().unwrap()));
        assert!(!after_undo.answered_by(run("direct").answer.as_ref().unwrap()));

        let table = table(
            &[map.clone(), map.clone(), map.clone(), after_undo.clone()],
            &[
                steady,
                unsteady,
                wrong,
                CaseResult::new(&after_undo, vec![conditional, run("direct")]),
            ],
        );
        assert!(
            table.contains("| map-trip | direct | direct, direct, direct | pass | routed direct |"),
            "{table}"
        );
        assert!(
            table.contains(
                "| direct, browser_then_build, direct | unsteady | routed browser_then_build |"
            ),
            "{table}"
        );
        assert!(
            table.contains(
                "| browser_then_build, error, direct | WRONG | routed browser_then_build |"
            ),
            "{table}"
        );
        assert!(
            table.contains("| direct (conditional), direct (required) | WRONG |"),
            "{table}"
        );
        assert!(
            table.contains("4 cases: 1 pass, 1 unsteady, 2 wrong. 11 routing steps"),
            "{table}"
        );
    }

    #[test]
    fn a_case_with_no_chat_and_one_with_a_chat_both_build() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        // The chat as the routing step reads it: the runtime's own projection of a job's history,
        // the case's entries and then its message.
        let read = |case: &Case| {
            let mut history = case.history.clone();
            history.push(json!({"role": "user", "content": case.message}));
            super::super::conversation_context::build_routing_conversation_context(Some(&json!(
                history
            )))
            .section_text
        };
        for case in &cases {
            let input = routing_input(case, workspace.path()).unwrap();
            assert!(input.browser_routes_offered, "{}", case.id);
            assert!(input.prompt.contains(&case.message), "{}", case.id);
            let chat = read(case);
            assert!(
                input
                    .prompt
                    .contains(&serde_json::to_string(&chat).unwrap()),
                "{}: the chat is not in the routing input",
                case.id
            );
            for entry in &case.history {
                let content = entry["content"].as_str().unwrap().trim();
                if !content.is_empty() {
                    assert!(chat.contains(content), "{}: {content}", case.id);
                }
            }
        }

        // With no chat, the routing step reads the message alone.
        let first = case(&cases, "map-trip");
        assert!(first.history.is_empty());
        let input = routing_input(&first, workspace.path()).unwrap();
        assert_eq!(input.history_metrics["includedTurns"], json!(1));
        assert_eq!(read(&first).matches(&first.message).count(), 1);

        // A chat's message sent straight to the browser is stored again as that browser turn's
        // request, and is read once; an empty reply is not read.
        let fill_in = case(&cases, "comparison-fill-in");
        let request = fill_in.history[0]["content"].as_str().unwrap();
        assert_eq!(read(&fill_in).matches(request).count(), 1);
        let input = routing_input(&fill_in, workspace.path()).unwrap();
        assert_eq!(input.history_metrics["includedTurns"], json!(4));
        assert_eq!(input.history_metrics["ignoredEntries"], json!(2));

        // A Stop and an Undo reach the routing step as the chat shows them.
        let undone = case(&cases, "keep-going-after-stop-and-undo");
        let chat = read(&undone);
        assert!(chat.contains("Stopped this run."), "{chat}");
        assert!(chat.contains("The person undid the change from"), "{chat}");
    }

    /// The routing input is the job's, reading the browser skill's routing section from the
    /// space's own copy: the copy this checkout ships, and a changed one when it changes.
    #[test]
    fn the_dumped_input_follows_the_routing_section() {
        let cases = shipped();
        let map = case(&cases, "map-trip");
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let skill_path = workspace.path().join(BROWSER_SKILL);
        let skill = std::fs::read_to_string(&skill_path).unwrap();
        assert_eq!(
            skill, SHIPPED_BROWSER_SKILL,
            "the space's copy is the checkout's"
        );
        let before = routing_input(&map, workspace.path()).unwrap().prompt;

        // A reworded rule in the space's copy reaches the routing input, and nothing else moves.
        let heading = format!("\n## {}\n", super::super::ROUTING_PREFLIGHT_SECTION);
        let start = skill
            .find(&heading)
            .expect("the browser skill has a routing section");
        let (head, section) = skill.split_at(start);
        let rule = section
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .expect("the routing section says something");
        let reworded = "A map goes `browser_then_build`.";
        std::fs::write(
            &skill_path,
            format!("{head}{}", section.replacen(rule, reworded, 1)),
        )
        .unwrap();
        let after = routing_input(&map, workspace.path()).unwrap().prompt;
        assert!(before.contains(rule), "{before}");
        assert!(!before.contains(reworded), "{before}");
        assert!(after.contains(reworded), "{after}");
        assert_eq!(after.replacen(reworded, rule, 1), before);
    }

    fn answer_json(route: &str, requirement: &str) -> JsonValue {
        json!({
            "summary": "s", "route": route, "reason": "Because.", "selectedSkills": [],
            "confidence": 90, "requiresContextLookup": false, "requiresCommandExecution": false,
            "workspaceFileChangeRequirement": requirement, "observationCommands": [],
            "workerQuestionReply": null
        })
    }

    #[test]
    fn an_answer_is_read_as_the_job_reads_it() {
        let cases = shipped();
        let comparison = case(&cases, "comparison-page");
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let input = routing_input(&comparison, workspace.path()).unwrap();
        // Every route a case can expect is one the job's parser reads back by that name.
        for route in ROUTES {
            assert_eq!(
                &read_answer(&answer_json(route, "none"), &comparison, &input).route,
                route
            );
        }
        let answer = read_answer(
            &answer_json("browser_then_build", "none"),
            &comparison,
            &input,
        );
        assert_eq!(
            answer,
            Answer {
                route: "browser_then_build".to_string(),
                workspace_file_change_requirement: Some("none".to_string()),
                reason: "Because.".to_string(),
            }
        );
        assert!(comparison.answered_by(&answer));
        // Where the browser routes were not offered, a browser answer runs direct.
        let not_offered = RoutingInput {
            browser_routes_offered: false,
            ..input.clone()
        };
        assert_eq!(
            read_answer(&answer_json("browser", "none"), &comparison, &not_offered).route,
            "direct"
        );
        assert_eq!(
            read_answer(&answer_json("team", "none"), &comparison, &input).route,
            "invalid"
        );
        assert_eq!(
            read_answer(&answer_json("direct", "maybe"), &comparison, &input).route,
            "invalid"
        );
    }
}
