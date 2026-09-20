//! Interactive message search. Authorization is part of the database query, before LIMIT.
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::conversations::{
    ensure_conversation_access, load_conversation_record, map_conversation_message_row,
    message_row_to_payload, ConversationMessagePayload,
};
use crate::{
    auth::{authenticate_request, require_user_session},
    bad_request, internal_error, not_found, ApiError, AppState,
};

const MAX_RESULTS: i64 = 50;
const SNIPPET_CHARS: i32 = 360;
// Include JS trim() whitespace because the existing per-viewer lifecycle is parsed by Studio.
const LIFECYCLE_WHITESPACE: &str = "\t\n\u{000b}\u{000c}\r \u{0085}\u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/search/messages", get(search_messages))
        .route(
            "/conversations/:conversation_id/messages/context",
            get(message_context),
        )
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let mut response = next.run(request).await;
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchQuery {
    q: String,
    project_id: Option<Uuid>,
    org_id: Option<Uuid>,
    #[serde(default)]
    personal: bool,
    cursor: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchCursor {
    version: u8,
    search_key: String,
    created_at: DateTime<Utc>,
    message_id: Uuid,
}

#[derive(Debug, Serialize, PartialEq)]
struct MatchRange {
    start: usize,
    end: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    message_id: Uuid,
    conversation_id: Uuid,
    project_id: Uuid,
    org_id: Option<Uuid>,
    project_name: String,
    org_name: Option<String>,
    conversation_title: String,
    role: String,
    created_at: DateTime<Utc>,
    snippet: String,
    match_ranges: Vec<MatchRange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchPage {
    matches: Vec<SearchMatch>,
    next_cursor: Option<String>,
    has_more: bool,
}

fn validate_query(params: &SearchQuery) -> Result<&str, (StatusCode, Json<ApiError>)> {
    let query = params.q.trim();
    if !(2..=200).contains(&query.chars().count()) || query.chars().any(char::is_control) {
        return Err(bad_request(
            "query must contain 2 to 200 characters without control characters",
        ));
    }
    if params.personal && params.org_id.is_some() {
        return Err(bad_request("personal and orgId scopes cannot be combined"));
    }
    if params
        .limit
        .is_some_and(|limit| !(1..=MAX_RESULTS).contains(&limit))
    {
        return Err(bad_request("limit must be between 1 and 50"));
    }
    Ok(query)
}

fn literal_pattern(query: &str) -> String {
    format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn search_key(user_id: Uuid, params: &SearchQuery, query: &str) -> String {
    hex::encode(Sha256::digest(format!(
        "{user_id}|{query}|{:?}|{:?}|{}",
        params.project_id, params.org_id, params.personal
    )))
}

fn decode_cursor(raw: &str, key: &str) -> Result<SearchCursor, (StatusCode, Json<ApiError>)> {
    if raw.len() > 1024 {
        return Err(bad_request("invalid search cursor"));
    }
    let parsed = URL_SAFE_NO_PAD
        .decode(raw)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SearchCursor>(&bytes).ok());
    parsed
        .filter(|cursor| cursor.version == 1 && cursor.search_key == key)
        .ok_or_else(|| bad_request("invalid search cursor for this query or scope"))
}

// Keep this predicate aligned with ensure_project_access and ensure_conversation_access.
// Unlike a runtime capability, search requires an interactive user and grants no sandbox-session bypass.
const AUTHORIZED_MATCHES: &str = r#"
  from conversation_messages m
  join conversations c on c.id = m.conversation_id and c.project_id = m.project_id
  join projects p on p.id = c.project_id
  left join organizations o on o.id = p.org_id
  where lower(coalesce(p.status, '')) <> 'deleted'
    and (p.owner_user_id = $1
      or exists (select 1 from project_memberships pm where pm.project_id = p.id and pm.user_id = $1 and lower(btrim(pm.role)) in ('viewer','builder','admin','owner'))
      or exists (select 1 from org_memberships om where om.org_id = p.org_id and om.user_id = $1 and lower(btrim(om.role)) in ('viewer','builder','admin','owner')))
    and (c.visibility <> 'private' or c.created_by = $1
      or exists (select 1 from conversation_participants cp where cp.conversation_id = c.id and cp.user_id = $1))
    and lower(btrim(coalesce(c.metadata -> $3::text ->> 'status', c.metadata ->> $3::text, 'active'), $12)) not in ('hidden','deleted')
    and ($4::uuid is null or p.id = $4)
    and ($5::uuid is null or p.org_id = $5)
    and (not $6 or p.org_id is null)
    and m.role in ('user', 'assistant')
    and lower(m.content) like lower($2) escape '\'
    and ($7::timestamptz is null or (m.created_at, m.id) < ($7, $8::uuid))
"#;

async fn search_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SearchQuery>,
) -> Result<Json<SearchPage>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let query = validate_query(&params)?;
    let key = search_key(user_id, &params, query);
    let cursor = params
        .cursor
        .as_deref()
        .map(|raw| decode_cursor(raw, &key))
        .transpose()?;
    let cursor_at = cursor.as_ref().map(|cursor| cursor.created_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.message_id);
    let pattern = literal_pattern(query);
    let lifecycle_key = format!("instafy_conversation_lifecycle_v1_{user_id}");
    let limit = params.limit.unwrap_or(30);
    let fetch_limit = limit + 1;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("message search unavailable"))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|_| internal_error("message search unavailable"))?;
    // Indexes accelerate ordinary terms; short/common terms still have a hard database budget.
    transaction
        .batch_execute("SET LOCAL statement_timeout = '5s'; SET TRANSACTION READ ONLY;")
        .await
        .map_err(|_| internal_error("message search unavailable"))?;
    let sql = format!(
        r#"select m.id, m.conversation_id, m.project_id, p.org_id,
      left(coalesce(p.name, 'Untitled space'), 200) as project_name, left(o.name, 200) as org_name,
      left(coalesce(nullif(btrim(c.metadata ->> 'title'), ''), 'Untitled chat'), 200) as conversation_title,
      m.role, m.created_at,
      substring(m.content from greatest(1, strpos(lower(m.content), lower($10)) - 90) for $11) as snippet,
      strpos(lower(m.content), lower($10)) > 91 as leading,
      char_length(m.content) >= greatest(1, strpos(lower(m.content), lower($10)) - 90) + $11 as trailing
      {AUTHORIZED_MATCHES} order by m.created_at desc, m.id desc limit $9"#
    );
    let rows = transaction
        .query(
            &sql,
            &[
                &user_id,
                &pattern,
                &lifecycle_key,
                &params.project_id,
                &params.org_id,
                &params.personal,
                &cursor_at,
                &cursor_id,
                &fetch_limit,
                &query,
                &SNIPPET_CHARS,
                &LIFECYCLE_WHITESPACE,
            ],
        )
        .await
        .map_err(|_| internal_error("message search unavailable; narrow the query or retry"))?;
    let has_more = rows.len() as i64 > limit;
    let matches: Vec<_> = rows
        .iter()
        .take(limit as usize)
        .map(|row| {
            let text: String = row.get("snippet");
            let snippet = format!(
                "{}{}{}",
                if row.get("leading") { "…" } else { "" },
                text,
                if row.get("trailing") { "…" } else { "" }
            );
            let match_ranges = highlight_ranges(&snippet, query);
            SearchMatch {
                message_id: row.get("id"),
                conversation_id: row.get("conversation_id"),
                project_id: row.get("project_id"),
                org_id: row.get("org_id"),
                project_name: row.get("project_name"),
                org_name: row.get("org_name"),
                conversation_title: row.get("conversation_title"),
                role: row.get("role"),
                created_at: row.get("created_at"),
                snippet,
                match_ranges,
            }
        })
        .collect();
    let next_cursor = if has_more {
        matches.last().map(|item| {
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&SearchCursor {
                    version: 1,
                    search_key: key,
                    created_at: item.created_at,
                    message_id: item.message_id,
                })
                .expect("search cursor serialization"),
            )
        })
    } else {
        None
    };
    transaction
        .commit()
        .await
        .map_err(|_| internal_error("message search unavailable"))?;
    Ok(Json(SearchPage {
        matches,
        next_cursor,
        has_more,
    }))
}

/// Map Unicode-lowercased bytes back to half-open UTF-16 offsets in the original text.
fn highlight_ranges(text: &str, query: &str) -> Vec<MatchRange> {
    // Whole-string casing preserves contextual rules such as Greek final sigma,
    // matching the same transformation applied to the query and by PostgreSQL.
    let folded = text.to_lowercase();
    let mut offsets = Vec::new();
    let mut utf16 = 0;
    for character in text.chars() {
        let lower = character.to_lowercase().collect::<String>();
        offsets.extend(std::iter::repeat_n(
            (utf16, utf16 + character.len_utf16()),
            lower.len(),
        ));
        utf16 += character.len_utf16();
    }
    // Contextual sigma changes the character, but not its UTF-8 byte length.
    debug_assert_eq!(folded.len(), offsets.len());
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    folded
        .match_indices(&needle)
        .map(|(start, _)| MatchRange {
            start: offsets[start].0,
            end: offsets[start + needle.len() - 1].1,
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextQuery {
    message_id: Uuid,
    before: Option<i64>,
    after: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextPage {
    anchor_message_id: Uuid,
    messages: Vec<ConversationMessagePayload>,
    older_cursor: Option<Uuid>,
    newer_cursor: Option<Uuid>,
    has_older: bool,
    has_newer: bool,
}

fn lifecycle_is_hidden(metadata: Option<&serde_json::Value>, user_id: Uuid) -> bool {
    let key = format!("instafy_conversation_lifecycle_v1_{user_id}");
    metadata
        .and_then(|metadata| metadata.get(key))
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("status").and_then(serde_json::Value::as_str))
        })
        .is_some_and(|status| {
            matches!(
                status
                    .trim_matches(|character| LIFECYCLE_WHITESPACE.contains(character))
                    .to_ascii_lowercase()
                    .as_str(),
                "hidden" | "deleted"
            )
        })
}

async fn message_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<Uuid>,
    Query(params): Query<ContextQuery>,
) -> Result<Json<ContextPage>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let before = params.before.unwrap_or(20);
    let after = params.after.unwrap_or(20);
    if !(0..=50).contains(&before) || !(0..=50).contains(&after) {
        return Err(bad_request("before and after must be between 0 and 50"));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("message context unavailable"))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|_| internal_error("message context unavailable"))?;
    transaction.batch_execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout = '5s';").await.map_err(|_| internal_error("message context unavailable"))?;
    let conversation = load_conversation_record(&transaction, &conversation_id).await?;
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    crate::ensure_project_access(&transaction, &project, &context, None).await?;
    ensure_conversation_access(&transaction, &conversation, &context).await?;
    if lifecycle_is_hidden(conversation.metadata.as_ref(), user_id) {
        return Err(not_found("message not found"));
    }
    let anchor = transaction.query_opt("select * from conversation_messages where id = $1 and conversation_id = $2 and project_id = $3", &[&params.message_id, &conversation_id, &conversation.project_id]).await.map_err(|_| internal_error("message context unavailable"))?
        .ok_or_else(|| not_found("message not found"))?;
    let created_at: DateTime<Utc> = anchor.get("created_at");
    let older = transaction.query("select * from conversation_messages where conversation_id = $1 and project_id = $2 and (created_at,id) < ($3,$4) order by created_at desc,id desc limit $5", &[&conversation_id, &conversation.project_id, &created_at, &params.message_id, &(before + 1)]).await.map_err(|_| internal_error("message context unavailable"))?;
    let newer = transaction.query("select * from conversation_messages where conversation_id = $1 and project_id = $2 and (created_at,id) > ($3,$4) order by created_at asc,id asc limit $5", &[&conversation_id, &conversation.project_id, &created_at, &params.message_id, &(after + 1)]).await.map_err(|_| internal_error("message context unavailable"))?;
    let has_older = older.len() as i64 > before;
    let has_newer = newer.len() as i64 > after;
    let mut messages: Vec<_> = newer
        .iter()
        .take(after as usize)
        .rev()
        .chain(std::iter::once(&anchor))
        .chain(older.iter().take(before as usize))
        .map(|row| message_row_to_payload(&map_conversation_message_row(row)))
        .collect();
    let older_cursor = has_older.then(|| messages.last().expect("context anchor").id);
    let newer_cursor = has_newer.then(|| messages.first().expect("context anchor").id);
    transaction
        .commit()
        .await
        .map_err(|_| internal_error("message context unavailable"))?;
    Ok(Json(ContextPage {
        anchor_message_id: params.message_id,
        messages: std::mem::take(&mut messages),
        older_cursor,
        newer_cursor,
        has_older,
        has_newer,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_queries_escape_wildcards_and_bound_inputs() {
        assert_eq!(literal_pattern("50%_\\done"), "%50\\%\\_\\\\done%");
        let mut params = SearchQuery {
            q: "a".into(),
            project_id: None,
            org_id: None,
            personal: false,
            cursor: None,
            limit: None,
        };
        assert!(validate_query(&params).is_err());
        params.q = "  bug  ".into();
        assert_eq!(validate_query(&params).unwrap(), "bug");
        params.q = "needle\0".into();
        assert!(validate_query(&params).is_err());
        params.q = "x".repeat(201);
        assert!(validate_query(&params).is_err());
        params.q = "needle".into();
        params.org_id = Some(Uuid::new_v4());
        params.personal = true;
        assert!(validate_query(&params).is_err());
    }
    #[test]
    fn snippets_highlight_utf16_without_html_or_unicode_boundary_errors() {
        assert_eq!(
            highlight_ranges("😀 Café café <script>", "CAFÉ"),
            vec![
                MatchRange { start: 3, end: 7 },
                MatchRange { start: 8, end: 12 }
            ]
        );
        assert_eq!(
            highlight_ranges("İstanbul", "i"),
            vec![MatchRange { start: 0, end: 1 }]
        );
        assert_eq!(
            highlight_ranges("😀xx😀", "😀"),
            vec![
                MatchRange { start: 0, end: 2 },
                MatchRange { start: 4, end: 6 }
            ]
        );
    }

    #[test]
    fn contextual_greek_casing_matches_queries_and_keeps_original_utf16_offsets() {
        assert_eq!(
            highlight_ranges("ΟΣ", "ΟΣ"),
            vec![MatchRange { start: 0, end: 2 }]
        );
        for query in ["ΟΣ", "ος"] {
            assert_eq!(
                highlight_ranges("😀 ΟΣ · ος · ΟΣΤ", query),
                vec![
                    MatchRange { start: 3, end: 5 },
                    MatchRange { start: 8, end: 10 },
                ]
            );
        }
        // Final sigma in the standalone query is not the medial sigma in this word.
        assert!(highlight_ranges("ΟΣΤ", "ΟΣ").is_empty());
    }
    #[test]
    fn cursors_reject_other_queries_scopes_and_accounts() {
        let cursor = SearchCursor {
            version: 1,
            search_key: "owner-scope-query".into(),
            created_at: Utc::now(),
            message_id: Uuid::new_v4(),
        };
        let raw = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap());
        assert!(decode_cursor(&raw, "owner-scope-query").is_ok());
        assert!(decode_cursor(&raw, "other-owner").is_err());
        assert!(decode_cursor("invalid", "owner-scope-query").is_err());
    }
    #[test]
    fn hidden_lifecycle_is_viewer_scoped_and_accepts_both_existing_shapes() {
        let viewer = Uuid::new_v4();
        let key = format!("instafy_conversation_lifecycle_v1_{viewer}");
        for value in [
            serde_json::json!(" HIDDEN "),
            serde_json::json!({"status":"deleted"}),
        ] {
            let metadata = serde_json::json!({key.clone(): value});
            assert!(lifecycle_is_hidden(Some(&metadata), viewer));
            assert!(!lifecycle_is_hidden(Some(&metadata), Uuid::new_v4()));
        }
    }
}
