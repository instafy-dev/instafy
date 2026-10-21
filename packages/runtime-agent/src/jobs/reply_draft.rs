//! Octo's reply while the model is still writing it.
//!
//! A chat turn's final answer is a JSON object whose `summary` becomes Octo's
//! message, and that message is persisted only when the job completes. This
//! module reads the `summary` string out of the answer as its text streams in,
//! so the Studio can show the reply growing instead of waiting for the end:
//!
//! - Only a run whose final answer is the conversation reply drafts at all (see
//!   `JobProcessor::run_apply_job`). Multi-agent plans and routing preflight
//!   answers have other schemas and never reach this reader.
//! - Text that is not a JSON object, values of other keys and nested `summary`
//!   keys are never drafted.
//! - A summary that could still become the `NO_RESPONSE` decline sentinel is
//!   held back until it can no longer be one.
//! - A draft is never persisted. The controller publishes it to the
//!   conversation's viewers, and the completed message replaces it.

use serde_json::Value as JsonValue;
use tokio::sync::watch;

/// The longest draft sent. A longer reply stops growing at this size until
/// the completed message replaces it.
const MAX_DRAFT_BYTES: usize = 32 * 1024;

/// The latest draft of the reply, as the dispatcher reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplyDraft {
    /// Changes whenever the text starts over (another answer item or another
    /// attempt), so a viewer replaces its text instead of extending it.
    pub segment: u64,
    pub text: String,
}

/// Where a job's drafts go. The dispatcher sends the latest value at its own
/// pace, so a burst of updates costs one request.
pub type ReplyDraftSender = watch::Sender<ReplyDraft>;

/// Feeds one Codex run's events to the job's reply draft.
pub(super) struct ReplyDraftStream {
    sender: ReplyDraftSender,
    item_id: Option<String>,
    /// Bytes of the current item's cumulative text already read.
    consumed: usize,
    reader: SummaryReader,
    /// Bytes of the visible summary already in the draft.
    published: usize,
}

impl ReplyDraftStream {
    /// Starts a draft segment of its own, so text from an earlier attempt is
    /// replaced rather than extended.
    pub(super) fn start(sender: ReplyDraftSender) -> Self {
        let mut stream = Self {
            sender,
            item_id: None,
            consumed: 0,
            reader: SummaryReader::default(),
            published: 0,
        };
        stream.restart();
        stream
    }

    pub(super) fn observe(&mut self, event: &JsonValue) {
        if event.get("type").and_then(JsonValue::as_str) != Some("item.updated") {
            return;
        }
        let Some(item) = event.get("item") else {
            return;
        };
        if item.get("type").and_then(JsonValue::as_str) != Some("agent_message") {
            return;
        }
        let (Some(id), Some(text)) = (
            item.get("id").and_then(JsonValue::as_str),
            item.get("text").and_then(JsonValue::as_str),
        ) else {
            return;
        };
        if self.sender.is_closed() {
            return;
        }
        // The adapter sends each item's text so far. Another item, or text that
        // no longer extends what was read, is a new answer.
        if self.item_id.as_deref() != Some(id)
            || text.len() < self.consumed
            || !text.is_char_boundary(self.consumed)
        {
            if self.item_id.is_some() {
                self.restart();
            }
            self.item_id = Some(id.to_string());
        }
        self.reader.feed(&text[self.consumed..]);
        self.consumed = text.len();
        self.publish();
    }

    fn restart(&mut self) {
        self.consumed = 0;
        self.reader = SummaryReader::default();
        self.published = 0;
        self.sender.send_modify(|draft| {
            draft.segment += 1;
            draft.text.clear();
        });
    }

    fn publish(&mut self) {
        let summary = self.reader.summary();
        let visible = summary.trim_start();
        if visible.len() <= self.published || could_become_decline(visible) {
            return;
        }
        let mut end = visible.len().min(MAX_DRAFT_BYTES);
        while !visible.is_char_boundary(end) {
            end -= 1;
        }
        if end <= self.published {
            return;
        }
        let added = &visible[self.published..end];
        self.sender.send_modify(|draft| draft.text.push_str(added));
        self.published = end;
    }
}

/// Whether a partial summary is, or could still grow into, the decline
/// sentinel in any form `participation_decline_sentinel` accepts: bare,
/// wrapped in backticks or in a fence with an optional language tag.
fn could_become_decline(partial: &str) -> bool {
    const SENTINEL: &str = "NO_RESPONSE";
    let text = partial.trim();
    if text.is_empty() || super::participation_decline_sentinel(text) {
        return true;
    }
    if SENTINEL.starts_with(text) {
        return true;
    }
    let Some(after_ticks) = text.strip_prefix('`') else {
        return false;
    };
    let after_ticks = after_ticks.trim_start_matches('`');
    let body = match after_ticks.split_once('\n') {
        // A fence: what precedes the newline is its language tag.
        Some((tag, body)) if is_fence_tag(tag.trim()) => body,
        Some(_) => return false,
        // Still on the first line, which may be a language tag or the sentinel.
        None if is_fence_tag(after_ticks.trim()) => return true,
        None => after_ticks,
    };
    let body = body.trim().trim_end_matches('`').trim_end();
    SENTINEL.starts_with(body) || body == SENTINEL
}

fn is_fence_tag(tag: &str) -> bool {
    tag.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

/// Reads the top-level `summary` string of a JSON object from its text as the
/// text arrives in pieces. Each piece is read once.
#[derive(Debug, Default)]
pub(super) struct SummaryReader {
    state: ReaderState,
    key: String,
    summary: String,
    escape: Escape,
    /// A `\u` high surrogate waiting for its low half.
    high_surrogate: Option<u16>,
    /// Open objects and arrays inside a value being skipped.
    skip_depth: usize,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ReaderState {
    #[default]
    BeforeObject,
    BeforeKey,
    Key,
    AfterKey,
    BeforeValue,
    Summary,
    SkipString,
    SkipNested,
    SkipNestedString,
    SkipScalar,
    AfterValue,
    /// The summary is complete, or the text is not an object with one.
    Done,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Escape {
    #[default]
    None,
    Started,
    /// Inside `\uXXXX`: the hex digits read so far and their value.
    Unicode(u8, u16),
}

impl SummaryReader {
    /// The summary decoded so far.
    pub(super) fn summary(&self) -> &str {
        &self.summary
    }

    pub(super) fn feed(&mut self, text: &str) {
        for ch in text.chars() {
            if self.state == ReaderState::Done {
                return;
            }
            self.step(ch);
        }
    }

    fn step(&mut self, ch: char) {
        use ReaderState::*;
        match self.state {
            BeforeObject => match ch {
                '{' => self.state = BeforeKey,
                ch if ch.is_whitespace() => {}
                _ => self.state = Done,
            },
            BeforeKey => match ch {
                '"' => {
                    self.key.clear();
                    self.state = Key;
                }
                ch if ch.is_whitespace() || ch == ',' => {}
                _ => self.state = Done,
            },
            Key => {
                if let Some(decoded) = self.read_string_char(ch) {
                    match decoded {
                        StringChar::End => self.state = AfterKey,
                        StringChar::Char(ch) => self.key.push(ch),
                        StringChar::Pending => {}
                    }
                }
            }
            AfterKey => match ch {
                ':' => self.state = BeforeValue,
                ch if ch.is_whitespace() => {}
                _ => self.state = Done,
            },
            BeforeValue => match ch {
                ch if ch.is_whitespace() => {}
                '"' if self.key == "summary" => self.state = Summary,
                // A `summary` that is not a string has nothing to draft.
                _ if self.key == "summary" => self.state = Done,
                '"' => self.state = SkipString,
                '{' | '[' => {
                    self.skip_depth = 1;
                    self.state = SkipNested;
                }
                _ => self.state = SkipScalar,
            },
            Summary => {
                if let Some(decoded) = self.read_string_char(ch) {
                    match decoded {
                        StringChar::End => self.state = Done,
                        StringChar::Char(ch) => self.summary.push(ch),
                        StringChar::Pending => {}
                    }
                }
            }
            SkipString => {
                if let Some(StringChar::End) = self.read_string_char(ch) {
                    self.state = AfterValue;
                }
            }
            SkipNested => match ch {
                '"' => self.state = SkipNestedString,
                '{' | '[' => self.skip_depth += 1,
                '}' | ']' => {
                    self.skip_depth -= 1;
                    if self.skip_depth == 0 {
                        self.state = AfterValue;
                    }
                }
                _ => {}
            },
            SkipNestedString => {
                if let Some(StringChar::End) = self.read_string_char(ch) {
                    self.state = SkipNested;
                }
            }
            SkipScalar => match ch {
                ',' => self.state = BeforeKey,
                '}' => self.state = Done,
                _ => {}
            },
            AfterValue => match ch {
                ',' => self.state = BeforeKey,
                ch if ch.is_whitespace() => {}
                _ => self.state = Done,
            },
            Done => {}
        }
    }

    /// One character of a JSON string's body. `None` while it is part of an
    /// escape that has not produced a character yet.
    fn read_string_char(&mut self, ch: char) -> Option<StringChar> {
        match self.escape {
            Escape::None => match ch {
                '\\' => {
                    self.escape = Escape::Started;
                    Some(StringChar::Pending)
                }
                '"' => Some(self.flush_surrogate_then(StringChar::End)),
                ch => Some(self.flush_surrogate_then(StringChar::Char(ch))),
            },
            Escape::Started => {
                self.escape = Escape::None;
                let decoded = match ch {
                    'u' => {
                        self.escape = Escape::Unicode(0, 0);
                        return Some(StringChar::Pending);
                    }
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    'b' => '\u{8}',
                    'f' => '\u{c}',
                    // `"`, `\`, `/` and anything unexpected stand for themselves.
                    ch => ch,
                };
                Some(self.flush_surrogate_then(StringChar::Char(decoded)))
            }
            Escape::Unicode(read, value) => {
                let Some(digit) = ch.to_digit(16) else {
                    self.escape = Escape::None;
                    return Some(
                        self.flush_surrogate_then(StringChar::Char(char::REPLACEMENT_CHARACTER)),
                    );
                };
                let value = (value << 4) | digit as u16;
                if read < 3 {
                    self.escape = Escape::Unicode(read + 1, value);
                    return Some(StringChar::Pending);
                }
                self.escape = Escape::None;
                Some(self.code_unit(value))
            }
        }
    }

    fn code_unit(&mut self, unit: u16) -> StringChar {
        match (self.high_surrogate.take(), unit) {
            (Some(high), 0xDC00..=0xDFFF) => {
                let code =
                    0x10000 + ((u32::from(high) - 0xD800) << 10) + (u32::from(unit) - 0xDC00);
                StringChar::Char(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER))
            }
            (high, 0xD800..=0xDBFF) => {
                if high.is_some() {
                    self.push_decoded(char::REPLACEMENT_CHARACTER);
                }
                self.high_surrogate = Some(unit);
                StringChar::Pending
            }
            (high, unit) => {
                if high.is_some() {
                    self.push_decoded(char::REPLACEMENT_CHARACTER);
                }
                StringChar::Char(
                    char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER),
                )
            }
        }
    }

    /// A high surrogate followed by anything but its low half is replaced.
    fn flush_surrogate_then(&mut self, next: StringChar) -> StringChar {
        if self.high_surrogate.take().is_some() {
            self.push_decoded(char::REPLACEMENT_CHARACTER);
        }
        next
    }

    fn push_decoded(&mut self, ch: char) {
        match self.state {
            ReaderState::Summary => self.summary.push(ch),
            ReaderState::Key => self.key.push(ch),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StringChar {
    Char(char),
    End,
    Pending,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_in_pieces(text: &str, piece: usize) -> String {
        let mut reader = SummaryReader::default();
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(piece) {
            reader.feed(&chunk.iter().collect::<String>());
        }
        reader.summary().to_string()
    }

    #[test]
    fn reads_the_summary_whatever_the_pieces() {
        let answer = json!({
            "summary": "Line one\nSaid \"hi\" \\ done — ok 😀 /",
            "code": null,
            "files": [],
        })
        .to_string();
        let escaped = r#"{"summary":"aé😀\/\tb","files":[]}"#;
        for piece in 1..8 {
            assert_eq!(
                read_in_pieces(&answer, piece),
                "Line one\nSaid \"hi\" \\ done — ok 😀 /"
            );
            assert_eq!(read_in_pieces(escaped, piece), "aé😀/\tb");
        }
    }

    #[test]
    fn a_partial_summary_grows_and_stops_at_its_closing_quote() {
        let mut reader = SummaryReader::default();
        reader.feed("{\n  \"summ");
        assert_eq!(reader.summary(), "");
        reader.feed("ary\": \"Hel");
        assert_eq!(reader.summary(), "Hel");
        reader.feed("lo \\");
        assert_eq!(reader.summary(), "Hello ");
        reader.feed("\"you\\u00");
        assert_eq!(reader.summary(), "Hello \"you");
        reader.feed("21\", \"summary\": \"again\"}");
        assert_eq!(reader.summary(), "Hello \"you!");
    }

    #[test]
    fn skips_other_keys_and_nested_summaries() {
        let answer = r#"{"files":[{"summary":"nested \"]}","path":"a"}],"actions":{"summary":"no"},"confidence":3,"summary":"top"}"#;
        for piece in 1..6 {
            assert_eq!(read_in_pieces(answer, piece), "top");
        }
    }

    #[test]
    fn drafts_nothing_from_text_that_is_not_an_object_with_a_string_summary() {
        for text in [
            "Plain prose that mentions {\"summary\": \"x\"}",
            "```json\n{\"summary\":\"fenced\"}```",
            r#"{"summary": null, "files": []}"#,
            r#"["summary", "x"]"#,
        ] {
            assert_eq!(read_in_pieces(text, 3), "", "{text}");
        }
    }

    #[test]
    fn holds_back_anything_that_could_still_be_the_decline_sentinel() {
        for partial in [
            "",
            " ",
            "N",
            "NO_",
            "NO_RESPONSE",
            " NO_RESPONSE \n",
            "`",
            "`NO_RE",
            "`NO_RESPONSE`",
            "```",
            "```text",
            "```text\n",
            "```text\nNO_RESP",
            "```\nNO_RESPONSE\n``",
            "```NO_RESPONSE```",
        ] {
            assert!(could_become_decline(partial), "{partial:?}");
        }
        for partial in [
            "No",
            "Nothing to add",
            "NO_RESPONSE!",
            "NO_RESPONSE because",
            "NOPE",
            "`code`",
            "```text\nprint()",
            "```text more\n",
            "Sure",
        ] {
            assert!(!could_become_decline(partial), "{partial:?}");
        }
    }

    fn update(id: &str, text: &str) -> JsonValue {
        json!({
            "type": "item.updated",
            "item": { "id": id, "type": "agent_message", "text": text, "status": "in_progress" },
        })
    }

    #[test]
    fn a_stream_drafts_the_growing_summary_and_restarts_on_another_item() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender);
        let first_segment = receiver.borrow().segment;

        stream.observe(&update("a", "{\"summary\":\" NO"));
        assert_eq!(receiver.borrow().text, "", "could still be a decline");
        stream.observe(&update("a", "{\"summary\":\" NOT now"));
        assert_eq!(receiver.borrow().text, "NOT now");
        // Reasoning, completed items and other events never draft.
        stream.observe(&json!({"type":"item.updated","item":{"id":"r","type":"reasoning","text":"{\"summary\":\"x\"}"}}));
        stream.observe(&json!({"type":"item.completed","item":{"id":"b","type":"agent_message","text":"{\"summary\":\"y\"}"}}));
        stream.observe(&update(
            "a",
            "{\"summary\":\" NOT now, later.\",\"files\":[]}",
        ));
        assert_eq!(
            *receiver.borrow(),
            ReplyDraft {
                segment: first_segment,
                text: "NOT now, later.".to_string(),
            }
        );

        stream.observe(&update("b", "{\"summary\":\"Second"));
        assert_eq!(
            *receiver.borrow(),
            ReplyDraft {
                segment: first_segment + 1,
                text: "Second".to_string(),
            }
        );

        // Another attempt starts a segment of its own.
        let sender = stream.sender.clone();
        let _retry = ReplyDraftStream::start(sender);
        assert_eq!(receiver.borrow().segment, first_segment + 2);
        assert_eq!(receiver.borrow().text, "");
    }

    #[test]
    fn a_declined_answer_never_reaches_the_draft() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender);
        let mut text = String::new();
        for piece in [
            "{\"summ",
            "ary\":\"",
            "NO",
            "_RES",
            "PONSE",
            "\",\"files\":[],",
            "\"actions\":[]}",
        ] {
            text.push_str(piece);
            stream.observe(&update("a", &text));
            assert_eq!(receiver.borrow().text, "");
        }
    }

    #[test]
    fn a_long_draft_stops_growing_at_the_cap() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender);
        let long = "é".repeat(MAX_DRAFT_BYTES);
        stream.observe(&update("a", &format!("{{\"summary\":\"{long}")));
        let draft = receiver.borrow().text.clone();
        assert!(draft.len() <= MAX_DRAFT_BYTES && draft.len() > MAX_DRAFT_BYTES - 4);
        assert!(long.starts_with(&draft));
    }
}
