//! What the salvage asks the controller for: git credentials minted with the
//! gateway's internal token, and the export of legacy chat images. Kept
//! behind a trait so the tests run the salvage against local repositories.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::ServerConfig;
use crate::git_tokens::mint_git_access_token;

/// Where a legacy chat image went.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportedTo {
    pub conversation_id: Uuid,
    pub storage_path: String,
    #[serde(default)]
    pub messages: usize,
}

/// The controller's answer to one image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ExportOutcome {
    /// Stored for each listed conversation.
    Exported(Vec<ExportedTo>),
    /// Not stored, and a rerun would get the same answer (no message names
    /// it, not an image, the space is gone); the salvage keeps it in the
    /// private archive.
    Kept(String),
    /// Not stored, but a rerun may store it (no Storage or no route yet, a
    /// credential the controller refused, a server error, a timeout, no
    /// answer); the salvage keeps it in the private archive and the entry
    /// waits for that rerun.
    Failed(String),
}

pub(crate) trait Services {
    /// A `git.read` credential for the space's canonical repository, or
    /// `None` when the gateway has no internal token (a local remote).
    fn read_token(&self, project: &Uuid) -> Result<Option<String>>;
    /// A `git.salvage` credential: it may only create salvage refs, and only
    /// through a push.
    fn salvage_token(&self, project: &Uuid) -> Result<String>;
    fn export_attachment(
        &self,
        project: &Uuid,
        workspace_path: &str,
        bytes: Vec<u8>,
    ) -> ExportOutcome;
}

/// The controller, called with the gateway's internal token.
pub(crate) struct ControllerServices {
    runtime: tokio::runtime::Handle,
    client: reqwest::Client,
    config: ServerConfig,
}

const EXPORT_TIMEOUT: Duration = Duration::from_secs(180);

impl ControllerServices {
    /// From the gateway's environment: `ORIGIN_CONTROLLER_URL` and
    /// `ORIGIN_INTERNAL_TOKEN`. Call from a thread that may block on
    /// `runtime`.
    pub(crate) fn from_env(
        runtime: tokio::runtime::Handle,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let controller =
            env("ORIGIN_CONTROLLER_URL").unwrap_or_else(|| "http://127.0.0.1:8788".to_string());
        let controller_base_url: reqwest::Url = controller
            .trim()
            .trim_end_matches('/')
            .parse()
            .context("invalid ORIGIN_CONTROLLER_URL")?;
        let jwks_url = controller_base_url
            .join(".well-known/jwks.json")
            .context("invalid ORIGIN_CONTROLLER_URL")?;
        let config = ServerConfig {
            project_id: Uuid::nil(),
            origin_id: Uuid::nil(),
            workspace_root: std::path::PathBuf::from("."),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: String::new(),
            git_author_email: String::new(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url,
            controller_internal_token: env("ORIGIN_INTERNAL_TOKEN")
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty()),
            controller_token_source: None,
            jwks_url,
            skip_auth: false,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(60),
            max_archive_bytes: 0,
            staging_base: None,
            multi_tenant: true,
            hosted_checkout: false,
        };
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .context("failed to build the HTTP client")?;
        Ok(Self {
            runtime,
            client,
            config,
        })
    }

    fn mint(&self, project: &Uuid, scope: &str) -> Result<Option<String>> {
        let minted = self
            .runtime
            .block_on(mint_git_access_token(
                &self.client,
                &self.config,
                *project,
                &[scope],
                None,
            ))
            .map_err(|error| anyhow::anyhow!("could not mint {scope}: {error}"))?;
        Ok(minted.map(|minted| minted.token))
    }
}

impl Services for ControllerServices {
    fn read_token(&self, project: &Uuid) -> Result<Option<String>> {
        self.mint(project, "git.read")
    }

    fn salvage_token(&self, project: &Uuid) -> Result<String> {
        if self.config.controller_internal_token.is_none() {
            bail!("ORIGIN_INTERNAL_TOKEN is required to mint git.salvage");
        }
        self.mint(project, GIT_SALVAGE_SCOPE)?
            .context("the controller minted no git.salvage token")
    }

    fn export_attachment(
        &self,
        project: &Uuid,
        workspace_path: &str,
        bytes: Vec<u8>,
    ) -> ExportOutcome {
        let Some(token) = self.config.controller_internal_token.as_deref() else {
            return ExportOutcome::Failed("no ORIGIN_INTERNAL_TOKEN to export with".to_string());
        };
        let mut url = self.config.controller_base_url.clone();
        match url.path_segments_mut() {
            Ok(mut segments) => {
                segments.pop_if_empty().extend([
                    "internal",
                    "projects",
                    &project.as_hyphenated().to_string(),
                    "chat-attachments",
                    "legacy",
                ]);
            }
            Err(()) => return ExportOutcome::Failed("ORIGIN_CONTROLLER_URL has no path".into()),
        }
        url.query_pairs_mut()
            .append_pair("workspacePath", workspace_path);
        let request = self
            .client
            .post(url)
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .timeout(EXPORT_TIMEOUT)
            .body(bytes);
        self.runtime.block_on(async move {
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    return ExportOutcome::Failed(format!(
                        "the export request failed: {}",
                        error.without_url()
                    ))
                }
            };
            let status = response.status();
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            interpret_export(status.as_u16(), &body)
        })
    }
}

/// `runtime_contracts::GIT_SALVAGE_SCOPE`: the controller mints it only for
/// its own credential, alone, for 120 seconds.
const GIT_SALVAGE_SCOPE: &str = "git.salvage";

/// What an export answer means for the file. Only answers about the file
/// or the space itself are final; anything else (no Storage, a route that is
/// not deployed yet and answers 404 without a code, a refused credential, a
/// server error) may change by a rerun.
pub(crate) fn interpret_export(status: u16, body: &serde_json::Value) -> ExportOutcome {
    if status == 200 {
        let exported: Vec<ExportedTo> = body
            .get("exported")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        return if exported.is_empty() {
            ExportOutcome::Kept("no message names this file".to_string())
        } else {
            ExportOutcome::Exported(exported)
        };
    }
    let code = body.get("code").and_then(serde_json::Value::as_str);
    let text = format!(
        "the controller answered {status} ({})",
        code.unwrap_or("unknown")
    );
    let file_or_space =
        matches!(status, 400 | 413 | 415) || (status == 404 && code == Some("project_not_found"));
    if file_or_space && code.is_some() {
        ExportOutcome::Kept(text)
    } else {
        ExportOutcome::Failed(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn export_answers_are_read_conservatively() {
        let conversation = Uuid::new_v4();
        assert_eq!(
            interpret_export(
                200,
                &json!({ "exported": [{
                    "conversationId": conversation, "storagePath": "p/c/x.png", "messages": 2
                }], "unreferenced": false })
            ),
            ExportOutcome::Exported(vec![ExportedTo {
                conversation_id: conversation,
                storage_path: "p/c/x.png".to_string(),
                messages: 2,
            }])
        );
        // Final: the answer is about the file or the space.
        for (status, body) in [
            (200, json!({ "exported": [], "unreferenced": true })),
            (200, json!({ "exported": "nonsense" })),
            (400, json!({ "code": "invalid_workspace_path" })),
            (400, json!({ "code": "empty_file" })),
            (413, json!({ "code": "too_large" })),
            (415, json!({ "code": "unsupported_image" })),
            (404, json!({ "code": "project_not_found" })),
        ] {
            assert!(
                matches!(interpret_export(status, &body), ExportOutcome::Kept(_)),
                "{status} {body}"
            );
        }
        // A rerun may export it.
        for (status, body) in [
            (409, json!({ "code": "attachments_unavailable" })),
            (404, json!(null)),
            (404, json!({ "message": "not found" })),
            (403, json!({ "code": "service_authentication_required" })),
            (401, json!(null)),
            (500, json!(null)),
            (502, json!({ "code": "storage_upload_failed" })),
            (503, json!(null)),
            (400, json!(null)),
        ] {
            assert!(
                matches!(interpret_export(status, &body), ExportOutcome::Failed(_)),
                "{status} {body}"
            );
        }
    }
}
