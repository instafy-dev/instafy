//! A run that may only answer in words (`CodexRunOptions::answer_only`): the reply check
//! (`jobs::reply_check`).
//!
//! Its requests keep the turn's instructions and tools, so the provider serves the turn's thread
//! from its cache, and so the model can still call a tool. Codex runs a tool as soon as a
//! response names it, so a prompt line ("Use no tool for this.") cannot hold one back, and
//! throwing the answer away afterwards leaves what the tool did. This gate reads each response of
//! the run's thread whole before Codex sees any of it. A response that calls a tool reaches Codex
//! with nothing in it (no reasoning, no words, no call): nothing runs, and with no tool output to
//! send back, no second request follows. Every response also ends the turn (`end_turn`), so a
//! response the provider left open is not followed by another request either. The run is then
//! one request, whatever the model answers.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use codex_extension_api::{
    ModelRequestContributor, ModelRequestInput, ModelRequestKind, ModelResponseError,
    ModelResponseInterceptor, ModelResponseStream, ResponseEvent,
};
use codex_protocol::models::ResponseItem;
use futures_util::StreamExt;

/// The words-only rule of one run: the threads it holds, and whether a response it held back
/// called a tool. Clones share both.
#[derive(Clone, Debug, Default)]
pub struct AnswerOnly {
    state: Arc<State>,
}

#[derive(Debug, Default)]
struct State {
    threads: Mutex<HashSet<String>>,
    tried_a_tool: AtomicBool,
}

impl AnswerOnly {
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds every response of `thread_id` to words.
    pub(crate) fn arm(&self, thread_id: &str) {
        self.threads().insert(thread_id.to_string());
    }

    fn holds(&self, thread_id: &str) -> bool {
        self.threads().contains(thread_id)
    }

    /// Whether a response called a tool, which then never ran.
    pub fn tried_a_tool(&self) -> bool {
        self.state.tried_a_tool.load(Ordering::SeqCst)
    }

    fn threads(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        // The set holds no invariant a panicking holder could break.
        self.state
            .threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// One response as Codex gets it: unchanged but for its end, which ends the turn, or, when
    /// it calls a tool, with none of its output.
    fn words_only(
        &self,
        response: Vec<Result<ResponseEvent, ModelResponseError>>,
    ) -> Vec<Result<ResponseEvent, ModelResponseError>> {
        let calls_a_tool = response.iter().any(|event| match event {
            Ok(ResponseEvent::OutputItemAdded(item) | ResponseEvent::OutputItemDone(item)) => {
                calls_a_tool(item)
            }
            Ok(ResponseEvent::ToolCallInputDelta { .. }) => true,
            _ => false,
        });
        if calls_a_tool {
            self.state.tried_a_tool.store(true, Ordering::SeqCst);
        }
        response
            .into_iter()
            .filter_map(|event| match event {
                Ok(ResponseEvent::Completed {
                    response_id,
                    token_usage,
                    usage_metadata,
                    end_turn: _,
                }) => Some(Ok(ResponseEvent::Completed {
                    response_id,
                    token_usage,
                    usage_metadata,
                    end_turn: Some(true),
                })),
                Ok(event) if calls_a_tool && is_output(&event) => None,
                other => Some(other),
            })
            .collect()
    }
}

/// An item that asks for a tool: run here (a command, a function or MCP tool, a patch, a tool
/// search), or by the provider (a web search, an image).
fn calls_a_tool(item: &ResponseItem) -> bool {
    matches!(
        item,
        ResponseItem::LocalShellCall { .. }
            | ResponseItem::FunctionCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::CustomToolCall { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. }
    )
}

/// What a response says, as opposed to what describes it (its id, model, usage and end).
fn is_output(event: &ResponseEvent) -> bool {
    matches!(
        event,
        ResponseEvent::OutputItemAdded(_)
            | ResponseEvent::OutputItemDone(_)
            | ResponseEvent::OutputTextDelta(_)
            | ResponseEvent::ToolCallInputDelta { .. }
            | ResponseEvent::ReasoningSummaryDelta { .. }
            | ResponseEvent::ReasoningSummaryDone { .. }
            | ResponseEvent::ReasoningContentDelta { .. }
            | ResponseEvent::ReasoningSummaryPartAdded { .. }
    )
}

impl ModelRequestContributor for AnswerOnly {
    fn request(&self, input: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        (input.kind == ModelRequestKind::Generation && self.holds(input.thread_id))
            .then(|| Box::new(WordsOnly(self.clone())) as Box<dyn ModelResponseInterceptor>)
    }
}

struct WordsOnly(AnswerOnly);

impl ModelResponseInterceptor for WordsOnly {
    fn intercept(self: Box<Self>, mut stream: ModelResponseStream) -> ModelResponseStream {
        let gate = self.0;
        Box::pin(
            futures_util::stream::once(async move {
                // The whole response, to its end or its error, before any of it goes on.
                let mut response = Vec::new();
                while let Some(event) = stream.next().await {
                    let last = matches!(event, Err(_) | Ok(ResponseEvent::Completed { .. }));
                    response.push(event);
                    if last {
                        break;
                    }
                }
                futures_util::stream::iter(gate.words_only(response))
            })
            .flatten(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn item(value: serde_json::Value) -> ResponseItem {
        serde_json::from_value(value).expect("a response item")
    }

    fn reasoning() -> ResponseItem {
        item(json!({
            "type": "reasoning", "id": "rs_1", "encrypted_content": null,
            "summary": [{"type": "summary_text", "text": "Checking the reply"}],
        }))
    }

    fn message(text: &str) -> ResponseItem {
        item(json!({
            "type": "message", "id": "msg_1", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "output_text", "text": text}],
        }))
    }

    fn command() -> ResponseItem {
        item(json!({
            "type": "function_call", "id": "fc_1", "name": "exec_command", "call_id": "call_1",
            "arguments": r#"{"cmd":"printf done > check-wrote.txt"}"#,
        }))
    }

    fn completed(end_turn: Option<bool>) -> ResponseEvent {
        ResponseEvent::Completed {
            response_id: "resp_1".to_string(),
            token_usage: None,
            usage_metadata: None,
            end_turn,
        }
    }

    /// What Codex gets of a response, each event by its shape.
    async fn delivered(
        gate: &AnswerOnly,
        thread_id: &str,
        events: Vec<ResponseEvent>,
    ) -> Option<Vec<String>> {
        let mut metadata: Option<HashMap<String, String>> = None;
        let interceptor = gate.request(ModelRequestInput {
            kind: ModelRequestKind::Generation,
            thread_id,
            client_metadata: &mut metadata,
            model: "gpt-5.5",
        })?;
        assert!(metadata.is_none(), "the request itself is unchanged");
        let upstream: ModelResponseStream =
            Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)));
        let out = interceptor.intercept(upstream).collect::<Vec<_>>().await;
        Some(
            out.into_iter()
                .map(|event| match event.expect("no error") {
                    ResponseEvent::Created { .. } => "created".to_string(),
                    ResponseEvent::OutputItemAdded(item) => format!("added {}", shape(&item)),
                    ResponseEvent::OutputItemDone(item) => format!("done {}", shape(&item)),
                    ResponseEvent::OutputTextDelta(delta) => format!("delta {delta}"),
                    ResponseEvent::Completed { end_turn, .. } => format!("completed {end_turn:?}"),
                    other => format!("{other:?}"),
                })
                .collect(),
        )
    }

    fn shape(item: &ResponseItem) -> &'static str {
        match item {
            ResponseItem::Reasoning { .. } => "reasoning",
            ResponseItem::Message { .. } => "message",
            ResponseItem::FunctionCall { .. } => "function_call",
            _ => "other",
        }
    }

    // A reply check kept the turn's tools, and its prompt's "Use no tool for this." was all that
    // held them back: a check that called a command wrote a file in the space and asked the
    // provider again with the output, and only its words were thrown away afterwards.
    #[tokio::test]
    async fn a_response_that_calls_a_tool_reaches_codex_with_nothing_in_it() {
        let gate = AnswerOnly::new();
        gate.arm("thread-a");
        let out = delivered(
            &gate,
            "thread-a",
            vec![
                ResponseEvent::Created { response_id: None },
                ResponseEvent::OutputItemAdded(reasoning()),
                ResponseEvent::OutputItemDone(reasoning()),
                ResponseEvent::OutputItemAdded(command()),
                ResponseEvent::ToolCallInputDelta {
                    item_id: "fc_1".to_string(),
                    call_id: Some("call_1".to_string()),
                    delta: "{".to_string(),
                },
                ResponseEvent::OutputItemDone(command()),
                completed(Some(false)),
            ],
        )
        .await
        .expect("held");
        // No call, and no reasoning left without the call it led to; the turn ends here.
        assert_eq!(out, ["created", "completed Some(true)"]);
        assert!(gate.tried_a_tool());
    }

    #[tokio::test]
    async fn an_answer_in_words_reaches_codex_whole_and_ends_the_turn() {
        let gate = AnswerOnly::new();
        gate.arm("thread-a");
        let out = delivered(
            &gate,
            "thread-a",
            vec![
                ResponseEvent::Created { response_id: None },
                ResponseEvent::OutputItemAdded(reasoning()),
                ResponseEvent::OutputItemDone(reasoning()),
                ResponseEvent::OutputItemAdded(message("")),
                ResponseEvent::OutputTextDelta("Not checked.".to_string()),
                ResponseEvent::OutputItemDone(message("Not checked.")),
                // An open-ended response would make Codex ask again.
                completed(Some(false)),
            ],
        )
        .await
        .expect("held");
        assert_eq!(
            out,
            [
                "created",
                "added reasoning",
                "done reasoning",
                "added message",
                "delta Not checked.",
                "done message",
                "completed Some(true)",
            ]
        );
        assert!(!gate.tried_a_tool());
    }

    #[tokio::test]
    async fn only_the_held_threads_generation_requests_are_read() {
        let gate = AnswerOnly::new();
        gate.arm("thread-a");
        // Another thread of the run, such as a helper's, is not held.
        assert!(
            delivered(&gate, "thread-b", vec![completed(None)])
                .await
                .is_none()
        );
        let mut metadata = None;
        assert!(
            gate.request(ModelRequestInput {
                kind: ModelRequestKind::Warmup,
                thread_id: "thread-a",
                client_metadata: &mut metadata,
                model: "gpt-5.5",
            })
            .is_none()
        );
    }
}
