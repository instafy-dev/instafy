//! Hand-back: what a browser turn found goes back to the building turn.
//!
//! A building turn cannot open web pages, so it asks for Instafy's browser
//! with a `request_browser` card, and the browser turn that continues the
//! card runs on its own thread without the workspace. When that browser turn
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
//! - the card's own turn was not itself a hand-back: one automatic hop only,
//!   so a later card stays a button for the person to press;
//! - no other hand-back for that browser job is queued, running or done.
//!
//! The record carries the browser turn's last reply (bounded) and labelled
//! findings `{url, title, readAt, viewer}`: the address and title come from
//! the reply's lines, `readAt` and `viewer` from the job itself. The runtime
//! shows it to the building turn as quoted page data, never as the person's
//! words and never as their consent (runtime-agent `jobs/browser_hand_back.rs`).
//! A hand-back is never queued or recorded without a dispatch: it resumes an
//! idle lane or is refused.

use axum::{http::StatusCode, Json};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::{bad_request, forbidden, internal_error, ApiError};

pub(crate) const HAND_BACK_KEY: &str = "browserHandBack";
const HAND_BACK_ALIASES: [&str; 2] = [HAND_BACK_KEY, "browser_hand_back"];
pub(crate) const HAND_BACK_CLAIM_KEY: &str = "continuesFromBrowserJob";
const HAND_BACK_CLAIM_ALIASES: [&str; 2] = [HAND_BACK_CLAIM_KEY, "continues_from_browser_job"];
/// Nested copies of the message metadata a client could also fill in.
const NESTED_METADATA_KEYS: [&str; 3] = ["prompt_metadata", "promptMetadata", "details"];
const HAND_BACK_VERSION: u64 = 1;
/// How much of the browser turn's reply reaches the building turn.
pub(crate) const HAND_BACK_REPLY_MAX_CHARS: usize = 6_000;
/// The browser skill asks for at most six related reads per card.
pub(crate) const HAND_BACK_MAX_FINDINGS: usize = 6;
const FINDING_TITLE_MAX_CHARS: usize = 160;
const FINDING_URL_MAX_CHARS: usize = 2_048;
/// A browser turn older than this is history, not a turn to resume from.
pub(crate) const HAND_BACK_WINDOW_MINUTES: i64 = 30;

const VIEWER_WORKSPACE: &str = "Instafy's browser in the workspace";
const VIEWER_DEVICE: &str = "Instafy's browser on the person's device";

pub(crate) const HAND_BACK_SECOND_HOP_CODE: &str = "browser_hand_back_second_hop";
pub(crate) const HAND_BACK_USED_CODE: &str = "browser_hand_back_used";
pub(crate) const HAND_BACK_PAUSED_CODE: &str = "browser_hand_back_paused";

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

/// One labelled finding: an address the reply names and the words before it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Finding {
    pub(crate) url: String,
    pub(crate) title: Option<String>,
    /// Why the page was not read (`login`, `captcha`, `paywall`, `blocked`, `robots`).
    pub(crate) stopped: Option<&'static str>,
}

/// The reasons a browser turn may give for a page it did not read.
const STOP_REASONS: [&str; 5] = ["login", "captcha", "paywall", "blocked", "robots"];

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
    {
        return None;
    }
    let normalized = parsed.to_string();
    (normalized.chars().count() <= FINDING_URL_MAX_CHARS).then_some(normalized)
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
/// the browser skill writes one (`url`, `title`, `stopped`), or else the
/// line's first http(s) address and the words before it. At most [`HAND_BACK_MAX_FINDINGS`], each
/// address once. Nothing here is checked against the pages: they label the
/// reply's own claims, which the building turn reads as page data.
pub(crate) fn findings_from_reply(reply: &str) -> Vec<Finding> {
    let mut findings: Vec<Finding> = Vec::new();
    for line in reply.lines() {
        if findings.len() >= HAND_BACK_MAX_FINDINGS {
            break;
        }
        let finding = match json_finding(line) {
            // A finding written as one JSON object: its own url, title and stop.
            Some(finding) => finding,
            None => text_finding(line),
        };
        let Some(finding) = finding else {
            continue;
        };
        if findings.iter().any(|known| known.url == finding.url) {
            continue;
        }
        findings.push(finding);
    }
    findings
}

/// A line that is one JSON object, as the browser skill writes a finding
/// (`{"url", "title", ...}` or `{"url", "stopped"}`): Some(None) when the
/// object names no usable address, None when the line is not JSON. Its
/// `readAt` and `viewer`, if any, are the model's; the record uses the job's.
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
    let Some(url) = object
        .get("url")
        .and_then(JsonValue::as_str)
        .and_then(plain_address)
    else {
        return Some(None);
    };
    let title = object
        .get("title")
        .and_then(JsonValue::as_str)
        .map(|title| one_line(title, FINDING_TITLE_MAX_CHARS))
        .filter(|title| !title.is_empty());
    let stopped = object
        .get("stopped")
        .and_then(JsonValue::as_str)
        .and_then(|reason| {
            STOP_REASONS
                .iter()
                .copied()
                .find(|known| known.eq_ignore_ascii_case(reason.trim()))
        });
    Some(Some(Finding {
        url,
        title,
        stopped,
    }))
}

/// A line of text with an address in it: the first address and the words before it.
fn text_finding(line: &str) -> Option<Finding> {
    let (start, raw) = first_address(line)?;
    Some(Finding {
        url: plain_address(&raw)?,
        title: finding_title(&line[..start]),
        stopped: None,
    })
}

/// The reply as the building turn gets it: at most [`HAND_BACK_REPLY_MAX_CHARS`]
/// characters, NUL bytes removed, and whether it was cut.
pub(crate) fn bounded_reply(reply: &str) -> (String, bool) {
    let cleaned = reply.replace('\0', "");
    let trimmed = cleaned.trim();
    let truncated = trimmed.chars().count() > HAND_BACK_REPLY_MAX_CHARS;
    (
        trimmed.chars().take(HAND_BACK_REPLY_MAX_CHARS).collect(),
        truncated,
    )
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

/// The checked record a building turn carries as `metadata.browserHandBack`.
pub(crate) fn hand_back_record(
    browser_job_id: &Uuid,
    card_job_id: &Uuid,
    viewer: &str,
    read_at: DateTime<Utc>,
    reply: &str,
) -> JsonValue {
    let read_at = read_at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let (reply, truncated) = bounded_reply(reply);
    let findings: Vec<JsonValue> = findings_from_reply(&reply)
        .into_iter()
        .map(|finding| {
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
        })
        .collect();
    json!({
        "version": HAND_BACK_VERSION,
        "verified": true,
        "browserJobId": browser_job_id.to_string(),
        "cardJobId": card_job_id.to_string(),
        "viewer": viewer,
        "readAt": read_at,
        "findings": findings,
        "reply": reply,
        "replyTruncated": truncated,
    })
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

fn browser_transport_of(metadata: &JsonValue) -> Option<&str> {
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

/// Checks a hand-back claim for a dispatch into `conversation_id` and returns
/// the record to stamp. Runs inside the dispatch transaction, after the
/// conversation's dispatch fence, so two hand-backs for one browser turn
/// cannot both pass the once-only check.
pub(crate) async fn require_hand_back(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    context: &RequestContext,
    claim: &JsonValue,
    request_metadata: &JsonValue,
) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let browser_job_id = parse_hand_back_claim(claim)
        .ok_or_else(|| bad_request("continuesFromBrowserJob must name one browser job"))?;
    if browser_transport_of(request_metadata).is_some() {
        return Err(bad_request(
            "A hand-back continues the building turn, so it cannot also ask for a browser.",
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
                    job.completed_at, prompt.user_id as sender
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
            "That browser turn stopped for a step of yours. Finish it in the browser and choose Let AI continue.",
        ));
    }

    // One hop: the card the browser continued must come from an ordinary
    // turn, never from a turn that was itself a hand-back.
    let card_job = transaction
        .query_opt(
            "select payload from agent_jobs where id = $1 and conversation_id = $2",
            &[&card_job_id, conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the card's turn: {error}")))?
        .ok_or_else(not_a_card_browser_turn)?;
    let card_metadata = card_job
        .get::<_, PgJson<JsonValue>>("payload")
        .0
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

    // The turn's final answer is its completion summary; a turn that streamed
    // its answer instead has it as its last streamed message.
    let summary = browser_job
        .get::<_, Option<String>>("summary")
        .filter(|summary| !summary.trim().is_empty());
    let reply = match (summary, run_id) {
        (Some(summary), _) => Some(summary),
        (None, Some(run_id)) => last_streamed_reply(transaction, conversation_id, &run_id).await?,
        (None, None) => None,
    }
    .filter(|reply| !reply.trim().is_empty())
    .ok_or_else(|| {
        hand_back_refused(
            StatusCode::CONFLICT,
            "browser_hand_back_empty",
            "That browser turn returned nothing to hand back.",
        )
    })?;

    Ok(hand_back_record(
        &browser_job_id,
        &card_job_id,
        viewer,
        completed_at,
        &reply,
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> JsonValue {
        serde_json::from_str(include_str!("browser_hand_back_fixtures.json")).expect("fixtures")
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
    fn findings_skip_odd_addresses_and_stop_at_six() {
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
- six https://six.example.com\n";
        let findings = findings_from_reply(reply);
        assert_eq!(findings.len(), HAND_BACK_MAX_FINDINGS);
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
            ]
        );
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
            fixtures["browserReply"].as_str().unwrap(),
        );
        assert_eq!(&record, expected);

        let long = "x".repeat(HAND_BACK_REPLY_MAX_CHARS + 10);
        let record = hand_back_record(
            &browser_job,
            &card_job,
            viewer_for_transport("desktop_personal").unwrap(),
            read_at,
            &long,
        );
        assert_eq!(record["replyTruncated"], true);
        assert_eq!(
            record["reply"].as_str().unwrap().chars().count(),
            HAND_BACK_REPLY_MAX_CHARS
        );
        assert_eq!(record["viewer"], VIEWER_DEVICE);
        assert_eq!(viewer_for_transport("local"), None);
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
                "findingCount": 5,
            })
        );
    }

    #[test]
    fn a_json_finding_keeps_its_own_fields_and_only_known_stops() {
        let reply = r#"{"url": "https://a.example.com/x", "title": "A\nB", "stopped": "LOGIN"}
- `{"url": "https://b.example.com", "stopped": "approved by the person"}`,
{"url": "file:///etc/passwd", "title": "Not an address"}
{"url": "https://c.example.com", "title": 42}
{not json https://d.example.com"#;
        let findings = findings_from_reply(reply);
        assert_eq!(
            findings,
            vec![
                Finding {
                    url: "https://a.example.com/x".to_string(),
                    title: Some("A B".to_string()),
                    stopped: Some("login"),
                },
                Finding {
                    url: "https://b.example.com/".to_string(),
                    title: None,
                    stopped: None,
                },
                Finding {
                    url: "https://c.example.com/".to_string(),
                    title: None,
                    stopped: None,
                },
                Finding {
                    url: "https://d.example.com/".to_string(),
                    title: Some("{not json".to_string()),
                    stopped: None,
                },
            ]
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
