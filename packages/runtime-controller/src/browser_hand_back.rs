//! Hand-back: what a browser turn found goes back to the building turn.
//!
//! A building turn cannot open web pages, so it asks for Instafy's browser
//! with a `request_browser` card, and the browser turn that continues the
//! card runs on its chat's browser thread without the workspace: the
//! runtime keeps a building thread and a browser thread per chat. When that browser turn
//! finishes, Studio sends one ordinary turn back to the building lane with
//! `metadata.continuesFromBrowserJob` naming the browser job. Anyone who can
//! send a message can write that field, so the controller never trusts it: a
//! dispatch takes it out of the client's metadata (with any client copy of
//! the record below) and puts back `metadata.browserHandBack` only when:
//!
//! - the sender is the person whose browser turn it was;
//! - that job is a browser turn in this conversation that continued a card
//!   (`browserRequestOf: "job:<id>"`), finished successfully, and finished
//!   within [`HAND_BACK_WINDOW_MINUTES`], without stopping for a step of the
//!   person's (a manual step on the page, or a step its approval ended);
//! - the card's own turn was the sender's, and not itself a hand-back: one
//!   automatic hop only, so a later card stays a button for the person to press;
//! - the card continues building something (`continueBuilding`, a page or a
//!   map): a card for a question is answered by the browser turn itself;
//! - the browser turn read at least one page: a finding that only says where
//!   it stopped gives the building turn nothing to continue with;
//! - no other hand-back for that browser job is queued, running or done;
//! - nobody sent a prompt in the conversation after the browser turn, other
//!   than a hand-back of it that failed, was stopped or expired: Try again on
//!   a failed one sends the hand-back again, its claim and Studio's words,
//!   never the notice it showed.
//!
//! A hand-back that passes resumes the building lane of the card's turn, so
//! it goes to that turn's agent alone, whichever agents its send names, and
//! writes no more than that turn could: without its write permission it has
//! none, and it keeps that turn's owned paths ([`ContinuedTurn`]).
//!
//! One browser turn hands back without reading a page: one that carries on a
//! card the routing step posted for the person's own message, opened no page
//! and asked Octo to make what the message asks (the runtime's Details note,
//! [`BUILD_REQUEST_NOTE_KEY`]; runtime-agent `jobs/browser_hand_back.rs`). The
//! message asked for something a browser turn cannot make, so its words go to
//! the building turn as the person's request, whether or not the card
//! continues building, and the record carries nothing of the browser turn
//! ([`BUILD_REQUEST_RECORD_KEY`]). The person's message has no answer until
//! that building turn gives one, so the controller sends this hand-back itself,
//! in the person's name, as soon as the browser turn's completion is committed
//! ([`hand_back_build_request`]): it never waits for a page of theirs to be
//! open. Its send goes through the same checks as Studio's.
//!
//! The record carries every finding line of the browser turn's last reply as
//! a labelled finding `{url, title, facts, readAt, viewer}`: the address,
//! title and facts come from the line, `readAt` and `viewer` from the job
//! itself. None of the turn's own words go with them: a page that stopped it
//! is a finding with `stopped`, which says which page and why, and only a
//! reply whose lines list no fact goes as it is
//! ([`words_for_the_building_turn`]); the record fits the runtime's section
//! ([`fit_the_section`]). The runtime moves those lines out
//! of the reply the person reads into a Details note of the browser turn
//! (runtime-agent `move_findings_into_details`), and the record reads them
//! back after the reply. A browser turn whose findings go back to the building
//! turn posts no words of its own: its note holds them, ahead of its findings,
//! and that note is its reply here ([`browser_turn_reply`]).
//! It does so only because every lease says this controller reads the note
//! ([`READS_NOTE_KEY`]): under an older controller, which refuses a hand-back
//! from a turn that posted no reply, the runtime posts "Finished in the
//! browser." in its place.
//! The runtime shows the record to the building turn as quoted page data,
//! never as the person's words and never as their consent (runtime-agent
//! `jobs/browser_hand_back.rs`).
//! A hand-back is never queued or recorded without a dispatch: it resumes an
//! idle lane or is refused.
//!
//! Every other browser turn reaches the building thread the same way, as
//! data: a building job's lease lists the conversation's browser turns since
//! the building thread's last turn ([`browser_turns_since`]), each with what
//! it was asked, its reply with its finding lines put back (at most
//! [`TURN_REPLY_MAX_CHARS`]), and those findings labelled as above.
//! The runtime quotes them to a building turn on a restored thread; the
//! hand-back's own browser turn is in its record, not the list.

use axum::{http::StatusCode, Json};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::{bad_request, forbidden, internal_error, ApiError};
use tracing::{info, warn};

pub(crate) const HAND_BACK_KEY: &str = "browserHandBack";
const HAND_BACK_ALIASES: [&str; 2] = [HAND_BACK_KEY, "browser_hand_back"];
pub(crate) const HAND_BACK_CLAIM_KEY: &str = "continuesFromBrowserJob";
/// What a hand-back asks the building turn, whatever words the send carried:
/// Studio's own (`BROWSER_HAND_BACK_PROMPT`); the findings come as data.
pub(crate) const HAND_BACK_PROMPT: &str = "Continue building with what the browser turn found.";
const HAND_BACK_CLAIM_ALIASES: [&str; 2] = [HAND_BACK_CLAIM_KEY, "continues_from_browser_job"];
/// Nested copies of the message metadata a client could also fill in.
const NESTED_METADATA_KEYS: [&str; 3] = ["prompt_metadata", "promptMetadata", "details"];
const HAND_BACK_VERSION: u64 = 1;
/// What the runtime quotes of a hand-back's record in one prompt section at
/// most (runtime-agent `browser_hand_back::DATA_MAX_CHARS`): an older runtime
/// leaves out the whole section over it, so the record never is
/// ([`fit_the_section`]).
pub(crate) const HAND_BACK_SECTION_MAX_CHARS: usize = 12_000;
/// How much of a browser turn's reply a building job's lease lists
/// ([`browser_turns_since`]).
pub(crate) const TURN_REPLY_MAX_CHARS: usize = 6_000;
const FINDING_TITLE_MAX_CHARS: usize = 160;
const FINDING_URL_MAX_CHARS: usize = 2_048;
/// What one finding's facts hold at most, whole facts in order, the rest
/// counted (`factsLeftOut`): one page's facts never crowd out the others.
const FINDING_FACTS_MAX_CHARS: usize = 2_000;
/// A browser turn older than this is history, not a turn to resume from.
pub(crate) const HAND_BACK_WINDOW_MINUTES: i64 = 30;
/// How much of what a browser turn was asked reaches the building turn.
pub(crate) const REQUEST_MAX_CHARS: usize = 2_000;
/// How much of a routed message's words the hand-back gives the building turn
/// as the person's request: all of a card's task (runtime-agent
/// `ROUTED_BROWSER_TASK_MAX_UTF16_UNITS`).
pub(crate) const PERSON_REQUEST_MAX_CHARS: usize = 8_000;
/// The payload key a lease stamps with [`browser_turns_since`].
pub(crate) const TURNS_SINCE_KEY: &str = "browser_turns_since";
/// The browser turns a building turn reads at most: the browser skill's six
/// reads per card, the newest ones.
pub(crate) const TURNS_SINCE_MAX: i64 = 6;
/// The payload key a lease stamps with whether [`browser_turns_since`] left
/// older turns out to keep the newest [`TURNS_SINCE_MAX`].
pub(crate) const TURNS_SINCE_LEFT_OUT_KEY: &str = "browser_turns_since_earlier_left_out";
/// The payload key with which every lease says that this controller reads the
/// Details note of a browser turn that posted no words of its own as that
/// turn's reply ([`browser_turn_reply`]). The runtime leaves a browser turn
/// whose findings go back to the building turn without words only then: an
/// older controller refuses the hand-back of such a turn as empty
/// (runtime-agent `browser_hand_back::READS_NOTE_KEY`).
pub(crate) const READS_NOTE_KEY: &str = "browser_hand_back_reads_note";
/// What Studio sends when the person presses Let Octo continue
/// (`BROWSER_HUMAN_INPUT_CONTINUE_PROMPT`; the fixture pins it).
pub(crate) const LET_OCTO_CONTINUE_PROMPT: &str = "Continue the previous browser task on this same page. I may have used the browser while I had control. Take a fresh snapshot before acting; do not reuse old target indices or request, reveal, or repeat any values I may have entered.";
/// How a building turn reads that press: one line, not Studio's
/// instructions in the person's name.
pub(crate) const LET_OCTO_CONTINUE_LINE: &str = "The person let Octo continue in the browser.";

const VIEWER_WORKSPACE: &str = "Instafy's browser in the workspace";
const VIEWER_DEVICE: &str = "Instafy's browser on the person's device";

pub(crate) const HAND_BACK_SECOND_HOP_CODE: &str = "browser_hand_back_second_hop";
pub(crate) const HAND_BACK_USED_CODE: &str = "browser_hand_back_used";
pub(crate) const HAND_BACK_PAUSED_CODE: &str = "browser_hand_back_paused";
pub(crate) const HAND_BACK_SUPERSEDED_CODE: &str = "browser_hand_back_superseded";
pub(crate) const HAND_BACK_NOT_BUILDING_CODE: &str = "browser_hand_back_not_building";
pub(crate) const HAND_BACK_NOTHING_READ_CODE: &str = "browser_hand_back_nothing_read";
/// The key of the runtime's Details note on a browser turn that asked Octo to
/// make the person's message (runtime-agent `BUILD_REQUEST_NOTE_KEY`).
pub(crate) const BUILD_REQUEST_NOTE_KEY: &str = "browserBuildRequest";
/// The key a hand-back record that carries such a message has.
pub(crate) const BUILD_REQUEST_RECORD_KEY: &str = "buildRequest";
/// What a hand-back the controller sends for such a message records in place
/// of its prompt, after the agent's name. Studio leaves it out: the person
/// reads their message and then the building turn.
const BUILD_REQUEST_NOTICE_SUFFIX: &str = "continued in the chat";

/// Removes every client-supplied hand-back claim and record, top level and
/// nested, and returns the top-level claim for [`require_hand_back`].
pub(crate) fn take_hand_back_claim(metadata: &mut JsonValue) -> Option<JsonValue> {
    let map = metadata.as_object_mut()?;
    let mut claim = None;
    for key in HAND_BACK_CLAIM_ALIASES {
        if let Some(value) = map.remove(key) {
            claim.get_or_insert(value);
        }
    }
    for key in HAND_BACK_ALIASES {
        map.remove(key);
    }
    for key in NESTED_METADATA_KEYS {
        if let Some(nested) = map.get_mut(key).and_then(JsonValue::as_object_mut) {
            for alias in HAND_BACK_CLAIM_ALIASES
                .iter()
                .chain(HAND_BACK_ALIASES.iter())
            {
                nested.remove(*alias);
            }
        }
    }
    claim
}

/// The browser job a claim names: one UUID string, nothing else.
pub(crate) fn parse_hand_back_claim(value: &JsonValue) -> Option<Uuid> {
    value
        .as_str()
        .map(str::trim)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

/// One labelled finding: an address the reply names, its title, and what
/// the page showed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Finding {
    pub(crate) url: String,
    pub(crate) title: Option<String>,
    /// What the page showed, as the finding line lists it, at most
    /// [`FINDING_FACTS_MAX_CHARS`]: none for a page that was not read, or for
    /// a line that names an address alone.
    pub(crate) facts: Vec<String>,
    /// How many more facts its lines list than [`FINDING_FACTS_MAX_CHARS`]
    /// holds.
    pub(crate) facts_left_out: usize,
    /// Why the page was not read: one of [`STOP_REASONS`].
    pub(crate) stopped: Option<&'static str>,
}

/// The reasons a browser turn may give for a page it did not read, as the
/// browser skill (`instafy-browser-automation`, "Several reads in one card")
/// names them. Any other reason a finding gives is still a stop: `blocked`.
pub(crate) const STOP_REASONS: [&str; 8] = [
    "login",
    "captcha",
    "paywall",
    "blocked",
    "robots",
    "download",
    "secret",
    "link-only",
];
const STOP_REASON_OTHER: &str = "blocked";

/// One line of plain text: control characters dropped, whitespace collapsed, capped.
fn one_line(value: &str, max: usize) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max).collect()
}

fn is_address_end(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '<' | '>' | '"' | '\'' | '`' | ')' | ']')
}

/// The first http(s) address in a line, as `(start byte, address)`. Trailing
/// sentence punctuation is not part of it.
fn first_address(line: &str) -> Option<(usize, String)> {
    let lower = line.to_ascii_lowercase();
    let start = match (lower.find("https://"), lower.find("http://")) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) | (None, Some(a)) => a,
        (None, None) => return None,
    };
    let rest = &line[start..];
    let end = rest.find(is_address_end).unwrap_or(rest.len());
    let address = rest[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
    Some((start, address.to_string()))
}

/// A public-looking http(s) address without credentials, normalized; None otherwise.
fn plain_address(raw: &str) -> Option<String> {
    if raw.chars().count() > FINDING_URL_MAX_CHARS {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host().is_none_or(is_private_host)
    {
        return None;
    }
    let normalized = parsed.to_string();
    (normalized.chars().count() <= FINDING_URL_MAX_CHARS).then_some(normalized)
}

/// A host no public page lives at: a loopback, private, link-local (cloud
/// metadata), shared or unspecified address, in any spelling the URL parser
/// accepts (decimal, hex or short IPv4, IPv4-mapped IPv6), or a local-only
/// name. Neither browser reads such an address for a card, so a finding that
/// names one is page text, and the building turn, whose shell can reach that
/// network, is never pointed at it.
fn is_private_host(host: url::Host<&str>) -> bool {
    fn private_v4(ip: std::net::Ipv4Addr) -> bool {
        let [a, b, ..] = ip.octets();
        ip.is_loopback()
            || ip.is_private()
            || ip.is_link_local()
            || ip.is_unspecified()
            || ip.is_broadcast()
            || a == 0
            || (a == 100 && (64..128).contains(&b))
    }
    match host {
        url::Host::Ipv4(ip) => private_v4(ip),
        url::Host::Ipv6(ip) => {
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || ip.to_ipv4_mapped().is_some_and(private_v4)
        }
        url::Host::Domain(name) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !name.contains('.')
                || [".localhost", ".local", ".internal", ".home.arpa"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
        }
    }
}

/// The words before an address on its line, without list markers or the
/// separators that lead into the address.
fn finding_title(before: &str) -> Option<String> {
    let mut title = before.trim();
    for marker in ["- ", "* ", "• ", "+ "] {
        if let Some(stripped) = title.strip_prefix(marker) {
            title = stripped.trim_start();
            break;
        }
    }
    let digits = title.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let after = &title[digits..];
        if let Some(stripped) = after
            .strip_prefix(". ")
            .or_else(|| after.strip_prefix(") "))
        {
            title = stripped.trim_start();
        }
    }
    let title = title
        .trim_start_matches(['[', '*', '_'])
        .trim_end_matches(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '—' | '–' | '-' | ':' | '(' | '<' | '[' | ']' | '`' | '*' | '_' | '|'
                )
        });
    let title = one_line(title, FINDING_TITLE_MAX_CHARS);
    (!title.is_empty()).then_some(title)
}

/// The findings a browser turn's reply lists, one per line: a JSON object as
/// the browser skill writes one (`url`, `title`, `facts`, `stopped`). Only a
/// reply with no such line falls back to each line's first http(s) address
/// and the words before it, so an address that page text put in the reply's
/// prose never becomes a labelled finding next to the ones the skill wrote.
/// Every line, each address once: a later line for the same page adds the
/// facts it lists, and facts over a page's bound are counted, not kept.
/// Nothing here is checked against the pages: they label the reply's own
/// claims, which the building turn reads as page data.
pub(crate) fn findings_from_reply(reply: &str) -> Vec<Finding> {
    let json_lines: Vec<Option<Finding>> = reply.lines().filter_map(json_finding).collect();
    let candidates: Vec<Finding> = if json_lines.is_empty() {
        reply.lines().filter_map(text_finding).collect()
    } else {
        json_lines.into_iter().flatten().collect()
    };
    let mut findings: Vec<Finding> = Vec::new();
    for finding in candidates {
        match findings.iter_mut().find(|known| known.url == finding.url) {
            Some(known) => {
                for fact in finding.facts {
                    if known.stopped.is_none() && !known.facts.contains(&fact) {
                        known.facts.push(fact);
                    }
                }
            }
            None => findings.push(finding),
        }
    }
    for finding in &mut findings {
        let listed = finding.facts.len();
        let mut room = FINDING_FACTS_MAX_CHARS;
        finding.facts.retain(|fact| {
            let fits = fact.chars().count() <= room;
            room = if fits { room - fact.chars().count() } else { 0 };
            fits
        });
        finding.facts_left_out = listed - finding.facts.len();
    }
    findings
}

/// The facts a finding line lists, each one line: what its page showed. A
/// page that stopped the turn showed nothing.
fn finding_facts(object: &JsonMap<String, JsonValue>) -> Vec<String> {
    let facts = match object.get("facts") {
        Some(JsonValue::Array(items)) => items.iter().filter_map(JsonValue::as_str).collect(),
        Some(JsonValue::String(fact)) => vec![fact.as_str()],
        _ => Vec::new(),
    };
    facts
        .into_iter()
        .map(|fact| one_line(fact, FINDING_FACTS_MAX_CHARS))
        .filter(|fact| !fact.is_empty())
        .collect()
}

/// A line that is one JSON object with a `url`, as the browser skill writes a
/// finding (`{"url", "title", "facts"}` or `{"url", "stopped"}`): Some(None)
/// when that `url` is no usable address, None when the line is not such an
/// object. Its `readAt` and `viewer`, if any, are the model's; the record uses
/// the job's.
fn json_finding(line: &str) -> Option<Option<Finding>> {
    let mut text = line.trim();
    for marker in ["- ", "* ", "• "] {
        if let Some(stripped) = text.strip_prefix(marker) {
            text = stripped.trim_start();
            break;
        }
    }
    let text = text.trim_end_matches(',').trim_matches('`').trim();
    if !(text.starts_with('{') && text.ends_with('}')) {
        return None;
    }
    let value = serde_json::from_str::<JsonValue>(text).ok()?;
    let object = value.as_object()?;
    let Some(url) = object.get("url")?.as_str().and_then(plain_address) else {
        return Some(None);
    };
    let title = object
        .get("title")
        .and_then(JsonValue::as_str)
        .map(|title| one_line(title, FINDING_TITLE_MAX_CHARS))
        .filter(|title| !title.is_empty());
    // Any `stopped` the finding gives means the page was not read; a reason
    // the skill does not name is `blocked`, never a page read.
    let stopped = match object.get("stopped") {
        None | Some(JsonValue::Null) | Some(JsonValue::Bool(false)) => None,
        Some(JsonValue::String(reason)) if reason.trim().is_empty() => None,
        Some(JsonValue::String(reason)) => Some(
            STOP_REASONS
                .iter()
                .copied()
                .find(|known| known.eq_ignore_ascii_case(reason.trim()))
                .unwrap_or(STOP_REASON_OTHER),
        ),
        Some(_) => Some(STOP_REASON_OTHER),
    };
    let facts = if stopped.is_some() {
        Vec::new()
    } else {
        finding_facts(object)
    };
    Some(Some(Finding {
        url,
        title,
        facts,
        facts_left_out: 0,
        stopped,
    }))
}

/// A line of text with an address in it: the first address and the words before it.
fn text_finding(line: &str) -> Option<Finding> {
    let (start, raw) = first_address(line)?;
    Some(Finding {
        url: plain_address(&raw)?,
        title: finding_title(&line[..start]),
        facts: Vec::new(),
        facts_left_out: 0,
        stopped: None,
    })
}

/// A browser turn's reply as a building job's lease lists it
/// ([`browser_turns_since`]): at most [`TURN_REPLY_MAX_CHARS`] characters,
/// NUL bytes removed, and whether it was cut.
pub(crate) fn bounded_reply(reply: &str) -> (String, bool) {
    let cleaned = reply.replace('\0', "");
    let trimmed = cleaned.trim();
    let truncated = trimmed.chars().count() > TURN_REPLY_MAX_CHARS;
    (
        trimmed.chars().take(TURN_REPLY_MAX_CHARS).collect(),
        truncated,
    )
}

/// What of a browser turn's own words goes to the building turn with its
/// findings: none, once a finding line lists what its page showed. The words
/// are the browser turn's, not a page's: told that a place or claim they
/// named with no page under it was not checked, a map's hand-back still put
/// the browser turn's day plan and advice, which no page gave, on the map (a
/// local test, Nov 4). A page that stopped the turn goes as its finding,
/// which says which page and why: the first line, where the browser turn says
/// so, also says what it read, and that map's turn wrote it as one paragraph
/// with its advice in it. A reply whose lines list no fact goes as it is,
/// since it is all the turn said: one that wrote no finding line, whose note
/// lists the pages its own steps opened by address alone (runtime-agent
/// `finding_lines_from_pages`), or an older runtime's reply.
fn words_for_the_building_turn(reply: &str, findings: &[Finding]) -> String {
    if findings.iter().any(|finding| !finding.facts.is_empty()) {
        return String::new();
    }
    reply.trim().to_string()
}

/// A finding's own characters, which it quotes at least.
fn finding_chars(finding: &Finding) -> usize {
    finding.url.chars().count()
        + finding
            .title
            .as_deref()
            .map_or(0, |title| title.chars().count())
        + finding
            .facts
            .iter()
            .map(|fact| fact.chars().count())
            .sum::<usize>()
}

/// The findings that can fit the runtime's section, and how many cannot: the
/// pages read, in order, while their own characters stay within it, and the
/// same of the pages that stopped the turn, the first of each always. Each
/// quotes at least its own characters, so [`fit_the_section`] would leave the
/// rest out too; leaving them out first keeps fitting cheap however many
/// lines a reply has.
fn findings_that_can_fit(findings: Vec<Finding>) -> (Vec<Finding>, usize) {
    // The characters left for the pages read and for those that stopped the
    // turn: none counted before the first of each.
    let mut room: [Option<usize>; 2] = [None, None];
    let listed = findings.len();
    let kept: Vec<Finding> = findings
        .into_iter()
        .filter(|finding| {
            let room = &mut room[usize::from(finding.stopped.is_some())];
            let chars = finding_chars(finding);
            let left = room.unwrap_or(HAND_BACK_SECTION_MAX_CHARS);
            let fits = room.is_none() || chars <= left;
            *room = Some(if fits { left.saturating_sub(chars) } else { 0 });
            fits
        })
        .collect();
    let left_out = listed - kept.len();
    (kept, left_out)
}

/// A reply's whole lines while they stay within the runtime's section, its
/// first line cut to it when that alone is over, and whether any of it was
/// left out: a line quotes at least its own characters, so [`fit_the_section`]
/// would keep no more, and fitting stays cheap however long the reply.
fn reply_that_can_fit(reply: &str) -> (String, bool) {
    if reply.chars().count() <= HAND_BACK_SECTION_MAX_CHARS {
        return (reply.to_string(), false);
    }
    let mut end = 0;
    let mut chars = 0;
    for line in reply.split_inclusive('\n') {
        chars += line.chars().count();
        if chars > HAND_BACK_SECTION_MAX_CHARS {
            break;
        }
        end += line.len();
    }
    let kept = if end == 0 {
        reply.chars().take(HAND_BACK_SECTION_MAX_CHARS).collect()
    } else {
        reply[..end].trim_end().to_string()
    };
    (kept, true)
}

/// How many characters the runtime quotes of a record in its section: the
/// record's data as pretty JSON, each backtick escaped to six (runtime-agent
/// `browser_hand_back::format_browser_hand_back_section`), with the reply and
/// `replyTruncated` that an older runtime quotes even when empty.
fn quoted_chars(record: &JsonValue) -> usize {
    let mut data = json!({
        "viewer": record["viewer"],
        "readAt": record["readAt"],
        "findings": record["findings"],
        "reply": record["reply"],
        "replyTruncated": record["replyTruncated"],
    });
    if let Some(left_out) = record.get("findingsLeftOut") {
        data["findingsLeftOut"] = left_out.clone();
    }
    // A routed message's words lead the section, outside its data.
    if record.get("personRequest").is_none() {
        data["request"] = record["request"].clone();
    }
    serde_json::to_string_pretty(&data).map_or(usize::MAX, |text| {
        text.chars().map(|ch| if ch == '`' { 6 } else { 1 }).sum()
    })
}

/// Leaves out the last finding of a record over its section: the last page
/// read while another stays, else the last page that stopped the turn, whose
/// finding is short and says which page and why. Never the only finding.
fn leave_out_a_finding(findings: &mut Vec<JsonValue>) -> bool {
    let read = |finding: &JsonValue| finding.get("stopped").is_none();
    let index = if findings.iter().filter(|finding| read(finding)).count() > 1 {
        findings.iter().rposition(read)
    } else if findings.len() > 1 {
        findings.iter().rposition(|finding| !read(finding))
    } else {
        None
    };
    index.map(|index| findings.remove(index)).is_some()
}

/// Keeps a record within the runtime's section ([`HAND_BACK_SECTION_MAX_CHARS`]),
/// which an older runtime leaves out whole when it is over: whole lines, in
/// order, the reply's last lines left out first and then the last findings
/// ([`leave_out_a_finding`]), saying how many findings were left out
/// (`findingsLeftOut`) and that the reply was cut (`replyTruncated`). A page
/// read always stays, and so does the reply's first line, cut only when it
/// alone is over.
fn fit_the_section(record: &mut JsonValue) {
    let mut left_out = record
        .get("findingsLeftOut")
        .and_then(JsonValue::as_u64)
        .unwrap_or(0);
    loop {
        let over = quoted_chars(record).saturating_sub(HAND_BACK_SECTION_MAX_CHARS);
        if over == 0 {
            return;
        }
        let reply = record["reply"]
            .as_str()
            .unwrap_or_default()
            .trim_end()
            .to_string();
        if let Some((kept, _)) = reply.rsplit_once('\n') {
            record["reply"] = json!(kept.trim_end());
            record["replyTruncated"] = json!(true);
        } else if record["findings"]
            .as_array_mut()
            .is_some_and(leave_out_a_finding)
        {
            left_out += 1;
            record["findingsLeftOut"] = json!(left_out);
        } else if !reply.is_empty() {
            let keep = reply.chars().count().saturating_sub(over);
            record["reply"] = json!(reply.chars().take(keep).collect::<String>());
            record["replyTruncated"] = json!(true);
        } else {
            return;
        }
    }
}

/// The browser turn's reply with the finding lines the runtime moved into its
/// Details note put back after it, as the browser turn wrote them for Octo. A
/// reply from an older runtime still holds its lines and has no note.
pub(crate) fn reply_with_finding_lines(reply: &str, finding_lines: Option<&str>) -> String {
    match finding_lines
        .map(str::trim)
        .filter(|lines| !lines.is_empty())
    {
        Some(lines) if reply.trim().is_empty() => lines.to_string(),
        Some(lines) => format!("{}\n\n{lines}", reply.trim_end()),
        None => reply.to_string(),
    }
}

/// Whether a checked record names at least one page the browser turn read.
pub(crate) fn record_read_a_page(record: &JsonValue) -> bool {
    record
        .get("findings")
        .and_then(JsonValue::as_array)
        .is_some_and(|findings| {
            findings
                .iter()
                .any(|finding| finding.get("stopped").is_none())
        })
}

/// Who read the pages, from the browser job's own transport.
pub(crate) fn viewer_for_transport(transport: &str) -> Option<&'static str> {
    match transport
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-")
        .as_str()
    {
        "shared" => Some(VIEWER_WORKSPACE),
        "desktop-personal" => Some(VIEWER_DEVICE),
        _ => None,
    }
}

/// What a browser turn was asked, as the building turn reads it: its prompt,
/// bounded, with a Let Octo continue press as one line.
pub(crate) fn browser_request_for_building(prompt: &str) -> String {
    let prompt = prompt.replace('\0', "");
    let prompt = prompt.trim();
    if prompt == LET_OCTO_CONTINUE_PROMPT {
        return LET_OCTO_CONTINUE_LINE.to_string();
    }
    prompt.chars().take(REQUEST_MAX_CHARS).collect()
}

/// A finding labelled with when and in which browser its page was read.
fn labelled(finding: &Finding, viewer: &str, read_at: &str) -> JsonValue {
    let mut labelled = json!({
        "url": finding.url,
        "title": finding.title,
        "readAt": read_at,
        "viewer": viewer,
    });
    if let Some(reason) = finding.stopped {
        labelled["stopped"] = json!(reason);
    }
    labelled
}

/// A listed browser turn's findings, labelled: its reply holds their facts.
fn labelled_findings(reply: &str, viewer: &str, read_at: &str) -> Vec<JsonValue> {
    findings_from_reply(reply)
        .iter()
        .map(|finding| labelled(finding, viewer, read_at))
        .collect()
}

/// The checked record a building turn carries as `metadata.browserHandBack`.
/// `request` is what the browser turn was asked: the building thread may never
/// have seen it. `person_request` is the words of a message the routing step
/// sent straight to the browser, from that message's own job: the person's
/// request, which the building thread never saw. `reply` is the browser
/// turn's: every finding line in it goes, labelled and with its facts, and of
/// its own words only what [`words_for_the_building_turn`] keeps, all within
/// the runtime's section ([`fit_the_section`]).
pub(crate) fn hand_back_record(
    browser_job_id: &Uuid,
    card_job_id: &Uuid,
    viewer: &str,
    read_at: DateTime<Utc>,
    request: &str,
    person_request: Option<&str>,
    reply: &str,
) -> JsonValue {
    let read_at = read_at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let reply = reply.replace('\0', "");
    let findings = findings_from_reply(&reply);
    let (words, reply_truncated) =
        reply_that_can_fit(&words_for_the_building_turn(&reply, &findings));
    let (findings, findings_left_out) = findings_that_can_fit(findings);
    let findings: Vec<JsonValue> = findings
        .iter()
        .map(|finding| {
            let mut value = labelled(finding, viewer, &read_at);
            if !finding.facts.is_empty() {
                value["facts"] = json!(finding.facts);
            }
            if finding.facts_left_out > 0 {
                value["factsLeftOut"] = json!(finding.facts_left_out);
            }
            value
        })
        .collect();
    let mut record = json!({
        "version": HAND_BACK_VERSION,
        "verified": true,
        "browserJobId": browser_job_id.to_string(),
        "cardJobId": card_job_id.to_string(),
        "viewer": viewer,
        "readAt": read_at,
        "request": browser_request_for_building(request),
        "findings": findings,
        "reply": words,
        "replyTruncated": reply_truncated,
    });
    if findings_left_out > 0 {
        record["findingsLeftOut"] = json!(findings_left_out);
    }
    let person_request = person_request
        .map(|words| words.replace('\0', ""))
        .map(|words| {
            words
                .trim()
                .chars()
                .take(PERSON_REQUEST_MAX_CHARS)
                .collect::<String>()
        })
        .filter(|words| !words.is_empty());
    if let Some(words) = person_request {
        record["personRequest"] = json!(words);
    }
    fit_the_section(&mut record);
    record
}

/// The copy the stored message keeps: which browser turn it continues, not
/// the reply (the browser turn's own message already shows that).
pub(crate) fn hand_back_for_message(record: &JsonValue) -> JsonValue {
    let mut copy = serde_json::Map::new();
    for key in ["version", "browserJobId", "cardJobId", "viewer", "readAt"] {
        if let Some(value) = record.get(key) {
            copy.insert(key.to_string(), value.clone());
        }
    }
    copy.insert(
        "findingCount".to_string(),
        json!(record
            .get("findings")
            .and_then(JsonValue::as_array)
            .map_or(0, Vec::len)),
    );
    JsonValue::Object(copy)
}

/// The card job a browser turn continued: `browserRequestOf: "job:<uuid>"`.
fn card_job_of(metadata: &JsonValue) -> Option<Uuid> {
    let raw = metadata
        .get("browserRequestOf")
        .or_else(|| metadata.get("browser_request_of"))?
        .as_str()?;
    Uuid::parse_str(raw.trim().strip_prefix("job:")?.trim()).ok()
}

pub(crate) fn browser_transport_of(metadata: &JsonValue) -> Option<&str> {
    metadata
        .get("browserTransport")
        .or_else(|| metadata.get("browser_transport"))
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn hand_back_refused(
    status: StatusCode,
    code: &str,
    message: &str,
) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError::with_details(message, code, json!({}))),
    )
}

fn not_a_card_browser_turn() -> (StatusCode, Json<ApiError>) {
    bad_request(
        "That browser turn did not continue a request from Octo, so there is nothing to hand back.",
    )
}

/// A hand-back [`require_hand_back`] let through: the record to stamp, and
/// the turn it carries on.
pub(crate) struct CheckedHandBack {
    pub(crate) record: JsonValue,
    pub(crate) continues: ContinuedTurn,
}

/// The turn a hand-back carries on: the one whose card its browser turn
/// continued. The hand-back resumes that turn's building lane, so it goes to
/// that turn's agent alone, and writes no more than that turn could.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ContinuedTurn {
    /// The agent that answered the turn.
    agent_handle: Option<String>,
    /// The turn could write the space's files.
    may_write: bool,
    /// The paths it could write, when only some (`owned`).
    owned_scope: Option<JsonValue>,
}

impl ContinuedTurn {
    fn of(card_payload: &JsonValue) -> Self {
        let metadata = card_payload.get("metadata");
        let agent_handle = metadata
            .and_then(|metadata| metadata.get("agent"))
            .and_then(|agent| agent.get("handle"))
            .and_then(JsonValue::as_str)
            .map(|handle| handle.trim().trim_start_matches('@').to_ascii_lowercase())
            .filter(|handle| !handle.is_empty());
        let owned_scope = metadata
            .and_then(|metadata| {
                metadata
                    .get("writeScope")
                    .or_else(|| metadata.get("write_scope"))
            })
            .filter(|scope| {
                scope.get("mode").and_then(JsonValue::as_str).map(str::trim) == Some("owned")
            })
            .cloned();
        Self {
            agent_handle,
            may_write: crate::origins::job_allows_workspace_mutation(card_payload),
            owned_scope,
        }
    }

    /// Makes a hand-back's send `metadata` the continued turn's: it names that
    /// turn's agent alone, has no write intent when that turn could not write,
    /// and has no write scope of its own, only that turn's owned paths.
    pub(crate) fn bind(&self, metadata: &mut JsonMap<String, JsonValue>) {
        if let Some(handle) = self.agent_handle.as_deref() {
            metadata.insert(
                "agentSelection".to_string(),
                json!({ "active": [handle], "mentions": [handle] }),
            );
        }
        if !self.may_write {
            metadata.insert("writeIntent".to_string(), JsonValue::Bool(false));
            metadata.remove("write_intent");
        }
        for key in [
            "writeScope",
            "write_scope",
            "agentWriteScopes",
            "agent_write_scopes",
            "writeScopes",
            "write_scopes",
        ] {
            metadata.remove(key);
        }
        if let Some(scope) = self.owned_scope.as_ref() {
            metadata.insert("writeScope".to_string(), scope.clone());
        }
    }
}

/// Checks a hand-back claim for a dispatch into `conversation_id` and returns
/// the record to stamp, with the turn the hand-back carries on. Runs inside the
/// dispatch transaction, after the conversation's dispatch fence, so two
/// hand-backs for one browser turn cannot both pass the once-only check.
pub(crate) async fn require_hand_back(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    context: &RequestContext,
    claim: &JsonValue,
    request_metadata: &JsonValue,
) -> Result<CheckedHandBack, (StatusCode, Json<ApiError>)> {
    let browser_job_id = parse_hand_back_claim(claim)
        .ok_or_else(|| bad_request("continuesFromBrowserJob must name one browser job"))?;
    if browser_transport_of(request_metadata).is_some() {
        return Err(bad_request(
            "A hand-back continues the building turn, so it cannot also ask for a browser.",
        ));
    }
    // Nor does it bring anything of the person's: what it asks is the
    // controller's (HAND_BACK_PROMPT), and it costs nothing unless it ends
    // with a reply (crate::system_turns).
    if crate::system_turns::carries_attachments(request_metadata) {
        return Err(bad_request(
            "A hand-back continues the building turn with what the browser found, so it cannot carry attachments.",
        ));
    }
    // Words for one agent would take the place of Studio's (dispatch's
    // `apply_agent_prompt_segment`).
    if crate::system_turns::carries_prompt_segments(request_metadata) {
        return Err(bad_request(
            "A hand-back continues the building turn with what the browser found, so it cannot carry words of its own.",
        ));
    }
    let user_id = match context.user_id {
        Some(user_id) if !context.is_service_role => user_id,
        _ => {
            return Err(forbidden(
                "Only the person who ran the browser turn can hand its findings back.",
            ))
        }
    };

    let browser_job = transaction
        .query_opt(
            "select job.run_id, job.status, job.outcome, job.summary, job.payload,
                    job.completed_at, job.prompt_id, prompt.user_id as sender,
                    prompt.created_at as sent_at
               from agent_jobs job
               left join prompts prompt on prompt.id = job.prompt_id
              where job.id = $1 and job.conversation_id = $2",
            &[&browser_job_id, conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load browser turn: {error}")))?
        .ok_or_else(not_a_card_browser_turn)?;
    let payload = browser_job.get::<_, PgJson<JsonValue>>("payload").0;
    let metadata = payload.get("metadata").cloned().unwrap_or(JsonValue::Null);
    let viewer = browser_transport_of(&metadata)
        .and_then(viewer_for_transport)
        .ok_or_else(not_a_card_browser_turn)?;
    let card_job_id = card_job_of(&metadata).ok_or_else(not_a_card_browser_turn)?;
    // The browser turn's prompt records who sent it; metadata could be anyone's words.
    if browser_job.get::<_, Option<Uuid>>("sender") != Some(user_id) {
        return Err(forbidden(
            "Only the person who ran the browser turn can hand its findings back.",
        ));
    }
    let status = browser_job.get::<_, String>("status");
    let outcome = browser_job.get::<_, Option<String>>("outcome");
    let completed_at = browser_job.get::<_, Option<DateTime<Utc>>>("completed_at");
    let Some(completed_at) =
        completed_at.filter(|_| status == "completed" && outcome.as_deref() == Some("succeeded"))
    else {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            "browser_hand_back_not_finished",
            "That browser turn has not finished, or did not finish, so there is nothing to hand back yet.",
        ));
    };
    if Utc::now() - completed_at > chrono::Duration::minutes(HAND_BACK_WINDOW_MINUTES) {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            "browser_hand_back_stale",
            "That browser turn finished too long ago to hand back. Ask Octo to continue instead.",
        ));
    }

    // A browser turn that stopped for the person (a manual step, or a step
    // its approval lane ended) did not finish the task: the person continues
    // it in the browser, and nothing goes back to the building turn.
    let run_id = browser_job.get::<_, Option<Uuid>>("run_id");
    if paused_for_person(transaction, conversation_id, &browser_job_id, run_id).await? {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            HAND_BACK_PAUSED_CODE,
            "That browser turn stopped for a step of yours. Finish it in the browser and choose Let Octo continue.",
        ));
    }

    // One hop: the card the browser continued must come from an ordinary
    // turn, never from a turn that was itself a hand-back.
    let card_job = transaction
        .query_opt(
            "select job.payload, prompt.user_id as sender
               from agent_jobs job
               left join prompts prompt on prompt.id = job.prompt_id
              where job.id = $1 and job.conversation_id = $2",
            &[&card_job_id, conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the card's turn: {error}")))?
        .ok_or_else(not_a_card_browser_turn)?;
    // The building turn resumes the person's own request: the card must come
    // from a turn they sent, not a teammate's.
    if card_job.get::<_, Option<Uuid>>("sender") != Some(user_id) {
        return Err(forbidden(
            "Only the person whose request sent the card can hand the browser's findings back to it.",
        ));
    }
    let card_payload = card_job.get::<_, PgJson<JsonValue>>("payload").0;
    let card_metadata = card_payload
        .get("metadata")
        .cloned()
        .unwrap_or(JsonValue::Null);
    if browser_transport_of(&card_metadata).is_some() {
        return Err(not_a_card_browser_turn());
    }
    if HAND_BACK_ALIASES
        .iter()
        .any(|key| card_metadata.get(*key).is_some())
    {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            HAND_BACK_SECOND_HOP_CODE,
            "Octo already continued once from the browser in this chain. Open the browser from Octo's message to keep going.",
        ));
    }
    // A browser turn that asked Octo to make the person's message hands it
    // back only from a card the routing step posted for that message.
    let build_request =
        browser_turn_requested_a_build(transaction, conversation_id, &browser_job_id).await?;
    let routed_card =
        job_posted_routed_browser_card(transaction, conversation_id, &card_job_id).await?;
    // Only a card that continues building something hands back: a question's
    // browser turn already answered it. The card is the runtime's own message
    // for that job, which says so (runtime-agent `browser_request.rs`).
    let builds = if build_request {
        routed_card
    } else {
        card_continues_building(transaction, conversation_id, &card_job_id).await?
    };
    if !builds {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            HAND_BACK_NOT_BUILDING_CODE,
            "The browser turn answered that request itself, so nothing goes back to Octo.",
        ));
    }

    let used = transaction
        .query_one(
            "select exists (
                 select 1 from agent_jobs
                  where conversation_id = $1
                    and payload #>> '{metadata,browserHandBack,browserJobId}' = $2
                    and status not in ('failed', 'canceled', 'expired')
             )",
            &[conversation_id, &browser_job_id.to_string()],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check earlier hand-backs: {error}")))?
        .get::<_, bool>(0);
    if used {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            HAND_BACK_USED_CODE,
            "Octo already continued from this browser turn.",
        ));
    }

    // Nobody wrote after the browser turn: a prompt sent in this conversation
    // since (the person's own next message, a teammate's, or a turn queued
    // behind it) comes first, and the findings never jump ahead of it. An
    // earlier hand-back of this browser turn that failed, was stopped or
    // expired is not someone writing, as it does not count as Octo having
    // continued above: Try again on it sends this hand-back again.
    let browser_prompt_id = browser_job.get::<_, Option<Uuid>>("prompt_id");
    let browser_sent_at = browser_job.get::<_, Option<DateTime<Utc>>>("sent_at");
    let written_after = transaction
        .query_one(
            "select exists (
                 select 1 from prompts prompt
                  where prompt.conversation_id = $1
                    and prompt.created_at > $2
                    and prompt.id is distinct from $3
                    and not exists (
                        select 1 from agent_jobs hand_back
                         where hand_back.conversation_id = $1
                           and hand_back.prompt_id = prompt.id
                           and hand_back.payload #>> '{metadata,browserHandBack,browserJobId}' = $4
                           and hand_back.status in ('failed', 'canceled', 'expired')
                    )
             )",
            &[
                conversation_id,
                &browser_sent_at,
                &browser_prompt_id,
                &browser_job_id.to_string(),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check later messages: {error}")))?
        .get::<_, bool>(0);
    if written_after {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            HAND_BACK_SUPERSEDED_CODE,
            "Someone wrote after that browser turn, so its findings are not handed back. Ask Octo to continue instead.",
        ));
    }

    let request = payload
        .get("prompt_text")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    // The message asked for something the browser turn cannot make: its words
    // go to the building turn, and nothing of the browser turn, which opened
    // no page and posted no reply.
    if build_request {
        let person_request = card_payload.get("prompt_text").and_then(JsonValue::as_str);
        let mut record = hand_back_record(
            &browser_job_id,
            &card_job_id,
            viewer,
            completed_at,
            request,
            person_request,
            "",
        );
        if record.get("personRequest").is_none() {
            return Err(hand_back_refused(
                StatusCode::CONFLICT,
                "browser_hand_back_empty",
                "That browser turn returned nothing to hand back.",
            ));
        }
        record[BUILD_REQUEST_RECORD_KEY] = json!(true);
        return Ok(CheckedHandBack {
            record,
            continues: ContinuedTurn::of(&card_payload),
        });
    }

    let reply = browser_turn_reply(
        transaction,
        conversation_id,
        &browser_job_id,
        run_id,
        browser_job.get::<_, Option<String>>("summary"),
    )
    .await?;
    if reply.trim().is_empty() {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            "browser_hand_back_empty",
            "That browser turn returned nothing to hand back.",
        ));
    }

    // A card the routing step posted for the person's own message: the
    // building thread never saw that message (its job ran no model turn), so
    // the record gives the build its words, from the message's own job, as the
    // person's request.
    let person_request = if routed_card {
        card_payload.get("prompt_text").and_then(JsonValue::as_str)
    } else {
        None
    };
    let record = hand_back_record(
        &browser_job_id,
        &card_job_id,
        viewer,
        completed_at,
        request,
        person_request,
        &reply,
    );
    // A browser turn that read no page leaves the building turn nothing to
    // continue with; its own reply already says what stopped it.
    if !record_read_a_page(&record) {
        return Err(hand_back_refused(
            StatusCode::CONFLICT,
            HAND_BACK_NOTHING_READ_CODE,
            "That browser turn read no page, so there is nothing to hand back.",
        ));
    }
    Ok(CheckedHandBack {
        record,
        continues: ContinuedTurn::of(&card_payload),
    })
}

/// Whether the card a browser turn continued says Octo continues building
/// from what the browser finds: the runtime's `action_request` message for
/// that job carries `browserRequest.continueBuilding`.
async fn card_continues_building(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    card_job_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            "select exists (
                 select 1 from conversation_messages
                  where conversation_id = $1
                    and role = 'assistant'
                    and created_by is null
                    and metadata #>> '{jobId}' = $2
                    and lower(coalesce(metadata #>> '{messageType}', metadata #>> '{message_type}', ''))
                        = 'action_request'
                    and (metadata #> '{details,browserRequest,continueBuilding}' = 'true'::jsonb
                         or metadata #> '{details,details,browserRequest,continueBuilding}' = 'true'::jsonb)
             )",
            &[conversation_id, &card_job_id.to_string()],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| internal_error(format!("failed to read the browser card: {error}")))
}

/// Sends the hand-back of a message the routing step sent straight to the
/// browser, once its browser turn `browser_job_id` (whose payload is
/// `job_payload`) has finished successfully and its completion is committed:
/// that turn carried on a routed card and, having opened no page, asked Octo
/// to make what the message asks ([`BUILD_REQUEST_NOTE_KEY`]). It goes out in
/// the name of the person who sent the browser turn, to the agent that
/// answered their message, as Studio sends any other hand-back: Studio's
/// words, the claim, and no attachments, browser or words of the person's
/// own; dispatch checks it with [`require_hand_back`] and charges it as any
/// hand-back. Like every send of Studio's, it says the turn may write the
/// space's files (`writeIntent`), so its job is given the token that saves
/// them when the message's own turn could write them ([`ContinuedTurn`]).
/// Every other completion returns at once.
///
/// A refusal for a conversation that moved on (someone wrote after the
/// browser turn, or the building lane is busy) changes nothing: the newer
/// turn answers. Any other refusal (no prompts or credits left, say) leaves
/// its plain reason as the browser turn's reply, so the person's message is
/// never left with no answer at all.
pub(crate) async fn hand_back_build_request(
    state: &crate::AppState,
    project_id: &Uuid,
    conversation_id: &Uuid,
    browser_job_id: &Uuid,
    job_payload: &JsonValue,
) {
    let metadata = job_payload.get("metadata").unwrap_or(&JsonValue::Null);
    let routed = metadata
        .get(crate::system_turns::BROWSER_CARD_TURN_KEY)
        .and_then(|stamp| stamp.get("routed"))
        == Some(&JsonValue::Bool(true));
    if !routed || browser_transport_of(metadata).is_none() {
        return;
    }
    let Some(card_job_id) = card_job_of(metadata) else {
        return;
    };
    let turn = match build_request_turn(state, conversation_id, browser_job_id, &card_job_id).await
    {
        Ok(Some(turn)) => turn,
        Ok(None) => return,
        Err((_, Json(error))) => {
            warn!(
                job_id = %browser_job_id,
                error = %error.message,
                "could not read how a routed browser turn ended"
            );
            return;
        }
    };
    let notice = format!(
        "{} {BUILD_REQUEST_NOTICE_SUFFIX}",
        turn.agent_name.as_deref().unwrap_or("Octo")
    );
    let request = crate::dispatch::normalize_dispatch_request(
        crate::dispatch::DispatchPromptRequest {
            project_id: Some(project_id.to_string()),
            session_id: turn.session_id.map(|id| id.to_string()),
            prompt_text: Some(HAND_BACK_PROMPT.to_string()),
            intent: Some("feature".to_string()),
            plan_seed: None,
            metadata: Some(json!({
                HAND_BACK_CLAIM_KEY: browser_job_id.to_string(),
                // One send per browser turn: dispatch answers a second with the first.
                "clientMessageId": format!("browser-build-request:{browser_job_id}"),
                "displayContent": notice,
                "agentSelection": { "active": [turn.agent_handle], "mentions": [turn.agent_handle] },
                // It builds what the message asks, so it writes and saves the
                // space's files, as Studio's own sends say they may: without
                // this its job gets no write token, and its save is refused
                // after the turn made the files. Dispatch gives it no more than
                // the message's own turn had (`ContinuedTurn::bind`).
                "writeIntent": true,
            })),
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: Some(conversation_id.to_string()),
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        },
    );
    let result = match request {
        Ok(mut request) => {
            request.conversation_is_new = false;
            // It resumes an idle building lane or is refused, as Studio's does.
            request.expected_lane_idle = true;
            let person = RequestContext {
                user_id: Some(turn.sender),
                is_service_role: false,
                scoped_claims: None,
            };
            crate::dispatch::process_dispatch_prompt(state, &person, request).await
        }
        Err(error) => Err(error),
    };
    let (status, Json(error)) = match result {
        Ok(_) => {
            info!(
                job_id = %browser_job_id,
                "a routed browser turn asked for a build: the message went to the building turn"
            );
            return;
        }
        Err(refusal) => refusal,
    };
    match reason_left_as_the_reply(status, &error) {
        None => info!(
            job_id = %browser_job_id,
            code = error.code.as_deref().unwrap_or_default(),
            "the build request's hand-back was not sent: the conversation moved on"
        ),
        Some(reason) => {
            warn!(
                job_id = %browser_job_id,
                status = status.as_u16(),
                error = %error.message,
                "the build request's hand-back was refused; its reason is the browser turn's reply"
            );
            leave_the_reason_as_the_reply(
                state,
                project_id,
                conversation_id,
                browser_job_id,
                &turn,
                reason,
            )
            .await;
        }
    }
}

/// What a refused build request hand-back leaves as its browser turn's reply:
/// nothing when the conversation moved on (a conflict: someone wrote after the
/// browser turn, it was handed back already, or the building lane is busy),
/// whose newer turn answers; otherwise the refusal's own words, which a send
/// of the person's would show them too (no prompts or credits left, no AI
/// connection), or a plain line when it has none.
pub(crate) fn reason_left_as_the_reply(status: StatusCode, error: &ApiError) -> Option<String> {
    if status == StatusCode::CONFLICT {
        return None;
    }
    let words = error.message.trim();
    Some(if words.is_empty() || status.is_server_error() {
        "Octo couldn't start on this in the chat. Send it again to try once more.".to_string()
    } else {
        words.to_string()
    })
}

/// What [`hand_back_build_request`] reads about a browser turn that asked Octo
/// to make the person's message.
struct BuildRequestTurn {
    /// Who sent the browser turn, whose own message it carried on.
    sender: Uuid,
    session_id: Option<Uuid>,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    /// The agent that answered the person's message with the routed card.
    agent_handle: String,
    agent_name: Option<String>,
}

/// The browser turn `browser_job_id` and the card turn `card_job_id` it
/// carried on, when the browser turn ended with the runtime's build request
/// note; None for any other.
async fn build_request_turn(
    state: &crate::AppState,
    conversation_id: &Uuid,
    browser_job_id: &Uuid,
    card_job_id: &Uuid,
) -> Result<Option<BuildRequestTurn>, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    if !browser_turn_requested_a_build(&transaction, conversation_id, browser_job_id).await? {
        return Ok(None);
    }
    let row = transaction
        .query_opt(
            "select prompt.user_id as sender, job.run_id, job.prompt_id,
                    job.payload #>> '{session_id}' as session_id,
                    card.payload #>> '{metadata,agent,handle}' as agent_handle,
                    card.payload #>> '{metadata,agent,displayName}' as agent_name
               from agent_jobs job
               join prompts prompt on prompt.id = job.prompt_id
               join agent_jobs card on card.id = $3 and card.conversation_id = job.conversation_id
              where job.id = $1 and job.conversation_id = $2",
            &[browser_job_id, conversation_id, card_job_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the browser turn: {error}")))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let Some(sender) = row.get::<_, Option<Uuid>>("sender") else {
        return Ok(None);
    };
    let agent_handle = row
        .get::<_, Option<String>>("agent_handle")
        .map(|handle| handle.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|handle| !handle.is_empty())
        .unwrap_or_else(|| "octo".to_string());
    Ok(Some(BuildRequestTurn {
        sender,
        session_id: row
            .get::<_, Option<String>>("session_id")
            .and_then(|raw| Uuid::parse_str(raw.trim()).ok()),
        run_id: row.get("run_id"),
        prompt_id: row.get("prompt_id"),
        agent_handle,
        agent_name: row
            .get::<_, Option<String>>("agent_name")
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty()),
    }))
}

/// Leaves `reason`, a refused send's own plain words, as the reply of the
/// browser turn whose hand-back it refused.
async fn leave_the_reason_as_the_reply(
    state: &crate::AppState,
    project_id: &Uuid,
    conversation_id: &Uuid,
    browser_job_id: &Uuid,
    turn: &BuildRequestTurn,
    reason: String,
) {
    let recorded = async {
        let mut connection = state
            .pool
            .get()
            .await
            .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
        let transaction = connection
            .transaction()
            .await
            .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
        let mut metadata = json!({ "jobId": browser_job_id.to_string() });
        if let Some(run_id) = turn.run_id {
            metadata["runId"] = json!(run_id.to_string());
        }
        let message = crate::agent::record_agent_conversation_message(
            &transaction,
            project_id,
            conversation_id,
            turn.session_id,
            turn.prompt_id,
            turn.run_id,
            reason,
            metadata,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to commit the reply: {error}")))?;
        Ok::<_, (StatusCode, Json<ApiError>)>(message)
    }
    .await;
    match recorded {
        Ok(message) => {
            crate::conversations::publish_conversation_message_event(&state.events, &message)
        }
        Err((_, Json(error))) => warn!(
            job_id = %browser_job_id,
            error = %error.message,
            "could not leave the refused hand-back's reason as the reply"
        ),
    }
}

/// Whether a browser turn asked Octo to make the person's message: the
/// runtime's Details note for that job carries [`BUILD_REQUEST_NOTE_KEY`]
/// (runtime-agent `browser_hand_back::build_request_note`).
async fn browser_turn_requested_a_build(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    browser_job_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let sql = format!(
        "select exists (
             select 1 from conversation_messages
              where conversation_id = $1
                and role = 'assistant'
                and created_by is null
                and metadata #>> '{{jobId}}' = $2
                and coalesce(metadata #> '{{details,{BUILD_REQUEST_NOTE_KEY}}}',
                             metadata #> '{{details,details,{BUILD_REQUEST_NOTE_KEY}}}') is not null
         )"
    );
    transaction
        .query_one(
            sql.as_str(),
            &[conversation_id, &browser_job_id.to_string()],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| {
            internal_error(format!(
                "failed to read how the browser turn ended: {error}"
            ))
        })
}

/// Whether a job posted the card of a message the runtime sent straight to
/// Instafy's browser (`browserRequest.routed`): the runtime's own
/// `action_request` message for that job.
pub(crate) async fn job_posted_routed_browser_card(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    job_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            "select exists (
                 select 1 from conversation_messages
                  where conversation_id = $1
                    and role = 'assistant'
                    and created_by is null
                    and metadata #>> '{jobId}' = $2
                    and lower(coalesce(metadata #>> '{messageType}', metadata #>> '{message_type}', ''))
                        = 'action_request'
                    and (metadata #> '{details,browserRequest,routed}' = 'true'::jsonb
                         or metadata #> '{details,details,browserRequest,routed}' = 'true'::jsonb)
             )",
            &[conversation_id, &job_id.to_string()],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| internal_error(format!("failed to read the routed card: {error}")))
}

/// A browser turn's reply as the building turn reads it, with the finding
/// lines its runtime moved into its Details note put back after it
/// ([`reply_with_finding_lines`]). The reply is the turn's completion summary,
/// or, for a turn that streamed its answer instead, its last streamed message.
/// A browser turn whose findings go back to the building turn posts no words
/// of its own (runtime-agent `move_findings_into_details`): with a note and no
/// summary, the note holds its words ahead of its findings and is the whole
/// reply, never a message the turn streamed on its way. Empty when the turn
/// left neither.
async fn browser_turn_reply(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    browser_job_id: &Uuid,
    run_id: Option<Uuid>,
    summary: Option<String>,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let finding_lines = finding_lines_note(transaction, conversation_id, browser_job_id)
        .await?
        .filter(|lines| !lines.trim().is_empty());
    let reply = match (
        summary.filter(|summary| !summary.trim().is_empty()),
        finding_lines.is_some(),
        run_id,
    ) {
        (Some(summary), _, _) => summary,
        (None, true, _) | (None, false, None) => String::new(),
        (None, false, Some(run_id)) => last_streamed_reply(transaction, conversation_id, &run_id)
            .await?
            .unwrap_or_default(),
    };
    Ok(reply_with_finding_lines(&reply, finding_lines.as_deref()))
}

/// The finding lines the runtime moved out of the browser turn's reply into
/// its Details note, if any.
async fn finding_lines_note(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    browser_job_id: &Uuid,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    transaction
        .query_opt(
            "select content
               from conversation_messages
              where conversation_id = $1
                and role = 'assistant'
                and created_by is null
                and metadata #>> '{jobId}' = $2
                and coalesce(metadata #> '{details,browserFindings}',
                             metadata #> '{details,details,browserFindings}') is not null
              order by created_at desc
              limit 1",
            &[conversation_id, &browser_job_id.to_string()],
        )
        .await
        .map(|row| row.map(|row| row.get::<_, String>("content")))
        .map_err(|error| {
            internal_error(format!(
                "failed to read the browser turn's findings: {error}"
            ))
        })
}

/// Whether a browser turn ended on a step that is the person's: it asked for
/// their input on the page (`request_human_input`), or a step's approval
/// ended the turn (the runtime's `browser/terminal-consent` artifact, and the
/// tool call that reported it).
async fn paused_for_person(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    browser_job_id: &Uuid,
    run_id: Option<Uuid>,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            "select exists (
                 select 1 from agent_jobs
                  where id = $1
                    and artifacts @> '[{\"kind\": \"browser/terminal-consent\"}]'::jsonb
             ) or exists (
                 select 1 from conversation_messages
                  where conversation_id = $2
                    and $3::uuid is not null
                    and run_id = $3
                    and role = 'assistant'
                    and lower(coalesce(metadata #>> '{messageType}', metadata #>> '{message_type}', ''))
                        = 'mcp_tool_call'
                    and (
                        (metadata #>> '{details,tool}' = 'request_human_input'
                         and metadata #>> '{details,status}' = 'completed')
                        or metadata #>> '{details,terminalConsent,state}' = 'blocked'
                    )
             )",
            &[browser_job_id, conversation_id, &run_id],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| internal_error(format!("failed to read how the browser turn ended: {error}")))
}

/// The browser turn's last streamed message: the agent speaking, not its tool
/// calls, progress, controller notices or the completion's own fallback line.
async fn last_streamed_reply(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    run_id: &Uuid,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select content
               from conversation_messages
              where conversation_id = $1
                and run_id = $2
                and role = 'assistant'
                and created_by is null
                and nullif(btrim(content), '') is not null
                and metadata #>> '{outcome}' = 'in_progress'
                and metadata #> '{presentation,hidden}' is distinct from 'true'::jsonb
                and metadata #> '{details,presentation,hidden}' is distinct from 'true'::jsonb
                and lower(coalesce(metadata #>> '{messageType}', metadata #>> '{message_type}', ''))
                    not in ('command_execution', 'mcp_tool_call', 'web_search', 'file_change',
                            'status', 'runtime_alert', 'run_cancellation', 'runtime_switch',
                            'agent_job_thread', 'token_usage', 'reasoning', 'learn_router',
                            'todo_list', 'browser_decision', 'error', 'action_request')
                and lower(coalesce(metadata #>> '{kind}', ''))
                    not in ('runtime_alert', 'run_cancellation', 'runtime_switch',
                            'agent_job_thread')
              order by created_at desc
              limit 1",
            &[conversation_id, run_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load the browser turn's reply: {error}"))
        })?;
    Ok(row.map(|row| row.get::<_, String>("content")))
}

/// What a building job's lease lists ([`browser_turns_since`]).
#[derive(Debug, Default, PartialEq)]
pub(crate) struct BrowserTurnsSince {
    /// The browser turns, oldest first: the newest [`TURNS_SINCE_MAX`].
    pub(crate) turns: Vec<JsonValue>,
    /// Older browser turns since the building thread's last turn were left
    /// out to keep the newest; the building turn is told so
    /// ([`TURNS_SINCE_LEFT_OUT_KEY`]).
    pub(crate) earlier_left_out: bool,
}

/// The hand-back's keys on the lease of a conversation's job: the browser
/// turns its building thread has not read yet ([`browser_turns_since`]),
/// whether older ones were left out, and that this controller reads the note
/// of a browser turn that posted no words as its reply ([`READS_NOTE_KEY`]).
/// Every lease sets them, so no copy a client sent can survive.
pub(crate) fn stamp_lease(
    payload: &mut serde_json::Map<String, JsonValue>,
    turns_since: BrowserTurnsSince,
) {
    payload.insert(
        TURNS_SINCE_KEY.to_string(),
        JsonValue::Array(turns_since.turns),
    );
    payload.insert(
        TURNS_SINCE_LEFT_OUT_KEY.to_string(),
        JsonValue::Bool(turns_since.earlier_left_out),
    );
    payload.insert(READS_NOTE_KEY.to_string(), JsonValue::Bool(true));
}

/// The browser turns of a conversation since its building thread's last
/// turn, for a building job's lease: what each was asked, its reply with the
/// findings its runtime moved into Details put back ([`bounded_reply`]), and
/// those findings labelled as the hand-back's record labels them, oldest
/// first.
///
/// The building thread's last turn is the newest other job of the
/// conversation that is not a browser turn and saved a provider state, in the
/// credential and agent scope `dispatch::load_provider_conversation_state_for_job`
/// resumes from, so it names the thread the leased job resumes. The browser
/// turns are the conversation's finished Shared and Personal Browser jobs of
/// the same agent created after it (all of them when there is none), the
/// newest [`TURNS_SINCE_MAX`], and whether older ones were left out. Never
/// another conversation's or agent's, never one still running, and never the
/// browser turn this job's checked hand-back already carries. A browser job's
/// own lease lists none: its thread holds its browser turns.
pub(crate) async fn browser_turns_since(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    job_id: &Uuid,
    payload: &JsonValue,
    credential_id: Option<&Uuid>,
    agent_id: Option<&Uuid>,
    agent_handle: Option<&str>,
) -> Result<BrowserTurnsSince, (StatusCode, Json<ApiError>)> {
    let metadata = payload.get("metadata").cloned().unwrap_or(JsonValue::Null);
    if browser_transport_of(&metadata).is_some() {
        return Ok(BrowserTurnsSince::default());
    }
    let handed_back = metadata
        .get(HAND_BACK_KEY)
        .filter(|record| record.get("verified") == Some(&JsonValue::Bool(true)))
        .and_then(|record| record.get("browserJobId"))
        .and_then(JsonValue::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok());
    let agent_handle = agent_handle
        .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    // A job on a connection of its own matches it exactly; a managed job only
    // through its platform record, which a deleted connection also leaves
    // without one (`dispatch::load_provider_conversation_state_for_job`). A
    // job with a connection never reads the platform records.
    let credential_clause = if credential_id.is_some() {
        "j.credential_id = $3::uuid"
    } else {
        "($3::uuid is null and j.credential_id is null
          and exists (
              select 1 from ai_usage_jobs u
               where u.job_id = j.id
                 and u.project_id = j.project_id
                 and u.run_id = j.run_id
          ))"
    };
    let anchor = transaction
        .query_opt(
            &format!(
                "select r.created_at
                   from runs r
                   join agent_jobs j on j.run_id = r.id
                     and j.project_id = r.project_id
                     and j.conversation_id = r.conversation_id
                  where r.conversation_id = $1
                    and j.id <> $2
                    and j.proxy_metadata->'conversation' is not null
                    and j.proxy_metadata->'conversation' <> 'null'::jsonb
                    and coalesce(j.payload #>> '{{metadata,browserTransport}}',
                                 j.payload #>> '{{metadata,browser_transport}}', '') = ''
                    and (r.metadata->>'jobId' is null or r.metadata->>'jobId' = j.id::text)
                    and {credential_clause}
                    and case
                        when $4::uuid is not null and r.metadata #>> '{{agent,id}}' is not null
                            then r.metadata #>> '{{agent,id}}' = $4::text
                        when $5::text is not null
                            then lower(ltrim(btrim(r.metadata #>> '{{agent,handle}}'), '@')) = $5
                        else $4::uuid is null
                    end
                  order by r.created_at desc, r.id desc, j.id desc
                  limit 1"
            ),
            &[
                conversation_id,
                job_id,
                &credential_id,
                &agent_id,
                &agent_handle,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to find the building thread's last turn: {error}"
            ))
        })?
        .map(|row| row.get::<_, DateTime<Utc>>("created_at"));
    let rows = transaction
        .query(
            "select j.id, j.run_id, j.outcome, j.summary, j.payload, j.completed_at,
                    r.created_at as run_created_at
               from runs r
               join agent_jobs j on j.run_id = r.id
                 and j.project_id = r.project_id
                 and j.conversation_id = r.conversation_id
              where r.conversation_id = $1
                and j.id <> $2
                and j.status = 'completed'
                and j.completed_at is not null
                and lower(replace(coalesce(j.payload #>> '{metadata,browserTransport}',
                                           j.payload #>> '{metadata,browser_transport}', ''),
                                  '_', '-')) in ('shared', 'desktop-personal')
                and ($3::timestamptz is null or r.created_at > $3)
                and ($4::uuid is null or j.id <> $4)
                and case
                    when $5::uuid is not null and r.metadata #>> '{agent,id}' is not null
                        then r.metadata #>> '{agent,id}' = $5::text
                    when $6::text is not null
                        then lower(ltrim(btrim(r.metadata #>> '{agent,handle}'), '@')) = $6
                    else $5::uuid is null
                end
              order by r.created_at desc, r.id desc, j.id desc
              limit $7",
            &[
                conversation_id,
                job_id,
                &anchor,
                &handed_back,
                &agent_id,
                &agent_handle,
                // One more than are kept, to know whether any were left out.
                &(TURNS_SINCE_MAX + 1),
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to list the browser turns since the building thread's last turn: {error}"
            ))
        })?;
    // A message the runtime sent straight to the browser whose card no
    // browser turn carried on: the building thread never saw it, and the
    // person may now ask for it without the browser.
    let unopened = transaction
        .query(
            "select j.id, j.payload, r.created_at
               from runs r
               join agent_jobs j on j.run_id = r.id
                 and j.project_id = r.project_id
                 and j.conversation_id = r.conversation_id
              where r.conversation_id = $1
                and j.id <> $2
                and j.status = 'completed'
                and ($3::timestamptz is null or r.created_at > $3)
                and exists (
                    select 1 from conversation_messages card
                     where card.conversation_id = $1
                       and card.role = 'assistant'
                       and card.created_by is null
                       and card.metadata #>> '{jobId}' = j.id::text
                       and (card.metadata #> '{details,browserRequest,routed}' = 'true'::jsonb
                            or card.metadata #> '{details,details,browserRequest,routed}' = 'true'::jsonb))
                and not exists (
                    select 1 from agent_jobs browser_job
                     where browser_job.conversation_id = $1
                       and browser_job.payload #>> '{metadata,browserRequestOf}' = 'job:' || j.id::text)
                and case
                    when $4::uuid is not null and r.metadata #>> '{agent,id}' is not null
                        then r.metadata #>> '{agent,id}' = $4::text
                    when $5::text is not null
                        then lower(ltrim(btrim(r.metadata #>> '{agent,handle}'), '@')) = $5
                    else $4::uuid is null
                end
              order by r.created_at desc, r.id desc, j.id desc
              limit $6",
            &[
                conversation_id,
                job_id,
                &anchor,
                &agent_id,
                &agent_handle,
                // One more than are kept, to know whether any were left out.
                &(TURNS_SINCE_MAX + 1),
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to list the messages sent straight to the browser: {error}"
            ))
        })?;
    let mut listed: Vec<(DateTime<Utc>, JsonValue)> = unopened
        .into_iter()
        .map(|row| {
            let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
            let request = payload
                .get("prompt_text")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            (
                row.get::<_, DateTime<Utc>>("created_at"),
                json!({
                    "routedJobId": row.get::<_, Uuid>("id").to_string(),
                    "request": browser_request_for_building(request),
                    "routedNotOpened": true,
                }),
            )
        })
        .collect();
    for row in rows.into_iter().rev() {
        let browser_job_id: Uuid = row.get("id");
        let run_id: Option<Uuid> = row.get("run_id");
        let browser_payload = row.get::<_, PgJson<JsonValue>>("payload").0;
        let browser_metadata = browser_payload
            .get("metadata")
            .cloned()
            .unwrap_or(JsonValue::Null);
        let Some(viewer) = browser_transport_of(&browser_metadata).and_then(viewer_for_transport)
        else {
            continue;
        };
        let completed_at: DateTime<Utc> = row.get("completed_at");
        let read_at = completed_at.to_rfc3339_opts(SecondsFormat::Secs, true);
        let reply = browser_turn_reply(
            transaction,
            conversation_id,
            &browser_job_id,
            run_id,
            row.get::<_, Option<String>>("summary"),
        )
        .await?;
        let (reply, truncated) = bounded_reply(&reply);
        let request = browser_payload
            .get("prompt_text")
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        listed.push((
            row.get::<_, DateTime<Utc>>("run_created_at"),
            json!({
                "browserJobId": browser_job_id.to_string(),
                "request": browser_request_for_building(request),
                "reply": reply,
                "replyTruncated": truncated,
                "findings": labelled_findings(&reply, viewer, &read_at),
                "readAt": read_at,
                "viewer": viewer,
                "outcome": row.get::<_, Option<String>>("outcome"),
            }),
        ));
    }
    // Oldest first, the newest TURNS_SINCE_MAX of both kinds. Each query
    // read one more than are kept, so a longer list means some were left out.
    listed.sort_by_key(|(created_at, _)| *created_at);
    let keep_from = listed.len().saturating_sub(TURNS_SINCE_MAX as usize);
    Ok(BrowserTurnsSince {
        turns: listed
            .into_iter()
            .skip(keep_from)
            .map(|(_, turn)| turn)
            .collect(),
        earlier_left_out: keep_from > 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> JsonValue {
        serde_json::from_str(include_str!("browser_hand_back_fixtures.json")).expect("fixtures")
    }

    // Studio's test pins its prompt to the same fixture.
    #[test]
    fn a_hand_back_asks_what_studio_sends() {
        assert_eq!(json!(HAND_BACK_PROMPT), fixtures()["handBackPrompt"]);
    }

    /// A build request hand-back the conversation moved past leaves nothing:
    /// the newer turn answers. One refused for anything else leaves its own
    /// plain words as the browser turn's reply, or a plain line for an error
    /// of the controller's own, so the person's message never goes without an
    /// answer.
    #[test]
    fn a_refused_build_request_leaves_its_reason_unless_the_chat_moved_on() {
        let error = |message: &str, code: &str| ApiError {
            message: message.to_string(),
            code: Some(code.to_string()),
            details: None,
        };
        assert_eq!(
            reason_left_as_the_reply(
                StatusCode::CONFLICT,
                &error(
                    "Someone wrote after that browser turn.",
                    HAND_BACK_SUPERSEDED_CODE
                )
            ),
            None
        );
        let limit = "Connect your own AI to continue. You have used all 20 Instafy AI prompts available today.";
        assert_eq!(
            reason_left_as_the_reply(StatusCode::BAD_REQUEST, &error(limit, "bad_request"))
                .as_deref(),
            Some(limit)
        );
        for status in [StatusCode::INTERNAL_SERVER_ERROR, StatusCode::BAD_REQUEST] {
            let message = if status.is_server_error() {
                "failed to load browser turn: db"
            } else {
                " "
            };
            let reason =
                reason_left_as_the_reply(status, &error(message, "internal")).expect("a reason");
            assert_eq!(
                reason,
                "Octo couldn't start on this in the chat. Send it again to try once more."
            );
        }
    }

    /// The note a browser turn that asked Octo to make the person's message
    /// ends with, and the record of its hand-back, go by the names the runtime
    /// and Studio use.
    #[test]
    fn the_build_request_goes_by_the_runtimes_and_studios_names() {
        let fixtures = fixtures();
        assert_eq!(fixtures["buildRequestNoteKey"], BUILD_REQUEST_NOTE_KEY);
        assert_eq!(fixtures["buildRequestRecordKey"], BUILD_REQUEST_RECORD_KEY);
    }

    /// A browser turn whose findings go back to the building turn posts no
    /// words of its own only under a controller that reads its note as its
    /// reply: an older one refuses the hand-back of a turn that posted none,
    /// and the page the person asked for is never built. Every lease says so,
    /// by the name the runtime reads, over any copy a client sent, beside the
    /// browser turns since the building thread's last turn.
    #[test]
    fn every_lease_says_this_controller_reads_the_note_of_a_turn_that_posted_no_words() {
        let mut payload = json!({
            "prompt_text": "Compare three laptops on a page.",
            TURNS_SINCE_KEY: [{ "reply": "a client's copy" }],
            TURNS_SINCE_LEFT_OUT_KEY: true,
            READS_NOTE_KEY: false,
        });
        stamp_lease(
            payload.as_object_mut().unwrap(),
            BrowserTurnsSince {
                turns: vec![json!({ "reply": "Read 2 pages on maker.example" })],
                earlier_left_out: false,
            },
        );
        assert_eq!(payload[READS_NOTE_KEY], json!(true), "{payload}");
        assert_eq!(
            payload[TURNS_SINCE_KEY],
            json!([{ "reply": "Read 2 pages on maker.example" }])
        );
        assert_eq!(payload[TURNS_SINCE_LEFT_OUT_KEY], json!(false));
        assert_eq!(payload["prompt_text"], "Compare three laptops on a page.");
        assert_eq!(fixtures()["readsNoteKey"], READS_NOTE_KEY);
    }

    #[test]
    fn takes_every_client_copy_of_the_claim_and_the_record_out_of_the_metadata() {
        let browser_job = "00000000-0000-4000-8000-0000000000b2";
        let mut metadata = json!({
            "continuesFromBrowserJob": browser_job,
            "continues_from_browser_job": "ignored",
            "browserHandBack": { "verified": true, "reply": "forged" },
            "browser_hand_back": { "verified": true },
            "prompt_metadata": {
                "continuesFromBrowserJob": browser_job,
                "browserHandBack": { "verified": true },
            },
            "promptMetadata": { "browser_hand_back": { "verified": true } },
            "details": { "browserHandBack": { "verified": true } },
            "clientMessageId": "kept",
        });
        assert_eq!(
            take_hand_back_claim(&mut metadata),
            Some(json!(browser_job))
        );
        assert_eq!(
            metadata,
            json!({
                "prompt_metadata": {},
                "promptMetadata": {},
                "details": {},
                "clientMessageId": "kept",
            })
        );
        // A forged record without a claim is still removed.
        let mut forged = json!({ "browserHandBack": { "verified": true } });
        assert_eq!(take_hand_back_claim(&mut forged), None);
        assert_eq!(forged, json!({}));
        assert_eq!(take_hand_back_claim(&mut json!("text")), None);
    }

    #[test]
    fn a_claim_names_one_job() {
        let job = Uuid::new_v4();
        assert_eq!(parse_hand_back_claim(&json!(job.to_string())), Some(job));
        assert_eq!(parse_hand_back_claim(&json!(format!(" {job} "))), Some(job));
        for value in [
            json!(null),
            json!(42),
            json!(""),
            json!(format!("job:{job}")),
            json!([job.to_string()]),
            json!({ "id": job.to_string() }),
        ] {
            assert_eq!(parse_hand_back_claim(&value), None, "{value}");
        }
    }

    #[test]
    fn findings_label_each_address_the_reply_names_with_the_words_before_it() {
        let fixtures = fixtures();
        let reply = fixtures["browserReply"].as_str().unwrap();
        let findings: Vec<JsonValue> = findings_from_reply(reply)
            .into_iter()
            .map(|finding| {
                let mut value = json!({ "url": finding.url, "title": finding.title });
                if let Some(reason) = finding.stopped {
                    value["stopped"] = json!(reason);
                }
                value
            })
            .collect();
        assert_eq!(JsonValue::Array(findings), fixtures["expectedFindings"]);
    }

    #[test]
    fn findings_skip_odd_addresses_and_keep_every_line() {
        let reply = "\
- Signed in page — https://user:secret@example.com/account\n\
- Local file file:///etc/passwd\n\
- [Docs](https://docs.example.com/a)\n\
- Again https://docs.example.com/a\n\
1. One https://one.example.com\n\
2) Two (https://two.example.com).\n\
https://three.example.com\n\
- four https://four.example.com\n\
- five https://five.example.com\n\
- six https://six.example.com\n\
- seven https://seven.example.com\n";
        let findings = findings_from_reply(reply);
        assert_eq!(
            findings
                .iter()
                .map(|finding| (finding.url.as_str(), finding.title.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("https://docs.example.com/a", Some("Docs")),
                ("https://one.example.com/", Some("One")),
                ("https://two.example.com/", Some("Two")),
                ("https://three.example.com/", None),
                ("https://four.example.com/", Some("four")),
                ("https://five.example.com/", Some("five")),
                ("https://six.example.com/", Some("six")),
                ("https://seven.example.com/", Some("seven")),
            ]
        );
        assert!(findings.iter().all(|finding| finding.facts.is_empty()));
        let long_title = format!("{} https://long.example.com", "word ".repeat(80));
        let finding = &findings_from_reply(&long_title)[0];
        assert_eq!(
            finding.title.as_ref().unwrap().chars().count(),
            FINDING_TITLE_MAX_CHARS
        );
        let long_url = format!(
            "https://long.example.com/{}",
            "a".repeat(FINDING_URL_MAX_CHARS)
        );
        assert!(findings_from_reply(&long_url).is_empty());
        assert!(findings_from_reply("no addresses here").is_empty());
    }

    #[test]
    fn the_record_matches_the_fixture_and_bounds_the_reply() {
        let fixtures = fixtures();
        let expected = &fixtures["stampedRecord"];
        let browser_job = Uuid::parse_str(expected["browserJobId"].as_str().unwrap()).unwrap();
        let card_job = Uuid::parse_str(expected["cardJobId"].as_str().unwrap()).unwrap();
        let read_at = DateTime::parse_from_rfc3339(expected["readAt"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        let record = hand_back_record(
            &browser_job,
            &card_job,
            viewer_for_transport("shared").unwrap(),
            read_at,
            fixtures["browserRequest"].as_str().unwrap(),
            None,
            fixtures["browserReply"].as_str().unwrap(),
        );
        assert_eq!(&record, expected);

        let record = hand_back_record(
            &browser_job,
            &card_job,
            viewer_for_transport("desktop_personal").unwrap(),
            read_at,
            &"y".repeat(REQUEST_MAX_CHARS + 10),
            Some(&format!("{}\0", "z".repeat(PERSON_REQUEST_MAX_CHARS + 10))),
            "Read one page.\n{\"url\": \"https://a.example.com/\", \"facts\": [\"Open daily.\"]}",
        );
        // A routed message's words reach the build whole, as a card's task is
        // bounded.
        assert_eq!(
            record["personRequest"].as_str().unwrap(),
            "z".repeat(PERSON_REQUEST_MAX_CHARS)
        );
        assert_eq!(
            record["request"].as_str().unwrap().chars().count(),
            REQUEST_MAX_CHARS
        );
        assert_eq!(record["viewer"], VIEWER_DEVICE);
        assert_eq!(viewer_for_transport("local"), None);
    }

    fn read_at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-04T08:26:14Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// One finding line per page, as the browser skill writes one.
    fn finding_line(url: &str, title: &str, facts: &[String]) -> String {
        json!({ "url": url, "title": title, "facts": facts }).to_string()
    }

    /// `count` pages of one maker and its reviewers, each with two facts, as
    /// a comparison's browser turn wrote them in a local test (Nov 4): its
    /// sixteen lines and first line came to 7,117 characters.
    fn pages(count: usize) -> Vec<(String, String, Vec<String>)> {
        (1..=count)
            .map(|page| {
                let site = if page % 2 == 0 { "maker.example" } else { "reviews.example" };
                (
                    format!("https://{site}/laptops/model-{page}"),
                    format!("Laptop model {page}: specifications and review | {site}"),
                    vec![
                        format!("Model {page} lists 1.4 kg weight, a 13.5-inch 2880x1920 display, a 74 Wh battery and up to 20 hours of video playback, 17 of web use and 11 of video calls under the stated test settings."),
                        format!("Its configurator starts at {page},349 euros with the 5 325 processor; the X7 358H and X9 388H cost more, and each configuration lists the same 74 Wh battery."),
                    ],
                )
            })
            .collect()
    }

    fn reply_of(first_line: &str, pages: &[(String, String, Vec<String>)]) -> String {
        let lines = pages
            .iter()
            .map(|(url, title, facts)| finding_line(url, title, facts))
            .collect::<Vec<_>>();
        format!("{first_line}\n{}", lines.join("\n"))
    }

    /// A local test, Nov 4: a comparison's browser turn read sixteen pages and
    /// wrote a finding line for each. The record cut the reply at 6,000
    /// characters and labelled six pages without their facts, so the building
    /// turn read thirteen lines whole, a fourteenth cut mid-line, and nothing
    /// of the last two. Every line now goes, labelled, with its facts.
    #[test]
    fn a_hand_back_carries_every_finding_line_with_its_facts() {
        let pages = pages(16);
        let reply = reply_of(
            "Read 16 pages on maker.example and reviews.example. Some independent coverage is for an earlier generation.",
            &pages,
        );
        assert!(reply.chars().count() > 7_000, "{}", reply.chars().count());
        let job = Uuid::new_v4();
        for person_request in [
            Some("Compare the three latest laptops of one maker, with two reviews each, as a comparison page."),
            None,
        ] {
            let record = hand_back_record(
                &job,
                &job,
                VIEWER_WORKSPACE,
                read_at(),
                "Read each laptop's own page and two independent reviews of each: processor, battery, weight and price.",
                person_request,
                &reply,
            );
            let findings = record["findings"].as_array().expect("findings");
            assert_eq!(findings.len(), 16, "{record}");
            for (finding, (url, title, facts)) in findings.iter().zip(&pages) {
                assert_eq!(
                    finding,
                    &json!({
                        "url": url,
                        "title": title,
                        "facts": facts,
                        "readAt": "2026-11-04T08:26:14Z",
                        "viewer": VIEWER_WORKSPACE,
                    })
                );
            }
            assert!(record.get("findingsLeftOut").is_none(), "{record}");
            assert_eq!(record["reply"], "");
            assert_eq!(record["replyTruncated"], false);
            let quoted = quoted_chars(&record);
            assert!(quoted <= HAND_BACK_SECTION_MAX_CHARS, "{quoted}");
        }
    }

    /// A local test, Nov 4: a map's browser turn wrote a day plan and advice
    /// ahead of its finding lines ("base yourself in …", "choose a quieter
    /// nearby street …"), which no page it read said, and the hand-back put
    /// them in the map's description. None of a browser turn's own words go
    /// with findings that list what their pages showed.
    #[test]
    fn a_reply_s_own_words_never_go_with_its_findings() {
        let words = "Read 4 pages on the city's tourism site. For a first visit, base yourself in the old quarter or the river district, and choose a quieter nearby street if you want a calmer stay.\n\nDay 1 — Historic heart: the palace and the cathedral.\n\nDay 2 — The river and the market across it.\n\nMap: https://visit.example.com/map — the official map.";
        let pages = vec![
            (
                "https://visit.example.com/".to_string(),
                "Home".to_string(),
                vec!["The site links to an interactive city map.".to_string()],
            ),
            (
                "https://visit.example.com/old-quarter".to_string(),
                "Old quarter".to_string(),
                vec![
                    "The page lists the palace, the cathedral and the archive as the quarter's sights.".to_string(),
                    "It describes the quarter as a high-visitor area.".to_string(),
                ],
            ),
        ];
        let job = Uuid::new_v4();
        let record = hand_back_record(
            &job,
            &job,
            VIEWER_WORKSPACE,
            read_at(),
            "",
            Some("Plan 3 days in the city for a first visit: where to stay, what to see each day, on a map."),
            &format!("{words}\n\n{}", reply_of("", &pages).trim_start()),
        );
        assert_eq!(record["reply"], "");
        let text = record.to_string();
        for words in [
            "base yourself",
            "quieter nearby street",
            "Day 1",
            "Day 2",
            "/map",
        ] {
            assert!(!text.contains(words), "{words}: {record}");
        }
        assert_eq!(record["findings"][1]["facts"], json!(pages[1].2));
    }

    /// A page that stopped the turn goes to the building turn as its finding,
    /// which says which page and why, and takes none of the browser turn's
    /// words along. The browser turn says what it read in its first line, and
    /// a stop there too: a map's browser turn wrote that line as one paragraph
    /// with its own advice in it ("base yourself in …", "choose a quieter
    /// nearby street …", which no page gave), so a stopped page, such as a
    /// link-only booking site, took that advice along with the stop.
    #[test]
    fn a_page_that_stopped_the_turn_takes_none_of_its_words_along() {
        let words = "Read 2 pages on the city's tourism site; the booking site is link-only. For a first visit, base yourself in the old quarter or the river district: they put the sights within easy walking reach. The quarter is busy, so choose a quieter nearby street if you want a calmer stay.\n\nDay 1 — Historic heart: the palace and the cathedral.";
        let pages = vec![
            (
                "https://visit.example.com/".to_string(),
                "Home".to_string(),
                vec!["The site links to an interactive city map.".to_string()],
            ),
            (
                "https://visit.example.com/old-quarter".to_string(),
                "Old quarter".to_string(),
                vec!["It describes the quarter as a high-visitor area.".to_string()],
            ),
        ];
        let stopped =
            r#"{"url": "https://booking.example/search?city=old-town", "stopped": "link-only"}"#;
        let job = Uuid::new_v4();
        let record = hand_back_record(
            &job,
            &job,
            VIEWER_WORKSPACE,
            read_at(),
            "",
            Some("Plan 3 days in the city for a first visit: where to stay, what to see each day, on a map."),
            &format!("{words}\n\n{}\n{stopped}", reply_of("", &pages).trim_start()),
        );
        assert_eq!(record["reply"], "", "{record}");
        let text = record.to_string();
        for words in [
            "base yourself",
            "quieter nearby street",
            "Day 1",
            "link-only.",
        ] {
            assert!(!text.contains(words), "{words}: {record}");
        }
        assert_eq!(
            record["findings"][2],
            json!({
                "url": "https://booking.example/search?city=old-town",
                "title": null,
                "readAt": "2026-11-04T08:26:14Z",
                "viewer": VIEWER_WORKSPACE,
                "stopped": "link-only",
            })
        );
        assert_eq!(record["findings"][1]["facts"], json!(pages[1].2));
        assert!(record_read_a_page(&record));
    }

    /// Fitting the section leaves out the last pages read before a page that
    /// stopped the turn: that finding is short, says which page and why, and
    /// is never counted with the pages read that were left out. At least one
    /// page read always stays.
    #[test]
    fn an_over_long_hand_back_keeps_the_pages_that_stopped_it() {
        let pages = pages(40);
        let reply = format!(
            "{}\n{}\n{}",
            r#"{"url": "https://reviews.example/laptop-1", "stopped": "login"}"#,
            reply_of("Read 40 pages.", &pages),
            r#"{"url": "https://reviews.example/laptop-41", "stopped": "paywall"}"#,
        );
        let job = Uuid::new_v4();
        let record = hand_back_record(&job, &job, VIEWER_WORKSPACE, read_at(), "", None, &reply);
        let findings = record["findings"].as_array().expect("findings");
        assert_eq!(findings[0]["stopped"], "login", "{record}");
        assert_eq!(findings.last().unwrap()["stopped"], "paywall", "{record}");
        let read: Vec<&JsonValue> = findings
            .iter()
            .filter(|finding| finding.get("stopped").is_none())
            .collect();
        assert!((1..40).contains(&read.len()), "{}", read.len());
        for (finding, (url, _, facts)) in read.iter().zip(&pages) {
            assert_eq!(finding["url"], json!(url));
            assert_eq!(finding["facts"], json!(facts));
        }
        assert_eq!(record["findingsLeftOut"], json!(40 - read.len()));
        assert!(quoted_chars(&record) <= HAND_BACK_SECTION_MAX_CHARS);
    }

    /// However long a reply, the record keeps the same whole lines it would
    /// keep of a short one: up to the section, one more not fitting. What can
    /// never fit is left out before fitting, which would otherwise quote the
    /// whole record once for each line it leaves out.
    #[test]
    fn a_long_reply_keeps_whole_lines_up_to_the_section() {
        let job = Uuid::new_v4();
        let words = (1..=4_000)
            .map(|line| format!("Line {line}: what the browser turn said of the pages it read."))
            .collect::<Vec<_>>();
        let reply = format!(
            "{}\n{{\"url\": \"https://maker.example/laptop-13\"}}",
            words.join("\n")
        );
        let record = hand_back_record(&job, &job, VIEWER_WORKSPACE, read_at(), "", None, &reply);
        let kept = record["reply"].as_str().expect("reply");
        let lines = kept.lines().count();
        assert_eq!(kept, words[..lines].join("\n"));
        assert_eq!(record["replyTruncated"], true);
        assert!(quoted_chars(&record) <= HAND_BACK_SECTION_MAX_CHARS);
        let mut more = record.clone();
        more["reply"] = json!(words[..=lines].join("\n"));
        assert!(quoted_chars(&more) > HAND_BACK_SECTION_MAX_CHARS);

        let lines = (1..=800)
            .map(|page| {
                finding_line(
                    &format!("https://maker.example/page-{page}"),
                    &format!("Page {page}"),
                    &[format!("Fact {page}, as the page states it.")],
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let record = hand_back_record(&job, &job, VIEWER_WORKSPACE, read_at(), "", None, &lines);
        let kept = record["findings"].as_array().expect("findings").len();
        assert!((1..800).contains(&kept), "{kept}");
        assert_eq!(record["findingsLeftOut"], json!(800 - kept));
        assert_eq!(
            record["findings"][kept - 1]["url"],
            format!("https://maker.example/page-{kept}")
        );
        assert!(quoted_chars(&record) <= HAND_BACK_SECTION_MAX_CHARS);
    }

    /// A page's facts over their bound are counted, never dropped without a
    /// word: the building turn would read a value the page stated, such as
    /// its price, as not stated.
    #[test]
    fn a_pages_facts_over_their_bound_are_counted() {
        let mut facts: Vec<String> = (1..=10)
            .map(|spec| format!("Specification {spec}: {}", ["detail"; 26].join(" ")))
            .collect();
        facts.push("Price: from 1,349 euros.".to_string());
        assert!(facts.iter().map(|fact| fact.chars().count()).sum::<usize>() > 2_000);
        let line = finding_line("https://maker.example/laptop-13", "Laptop 13", &facts);
        let job = Uuid::new_v4();
        let record = hand_back_record(
            &job,
            &job,
            VIEWER_WORKSPACE,
            read_at(),
            "",
            None,
            &format!("Read 1 page.\n{line}"),
        );
        let finding = &record["findings"][0];
        let kept = finding["facts"].as_array().expect("facts").len();
        assert!((1..facts.len()).contains(&kept), "{record}");
        assert_eq!(finding["facts"], json!(facts[..kept]));
        assert_eq!(
            finding["factsLeftOut"],
            json!(facts.len() - kept),
            "{record}"
        );
        // A page whose facts fit has no count.
        let record = hand_back_record(
            &job,
            &job,
            VIEWER_WORKSPACE,
            read_at(),
            "",
            None,
            &finding_line("https://maker.example/laptop-13", "Laptop 13", &facts[10..]),
        );
        assert!(
            record["findings"][0].get("factsLeftOut").is_none(),
            "{record}"
        );
    }

    /// The runtime's section leaves the whole hand-back out when it is over its
    /// size. The record keeps whole finding lines, in order, up to it, and says
    /// how many it left out; never all of them.
    #[test]
    fn an_over_long_hand_back_keeps_whole_lines_and_says_how_many_were_left_out() {
        let pages = pages(40);
        let job = Uuid::new_v4();
        let record = hand_back_record(
            &job,
            &job,
            VIEWER_WORKSPACE,
            read_at(),
            "Read every page.",
            None,
            &reply_of("Read 40 pages.", &pages),
        );
        let findings = record["findings"].as_array().expect("findings");
        let kept = findings.len();
        assert!((1..40).contains(&kept), "{kept}");
        assert_eq!(record["findingsLeftOut"], json!(40 - kept));
        for (finding, (url, _, facts)) in findings.iter().zip(&pages) {
            assert_eq!(finding["url"], json!(url));
            assert_eq!(finding["facts"], json!(facts));
        }
        assert!(quoted_chars(&record) <= HAND_BACK_SECTION_MAX_CHARS);
        // Up to the limit: one more whole line would not fit.
        let mut more = record.clone();
        more["findings"].as_array_mut().unwrap().push(json!({
            "url": pages[kept].0,
            "title": pages[kept].1,
            "facts": pages[kept].2,
            "readAt": "2026-11-04T08:26:14Z",
            "viewer": VIEWER_WORKSPACE,
        }));
        more["findingsLeftOut"] = json!(40 - kept - 1);
        assert!(quoted_chars(&more) > HAND_BACK_SECTION_MAX_CHARS);

        // A reply whose lines list no fact keeps its whole first lines.
        let words = (1..=400)
            .map(|line| {
                format!("Line {line} of what the browser turn said about the pages it read.")
            })
            .collect::<Vec<_>>();
        let reply = format!(
            "{}\n{{\"url\": \"https://maker.example/laptop-13\"}}",
            words.join("\n")
        );
        let record = hand_back_record(&job, &job, VIEWER_WORKSPACE, read_at(), "", None, &reply);
        let kept = record["reply"].as_str().unwrap();
        assert!(words.join("\n").starts_with(kept), "{kept}");
        assert!(kept.ends_with("the pages it read."), "{kept}");
        assert_eq!(record["replyTruncated"], true);
        assert_eq!(record["findings"].as_array().map(Vec::len), Some(1));
        assert!(quoted_chars(&record) <= HAND_BACK_SECTION_MAX_CHARS);

        // Never all of them: the one page and the first line stay, the line
        // cut to fit when it alone is over.
        let reply = format!(
            "{}\n{{\"url\": \"https://maker.example/laptop-13\"}}",
            "w".repeat(20_000)
        );
        let record = hand_back_record(&job, &job, VIEWER_WORKSPACE, read_at(), "", None, &reply);
        assert_eq!(record["findings"].as_array().map(Vec::len), Some(1));
        let kept = record["reply"].as_str().unwrap();
        assert!(
            !kept.is_empty() && kept.chars().all(|ch| ch == 'w'),
            "{record}"
        );
        assert_eq!(record["replyTruncated"], true);
        assert!(quoted_chars(&record) <= HAND_BACK_SECTION_MAX_CHARS);
        // One page's facts never crowd out the others: whole facts, in
        // order, up to their bound.
        let facts = [
            "a".repeat(FINDING_FACTS_MAX_CHARS - 10),
            "b".repeat(20),
            "c".repeat(5),
            "d".repeat(FINDING_FACTS_MAX_CHARS + 10),
        ];
        let findings = findings_from_reply(&finding_line(
            "https://maker.example/laptop-13",
            "Laptop 13",
            &facts,
        ));
        assert_eq!(findings[0].facts, vec![facts[0].clone()]);
        let findings = findings_from_reply(&finding_line(
            "https://maker.example/laptop-13",
            "Laptop 13",
            &facts[3..],
        ));
        assert_eq!(findings[0].facts, vec!["d".repeat(FINDING_FACTS_MAX_CHARS)]);
    }

    /// A reply whose lines list no fact goes as it is, as all the turn said:
    /// one whose turn wrote no finding line, so its note lists the pages its
    /// own steps opened by address alone (runtime-agent
    /// `finding_lines_from_pages`), or an older runtime's reply with none.
    /// Nothing cuts it at 6,000 characters any more.
    #[test]
    fn a_reply_with_no_finding_lines_still_goes_as_it_is() {
        let words = (1..=90)
            .map(|line| {
                format!(
                    "Line {line}: the maker's page for this model lists its battery and weight."
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(words.chars().count() > 6_000);
        let opened = "{\"url\":\"https://maker.example/laptop-13\"}\n{\"url\":\"https://reviews.example/laptop-13\"}";
        let job = Uuid::new_v4();
        for reply in [
            format!("{words}\n\n{opened}"),
            format!("{words}\n- Maker's page https://maker.example/laptop-13"),
        ] {
            let record = hand_back_record(&job, &job, VIEWER_DEVICE, read_at(), "", None, &reply);
            assert_eq!(record["reply"], json!(reply), "{record}");
            assert_eq!(record["replyTruncated"], false);
            assert!(record_read_a_page(&record), "{record}");
            assert!(record["findings"]
                .as_array()
                .unwrap()
                .iter()
                .all(|finding| finding.get("facts").is_none()));
        }
    }

    /// The runtime moves the finding lines out of the reply the person reads
    /// and into the browser turn's Details note: the record's reply puts them
    /// back, so the building turn gets the same findings as before.
    #[test]
    fn finding_lines_from_the_details_note_go_back_after_the_reply() {
        let fixtures = fixtures();
        let posted = fixtures["postedReply"].as_str().unwrap();
        let lines = fixtures["findingLines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let reply = reply_with_finding_lines(posted, Some(&lines));
        assert_eq!(reply, format!("{posted}\n\n{lines}"));
        let findings: Vec<JsonValue> = findings_from_reply(&reply)
            .into_iter()
            .map(|finding| {
                let mut value = json!({ "url": finding.url, "title": finding.title });
                if let Some(reason) = finding.stopped {
                    value["stopped"] = json!(reason);
                }
                value
            })
            .collect();
        assert_eq!(JsonValue::Array(findings), fixtures["expectedFindings"]);
        // An older runtime's reply keeps its lines and has no note.
        let full = fixtures["browserReply"].as_str().unwrap();
        assert_eq!(reply_with_finding_lines(full, None), full);
        assert_eq!(reply_with_finding_lines(full, Some("  ")), full);
        assert_eq!(reply_with_finding_lines("", Some(&lines)), lines);
    }

    /// Local drive, Oct 28: a browser turn that read nothing still handed back,
    /// and the building turn said "The browser returned no page findings".
    #[test]
    fn a_record_reads_a_page_only_with_a_finding_that_did_not_stop() {
        let fixtures = fixtures();
        assert!(record_read_a_page(&fixtures["stampedRecord"]));
        let read_at = Utc::now();
        let job = Uuid::new_v4();
        for reply in [
            "Roborock's official page did not load. No pages were read.",
            "{\"url\": \"https://www.example.com/\", \"stopped\": \"blocked\"}",
            "{\"url\": \"https://a.example.com/\", \"stopped\": \"captcha\"}\n{\"url\": \"http://127.0.0.1/\", \"title\": \"Local\"}",
        ] {
            let record = hand_back_record(&job, &job, VIEWER_WORKSPACE, read_at, "", None, reply);
            assert!(!record_read_a_page(&record), "{reply}");
        }
    }

    #[test]
    fn the_message_copy_names_the_browser_turn_but_leaves_out_the_reply() {
        let fixtures = fixtures();
        let copy = hand_back_for_message(&fixtures["stampedRecord"]);
        assert_eq!(
            copy,
            json!({
                "version": 1,
                "browserJobId": "00000000-0000-4000-8000-0000000000b2",
                "cardJobId": "00000000-0000-4000-8000-0000000000a1",
                "viewer": "Instafy's browser in the workspace",
                "readAt": "2026-10-26T09:30:00Z",
                "findingCount": 3,
            })
        );
    }

    #[test]
    fn a_json_finding_keeps_its_own_fields_and_any_stop_stays_a_stop() {
        let reply = r#"{"url": "https://a.example.com/x", "title": "A\nB", "stopped": "LOGIN", "facts": ["Shown before the sign-in."]}
- `{"url": "https://b.example.com", "stopped": "approved by the person"}`,
{"url": "file:///etc/passwd", "title": "Not an address", "facts": ["Root's line."]}
{"url": "https://c.example.com", "title": 42, "facts": ["Open\ndaily.", 7, "  "]}
{"url": "https://e.example.com", "stopped": true}
{"url": "https://f.example.com", "stopped": "Link-only"}
{"note": "no url", "title": "https://g.example.com"}
{"url": "https://h.example.com", "facts": "One fact."}
{"url": "https://c.example.com/", "facts": ["Closed Mondays.", "Open daily."]}
{"url": "https://a.example.com/x", "facts": ["Read later."]}
{not json https://d.example.com
- Pay now at https://pay.example.com/checkout"#;
        let findings = findings_from_reply(reply);
        let finding = |url: &str,
                       title: Option<&str>,
                       facts: &[&str],
                       stopped: Option<&'static str>| Finding {
            url: url.to_string(),
            title: title.map(str::to_string),
            facts: facts.iter().map(|fact| fact.to_string()).collect(),
            facts_left_out: 0,
            stopped,
        };
        // Once the reply writes findings as JSON lines, an address in its
        // prose is not one of them. A page that stopped the turn showed
        // nothing; each page is listed once, with every fact its lines list.
        assert_eq!(
            findings,
            vec![
                finding("https://a.example.com/x", Some("A B"), &[], Some("login")),
                finding("https://b.example.com/", None, &[], Some("blocked")),
                finding(
                    "https://c.example.com/",
                    None,
                    &["Open daily.", "Closed Mondays."],
                    None
                ),
                finding("https://e.example.com/", None, &[], Some("blocked")),
                finding("https://f.example.com/", None, &[], Some("link-only")),
                finding("https://h.example.com/", None, &["One fact."], None),
            ]
        );
        // The same reasons the runtime asks the browser turn for.
        assert_eq!(json!(STOP_REASONS), fixtures()["stopReasons"]);
        for reason in STOP_REASONS {
            let line = format!(r#"{{"url": "https://s.example.com", "stopped": "{reason}"}}"#);
            assert_eq!(findings_from_reply(&line)[0].stopped, Some(reason));
        }
        // A reply with no JSON finding falls back to its lines' addresses.
        assert_eq!(
            findings_from_reply("{not json https://d.example.com"),
            vec![finding(
                "https://d.example.com/",
                Some("{not json"),
                &[],
                None
            )]
        );
    }

    #[test]
    fn findings_never_name_a_private_or_local_address() {
        for address in [
            "http://localhost:3000/admin",
            "http://LOCALHOST./",
            "http://router/",
            "http://dev.localhost/",
            "http://printer.local/",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://0x7f.1/",
            "http://0177.0.0.1/",
            "http://0/",
            "http://10.0.0.8/",
            "http://172.16.4.2/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.100.100.200/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[::ffff:7f00:1]/",
            "http://[::]/",
        ] {
            let json_line = format!(r#"{{"url": "{address}", "title": "x"}}"#);
            assert!(findings_from_reply(&json_line).is_empty(), "{address}");
            let text_line = format!("- Page {address}");
            assert!(findings_from_reply(&text_line).is_empty(), "{address}");
        }
        for address in [
            "https://93.184.215.14/",
            "https://[2606:4700::1111]/",
            "https://docs.example.com/",
        ] {
            let line = format!(r#"{{"url": "{address}"}}"#);
            assert_eq!(findings_from_reply(&line)[0].url, address);
        }
    }

    // Studio's test pins its Let Octo continue prompt to the same fixture.
    #[test]
    fn a_let_octo_continue_press_reads_as_one_line() {
        assert_eq!(
            json!(LET_OCTO_CONTINUE_PROMPT),
            fixtures()["letOctoContinuePrompt"]
        );
        assert_eq!(
            browser_request_for_building(&format!("  {LET_OCTO_CONTINUE_PROMPT}\n")),
            LET_OCTO_CONTINUE_LINE
        );
        assert_eq!(
            browser_request_for_building("Find the opening hours.\0"),
            "Find the opening hours."
        );
    }

    #[test]
    fn a_card_job_is_named_by_job_key_only() {
        let job = Uuid::new_v4();
        assert_eq!(
            card_job_of(&json!({ "browserRequestOf": format!("job:{job}") })),
            Some(job)
        );
        assert_eq!(
            card_job_of(&json!({ "browserRequestOf": format!("message:{job}") })),
            None
        );
        assert_eq!(
            card_job_of(&json!({ "browserRequestOf": job.to_string() })),
            None
        );
        assert_eq!(card_job_of(&json!({})), None);
    }
}
