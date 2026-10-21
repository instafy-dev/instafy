//! Ask Octo from a site in a preview (docs/Bound-Sites.md §2a).
//!
//! Studio sends a click on a site's "Ask Octo" button as the clicker's own
//! chat message, with `metadata.siteIntent` saying where it came from:
//! `{previewId, askId, intent, ref, params, withheld?, coarsened?}`. Anyone
//! who can send a message can put that field in, so the controller never
//! trusts it: every dispatch takes it out of the client's metadata, checks
//! its shape and sizes, and puts it back only when the sender may see an
//! open preview with that id in this space. The kept copy adds the
//! preview's own title and port (the grant's, not the page's), and is what
//! the runtime shows Octo as page-provided data. The record-only paths drop
//! it outright: an ask always dispatches.
//!
//! The controller also caps one person's asks from one preview at six in ten
//! minutes, on top of the per-person prompt limit; Studio keeps one ask at a
//! time and the same six in its own tab.

use std::time::Duration;

use axum::{http::StatusCode, Json};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tracing::warn;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::{too_many_requests, ApiError, AppState};

pub(crate) const SITE_INTENT_KEY: &str = "siteIntent";
const SITE_INTENT_ALIASES: [&str; 2] = [SITE_INTENT_KEY, "site_intent"];
/// Nested copies of the message metadata a client could also fill in.
const NESTED_METADATA_KEYS: [&str; 3] = ["prompt_metadata", "promptMetadata", "details"];
/// The whole claim as JSON, and its params alone.
pub(crate) const SITE_INTENT_MAX_BYTES: usize = 4096;
pub(crate) const SITE_INTENT_PARAMS_MAX_BYTES: usize = 2048;
const SITE_INTENT_MAX_PARAMS: usize = 24;
const SITE_INTENT_MAX_DEPTH: usize = 3;
const SITE_INTENT_STRING_MAX_CHARS: usize = 500;
/// Asks one person may send from one preview in [`SITE_ASK_WINDOW`].
pub(crate) const SITE_ASKS_PER_WINDOW: usize = 6;
pub(crate) const SITE_ASK_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Removes every client-supplied site intent, top level and nested, and
/// returns the top-level one for [`verified_site_intent`] to check.
pub(crate) fn take_site_intent_claim(metadata: &mut JsonValue) -> Option<JsonValue> {
    let map = metadata.as_object_mut()?;
    let mut claim = None;
    for key in SITE_INTENT_ALIASES {
        if let Some(value) = map.remove(key) {
            claim.get_or_insert(value);
        }
    }
    for key in NESTED_METADATA_KEYS {
        if let Some(nested) = map.get_mut(key).and_then(JsonValue::as_object_mut) {
            for alias in SITE_INTENT_ALIASES {
                nested.remove(alias);
            }
        }
    }
    claim
}

/// A site intent whose shape and sizes are right; not yet checked against a preview.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SiteIntentClaim {
    pub(crate) preview_id: Uuid,
    pub(crate) ask_id: String,
    pub(crate) intent: String,
    pub(crate) site_ref: Option<String>,
    pub(crate) params: JsonMap<String, JsonValue>,
    pub(crate) withheld: Vec<String>,
    pub(crate) coarsened: Vec<String>,
}

fn is_param_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && key.len() <= 64
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn is_ask_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn is_intent_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
        && value.len() <= 48
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// `<collection>:<id>`, the bind protocol's ref (Bound-Sites.md §2).
fn is_site_ref(value: &str) -> bool {
    let Some((collection, id)) = value.split_once(':') else {
        return false;
    };
    let mut first = collection.chars();
    matches!(first.next(), Some(ch) if ch.is_ascii_alphanumeric())
        && collection.len() <= 48
        && first.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        && (1..=120).contains(&id.len())
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-'))
}

fn plain_value(value: &JsonValue, depth: usize) -> bool {
    match value {
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => true,
        JsonValue::String(text) => text.chars().count() <= SITE_INTENT_STRING_MAX_CHARS,
        JsonValue::Array(items) => {
            depth < SITE_INTENT_MAX_DEPTH
                && items.len() <= SITE_INTENT_MAX_PARAMS
                && items.iter().all(|item| plain_value(item, depth + 1))
        }
        JsonValue::Object(map) => {
            depth < SITE_INTENT_MAX_DEPTH
                && map.len() <= SITE_INTENT_MAX_PARAMS
                && map
                    .iter()
                    .all(|(key, item)| is_param_key(key) && plain_value(item, depth + 1))
        }
    }
}

fn param_names(value: Option<&JsonValue>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let items = value.as_array()?;
    if items.len() > SITE_INTENT_MAX_PARAMS {
        return None;
    }
    let mut names: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let name = item.as_str().filter(|name| is_param_key(name))?;
        if !names.iter().any(|known| known == name) {
            names.push(name.to_string());
        }
    }
    Some(names)
}

/// Checks a claim's shape and sizes. Anything odd refuses it whole.
pub(crate) fn parse_site_intent_claim(value: &JsonValue) -> Option<SiteIntentClaim> {
    if serde_json::to_vec(value).ok()?.len() > SITE_INTENT_MAX_BYTES {
        return None;
    }
    let map = value.as_object()?;
    let preview_id = map
        .get("previewId")
        .and_then(JsonValue::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())?;
    let ask_id = map
        .get("askId")
        .and_then(JsonValue::as_str)
        .filter(|id| is_ask_id(id))?
        .to_string();
    let intent = map
        .get("intent")
        .and_then(JsonValue::as_str)
        .filter(|name| is_intent_name(name))?
        .to_string();
    let site_ref = match map.get("ref") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) if is_site_ref(value) => Some(value.clone()),
        Some(_) => return None,
    };
    let params = match map.get("params") {
        None => JsonMap::new(),
        Some(JsonValue::Object(params)) => params.clone(),
        Some(_) => return None,
    };
    if params.len() > SITE_INTENT_MAX_PARAMS
        || !params
            .iter()
            .all(|(key, value)| is_param_key(key) && plain_value(value, 1))
        || serde_json::to_vec(&params).ok()?.len() > SITE_INTENT_PARAMS_MAX_BYTES
    {
        return None;
    }
    Some(SiteIntentClaim {
        preview_id,
        ask_id,
        intent,
        site_ref,
        params,
        withheld: param_names(map.get("withheld"))?,
        coarsened: param_names(map.get("coarsened"))?,
    })
}

/// What the controller knows about the preview an ask came from (its grant).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SitePreviewFacts {
    pub(crate) title: String,
    pub(crate) port: u16,
}

impl SiteIntentClaim {
    /// The copy the controller keeps: the checked fields plus the preview's own title and port.
    pub(crate) fn verified_json(&self, site: &SitePreviewFacts) -> JsonValue {
        let mut value = json!({
            "previewId": self.preview_id.to_string(),
            "askId": self.ask_id,
            "intent": self.intent,
            "ref": self.site_ref,
            "params": self.params,
            "site": { "title": site.title, "port": site.port },
            "verified": true,
        });
        let map = value.as_object_mut().unwrap_or_else(|| unreachable!());
        if !self.withheld.is_empty() {
            map.insert("withheld".to_string(), json!(self.withheld));
        }
        if !self.coarsened.is_empty() {
            map.insert("coarsened".to_string(), json!(self.coarsened));
        }
        value
    }
}

/// The checked site intent to keep on this dispatch, or None to drop the
/// claim: no user, a malformed claim, or a preview the sender cannot see
/// open in this space. `count` charges the per-person, per-preview cap (a
/// send-queue drain re-checks a claim that was already charged).
pub(crate) async fn verified_site_intent(
    state: &AppState,
    project_id: &Uuid,
    context: &RequestContext,
    claim: &JsonValue,
    count: bool,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let Some(user_id) = context.user_id else {
        return Ok(None);
    };
    let Some(claim) = parse_site_intent_claim(claim) else {
        warn!(%project_id, "dropped a malformed site intent from a message");
        return Ok(None);
    };
    let Some(site) =
        crate::previews::site_intent_preview(state, project_id, &user_id, &claim.preview_id)
            .await?
    else {
        warn!(%project_id, "dropped a site intent naming no open preview the sender can see");
        return Ok(None);
    };
    if count {
        state
            .rate_limiter
            .enforce(
                format!("site-ask:{user_id}:{}", claim.preview_id),
                SITE_ASKS_PER_WINDOW,
                SITE_ASK_WINDOW,
            )
            .await
            .map_err(|limit| {
                let minutes = limit.retry_after.as_secs().div_ceil(60).max(1);
                too_many_requests(format!(
                    "You asked from this site {SITE_ASKS_PER_WINDOW} times in 10 minutes. Try again in {minutes} min."
                ))
            })?;
    }
    Ok(Some(claim.verified_json(&site)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim() -> JsonValue {
        json!({
            "previewId": "11111111-1111-4111-8111-111111111111",
            "askId": "int_m1abc_x7k2",
            "intent": "check_size",
            "ref": "shoes:karhu-ikoni-3",
            "params": { "size": "10", "near": "52.37, 4.895", "position": { "lat": 52.37 } },
            "withheld": ["note"],
            "coarsened": ["near"],
        })
    }

    #[test]
    fn takes_every_client_copy_out_of_the_metadata() {
        let mut metadata = json!({
            "siteIntent": claim(),
            "site_intent": { "askId": "other" },
            "prompt_metadata": { "siteIntent": claim() },
            "details": { "site_intent": claim() },
            "agentSelection": { "mentions": ["octo"] },
        });
        assert_eq!(take_site_intent_claim(&mut metadata), Some(claim()));
        assert_eq!(
            metadata,
            json!({ "prompt_metadata": {}, "details": {}, "agentSelection": { "mentions": ["octo"] } })
        );
        assert_eq!(take_site_intent_claim(&mut json!("text")), None);
    }

    #[test]
    fn a_claim_is_read_only_when_every_field_has_its_shape_and_size() {
        let parsed = parse_site_intent_claim(&claim()).expect("valid claim");
        assert_eq!(parsed.intent, "check_size");
        assert_eq!(parsed.site_ref.as_deref(), Some("shoes:karhu-ikoni-3"));
        assert_eq!(parsed.withheld, vec!["note".to_string()]);
        let kept = parsed.verified_json(&SitePreviewFacts {
            title: "Running shoes".to_string(),
            port: 4180,
        });
        assert_eq!(
            kept["site"],
            json!({ "title": "Running shoes", "port": 4180 })
        );
        assert_eq!(kept["verified"], json!(true));
        assert_eq!(kept["params"], claim()["params"]);

        let broken: [(&str, JsonValue); 12] = [
            ("previewId", json!("not-a-uuid")),
            ("askId", json!("../x")),
            ("intent", json!("Bad Name")),
            ("ref", json!("no colon")),
            ("ref", json!(7)),
            ("params", json!("size=10")),
            ("params", json!({ "bad key": 1 })),
            ("params", json!({ "blob": "x".repeat(501) })),
            ("params", json!({ "a": { "b": { "c": { "d": 1 } } } })),
            (
                "params",
                json!({ "a": "x".repeat(400), "b": "x".repeat(400), "c": "x".repeat(400), "d": "x".repeat(400), "e": "x".repeat(400), "f": "x".repeat(400) }),
            ),
            ("withheld", json!("note")),
            ("coarsened", json!(["bad key"])),
        ];
        for (field, value) in broken {
            let mut forged = claim();
            forged[field] = value;
            assert_eq!(parse_site_intent_claim(&forged), None, "{field}");
        }
        let mut huge = claim();
        huge["padding"] = json!("x".repeat(SITE_INTENT_MAX_BYTES));
        assert_eq!(parse_site_intent_claim(&huge), None);
    }
}
