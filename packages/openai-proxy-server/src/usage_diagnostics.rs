//! Opt-in, content-free observations of actual upstream attempts. These logs are
//! diagnostics, not a usage ledger or authority to charge a customer.

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use ring::digest::{SHA256, digest};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::proxy_auth::ProxyClaims;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_RESPONSE_ID_BYTES: usize = 512;
const MAX_TERMINAL_OBSERVATIONS: usize = 16;
const MAX_SSE_BUFFER_BYTES: usize = 16 * 1024 * 1024;

type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// Shared by clients rebuilt for credential renewal, so every real send keeps
/// its ingress request identity and receives a distinct attempt identity.
#[derive(Clone)]
pub(crate) struct UsageDiagnostics(Arc<Request>);

struct Request {
    id: Uuid,
    scope: Value,
    attempts: AtomicU64,
    sink: Sink,
}

impl UsageDiagnostics {
    pub(crate) fn from_env(claims: Option<&ProxyClaims>) -> Option<Self> {
        (std::env::var("PROXY_USAGE_DIAGNOSTICS").as_deref() == Ok("1")).then(|| {
            Self::new(
                claims,
                Arc::new(|record| {
                    write_record(std::io::stderr().lock(), &record);
                }),
            )
        })
    }

    fn new(claims: Option<&ProxyClaims>, sink: Sink) -> Self {
        // Only authenticated token claims establish correlation. No request
        // body, header, account identity, credential id or token is logged.
        let id = |value: Option<&str>| value.and_then(|value| Uuid::parse_str(value).ok());
        let scope = json!({
            "runId": id(claims.and_then(|claims| claims.run_id.as_deref())),
            "jobId": id(claims.and_then(|claims| claims.job_id.as_deref())),
            "leaseAttempt": claims.and_then(|claims| claims.lease_attempt)
                .filter(|attempt| *attempt > 0 && *attempt as u64 <= MAX_SAFE_INTEGER),
        });
        Self(Arc::new(Request {
            id: Uuid::new_v4(),
            scope,
            attempts: AtomicU64::new(0),
            sink,
        }))
    }

    pub(crate) fn start(
        &self,
        model: &str,
        wire_api: &'static str,
        outbound_payload: &Value,
    ) -> UsageAttempt {
        let mut attempt = UsageAttempt {
            request: self.clone(),
            id: Uuid::new_v4(),
            number: self.0.attempts.fetch_add(1, Ordering::Relaxed) + 1,
            model: safe_model_id(model),
            outbound_reasoning_effort: observed_reasoning_effort(outbound_payload, wire_api),
            wire_api,
            http_status: None,
            outcome: "interrupted",
            terminals: 0,
            truncated: false,
            sse_buffer: Vec::new(),
        };
        attempt.emit("attempt_started", json!({}));
        attempt
    }
}

/// Diagnostics must never abort a request, including while its guard is being
/// dropped during unwinding. Unlike `eprintln!`, an unavailable log destination
/// is a best-effort write failure, with no recursive attempt to report it.
fn write_record(mut output: impl std::io::Write, record: &Value) {
    let _ = writeln!(output, "[proxy] usage diagnostic {record}");
}

pub(crate) struct UsageAttempt {
    request: UsageDiagnostics,
    id: Uuid,
    number: u64,
    model: Option<String>,
    outbound_reasoning_effort: Option<&'static str>,
    wire_api: &'static str,
    http_status: Option<u16>,
    outcome: &'static str,
    terminals: usize,
    truncated: bool,
    sse_buffer: Vec<u8>,
}

impl UsageAttempt {
    fn emit(&mut self, event: &'static str, detail: Value) {
        let mut record = json!({
            "schemaVersion": 1,
            "event": event,
            "observedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "requestId": self.request.0.id,
            "attemptId": self.id,
            "attempt": self.number,
            "scope": self.request.0.scope,
            "model": self.model,
            "outboundReasoningEffort": self.outbound_reasoning_effort,
            "wireApi": self.wire_api,
        });
        record
            .as_object_mut()
            .unwrap()
            .extend(detail.as_object().unwrap().clone());
        (self.request.0.sink)(record);
    }

    pub(crate) fn http_status(&mut self, status: u16) {
        self.http_status = Some(status);
    }

    pub(crate) fn failure(&mut self, outcome: &'static str) {
        self.outcome = outcome;
    }

    pub(crate) fn observe_event(&mut self, event: &Value) {
        let status = match event.get("type").and_then(Value::as_str) {
            Some("response.completed") => "completed",
            Some("response.incomplete") => "incomplete",
            Some("response.failed") => "failed",
            Some("response.error") => "error",
            _ => return,
        };
        self.observe_response(event.get("response").unwrap_or(event), status);
    }

    /// Observe before adapting provider usage, which may default missing detail
    /// fields. Only allowlisted numeric fields and their presence are retained.
    pub(crate) fn observe_json(&mut self, response: &Value) {
        let status = match response.get("status").and_then(Value::as_str) {
            Some("failed") => "failed",
            Some("incomplete") => "incomplete",
            Some("completed") => "completed",
            _ if self.wire_api != "responses" => "completed",
            _ => "unknown",
        };
        self.observe_response(response, status);
    }

    fn observe_response(&mut self, response: &Value, status: &'static str) {
        if self.terminals >= MAX_TERMINAL_OBSERVATIONS {
            self.truncated = true;
            return;
        }
        self.terminals += 1;
        self.outcome = status;
        let response_id = response
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= MAX_RESPONSE_ID_BYTES);
        self.emit(
            "response_observed",
            json!({
                "responseIdHash": response_id.map(hash_id),
                "responseStatus": status,
                "providerModel": response.get("model").and_then(Value::as_str).and_then(safe_model_id),
                "providerReasoningEffort": observed_reasoning_effort(response, self.wire_api),
                "usage": observe_usage(response, self.wire_api),
            }),
        );
    }

    /// The buffered ChatGPT path still observes each terminal as bytes arrive:
    /// an eventual transport/parser failure cannot erase an earlier observation.
    /// This bounded side parser never changes the response delivered to callers.
    pub(crate) fn observe_sse_bytes(&mut self, bytes: &[u8]) {
        if self.truncated {
            return;
        }
        for &byte in bytes {
            self.sse_buffer.push(byte);
            if self.sse_buffer.len() > MAX_SSE_BUFFER_BYTES {
                self.sse_buffer.clear();
                self.truncated = true;
                return;
            }
            if self.sse_buffer.ends_with(b"\n\n") || self.sse_buffer.ends_with(b"\n\r\n") {
                self.flush_sse_event();
            }
        }
    }

    pub(crate) fn finish_sse(&mut self) {
        if !self.sse_buffer.is_empty() && !self.truncated {
            self.flush_sse_event();
        }
    }

    fn flush_sse_event(&mut self) {
        let bytes = std::mem::take(&mut self.sse_buffer);
        let Ok(text) = std::str::from_utf8(&bytes) else {
            self.truncated = true;
            return;
        };
        let mut kind = None;
        let mut data = Vec::new();
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                kind = Some(value.trim());
            }
            if let Some(value) = line.strip_prefix("data:") {
                data.push(value.trim_start());
            }
        }
        if data.is_empty() || data.join("\n").trim() == "[DONE]" {
            return;
        }
        let Ok(mut event) = serde_json::from_str::<Value>(&data.join("\n")) else {
            self.truncated = true;
            return;
        };
        if event.get("type").is_none()
            && let (Some(kind), Some(map)) = (kind, event.as_object_mut())
        {
            map.insert("type".into(), json!(kind));
        }
        self.observe_event(&event);
    }
}

impl Drop for UsageAttempt {
    fn drop(&mut self) {
        self.emit(
            "attempt_finished",
            json!({
                "httpStatus": self.http_status,
                "outcome": self.outcome,
                "terminalObservations": self.terminals,
                "truncated": self.truncated,
            }),
        );
    }
}

// Observe only the final wire payload's explicit control. Do not infer a
// default, copy an arbitrary value, or claim the provider's internal behavior.
fn observed_reasoning_effort(payload: &Value, wire_api: &str) -> Option<&'static str> {
    let value = match wire_api {
        "responses" => payload.pointer("/reasoning/effort"),
        "chat_completions" => payload.get("reasoning_effort"),
        _ => None,
    };
    match value.and_then(Value::as_str)? {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        "ultra" => Some("ultra"),
        _ => None,
    }
}

fn safe_model_id(model: &str) -> Option<String> {
    (!model.is_empty()
        && model.len() <= 128
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/".contains(&byte)))
    .then(|| model.to_string())
}

fn hash_id(id: &str) -> String {
    digest(&SHA256, id.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn counter(value: Option<&Value>) -> Value {
    match value {
        None => json!({"state": "missing"}),
        Some(Value::Null) => json!({"state": "null"}),
        Some(value) => match value.as_u64().filter(|value| *value <= MAX_SAFE_INTEGER) {
            Some(value) => json!({"state": "reported", "value": value}),
            None => json!({"state": "invalid"}),
        },
    }
}

fn observe_usage(response: &Value, wire_api: &str) -> Value {
    let (usage, paths) = match wire_api {
        "chat_completions" => (
            response.get("usage"),
            [
                "/prompt_tokens",
                "/prompt_tokens_details/cached_tokens",
                "/prompt_tokens_details/cache_write_tokens",
                "/completion_tokens",
                "/completion_tokens_details/reasoning_tokens",
                "/total_tokens",
            ],
        ),
        "gemini_code_assist" => (
            response
                .pointer("/response/usageMetadata")
                .or_else(|| response.get("usageMetadata")),
            [
                "/promptTokenCount",
                "/cachedContentTokenCount",
                "/cacheWriteTokenCount",
                "/candidatesTokenCount",
                "/thoughtsTokenCount",
                "/totalTokenCount",
            ],
        ),
        _ => (
            response.get("usage"),
            [
                "/input_tokens",
                "/input_tokens_details/cached_tokens",
                "/input_tokens_details/cache_write_tokens",
                "/output_tokens",
                "/output_tokens_details/reasoning_tokens",
                "/total_tokens",
            ],
        ),
    };
    let fields: serde_json::Map<String, Value> = [
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
    ]
    .into_iter()
    .zip(paths)
    .map(|(key, path)| {
        (
            key.to_string(),
            counter(usage.and_then(|usage| usage.pointer(path))),
        )
    })
    .collect();
    json!({
        "state": match usage { None => "missing", Some(Value::Null) => "null", Some(Value::Object(_)) => "object", Some(_) => "invalid" },
        "fields": fields,
        "details": match wire_api {
            "responses" => json!({
                "input": container_state(usage.and_then(|usage| usage.get("input_tokens_details"))),
                "output": container_state(usage.and_then(|usage| usage.get("output_tokens_details"))),
            }),
            "chat_completions" => json!({
                "input": container_state(usage.and_then(|usage| usage.get("prompt_tokens_details"))),
                "output": container_state(usage.and_then(|usage| usage.get("completion_tokens_details"))),
            }),
            _ => Value::Null,
        },
    })
}

fn container_state(value: Option<&Value>) -> &'static str {
    match value {
        None => "missing",
        Some(Value::Null) => "null",
        Some(Value::Object(_)) => "object",
        Some(_) => "invalid",
    }
}

#[cfg(test)]
pub(crate) fn recorder() -> (UsageDiagnostics, Arc<std::sync::Mutex<Vec<Value>>>) {
    let records = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = records.clone();
    (
        UsageDiagnostics::new(
            None,
            Arc::new(move |record| captured.lock().unwrap().push(record)),
        ),
        records,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> Value {
        json!({"id": "response-private-identity", "status": "completed", "output": "private output",
            "usage": {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 40},
            "output_tokens": 10, "output_tokens_details": {"reasoning_tokens": 5}, "total_tokens": 110}})
    }

    #[test]
    fn unavailable_log_sink_does_not_panic_on_start_or_drop() {
        struct Unavailable(Arc<AtomicU64>);
        impl std::io::Write for Unavailable {
            fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "unavailable",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let writes = Arc::new(AtomicU64::new(0));
        let captured = writes.clone();
        let diagnostics = UsageDiagnostics::new(
            None,
            Arc::new(move |record| {
                write_record(Unavailable(captured.clone()), &record);
            }),
        );
        drop(diagnostics.start("fixture-model", "responses", &json!({})));
        assert_eq!(writes.load(Ordering::Relaxed), 2);

        // The guard's finish record is also safe during an unrelated unwind.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _attempt = diagnostics.start("fixture-model", "responses", &json!({}));
            panic!("unrelated fixture failure");
        }));
        assert!(result.is_err());
        assert_eq!(writes.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn counters_preserve_presence_and_subsets_without_content() {
        let (diagnostics, records) = recorder();
        let mut attempt = diagnostics.start("fixture-model", "responses", &json!({}));
        attempt.observe_json(&response());
        drop(attempt);
        let records = records.lock().unwrap();
        let usage = &records[1]["usage"]["fields"];
        assert_eq!(
            usage["input_tokens"],
            json!({"state": "reported", "value": 100})
        );
        assert_eq!(
            usage["cached_input_tokens"],
            json!({"state": "reported", "value": 40})
        );
        assert_eq!(
            usage["cache_write_input_tokens"],
            json!({"state": "missing"})
        );
        assert_eq!(
            usage["total_tokens"],
            json!({"state": "reported", "value": 110})
        );
        assert_eq!(records[2]["outcome"], "completed");
        let text = serde_json::to_string(&*records).unwrap();
        assert!(!text.contains("private"));
        assert_eq!(records[1]["responseIdHash"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn gemini_preserves_candidate_and_thought_counters_separately() {
        let metadata = json!({
            "promptTokenCount": 100,
            "cachedContentTokenCount": 40,
            "candidatesTokenCount": 7,
            "thoughtsTokenCount": 20,
            "totalTokenCount": 127,
        });
        for response in [
            json!({"usageMetadata": metadata}),
            json!({"response": {"usageMetadata": metadata}}),
        ] {
            let usage = observe_usage(&response, "gemini_code_assist");
            for (field, value) in [
                ("input_tokens", 100),
                ("cached_input_tokens", 40),
                ("output_tokens", 7),
                ("reasoning_output_tokens", 20),
                ("total_tokens", 127),
            ] {
                assert_eq!(
                    usage["fields"][field],
                    json!({"state": "reported", "value": value}),
                );
            }
            assert_eq!(
                usage["fields"]["cache_write_input_tokens"],
                json!({"state": "missing"}),
            );
        }
    }

    #[test]
    fn outbound_controls_and_provider_metadata_remain_distinct() {
        for (wire_api, outbound, returned) in [
            (
                "responses",
                json!({"reasoning": {"effort": "low"}}),
                json!({"reasoning": {"effort": "high"}}),
            ),
            (
                "chat_completions",
                json!({"reasoning_effort": "low"}),
                json!({"reasoning_effort": "high"}),
            ),
        ] {
            let (diagnostics, records) = recorder();
            let mut attempt = diagnostics.start("outbound-model", wire_api, &outbound);
            let mut response = response();
            response["model"] = json!("provider-model-revision");
            response
                .as_object_mut()
                .unwrap()
                .extend(returned.as_object().unwrap().clone());
            attempt.observe_json(&response);
            drop(attempt);
            let records = records.lock().unwrap();
            for record in records.iter() {
                assert_eq!(record["model"], "outbound-model");
                assert_eq!(record["outboundReasoningEffort"], "low");
            }
            assert_eq!(records[1]["providerModel"], "provider-model-revision");
            assert_eq!(records[1]["providerReasoningEffort"], "high");
        }
    }

    #[test]
    fn missing_and_invalid_model_controls_remain_unknown_without_content() {
        for payload in [
            json!({}),
            json!({"model": null, "reasoning": {"effort": null}}),
            json!({"model": "private model content", "reasoning": {"effort": "private effort"}}),
            json!({"model": "x".repeat(129), "reasoning": {"effort": {"private": "content"}}}),
            json!({"model": 42, "reasoning": "private content"}),
        ] {
            let (diagnostics, records) = recorder();
            let mut attempt = diagnostics.start("outbound-model", "responses", &payload);
            attempt.observe_json(&payload);
            drop(attempt);
            let records = records.lock().unwrap();
            assert!(
                records
                    .iter()
                    .all(|record| record["outboundReasoningEffort"].is_null())
            );
            assert_eq!(records[1]["providerModel"], Value::Null);
            assert_eq!(records[1]["providerReasoningEffort"], Value::Null);
            let text = serde_json::to_string(&*records).unwrap();
            assert!(!text.contains("private"));
            assert!(!text.contains(&"x".repeat(129)));
        }
    }

    #[test]
    fn reasoning_observation_uses_only_the_selected_wire_api_and_known_values() {
        let payload = json!({"reasoning": {"effort": "low"}, "reasoning_effort": "max"});
        assert_eq!(
            observed_reasoning_effort(&payload, "responses"),
            Some("low")
        );
        assert_eq!(
            observed_reasoning_effort(&payload, "chat_completions"),
            Some("max")
        );
        assert_eq!(
            observed_reasoning_effort(&payload, "gemini_code_assist"),
            None
        );
        for value in [
            json!("HIGH"),
            json!(" high "),
            json!("private effort"),
            json!(12),
            Value::Null,
        ] {
            assert_eq!(
                observed_reasoning_effort(&json!({"reasoning_effort": value}), "chat_completions"),
                None
            );
        }
    }

    #[test]
    fn absent_null_invalid_and_explicit_zero_remain_distinct() {
        for (usage, state, input_state) in [
            (None, "missing", "missing"),
            (Some(Value::Null), "null", "missing"),
            (Some(json!("private invalid value")), "invalid", "missing"),
            (Some(json!({"input_tokens": null})), "object", "null"),
            (Some(json!({"input_tokens": -1})), "object", "invalid"),
            (
                Some(json!({"input_tokens": "private invalid value"})),
                "object",
                "invalid",
            ),
            (Some(json!({"input_tokens": 0})), "object", "reported"),
        ] {
            let mut response = json!({});
            if let Some(usage) = usage {
                response["usage"] = usage;
            }
            let observation = observe_usage(&response, "responses");
            assert_eq!(observation["state"], state);
            assert_eq!(observation["fields"]["input_tokens"]["state"], input_state);
            assert!(!observation.to_string().contains("private"));
        }
        let observation = observe_usage(
            &json!({"usage": {
                "input_tokens": MAX_SAFE_INTEGER + 1,
                "input_tokens_details": "private invalid details",
            }}),
            "responses",
        );
        assert_eq!(observation["fields"]["input_tokens"]["state"], "invalid");
        assert_eq!(observation["details"]["input"], "invalid");
    }

    #[test]
    fn retries_and_drops_keep_distinct_attempts_without_fabricating_zero() {
        let (diagnostics, records) = recorder();
        let mut first = diagnostics.start("fixture-model", "responses", &json!({}));
        first.http_status(401);
        first.failure("http_error");
        drop(first);
        drop(
            diagnostics
                .clone()
                .start("fixture-model", "responses", &json!({})),
        );
        let records = records.lock().unwrap();
        assert_eq!(records.len(), 4);
        assert_eq!(records[0]["requestId"], records[2]["requestId"]);
        assert_ne!(records[0]["attemptId"], records[2]["attemptId"]);
        assert_eq!(records[2]["attempt"], 2);
        assert_eq!(records[1]["outcome"], "http_error");
        assert_eq!(records[1]["terminalObservations"], 0);
        assert_eq!(records[3]["outcome"], "interrupted");
        assert!(records.iter().all(|record| record.get("usage").is_none()));
    }

    #[test]
    fn buffered_sse_observes_split_failed_terminals_and_retains_duplicate_provenance() {
        let (diagnostics, records) = recorder();
        let mut attempt = diagnostics.start("fixture-model", "responses", &json!({}));
        let event = json!({"response": response()});
        let stream = format!("event: response.failed\r\ndata: {event}\r\n\r\n");
        for chunk in stream.as_bytes().chunks(3) {
            attempt.observe_sse_bytes(chunk);
        }
        attempt.observe_sse_bytes(stream.as_bytes());
        drop(attempt);
        let records = records.lock().unwrap();
        assert_eq!(records.len(), 4);
        assert_eq!(records[1]["responseStatus"], "failed");
        assert_eq!(records[1]["responseIdHash"], records[2]["responseIdHash"]);
        assert_eq!(records[3]["terminalObservations"], 2);
        assert_eq!(records[3]["outcome"], "failed");
    }

    #[test]
    fn observation_caps_and_invalid_sse_are_explicit() {
        let (diagnostics, records) = recorder();
        let mut attempt = diagnostics.start("fixture-model", "responses", &json!({}));
        for _ in 0..MAX_TERMINAL_OBSERVATIONS + 1 {
            attempt.observe_json(&response());
        }
        drop(attempt);
        assert_eq!(records.lock().unwrap().last().unwrap()["truncated"], true);
        let (diagnostics, records) = recorder();
        let mut attempt = diagnostics.start("fixture-model", "responses", &json!({}));
        attempt.observe_sse_bytes(b"data: {\"private broken event\"\n\n");
        drop(attempt);
        let records = records.lock().unwrap();
        assert_eq!(records[1]["truncated"], true);
        assert!(
            !serde_json::to_string(&*records)
                .unwrap()
                .contains("private")
        );
    }

    #[test]
    fn only_uuid_claims_and_bounded_model_identifiers_are_retained() {
        let claims: ProxyClaims = serde_json::from_value(json!({
            "project_id": "private project", "run_id": Uuid::nil(), "job_id": "private job",
            "credential_id": "private credential", "lease_attempt": 3,
        }))
        .unwrap();
        let records = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = records.clone();
        let diagnostics = UsageDiagnostics::new(
            Some(&claims),
            Arc::new(move |record| captured.lock().unwrap().push(record)),
        );
        drop(diagnostics.start("private model content", "responses", &json!({})));
        let records = records.lock().unwrap();
        assert_eq!(records[0]["scope"]["runId"], Uuid::nil().to_string());
        assert_eq!(records[0]["scope"]["jobId"], Value::Null);
        assert_eq!(records[0]["scope"]["leaseAttempt"], 3);
        assert_eq!(records[0]["model"], Value::Null);
        assert!(
            !serde_json::to_string(&*records)
                .unwrap()
                .contains("private")
        );
    }
}
