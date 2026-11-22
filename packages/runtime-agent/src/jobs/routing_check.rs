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
use std::path::{Path, PathBuf};
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
    /// Whether Octo's turn for the message can search the web, as the job's grant lets it: the
    /// routing input then says so, above the browser skill's routing section.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub integrated_search: bool,
    /// Whether research that ends in a page searches first there too, on a runtime with
    /// `INSTAFY_RESEARCH_PAGES_SEARCH_FIRST` on: the routing input then says so in a second line,
    /// and reads the section without the words it puts in braces.
    /// Only with `integratedSearch`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub research_pages_search_first: bool,
    /// The space's pages, as the controller gives a job them: each made in this chat or in
    /// another one, which the routing input then names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<Page>,
    pub expect: Expect,
    /// Why that route is right.
    pub why: String,
}

/// One of the space's pages: its title, its folder in the space, and the chat that made it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub title: String,
    pub folder: String,
    pub made_in: MadeIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum MadeIn {
    #[serde(rename = "this chat")]
    ThisChat,
    #[serde(rename = "another chat")]
    AnotherChat,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expect {
    pub route: String,
    /// When set, a run also needs one of these: what the turn after it must change in the space.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_file_change_requirement: Option<Vec<String>>,
    /// Whether the person's own words ask for deeper research, which gives an Instafy AI message
    /// more web searches, each of which costs them credits: a run's `deeperResearch` must say
    /// the same. False unless the case says so, so a router that reads an ordinary question as
    /// asking for more shows.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deeper_research: bool,
    /// What the routing step's `summary` must name where a routed browser turn reads it, in its
    /// card's task after the person's words, such as the address of a page a reply here linked:
    /// that turn never reads the reply.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub summary_names: Vec<String>,
}

impl Case {
    /// Whether a run's answer is the one this case expects.
    pub fn answered_by(&self, answer: &Answer) -> bool {
        answer.route == self.expect.route
            && answer.deeper_research == self.expect.deeper_research
            && self.expect.summary_names.iter().all(|name| {
                answer
                    .browser_task
                    .as_ref()
                    .is_some_and(|task| task.contains(name.as_str()))
            })
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
        let route = match &self.expect.workspace_file_change_requirement {
            Some(allowed) => format!("{} (change: {})", self.expect.route, allowed.join(" or ")),
            None => self.expect.route.clone(),
        };
        let route = if self.expect.deeper_research {
            format!("{route}, deeper research")
        } else {
            route
        };
        if self.expect.summary_names.is_empty() {
            route
        } else {
            format!(
                "{route}, its summary naming {}",
                self.expect.summary_names.join(" and ")
            )
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
        ensure!(
            case.integrated_search || !case.research_pages_search_first,
            "case {id}: researchPagesSearchFirst goes with integratedSearch"
        );
        let mut folders = HashSet::new();
        for page in &case.pages {
            ensure!(
                !page.title.trim().is_empty() && page_folder(&page.folder).is_some(),
                "case {id}: a page needs a title and a folder in the space, such as sites/name"
            );
            ensure!(
                folders.insert(page.folder.as_str()),
                "case {id}: the folder {} is listed twice",
                page.folder
            );
        }
    }
    Ok(file.cases)
}

/// A page's folder as a path of plain names in the space, at most two deep (`sites/name`).
fn page_folder(folder: &str) -> Option<&Path> {
    let path = Path::new(folder);
    let names = path.components().count();
    ((1..=2).contains(&names)
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_))))
    .then_some(path)
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
/// with the chat's entries and then the message itself, and the space's pages as the controller
/// gives them, each with the chat that made it.
fn case_job(case: &Case) -> LeaseJob {
    let mut history = case.history.clone();
    history.push(json!({"role": "user", "content": case.message, "runId": "run-latest"}));
    let (this_chat, another_chat) = (Uuid::new_v4(), Uuid::new_v4());
    let mut payload = json!({
        "prompt_text": case.message,
        "conversation_history": history,
        "metadata": {},
    });
    if !case.pages.is_empty() {
        let pages: Vec<JsonValue> = case
            .pages
            .iter()
            .map(|page| {
                let chat = match page.made_in {
                    MadeIn::ThisChat => this_chat,
                    MadeIn::AnotherChat => another_chat,
                };
                json!({
                    "folder": page.folder,
                    "title": page.title,
                    "server": ["instafy", "bind"],
                    "openedAt": "2026-11-17T09:00:00.000Z",
                    "conversationId": chat.to_string(),
                })
            })
            .collect();
        payload[super::space_pages::CONTROLLERS_PAGES_KEY] = json!({ "pages": pages });
    }
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(Uuid::new_v4()),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(this_chat),
        session_id: None,
        credential_id: None,
        payload,
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
        engine: None,
        claude_code_login_id: None,
    }
}

/// What the routing step sends the model for a case.
#[derive(Debug, Clone)]
pub struct RoutingInput {
    /// The routing prompt, exactly as the job sends it.
    pub prompt: String,
    /// How the prompt starts: the part that is the same for every chat offered the same routes,
    /// from which the routing step's cache key is made.
    pub shared_start: String,
    /// Whether the job offered the browser routes.
    pub browser_routes_offered: bool,
    /// The history projection's counts.
    pub history_metrics: JsonValue,
}

/// A case's routing input, built by the job's own code in `workspace`. A case's pages are the
/// space's for that case alone: their folders are made, the job takes the controller's pages over
/// the space's record as a job does before its routing step, and both go once the input is built.
pub fn routing_input(case: &Case, workspace: &Path) -> Result<RoutingInput> {
    let job = case_job(case);
    ensure!(
        super::should_run_agent_routing_preflight_for_execution(&job, &case.message),
        "case {}: a turn would skip the routing step",
        case.id
    );
    let pages = CasePages::lay_out(workspace, &case.pages)
        .with_context(|| format!("case {}: its pages", case.id))?;
    super::space_pages::take_the_controllers_pages(workspace, &job.payload);
    let request = super::routing_preflight_request(
        &job,
        workspace,
        &case.message,
        None,
        case.integrated_search,
        case.research_pages_search_first,
    );
    drop(pages);
    Ok(RoutingInput {
        prompt: request.prompt,
        shared_start: request.shared_start,
        browser_routes_offered: request.browser_routes.is_some(),
        history_metrics: request.history_metrics,
    })
}

/// The folders of a case's pages, made in the space for that case alone, and the space's record of
/// its pages, which the job writes from them: both go when this is dropped.
struct CasePages {
    made: Vec<PathBuf>,
    record: Option<PathBuf>,
}

impl CasePages {
    fn lay_out(workspace: &Path, pages: &[Page]) -> Result<Self> {
        let mut laid_out = Self {
            made: Vec::new(),
            record: None,
        };
        if pages.is_empty() {
            return Ok(laid_out);
        }
        // The first folder of the record's path the space doesn't have yet, which goes whole.
        let record_dir = Path::new(super::space_pages::PAGES_RECORD)
            .parent()
            .context("the record's folder")?;
        let mut first_missing = None;
        let mut dir = workspace.to_path_buf();
        for name in record_dir.components() {
            dir.push(name);
            if !dir.exists() {
                first_missing = Some(dir.clone());
                break;
            }
        }
        laid_out.record =
            Some(first_missing.context("the space already has a record of its pages")?);
        for page in pages {
            let mut dir = workspace.to_path_buf();
            for name in Path::new(&page.folder).components() {
                dir.push(name);
                if !dir.exists() {
                    std::fs::create_dir(&dir)
                        .with_context(|| format!("failed to create {}", dir.display()))?;
                    laid_out.made.push(dir.clone());
                }
            }
        }
        Ok(laid_out)
    }
}

impl Drop for CasePages {
    fn drop(&mut self) {
        if let Some(record) = &self.record {
            let _ = std::fs::remove_dir_all(record);
        }
        for dir in self.made.iter().rev() {
            let _ = std::fs::remove_dir(dir);
        }
    }
}

/// A routing answer, read as the job reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// The route the job takes, or `invalid` for an answer it cannot use.
    pub route: String,
    pub workspace_file_change_requirement: Option<String>,
    /// Whether the answer read the person's own words as asking for deeper research.
    pub deeper_research: bool,
    /// The router's own reason.
    pub reason: String,
    /// On a browser route, the task of the card the job posts: the person's words, then the
    /// answer's `summary` where the job keeps it (`routed_browser_task`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_task: Option<String>,
}

/// Reads a routing answer with the job's parser. A browser route the job could not take runs
/// `direct`, as in the job. An answer whose change requirement is not valid fails a turn, and
/// one with a route the runtime does not know runs `direct` with a warning: both are `invalid`
/// here.
pub fn read_answer(final_json: &JsonValue, case: &Case, input: &RoutingInput) -> Answer {
    let invalid = |reason: &str| Answer {
        route: "invalid".to_string(),
        workspace_file_change_requirement: None,
        deeper_research: false,
        reason: reason.to_string(),
        browser_task: None,
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
    let browser_task =
        matches!(preflight.route, AgentRoutingPreflightRoute::Browser { .. }).then(|| {
            super::routed_browser_task(
                &case_job(case),
                &case.message,
                final_json.get("summary").and_then(JsonValue::as_str),
            )
        });
    let artifact = super::agent_routing_preflight_artifact(&preflight);
    Answer {
        route: artifact["route"].as_str().unwrap_or("invalid").to_string(),
        workspace_file_change_requirement: artifact["workspaceFileChangeRequirement"]
            .as_str()
            .map(str::to_string),
        deeper_research: preflight.deeper_research,
        reason: preflight.reason,
        browser_task,
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
        ..super::routing_preflight_run_options(false, &input.shared_start)
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
    /// It passes, with a run that did not give the expected answer.
    Unsteady,
    Wrong,
    /// Runs that got no answer decide it, so it needs a rerun.
    NoAnswer,
}

impl Verdict {
    pub fn label(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Unsteady => "unsteady",
            Self::Wrong => "WRONG",
            Self::NoAnswer => "no answer",
        }
    }
}

/// A case passes when more than half of its runs give the expected answer. One that passes with
/// a run that did not (2 of 3) is unsteady. A run that got no answer (the endpoint failed or
/// timed out) gave no route: a case is wrong only when its wrong answers alone keep it from
/// passing, and has no answer when the runs without one decide it.
pub fn verdict(right: usize, wrong: usize, runs: usize) -> Verdict {
    if right * 2 > runs {
        if right == runs {
            Verdict::Pass
        } else {
            Verdict::Unsteady
        }
    } else if wrong > 0 && wrong * 2 >= runs {
        Verdict::Wrong
    } else {
        Verdict::NoAnswer
    }
}

/// The command's exit status: 1 when a case is wrong, otherwise 2 when a case has no answer (a
/// rerun settles it), and 0 when every case passes.
pub fn exit_status(results: &[CaseResult]) -> u8 {
    if results
        .iter()
        .any(|result| result.verdict == Verdict::Wrong)
    {
        1
    } else if results
        .iter()
        .any(|result| result.verdict == Verdict::NoAnswer)
    {
        2
    } else {
        0
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
        let answered = runs.iter().filter(|run| run.answer.is_some()).count();
        Self {
            id: case.id.clone(),
            expected: case.expected(),
            verdict: verdict(right, answered - right, runs.len()),
            runs,
        }
    }
}

fn run_label(case_expects_requirement: bool, run: &Run) -> String {
    match &run.answer {
        None => "error".to_string(),
        Some(answer) => {
            let route = match (
                case_expects_requirement,
                &answer.workspace_file_change_requirement,
            ) {
                (true, Some(requirement)) => format!("{} ({requirement})", answer.route),
                _ => answer.route.clone(),
            };
            // Shown whenever a run says so, as a case that expects none fails on it.
            if answer.deeper_research {
                format!("{route} + deeper research")
            } else {
                route
            }
        }
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
        "\n{}: {} pass, {} unsteady, {} wrong, {} with no answer. {} took {:.0} s and {} tokens in ({} of them cached) and {} out.",
        plural(results.len(), "case"),
        count(Verdict::Pass),
        count(Verdict::Unsteady),
        count(Verdict::Wrong),
        count(Verdict::NoAnswer),
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

    /// The words a skill's routing section puts in braces, in order.
    fn marked_words(skill: &str) -> Vec<&str> {
        let (_, section) = skill
            .split_once("\n## Routing preflight\n")
            .expect("the routing section");
        section
            .split('{')
            .skip(1)
            .map(|rest| rest.split_once('}').expect("a closing brace").0)
            .collect()
    }

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
        // Every run answered: (right, wrong, runs).
        assert_eq!(verdict(3, 0, 3), Verdict::Pass);
        assert_eq!(verdict(2, 1, 3), Verdict::Unsteady);
        assert_eq!(verdict(1, 2, 3), Verdict::Wrong);
        assert_eq!(verdict(0, 3, 3), Verdict::Wrong);
        assert_eq!(verdict(1, 0, 1), Verdict::Pass);
        assert_eq!(verdict(0, 1, 1), Verdict::Wrong);
        // Half is no majority.
        assert_eq!(verdict(1, 1, 2), Verdict::Wrong);
        assert_eq!(verdict(3, 2, 5), Verdict::Unsteady);

        let cases = shipped();
        let map = case(&cases, "map-weekend");
        let run = |route: &str| Run {
            answer: Some(Answer {
                route: route.to_string(),
                workspace_file_change_requirement: Some("required".to_string()),
                deeper_research: false,
                reason: format!("routed {route}"),
                browser_task: None,
            }),
            error: None,
            tokens: Tokens {
                input: 9_000,
                cached_input: 0,
                output: 120,
            },
            seconds: 5.0,
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
            vec![
                run("browser_then_build"),
                run("browser_then_build"),
                run("direct"),
            ],
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
            table.contains(
                "| map-weekend | direct | direct, direct, direct | pass | routed direct |"
            ),
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
                "| browser_then_build, browser_then_build, direct | WRONG | routed browser_then_build |"
            ),
            "{table}"
        );
        assert!(
            table.contains("| direct (conditional), direct (required) | WRONG |"),
            "{table}"
        );
        assert!(
            table.contains(
                "4 cases: 1 pass, 1 unsteady, 2 wrong, 0 with no answer. 11 routing steps"
            ),
            "{table}"
        );
    }

    /// A run that got no answer (the endpoint failed or timed out) gave no route, so it never
    /// makes a case wrong: runs like it that decide a case leave it with no answer, which the
    /// command's exit status keeps apart from a wrong one.
    #[test]
    fn a_run_with_no_answer_is_no_route() {
        // (right, wrong, runs): the other runs got no answer.
        assert_eq!(verdict(2, 0, 3), Verdict::Unsteady);
        assert_eq!(verdict(1, 0, 3), Verdict::NoAnswer);
        assert_eq!(verdict(0, 0, 3), Verdict::NoAnswer);
        // One answer each way, and the run without one decides.
        assert_eq!(verdict(1, 1, 3), Verdict::NoAnswer);
        assert_eq!(verdict(0, 1, 3), Verdict::NoAnswer);
        // The wrong answers alone keep it from passing.
        assert_eq!(verdict(0, 2, 3), Verdict::Wrong);
        assert_eq!(verdict(0, 1, 2), Verdict::Wrong);
        assert_eq!(verdict(0, 0, 0), Verdict::NoAnswer);

        let cases = shipped();
        let map = case(&cases, "map-weekend");
        let failed = Run {
            answer: None,
            error: Some("Connection failed: error sending request".to_string()),
            tokens: Tokens::default(),
            seconds: 0.1,
        };
        let answered = |route: &str| Run {
            answer: Some(Answer {
                route: route.to_string(),
                workspace_file_change_requirement: Some("none".to_string()),
                deeper_research: false,
                reason: format!("routed {route}"),
                browser_task: None,
            }),
            error: None,
            tokens: Tokens::default(),
            seconds: 5.0,
        };
        let unreachable = CaseResult::new(&map, vec![failed.clone(), failed.clone(), failed]);
        assert_eq!(unreachable.verdict, Verdict::NoAnswer);
        let table = table(
            std::slice::from_ref(&map),
            std::slice::from_ref(&unreachable),
        );
        assert!(
            table.contains(
                "| map-weekend | direct | error, error, error | no answer | Connection failed: error sending request |"
            ),
            "{table}"
        );
        assert!(
            table.contains("1 case: 0 pass, 0 unsteady, 0 wrong, 1 with no answer."),
            "{table}"
        );
        assert_eq!(exit_status(std::slice::from_ref(&unreachable)), 2);

        let wrong = CaseResult::new(&map, vec![answered("browser_then_build")]);
        assert_eq!(wrong.verdict, Verdict::Wrong);
        let pass = CaseResult::new(&map, vec![answered("direct")]);
        assert_eq!(pass.verdict, Verdict::Pass);
        assert_eq!(exit_status(&[pass.clone(), unreachable, wrong]), 1);
        assert_eq!(exit_status(&[pass]), 0);
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
            // What the person stopped or undid, and its notices, are left out (below).
            for gone in ["Stopped this run.", "The person undid the change from"] {
                assert!(!chat.contains(gone), "{}: {chat}", case.id);
            }
            let taken_back = case.history.iter().any(|entry| {
                entry["content"] == "Stopped this run."
                    || entry["metadata"]["kind"] == "change_undone"
            });
            for entry in &case.history {
                let content = entry["content"].as_str().unwrap().trim();
                // A hand-back's stored prompt is Studio's words, not the person's: the chat
                // leaves it out.
                if content == super::super::conversation_context::HAND_BACK_PROMPT {
                    assert!(!chat.contains(content), "{}: {chat}", case.id);
                } else if !content.is_empty() && !taken_back {
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
        // request, and is read once; an empty reply, and the hand-back's stored prompt, are not
        // read.
        let fill_in = case(&cases, "comparison-fill-in");
        let request = fill_in.history[0]["content"].as_str().unwrap();
        assert_eq!(read(&fill_in).matches(request).count(), 1);
        let input = routing_input(&fill_in, workspace.path()).unwrap();
        assert_eq!(input.history_metrics["includedTurns"], json!(3));
        assert_eq!(input.history_metrics["ignoredEntries"], json!(3));

        // A request the person stopped and one whose change they undid are not in the chat the
        // routing step reads, nor their Stop and Undo lines: only what was left.
        let undone = case(&cases, "keep-going-after-stop-and-undo");
        let chat = read(&undone);
        for gone in [
            "Add a short \"Before you go\" section to that page.",
            "Add a one-line tip about the best time to visit.",
            "Added a one-line visit tip",
            "Stopped this run.",
            "The person undid the change from",
        ] {
            assert!(!chat.contains(gone), "{gone}: {chat}");
        }
        assert!(
            chat.contains("User: Put the hours on a small page I can share.\nAssistant: I made a small shareable page"),
            "{chat}"
        );
        assert!(chat.ends_with("User: keep going"), "{chat}");
    }

    /// After the person stopped one change and stopped and undid another, a bare "keep going"
    /// whose page marks the route not confirmed reads the line that says what it carries on, and
    /// no rule against a change the person stopped or undid ahead of the routes: in a recorded
    /// local test (Nov 5) that rule sent it to the browser alone, whose
    /// turn set nothing on the planner. It reads the chat up to the page, and none of the words a
    /// hand-back is stored with: the section the person stopped and the tip they stopped and
    /// undid, with their Stops and the Undo, are left out (a local test, Nov 7: read as "the
    /// unfinished page work", they kept a real "keep going" with Octo). So does the message
    /// before it, a page asked for in a chat that confirmed nothing yet.
    #[test]
    fn keep_going_after_a_stop_and_an_undo_reads_the_route_line_and_not_what_was_taken_back() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let hand_back = super::super::conversation_context::HAND_BACK_PROMPT;
        for id in [
            "page-from-unconfirmed-findings",
            "keep-going-route-open-after-stop-and-undo",
        ] {
            let case = case(&cases, id);
            assert_eq!(case.expected(), "browser_then_build", "{id}");
            let input = routing_input(&case, workspace.path()).unwrap();
            assert!(input.browser_routes_offered, "{id}");
            assert!(
                input.prompt.contains(
                    "So is a bare \"keep going\" when a page here marks something not checked or not confirmed"
                ),
                "{id}: {}",
                input.prompt
            );
            assert!(
                !input.prompt.contains(
                    "- A bare \"keep going\" never carries on a change the person stopped or undid."
                ),
                "{id}"
            );
            assert!(!input.prompt.contains(hand_back), "{id}");
        }
        let keep_going = case(&cases, "keep-going-route-open-after-stop-and-undo");
        assert_eq!(
            keep_going
                .history
                .iter()
                .filter(|entry| entry["content"] == hand_back)
                .count(),
            2
        );
        let input = routing_input(&keep_going, workspace.path()).unwrap();
        for gone in [
            "Stopped this run.",
            "The person undid the change from",
            "Add a short \\\"Before you go\\\" section",
            "Add a one-line tip about the best time to visit.",
            "Applied file changes:",
        ] {
            assert!(!input.prompt.contains(gone), "{gone}: {}", input.prompt);
        }
        assert!(
            input
                .prompt
                .contains("I built a small page with Livraria Lello\u{2019}s daily hours"),
            "{}",
            input.prompt
        );
        // Four requests sent on to the browser, two empty replies, two hand-backs' words, and
        // the section's request and Stop, and the tip's request, Stop, kept change and Undo.
        assert_eq!(input.history_metrics["ignoredEntries"], json!(14));
        assert_eq!(input.history_metrics["includedTurns"], json!(7));
    }

    /// Two chats of a recorded local test (Nov 6), each with the entries its routing step
    /// received there. After a comparison's building turn said it could not read the maker's
    /// pages, "Fill in what's still missing." needs the web and a change here, in a chat with no
    /// browser turn yet; after a page that marks its metro route not confirmed, a stopped section
    /// and a tip stopped and undone, "keep going" carries the route on. Each input reads the
    /// routing section's line for it, and the chat as the routing step reads it: the comparison
    /// and its reply; six of the page's entries, and eleven left out (three requests sent on to
    /// the browser, an empty reply, a hand-back's words, and the section and the tip the person
    /// stopped, one of them undone, with their two Stops, the kept change and the Undo).
    #[test]
    fn a_fill_in_after_a_reply_and_keep_going_after_a_page_read_their_lines() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let fill_in = case(&cases, "comparison-fill-in-after-a-reply");
        assert!(
            fill_in
                .history
                .iter()
                .all(|entry| entry.get("lane").is_none())
        );
        let keep_going = case(&cases, "keep-going-unconfirmed-route-after-stops-and-undo");
        for (case, line, included, ignored) in [
            (
                &fill_in,
                "Also when the browser part needs what only this space or another chat holds (a page, map or file here)",
                3,
                0,
            ),
            (
                &keep_going,
                "So is a bare \"keep going\" when a page here marks something not checked or not confirmed, or a page asked for here isn't made yet: it carries that on.",
                7,
                11,
            ),
        ] {
            assert_eq!(case.expected(), "browser_then_build", "{}", case.id);
            let input = routing_input(case, workspace.path()).unwrap();
            assert!(input.browser_routes_offered, "{}", case.id);
            assert!(input.prompt.contains(line), "{}: {}", case.id, input.prompt);
            assert!(input.prompt.contains(
                "A routed browser turn sees only the person's words, this chat's browser turns and your `summary`: name the items, place or site this chat names (by name; a page a reply here linked, by address, whatever they call it) and what to find."
            ));
            assert_eq!(
                input.history_metrics["includedTurns"],
                json!(included),
                "{}",
                case.id
            );
            assert_eq!(
                input.history_metrics["ignoredEntries"],
                json!(ignored),
                "{}",
                case.id
            );
        }
        let input = routing_input(&keep_going, workspace.path()).unwrap();
        assert_eq!(input.prompt.matches("Stopped this run.").count(), 0);
    }

    /// Two messages of a fourth recorded local test (Nov 6), each with the entries its routing
    /// step received there, both `browser_then_build`: a page asked for while the chat had found
    /// the hours but not confirmed the metro route, and a bare "keep going" after that page, a
    /// stopped section and a tip stopped and undid. Each input reads the routing section's line
    /// for it and the chat as the routing step reads it: four and six entries, the two requests
    /// sent on to the browser left out, and from "keep going" also the section and the tip the
    /// person took back, with their Stops, the kept change and the Undo. And the map trip's turn
    /// must make files.
    #[test]
    fn a_page_and_keep_going_with_the_route_unconfirmed_read_their_lines() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let page = case(&cases, "page-from-findings-with-the-route-unconfirmed");
        let keep_going = case(&cases, "keep-going-after-a-page-made-from-findings");
        for (case, line, included, ignored) in [
            (
                &page,
                "and for a page or change made only from what this chat found and confirmed;",
                5,
                2,
            ),
            (
                &keep_going,
                "So is a bare \"keep going\" when a page here marks something not checked or not confirmed, or a page asked for here isn't made yet: it carries that on.",
                7,
                8,
            ),
        ] {
            assert_eq!(case.expected(), "browser_then_build", "{}", case.id);
            let input = routing_input(case, workspace.path()).unwrap();
            assert!(input.browser_routes_offered, "{}", case.id);
            assert!(input.prompt.contains(line), "{}: {}", case.id, input.prompt);
            assert!(!input.prompt.contains("stopped or undid"), "{}", case.id);
            assert_eq!(
                input.history_metrics["includedTurns"],
                json!(included),
                "{}",
                case.id
            );
            assert_eq!(
                input.history_metrics["ignoredEntries"],
                json!(ignored),
                "{}",
                case.id
            );
        }
        let input = routing_input(&keep_going, workspace.path()).unwrap();
        assert_eq!(input.prompt.matches("Stopped this run.").count(), 0);
        assert_eq!(input.prompt.matches("Applied file changes:").count(), 0);
        assert!(!input.prompt.contains("The person undid the change from"));
        assert_eq!(
            case(&cases, "map-trip").expected(),
            "direct (change: required)"
        );
    }

    /// Two messages of a fifth recorded local test (Nov 7), each with the entries its routing step
    /// received there, both `browser_then_build`. "Add each laptop's warranty from its own page."
    /// went `direct`, its reason that the building turn would read the pages; that turn, which
    /// changes files and opens no browser, asked the person to send them. Its input now reads that
    /// a change that needs what a web page says starts in the browser, and nothing that says a
    /// building turn reads first and opens the browser itself: a change's building turn can't, and
    /// a change that needed each maker's page went `direct` again for it (a local test, Nov 20).
    /// After a page whose metro route was not confirmed, a section the person stopped and a tip
    /// they stopped and undid, "keep going" read them as "the unfinished page work" and stayed
    /// `direct`: its input now reads the chat up to the page and nothing the person took back.
    #[test]
    fn a_change_that_needs_a_page_and_keep_going_after_two_stops_read_their_lines() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let warranty = case(&cases, "warranty-from-each-laptops-page");
        assert_eq!(warranty.expected(), "browser_then_build");
        let input = routing_input(&warranty, workspace.path()).unwrap();
        assert!(input.browser_routes_offered);
        for line in [
            "it carries that on. So is a change that needs what a web page says.\n- Stay `direct` (`required`) for a map (its research too),",
            "the building turn reads it and answers with a card naming it,",
            "an order's own status or items, a form or planner).\n- `browser`:",
        ] {
            assert!(input.prompt.contains(line), "{line}: {}", input.prompt);
        }
        assert!(
            !input.prompt.contains("opening the browser itself"),
            "{}",
            input.prompt
        );
        // Both requests and their replies, the two requests sent on to the browser and the two
        // hand-backs' words left out.
        assert_eq!(input.history_metrics["includedTurns"], json!(7));
        assert_eq!(input.history_metrics["ignoredEntries"], json!(4));

        let keep_going = case(&cases, "keep-going-after-two-stops-and-an-undo");
        assert_eq!(keep_going.expected(), "browser_then_build");
        let input = routing_input(&keep_going, workspace.path()).unwrap();
        assert!(input.prompt.contains(
            "So is a bare \"keep going\" when a page here marks something not checked or not confirmed"
        ));
        let mut history = keep_going.history.clone();
        history.push(json!({"role": "user", "content": keep_going.message}));
        let chat = super::super::conversation_context::build_routing_conversation_context(Some(
            &json!(history),
        ))
        .section_text;
        let kept: Vec<String> = [0, 2, 3, 5, 6, 8, 9, 13, 20]
            .into_iter()
            .map(|index| {
                let entry = &history[index];
                let role = if entry["role"] == "user" {
                    "User"
                } else {
                    "Assistant"
                };
                format!("{role}: {}", entry["content"].as_str().unwrap())
            })
            .collect();
        assert_eq!(chat, kept.join("\n"));
        assert!(
            chat.contains("The metro route from São Bento remains unconfirmed"),
            "{chat}"
        );
        assert_eq!(input.history_metrics["includedTurns"], json!(9));
        assert_eq!(input.history_metrics["ignoredEntries"], json!(12));
    }

    /// A page stays `direct` when this chat found and confirmed all it needs: the hours from the
    /// tourism site, asked for on a page alone. Every other page from findings here waits for the
    /// metro route no reply confirmed, so without this case a routing step that sent each such
    /// page to the browser first would pass them all.
    #[test]
    fn a_page_of_what_the_chat_found_and_confirmed_stays_direct() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let page = case(&cases, "page-from-confirmed-findings");
        assert_eq!(page.expected(), "direct (change: required)");
        let input = routing_input(&page, workspace.path()).unwrap();
        assert!(input.browser_routes_offered);
        assert!(
            input.prompt.contains(
                "and for a page or change made only from what this chat found and confirmed;"
            ),
            "{}",
            input.prompt
        );
        // The chat as the routing step reads it: the request, the browser's reply and the
        // message, the request sent on to the browser left out.
        assert_eq!(input.history_metrics["includedTurns"], json!(3));
        assert_eq!(input.history_metrics["ignoredEntries"], json!(1));
        assert!(
            input
                .prompt
                .contains("Livraria Lello is listed as open daily from 09:00 to 19:30.")
        );
    }

    /// A note in the person's own words on the map this chat made stays `direct`, a change of
    /// files: a sixth recorded local test (Nov 8), with the entries its routing step received
    /// there. It went `browser_then_build`, its reason quoting the confirmed-findings sentence
    /// that closed that route's line; the line that keeps it `direct` now names it.
    #[test]
    fn a_note_in_the_persons_own_words_on_a_map_stays_direct() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let note = case(&cases, "map-note");
        assert_eq!(note.expected(), "direct (change: required)");
        let input = routing_input(&note, workspace.path()).unwrap();
        assert!(input.browser_routes_offered);
        assert!(
            input.prompt.contains(
                "- Stay `direct` (`required`) for a map (its research too), for a change in the person's own words to a page or map here (a note, a name, a color),"
            ),
            "{}",
            input.prompt
        );
        // The map's request, its reply and the note, as the routing step read them there.
        assert_eq!(input.history_metrics["includedTurns"], json!(3));
        assert_eq!(input.history_metrics["ignoredEntries"], json!(0));
        assert!(
            input.prompt.contains("one sight pinned for each day"),
            "{}",
            input.prompt
        );
    }

    /// The routing step reads the routing sections of the browser and collaboration skills, never
    /// `AGENTS.md` or the rest of a skill: what replies say (a rule of "Replies"), how a turn reads
    /// the web, and when a page's build asks the person change no route. Every case's routing
    /// input stays byte for byte the same when the space's `AGENTS.md` is a team's own and the
    /// page skill says the opposite of what it says.
    #[test]
    fn the_routing_input_reads_neither_agents_md_nor_the_page_skills_rules() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let inputs = || {
            cases
                .iter()
                .map(|case| {
                    let input = routing_input(case, workspace.path()).unwrap();
                    (case.id.clone(), input.shared_start, input.prompt)
                })
                .collect::<Vec<_>>()
        };
        let before = inputs();
        assert_eq!(before.len(), cases.len());

        std::fs::write(
            workspace.path().join(learn::AGENTS_DOC_FILENAME),
            "# Team notes\n\n## Reading the web\n\n- Read pages any way.\n\n## Replies\n\n- Ask before every choice.\n",
        )
        .unwrap();
        let hub = workspace
            .path()
            .join(learn::INTERACTIVE_ARTIFACTS_RELATIVE_PATH);
        let text = std::fs::read_to_string(&hub).unwrap();
        let (front, body) = super::super::skill_routing::split_front_matter(&text);
        assert!(!front.is_empty() && body.contains("## 1. Pick the builder"));
        std::fs::write(
            &hub,
            format!("{front}\n# Interactive artifacts\n\nAlways stop to ask before building.\n"),
        )
        .unwrap();
        let after = inputs();
        for ((id, start_before, prompt_before), (_, start_after, prompt_after)) in
            before.iter().zip(&after)
        {
            assert_eq!(start_before, start_after, "{id}: the shared start");
            assert_eq!(prompt_before, prompt_after, "{id}: the prompt");
        }
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

    /// The routing step's input, pinned by its hash: the start every chat offered the same
    /// routes shares (the routing instructions and the skills' routing sections, which a
    /// provider serves from its cache) and each case's whole routing prompt, built in a new
    /// space holding the files this checkout ships. The history's counts line is left out of the
    /// hash, as it reads the machine's model settings. A change to what turns read that leaves
    /// routing alone (a skill's other sections, a browser turn's run text, a section only a turn
    /// reads) keeps both hashes. A change that means to move routes updates them, and its pull
    /// request carries the routing check's table. A message whose turn can search the web shares
    /// a start of its own: the same, with the line that says so above the browser skill's
    /// routing section and, after it, the line that says research that ends in a page doesn't
    /// search first. On a runtime where such research searches first, that second line says so
    /// instead, the section is read without the words it puts in braces (those that hold only
    /// until then), and `browser_then_build`'s own line stops at the build. Without search the
    /// start is byte for byte what it was before the section had braces: its hash is the same.
    /// The space's pages, which differ from chat to chat, come after it.
    #[test]
    fn the_routing_input_is_byte_identical_to_its_pinned_hashes() {
        use sha2::{Digest, Sha256};
        const SHARED_START_SHA256: &str =
            "ae070fe68e8531847ddd9cfc92b81b3f6ceec61d8795c71d78a21508badc7885";
        const CASE_PROMPTS_SHA256: &str =
            "f63a858d8d2b4e431aefe03d88cae17230402a16e2e7ef1d08c73333971ba61c";
        const COUNTS_LINE: &str = "History projection metadata (counts only):\n";
        let digest = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()));
        let without_counts = |prompt: &str| match prompt.split_once(COUNTS_LINE) {
            Some((head, rest)) => {
                let rest = rest.split_once('\n').map_or("", |(_, rest)| rest);
                format!("{head}{COUNTS_LINE}{rest}")
            }
            None => prompt.to_string(),
        };
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        let inputs: Vec<(String, RoutingInput)> = shipped()
            .iter()
            .map(|case| {
                let input = routing_input(case, workspace.path()).unwrap();
                (case.id.clone(), input)
            })
            .collect();
        let starts: HashSet<&str> = inputs
            .iter()
            .map(|(_, input)| input.shared_start.as_str())
            .collect();
        assert!(
            inputs.iter().all(|(_, input)| input.browser_routes_offered),
            "every case is offered the browser routes"
        );
        assert_eq!(
            starts.len(),
            3,
            "three starts: without search, with it, and with research pages searching first too"
        );
        let cases = shipped();
        let start_where = |searching: bool, pages_first: bool| {
            let starts: HashSet<&str> = cases
                .iter()
                .filter(|case| {
                    case.integrated_search == searching
                        && case.research_pages_search_first == pages_first
                })
                .map(|case| {
                    inputs
                        .iter()
                        .find(|(each, _)| *each == case.id)
                        .map(|(_, input)| input.shared_start.as_str())
                        .expect("its input")
                })
                .collect();
            assert_eq!(
                starts.len(),
                1,
                "every case with search {searching} and pages first {pages_first} shares one start"
            );
            starts.into_iter().next().expect("a start")
        };
        let start = start_where(false, false);
        let search_start = start_where(true, false);
        let pages_start = start_where(true, true);
        // Two lines are all that tell the first two apart: that Octo can search the web, and
        // that research that ends in a page doesn't search first, a paragraph of their own
        // above the browser skill's section. The last two differ in the second line, which says
        // such research searches first or that it doesn't, and in what follows from it: where
        // it does, the words the section puts in braces are left out, and `browser_then_build`'s
        // own line stops at the build.
        let lines = format!(
            "\n{}{}",
            super::super::ROUTING_SEARCH_FACT,
            super::super::ROUTING_NO_SEARCH_FIRST_FACT
        );
        assert_eq!(search_start.matches(&lines).count(), 1);
        assert_eq!(
            search_start
                .matches(super::super::ROUTING_SEARCH_FACT)
                .count(),
            1
        );
        assert_eq!(search_start.replacen(&lines, "", 1), start);
        assert_eq!(
            pages_start
                .matches(super::super::ROUTING_SEARCH_FIRST_FACT)
                .count(),
            1
        );
        let marked = marked_words(SHIPPED_BROWSER_SKILL);
        assert_eq!(
            marked,
            [
                " when it searches first",
                " So is research that ends in a page (a comparison, prices, a route; not a map), unless it searches first (in Octo's own turn: the browser can't).",
            ]
        );
        let mut without = search_start.replacen(
            super::super::ROUTING_NO_SEARCH_FIRST_FACT,
            super::super::ROUTING_SEARCH_FIRST_FACT,
            1,
        );
        for words in &marked {
            assert_eq!(search_start.matches(words).count(), 1, "{words}");
            assert_eq!(start.matches(words).count(), 1, "{words}");
            assert!(!pages_start.contains(words), "{words}");
            without = without.replacen(words, "", 1);
        }
        assert_eq!(
            without.replacen(
                "- `browser_then_build`: the same, then a build from what it found.\n",
                "- `browser_then_build`: the same, then a build.\n",
                1
            ),
            pages_start
        );
        for start in [start, search_start, pages_start] {
            assert!(!start.contains(['{', '}']), "no brace is read");
        }
        assert!(pages_start.contains(
            ", or that ends in a page, stays `direct` unless the message names the browser,"
        ));
        assert!(!start.contains(super::super::ROUTING_SEARCH_FACT));
        assert!(!start.contains(super::super::ROUTING_NO_SEARCH_FIRST_FACT));
        assert!(!search_start.contains(super::super::ROUTING_SEARCH_FIRST_FACT));
        assert!(!pages_start.contains(super::super::ROUTING_NO_SEARCH_FIRST_FACT));
        let mut prompts = String::new();
        let mut each = String::new();
        for (id, input) in &inputs {
            let prompt = without_counts(&input.prompt);
            assert!(
                [start, search_start, pages_start]
                    .iter()
                    .any(|start| prompt.starts_with(start)),
                "{id}: the prompt opens with a start"
            );
            let _ = writeln!(each, "{id}: {}", digest(&prompt));
            let _ = writeln!(prompts, "{id}\n{prompt}");
        }
        assert_eq!(
            (digest(start), digest(&prompts)),
            (
                SHARED_START_SHA256.to_string(),
                CASE_PROMPTS_SHA256.to_string()
            ),
            "the routing input changed; each case's prompt now hashes to:\n{each}"
        );
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
                deeper_research: false,
                reason: "Because.".to_string(),
                // A chat with no earlier turn: the card's task is the person's words alone.
                browser_task: Some(comparison.message.clone()),
            }
        );
        assert!(comparison.answered_by(&answer));
        // An answer that reads the person's words as asking for deeper research says so, and a
        // case that does not expect it is not answered by it: the message would run, and charge,
        // more web searches than it asked for.
        let mut deeper = answer_json("browser_then_build", "none");
        deeper["deeperResearch"] = json!(true);
        let deeper = read_answer(&deeper, &comparison, &input);
        assert!(deeper.deeper_research);
        assert!(!comparison.answered_by(&deeper));
        let in_depth = case(&cases, "research-in-depth");
        assert!(in_depth.expect.deeper_research);
        assert_eq!(in_depth.expected(), "direct, deeper research");
        let mut asked = answer_json("direct", "none");
        asked["deeperResearch"] = json!(true);
        let in_depth_input = routing_input(&in_depth, workspace.path()).unwrap();
        assert!(in_depth.answered_by(&read_answer(&asked, &in_depth, &in_depth_input)));
        assert!(!in_depth.answered_by(&read_answer(
            &answer_json("direct", "none"),
            &in_depth,
            &in_depth_input
        )));
        let table = table(
            std::slice::from_ref(&comparison),
            &[CaseResult::new(
                &comparison,
                vec![Run {
                    answer: Some(deeper),
                    error: None,
                    tokens: Tokens::default(),
                    seconds: 5.0,
                }],
            )],
        );
        assert!(
            table.contains("| browser_then_build + deeper research | WRONG |"),
            "{table}"
        );
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

    /// Every rule of the browser skill's routing section has a case on a subject of its own, so a
    /// rule that holds only for the recorded tests' subjects shows: the recorded tests sent every
    /// earlier case about the same few places, products and sites. The cases from `news-today` on
    /// are these, each with the route its rule gives, and each case's routing input reads that
    /// rule. Eight of them are lookups that a search for fresh information changes: news, a recent
    /// result and opening hours answered in a reply, news put on a page and a comparison page (both
    /// `browser_then_build` when Octo can't search the web), a trip on a map, an order in the
    /// person's own account and a site opened in the browser. Where two rules could both be read as
    /// a case's, the case says which one decides: a note in the person's own words, and a place
    /// added to a map, after replies that said something wasn't found. Those sent where Octo can
    /// search the web for the message have one line saying so in their routing input, and a second
    /// saying whether research that ends in a page searches first: news put on a page, a comparison
    /// page and a page of places stay `direct` only where it does, browsing first where it doesn't
    /// and without search, a trip, a trip with the suggested hotels' prices for the person's dates
    /// and events put on a map stay `direct` where it does, as a map does where it doesn't and
    /// without search, while a map of what a site the person names in the browser says goes to the
    /// browser first with search or without (the line that keeps a map's research with it is not
    /// about a site to use), a page that needs prices for dates or a route still browses first
    /// where it does, as a site must be used first (that rule's, not the one for research that
    /// ends in a page), an order in the person's own account is still the
    /// browser's, and news answered in a reply and a hotel for dates nobody named stay `direct`,
    /// while hotels for dates nobody named put on a page browse first unless research that ends in
    /// a page searches first. A question about a shop's policy beside an order number stays
    /// `direct`, with search or without, while that order's own status is the browser's, a page a
    /// reply linked, opened in the browser, goes by its address whatever the person calls it, also
    /// where the reply linked no article, and a change to another chat's page, which the routing
    /// input's pages name, stays `direct` with no change.
    #[test]
    fn every_rule_of_the_routing_section_has_a_case_on_a_subject_of_its_own() {
        let cases = shipped();
        let workspace = tempdir().unwrap();
        prepare_workspace(workspace.path()).unwrap();
        // The section as the routing step reads it: where research that ends in a page doesn't
        // search first (and without search), and where it does.
        let written = SHIPPED_BROWSER_SKILL
            .split_once("\n## Routing preflight\n")
            .map(|(_, section)| section)
            .expect("the routing section");
        let section = super::super::browser_routing_section_for_search_state(written, false);
        let searching_first = super::super::browser_routing_section_for_search_state(written, true);
        let rules: &[(&str, &str, &[&str])] = &[
            (
                "name the items, place or site this chat names (by name; a page a reply here linked, by address, whatever they call it)",
                "browser",
                &[
                    "news-then-open-the-article",
                    "news-two-links-then-open-the-article",
                ],
            ),
            (
                "- Research whose answer is a reply (facts, a price, opening hours, reviews, a rule or policy, even beside an order number or email;",
                "direct",
                &[
                    "news-today",
                    "score-last-night",
                    "hours-sunday",
                    "translate-words-about-the-browser",
                    "news-today-searching",
                    "policy-beside-an-order-number",
                    "policy-beside-an-order-number-searching",
                ],
            ),
            (
                "when Octo can search the web, availability for dates at places nobody named)",
                "direct",
                &["hotel-for-dates-nobody-named-searching"],
            ),
            (
                "or that ends in a page, stays `direct`",
                "direct",
                &[
                    "news-then-page-searching",
                    "comparison-page-searching",
                    "comparison-page-watches-searching",
                    "page-of-places-searching",
                ],
            ),
            (
                "unless the message names the browser, it carries on this chat's browser work or a site must be used first (availability at a place named, a sign-in or their account, an order's own status or items, a form or planner)",
                "browser",
                &["order-status-beside-an-order-number"],
            ),
            (
                "or a site must be used first (availability at a place named, a sign-in or their account, an order's own status or items, a form or planner)",
                "browser_then_build",
                &["hotels-for-dates-page-searching", "route-page-searching"],
            ),
            (
                "the person names Instafy's browser (\"in your browser\")",
                "browser",
                &["open-a-site-in-the-browser"],
            ),
            (
                "the work happens on a website (use a site, sign in, check their account, send a form, press its buttons)",
                "browser",
                &[
                    "metro-planner",
                    "send-a-form-on-a-site",
                    "order-in-account",
                    "order-in-account-searching",
                ],
            ),
            (
                "or it carries on browser work this chat started, whether or not that found the answer.",
                "browser",
                &["browser-follow-up-tram"],
            ),
            (
                "- `browser_then_build`: the same, then Octo makes or changes something here",
                "browser_then_build",
                &[
                    "browser-named-then-page",
                    "map-from-a-site-in-the-browser",
                    "map-from-a-site-in-the-browser-searching",
                ],
            ),
            (
                "So is research that ends in a page (a comparison, prices, a route; not a map), unless it searches first (in Octo's own turn: the browser can't).",
                "browser_then_build",
                &[
                    "comparison-page-watches",
                    "news-then-page",
                    "news-then-page-searching-pages-browse-first",
                    "hotels-for-dates-nobody-named-page-searching",
                    "page-of-places",
                    "comparison-page-watches-searching-pages-browse-first",
                    "hotels-for-dates-page-searching-pages-browse-first",
                ],
            ),
            (
                "So is a page or change with values this chat's replies said weren't found or confirmed: the browser looks again first.",
                "browser_then_build",
                &[
                    "page-with-a-value-the-browser-did-not-confirm",
                    "page-with-a-value-a-reply-did-not-confirm",
                    "price-added-to-a-page-a-reply-did-not-confirm",
                ],
            ),
            (
                "So is a bare \"keep going\" when a page here marks something not checked or not confirmed, or a page asked for here isn't made yet: it carries that on.",
                "browser_then_build",
                &["keep-going-tram-route-open", "keep-going-page-not-made-yet"],
            ),
            (
                "So is a bare \"keep going\" when a page here marks something not checked or not confirmed",
                "direct",
                &["keep-going-nothing-open"],
            ),
            (
                "So is a change that needs what a web page says.",
                "browser_then_build",
                &["change-needs-each-makers-page"],
            ),
            (
                "- Stay `direct` (`required`) for a map (its research too),",
                "direct",
                &[
                    "trip-on-a-map",
                    "sight-a-map-did-not-find-on-a-day",
                    "trip-on-a-map-searching",
                    "trip-map-with-hotel-prices-searching",
                    "events-this-weekend-on-a-map-searching",
                    "trip-on-a-map-searching-pages-browse-first",
                ],
            ),
            (
                "for a change in the person's own words to a page or map here (a note, a name, a color)",
                "direct",
                &[
                    "note-in-own-words-on-a-map",
                    "note-on-a-sight-a-map-did-not-find",
                    "note-in-own-words-on-a-page-about-an-unconfirmed-value",
                ],
            ),
            (
                "and for a page or change made only from what this chat found and confirmed;",
                "direct",
                &["page-from-confirmed-hours"],
            ),
            (
                "(`none`) for a change to another chat's page.",
                "direct",
                &["change-to-another-chats-page"],
            ),
            (
                "when the site runs here (a preview card)",
                "direct",
                &["site-runs-in-this-space"],
            ),
            (
                "or the person says not to use the browser.",
                "direct",
                &["says-not-to-use-the-browser"],
            ),
            (
                "Also when the browser part needs what only this space or another chat holds (a page, map or file here): the building turn reads it and answers with a card naming it,",
                "direct",
                &["needs-a-file-here"],
            ),
            (
                "unless it needs only what this chat's browser work found: filling in, checking again or going on is `browser_then_build`.",
                "browser_then_build",
                &["fill-in-after-browser-work-watches"],
            ),
        ];
        let mut covered = HashSet::new();
        const SECTION_OPENS: &str = "\nFocused browser routing skill snapshot:\n";
        for (rule, route, ids) in rules {
            assert!(
                section.contains(rule) || searching_first.contains(rule),
                "the section says: {rule}"
            );
            for id in *ids {
                let case = case(&cases, id);
                assert_eq!(&case.expect.route, route, "{id}");
                let input = routing_input(&case, workspace.path()).unwrap();
                assert!(input.browser_routes_offered, "{id}");
                assert!(input.prompt.contains(rule), "{id} reads: {rule}");
                // Each case reads the section for its own search state, whole, and no brace.
                let read = if case.research_pages_search_first {
                    &searching_first
                } else {
                    &section
                };
                assert!(input.prompt.contains(read.trim_end()), "{id}");
                assert!(!input.shared_start.contains(['{', '}']), "{id}");
                // Whether Octo can search the web for the message is one line of the routing
                // input, above the section, there exactly when the case says so, and whether
                // research that ends in a page searches first is the line after it, which says
                // that it does or that it doesn't.
                let fact = format!("```\n\n{}", super::super::ROUTING_SEARCH_FACT);
                assert_eq!(input.prompt.contains(&fact), case.integrated_search, "{id}");
                assert_eq!(
                    input
                        .prompt
                        .matches(super::super::ROUTING_SEARCH_FACT)
                        .count(),
                    usize::from(case.integrated_search),
                    "{id}"
                );
                let both = format!(
                    "```\n\n{}{}{SECTION_OPENS}",
                    super::super::ROUTING_SEARCH_FACT,
                    super::super::ROUTING_SEARCH_FIRST_FACT
                );
                assert_eq!(
                    input.prompt.contains(&both),
                    case.research_pages_search_first,
                    "{id}"
                );
                assert_eq!(
                    input
                        .prompt
                        .matches(super::super::ROUTING_SEARCH_FIRST_FACT)
                        .count(),
                    usize::from(case.research_pages_search_first),
                    "{id}"
                );
                let not_first = case.integrated_search && !case.research_pages_search_first;
                let alone = format!(
                    "```\n\n{}{}{SECTION_OPENS}",
                    super::super::ROUTING_SEARCH_FACT,
                    super::super::ROUTING_NO_SEARCH_FIRST_FACT
                );
                assert_eq!(input.prompt.contains(&alone), not_first, "{id}");
                assert_eq!(
                    input
                        .prompt
                        .matches(super::super::ROUTING_NO_SEARCH_FIRST_FACT)
                        .count(),
                    usize::from(not_first),
                    "{id}"
                );
                covered.insert(case.id);
            }
        }
        // Research that ends in a page stays `direct` where it searches first and browses first
        // where it doesn't: a case filed under either sentence has the line that says research
        // that ends in a page searches first exactly when that sentence says so. The line that
        // Octo can search the web is not it: the line after it then says such research doesn't.
        // Each state reads its own sentence and not the other's: where such research searches
        // first, that it stays `direct`, said plainly, and nothing of browsing first; in the two
        // other states, both sentences with their conditions, as before.
        assert!(
            !searching_first.contains("searches first"),
            "{searching_first}"
        );
        assert!(section.contains("or that ends in a page when it searches first, stays `direct`"));
        for (sentence, searches_first) in [
            ("or that ends in a page, stays `direct`", true),
            (
                "So is research that ends in a page (a comparison, prices, a route; not a map), unless it searches first (in Octo's own turn: the browser can't).",
                false,
            ),
        ] {
            let (_, _, ids) = rules
                .iter()
                .find(|(rule, ..)| *rule == sentence)
                .expect(sentence);
            assert_eq!(searching_first.contains(sentence), searches_first);
            assert_eq!(section.contains(sentence), !searches_first);
            for id in *ids {
                assert_eq!(
                    case(&cases, id).research_pages_search_first,
                    searches_first,
                    "{id} is filed under: {sentence}"
                );
            }
        }
        // The route's own line follows the same state: where such research searches first it
        // stops at the build, and everywhere else it is as it was.
        for case in &cases {
            let input = routing_input(case, workspace.path()).unwrap();
            assert_eq!(
                input
                    .shared_start
                    .contains("- `browser_then_build`: the same, then a build.\n"),
                case.research_pages_search_first,
                "{}",
                case.id
            );
            assert_eq!(
                input.shared_start.contains(
                    "- `browser_then_build`: the same, then a build from what it found.\n"
                ),
                !case.research_pages_search_first,
                "{}",
                case.id
            );
        }
        // Each case that can search has a twin rule on the same kind of message without it: news,
        // a comparison and a page of places put on a page browse first unless Octo can search the
        // web and research that ends in a page searches first. Five of them are word for word the
        // same message, with only the search lines of the routing input between them: a
        // comparison page and a page that needs prices for dates at hotels the person named
        // browse first where research that ends in a page doesn't search first, the second also
        // where it does, as a site must be used first.
        for (searching, without) in [
            ("news-then-page-searching", "news-then-page"),
            ("comparison-page-searching", "comparison-page-watches"),
            (
                "comparison-page-watches-searching",
                "comparison-page-watches",
            ),
            (
                "news-then-page-searching",
                "news-then-page-searching-pages-browse-first",
            ),
            ("page-of-places-searching", "page-of-places"),
            (
                "comparison-page-watches-searching",
                "comparison-page-watches-searching-pages-browse-first",
            ),
            (
                "hotels-for-dates-page-searching",
                "hotels-for-dates-page-searching-pages-browse-first",
            ),
        ] {
            let (searching, without) = (case(&cases, searching), case(&cases, without));
            assert!(searching.research_pages_search_first, "{}", searching.id);
            assert!(!without.research_pages_search_first, "{}", without.id);
        }
        for (one, other) in [
            (
                "comparison-page-watches-searching",
                "comparison-page-watches",
            ),
            (
                "news-then-page-searching",
                "news-then-page-searching-pages-browse-first",
            ),
            (
                "policy-beside-an-order-number-searching",
                "policy-beside-an-order-number",
            ),
            ("page-of-places-searching", "page-of-places"),
            (
                "comparison-page-watches-searching",
                "comparison-page-watches-searching-pages-browse-first",
            ),
            (
                "hotels-for-dates-page-searching",
                "hotels-for-dates-page-searching-pages-browse-first",
            ),
            (
                "trip-on-a-map-searching",
                "trip-on-a-map-searching-pages-browse-first",
            ),
            (
                "map-from-a-site-in-the-browser-searching",
                "map-from-a-site-in-the-browser",
            ),
        ] {
            assert_eq!(case(&cases, one).message, case(&cases, other).message);
        }
        // A map stays `direct` (`required`) in every search state, where research that ends in a
        // page searches first, where it doesn't and without search: its research is the map's
        // own, a trip's, the prices of the hotels it suggests for the person's dates and the
        // events it puts on it, and Instafy's browser can't search. Where such research searches
        // first, trips and events put on a map went to the browser first (a local test, Nov 20).
        let trip = case(&cases, "trip-on-a-map");
        assert!(!trip.integrated_search);
        for (id, pages_first) in [
            ("trip-on-a-map-searching", true),
            ("trip-map-with-hotel-prices-searching", true),
            ("events-this-weekend-on-a-map-searching", true),
            ("trip-on-a-map-searching-pages-browse-first", false),
        ] {
            let map = case(&cases, id);
            assert!(map.integrated_search, "{id}");
            assert_eq!(map.research_pages_search_first, pages_first, "{id}");
            assert_eq!(map.expected(), trip.expected(), "{id}");
            assert_eq!(map.expected(), "direct (change: required)", "{id}");
        }
        // Where the person names the browser for a site's own words, a map of them goes to the
        // browser first, with search as without it: the line that keeps a map's research with it
        // doesn't reach a site to use.
        for (id, searching) in [
            ("map-from-a-site-in-the-browser", false),
            ("map-from-a-site-in-the-browser-searching", true),
        ] {
            let map = case(&cases, id);
            assert_eq!(map.integrated_search, searching, "{id}");
            assert_eq!(map.research_pages_search_first, searching, "{id}");
            assert_eq!(map.expected(), "browser_then_build", "{id}");
        }
        // A question about a shop's policy beside an order number stays with Octo whether or not
        // it can search the web for the message: the twins differ only in that line.
        let (searching, without) = (
            case(&cases, "policy-beside-an-order-number-searching"),
            case(&cases, "policy-beside-an-order-number"),
        );
        assert!(searching.integrated_search && !without.integrated_search);
        assert!(!searching.research_pages_search_first);
        // Hotels for dates nobody named are research answered in a reply where Octo can search
        // the web, and research that ends in a page once they go on one: the page browses first
        // where only replies' research searches first.
        let (reply, page) = (
            case(&cases, "hotel-for-dates-nobody-named-searching"),
            case(&cases, "hotels-for-dates-nobody-named-page-searching"),
        );
        assert!(reply.integrated_search && page.integrated_search);
        assert!(!reply.research_pages_search_first && !page.research_pages_search_first);
        assert_eq!(page.expect.route, "browser_then_build");
        // The routing input names the space's pages, each with the chat that made it, after the
        // part every chat shares; a case with no pages names none.
        let other = case(&cases, "change-to-another-chats-page");
        let input = routing_input(&other, workspace.path()).unwrap();
        let pages = "- The space's pages:\n  - \"Levoit Core 300 vs Blueair 411\", in `sites/levoit-blueair/`: made in this chat.\n  - \"Air purifiers: Levoit Core 300 vs Blueair 411 vs Coway Airmega\", in `sites/air-purifiers/`: made in another chat, read-only here.\n";
        assert!(input.prompt.contains(pages), "{}", input.prompt);
        assert!(!input.shared_start.contains("The space's pages"));
        assert!(input.prompt.starts_with(&input.shared_start));
        for id in ["comparison-page-watches", "news-then-open-the-article"] {
            let input = routing_input(&case(&cases, id), workspace.path()).unwrap();
            assert!(!input.prompt.contains("The space's pages"), "{id}");
        }
        // The pages were the space's for that case alone.
        assert!(!workspace.path().join("sites/air-purifiers").exists());
        assert!(
            !workspace
                .path()
                .join(super::super::space_pages::PAGES_RECORD)
                .exists()
        );
        // A reply's article goes to the browser by the address the reply linked: the routing
        // input holds the reply, and the case reads that address in the card's task.
        let article = case(&cases, "news-then-open-the-article");
        let address = &article.expect.summary_names[0];
        let input = routing_input(&article, workspace.path()).unwrap();
        assert!(input.prompt.contains(address.as_str()), "{}", input.prompt);
        let mut answer = answer_json("browser", "none");
        answer["summary"] = json!(format!("Open {address} and read the article."));
        assert!(article.answered_by(&read_answer(&answer, &article, &input)));
        answer["summary"] = json!("Open the Reuters article about Philips.");
        assert!(!article.answered_by(&read_answer(&answer, &article, &input)));
        // So does one whose reply linked no article, only the company's newsroom its news came
        // from and a share-price page, though the person calls it an article: the routing input
        // holds both addresses, and a summary that names the page, not its address, fails. Told
        // only "by address", such a summary named "the article linked in this chat", and its
        // browser turn opened the company's home page (a local test, Nov 19), so the section
        // says "whatever they call it".
        let two_links = case(&cases, "news-two-links-then-open-the-article");
        let newsroom = &two_links.expect.summary_names[0];
        let input = routing_input(&two_links, workspace.path()).unwrap();
        for address in [
            newsroom.as_str(),
            "https://finance.yahoo.com/quote/ERIC-B.ST/",
        ] {
            assert!(
                input.prompt.contains(address),
                "{address}: {}",
                input.prompt
            );
        }
        assert!(
            !two_links.history[1]["content"]
                .as_str()
                .unwrap()
                .contains("article")
        );
        answer["summary"] = json!(format!(
            "Open {newsroom} and summarise today's story there."
        ));
        assert!(two_links.answered_by(&read_answer(&answer, &two_links, &input)));
        answer["summary"] = json!("Open the Ericsson article linked in this chat in the browser.");
        assert!(!two_links.answered_by(&read_answer(&answer, &two_links, &input)));
        // The cases from `news-today` on are exactly these, and none is about a subject an
        // earlier case is about.
        let first = cases
            .iter()
            .position(|case| case.id == "news-today")
            .expect("news-today");
        let written: HashSet<String> = cases[first..].iter().map(|case| case.id.clone()).collect();
        assert_eq!(written, covered);
        for case in &cases[first..] {
            let words = std::iter::once(case.message.as_str())
                .chain(
                    case.history
                        .iter()
                        .filter_map(|entry| entry["content"].as_str()),
                )
                .collect::<Vec<_>>()
                .join("\n")
                .to_lowercase();
            for subject in [
                "porto",
                "lello",
                "bento",
                "seville",
                "alcázar",
                "lisbon",
                "framework",
                "kraków",
                "wawel",
                "kobo",
                "amsterdam",
                "github",
                "httpbin",
                "heat pump",
            ] {
                assert!(!words.contains(subject), "{}: {subject}", case.id);
            }
        }
        // A page, or a change to one, asked for with a value a reply here said wasn't confirmed
        // reads that reply, in a chat with a browser turn and in one without. So do a note in the
        // person's own words and a place added to a map after a reply that said something wasn't
        // found or confirmed, which stay `direct` (`required`): the map's skill looks up its own
        // places, and a note is as the person wrote it.
        for (id, reply) in [
            (
                "page-with-a-value-the-browser-did-not-confirm",
                "I couldn't confirm whether the dinosaur gallery needs a ticket",
            ),
            (
                "page-with-a-value-a-reply-did-not-confirm",
                "I couldn't confirm today's price",
            ),
            (
                "price-added-to-a-page-a-reply-did-not-confirm",
                "It leaves out the price, which I couldn't confirm.",
            ),
            (
                "note-on-a-sight-a-map-did-not-find",
                "Not found yet: the Asinelli Tower",
            ),
            (
                "sight-a-map-did-not-find-on-a-day",
                "Not found yet: the Asinelli Tower",
            ),
            (
                "note-in-own-words-on-a-page-about-an-unconfirmed-value",
                "I couldn't confirm whether the dinosaur gallery needs a ticket",
            ),
        ] {
            let case = case(&cases, id);
            let input = routing_input(&case, workspace.path()).unwrap();
            assert!(input.prompt.contains(reply), "{id}: {}", input.prompt);
            if case.expect.route == "direct" {
                assert_eq!(
                    case.expect.workspace_file_change_requirement,
                    Some(vec!["required".to_string()]),
                    "{id}"
                );
            }
        }
    }
}
