//! The assistant's reply while the model is still writing it.
//!
//! A structured chat turn's final answer is a JSON object whose `summary` becomes its
//! message, and that message is persisted only when the job completes. This
//! module reads the `summary` string out of the answer as its text streams in,
//! so the Studio can show the reply growing instead of waiting for the end:
//!
//! - Only a run whose final answer is the conversation reply drafts at all (see
//!   `JobProcessor::run_apply_job`). Multi-agent plans and routing preflight
//!   answers have other schemas and never reach this reader.
//! - Structured output reveals only its top-level summary. Report/write turns may
//!   also draft natural prose explicitly marked final_answer by the provider.
//! - Commentary, planning contracts and internal worker messages never draft. A
//!   local-engine turn learns that a text was commentary only once a tool call
//!   follows it in the same message, so it drafts the text and then clears the
//!   draft with a `draft.reset` event (`claude_code::events`).
//! - A summary that could still become the `NO_RESPONSE` decline sentinel is
//!   held back until it can no longer be one.
//! - An answer asked for again (the runtime runs the turn once more, Codex sends
//!   its request again, or the attempt failed) stays in the draft until the new
//!   answer's first words take its place: it is replaced where it is, not taken
//!   away first. Only an answer the runtime found untrue goes as its retry
//!   begins ([`ReplyDraftStream::withdraw_shown`]).
//! - A draft is never persisted. The controller publishes it to the
//!   conversation's viewers, and the completed message replaces it.

use serde_json::Value as JsonValue;
use tokio::sync::watch;

use crate::claude_code::events::DRAFT_RESET_EVENT;

/// The longest draft sent. A longer reply stops growing at this size until
/// the completed message replaces it.
const MAX_DRAFT_BYTES: usize = 128 * 1024;

/// The latest draft of the reply, as the dispatcher reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplyDraft {
    /// Changes whenever the text starts over (another answer item or another
    /// attempt), with the new text's first words, so a viewer replaces its text
    /// instead of extending it.
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
    allow_plain_text: bool,
    /// A browser turn's: its reply ends with finding lines, which the draft never shows.
    ends_at_finding_lines: bool,
    previous: String,
    /// The draft still shows what it showed before this text started over: an earlier
    /// attempt's answer, or the one a request sent again had begun. It stays until this text's
    /// first words take its place, in a segment of their own ([`Self::publish`]).
    replaces_shown: bool,
}

impl ReplyDraftStream {
    /// Starts this run's draft: its first words replace, in a segment of their own, whatever an
    /// earlier attempt's draft shows, which stays until they come. Cleared as the runtime's retry
    /// began, a streamed answer ("I can't change … here because it was created in another
    /// chat…") vanished for 2.6 s, "Thinking…" came back, and it returned rewritten (a local
    /// test, Nov 20).
    pub(super) fn start(
        sender: ReplyDraftSender,
        allow_plain_text: bool,
        ends_at_finding_lines: bool,
    ) -> Self {
        Self {
            sender,
            item_id: None,
            consumed: 0,
            reader: SummaryReader::default(),
            published: 0,
            allow_plain_text,
            ends_at_finding_lines,
            previous: String::new(),
            replaces_shown: true,
        }
    }

    /// Takes away now what the draft shows of an earlier attempt, before this run's first words:
    /// for the retry of an answer the runtime found untrue, which would otherwise stand until the
    /// retry's words replaced it. A refused card's "I've opened a browser check of the official
    /// results." stood there with no card behind it for as long as the retry ran, and to its end
    /// when the retry wrote no words of its own.
    pub(super) fn withdraw_shown(&mut self) {
        self.start_over(true);
    }

    pub(super) fn observe(&mut self, event: &JsonValue) {
        match event.get("type").and_then(JsonValue::as_str) {
            // The request goes again: Codex sends it again by itself, or the attempt failed and
            // the runtime may run it once more. What the draft shows stays until the next words.
            Some("stream.retry" | "turn.failed") => {
                self.start_over(false);
                self.item_id = None;
                return;
            }
            // In a local-engine turn, a text the draft showed turned out to be commentary: a
            // text block a tool call followed in the same message (`claude_code::events`). It
            // was never the answer, so what this run showed goes now. Codex never sends this
            // reset.
            Some(DRAFT_RESET_EVENT) => {
                self.start_over(!self.replaces_shown);
                self.item_id = None;
                return;
            }
            Some("item.updated") => {}
            _ => return,
        }
        let Some(item) = event.get("item") else {
            return;
        };
        if item.get("type").and_then(JsonValue::as_str) != Some("agent_message") {
            return;
        }
        // Commentary and internal planning never become a reply. Phase-less structured
        // output remains readable, but prose requires an explicit final-answer phase.
        let phase = item.get("phase").and_then(JsonValue::as_str);
        if matches!(phase, Some("commentary" | "analysis")) {
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
        // no longer extends what was read, is a new answer. What this run showed
        // of the one before goes now; an earlier attempt's answer still waits for
        // the new one's words.
        if self.item_id.as_deref() != Some(id)
            || text.len() < self.consumed
            || !text.is_char_boundary(self.consumed)
            || !text.starts_with(&self.previous)
        {
            if self.item_id.is_some() {
                self.start_over(!self.replaces_shown);
            }
            self.item_id = Some(id.to_string());
        }
        self.reader.feed(&text[self.consumed..]);
        self.consumed = text.len();
        // Keep only a bounded prefix for detecting replacements; the adapter owns
        // the complete cumulative text, including content after the display bound.
        let mut prefix_end = text.len().min(MAX_DRAFT_BYTES);
        while !text.is_char_boundary(prefix_end) {
            prefix_end -= 1;
        }
        self.previous = text[..prefix_end].to_owned();
        let visible = if text.trim_start().starts_with('{') {
            self.reader.summary().to_owned()
        } else if self.allow_plain_text
            && phase == Some("final_answer")
            && !text.trim_start().starts_with('[')
            && !text.trim_start().starts_with("```")
            && !text.trim_start().chars().all(|ch| ch == '`')
        {
            text.to_owned()
        } else {
            String::new()
        };
        self.publish(&visible);
    }

    /// Starts the text over: reading begins again, and the next words replace what the draft
    /// shows. With `at_once`, what it shows goes now, in a segment of its own.
    fn start_over(&mut self, at_once: bool) {
        self.consumed = 0;
        self.reader = SummaryReader::default();
        self.published = 0;
        self.previous.clear();
        self.replaces_shown = !at_once;
        if at_once {
            self.sender.send_modify(|draft| {
                draft.segment += 1;
                draft.text.clear();
            });
        }
    }

    fn publish(&mut self, summary: &str) {
        // A browser turn ends its reply with finding lines, which the runtime moves into a
        // Details note (`browser_hand_back::move_findings_into_details`): the draft ends before
        // the first of them, so none shows while it grows. Any other turn's reply may show a
        // line of code that opens with a brace.
        let visible = summary.trim_start();
        let visible = if self.ends_at_finding_lines {
            before_a_json_line(visible)
        } else {
            visible
        };
        // The runtime removes a final NO_FILE_CHANGES line from the durable
        // answer. Hold its prefixes too, so streaming cannot expose the marker.
        let last_line = visible.rsplit_once('\n');
        let tail = last_line.map_or(visible, |(_, tail)| tail);
        let bare = tail
            .trim()
            .trim_matches(['`', '*', '[', ']'])
            .to_ascii_uppercase();
        let visible = if !bare.is_empty() && "NO_FILE_CHANGES".starts_with(&bare) {
            last_line.map_or("", |(prefix, _)| prefix)
        } else {
            visible
        };
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
        // The first words after the text started over take the place of what the draft shows.
        let replaces = std::mem::take(&mut self.replaces_shown);
        self.sender.send_modify(|draft| {
            if replaces {
                draft.segment += 1;
                draft.text.clear();
            }
            draft.text.push_str(added);
        });
        self.published = end;
    }
}

/// The text before its first line that opens a JSON object, after a list marker or backticks:
/// a browser turn's finding line, or the start of one, which no person reads.
fn before_a_json_line(text: &str) -> &str {
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let opening = line
            .trim_start()
            .trim_start_matches(['-', '*', '\u{2022}', '`'])
            .trim_start();
        if opening.starts_with('{') {
            return text[..start].trim_end();
        }
        start += line.len();
    }
    text
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
            Key | Summary => match self.read_string_char(ch) {
                StringChar::End => self.state = if self.state == Key { AfterKey } else { Done },
                StringChar::Char(ch) => self.push_decoded(ch),
                StringChar::Pending => {}
            },
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
            SkipString => {
                if let StringChar::End = self.read_string_char(ch) {
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
                if let StringChar::End = self.read_string_char(ch) {
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

    /// One character of a JSON string's body. `Pending` while it is part of an
    /// escape that has not produced a character yet.
    fn read_string_char(&mut self, ch: char) -> StringChar {
        match self.escape {
            Escape::None => match ch {
                '\\' => {
                    self.escape = Escape::Started;
                    StringChar::Pending
                }
                '"' => self.flush_surrogate_then(StringChar::End),
                ch => self.flush_surrogate_then(StringChar::Char(ch)),
            },
            Escape::Started => {
                self.escape = Escape::None;
                let decoded = match ch {
                    'u' => {
                        self.escape = Escape::Unicode(0, 0);
                        return StringChar::Pending;
                    }
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    'b' => '\u{8}',
                    'f' => '\u{c}',
                    // `"`, `\`, `/` and anything unexpected stand for themselves.
                    ch => ch,
                };
                self.flush_surrogate_then(StringChar::Char(decoded))
            }
            Escape::Unicode(read, value) => {
                let Some(digit) = ch.to_digit(16) else {
                    self.escape = Escape::None;
                    return self
                        .flush_surrogate_then(StringChar::Char(char::REPLACEMENT_CHARACTER));
                };
                let value = (value << 4) | digit as u16;
                if read < 3 {
                    self.escape = Escape::Unicode(read + 1, value);
                    return StringChar::Pending;
                }
                self.escape = Escape::None;
                self.code_unit(value)
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
            ReaderState::Summary if self.summary.len() + ch.len_utf8() <= MAX_DRAFT_BYTES => {
                self.summary.push(ch)
            }
            // Eight bytes are enough to reject any key longer than "summary".
            ReaderState::Key if self.key.len() < 8 => self.key.push(ch),
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
        for (case, text, expected) in [
            (
                "encoded summary",
                answer.as_str(),
                "Line one\nSaid \"hi\" \\ done — ok 😀 /",
            ),
            (
                "escaped slash and tab",
                r#"{"summary":"aé😀\/\tb","files":[]}"#,
                "aé😀/\tb",
            ),
            (
                "nested summaries and other keys",
                r#"{"files":[{"summary":"nested \"]}","path":"a"}],"actions":{"summary":"no"},"confidence":3,"summary":"top"}"#,
                "top",
            ),
            (
                "prose",
                "Plain prose that mentions {\"summary\": \"x\"}",
                "",
            ),
            ("fenced JSON", "```json\n{\"summary\":\"fenced\"}```", ""),
            (
                "non-string summary",
                r#"{"summary": null, "files": []}"#,
                "",
            ),
            ("array", r#"["summary", "x"]"#, ""),
        ] {
            for piece in (1..8).chain(std::iter::once(text.chars().count())) {
                assert_eq!(
                    read_in_pieces(text, piece),
                    expected,
                    "{case}, piece={piece}"
                );
            }
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
    fn oversized_unrelated_keys_do_not_grow_parser_memory_or_match_summary() {
        let mut reader = SummaryReader::default();
        reader.feed(&format!(
            "{{\"summary{}\":\"private\",\"summary\":\"Visible\"}}",
            "x".repeat(MAX_DRAFT_BYTES)
        ));
        assert_eq!(reader.summary(), "Visible");
        assert!(reader.key.len() <= 8);
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
        let mut stream = ReplyDraftStream::start(sender, false, false);
        // The first words come in a segment of their own.
        let first_segment = receiver.borrow().segment + 1;

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

        // Another attempt's words come in a segment of their own, in the earlier answer's
        // place: until they do, that answer stays.
        let sender = stream.sender.clone();
        let mut retry = ReplyDraftStream::start(sender, false, false);
        assert_eq!(
            *receiver.borrow(),
            ReplyDraft {
                segment: first_segment + 1,
                text: "Second".to_string(),
            }
        );
        retry.observe(&update("c", "{\"summ"));
        assert_eq!(receiver.borrow().text, "Second");
        retry.observe(&update("c", "{\"summary\":\"Third"));
        assert_eq!(
            *receiver.borrow(),
            ReplyDraft {
                segment: first_segment + 2,
                text: "Third".to_string(),
            }
        );
    }

    /// An answer that streamed and that the runtime then asked for again stays where it is until
    /// the retry's words replace it: never a moment with no answer and "Thinking…" back. A
    /// message naming another chat's page streamed "I can't change … here because it was created
    /// in another chat…", the runtime ran it once more for the files it didn't write, and the
    /// draft emptied as the retry began: the row went for 2.6 s and came back rewritten (a local
    /// test, Nov 20). A request Codex sends again by itself, and a failed attempt, keep it too;
    /// text that turned out to be commentary still goes at once.
    #[test]
    fn an_answer_asked_for_again_is_replaced_in_place_never_taken_away_first() {
        let first = "I can't change \u{201c}Cameras compared\u{201d} here because it was made in another chat.";
        let (sender, mut receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender.clone(), false, false);
        stream.observe(&update("a", &format!("{{\"summary\":\"{first}\"")));
        let shown = receiver.borrow_and_update().clone();
        assert_eq!(shown.text, first);

        // The runtime's retry: its run starts, its reasoning and steps come, and the draft is
        // unchanged until its own words do.
        let mut retry = ReplyDraftStream::start(sender.clone(), false, false);
        assert!(
            !receiver.has_changed().unwrap(),
            "nothing is sent as it starts"
        );
        retry.observe(
            &json!({"type":"item.started","item":{"id":"cmd","type":"command_execution"}}),
        );
        retry.observe(&update("b", "{\"summary\":\""));
        retry.observe(&update("b", "{\"summary\":\" "));
        assert!(!receiver.has_changed().unwrap());
        assert_eq!(*receiver.borrow(), shown);
        retry.observe(&update("b", "{\"summary\":\" I can't edit"));
        assert_eq!(
            *receiver.borrow_and_update(),
            ReplyDraft {
                segment: shown.segment + 1,
                text: "I can't edit".to_string(),
            }
        );
        retry.observe(&update(
            "b",
            "{\"summary\":\" I can't edit it from this chat.",
        ));
        assert_eq!(receiver.borrow().text, "I can't edit it from this chat.");

        // A request sent again, or a failed attempt: the text shown stays until the next words,
        // which replace it rather than extend it.
        for event in ["stream.retry", "turn.failed"] {
            let before = receiver.borrow_and_update().clone();
            retry.observe(&json!({ "type": event }));
            assert!(!receiver.has_changed().unwrap(), "{event}");
            retry.observe(&update("c", "{\"summary\":\"Again."));
            assert_eq!(
                *receiver.borrow_and_update(),
                ReplyDraft {
                    segment: before.segment + 1,
                    text: "Again.".to_string(),
                },
                "{event}"
            );
        }

        // Commentary the draft showed goes at once.
        retry.observe(&json!({ "type": DRAFT_RESET_EVENT }));
        assert_eq!(receiver.borrow().text, "");
    }

    /// An answer the runtime found untrue goes as its retry begins, not when the retry's words
    /// come: a refused card's "I've opened a browser check of the official results." would stand
    /// in the chat with no card behind it for as long as the retry ran, and to the turn's end
    /// when the retry's whole answer was a card. The retry's words then grow where it was.
    #[test]
    fn an_answer_the_runtime_found_untrue_goes_as_its_retry_begins() {
        let first = "I've opened a browser check of the official results.";
        let (sender, mut receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender.clone(), false, false);
        stream.observe(&update("a", &format!("{{\"summary\":\"{first}\"")));
        let shown = receiver.borrow_and_update().clone();
        assert_eq!(shown.text, first);

        let mut retry = ReplyDraftStream::start(sender, false, false);
        retry.withdraw_shown();
        assert_eq!(
            *receiver.borrow_and_update(),
            ReplyDraft {
                segment: shown.segment + 1,
                text: String::new(),
            }
        );
        // Nothing of the first answer stays while the retry works, also when its whole answer
        // turns out to be a card. Its words, when it writes any, grow there.
        retry.observe(
            &json!({"type":"item.started","item":{"id":"cmd","type":"command_execution"}}),
        );
        retry.observe(&update("b", "{\"summary\":\""));
        assert_eq!(receiver.borrow().text, "");
        retry.observe(&update("b", "{\"summary\":\"The home side won 3 to 1."));
        assert_eq!(
            *receiver.borrow(),
            ReplyDraft {
                segment: shown.segment + 1,
                text: "The home side won 3 to 1.".to_string(),
            }
        );
    }

    /// A browser turn ends its reply with finding lines, which the runtime moves into a Details
    /// note: the draft stops before the first of them, so none shows while the turn writes it.
    #[test]
    fn a_browser_turns_finding_lines_never_reach_the_draft() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender, false, true);
        let words = "Livraria Lello is open daily from 9:00 to 19:30.";
        let mut text = format!("{{\"summary\":\"{words}");
        stream.observe(&update("a", &text));
        assert_eq!(receiver.borrow().text, words);
        for piece in [
            r#"\n"#,
            r#"{\"url\": \"https://lello.example/\""#,
            r#", \"facts\": [\"Open daily\"]}"#,
            r#"\n- `{\"url\": \"https://visit.example/\", \"stopped\": \"timed-out\"}`"#,
            r#"\"}"#,
        ] {
            text.push_str(piece);
            stream.observe(&update("a", &text));
            assert_eq!(receiver.borrow().text.trim_end(), words, "{text}");
        }
    }

    /// Any other turn's reply drafts its lines that open with a brace, a settings file or a
    /// placeholder the reply names, as it writes them: no finding line ends it.
    #[test]
    fn a_building_turns_draft_shows_its_brace_lines() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender, false, false);
        let reply = r#"Here is the settings file:\n```json\n{\"theme\": \"dark\"}\n```\n`{title}` now shows the trip name."#;
        stream.observe(&update("a", &format!("{{\"summary\":\"{reply}")));
        assert_eq!(
            receiver.borrow().text,
            "Here is the settings file:\n```json\n{\"theme\": \"dark\"}\n```\n`{title}` now shows the trip name."
        );
    }

    #[test]
    fn a_declined_answer_never_reaches_the_draft() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender, false, false);
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
        let mut stream = ReplyDraftStream::start(sender, false, false);
        let long = "é".repeat(MAX_DRAFT_BYTES);
        stream.observe(&update("a", &format!("{{\"summary\":\"{long}")));
        let draft = receiver.borrow().text.clone();
        assert!(draft.len() <= MAX_DRAFT_BYTES && draft.len() > MAX_DRAFT_BYTES - 4);
        assert!(long.starts_with(&draft));
    }
    #[test]
    fn plain_final_prose_streams_but_commentary_and_json_contracts_do_not() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender, true, false);
        let event = |id: &str, text: &str, phase: &str| {
            json!({
                "type":"item.updated", "item":{"id":id,"type":"agent_message","text":text,"phase":phase}
            })
        };
        stream.observe(&event("comment", "Private progress", "commentary"));
        stream.observe(&event("unknown", "Not yet final", ""));
        assert_eq!(receiver.borrow().text, "");
        stream.observe(&event("final", "The report says", "final_answer"));
        assert_eq!(receiver.borrow().text, "The report says");
        stream.observe(&event(
            "final",
            "The report says all checks passed.",
            "final_answer",
        ));
        assert_eq!(receiver.borrow().text, "The report says all checks passed.");
        stream.observe(&event(
            "json",
            r#"{"summary":"Readable","actions":[{"secret":"never"}]}"#,
            "final_answer",
        ));
        assert_eq!(receiver.borrow().text, "Readable");
        stream.observe(&event(
            "fence",
            "```json\n{\"actions\":[{\"secret\":\"never\"}]}",
            "final_answer",
        ));
        assert_eq!(receiver.borrow().text, "");
        stream.observe(&event("inline", "`", "final_answer"));
        assert_eq!(receiver.borrow().text, "");
        stream.observe(&event(
            "inline",
            "`README.md` now explains the change.",
            "final_answer",
        ));
        assert_eq!(
            receiver.borrow().text,
            "`README.md` now explains the change."
        );
    }

    #[test]
    fn a_draft_reset_clears_the_draft_and_starts_a_segment() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender, true, false);
        // The first words come in a segment of their own.
        let segment = receiver.borrow().segment + 1;
        let drafted = |text: &str| json!({"type": "item.updated", "item": {"id": "msg_1:0", "type": "agent_message", "text": text, "phase": "final_answer"}});
        stream.observe(&drafted("I'll read the README"));
        assert_eq!(receiver.borrow().text, "I'll read the README");
        // The text was commentary: a tool call followed it in the same message.
        stream.observe(&json!({"type": "item.completed", "item": {"id": "msg_1:0", "type": "agent_message", "text": "I'll read the README", "phase": "commentary"}}));
        assert_eq!(receiver.borrow().text, "I'll read the README");
        stream.observe(&json!({ "type": DRAFT_RESET_EVENT }));
        assert_eq!(
            *receiver.borrow(),
            ReplyDraft {
                segment: segment + 1,
                text: String::new(),
            }
        );
        // The same item drafting again starts from its own text, not after the cleared one.
        stream.observe(&drafted("Done."));
        assert_eq!(receiver.borrow().text, "Done.");
        assert_eq!(receiver.borrow().segment, segment + 1);
    }

    /// A local-engine turn's events (docs/Local-Engine-Turns.md 3.7), from the fake `claude`'s
    /// success scenario, read as a turn reads them: the steps `extract_codex_messages` makes of
    /// them, and the drafts the reply stream shows.
    #[test]
    fn a_local_engine_turns_events_make_its_steps_and_drafts() {
        use crate::claude_code::events::EventAdapter;
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let folder_text = folder.to_str().unwrap();
        let home = "/home/person";
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake-claude-fixtures/scenarios/success.jsonl");
        let scenario = std::fs::read_to_string(&fixture).unwrap();
        let mut adapter = EventAdapter::new(&folder, Some(std::path::Path::new(home)));
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender, true, false);
        // The first words come in a segment of their own.
        let first = receiver.borrow().segment + 1;
        let mut events = Vec::new();
        let mut drafts: Vec<ReplyDraft> = Vec::new();
        for line in scenario.lines().filter(|line| !line.starts_with("#!")) {
            let line = line
                .replace("@CWD@", folder_text)
                .replace("@HOME@", home)
                .replace("@SESSION@", "5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50");
            let value: JsonValue = serde_json::from_str(&line).unwrap();
            for event in adapter.feed(&value) {
                stream.observe(&event);
                let draft = receiver.borrow().clone();
                if drafts.last() != Some(&draft) {
                    drafts.push(draft);
                }
                events.push(event);
            }
        }
        // The commentary drafted until a tool call followed it in its message, then the draft
        // cleared; the subagent's words never drafted, nor did thinking; the reply drafted with
        // its paths made relative.
        let draft = |segment: u64, text: &str| ReplyDraft {
            segment,
            text: text.to_string(),
        };
        assert_eq!(
            drafts,
            [
                draft(first, "I'll read "),
                draft(first, "I'll read the README first."),
                draft(first + 1, ""),
                draft(first + 1, "Renamed the project in "),
                draft(
                    first + 1,
                    "Renamed the project in README.md and wrote docs/notes.md."
                ),
            ]
        );

        let messages = super::super::extract_codex_messages(&events);
        let steps: Vec<(&str, &str)> = messages
            .iter()
            .map(|message| {
                (
                    message.message_type.as_deref().unwrap_or_default(),
                    message.content.as_str(),
                )
            })
            .collect();
        assert_eq!(
            steps,
            [
                ("status", "I'll read the README first."),
                ("mcp_tool_call", "Tool call started: claude-code/Read"),
                ("mcp_tool_call", "Tool call completed: claude-code/Read"),
                ("command_execution", "npm test"),
                ("command_execution", "npm test"),
                ("file_change", "Applied file changes: README.md"),
                ("file_change", "Applied file changes: docs/notes.md"),
                ("command_execution", "tail -f server.log"),
                ("command_execution", "tail -f server.log"),
                ("web_search", "Web search started"),
                ("web_search", "Web search completed: \"vitest config\""),
                ("todo_list", "Plan update: 1/2 steps complete"),
                ("todo_list", "Plan update: 0/1 steps complete"),
                ("todo_list", "Plan update: 0/2 steps complete"),
                ("todo_list", "Plan update: 1/2 steps complete"),
                ("status", "Let me ask a helper to find the other uses."),
                ("mcp_tool_call", "Tool call started: claude-code/Agent"),
                ("status", "Searching for uses."),
                ("mcp_tool_call", "Tool call started: claude-code/Grep"),
                ("mcp_tool_call", "Tool call completed: claude-code/Grep"),
                ("mcp_tool_call", "Tool call completed: claude-code/Agent"),
                ("mcp_tool_call", "Tool call started: claude-code/Task"),
                ("mcp_tool_call", "Tool call completed: claude-code/Task"),
                ("mcp_tool_call", "Tool call started: claude-code/WebFetch"),
                ("mcp_tool_call", "Tool call completed: claude-code/WebFetch"),
            ]
        );
        let metadata = |index: usize| messages[index].metadata.clone().unwrap();
        assert_eq!(
            metadata(4)["aggregatedOutput"],
            json!("3 tests passed in test with key [redacted] read from ~/.npmrc")
        );
        assert_eq!(metadata(4)["status"], json!("completed"));
        // A Monitor watch is a command step.
        assert_eq!(metadata(7)["kind"], json!("codex_command_execution"));
        // The plan step carries the whole list the task tools built, each time either ran.
        assert_eq!(
            metadata(14)["items"],
            json!([
                {"text": "Check the links", "completed": true},
                {"text": "Update the docs", "completed": false},
            ])
        );
        assert_eq!(metadata(16)["tool"], json!("Agent"));
        assert_eq!(metadata(21)["tool"], json!("Task"));

        // Steps, their stored events and drafts name neither the folder nor the home folder,
        // and carry no token.
        let everything = serde_json::to_string(&json!({
            "events": events,
            "steps": messages.iter().map(|message| json!({"content": message.content, "metadata": message.metadata})).collect::<Vec<_>>(),
            "drafts": drafts.iter().map(|draft| draft.text.clone()).collect::<Vec<_>>(),
            "runLog": adapter.run_log().events(),
        }))
        .unwrap();
        for leak in [folder_text, home, "sk-ant-", "Private thoughts"] {
            assert!(!everything.contains(leak), "{leak} leaked");
        }
        assert_eq!(
            adapter.reply(),
            Some("Renamed the project in README.md and wrote docs/notes.md.")
        );
        assert!(adapter.succeeded());
    }

    #[test]
    fn replacements_retries_and_runtime_markers_do_not_append_stale_or_internal_text() {
        let (sender, receiver) = watch::channel(ReplyDraft::default());
        let mut stream = ReplyDraftStream::start(sender, false, false);
        stream.observe(&update("a", r#"{"summary":"First answer"#));
        let segment = receiver.borrow().segment;
        stream.observe(&update("a", r#"{"summary":"Other answer"#));
        assert!(receiver.borrow().segment > segment);
        assert_eq!(receiver.borrow().text, "Other answer");
        // A request sent again leaves the answer shown until the next words replace it.
        stream.observe(&json!({"type":"stream.retry"}));
        assert_eq!(receiver.borrow().text, "Other answer");
        for tail in ["N", "NO_", "NO_FILE_CHANGES"] {
            stream.observe(&update("b", &format!("{{\"summary\":\"Done.\\n{tail}")));
            assert_eq!(receiver.borrow().text, "Done.");
        }
    }
}
