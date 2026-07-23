use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Url;
use uuid::Uuid;

pub const MAX_APPLY_MANIFEST_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub project_id: Uuid,
    pub origin_id: Uuid,
    pub workspace_root: PathBuf,
    pub git_remote_url: Option<String>,
    pub git_remote_base_url: Option<String>,
    pub git_branch: String,
    pub git_remote_name: String,
    pub git_author_name: String,
    pub git_author_email: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub controller_base_url: Url,
    pub controller_internal_token: Option<String>,
    pub jwks_url: Url,
    pub skip_auth: bool,
    pub enable_presence_heartbeat: bool,
    pub presence_interval: Duration,
    pub max_archive_bytes: u64,
    pub staging_base: Option<PathBuf>,
    pub multi_tenant: bool,
}

impl ServerConfig {
    pub fn staging_root_for_workspace(&self, workspace_root: &Path) -> PathBuf {
        if let Some(custom) = &self.staging_base {
            return custom.clone();
        }
        workspace_root
            .join(".instafy")
            .join("origin-staging")
            .join(self.origin_id.to_string())
    }

    pub fn canonical_workspace_root(&self) -> Result<PathBuf> {
        canonicalize(&self.workspace_root)
    }

    pub fn workspace_root_for_project(&self, project_id: Uuid) -> PathBuf {
        if self.multi_tenant {
            self.workspace_root.join(project_id.to_string())
        } else {
            self.workspace_root.clone()
        }
    }

    pub fn git_remote_url_for_project(&self, project_id: Uuid) -> Option<String> {
        if let Some(url) = self.git_remote_url.as_deref() {
            let trimmed = url.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(base) = self.git_remote_base_url.as_deref() {
            let trimmed = base.trim().trim_end_matches('/');
            if !trimmed.is_empty() {
                return Some(format!("{trimmed}/{}.git", project_id));
            }
        }
        None
    }

    pub fn controller_commit_receipt_url(&self) -> Result<Url> {
        let mut url = self.controller_base_url.clone();
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("controller base url missing path segments"))?
            .extend(["commit", "receipt"]);
        Ok(url)
    }

    pub fn controller_presence_url(&self) -> Result<Url> {
        if self.multi_tenant {
            anyhow::bail!("presence beats are not supported in multi-tenant mode");
        }
        let mut url = self.controller_base_url.clone();
        // Prefer project-scoped presence beats to avoid ambiguous routing and 404s
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("controller base url missing path segments"))?
            .extend([
                "projects",
                &self.project_id.to_string(),
                "origin",
                "presence",
                "beat",
            ]);
        Ok(url)
    }
}

fn canonicalize(path: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(path).with_context(|| format!("failed to canonicalize {:?}", path))
}
