use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use anyhow::{Context, Result};

use crate::config::GitShardConfig;
use crate::error::ServiceError;

const INIT_COMMIT_MESSAGE: &str = "instafy: init";

const INSTAFY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/INSTAFY.md"
));
const AGENTS_DOC_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/AGENTS.md"
));
const CLAUDE_DOC_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/CLAUDE.md"
));
const AGENTS_SCRIPT_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/AGENTS.py"
));
const LEARNING_POLICY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-learning-policy/SKILL.md"
));
const GIT_CANONICAL_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-git-canonical-sync/SKILL.md"
));
const GIT_CANONICAL_CONFLICTS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-git-canonical-conflicts/SKILL.md"
));
const RUNTIME_FLAVORS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-runtime-flavors/SKILL.md"
));
const SECRETS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-secrets/SKILL.md"
));
const FRONTEND_PREVIEWS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-frontend-previews/SKILL.md"
));
const INTEGRATION_ONBOARDING_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-integration-onboarding/SKILL.md"
));
const BYOC_AI_CREDENTIALS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-byoc-ai-credentials/SKILL.md"
));
const AGENT_COLLABORATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-agent-collaboration/SKILL.md"
));
const DIAGNOSTICS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-diagnostics/SKILL.md"
));
const DIAGNOSTICS_OPENAI_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-diagnostics/agents/openai.yaml"
));
const GROUP_PARTICIPATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-group-participation/SKILL.md"
));
const AUTOMATIONS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-automations/SKILL.md"
));
const PERSISTENT_CONTEXTS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-persistent-contexts/SKILL.md"
));
const SKILL_IMPORT_COMPAT_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-skill-import-compat/SKILL.md"
));

pub fn ensure_repo_exists(
    config: &GitShardConfig,
    repo_dir: &str,
) -> Result<PathBuf, ServiceError> {
    // Push policy and `http.receivepack` come from the shard's shared hooks
    // directory and the `git http-backend` environment, so an existing
    // repository needs no per-request file writes or `git config` spawns.
    let repo_path = config.repo_root.join(repo_dir);
    if repo_path.exists() {
        return Ok(repo_path);
    }

    if !config.auto_init {
        return Err(ServiceError::not_found("repo not found"));
    }

    std::fs::create_dir_all(&config.repo_root).map_err(|error| {
        ServiceError::internal(format!(
            "failed to create repo root {:?}: {error}",
            config.repo_root
        ))
    })?;

    init_bare_repo(&repo_path, &config.default_branch)
        .map_err(|error| ServiceError::internal(error.to_string()))?;
    seed_initial_commit(&repo_path, &config.default_branch)
        .map_err(|error| ServiceError::internal(error.to_string()))?;

    Ok(repo_path)
}

/// Delete one canonical project bare repository.
///
/// The caller must still authenticate and classify the HTTP request. This
/// filesystem boundary repeats the important route constraints so a future
/// shard caller cannot turn an arbitrary string into a recursive delete.
pub fn delete_bare_repo(config: &GitShardConfig, repo_dir: &str) -> Result<(), ServiceError> {
    let repo_name = repo_dir
        .strip_suffix(".git")
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ServiceError::bad_request("invalid repository deletion target"))?;
    let project_id = uuid::Uuid::parse_str(repo_name)
        .ok()
        .filter(|project_id| project_id.to_string() == repo_name)
        .ok_or_else(|| {
            ServiceError::bad_request(
                "repository deletion requires a canonical lowercase UUID repo name",
            )
        })?;
    if repo_dir != format!("{project_id}.git") {
        return Err(ServiceError::bad_request(
            "repository deletion target must be one direct repo-root child",
        ));
    }

    let root_metadata = std::fs::symlink_metadata(&config.repo_root).map_err(|error| {
        ServiceError::internal(format!(
            "failed to inspect configured repo root {:?}: {error}",
            config.repo_root
        ))
    })?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(ServiceError::internal(
            "configured repo root must be a real directory",
        ));
    }
    let canonical_root = config.repo_root.canonicalize().map_err(|error| {
        ServiceError::internal(format!(
            "failed to resolve configured repo root {:?}: {error}",
            config.repo_root
        ))
    })?;

    #[cfg(unix)]
    let root_device = root_metadata.dev();

    let repo_path = config.repo_root.join(repo_dir);
    let repo_metadata = match std::fs::symlink_metadata(&repo_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ServiceError::not_found("repo not found"));
        }
        Err(error) => {
            return Err(ServiceError::internal(format!(
                "failed to inspect repository deletion target {:?}: {error}",
                repo_path
            )));
        }
    };
    if repo_metadata.file_type().is_symlink() {
        return Err(ServiceError::bad_request(
            "repository deletion target must not be a symlink",
        ));
    }
    if !repo_metadata.is_dir() {
        return Err(ServiceError::bad_request(
            "repository deletion target must be a directory",
        ));
    }

    #[cfg(unix)]
    ensure_expected_device(&repo_path, repo_metadata.dev(), root_device)?;

    let canonical_repo = repo_path.canonicalize().map_err(|error| {
        ServiceError::internal(format!(
            "failed to resolve repository deletion target {:?}: {error}",
            repo_path
        ))
    })?;
    if canonical_repo.parent() != Some(canonical_root.as_path()) {
        return Err(ServiceError::bad_request(
            "repository deletion target escaped the configured repo root",
        ));
    }

    // Refuse to recursively remove an arbitrary UUID-named directory if the
    // volume was misconfigured or corrupted. These are the stable structural
    // markers written by `git init --bare`.
    ensure_bare_repo_marker(&canonical_repo.join("HEAD"), false)?;
    ensure_bare_repo_marker(&canonical_repo.join("config"), false)?;
    ensure_bare_repo_marker(&canonical_repo.join("objects"), true)?;
    ensure_bare_repo_marker(&canonical_repo.join("refs"), true)?;

    // `remove_dir_all` can otherwise descend into a nested bind mount or
    // mountpoint. Preserve the old cleanup's `find -xdev` containment by
    // rejecting the entire operation before deletion when any entry crosses
    // the repository root's filesystem boundary.
    #[cfg(unix)]
    ensure_tree_on_device(&canonical_repo, root_device)?;

    std::fs::remove_dir_all(&canonical_repo).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ServiceError::not_found("repo not found")
        } else {
            ServiceError::internal(format!(
                "failed to delete bare repository {:?}: {error}",
                canonical_repo
            ))
        }
    })?;
    Ok(())
}

#[cfg(unix)]
fn ensure_tree_on_device(root: &Path, expected_device: u64) -> Result<(), ServiceError> {
    ensure_tree_on_device_with(root, expected_device, |_, metadata| metadata.dev())
}

#[cfg(unix)]
fn ensure_tree_on_device_with<F>(
    root: &Path,
    expected_device: u64,
    device_for: F,
) -> Result<(), ServiceError>
where
    F: Fn(&Path, &std::fs::Metadata) -> u64,
{
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            ServiceError::internal(format!(
                "failed to inspect repository deletion entry {:?}: {error}",
                path
            ))
        })?;
        ensure_expected_device(&path, device_for(&path, &metadata), expected_device)?;

        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            let entries = std::fs::read_dir(&path).map_err(|error| {
                ServiceError::internal(format!(
                    "failed to enumerate repository deletion entry {:?}: {error}",
                    path
                ))
            })?;
            for entry in entries {
                let entry = entry.map_err(|error| {
                    ServiceError::internal(format!(
                        "failed to enumerate repository deletion entry {:?}: {error}",
                        path
                    ))
                })?;
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_expected_device(
    path: &Path,
    actual_device: u64,
    expected_device: u64,
) -> Result<(), ServiceError> {
    if actual_device != expected_device {
        return Err(ServiceError::bad_request(format!(
            "repository deletion entry {:?} crosses a filesystem boundary",
            path
        )));
    }
    Ok(())
}

fn ensure_bare_repo_marker(path: &Path, directory: bool) -> Result<(), ServiceError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        ServiceError::bad_request("repository deletion target is not a bare git repository")
    })?;
    let expected_type = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    if metadata.file_type().is_symlink() || !expected_type {
        return Err(ServiceError::bad_request(
            "repository deletion target is not a bare git repository",
        ));
    }
    Ok(())
}

fn write_git_object(
    repo_str: &str,
    args: &[&str],
    stdin_bytes: &[u8],
    context: &str,
) -> Result<String> {
    use std::io::Write;

    let mut child = Command::new("git")
        .args(["-C", repo_str])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .with_context(|| context.to_string())?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("failed to open stdin for {context}"))?;
        stdin
            .write_all(stdin_bytes)
            .with_context(|| format!("failed to write stdin for {context}"))?;
    }

    let output = child
        .wait_with_output()
        .with_context(|| format!("failed to wait for {context}"))?;
    if !output.status.success() {
        anyhow::bail!(
            "{context}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        anyhow::bail!("{context}: returned empty output");
    }
    Ok(value)
}

fn write_blob(repo_str: &str, contents: &str) -> Result<String> {
    write_git_object(
        repo_str,
        &["hash-object", "-w", "--stdin"],
        contents.as_bytes(),
        "git hash-object failed",
    )
}

fn write_tree(repo_str: &str, entries: &[(&str, &str, &str, &str)]) -> Result<String> {
    let mut entries = entries.to_vec();
    entries.sort_by(|a, b| a.3.cmp(b.3));
    let input = entries
        .iter()
        .map(|(mode, kind, hash, name)| format!("{mode} {kind} {hash}\t{name}\n"))
        .collect::<String>();

    write_git_object(repo_str, &["mktree"], input.as_bytes(), "git mktree failed")
}

fn init_bare_repo(repo_path: &Path, default_branch: &str) -> Result<()> {
    let repo_str = repo_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("repo path is not valid utf-8"))?;

    let output = Command::new("git")
        .args([
            "init",
            "--bare",
            "--initial-branch",
            default_branch,
            repo_str,
        ])
        .output()
        .with_context(|| "git init --bare failed")?;

    if !output.status.success() {
        anyhow::bail!(
            "git init failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(())
}

fn seed_initial_commit(repo_path: &Path, default_branch: &str) -> Result<()> {
    let repo_str = repo_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("repo path is not valid utf-8"))?;

    let instafy_blob = write_blob(repo_str, INSTAFY_TEMPLATE)?;
    let agents_doc_blob = write_blob(repo_str, AGENTS_DOC_TEMPLATE)?;
    let claude_doc_blob = write_blob(repo_str, CLAUDE_DOC_TEMPLATE)?;
    let agents_script_blob = write_blob(repo_str, AGENTS_SCRIPT_TEMPLATE)?;
    let policy_blob = write_blob(repo_str, LEARNING_POLICY_TEMPLATE)?;
    let git_canonical_blob = write_blob(repo_str, GIT_CANONICAL_TEMPLATE)?;
    let git_conflicts_blob = write_blob(repo_str, GIT_CANONICAL_CONFLICTS_TEMPLATE)?;
    let runtime_flavors_blob = write_blob(repo_str, RUNTIME_FLAVORS_TEMPLATE)?;
    let secrets_blob = write_blob(repo_str, SECRETS_TEMPLATE)?;
    let frontend_previews_blob = write_blob(repo_str, FRONTEND_PREVIEWS_TEMPLATE)?;
    let integration_onboarding_blob = write_blob(repo_str, INTEGRATION_ONBOARDING_TEMPLATE)?;
    let byoc_ai_credentials_blob = write_blob(repo_str, BYOC_AI_CREDENTIALS_TEMPLATE)?;
    let agent_collaboration_blob = write_blob(repo_str, AGENT_COLLABORATION_TEMPLATE)?;
    let diagnostics_blob = write_blob(repo_str, DIAGNOSTICS_TEMPLATE)?;
    let diagnostics_openai_blob = write_blob(repo_str, DIAGNOSTICS_OPENAI_TEMPLATE)?;
    let group_participation_blob = write_blob(repo_str, GROUP_PARTICIPATION_TEMPLATE)?;
    let automations_blob = write_blob(repo_str, AUTOMATIONS_TEMPLATE)?;
    let persistent_contexts_blob = write_blob(repo_str, PERSISTENT_CONTEXTS_TEMPLATE)?;
    let skill_import_compat_blob = write_blob(repo_str, SKILL_IMPORT_COMPAT_TEMPLATE)?;

    let policy_skill_tree = write_tree(repo_str, &[("100644", "blob", &policy_blob, "SKILL.md")])?;
    let git_canonical_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &git_canonical_blob, "SKILL.md")],
    )?;
    let git_conflicts_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &git_conflicts_blob, "SKILL.md")],
    )?;
    let runtime_flavors_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &runtime_flavors_blob, "SKILL.md")],
    )?;
    let secrets_skill_tree =
        write_tree(repo_str, &[("100644", "blob", &secrets_blob, "SKILL.md")])?;
    let frontend_previews_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &frontend_previews_blob, "SKILL.md")],
    )?;
    let integration_onboarding_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &integration_onboarding_blob, "SKILL.md")],
    )?;
    let byoc_ai_credentials_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &byoc_ai_credentials_blob, "SKILL.md")],
    )?;
    let agent_collaboration_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &agent_collaboration_blob, "SKILL.md")],
    )?;
    let diagnostics_agents_tree = write_tree(
        repo_str,
        &[("100644", "blob", &diagnostics_openai_blob, "openai.yaml")],
    )?;
    let diagnostics_skill_tree = write_tree(
        repo_str,
        &[
            ("100644", "blob", &diagnostics_blob, "SKILL.md"),
            ("040000", "tree", &diagnostics_agents_tree, "agents"),
        ],
    )?;
    let group_participation_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &group_participation_blob, "SKILL.md")],
    )?;
    let automations_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &automations_blob, "SKILL.md")],
    )?;
    let persistent_contexts_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &persistent_contexts_blob, "SKILL.md")],
    )?;
    let skill_import_compat_skill_tree = write_tree(
        repo_str,
        &[("100644", "blob", &skill_import_compat_blob, "SKILL.md")],
    )?;

    let skills_tree = write_tree(
        repo_str,
        &[
            (
                "040000",
                "tree",
                &agent_collaboration_skill_tree,
                "instafy-agent-collaboration",
            ),
            (
                "040000",
                "tree",
                &automations_skill_tree,
                "instafy-automations",
            ),
            (
                "040000",
                "tree",
                &byoc_ai_credentials_skill_tree,
                "instafy-byoc-ai-credentials",
            ),
            (
                "040000",
                "tree",
                &diagnostics_skill_tree,
                "instafy-diagnostics",
            ),
            (
                "040000",
                "tree",
                &frontend_previews_skill_tree,
                "instafy-frontend-previews",
            ),
            (
                "040000",
                "tree",
                &git_conflicts_skill_tree,
                "instafy-git-canonical-conflicts",
            ),
            (
                "040000",
                "tree",
                &git_canonical_skill_tree,
                "instafy-git-canonical-sync",
            ),
            (
                "040000",
                "tree",
                &group_participation_skill_tree,
                "instafy-group-participation",
            ),
            (
                "040000",
                "tree",
                &integration_onboarding_skill_tree,
                "instafy-integration-onboarding",
            ),
            (
                "040000",
                "tree",
                &persistent_contexts_skill_tree,
                "instafy-persistent-contexts",
            ),
            (
                "040000",
                "tree",
                &policy_skill_tree,
                "instafy-learning-policy",
            ),
            (
                "040000",
                "tree",
                &runtime_flavors_skill_tree,
                "instafy-runtime-flavors",
            ),
            (
                "040000",
                "tree",
                &skill_import_compat_skill_tree,
                "instafy-skill-import-compat",
            ),
            ("040000", "tree", &secrets_skill_tree, "instafy-secrets"),
        ],
    )?;

    let agents_tree = write_tree(repo_str, &[("040000", "tree", &skills_tree, "skills")])?;

    let root_tree = write_tree(
        repo_str,
        &[
            ("040000", "tree", &agents_tree, ".agents"),
            ("100644", "blob", &agents_doc_blob, "AGENTS.md"),
            ("100644", "blob", &agents_script_blob, "AGENTS.py"),
            ("100644", "blob", &claude_doc_blob, "CLAUDE.md"),
            ("100644", "blob", &instafy_blob, "INSTAFY.md"),
        ],
    )?;

    let commit_output = Command::new("git")
        .args([
            "-C",
            repo_str,
            "commit-tree",
            &root_tree,
            "-m",
            INIT_COMMIT_MESSAGE,
        ])
        .env("GIT_AUTHOR_NAME", "Instafy")
        .env("GIT_AUTHOR_EMAIL", "service-runtime@instafy.dev")
        .env("GIT_COMMITTER_NAME", "Instafy")
        .env("GIT_COMMITTER_EMAIL", "service-runtime@instafy.dev")
        .stdin(Stdio::null())
        .output()
        .with_context(|| "git commit-tree failed")?;
    if !commit_output.status.success() {
        anyhow::bail!(
            "git commit-tree failed: {}",
            String::from_utf8_lossy(&commit_output.stderr).trim()
        );
    }
    let commit_hash = String::from_utf8_lossy(&commit_output.stdout)
        .trim()
        .to_string();
    if commit_hash.is_empty() {
        anyhow::bail!("git commit-tree returned empty commit hash");
    }

    let ref_name = format!("refs/heads/{default_branch}");
    let update_ref = Command::new("git")
        .args(["-C", repo_str, "update-ref", &ref_name, &commit_hash])
        .output()
        .with_context(|| "git update-ref failed")?;
    if !update_ref.status.success() {
        anyhow::bail!(
            "git update-ref failed: {}",
            String::from_utf8_lossy(&update_ref.stderr).trim()
        );
    }

    // Ensure HEAD points to the default branch.
    let _ = Command::new("git")
        .args(["-C", repo_str, "symbolic-ref", "HEAD", &ref_name])
        .output();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

    fn run_git(repo_str: &str, args: &[&str]) -> Result<std::process::Output> {
        Command::new("git")
            .args(["-C", repo_str])
            .args(args)
            .output()
            .with_context(|| format!("failed to run git command {:?}", args))
    }

    fn run_git_stdout(repo_str: &str, args: &[&str]) -> Result<Vec<u8>> {
        let output = run_git(repo_str, args)?;
        if !output.status.success() {
            anyhow::bail!(
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(output.stdout)
    }

    fn test_config(repo_root: PathBuf, auto_init: bool) -> GitShardConfig {
        GitShardConfig {
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            repo_root,
            auto_init,
            default_branch: "main".to_string(),
            max_push_bytes: crate::config::DEFAULT_GIT_MAX_PUSH_BYTES,
            jwks_url: reqwest::Url::parse("http://127.0.0.1/jwks").unwrap(),
            audience: "git".to_string(),
            events_webhook: None,
        }
    }

    #[test]
    fn seed_initial_commit_includes_instafy_scaffold() -> Result<()> {
        let temp_root = unique_temp_dir("instafy-git-service-seed");
        std::fs::create_dir_all(&temp_root)?;
        let repo_path = temp_root.join("repo.git");

        init_bare_repo(&repo_path, "main")?;
        seed_initial_commit(&repo_path, "main")?;

        let repo_str = repo_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("repo path is not valid utf-8"))?;

        let names = String::from_utf8(run_git_stdout(
            repo_str,
            &["ls-tree", "-r", "--name-only", "HEAD"],
        )?)?;

        let expected_paths = [
            ".agents/skills/instafy-agent-collaboration/SKILL.md",
            ".agents/skills/instafy-automations/SKILL.md",
            ".agents/skills/instafy-byoc-ai-credentials/SKILL.md",
            ".agents/skills/instafy-diagnostics/SKILL.md",
            ".agents/skills/instafy-diagnostics/agents/openai.yaml",
            ".agents/skills/instafy-frontend-previews/SKILL.md",
            ".agents/skills/instafy-git-canonical-conflicts/SKILL.md",
            ".agents/skills/instafy-git-canonical-sync/SKILL.md",
            ".agents/skills/instafy-group-participation/SKILL.md",
            ".agents/skills/instafy-integration-onboarding/SKILL.md",
            ".agents/skills/instafy-learning-policy/SKILL.md",
            ".agents/skills/instafy-persistent-contexts/SKILL.md",
            ".agents/skills/instafy-runtime-flavors/SKILL.md",
            ".agents/skills/instafy-skill-import-compat/SKILL.md",
            ".agents/skills/instafy-secrets/SKILL.md",
            "AGENTS.md",
            "AGENTS.py",
            "CLAUDE.md",
            "INSTAFY.md",
        ];

        for path in expected_paths {
            assert!(
                names.lines().any(|line| line.trim() == path),
                "expected {path} to be tracked, got:\n{names}"
            );
        }

        let agents_doc = String::from_utf8(run_git_stdout(repo_str, &["show", "HEAD:AGENTS.md"])?)?;
        assert_eq!(agents_doc, AGENTS_DOC_TEMPLATE);

        let claude_doc = String::from_utf8(run_git_stdout(repo_str, &["show", "HEAD:CLAUDE.md"])?)?;
        assert_eq!(claude_doc, CLAUDE_DOC_TEMPLATE);

        let instafy_doc =
            String::from_utf8(run_git_stdout(repo_str, &["show", "HEAD:INSTAFY.md"])?)?;
        assert_eq!(instafy_doc, INSTAFY_TEMPLATE);

        let secrets = String::from_utf8(run_git_stdout(
            repo_str,
            &["show", "HEAD:.agents/skills/instafy-secrets/SKILL.md"],
        )?)?;
        assert_eq!(secrets, SECRETS_TEMPLATE);

        let integration_onboarding = String::from_utf8(run_git_stdout(
            repo_str,
            &[
                "show",
                "HEAD:.agents/skills/instafy-integration-onboarding/SKILL.md",
            ],
        )?)?;
        assert_eq!(integration_onboarding, INTEGRATION_ONBOARDING_TEMPLATE);

        let agent_collaboration = String::from_utf8(run_git_stdout(
            repo_str,
            &[
                "show",
                "HEAD:.agents/skills/instafy-agent-collaboration/SKILL.md",
            ],
        )?)?;
        assert_eq!(agent_collaboration, AGENT_COLLABORATION_TEMPLATE);

        let group_participation = String::from_utf8(run_git_stdout(
            repo_str,
            &[
                "show",
                "HEAD:.agents/skills/instafy-group-participation/SKILL.md",
            ],
        )?)?;
        assert_eq!(group_participation, GROUP_PARTICIPATION_TEMPLATE);
        assert!(group_participation.contains("targetMessageId"));

        let diagnostics = String::from_utf8(run_git_stdout(
            repo_str,
            &["show", "HEAD:.agents/skills/instafy-diagnostics/SKILL.md"],
        )?)?;
        assert_eq!(diagnostics, DIAGNOSTICS_TEMPLATE);
        assert!(diagnostics.contains("instafy-diagnostics-v1"));

        let diagnostics_openai = String::from_utf8(run_git_stdout(
            repo_str,
            &[
                "show",
                "HEAD:.agents/skills/instafy-diagnostics/agents/openai.yaml",
            ],
        )?)?;
        assert_eq!(diagnostics_openai, DIAGNOSTICS_OPENAI_TEMPLATE);

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }

    #[test]
    fn delete_bare_repo_removes_only_canonical_uuid_repo_root() -> Result<()> {
        let temp_root = unique_temp_dir("instafy-git-service-delete");
        let repo_root = temp_root.join("repos");
        std::fs::create_dir_all(&repo_root)?;
        let project_id = uuid::Uuid::new_v4();
        let repo_dir = format!("{project_id}.git");
        let repo_path = repo_root.join(&repo_dir);
        init_bare_repo(&repo_path, "main")?;
        let config = test_config(repo_root, true);

        delete_bare_repo(&config, &repo_dir).expect("delete exact bare repo");
        assert!(!repo_path.exists());
        assert!(matches!(
            delete_bare_repo(&config, &repo_dir),
            Err(ServiceError::NotFound(_))
        ));
        assert!(
            !repo_path.exists(),
            "a repeated delete must not auto-initialize the repository"
        );

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }

    #[test]
    fn delete_bare_repo_rejects_traversal_non_directory_and_non_repo_targets() -> Result<()> {
        let temp_root = unique_temp_dir("instafy-git-service-delete-invalid");
        let repo_root = temp_root.join("repos");
        std::fs::create_dir_all(&repo_root)?;
        let config = test_config(repo_root.clone(), true);

        let file_project_id = uuid::Uuid::new_v4();
        let file_repo_dir = format!("{file_project_id}.git");
        std::fs::write(repo_root.join(&file_repo_dir), b"not a repo")?;
        assert!(matches!(
            delete_bare_repo(&config, &file_repo_dir),
            Err(ServiceError::BadRequest(_))
        ));

        let directory_project_id = uuid::Uuid::new_v4();
        let directory_repo_dir = format!("{directory_project_id}.git");
        std::fs::create_dir(repo_root.join(&directory_repo_dir))?;
        assert!(matches!(
            delete_bare_repo(&config, &directory_repo_dir),
            Err(ServiceError::BadRequest(_))
        ));
        assert!(repo_root.join(&directory_repo_dir).exists());

        assert!(matches!(
            delete_bare_repo(&config, &format!("../{}.git", uuid::Uuid::new_v4())),
            Err(ServiceError::BadRequest(_))
        ));

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn delete_bare_repo_rejects_symlink_target_without_touching_destination() -> Result<()> {
        use std::os::unix::fs::symlink;

        let temp_root = unique_temp_dir("instafy-git-service-delete-symlink");
        let repo_root = temp_root.join("repos");
        std::fs::create_dir_all(&repo_root)?;
        let outside_repo = temp_root.join("outside.git");
        init_bare_repo(&outside_repo, "main")?;
        let project_id = uuid::Uuid::new_v4();
        let repo_dir = format!("{project_id}.git");
        symlink(&outside_repo, repo_root.join(&repo_dir))?;
        let config = test_config(repo_root, false);

        assert!(matches!(
            delete_bare_repo(&config, &repo_dir),
            Err(ServiceError::BadRequest(_))
        ));
        assert!(outside_repo.exists());
        assert!(outside_repo.join("HEAD").is_file());

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn delete_bare_repo_rejects_symlink_configured_root() -> Result<()> {
        use std::os::unix::fs::symlink;

        let temp_root = unique_temp_dir("instafy-git-service-delete-root-symlink");
        let real_repo_root = temp_root.join("real-repos");
        std::fs::create_dir_all(&real_repo_root)?;
        let project_id = uuid::Uuid::new_v4();
        let repo_dir = format!("{project_id}.git");
        let repo_path = real_repo_root.join(&repo_dir);
        init_bare_repo(&repo_path, "main")?;
        let linked_repo_root = temp_root.join("linked-repos");
        symlink(&real_repo_root, &linked_repo_root)?;
        let config = test_config(linked_repo_root, false);

        assert!(matches!(
            delete_bare_repo(&config, &repo_dir),
            Err(ServiceError::Internal(_))
        ));
        assert!(repo_path.exists());

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn repository_delete_device_guard_rejects_cross_filesystem_entry() -> Result<()> {
        let temp_root = unique_temp_dir("instafy-git-service-delete-device");
        let repo_path = temp_root.join("repo.git");
        let mounted_path = repo_path.join("objects/mounted");
        std::fs::create_dir_all(&mounted_path)?;
        std::fs::write(mounted_path.join("outside-data"), b"preserve")?;

        let expected_device = std::fs::symlink_metadata(&repo_path)?.dev();
        ensure_tree_on_device(&repo_path, expected_device)?;

        let foreign_device = expected_device.wrapping_add(1);
        assert!(matches!(
            ensure_tree_on_device_with(&repo_path, expected_device, |path, metadata| {
                if path == mounted_path {
                    foreign_device
                } else {
                    metadata.dev()
                }
            }),
            Err(ServiceError::BadRequest(message))
                if message.contains("crosses a filesystem boundary")
        ));

        assert!(mounted_path.join("outside-data").exists());
        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }
}
