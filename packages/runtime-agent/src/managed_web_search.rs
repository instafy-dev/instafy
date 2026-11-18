//! Instafy AI's web searches: how many a message may run, and what they cost.
//!
//! A managed run (Instafy AI: a run and no credential of its own) searches through the proxy's
//! search bridge, and each search costs the person credits (`docs/Credits-Billing.md`, "Web
//! search for Instafy AI"). So the runtime holds a message's allowance of searches here:
//!
//! - A message may run [`SEARCHES_PER_MESSAGE`] searches, or [`SEARCHES_FOR_DEEPER_RESEARCH`]
//!   when its routing step read the person's own words as asking for deeper research
//!   (`deeperResearch`, which the job also tells the controller). The controller counts a
//!   message's searches across all its jobs (a team plan's, its several agents', the build after
//!   the browser), and the proxy asks it before each search, so the message as a whole keeps to
//!   them whichever machines its jobs run on. This runtime keeps to them too, for its own jobs: a
//!   build Instafy starts after the browser (a hand-back) goes on with the allowance of the turn
//!   whose card it carries on, and a job's later attempt with its earlier attempt's.
//! - The AI's search tool is wrapped ([`install`]): a call runs only as many of its queries as
//!   are left, and says so, and a call with none left does not run: the model reads
//!   [`limit_line`] in its place. What the searches answered is kept ([`ManagedWebSearch::found`]),
//!   so a run of the same turn that starts afresh (a recovery retry on a new thread) reads it
//!   instead of searching again.
//! - What the bridge says each search cost (its `search_usage` entry: one search per query it
//!   searched, and the tokens of its request) is added up over the job's runs: its first, a
//!   recovery retry, one that ended in an error or its time limit. The job's completion carries
//!   it, whether the job succeeded or failed, as one [`WEB_SEARCH_USAGE_ARTIFACT`]
//!   ([`usage_artifact_of_job`]), which the controller charges on the job's message.
//!
//! A person's own ChatGPT login searches on their own plan: it has no allowance here, and none of
//! its searches is reported or charged.

use std::collections::VecDeque;
use std::sync::{Arc, LazyLock};

use codex_core::config::Config;
use codex_extension_api::{
    ExtensionData, ExtensionFuture, ExtensionRegistryBuilder, ExtensionTurnItem, FunctionCallError,
    StepPreparationInput, ToolCall, ToolContributor, ToolExecutor, ToolExecutorFuture, ToolName,
    ToolOutput, ToolPayload, ToolSpec, TurnItemEmissionFuture, TurnItemEmitter,
};
use codex_login::AuthManager;
use codex_protocol::models::{
    FunctionCallOutputBody, FunctionCallOutputContentItem, ResponseInputItem,
};
use codex_protocol::protocol::EventMsg;
use codex_utils_path_uri::PathUri;
use parking_lot::Mutex;
use serde_json::{Value as JsonValue, json};
use uuid::Uuid;

/// The web searches one message may run with Instafy AI.
pub(crate) const SEARCHES_PER_MESSAGE: u32 =
    runtime_contracts::research::MANAGED_WEB_SEARCHES_PER_MESSAGE;
/// The web searches a message whose own words ask for deeper research may run.
pub(crate) const SEARCHES_FOR_DEEPER_RESEARCH: u32 =
    runtime_contracts::research::MANAGED_WEB_SEARCHES_FOR_DEEPER_RESEARCH;
/// The most of what a message's searches answered that is kept for a run that starts afresh.
const MAX_FOUND_CHARS: usize = 12_000;
/// The most `search_query` entries one call of the search tool runs: the search bridge's own
/// limit (openai-proxy-server `search_bridge::MAX_QUERIES`), as codex's tool allows.
const QUERIES_PER_CALL: usize = 4;
/// How many recent jobs' allowances this runtime remembers, for the hand-backs and later attempts
/// that go on with them.
const REMEMBERED_JOBS: usize = 64;
/// The search tool this wraps: codex's `web.run`.
const SEARCH_TOOL_NAMESPACE: &str = "web";
const SEARCH_TOOL_NAME: &str = "run";
/// The search bridge's `results` entries this reads (openai-proxy-server `search_bridge.rs`).
const SEARCH_USAGE: &str = "search_usage";
const SEARCHED_QUERIES: &str = "searched_queries";
/// The kind of the artifact a job's completion carries with what its web searches cost
/// (runtime-controller `extract_web_search_usage_from_artifacts`).
pub(crate) const WEB_SEARCH_USAGE_ARTIFACT: &str = "ai/web-search-usage";

/// What searches cost, as the search bridge reports it: how many ran, and their requests' tokens
/// (the search content among the input).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchCost {
    pub searches: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
}

impl SearchCost {
    fn add(&mut self, other: SearchCost) {
        self.searches = self.searches.saturating_add(other.searches);
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
    }

    /// The job's [`WEB_SEARCH_USAGE_ARTIFACT`], which the controller charges.
    fn to_artifact(self) -> JsonValue {
        json!({
            "kind": WEB_SEARCH_USAGE_ARTIFACT,
            "searches": self.searches,
            "input_tokens": self.input_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "output_tokens": self.output_tokens,
        })
    }

    /// What one call's searches cost, from the `results` the bridge answered with: its
    /// `search_usage` entry, else one search for each query its `searched_queries` entry names
    /// (a bridge from before `search_usage`), with no tokens. None when the answer has neither: no
    /// bridge searched it.
    fn of_results(results: Option<&[JsonValue]>) -> Option<SearchCost> {
        let results = results?;
        let entry = |kind: &str| {
            results
                .iter()
                .find(|result| result.get("type").and_then(JsonValue::as_str) == Some(kind))
        };
        if let Some(usage) = entry(SEARCH_USAGE) {
            let count = |field: &str| usage.get(field).and_then(JsonValue::as_u64).unwrap_or(0);
            return Some(SearchCost {
                searches: count("searches"),
                input_tokens: count("input_tokens"),
                cached_input_tokens: count("cached_input_tokens"),
                output_tokens: count("output_tokens"),
            });
        }
        let searched = entry(SEARCHED_QUERIES)?
            .get("queries")
            .and_then(JsonValue::as_array)
            .map_or(0, Vec::len);
        Some(SearchCost {
            searches: searched as u64,
            ..SearchCost::default()
        })
    }
}

/// One message's allowance of web searches, shared by its turn's runs and native helpers, and by
/// the hand-back that goes on with it.
#[derive(Debug)]
pub struct ManagedWebSearch {
    limit: u32,
    state: Mutex<AllowanceState>,
}

#[derive(Debug, Default)]
struct AllowanceState {
    /// Searches that ran, and those a call still running holds.
    taken: u32,
    /// What the searches since the last report cost.
    unreported: SearchCost,
    /// What the calls that searched answered, as the model read it, up to [`MAX_FOUND_CHARS`].
    found: Vec<String>,
}

impl ManagedWebSearch {
    /// A message's allowance of `limit` searches, none used.
    pub fn new(limit: u32) -> Self {
        Self {
            limit,
            state: Mutex::new(AllowanceState::default()),
        }
    }

    pub(crate) fn limit(&self) -> u32 {
        self.limit
    }

    /// Holds up to `asked` searches for a call, and says how many it may run: none when the
    /// message has none left.
    fn hold(&self, asked: u32) -> u32 {
        let mut state = self.state.lock();
        let held = asked.min(self.limit.saturating_sub(state.taken));
        state.taken += held;
        held
    }

    /// Settles a call that held `held` searches: what its searches cost when it searched, else
    /// nothing. Searches it held and did not run (the bridge refused, merged or failed a query, or
    /// the call failed) are left for later calls. A call answered by no bridge keeps them.
    fn settle(&self, held: u32, ended: Option<Option<SearchCost>>) {
        let mut state = self.state.lock();
        match ended {
            Some(Some(cost)) => {
                let ran = u32::try_from(cost.searches).unwrap_or(u32::MAX).min(held);
                state.taken -= held - ran;
                state.unreported.add(cost);
            }
            Some(None) => {}
            None => state.taken -= held,
        }
    }

    /// What the searches since the last report cost, which the job's completion reports
    /// ([`usage_artifact_of_job`]); None when none ran.
    pub fn take_unreported(&self) -> Option<SearchCost> {
        let cost = std::mem::take(&mut self.state.lock().unreported);
        (cost != SearchCost::default()).then_some(cost)
    }

    /// Keeps what a call that searched answered, as the model read it, while there is room.
    fn keep_found(&self, text: String) {
        let mut state = self.state.lock();
        let kept: usize = state.found.iter().map(|text| text.chars().count()).sum();
        let room = MAX_FOUND_CHARS.saturating_sub(kept);
        if room > 0 && !text.trim().is_empty() {
            state.found.push(text.chars().take(room).collect());
        }
    }

    /// What the message's searches answered so far, as the model read it, oldest first: a run of
    /// the same turn that starts afresh gets it in place of searching again.
    pub(crate) fn found(&self) -> Vec<String> {
        self.state.lock().found.clone()
    }
}

/// Records searches that ran on `allowance`, as a search call does, for tests elsewhere in the
/// crate.
#[cfg(test)]
pub(crate) fn record_searches_for_test(
    allowance: &ManagedWebSearch,
    searches: u32,
    input_tokens: u64,
    output_tokens: u64,
) {
    let held = allowance.hold(searches);
    allowance.settle(
        held,
        Some(Some(SearchCost {
            searches: u64::from(searches),
            input_tokens,
            cached_input_tokens: 0,
            output_tokens,
        })),
    );
}

/// Keeps `text` as what a call that searched answered on `allowance`, as a search call does, for
/// tests elsewhere in the crate.
#[cfg(test)]
pub(crate) fn keep_found_for_test(allowance: &ManagedWebSearch, text: &str) {
    allowance.keep_found(text.to_string());
}

/// The allowances of recent jobs, newest last.
static REMEMBERED: LazyLock<Mutex<VecDeque<(Uuid, Arc<ManagedWebSearch>)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

/// The allowance of `job_id`'s turn: the one an earlier attempt of the job held, else the one of
/// the turn whose card it carries on (`goes_on_from`, a hand-back's), else a new one of `limit`
/// searches. A runtime that started since, or another runtime, has none of them: the turn gets a
/// new one.
pub(crate) fn allowance_for_job(
    job_id: Uuid,
    goes_on_from: Option<Uuid>,
    limit: u32,
) -> Arc<ManagedWebSearch> {
    let mut remembered = REMEMBERED.lock();
    let find = |remembered: &VecDeque<(Uuid, Arc<ManagedWebSearch>)>, id: Uuid| {
        remembered
            .iter()
            .find(|(job, _)| *job == id)
            .map(|(_, allowance)| allowance.clone())
    };
    if let Some(allowance) = find(&remembered, job_id) {
        return allowance;
    }
    let allowance = goes_on_from
        .and_then(|card_job| find(&remembered, card_job))
        .unwrap_or_else(|| Arc::new(ManagedWebSearch::new(limit)));
    if remembered.len() >= REMEMBERED_JOBS {
        remembered.pop_front();
    }
    remembered.push_back((job_id, allowance.clone()));
    allowance
}

/// What `job_id`'s web searches cost since the last report, as the artifact its completion
/// carries ([`WEB_SEARCH_USAGE_ARTIFACT`]); None when the job has no allowance on this runtime or
/// searched nothing since. Taking it reports it: a later call answers only what was searched
/// after.
pub(crate) fn usage_artifact_of_job(job_id: Uuid) -> Option<JsonValue> {
    let allowance = REMEMBERED
        .lock()
        .iter()
        .find(|(job, _)| *job == job_id)
        .map(|(_, allowance)| allowance.clone())?;
    allowance.take_unreported().map(SearchCost::to_artifact)
}

/// What the model reads in place of a search when its message has none left. Another of the
/// message's turns may have used them, so it does not say that their results are at hand. (A
/// recovery retry that starts afresh reads what its first attempt found, and does not search.)
pub(crate) fn limit_line(limit: u32) -> String {
    let more = if limit < SEARCHES_FOR_DEEPER_RESEARCH {
        " A message gets more only when the person's own words in it ask for deeper research."
    } else {
        ""
    };
    format!(
        "Not searched: this message has already used its {limit} web searches. Answer from what you have already found or read, read a page whose address you have with `instafy web read`, and say plainly what you could not check.{more}"
    )
}

/// What the model reads under a call that ran only the first `ran` of its queries.
fn fewer_line(ran: u32, limit: u32) -> String {
    let first = if ran == 1 {
        "query".to_string()
    } else {
        format!("{ran} queries")
    };
    format!(
        "Only the first {first} of this search ran: that was all this message had left of its {limit} web searches."
    )
}

/// Installs the AI's own web search into a run's registry. With an allowance, its search tool
/// keeps to it and counts what each search cost; the extension's other parts are its own.
pub(crate) fn install(
    builder: &mut ExtensionRegistryBuilder<Config>,
    auth_manager: Arc<AuthManager>,
    allowance: Option<Arc<ManagedWebSearch>>,
) {
    let Some(allowance) = allowance else {
        codex_web_search_extension::install(builder, auth_manager);
        return;
    };
    let mut own = ExtensionRegistryBuilder::new();
    codex_web_search_extension::install(&mut own, auth_manager);
    let own = own.build();
    for contributor in own.thread_lifecycle_contributors() {
        builder.thread_lifecycle_contributor(contributor.clone());
    }
    for contributor in own.config_contributors() {
        builder.config_contributor(contributor.clone());
    }
    for contributor in own.tool_contributors() {
        builder.tool_contributor(Arc::new(KeptToAllowance {
            inner: contributor.clone(),
            allowance: allowance.clone(),
        }));
    }
}

type Executor = Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>;

/// The search extension's tools, its search tool kept to the allowance.
struct KeptToAllowance {
    inner: Arc<dyn ToolContributor>,
    allowance: Arc<ManagedWebSearch>,
}

impl KeptToAllowance {
    fn keep(&self, tools: Vec<Executor>) -> Vec<Executor> {
        let search = ToolName::namespaced(SEARCH_TOOL_NAMESPACE, SEARCH_TOOL_NAME);
        tools
            .into_iter()
            .map(|tool| -> Executor {
                if tool.tool_name() == search {
                    Arc::new(KeptSearch {
                        inner: tool,
                        allowance: self.allowance.clone(),
                    })
                } else {
                    tool
                }
            })
            .collect()
    }
}

impl ToolContributor for KeptToAllowance {
    fn prepare_for_step<'a>(&'a self, input: StepPreparationInput<'a>) -> ExtensionFuture<'a, ()> {
        self.inner.prepare_for_step(input)
    }

    fn tools(&self, session_store: &ExtensionData, thread_store: &ExtensionData) -> Vec<Executor> {
        self.keep(self.inner.tools(session_store, thread_store))
    }

    fn tools_for_step(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
        step_store: &ExtensionData,
    ) -> Vec<Executor> {
        self.keep(
            self.inner
                .tools_for_step(session_store, thread_store, step_store),
        )
    }
}

/// The search tool, kept to a message's allowance.
struct KeptSearch {
    inner: Executor,
    allowance: Arc<ManagedWebSearch>,
}

impl<'call> ToolExecutor<ToolCall<'call>> for KeptSearch {
    fn tool_name(&self) -> ToolName {
        self.inner.tool_name()
    }

    fn spec(&self) -> ToolSpec {
        self.inner.spec()
    }

    fn exposure(&self) -> codex_tools::ToolExposure {
        self.inner.exposure()
    }

    fn search_info(&self) -> Option<codex_tools::ToolSearchInfo> {
        self.inner.search_info()
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.inner.supports_parallel_tool_calls()
    }

    fn environment_arguments(
        &self,
        payload: &ToolPayload,
    ) -> Result<Vec<(&'static str, String)>, FunctionCallError> {
        self.inner.environment_arguments(payload)
    }

    fn handle<'a>(&'a self, mut call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        ToolCall<'call>: 'a,
    {
        Box::pin(async move {
            let asked = asked_queries(&call.payload);
            if asked == 0 {
                // Opening or finding in a page, or another command: no search runs.
                return self.inner.handle(call).await;
            }
            let held = self.allowance.hold(asked);
            if held == 0 {
                return Err(FunctionCallError::RespondToModel(limit_line(
                    self.allowance.limit(),
                )));
            }
            if held < asked {
                keep_first_queries(&mut call.payload, held as usize);
            }
            let call_id = call.call_id.clone();
            let payload = call.payload.clone();
            let ended = Arc::new(Mutex::new(None));
            call.turn_item_emitter = Arc::new(SearchCostWatch {
                inner: call.turn_item_emitter.clone(),
                ended: ended.clone(),
            });
            let result = self.inner.handle(call).await;
            let ended = ended.lock().take();
            if let (Ok(output), Some(Some(cost))) = (&result, &ended)
                && cost.searches > 0
            {
                self.allowance
                    .keep_found(output_text(output.as_ref(), &call_id, &payload));
            }
            self.allowance.settle(held, ended);
            match result {
                Ok(output) if held < asked => Ok(Box::new(NotedOutput {
                    inner: output,
                    note: fewer_line(held, self.allowance.limit()),
                }) as Box<dyn ToolOutput>),
                result => result,
            }
        })
    }
}

/// The text the model reads for a call's output.
fn output_text(output: &dyn ToolOutput, call_id: &str, payload: &ToolPayload) -> String {
    let ResponseInputItem::FunctionCallOutput { output, .. } =
        output.to_response_item(call_id, payload)
    else {
        return String::new();
    };
    match output.body {
        FunctionCallOutputBody::Text(text) => text,
        FunctionCallOutputBody::ContentItems(items) => items
            .into_iter()
            .filter_map(|item| match item {
                FunctionCallOutputContentItem::InputText { text } => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// How many of a call's queries would search: its `search_query` entries, at most as many as one
/// call runs. Opening or finding in a page, and the search tool's other commands, run no search.
fn asked_queries(payload: &ToolPayload) -> u32 {
    let ToolPayload::Function { arguments } = payload else {
        return 0;
    };
    serde_json::from_str::<JsonValue>(arguments)
        .ok()
        .and_then(|arguments| {
            arguments
                .get("search_query")
                .and_then(JsonValue::as_array)
                .map(|queries| queries.len().min(QUERIES_PER_CALL) as u32)
        })
        .unwrap_or(0)
}

/// Keeps a call's first `kept` queries, and all else it asks.
fn keep_first_queries(payload: &mut ToolPayload, kept: usize) {
    let ToolPayload::Function { arguments } = payload else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<JsonValue>(arguments) else {
        return;
    };
    if let Some(queries) = value
        .get_mut("search_query")
        .and_then(JsonValue::as_array_mut)
    {
        queries.truncate(kept);
        *arguments = value.to_string();
    }
}

/// Passes a call's items on, and keeps what its search's end says the search cost.
struct SearchCostWatch {
    inner: Arc<dyn TurnItemEmitter>,
    /// Some once the search ended: what its bridge said it cost, or None from no bridge.
    ended: Arc<Mutex<Option<Option<SearchCost>>>>,
}

impl TurnItemEmitter for SearchCostWatch {
    fn emit_started<'a>(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a> {
        self.inner.emit_started(item)
    }

    fn emit_completed<'a>(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a> {
        for event in &item.legacy_events {
            if let EventMsg::WebSearchEnd(end) = event {
                *self.ended.lock() = Some(SearchCost::of_results(end.results.as_deref()));
            }
        }
        self.inner.emit_completed(item)
    }
}

/// A search's output, with a line after it for the model.
struct NotedOutput {
    inner: Box<dyn ToolOutput>,
    note: String,
}

impl ToolOutput for NotedOutput {
    fn log_output(&self) -> String {
        self.inner.log_output()
    }

    fn success_for_logging(&self) -> bool {
        self.inner.success_for_logging()
    }

    fn set_handler_duration_ms(&mut self, handler_duration_ms: u64) {
        self.inner.set_handler_duration_ms(handler_duration_ms);
    }

    fn contains_external_context(&self) -> bool {
        self.inner.contains_external_context()
    }

    fn fallback_token_limit_override(&self) -> Option<usize> {
        self.inner.fallback_token_limit_override()
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        let mut item = self.inner.to_response_item(call_id, payload);
        if let ResponseInputItem::FunctionCallOutput { output, .. } = &mut item {
            match &mut output.body {
                FunctionCallOutputBody::Text(text) => {
                    text.push_str("\n\n");
                    text.push_str(&self.note);
                }
                FunctionCallOutputBody::ContentItems(items) => {
                    items.push(FunctionCallOutputContentItem::InputText {
                        text: self.note.clone(),
                    });
                }
            }
        }
        item
    }

    fn post_tool_use_id(&self, call_id: &str) -> String {
        self.inner.post_tool_use_id(call_id)
    }

    fn post_tool_use_cwd(&self) -> Option<PathUri> {
        self.inner.post_tool_use_cwd()
    }

    fn post_tool_use_input(&self, payload: &ToolPayload) -> Option<JsonValue> {
        self.inner.post_tool_use_input(payload)
    }

    fn post_tool_use_response(&self, call_id: &str, payload: &ToolPayload) -> Option<JsonValue> {
        self.inner.post_tool_use_response(call_id, payload)
    }

    fn tool_result_metadata(&self) -> Option<&JsonValue> {
        self.inner.tool_result_metadata()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `results` the search bridge answers a call with: the queries it searched, and what
    /// they cost, then a page.
    fn bridge_results(queries: &[&str], tokens: u64) -> Vec<JsonValue> {
        vec![
            json!({"type": "searched_queries", "queries": queries}),
            json!({"type": "search_usage", "searches": queries.len(),
                   "input_tokens": tokens * queries.len() as u64, "cached_input_tokens": 0,
                   "output_tokens": 100 * queries.len() as u64}),
            json!({"type": "text_result", "url": "https://www.example.org/page"}),
        ]
    }

    fn cost(searches: u64, input_tokens: u64, output_tokens: u64) -> SearchCost {
        SearchCost {
            searches,
            input_tokens,
            cached_input_tokens: 0,
            output_tokens,
        }
    }

    /// A message runs two searches; the third finds none left. Searches a call held and did not
    /// run go back, so a refused or failed query costs no search of the message's.
    #[test]
    fn a_message_holds_two_searches_and_gets_back_those_that_did_not_run() {
        let allowance = ManagedWebSearch::new(SEARCHES_PER_MESSAGE);
        assert_eq!(allowance.hold(1), 1);
        allowance.settle(
            1,
            Some(SearchCost::of_results(Some(&bridge_results(&["a"], 8_000)))),
        );
        // Asked for three: one is left, so one is held.
        assert_eq!(allowance.hold(3), 1);
        // The bridge refused it as key-like: it searched nothing, and the search goes back.
        allowance.settle(
            1,
            Some(SearchCost::of_results(Some(&bridge_results(&[], 0)))),
        );
        assert_eq!(allowance.hold(2), 1);
        // The call failed: nothing ended, so its search goes back too.
        allowance.settle(1, None);
        assert_eq!(allowance.hold(1), 1);
        allowance.settle(
            1,
            Some(SearchCost::of_results(Some(&bridge_results(&["b"], 8_000)))),
        );
        assert_eq!(allowance.hold(1), 0, "a third search");
        assert_eq!(allowance.take_unreported(), Some(cost(2, 16_000, 200)));
        assert_eq!(allowance.take_unreported(), None, "reported once");

        // A message whose person asked for deeper research has more.
        let deeper = ManagedWebSearch::new(SEARCHES_FOR_DEEPER_RESEARCH);
        assert_eq!(deeper.hold(4), 4);
        assert_eq!(deeper.hold(4), 4);
        assert_eq!(deeper.hold(1), 0);
    }

    /// What the calls that searched answered is kept, oldest first, for a run of the same turn
    /// that starts afresh, up to its room; blank text keeps nothing.
    #[test]
    fn what_the_searches_answered_is_kept_for_a_run_that_starts_afresh() {
        let allowance = ManagedWebSearch::new(SEARCHES_PER_MESSAGE);
        assert!(allowance.found().is_empty());
        allowance.keep_found("Query 1: \"museum hours\"".into());
        allowance.keep_found("  \n ".into());
        allowance.keep_found("y".repeat(MAX_FOUND_CHARS));
        let found = allowance.found();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], "Query 1: \"museum hours\"");
        assert_eq!(
            found.iter().map(|text| text.chars().count()).sum::<usize>(),
            MAX_FOUND_CHARS
        );
        allowance.keep_found("z".into());
        assert_eq!(allowance.found().len(), 2, "no room left");
    }

    /// A search answered by no bridge (no entry of its own) keeps what it held, and reports
    /// nothing to charge; one answered by a bridge from before `search_usage` counts the queries
    /// it names, with no tokens.
    #[test]
    fn what_a_search_cost_comes_from_the_bridges_entries() {
        assert_eq!(
            SearchCost::of_results(Some(&bridge_results(&["a", "b"], 8_412))),
            Some(cost(2, 16_824, 200))
        );
        let older = [json!({"type": "searched_queries", "queries": ["a", "b", "c"]})];
        assert_eq!(SearchCost::of_results(Some(&older)), Some(cost(3, 0, 0)));
        let pages = [json!({"type": "text_result", "url": "https://www.example.org/"})];
        assert_eq!(SearchCost::of_results(Some(&pages)), None);
        assert_eq!(SearchCost::of_results(None), None);

        let allowance = ManagedWebSearch::new(SEARCHES_PER_MESSAGE);
        assert_eq!(allowance.hold(2), 2);
        allowance.settle(2, Some(None));
        assert_eq!(allowance.hold(1), 0, "it kept what it held");
        assert_eq!(allowance.take_unreported(), None);
    }

    /// Only a call's `search_query` entries search, at most four of them; opening or finding in a
    /// page searches nothing. A call sent fewer keeps the rest of what it asks.
    #[test]
    fn a_call_is_sent_only_the_queries_left() {
        let call = |arguments: JsonValue| ToolPayload::Function {
            arguments: arguments.to_string(),
        };
        let mut payload = call(json!({
            "search_query": [{"q": "a"}, {"q": "b", "recency": 7}, {"q": "c"}],
            "open": [{"ref_id": "https://www.example.org/"}],
            "response_length": "short",
        }));
        assert_eq!(asked_queries(&payload), 3);
        keep_first_queries(&mut payload, 1);
        let ToolPayload::Function { arguments } = &payload else {
            unreachable!()
        };
        assert_eq!(
            serde_json::from_str::<JsonValue>(arguments).unwrap(),
            json!({
                "search_query": [{"q": "a"}],
                "open": [{"ref_id": "https://www.example.org/"}],
                "response_length": "short",
            })
        );
        let five =
            json!({"search_query": [{"q": "1"}, {"q": "2"}, {"q": "3"}, {"q": "4"}, {"q": "5"}]});
        assert_eq!(asked_queries(&call(five)), 4);
        for searches_nothing in [
            json!({"open": [{"ref_id": "turn0search0"}]}),
            json!({"find": [{"ref_id": "turn0search0", "pattern": "price"}]}),
            json!({"search_query": []}),
            json!({}),
        ] {
            assert_eq!(
                asked_queries(&call(searches_nothing.clone())),
                0,
                "{searches_nothing}"
            );
        }
        assert_eq!(
            asked_queries(&ToolPayload::Function {
                arguments: "not json".into()
            }),
            0
        );
    }

    /// A hand-back goes on with the allowance of the turn whose card it carries on, and a job's
    /// later attempt with its own: the message keeps to one allowance. Any other turn gets a new
    /// one.
    #[test]
    fn a_hand_back_and_a_later_attempt_go_on_with_the_messages_allowance() {
        let message = Uuid::new_v4();
        let first = allowance_for_job(message, None, SEARCHES_FOR_DEEPER_RESEARCH);
        assert_eq!(first.hold(5), 5);
        first.settle(5, Some(Some(cost(5, 0, 0))));
        let again = allowance_for_job(message, None, SEARCHES_PER_MESSAGE);
        assert!(Arc::ptr_eq(&first, &again));
        let hand_back = allowance_for_job(Uuid::new_v4(), Some(message), SEARCHES_PER_MESSAGE);
        assert!(Arc::ptr_eq(&first, &hand_back));
        assert_eq!(hand_back.limit(), SEARCHES_FOR_DEEPER_RESEARCH);
        assert_eq!(hand_back.hold(8), 3);

        let unknown_card = allowance_for_job(Uuid::new_v4(), Some(Uuid::new_v4()), 2);
        assert!(!Arc::ptr_eq(&first, &unknown_card));
        assert_eq!(unknown_card.hold(4), 2);
    }

    /// A job's completion takes what its searches cost since the last report, once, as the
    /// artifact the controller charges; a job with no allowance here, or that searched nothing
    /// since, has none.
    #[test]
    fn a_jobs_report_takes_what_its_searches_cost_once() {
        let job = Uuid::new_v4();
        let allowance = allowance_for_job(job, None, SEARCHES_PER_MESSAGE);
        assert_eq!(usage_artifact_of_job(job), None, "nothing searched yet");
        record_searches_for_test(&allowance, 2, 16_824, 782);
        assert_eq!(
            usage_artifact_of_job(job),
            Some(
                json!({"kind": "ai/web-search-usage", "searches": 2, "input_tokens": 16_824,
                        "cached_input_tokens": 0, "output_tokens": 782})
            )
        );
        assert_eq!(usage_artifact_of_job(job), None, "reported once");
        assert_eq!(usage_artifact_of_job(Uuid::new_v4()), None);
    }

    /// Kept to an allowance, the search extension keeps all it registers: its thread and config
    /// contributors as they are, and its tools behind the allowance. Codex's extension registers
    /// nothing else; a bump that makes it register more fails here, so the wrapper takes that too.
    #[test]
    fn the_search_extension_keeps_all_it_registers_behind_the_allowance() {
        let auth = || {
            codex_login::AuthManager::from_auth_for_testing(codex_login::CodexAuth::from_api_key(
                "inert",
            ))
        };
        let counts = |registry: &codex_extension_api::ExtensionRegistry<Config>| {
            [
                registry.thread_lifecycle_contributors().len(),
                registry.config_contributors().len(),
                registry.tool_contributors().len(),
                registry.turn_lifecycle_contributors().len(),
                registry.token_usage_contributors().len(),
                registry.skill_invocation_contributors().len(),
                registry.context_contributors().len(),
                registry.mcp_server_contributors().len(),
                registry.turn_input_contributors().len(),
                registry.message_lifecycle_contributors().len(),
                registry.model_request_contributors().len(),
                registry.tool_lifecycle_contributors().len(),
                registry.turn_item_contributors().len(),
            ]
        };
        let mut codex = ExtensionRegistryBuilder::new();
        codex_web_search_extension::install(&mut codex, auth());
        let codex = codex.build();
        assert_eq!(counts(&codex), [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let mut kept = ExtensionRegistryBuilder::new();
        install(
            &mut kept,
            auth(),
            Some(Arc::new(ManagedWebSearch::new(SEARCHES_PER_MESSAGE))),
        );
        assert_eq!(counts(&kept.build()), counts(&codex));
    }

    /// The line the model reads names the allowance, says how to answer without more searches,
    /// and that only the person's own words get more; it names no price, provider or tool of
    /// the search. A run that starts afresh after an earlier one used the searches (a recovery
    /// retry) has none of their results, so the line never says it has.
    #[test]
    fn the_limit_line_says_what_to_do_in_plain_words() {
        assert_eq!(
            limit_line(SEARCHES_PER_MESSAGE),
            "Not searched: this message has already used its 2 web searches. Answer from what you have already found or read, read a page whose address you have with `instafy web read`, and say plainly what you could not check. A message gets more only when the person's own words in it ask for deeper research."
        );
        assert!(
            !limit_line(SEARCHES_PER_MESSAGE).contains("the searches and the pages you read found")
        );
        assert!(!limit_line(SEARCHES_FOR_DEEPER_RESEARCH).contains("deeper research"));
        assert_eq!(
            fewer_line(1, 2),
            "Only the first query of this search ran: that was all this message had left of its 2 web searches."
        );
        assert!(fewer_line(3, 8).starts_with("Only the first 3 queries of this search ran"));
        for line in [limit_line(2), fewer_line(1, 2)] {
            for word in ["credit", "OpenAI", "web.run", "proxy", "codex"] {
                assert!(!line.contains(word), "{word} in {line}");
            }
        }
    }
}
