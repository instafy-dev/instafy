//! A streaming Responses request's upstream events, sent on to the client as they arrive.
//!
//! The proxy used to read a whole upstream response before it answered, so a client saw no
//! text until the model had finished writing. For an upstream that streams (see
//! `CodexClient::upstream_streams`), each event now goes on as it comes, in the upstream's
//! order, with two exceptions that keep what the client finally gets as before:
//!
//! - Each `response.output_item.done` waits for the next event. Only the last item can be one
//!   the stop cut off, so a response that ends with `response.incomplete` gets what
//!   `incomplete_response` keeps of it instead: the cut-off answer with the text that arrived
//!   and the notice, or nothing, and never a truncated tool call. An answer that already went
//!   on before the stop cannot take the notice any more, so the notice then follows as a
//!   message of its own.
//! - A ChatGPT login's client gets the items a buffered response kept, and nothing about the
//!   others: no reasoning and none of the backend's own tool items. Text that streams with no
//!   answer announced around it goes on inside one the proxy announces and finishes, as a
//!   buffered response put such text in an answer of its own.
//! - A failure the upstream reports before any output is still the request's error
//!   (`CodexClient::respond_with_input` reads ahead to the first output). Once output went on,
//!   a `response.failed` goes on as it is, and a stream that breaks off ends without `[DONE]`,
//!   so the client sees it was cut and retries as for any broken stream.
//!
//! Nothing here touches usage: the upstream's terminal event carries it, as before.

use std::collections::{HashSet, VecDeque};
use std::convert::Infallible;

use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::stream;
use serde_json::{Value, json};

use crate::client::{
    StreamedOutput, UpstreamEventStream, assistant_text_response_item,
    chatgpt_message_event_to_response_item, chatgpt_relays_item, response_items_match,
    stream_event_type, terminal_response,
};
use crate::incomplete_response;

/// Answers with `upstream`'s events as server-sent events, followed by `[DONE]` once the
/// upstream ended the response.
pub(crate) fn pass_through(upstream: UpstreamEventStream, run_id: Option<String>) -> Response {
    let relay = Relay::new(upstream, run_id);
    let events = stream::unfold(relay, |mut relay| async move {
        relay
            .next_event()
            .await
            .map(|event| (Ok::<Event, Infallible>(event), relay))
    });
    Sse::new(events).into_response()
}

struct Relay {
    upstream: UpstreamEventStream,
    run_id: Option<String>,
    /// Events ready to go to the client.
    out: VecDeque<Value>,
    /// The latest `response.output_item.done`, until the next event shows its item is not the
    /// cut-off last one.
    held_done: Option<Value>,
    /// The items whose `response.output_item.done` went to the client.
    sent_items: Vec<Value>,
    /// What the stream produced, to rebuild a cut-short response from.
    output: StreamedOutput,
    /// The upstream ended the response: only `out`, then `[DONE]`, remain.
    ended: bool,
    sent_done: bool,
    /// The ids and output indexes of items a ChatGPT login's client does not get.
    dropped_ids: HashSet<String>,
    dropped_indexes: HashSet<u64>,
    /// Whether the client has an announced answer that is not finished yet, which text goes to.
    answer_open: bool,
    /// The answer the proxy announced for text that streamed without one, and that text.
    unannounced_answer: Option<(String, String)>,
}

impl Relay {
    fn new(upstream: UpstreamEventStream, run_id: Option<String>) -> Self {
        Self {
            upstream,
            run_id,
            out: VecDeque::new(),
            held_done: None,
            sent_items: Vec::new(),
            output: StreamedOutput::default(),
            ended: false,
            sent_done: false,
            dropped_ids: HashSet::new(),
            dropped_indexes: HashSet::new(),
            answer_open: false,
            unannounced_answer: None,
        }
    }

    async fn next_event(&mut self) -> Option<Event> {
        loop {
            if let Some(event) = self.out.pop_front() {
                if std::env::var("PROXY_DEBUG_STREAM").as_deref() == Ok("1") {
                    eprintln!(
                        "[proxy] stream event: {}",
                        serde_json::to_string(&event).unwrap_or_else(|_| "<invalid>".into())
                    );
                }
                match Event::default().json_data(&event) {
                    Ok(event) => return Some(event),
                    Err(_) => continue,
                }
            }
            if self.ended {
                if self.sent_done {
                    return None;
                }
                self.sent_done = true;
                return Some(Event::default().data("[DONE]"));
            }
            match self.upstream.next_event().await {
                Ok(Some(event)) => self.accept(event),
                Ok(None) => {
                    self.log_broken_off("the upstream stream ended before the response did");
                    return None;
                }
                Err(error) => {
                    self.log_broken_off(&format!("{error:#}"));
                    return None;
                }
            }
        }
    }

    fn accept(&mut self, event: Value) {
        let kind = stream_event_type(&event).to_string();
        if self.upstream.chatgpt && self.drops(&kind, &event) {
            return;
        }
        match kind.as_str() {
            "response.output_item.added" => {
                self.output.observe(&kind, &event);
                self.release_held();
                self.finish_unannounced_answer();
                self.answer_open = event
                    .pointer("/item/type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind == "message");
                self.out.push_back(event);
            }
            "response.output_item.done" => {
                self.release_held();
                self.finish_unannounced_answer();
                self.output.observe(&kind, &event);
                self.answer_open = false;
                self.held_done = Some(event);
            }
            "response.output_text.delta" => {
                self.output.observe(&kind, &event);
                self.release_held();
                if !self.answer_open {
                    self.announce_answer();
                }
                if let (Some((_, text)), Some(delta)) = (
                    self.unannounced_answer.as_mut(),
                    event.get("delta").and_then(Value::as_str),
                ) {
                    text.push_str(delta);
                }
                self.out.push_back(event);
            }
            // An older shape of an assistant message, sent whole: a client reads it as a
            // finished item.
            "message" => {
                self.release_held();
                self.finish_unannounced_answer();
                self.output.observe(&kind, &event);
                if let Some(item) = chatgpt_message_event_to_response_item(&event) {
                    self.held_done =
                        Some(json!({"type": "response.output_item.done", "item": item}));
                }
            }
            "response.completed" => {
                self.release_held();
                self.finish_unannounced_answer();
                self.out.push_back(event);
                self.ended = true;
            }
            "response.incomplete" => {
                self.finish_cut_short(event);
                self.ended = true;
            }
            "response.failed" | "response.error" => {
                eprintln!(
                    "[proxy] upstream stream failed after output {}",
                    json!({ "runId": self.run_id, "type": kind })
                );
                self.out.push_back(event);
                self.ended = true;
            }
            _ => {
                self.output.observe(&kind, &event);
                self.release_held();
                self.out.push_back(event);
            }
        }
    }

    /// Whether a ChatGPT login's client goes without `event`: an item of a kind it does not
    /// get ([`chatgpt_relays_item`]), or an event about one.
    fn drops(&mut self, kind: &str, event: &Value) -> bool {
        if matches!(
            kind,
            "response.output_item.added" | "response.output_item.done"
        ) {
            let Some(item) = event.get("item") else {
                return false;
            };
            if chatgpt_relays_item(item) {
                return false;
            }
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                self.dropped_ids.insert(id.to_string());
            }
            if let Some(index) = event.get("output_index").and_then(Value::as_u64) {
                self.dropped_indexes.insert(index);
            }
            return true;
        }
        event
            .get("item_id")
            .and_then(Value::as_str)
            .is_some_and(|id| self.dropped_ids.contains(id))
            || event
                .get("output_index")
                .and_then(Value::as_u64)
                .is_some_and(|index| self.dropped_indexes.contains(&index))
    }

    /// Announces an answer for text that streams with none around it.
    fn announce_answer(&mut self) {
        let item = assistant_text_response_item("");
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut announced = item;
        announced["content"] = json!([]);
        announced["status"] = json!("in_progress");
        self.out
            .push_back(json!({"type": "response.output_item.added", "item": announced}));
        self.unannounced_answer = Some((id, String::new()));
        self.answer_open = true;
    }

    /// Finishes the answer the proxy announced, with the text that streamed into it.
    fn finish_unannounced_answer(&mut self) {
        let Some((id, text)) = self.unannounced_answer.take() else {
            return;
        };
        if !self.answer_open || text.trim().is_empty() {
            return;
        }
        let mut item = assistant_text_response_item(text.trim_end_matches('\n'));
        item["id"] = json!(id);
        self.out
            .push_back(json!({"type": "response.output_item.done", "item": item}));
        self.answer_open = false;
    }

    fn release_held(&mut self) {
        if let Some(done) = self.held_done.take() {
            if let Some(item) = done.get("item") {
                self.sent_items.push(item.clone());
            }
            self.out.push_back(done);
        }
    }

    /// Ends a response the upstream stopped early as `incomplete_response` delivers it: the
    /// kept items the client has not finished yet, then `response.completed` with the delivered
    /// response and the upstream's usage.
    fn finish_cut_short(&mut self, event: Value) {
        let Some(response) = terminal_response(&event) else {
            self.release_held();
            self.out.push_back(event);
            return;
        };
        // The held item is the last one: what it becomes is the delivered response's to say.
        self.held_done = None;
        let output = std::mem::take(&mut self.output);
        let mut delivered =
            incomplete_response::delivered_response(output.incomplete_response(response.clone()));
        // The items the client ends up with, as it got them.
        let mut finished = Vec::new();
        let mut notice_owed = false;
        for item in delivered
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match self
                .sent_items
                .iter()
                .find(|sent| response_items_match(sent, item))
            {
                // The notice joined an answer the client already finished.
                Some(sent) => {
                    notice_owed |= sent != item;
                    finished.push(sent.clone());
                }
                None => {
                    self.out
                        .push_back(json!({"type": "response.output_item.done", "item": item}));
                    finished.push(item.clone());
                }
            }
        }
        if notice_owed {
            let notice = incomplete_response::separate_notice(&response);
            self.out
                .push_back(json!({"type": "response.output_item.done", "item": notice}));
            finished.push(notice);
        }
        delivered["output"] = Value::Array(finished);
        self.out
            .push_back(json!({"type": "response.completed", "response": delivered}));
    }

    fn log_broken_off(&self, reason: &str) {
        eprintln!(
            "[proxy] upstream stream broke off after output {}",
            json!({ "runId": self.run_id, "reason": reason })
        );
    }
}
