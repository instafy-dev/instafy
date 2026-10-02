//! What an origin says about a save (`POST /git/sync`): where the work went,
//! which paths were left out and why, and where anything that did not reach
//! canonical `main` is kept. The post-turn checkpoint, the pre-turn refresh
//! and the `/sync` lane all read it, and the chat turn ends with one
//! "Not saved: <paths> (kept at <ref>)" sentence per group of paths that did
//! not reach `main`, so nothing is dropped without the user being told.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value as JsonValue;

/// At most this many paths are named in one sentence; the rest are counted.
const MAX_NAMED_PATHS: usize = 5;

/// A path the origin left out of a save.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RejectedPath {
    pub(crate) path: String,
    /// `excluded`, `secret`, `attachment`, `ignored`, `too_large`, `policy`
    /// or `unsupported`; empty when the origin did not say.
    pub(crate) reason: String,
    /// `main` kept its own earlier version of the path.
    pub(crate) kept_saved_version: bool,
}

/// The fields of a `/git/sync` body the runtime reads. The same shape comes
/// back on success and in a `not_saved` error (409 or 503), which carries the
/// report next to `error` and `code`. Unknown or malformed fields are ignored
/// so an older origin still yields its `rev`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginSaveResponse {
    #[serde(default, deserialize_with = "lenient_string")]
    pub(crate) rev: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub(crate) base_rev: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub(crate) git_sync_status: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub(crate) recovery_ref: Option<String>,
    #[serde(default, deserialize_with = "lenient_paths")]
    pub(crate) conflicted_paths: Vec<String>,
    #[serde(default, deserialize_with = "lenient_rejected_paths")]
    pub(crate) rejected_paths: Vec<RejectedPath>,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) unpushed_refs: Option<u64>,
    #[serde(default, deserialize_with = "lenient_bool")]
    pub(crate) checkout_moved: Option<bool>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub(crate) failure: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub(crate) error: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub(crate) code: Option<String>,
}

impl OriginSaveResponse {
    /// Parse a response body; anything unreadable is an empty response.
    pub(crate) fn parse(body: &str) -> Self {
        serde_json::from_str(body).unwrap_or_default()
    }

    /// Parse a report the origin produced in process.
    pub(crate) fn from_value(value: JsonValue) -> Self {
        serde_json::from_value(value).unwrap_or_default()
    }

    /// The origin answered `not_saved`: nothing reached `main`, and the
    /// report says where the work is kept.
    pub(crate) fn is_not_saved(&self) -> bool {
        self.code.as_deref() == Some("not_saved")
    }

    pub(crate) fn save_report(&self) -> SaveReport {
        SaveReport {
            status: self.git_sync_status.clone(),
            recovery_ref: self.recovery_ref.clone(),
            conflicted_paths: self.conflicted_paths.clone(),
            rejected_paths: self.rejected_paths.clone(),
        }
    }
}

/// What did not reach `main` in one save, and where it is kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SaveReport {
    /// The origin's own status: `published`, `partial`, `unchanged` or
    /// `unpublished`. `None` from an origin that does not report one.
    pub(crate) status: Option<String>,
    /// The recovery ref holding work that did not reach `main`.
    pub(crate) recovery_ref: Option<String>,
    /// Paths both sides changed: `main` kept its version and this
    /// checkout's version is on `recovery_ref`.
    pub(crate) conflicted_paths: Vec<String>,
    pub(crate) rejected_paths: Vec<RejectedPath>,
}

impl SaveReport {
    /// Some of the save reached `main` and some did not.
    pub(crate) fn is_partial(&self) -> bool {
        self.status.as_deref() == Some("partial")
            || !self.conflicted_paths.is_empty()
            || !self.rejected_paths.is_empty()
    }

    /// One "Not saved: ..." sentence per group of paths that did not reach
    /// `main`. `unsaved` lists the paths of a save that failed as a whole
    /// (empty when it did not), and `failure` says why.
    pub(crate) fn not_saved_sentences(
        &self,
        unsaved: &[String],
        failure: Option<&str>,
    ) -> Vec<String> {
        let mut sentences = Vec::new();
        let kept_at = self
            .recovery_ref
            .as_deref()
            .map(str::trim)
            .filter(|reference| !reference.is_empty());

        let named = |paths: &[String]| -> Vec<String> {
            let mut list = paths
                .iter()
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty())
                .collect::<Vec<_>>();
            list.sort();
            list.dedup();
            list
        };

        let conflicted = named(&self.conflicted_paths);
        if !conflicted.is_empty() {
            sentences.push(match kept_at {
                Some(reference) => format!(
                    "Not saved: {} (kept at {reference})",
                    describe_paths(&conflicted)
                ),
                None => format!("Not saved: {}", describe_paths(&conflicted)),
            });
        }

        let rejected_paths = self
            .rejected_paths
            .iter()
            .map(|rejected| rejected.path.clone())
            .collect::<Vec<_>>();
        let mut groups: Vec<(&'static str, Vec<String>)> = Vec::new();
        for rejected in &self.rejected_paths {
            let label = rejection_label(&rejected.reason);
            match groups.iter_mut().find(|(existing, _)| *existing == label) {
                Some((_, paths)) => paths.push(rejected.path.clone()),
                None => groups.push((label, vec![rejected.path.clone()])),
            }
        }
        for (label, paths) in groups {
            let paths = named(&paths);
            if !paths.is_empty() {
                sentences.push(format!("Not saved: {} ({label})", describe_paths(&paths)));
            }
        }

        // A save that failed as a whole: every path not already named.
        let remaining = named(
            &unsaved
                .iter()
                .filter(|path| !conflicted.contains(path) && !rejected_paths.contains(path))
                .cloned()
                .collect::<Vec<_>>(),
        );
        if !remaining.is_empty() {
            sentences.push(match kept_at {
                Some(reference) => format!(
                    "Not saved: {} (kept at {reference})",
                    describe_paths(&remaining)
                ),
                None => format!(
                    "Not saved: {} (still in the workspace; send /sync to try again)",
                    describe_paths(&remaining)
                ),
            });
        } else if sentences.is_empty()
            && let Some(failure) = failure
                .map(|value| value.trim().trim_end_matches('.'))
                .filter(|value| !value.is_empty())
            && self.status.as_deref() == Some("unpublished")
        {
            // An origin's `not_saved` error already reads
            // "Not saved: <why> (kept at <ref>)".
            sentences.push(if failure.starts_with("Not saved") {
                failure.to_string()
            } else {
                match kept_at {
                    Some(reference) => format!("Not saved: {failure} (kept at {reference})"),
                    None => format!("Not saved: {failure}"),
                }
            });
        }
        sentences
    }
}

/// Append each sentence (with a full stop) to the end of `summary`, on a new
/// paragraph, unless the summary already says it.
pub(crate) fn append_not_saved(summary: &mut String, sentences: &[String]) {
    for sentence in sentences {
        let sentence = format!("{}.", sentence.trim_end_matches('.'));
        if summary.contains(&sentence) {
            continue;
        }
        let trimmed_len = summary.trim_end().len();
        summary.truncate(trimmed_len);
        if !summary.is_empty() {
            summary.push_str("\n\n");
        }
        summary.push_str(&sentence);
    }
}

fn describe_paths(paths: &[String]) -> String {
    if paths.len() <= MAX_NAMED_PATHS {
        return paths.join(", ");
    }
    format!(
        "{} and {} more",
        paths[..MAX_NAMED_PATHS].join(", "),
        paths.len() - MAX_NAMED_PATHS
    )
}

fn rejection_label(reason: &str) -> &'static str {
    match reason {
        "ignored" => "ignored by .gitignore",
        "secret" => "secret files are never saved",
        "too_large" => "larger than 20 MiB",
        "unsupported" => "not a file that can be saved",
        _ => "excluded from saved versions",
    }
}

fn lenient_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match JsonValue::deserialize(deserializer)? {
        JsonValue::String(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        _ => None,
    })
}

fn lenient_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(JsonValue::deserialize(deserializer)?.as_u64())
}

fn lenient_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(JsonValue::deserialize(deserializer)?.as_bool())
}

fn lenient_paths<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match JsonValue::deserialize(deserializer)? {
        JsonValue::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                JsonValue::String(path) if !path.trim().is_empty() => Some(path),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    })
}

/// `rejectedPaths` entries are `{path, reason, keptSavedVersion}`; a bare
/// path string is accepted too.
fn lenient_rejected_paths<'de, D>(deserializer: D) -> Result<Vec<RejectedPath>, D::Error>
where
    D: Deserializer<'de>,
{
    let JsonValue::Array(items) = JsonValue::deserialize(deserializer)? else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match item {
            JsonValue::String(path) if !path.trim().is_empty() => Some(RejectedPath {
                path,
                ..RejectedPath::default()
            }),
            JsonValue::Object(map) => {
                let path = map.get("path")?.as_str()?.trim().to_string();
                if path.is_empty() {
                    return None;
                }
                Some(RejectedPath {
                    path,
                    reason: map
                        .get("reason")
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    kept_saved_version: map
                        .get("keptSavedVersion")
                        .and_then(JsonValue::as_bool)
                        .unwrap_or(false),
                })
            }
            _ => None,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_partial_publish_report() {
        let response = OriginSaveResponse::parse(
            r#"{"rev":"p","baseRev":"r","gitSyncStatus":"partial",
                "recoveryRef":"refs/instafy/recovery/o/20261002T101010Z-conflict-abc",
                "conflictedPaths":["src/a.rs"],
                "rejectedPaths":[{"path":".env","reason":"ignored","keptSavedVersion":false},
                                 {"path":"big.bin","reason":"too_large","keptSavedVersion":true},
                                 "legacy.txt", 7],
                "unpushedRefs":0,"checkoutMoved":true}"#,
        );
        assert_eq!(response.rev.as_deref(), Some("p"));
        assert_eq!(response.base_rev.as_deref(), Some("r"));
        let report = response.save_report();
        assert!(report.is_partial());
        assert_eq!(report.conflicted_paths, vec!["src/a.rs"]);
        assert_eq!(report.rejected_paths.len(), 3);
        assert_eq!(report.rejected_paths[1].reason, "too_large");
        assert!(report.rejected_paths[1].kept_saved_version);
        assert_eq!(report.rejected_paths[2].path, "legacy.txt");
        assert!(!response.is_not_saved());
    }

    #[test]
    fn an_older_origin_still_yields_its_rev() {
        let response = OriginSaveResponse::parse(r#"{"rev":"abc","baseRev":null}"#);
        assert_eq!(response.rev.as_deref(), Some("abc"));
        assert!(!response.save_report().is_partial());
        let response = OriginSaveResponse::parse(r#"{"rev":"abc","rejectedPaths":"nope"}"#);
        assert_eq!(response.rev.as_deref(), Some("abc"));
        assert!(OriginSaveResponse::parse("not json").rev.is_none());
    }

    #[test]
    fn not_saved_sentences_name_the_paths_and_where_they_are_kept() {
        let report = SaveReport {
            status: Some("partial".to_string()),
            recovery_ref: Some("refs/instafy/recovery/o/x-conflict-1".to_string()),
            conflicted_paths: vec!["src/b.rs".to_string(), "src/a.rs".to_string()],
            rejected_paths: vec![
                RejectedPath {
                    path: ".env".to_string(),
                    reason: "ignored".to_string(),
                    kept_saved_version: false,
                },
                RejectedPath {
                    path: "id_rsa".to_string(),
                    reason: "secret".to_string(),
                    kept_saved_version: false,
                },
            ],
        };
        assert_eq!(
            report.not_saved_sentences(&[], None),
            vec![
                "Not saved: src/a.rs, src/b.rs (kept at refs/instafy/recovery/o/x-conflict-1)",
                "Not saved: .env (ignored by .gitignore)",
                "Not saved: id_rsa (secret files are never saved)",
            ]
        );
    }

    #[test]
    fn a_failed_save_names_every_path_once() {
        let report = SaveReport {
            status: Some("unpublished".to_string()),
            recovery_ref: Some("refs/instafy/local-recovery/x-unpublished-2".to_string()),
            ..SaveReport::default()
        };
        let paths = (0..7).map(|n| format!("f{n}.md")).collect::<Vec<_>>();
        assert_eq!(
            report.not_saved_sentences(&paths, Some("the saved version kept changing")),
            vec![
                "Not saved: f0.md, f1.md, f2.md, f3.md, f4.md and 2 more (kept at refs/instafy/local-recovery/x-unpublished-2)"
            ]
        );
        let nothing_kept = SaveReport::default();
        assert_eq!(
            nothing_kept.not_saved_sentences(&["a.md".to_string()], Some("boom")),
            vec!["Not saved: a.md (still in the workspace; send /sync to try again)"]
        );
        assert_eq!(
            report.not_saved_sentences(&[], Some("could not reach the saved history")),
            vec![
                "Not saved: could not reach the saved history (kept at refs/instafy/local-recovery/x-unpublished-2)"
            ]
        );
        assert_eq!(
            report.not_saved_sentences(
                &[],
                Some("Not saved: the saved version kept changing (kept at refs/x)."),
            ),
            vec!["Not saved: the saved version kept changing (kept at refs/x)"]
        );
        assert!(
            SaveReport::default()
                .not_saved_sentences(&[], Some("boom"))
                .is_empty()
        );
    }

    #[test]
    fn appending_keeps_the_answer_and_never_repeats_a_sentence() {
        let mut summary = "Done: updated the README.\n".to_string();
        let sentences = vec!["Not saved: a.md (kept at refs/x)".to_string()];
        append_not_saved(&mut summary, &sentences);
        append_not_saved(&mut summary, &sentences);
        assert_eq!(
            summary,
            "Done: updated the README.\n\nNot saved: a.md (kept at refs/x)."
        );
        let mut empty = String::new();
        append_not_saved(&mut empty, &sentences);
        assert_eq!(empty, "Not saved: a.md (kept at refs/x).");
    }
}
