//! Bounded, content-free runtime usage receipts. These measure root calls; they
//! do not authorize a customer charge or replace managed-AI reconciliation.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

const MAX_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_CALLS: usize = 128;
const MAX_JOB_RECEIPTS: usize = 32;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// These fields are controller-owned results, never authoring instructions.
/// Strip them even for service-role dispatches: only agent completion may
/// establish a receipt. Mirror the metadata wrappers used by recorded messages.
pub(crate) fn strip_authoring_claims(value: &mut Value) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    map.remove("aiTaskUsage");
    map.remove("aiTaskUsageTruncated");
    for key in ["details", "prompt_metadata", "promptMetadata"] {
        if let Some(nested) = map.get_mut(key) {
            strip_authoring_claims(nested);
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskUsageReceipt {
    kind: String,
    version: u32,
    coverage: String,
    calls: Vec<CallReceipt>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CallReceipt {
    invocation_id: Uuid,
    attempt: u32,
    phase: Phase,
    outcome: Outcome,
    usage_status: UsageStatus,
    usage_scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Routing,
    Main,
    Recovery,
    Finalization,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Success,
    Error,
    Timeout,
    Cancelled,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum UsageStatus {
    Reported,
    Partial,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Usage {
    input_tokens: u64,
    cached_input_tokens: u64,
    cache_write_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
}

impl Usage {
    fn counters_are_safe(&self) -> bool {
        [
            self.input_tokens,
            self.cached_input_tokens,
            self.cache_write_input_tokens,
            self.output_tokens,
            self.reasoning_output_tokens,
            self.total_tokens,
        ]
        .into_iter()
        .all(|value| value <= MAX_SAFE_INTEGER)
    }
}

/// Extract before the generic artifact cap. An absent legacy receipt stays
/// absent; malformed or duplicate receipts never turn into a numeric zero.
pub(crate) fn extract(artifacts: &Value) -> Result<Option<TaskUsageReceipt>, &'static str> {
    let Some(artifacts) = artifacts.as_array() else {
        return Ok(None);
    };
    let mut candidates = artifacts
        .iter()
        .filter(|artifact| artifact.get("kind").and_then(Value::as_str) == Some("ai/task-usage"));
    let Some(candidate) = candidates.next() else {
        return Ok(None);
    };
    if candidates.next().is_some() {
        return Err("duplicate task usage receipts");
    }
    if serde_json::to_vec(candidate)
        .map_err(|_| "invalid receipt JSON")?
        .len()
        > MAX_RECEIPT_BYTES
    {
        return Err("task usage receipt exceeds size cap");
    }
    let receipt: TaskUsageReceipt =
        serde_json::from_value(candidate.clone()).map_err(|_| "invalid task usage schema")?;
    if receipt.kind != "ai/task-usage"
        || receipt.version != 1
        || receipt.coverage != "root_turns_only"
        || receipt.calls.len() > MAX_CALLS
    {
        return Err("unsupported task usage receipt");
    }
    let mut seen = HashSet::new();
    for call in &receipt.calls {
        if call.attempt == 0
            || call.usage_scope != "turn"
            || !seen.insert((call.invocation_id, call.attempt))
        {
            return Err("invalid or duplicate task usage call identity");
        }
        match (&call.usage_status, &call.usage) {
            (UsageStatus::Unknown, None) => {}
            (UsageStatus::Reported | UsageStatus::Partial, Some(usage))
                if usage.counters_are_safe() => {}
            _ => return Err("invalid task usage coverage"),
        }
        if matches!(call.usage_status, UsageStatus::Reported)
            && !matches!(call.outcome, Outcome::Success)
        {
            return Err("completed usage requires a successful root call");
        }
    }
    Ok(Some(receipt))
}

/// Store once by the authenticated job id. Repeated completion metadata writes
/// replace that job's receipt; they never add its counters a second time.
pub(crate) fn merge_into_metadata(
    metadata: &mut Map<String, Value>,
    job_id: &Uuid,
    receipt: &TaskUsageReceipt,
) -> bool {
    let job_key = job_id.to_string();
    let receipts = metadata
        .entry("aiTaskUsage")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(receipts) = receipts.as_object_mut() else {
        metadata.insert("aiTaskUsageTruncated".into(), Value::Bool(true));
        return false;
    };
    if receipts.len() >= MAX_JOB_RECEIPTS && !receipts.contains_key(&job_key) {
        metadata.insert("aiTaskUsageTruncated".into(), Value::Bool(true));
        return false;
    }
    let Ok(value) = serde_json::to_value(receipt) else {
        return false;
    };
    receipts.insert(job_key, value);
    true
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn receipt_fixture() -> Value {
        json!({
            "kind": "ai/task-usage", "version": 1, "coverage": "root_turns_only",
            "truncated": false,
            "calls": [{
                "invocationId": "cd5724d4-fadc-4a34-b938-a31a38f2d8aa", "attempt": 1,
                "phase": "main", "outcome": "success", "usageStatus": "reported",
                "usageScope": "turn", "usage": {
                    "input_tokens": 100, "cached_input_tokens": 40,
                    "cache_write_input_tokens": 0, "output_tokens": 10,
                    "reasoning_output_tokens": 2, "total_tokens": 110
                }
            }]
        })
    }

    #[test]
    fn authoring_metadata_cannot_seed_receipts_or_exhaust_the_job_cap() {
        let mut metadata = json!({
            "aiTaskUsage": { "forged-job": receipt_fixture() },
            "aiTaskUsageTruncated": true,
            "clientMessageId": "keep",
            "details": { "aiTaskUsage": {}, "reason": "keep" },
            "prompt_metadata": { "promptMetadata": { "aiTaskUsageTruncated": false } }
        });
        strip_authoring_claims(&mut metadata);
        assert_eq!(
            metadata,
            json!({
                "clientMessageId": "keep", "details": { "reason": "keep" },
                "prompt_metadata": { "promptMetadata": {} }
            })
        );
    }

    #[test]
    fn rejects_duplicate_receipts_and_call_keys() {
        let receipt = receipt_fixture();
        assert!(extract(&json!([receipt, receipt])).is_err());
        let mut receipt = receipt_fixture();
        let call = receipt["calls"][0].clone();
        receipt["calls"].as_array_mut().unwrap().push(call);
        assert!(extract(&json!([receipt])).is_err());
    }

    #[test]
    fn failed_and_missing_usage_are_not_a_reported_zero() {
        let mut receipt = receipt_fixture();
        let mut failed = receipt["calls"][0].clone();
        failed["attempt"] = json!(2);
        failed["phase"] = json!("recovery");
        failed["outcome"] = json!("error");
        failed["usageStatus"] = json!("partial");
        let mut unknown = failed.clone();
        unknown["attempt"] = json!(3);
        unknown["outcome"] = json!("timeout");
        unknown["usageStatus"] = json!("unknown");
        unknown.as_object_mut().unwrap().remove("usage");
        receipt["calls"]
            .as_array_mut()
            .unwrap()
            .extend([failed, unknown]);
        let parsed = extract(&json!([receipt])).unwrap().unwrap();
        let roundtrip = serde_json::to_value(parsed).unwrap();
        assert_eq!(roundtrip["calls"][1]["usageStatus"], "partial");
        assert!(roundtrip["calls"][2].get("usage").is_none());
        assert!(extract(&json!([{ "kind": "codex/run-log", "events": [] }]))
            .unwrap()
            .is_none());
    }

    #[test]
    fn reported_zero_and_unknown_usage_stay_distinct() {
        let mut zero = receipt_fixture();
        for counter in zero["calls"][0]["usage"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            *counter = json!(0);
        }
        let parsed = extract(&json!([zero.clone()])).unwrap().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), zero);

        let mut unknown = zero.clone();
        unknown["calls"][0]["usageStatus"] = json!("unknown");
        assert!(extract(&json!([unknown.clone()])).is_err());
        unknown["calls"][0].as_object_mut().unwrap().remove("usage");
        let parsed = extract(&json!([unknown.clone()])).unwrap().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), unknown);
        assert_ne!(unknown, zero);
    }

    #[test]
    fn rejects_malformed_unbounded_or_content_bearing_receipts() {
        for (pointer, value) in [
            ("/version", json!(2)),
            ("/coverage", json!("all_provider_calls")),
            ("/calls/0/invocationId", json!("not-a-uuid")),
            ("/calls/0/attempt", json!(0)),
            ("/calls/0/phase", json!("other")),
            ("/calls/0/usageScope", json!("thread")),
            ("/calls/0/usage/input_tokens", json!(-1)),
            ("/calls/0/usage/output_tokens", json!(1.5)),
            ("/calls/0/usage/total_tokens", json!(MAX_SAFE_INTEGER + 1)),
            ("/calls/0/usageStatus", json!("unknown")),
            ("/calls/0/outcome", json!("error")),
        ] {
            let mut receipt = receipt_fixture();
            *receipt.pointer_mut(pointer).unwrap() = value;
            assert!(extract(&json!([receipt])).is_err(), "{pointer}");
        }
        let mut receipt = receipt_fixture();
        receipt["calls"][0]["prompt"] = json!("must never persist");
        assert!(extract(&json!([receipt])).is_err());
        let mut receipt = receipt_fixture();
        receipt["padding"] = json!("x".repeat(MAX_RECEIPT_BYTES));
        assert!(extract(&json!([receipt])).is_err());
        let mut receipt = receipt_fixture();
        let call = receipt["calls"][0].clone();
        receipt["calls"] = json!(vec![call; MAX_CALLS + 1]);
        assert!(extract(&json!([receipt])).is_err());
    }

    #[test]
    fn job_receipts_replace_on_replay_without_accumulating() {
        let receipt = extract(&json!([receipt_fixture()])).unwrap().unwrap();
        let job_id = Uuid::new_v4();
        let mut metadata = Map::new();
        assert!(merge_into_metadata(&mut metadata, &job_id, &receipt));
        let first = metadata.clone();
        assert!(merge_into_metadata(&mut metadata, &job_id, &receipt));
        assert_eq!(metadata, first);
        assert_eq!(metadata["aiTaskUsage"].as_object().unwrap().len(), 1);
        for _ in 1..MAX_JOB_RECEIPTS {
            assert!(merge_into_metadata(
                &mut metadata,
                &Uuid::new_v4(),
                &receipt
            ));
        }
        assert!(!merge_into_metadata(
            &mut metadata,
            &Uuid::new_v4(),
            &receipt
        ));
        assert_eq!(metadata["aiTaskUsageTruncated"], true);
        assert!(merge_into_metadata(&mut metadata, &job_id, &receipt));
    }
}
