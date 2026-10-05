use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use axum::http::{Method, Uri};
use serde::Serialize;
use uuid::Uuid;

use crate::config::GitEventsWebhookConfig;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushRefUpdate {
    pub ref_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_rev: Option<String>,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushEventPayload {
    pub schema: String,
    pub kind: String,
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub default_branch: String,
    pub updates: Vec<GitPushRefUpdate>,
    pub received_at_ms: u64,
}

pub fn is_receive_pack_request(method: &Method, uri: &Uri) -> bool {
    if *method != Method::POST {
        return false;
    }
    uri.path().to_ascii_lowercase().contains("git-receive-pack")
}

/// Directory under the shard's repo root that holds one report file per push
/// in flight (see [`crate::policy::PUSH_REPORT_ENV`]). Its name does not end
/// in `.git`, so no Smart HTTP request can address it.
pub const PUSH_REPORTS_DIR_NAME: &str = ".instafy-push-reports";

/// Create the push report directory and remove reports an earlier process
/// left behind. Returns its absolute path.
pub fn prepare_push_reports_dir(repo_root: &Path) -> Result<PathBuf> {
    let dir = repo_root.join(PUSH_REPORTS_DIR_NAME);
    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            bail!("push report path {dir:?} must be a real directory");
        }
        Ok(_) => {
            for entry in
                std::fs::read_dir(&dir).with_context(|| format!("failed to list {dir:?}"))?
            {
                let path = entry
                    .with_context(|| format!("failed to list {dir:?}"))?
                    .path();
                std::fs::remove_file(&path)
                    .with_context(|| format!("failed to remove stale push report {path:?}"))?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&dir).with_context(|| format!("failed to create {dir:?}"))?;
        }
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect {dir:?}"));
        }
    }
    dir.canonicalize()
        .with_context(|| format!("failed to resolve {dir:?}"))
}

/// Turn the `<old> <new> <ref>` lines `post-receive` wrote for one push into
/// the event's updates: branches and tags only, sorted by name. These are the
/// updates that push made, so overlapping pushes never see each other's. A
/// created ref has no old revision and a deleted ref has no new one.
pub fn parse_push_report(report: &[u8]) -> Result<Vec<GitPushRefUpdate>> {
    let mut updates = BTreeMap::new();
    for (old_rev, new_rev, ref_name) in push_report_lines(report)? {
        if !ref_name.starts_with("refs/heads/") && !ref_name.starts_with("refs/tags/") {
            continue;
        }
        let old_rev = (!is_zero_object_id(old_rev)).then(|| old_rev.to_string());
        let new_rev = (!is_zero_object_id(new_rev)).then(|| new_rev.to_string());
        updates.insert(
            ref_name.to_string(),
            GitPushRefUpdate {
                ref_name: ref_name.to_string(),
                old_rev,
                deleted: new_rev.is_none(),
                new_rev,
            },
        );
    }
    Ok(updates.into_values().collect())
}

/// The refs one push created (no old revision), in any namespace, in the
/// order `post-receive` reported them. The shard logs these for salvage
/// pushes.
pub fn created_refs_in_push_report(report: &[u8]) -> Result<Vec<String>> {
    let mut created: Vec<String> = Vec::new();
    for (old_rev, new_rev, ref_name) in push_report_lines(report)? {
        if is_zero_object_id(old_rev)
            && !is_zero_object_id(new_rev)
            && !created.iter().any(|existing| existing == ref_name)
        {
            created.push(ref_name.to_string());
        }
    }
    Ok(created)
}

/// The `<old> <new> <ref>` lines of a push report, each checked.
fn push_report_lines(report: &[u8]) -> Result<Vec<(&str, &str, &str)>> {
    let text = std::str::from_utf8(report).context("push report is not utf-8")?;
    text.lines()
        .map(|line| {
            let mut fields = line.split(' ');
            let (Some(old_rev), Some(new_rev), Some(ref_name), None) =
                (fields.next(), fields.next(), fields.next(), fields.next())
            else {
                bail!("invalid push report line: {line:?}");
            };
            if !is_object_id(old_rev) || !is_object_id(new_rev) || !ref_name.starts_with("refs/") {
                bail!("invalid push report line: {line:?}");
            }
            Ok((old_rev, new_rev, ref_name))
        })
        .collect()
}

/// A SHA-1 or SHA-256 object id in lower-case hex.
fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_zero_object_id(value: &str) -> bool {
    value.bytes().all(|byte| byte == b'0')
}

pub fn build_push_event_payload(
    repo: &str,
    default_branch: &str,
    updates: Vec<GitPushRefUpdate>,
) -> Option<GitPushEventPayload> {
    if updates.is_empty() {
        return None;
    }

    let repo_name = repo.trim().to_string();
    if repo_name.is_empty() {
        return None;
    }

    let project_id = repo_name
        .trim_end_matches(".git")
        .trim()
        .parse::<Uuid>()
        .ok()
        .map(|value| value.to_string());

    Some(GitPushEventPayload {
        schema: "instafy.git-service.event.v1".to_string(),
        kind: "git.push.received".to_string(),
        repo: repo_name,
        project_id,
        default_branch: default_branch.trim().to_string(),
        updates,
        received_at_ms: now_unix_ms(),
    })
}

pub async fn dispatch_push_event(
    client: &reqwest::Client,
    webhook: &GitEventsWebhookConfig,
    payload: &GitPushEventPayload,
) -> Result<()> {
    let mut request = client.post(webhook.url.clone()).json(payload);
    if let Some(token) = webhook.token.as_deref() {
        request = request.bearer_auth(token);
    }

    let response = tokio::time::timeout(Duration::from_millis(webhook.timeout_ms), request.send())
        .await
        .map_err(|_| anyhow!("webhook request timed out after {}ms", webhook.timeout_ms))?
        .context("webhook request failed")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let preview = body.trim().chars().take(300).collect::<String>();
        return Err(anyhow!(
            "webhook rejected event: status={status} body={preview}"
        ));
    }

    Ok(())
}

fn now_unix_ms() -> u64 {
    let now = SystemTime::now();
    now.duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{build_push_event_payload, parse_push_report};

    #[test]
    fn push_report_lists_creates_updates_and_deletes_of_branches_and_tags() {
        let zero = "0".repeat(40);
        let (a, b, c) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let report = format!(
            "{a} {c} refs/heads/main\n\
             {zero} {b} refs/tags/v1\n\
             {b} {zero} refs/heads/old\n\
             {zero} {a} refs/instafy/recovery/x/y\n"
        );
        let updates = parse_push_report(report.as_bytes()).expect("parse report");
        let summary = updates
            .iter()
            .map(|update| {
                (
                    update.ref_name.as_str(),
                    update.old_rev.as_deref(),
                    update.new_rev.as_deref(),
                    update.deleted,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                ("refs/heads/main", Some(a.as_str()), Some(c.as_str()), false),
                ("refs/heads/old", Some(b.as_str()), None, true),
                ("refs/tags/v1", None, Some(b.as_str()), false),
            ]
        );
        assert!(parse_push_report(b"").expect("empty report").is_empty());
    }

    #[test]
    fn push_report_accepts_sha256_and_refuses_malformed_lines() {
        let (old, new) = ("1".repeat(64), "2".repeat(64));
        let updates = parse_push_report(format!("{old} {new} refs/heads/main\n").as_bytes())
            .expect("sha-256 report");
        assert_eq!(updates.len(), 1);

        let a = "a".repeat(40);
        for line in [
            format!("{a} {a}"),
            format!("{a} {a} refs/heads/main extra"),
            format!("{a} xyz refs/heads/main"),
            format!("{} {a} refs/heads/main", "A".repeat(40)),
            format!("{a} {a} heads/main"),
        ] {
            assert!(
                parse_push_report(format!("{line}\n").as_bytes()).is_err(),
                "{line:?} was accepted"
            );
        }
        assert!(parse_push_report(b"\xff\n").is_err());
    }

    #[test]
    fn build_payload_omits_invalid_project_id() {
        let payload = build_push_event_payload(
            "not-a-uuid.git",
            "main",
            vec![super::GitPushRefUpdate {
                ref_name: "refs/heads/main".to_string(),
                old_rev: Some("a".repeat(40)),
                new_rev: Some("b".repeat(40)),
                deleted: false,
            }],
        )
        .expect("payload");

        assert_eq!(payload.repo, "not-a-uuid.git");
        assert!(payload.project_id.is_none());
        assert_eq!(payload.kind, "git.push.received");
    }

    #[test]
    fn created_refs_lists_every_namespace_once_in_report_order() {
        let (zero, a, b) = ("0".repeat(40), "a".repeat(40), "b".repeat(40));
        let report = format!(
            "{zero} {a} refs/instafy/salvage/gateway/n-2\n\
             {a} {b} refs/heads/main\n\
             {zero} {b} refs/heads/feature\n\
             {a} {zero} refs/tags/old\n\
             {zero} {a} refs/instafy/salvage/gateway/n-1\n\
             {zero} {a} refs/instafy/salvage/gateway/n-2\n"
        );
        assert_eq!(
            super::created_refs_in_push_report(report.as_bytes()).unwrap(),
            vec![
                "refs/instafy/salvage/gateway/n-2",
                "refs/heads/feature",
                "refs/instafy/salvage/gateway/n-1",
            ]
        );
        assert!(super::created_refs_in_push_report(b"").unwrap().is_empty());
        assert!(super::created_refs_in_push_report(b"bad line\n").is_err());
    }

    #[test]
    fn push_reports_dir_is_created_and_cleared() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "instafy-git-push-reports-{}-{nanos}",
            std::process::id()
        ));
        let dir = super::prepare_push_reports_dir(&root).expect("create dir");
        assert!(dir.is_absolute());
        std::fs::write(dir.join("stale.push"), b"x").unwrap();
        assert_eq!(super::prepare_push_reports_dir(&root).expect("reuse"), dir);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
