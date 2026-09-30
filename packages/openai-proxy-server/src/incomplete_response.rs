//! A Responses response the upstream stopped early: `status: "incomplete"`, for example at
//! `max_output_tokens` or by a content filter. The upstream has produced and billed it by then.
//! Codex answers the upstream's `response.incomplete` by sending the same request again, which the
//! upstream bills again and most likely stops the same way, and it runs whatever tool call the
//! stopped response carried, truncated arguments included. The proxy buffers the whole upstream
//! response before it answers, so it decides what a cut-short response becomes instead:
//!
//! - Only the output items the upstream finished remain: those with status `completed` or with no
//!   status. An item it finalized with status `incomplete`, such as a cut-off answer or a tool call
//!   with truncated arguments, and one it never finished, are dropped.
//! - When a finished tool call that codex runs remains, the response is delivered as completed
//!   with the remaining items. Codex runs the call and continues on its own follow-up request,
//!   which hands the model the call's output.
//! - Otherwise it is delivered as failed, with code `invalid_prompt` and the message codex gives
//!   the upstream's `response.incomplete`. Codex treats `invalid_prompt` as terminal, so the turn
//!   ends with that message instead of sending the request again.
//!
//! Either way the delivered response keeps the upstream's `usage`. This applies on every lane,
//! since a re-send is billed to whoever owns the key.

use serde_json::{Value, json};

/// The `error.code` of a cut-short response the proxy delivers as failed. Codex ends the turn on
/// it rather than retrying (`codex-api` `sse/responses.rs`, the `response.failed` branch).
pub(crate) const INCOMPLETE_RESPONSE_ERROR_CODE: &str = "invalid_prompt";

/// How the proxy delivers an upstream Responses response to a streaming client.
#[derive(Debug, PartialEq)]
pub(crate) enum Delivery {
    /// As `response.completed`: every response the upstream completed, unchanged, and a cut-short
    /// one reduced to its finished items, which still hold a tool call codex runs.
    Completed(Value),
    /// As `response.failed`: a cut-short response with no finished tool call codex runs. It
    /// carries the `error`, and no output.
    Failed(Value),
}

/// Decides how `response`, as the upstream returned it, reaches a streaming client. Only a
/// response whose `status` is `incomplete` changes; see the module documentation.
pub(crate) fn delivery(mut response: Value) -> Delivery {
    if response.get("status").and_then(Value::as_str) != Some("incomplete") {
        return Delivery::Completed(response);
    }
    let reason = incomplete_reason(&response);
    let Some(map) = response.as_object_mut() else {
        return Delivery::Completed(response);
    };
    let output = match map.remove("output") {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    let upstream_items = output.len();
    let finished: Vec<Value> = output.into_iter().filter(is_finished).collect();
    let continues = finished.iter().any(is_tool_call_codex_runs);
    eprintln!(
        "[proxy] upstream response incomplete {}",
        json!({
            "responseId": map.get("id"),
            "reason": reason,
            "delivered": if continues { "completed" } else { "failed" },
            "upstreamItems": upstream_items,
            "finishedItems": finished.len(),
        })
    );
    map.remove("incomplete_details");
    if continues {
        map.insert("status".into(), json!("completed"));
        map.insert("output".into(), Value::Array(finished));
        return Delivery::Completed(response);
    }
    map.insert("status".into(), json!("failed"));
    map.insert("output".into(), json!([]));
    map.insert(
        "error".into(),
        json!({
            "code": INCOMPLETE_RESPONSE_ERROR_CODE,
            "message": incomplete_response_message(&reason),
        }),
    );
    Delivery::Failed(response)
}

/// Codex's own message for an upstream `response.incomplete`, which the Studio and the runtime
/// recognise.
fn incomplete_response_message(reason: &str) -> String {
    format!("Incomplete response returned, reason: {reason}")
}

/// Why the upstream stopped: `incomplete_details.reason`, or `unknown` without one, as codex
/// reads it.
fn incomplete_reason(response: &Value) -> String {
    response
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Whether the upstream finished `item`: its status is `completed`, or it has none.
fn is_finished(item: &Value) -> bool {
    match item.get("status") {
        None | Some(Value::Null) => true,
        Some(status) => status.as_str() == Some("completed"),
    }
}

/// Whether codex runs `item` as a tool call and records an output for it, which gives its next
/// request new model input: a function or custom tool call, or a tool search with a `call_id`
/// that the client executes. These are the items `is_tool_call_core_runs` in codex's
/// `codex-api/src/sse/responses.rs` (the fork's codex#4) lists, the ones
/// `ToolRouter::build_tool_call` turns into a call. A reasoning item or a message is only the
/// model's own output, and a re-send after it would most likely stop the same way; a local shell
/// call and a tool search the server ran are not calls codex runs.
fn is_tool_call_codex_runs(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str) {
        Some("function_call" | "custom_tool_call") => true,
        Some("tool_search_call") => {
            item.get("call_id").is_some_and(Value::is_string)
                && item.get("execution").and_then(Value::as_str) == Some("client")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage() -> Value {
        json!({"input_tokens": 40, "output_tokens": 128, "total_tokens": 168,
            "input_tokens_details": {"cached_tokens": 8},
            "output_tokens_details": {"reasoning_tokens": 100}})
    }

    fn incomplete(reason: Option<&str>, output: Vec<Value>) -> Value {
        let mut response = json!({
            "id": "resp-cut", "object": "response", "model": "gpt-6-luna",
            "status": "incomplete", "output": output, "usage": usage(),
        });
        if let Some(reason) = reason {
            response["incomplete_details"] = json!({ "reason": reason });
        }
        response
    }

    fn reasoning() -> Value {
        json!({"type": "reasoning", "id": "rs-1", "summary": [],
            "encrypted_content": "b3BhcXVl"})
    }

    fn message(status: &str) -> Value {
        json!({"type": "message", "id": "msg-1", "role": "assistant", "status": status,
            "content": [{"type": "output_text", "text": "A partial answer"}]})
    }

    fn function_call(call_id: &str, status: &str) -> Value {
        json!({"type": "function_call", "id": format!("fc-{call_id}"), "call_id": call_id,
            "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}", "status": status})
    }

    fn failed(reason: &str) -> Value {
        json!({
            "id": "resp-cut", "object": "response", "model": "gpt-6-luna",
            "status": "failed", "output": [], "usage": usage(),
            "error": {
                "code": "invalid_prompt",
                "message": format!("Incomplete response returned, reason: {reason}"),
            },
        })
    }

    #[test]
    fn a_response_that_is_not_incomplete_is_delivered_unchanged() {
        for response in [
            json!({"id": "resp-1", "status": "completed",
                "output": [message("incomplete"), function_call("call-1", "in_progress")]}),
            // The SSE builder gives a response without a status `completed`, as before.
            json!({"id": "resp-1", "output": [message("completed")]}),
            json!({"id": "resp-1", "status": "failed", "output": []}),
            json!("not an object"),
        ] {
            assert_eq!(
                delivery(response.clone()),
                Delivery::Completed(response.clone())
            );
        }
    }

    #[test]
    fn a_cut_short_answer_fails_with_its_reason_and_keeps_the_usage() {
        for (reason, expected) in [
            (Some("max_output_tokens"), "max_output_tokens"),
            (Some("content_filter"), "content_filter"),
            (Some("interrupted"), "interrupted"),
            (None, "unknown"),
        ] {
            let response = incomplete(reason, vec![reasoning(), message("incomplete")]);
            assert_eq!(delivery(response), Delivery::Failed(failed(expected)));
        }
        // A reason that is not a string, or details without one, reads as unknown.
        for details in [json!({"reason": 7}), json!({}), json!(null)] {
            let mut response = incomplete(None, vec![reasoning()]);
            response["incomplete_details"] = details;
            assert_eq!(delivery(response), Delivery::Failed(failed("unknown")));
        }
        // No output at all is the same.
        let mut response = incomplete(Some("max_output_tokens"), Vec::new());
        response.as_object_mut().unwrap().remove("output");
        assert_eq!(
            delivery(response),
            Delivery::Failed(failed("max_output_tokens"))
        );
    }

    #[test]
    fn a_finished_tool_call_completes_the_response_with_only_the_finished_items() {
        let response = incomplete(
            Some("max_output_tokens"),
            vec![
                reasoning(),
                function_call("call-finished", "completed"),
                function_call("call-cut-off", "incomplete"),
                message("in_progress"),
            ],
        );
        assert_eq!(
            delivery(response),
            Delivery::Completed(json!({
                "id": "resp-cut", "object": "response", "model": "gpt-6-luna",
                "status": "completed", "usage": usage(),
                "output": [reasoning(), function_call("call-finished", "completed")],
            }))
        );
    }

    #[test]
    fn only_items_with_status_completed_or_none_are_finished() {
        let call = |status: Value| {
            let mut call = function_call("call-1", "completed");
            call["status"] = status;
            call
        };
        for status in [json!("completed"), Value::Null] {
            let response = incomplete(Some("max_output_tokens"), vec![call(status.clone())]);
            assert!(
                matches!(delivery(response), Delivery::Completed(_)),
                "{status}"
            );
        }
        let mut no_status = call(Value::Null);
        no_status.as_object_mut().unwrap().remove("status");
        let response = incomplete(Some("max_output_tokens"), vec![no_status]);
        assert!(matches!(delivery(response), Delivery::Completed(_)));
        for status in [
            json!("incomplete"),
            json!("in_progress"),
            json!("searching"),
            json!("failed"),
            json!(""),
            json!(1),
        ] {
            let response = incomplete(Some("max_output_tokens"), vec![call(status.clone())]);
            assert_eq!(
                delivery(response),
                Delivery::Failed(failed("max_output_tokens")),
                "{status}"
            );
        }
    }

    #[test]
    fn only_a_tool_call_codex_runs_lets_the_response_continue() {
        let custom = json!({"type": "custom_tool_call", "id": "ctc-1", "call_id": "call-1",
            "name": "exec", "input": "text('ok')", "status": "completed"});
        let client_search = json!({"type": "tool_search_call", "id": "tsc-1",
            "call_id": "search-1", "execution": "client", "status": "completed",
            "arguments": {"query": "browser"}});
        for item in [
            function_call("call-1", "completed"),
            custom,
            client_search.clone(),
        ] {
            let response = incomplete(Some("max_output_tokens"), vec![item.clone()]);
            assert!(
                matches!(delivery(response), Delivery::Completed(_)),
                "{item}"
            );
        }
        let mut server_search = client_search.clone();
        server_search["execution"] = json!("server");
        let mut search_without_call_id = client_search.clone();
        search_without_call_id["call_id"] = Value::Null;
        let mut search_without_execution = client_search;
        search_without_execution
            .as_object_mut()
            .unwrap()
            .remove("execution");
        for item in [
            reasoning(),
            message("completed"),
            server_search,
            search_without_call_id,
            search_without_execution,
            json!({"type": "local_shell_call", "id": "lsc-1", "call_id": "call-1",
                "status": "completed", "action": {"type": "exec", "command": ["pwd"]}}),
            json!({"type": "web_search_call", "id": "ws-1", "status": "completed"}),
            json!({"id": "untyped-1", "status": "completed"}),
        ] {
            let response = incomplete(Some("content_filter"), vec![item.clone()]);
            assert_eq!(
                delivery(response),
                Delivery::Failed(failed("content_filter")),
                "{item}"
            );
        }
    }
}
