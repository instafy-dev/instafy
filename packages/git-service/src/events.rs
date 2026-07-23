use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
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

pub fn snapshot_refs(repo_path: &Path) -> Result<BTreeMap<String, String>> {
    let repo_str = repo_path
        .to_str()
        .ok_or_else(|| anyhow!("repo path is not valid utf-8"))?;

    let output = Command::new("git")
        .args(["-C", repo_str, "show-ref", "--heads", "--tags"])
        .output()
        .with_context(|| format!("failed to read refs for {:?}", repo_path))?;

    if !output.status.success() {
        // `git show-ref` exits with status 1 when there are no refs; that's not an error here.
        if output.status.code() == Some(1) {
            let stdout_trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr_trimmed = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stdout_trimmed.is_empty()
                && (stderr_trimmed.is_empty() || stderr_trimmed.contains("No references"))
            {
                return Ok(BTreeMap::new());
            }
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!("git show-ref failed: {stderr}"));
    }

    parse_show_ref_output(&output.stdout)
}

pub fn diff_refs(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> Vec<GitPushRefUpdate> {
    let mut keys = BTreeSet::new();
    keys.extend(before.keys().cloned());
    keys.extend(after.keys().cloned());

    let mut updates = Vec::new();
    for ref_name in keys {
        let old_rev = before.get(&ref_name).cloned();
        let new_rev = after.get(&ref_name).cloned();
        if old_rev == new_rev {
            continue;
        }
        updates.push(GitPushRefUpdate {
            ref_name,
            old_rev,
            deleted: new_rev.is_none(),
            new_rev,
        });
    }

    updates
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

fn parse_show_ref_output(stdout: &[u8]) -> Result<BTreeMap<String, String>> {
    let mut refs = BTreeMap::new();
    let text = String::from_utf8(stdout.to_vec()).context("git show-ref returned non-utf8")?;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let rev = parts.next().unwrap_or_default().trim();
        let ref_name = parts.next().unwrap_or_default().trim();
        if rev.is_empty() || ref_name.is_empty() {
            return Err(anyhow!("invalid show-ref line: {trimmed}"));
        }
        refs.insert(ref_name.to_string(), rev.to_string());
    }
    Ok(refs)
}

fn now_unix_ms() -> u64 {
    let now = SystemTime::now();
    now.duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{build_push_event_payload, diff_refs, parse_show_ref_output};

    #[test]
    fn parse_show_ref_output_extracts_refs() {
        let refs = parse_show_ref_output(
            b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v1\n",
        )
        .expect("parse refs");

        assert_eq!(
            refs.get("refs/heads/main").map(String::as_str),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            refs.get("refs/tags/v1").map(String::as_str),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
    }

    #[test]
    fn diff_refs_marks_creates_updates_and_deletes() {
        let before = BTreeMap::from([
            (
                "refs/heads/main".to_string(),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            ),
            (
                "refs/heads/old".to_string(),
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            ),
        ]);
        let after = BTreeMap::from([
            (
                "refs/heads/main".to_string(),
                "cccccccccccccccccccccccccccccccccccccccc".to_string(),
            ),
            (
                "refs/heads/new".to_string(),
                "dddddddddddddddddddddddddddddddddddddddd".to_string(),
            ),
        ]);

        let updates = diff_refs(&before, &after);
        assert_eq!(updates.len(), 3);
        assert!(updates
            .iter()
            .any(|update| update.ref_name == "refs/heads/new"
                && update.old_rev.is_none()
                && update.new_rev.as_deref() == Some("dddddddddddddddddddddddddddddddddddddddd")));
        assert!(updates
            .iter()
            .any(|update| update.ref_name == "refs/heads/old"
                && update.deleted
                && update.new_rev.is_none()));
        assert!(updates
            .iter()
            .any(|update| update.ref_name == "refs/heads/main"
                && update.old_rev.as_deref() == Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                && update.new_rev.as_deref() == Some("cccccccccccccccccccccccccccccccccccccccc")));
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
}
