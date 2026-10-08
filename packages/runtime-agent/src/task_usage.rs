//! Bounded, content-free observations of root Codex calls. These are diagnostic receipts,
//! not a billing authority: subagents and provider work without a returned count are absent.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_CALLS: usize = 128;
const MAX_RESPONSES_PER_ATTEMPT: usize = 1024;
const MAX_RESPONSE_ID_BYTES: usize = 256;
const MAX_COUNTER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsagePhase {
    Routing,
    Main,
    Recovery,
    Finalization,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UsageOutcome {
    Success,
    Error,
    Timeout,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub(crate) struct UsageCounts {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub cache_write_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

impl UsageCounts {
    fn valid(&self) -> bool {
        [
            self.input_tokens,
            self.cached_input_tokens,
            self.cache_write_input_tokens,
            self.output_tokens,
            self.reasoning_output_tokens,
            self.total_tokens,
        ]
        .into_iter()
        .all(|value| (0..=MAX_COUNTER).contains(&value))
    }

    fn checked_add(self, other: Self) -> Option<Self> {
        let add = |left: i64, right: i64| {
            left.checked_add(right)
                .filter(|value| (0..=MAX_COUNTER).contains(value))
        };
        Some(Self {
            input_tokens: add(self.input_tokens, other.input_tokens)?,
            cached_input_tokens: add(self.cached_input_tokens, other.cached_input_tokens)?,
            cache_write_input_tokens: add(
                self.cache_write_input_tokens,
                other.cache_write_input_tokens,
            )?,
            output_tokens: add(self.output_tokens, other.output_tokens)?,
            reasoning_output_tokens: add(
                self.reasoning_output_tokens,
                other.reasoning_output_tokens,
            )?,
            total_tokens: add(self.total_tokens, other.total_tokens)?,
        })
    }
}

#[derive(Debug, Default)]
struct Observations {
    calls: Vec<UsageAttempt>,
    truncated: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TaskUsage(Arc<Mutex<Observations>>);

impl TaskUsage {
    pub fn call(&self, phase: UsagePhase) -> UsageCall {
        UsageCall {
            task: self.clone(),
            invocation_id: Uuid::new_v4(),
            phase,
        }
    }

    pub fn artifact(&self) -> Option<Value> {
        let observations = self.0.lock();
        if observations.calls.is_empty() && !observations.truncated {
            return None;
        }
        Some(json!({
            "kind": "ai/task-usage",
            "version": 1,
            "coverage": "root_turns_only",
            "truncated": observations.truncated,
            "calls": observations.calls.iter().map(UsageAttempt::receipt).collect::<Vec<_>>(),
        }))
    }
}

#[derive(Debug, Clone)]
pub struct UsageCall {
    task: TaskUsage,
    invocation_id: Uuid,
    phase: UsagePhase,
}

impl UsageCall {
    /// Options may be cloned and reused by callers. Every actual execution gets a fresh
    /// invocation identity, while its internal retries keep that identity.
    pub(crate) fn new_invocation(&self) -> Self {
        Self {
            task: self.task.clone(),
            invocation_id: Uuid::new_v4(),
            phase: self.phase,
        }
    }

    pub(crate) fn start_attempt(&self, attempt: usize) -> UsageAttempt {
        let observation = UsageAttempt(Arc::new(Mutex::new(AttemptState {
            invocation_id: self.invocation_id,
            attempt,
            phase: self.phase,
            usage: None,
            response_ids: HashSet::new(),
            incomplete: false,
            completed: false,
            outcome: None,
        })));
        let mut task = self.task.0.lock();
        if task.calls.len() < MAX_CALLS {
            task.calls.push(observation.clone());
        } else {
            task.truncated = true;
        }
        observation
    }
}

#[derive(Debug)]
struct AttemptState {
    invocation_id: Uuid,
    attempt: usize,
    phase: UsagePhase,
    usage: Option<UsageCounts>,
    response_ids: HashSet<String>,
    incomplete: bool,
    completed: bool,
    outcome: Option<UsageOutcome>,
}

#[derive(Debug, Clone)]
pub(crate) struct UsageAttempt(Arc<Mutex<AttemptState>>);

impl UsageAttempt {
    /// Count only the exact usage attached to a completed response from this root turn.
    /// Cumulative TokenCount events may be restored or estimated and are never inputs here.
    /// Response IDs are bounded, ephemeral deduplication keys and never enter the receipt.
    pub(crate) fn observe_response(&self, response_id: &str, usage: Option<UsageCounts>) {
        let mut state = self.0.lock();
        if response_id.trim().is_empty() || response_id.len() > MAX_RESPONSE_ID_BYTES {
            state.incomplete = true;
            return;
        }
        if state.response_ids.contains(response_id) {
            return;
        }
        if state.response_ids.len() >= MAX_RESPONSES_PER_ATTEMPT {
            state.incomplete = true;
            return;
        }
        state.response_ids.insert(response_id.to_string());
        let Some(usage) = usage.filter(UsageCounts::valid) else {
            state.incomplete = true;
            return;
        };
        match state.usage.unwrap_or_default().checked_add(usage) {
            Some(total) => state.usage = Some(total),
            // Keep earlier known usage; neither overflow nor missing usage means zero.
            None => state.incomplete = true,
        }
    }

    pub(crate) fn completed(&self) {
        self.0.lock().completed = true;
    }

    pub(crate) fn finish(&self, outcome: UsageOutcome) {
        self.0.lock().outcome = Some(outcome);
    }

    fn receipt(&self) -> Value {
        let state = self.0.lock();
        // A cancelled future may not reach its finalizer. Never imply that such a reading
        // is complete, even when a count was observed before cancellation.
        let outcome = state.outcome.unwrap_or(UsageOutcome::Cancelled);
        let status = match state.usage {
            None => "unknown",
            Some(_) if state.completed && outcome == UsageOutcome::Success && !state.incomplete => {
                "reported"
            }
            Some(_) => "partial",
        };
        let mut receipt = json!({
            "invocationId": state.invocation_id,
            "attempt": state.attempt,
            "phase": state.phase,
            "outcome": outcome,
            "usageStatus": status,
            "usageScope": "turn",
        });
        if let Some(usage) = state.usage {
            receipt["usage"] = json!(usage);
        }
        receipt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(input: i64) -> UsageCounts {
        UsageCounts {
            input_tokens: input,
            cached_input_tokens: 4,
            cache_write_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: input + 2,
        }
    }

    #[test]
    fn preserves_equal_counts_across_phases_and_internal_retries() {
        let task = TaskUsage::default();
        for phase in [
            UsagePhase::Routing,
            UsagePhase::Main,
            UsagePhase::Recovery,
            UsagePhase::Finalization,
        ] {
            let call = task.call(phase);
            for attempt in 1..=2 {
                let observation = call.start_attempt(attempt);
                observation.observe_response("response-1", Some(counts(10)));
                observation.observe_response("response-1", Some(counts(10)));
                observation.completed();
                observation.finish(UsageOutcome::Success);
            }
        }
        let artifact = task.artifact().unwrap();
        let calls = artifact["calls"].as_array().unwrap();
        assert_eq!(calls.len(), 8);
        let mut keys = std::collections::HashSet::new();
        for call in calls {
            assert_eq!(call["usage"]["input_tokens"], 10);
            assert_eq!(call["usageStatus"], "reported");
            assert!(keys.insert((
                call["invocationId"].as_str().unwrap(),
                call["attempt"].as_u64().unwrap()
            )));
        }
        assert_eq!(calls[0]["invocationId"], calls[1]["invocationId"]);
        assert_ne!(calls[1]["invocationId"], calls[2]["invocationId"]);
    }

    #[test]
    fn distinct_responses_sum_without_double_counting_replayed_ids() {
        let task = TaskUsage::default();
        let attempt = task.call(UsagePhase::Main).start_attempt(1);
        let usage = UsageCounts {
            cache_write_input_tokens: 3,
            ..counts(10)
        };
        attempt.observe_response("response-1", Some(usage));
        attempt.observe_response("response-2", Some(usage));
        attempt.observe_response("response-1", Some(usage));
        attempt.completed();
        attempt.finish(UsageOutcome::Success);
        let receipt = attempt.receipt();
        assert_eq!(receipt["usageStatus"], "reported");
        assert_eq!(
            receipt["usage"],
            json!({
                "input_tokens": 20,
                "cached_input_tokens": 8,
                "cache_write_input_tokens": 6,
                "output_tokens": 4,
                "reasoning_output_tokens": 2,
                "total_tokens": 24,
            })
        );
        assert!(!receipt.to_string().contains("response-"));
    }

    #[test]
    fn missing_or_invalid_response_usage_preserves_known_counts_as_partial() {
        for missing in [
            None,
            Some(UsageCounts {
                input_tokens: -1,
                ..counts(10)
            }),
            Some(UsageCounts {
                cached_input_tokens: MAX_COUNTER + 1,
                ..counts(10)
            }),
        ] {
            let task = TaskUsage::default();
            let attempt = task.call(UsagePhase::Main).start_attempt(1);
            attempt.observe_response("response-1", Some(counts(10)));
            attempt.observe_response("response-2", missing);
            attempt.observe_response("response-3", Some(counts(10)));
            attempt.completed();
            attempt.finish(UsageOutcome::Success);
            let receipt = attempt.receipt();
            assert_eq!(receipt["usageStatus"], "partial");
            assert_eq!(receipt["usage"]["input_tokens"], 20);
            assert_eq!(receipt["usage"]["total_tokens"], 24);
        }
    }

    #[test]
    fn explicit_zero_is_reported_but_missing_response_usage_is_unknown() {
        let task = TaskUsage::default();
        for usage in [Some(UsageCounts::default()), None] {
            let attempt = task.call(UsagePhase::Main).start_attempt(1);
            attempt.observe_response("response-1", usage);
            attempt.completed();
            attempt.finish(UsageOutcome::Success);
            let receipt = attempt.receipt();
            match usage {
                Some(usage) => {
                    assert_eq!(receipt["usageStatus"], "reported");
                    assert_eq!(receipt["usage"], json!(usage));
                }
                None => {
                    assert_eq!(receipt["usageStatus"], "unknown");
                    assert!(receipt.get("usage").is_none());
                }
            }
        }
    }

    #[test]
    fn unsafe_sum_retains_prior_counts_without_saturating_or_wrapping() {
        let task = TaskUsage::default();
        let attempt = task.call(UsagePhase::Main).start_attempt(1);
        let first = UsageCounts {
            input_tokens: MAX_COUNTER,
            total_tokens: MAX_COUNTER,
            ..UsageCounts::default()
        };
        attempt.observe_response("response-1", Some(first));
        attempt.observe_response("response-2", Some(counts(10)));
        attempt.completed();
        attempt.finish(UsageOutcome::Success);
        let receipt = attempt.receipt();
        assert_eq!(receipt["usageStatus"], "partial");
        assert_eq!(receipt["usage"], json!(first));
    }

    #[test]
    fn response_id_limits_bound_memory_and_disclose_omitted_usage() {
        for invalid_id in [
            String::new(),
            " ".to_string(),
            "x".repeat(MAX_RESPONSE_ID_BYTES + 1),
        ] {
            let task = TaskUsage::default();
            let attempt = task.call(UsagePhase::Main).start_attempt(1);
            attempt.observe_response("response-1", Some(counts(10)));
            attempt.observe_response(&invalid_id, Some(counts(10)));
            attempt.completed();
            attempt.finish(UsageOutcome::Success);
            let receipt = attempt.receipt();
            assert_eq!(receipt["usageStatus"], "partial");
            assert_eq!(receipt["usage"], json!(counts(10)));
        }

        let task = TaskUsage::default();
        let attempt = task.call(UsagePhase::Main).start_attempt(1);
        for index in 0..MAX_RESPONSES_PER_ATTEMPT {
            attempt.observe_response(&format!("response-{index}"), Some(counts(10)));
        }
        // A repeat at capacity remains free; a new response cannot be stored or counted.
        attempt.observe_response("response-0", Some(counts(10)));
        attempt.completed();
        attempt.finish(UsageOutcome::Success);
        assert_eq!(attempt.receipt()["usageStatus"], "reported");
        attempt.observe_response("response-over-cap", Some(counts(10)));
        let receipt = attempt.receipt();
        assert_eq!(receipt["usageStatus"], "partial");
        assert_eq!(
            receipt["usage"]["input_tokens"],
            (MAX_RESPONSES_PER_ATTEMPT * 10) as i64
        );
        assert_eq!(
            attempt.0.lock().response_ids.len(),
            MAX_RESPONSES_PER_ATTEMPT
        );
    }

    #[test]
    fn failed_and_cancelled_readings_are_partial_and_missing_is_not_zero() {
        let task = TaskUsage::default();
        for outcome in [
            UsageOutcome::Error,
            UsageOutcome::Timeout,
            UsageOutcome::Cancelled,
        ] {
            let attempt = task.call(UsagePhase::Main).start_attempt(1);
            attempt.observe_response("response-1", Some(counts(10)));
            attempt.finish(outcome);
        }
        task.call(UsagePhase::Recovery)
            .start_attempt(1)
            .finish(UsageOutcome::Error);
        let artifact = task.artifact().unwrap();
        let calls = artifact["calls"].as_array().unwrap();
        assert!(
            calls[..3]
                .iter()
                .all(|call| call["usageStatus"] == "partial")
        );
        assert_eq!(calls[3]["usageStatus"], "unknown");
        assert!(calls[3].get("usage").is_none());
    }

    #[test]
    fn reusing_an_observer_does_not_reuse_an_invocation_identity() {
        let task = TaskUsage::default();
        let observer = task.call(UsagePhase::Main);
        for _ in 0..2 {
            observer
                .new_invocation()
                .start_attempt(1)
                .finish(UsageOutcome::Success);
        }
        let artifact = task.artifact().unwrap();
        assert_ne!(
            artifact["calls"][0]["invocationId"],
            artifact["calls"][1]["invocationId"]
        );
    }

    #[test]
    fn bounded_receipts_disclose_truncation_and_reject_unsafe_counts() {
        let task = TaskUsage::default();
        assert!(task.artifact().is_none());
        for _ in 0..=MAX_CALLS {
            let attempt = task.call(UsagePhase::Main).start_attempt(1);
            attempt.observe_response("response-1", Some(counts(MAX_COUNTER + 1)));
            attempt.finish(UsageOutcome::Success);
        }
        let artifact = task.artifact().unwrap();
        assert_eq!(artifact["calls"].as_array().unwrap().len(), MAX_CALLS);
        assert_eq!(artifact["truncated"], true);
        assert!(
            artifact["calls"]
                .as_array()
                .unwrap()
                .iter()
                .all(|call| call["usageStatus"] == "unknown" && call.get("usage").is_none())
        );
    }
}
