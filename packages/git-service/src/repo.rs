use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
    let repo_path = config.repo_root.join(repo_dir);
    if repo_path.exists() {
        ensure_repo_policy(&repo_path, &config.default_branch)
            .map_err(|error| ServiceError::internal(error.to_string()))?;
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
    ensure_repo_policy(&repo_path, &config.default_branch)
        .map_err(|error| ServiceError::internal(error.to_string()))?;

    Ok(repo_path)
}

fn ensure_repo_policy(repo_path: &Path, default_branch: &str) -> Result<()> {
    install_update_hook(repo_path, default_branch)?;
    enable_http_receive_pack(repo_path)?;
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

fn enable_http_receive_pack(repo_path: &Path) -> Result<()> {
    let repo_str = repo_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("repo path is not valid utf-8"))?;

    let output = Command::new("git")
        .args(["-C", repo_str, "config", "http.receivepack", "true"])
        .output()
        .with_context(|| "git config http.receivepack failed")?;

    if !output.status.success() {
        anyhow::bail!(
            "git config http.receivepack failed: {}",
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

fn install_update_hook(repo_path: &Path, default_branch: &str) -> Result<()> {
    let hooks_dir = repo_path.join("hooks");
    std::fs::create_dir_all(&hooks_dir)
        .with_context(|| format!("failed to create hooks dir {:?}", hooks_dir))?;
    let hook_path = hooks_dir.join("update");

    let script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail

refname="$1"
oldrev="$2"
newrev="$3"

main_ref="refs/heads/{default_branch}"

if [[ "${{GIT_POLICY_DISABLED:-0}}" == "1" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Protect the default branch (fast-forward only, no delete).
# ---------------------------------------------------------------------------
if [[ "$refname" == "$main_ref" ]]; then
  # Disallow deleting main.
  if [[ "$newrev" =~ ^0{{40}}$ ]]; then
    echo "instafy: deleting {default_branch} is not allowed" >&2
    exit 1
  fi

  # Allow creating main from scratch (should be rare; repos are seeded).
  if [[ "$oldrev" =~ ^0{{40}}$ ]]; then
    true
  else
    # Enforce fast-forward only.
    if ! git merge-base --is-ancestor "$oldrev" "$newrev"; then
      echo "instafy: non-fast-forward updates to {default_branch} are not allowed" >&2
      exit 1
    fi
  fi
fi

# Deleting a ref is always allowed (handled above for default branch).
if [[ "$newrev" =~ ^0{{40}}$ ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Repo hygiene policy (deny paths + blob size).
# ---------------------------------------------------------------------------

max_blob_bytes="${{GIT_MAX_BLOB_BYTES:-20971520}}" # 20 MiB default
deny_extra="${{GIT_DENY_PATHS:-}}"

trim() {{
  local s="$1"
  s="${{s#"${{s%%[![:space:]]*}}"}}"
  s="${{s%"${{s##*[![:space:]]}}"}}"
  printf '%s' "$s"
}}

is_denied_path() {{
  local p="$1"
  case "$p" in
    node_modules/*|*/node_modules/*) return 0 ;;
    .next/*|*/.next/*) return 0 ;;
    dist/*|*/dist/*) return 0 ;;
    build/*|*/build/*) return 0 ;;
    target/*|*/target/*) return 0 ;;
    .turbo/*|*/.turbo/*) return 0 ;;
    .vercel/*|*/.vercel/*) return 0 ;;
    .cache/*|*/.cache/*) return 0 ;;
    .vite/*|*/.vite/*) return 0 ;;
    coverage/*|*/coverage/*) return 0 ;;
    playwright-report/*|*/playwright-report/*) return 0 ;;
    test-results/*|*/test-results/*) return 0 ;;
    tmp/*|*/tmp/*) return 0 ;;
    .supabase/*|*/.supabase/*) return 0 ;;
    .instafy/origin-staging/*|*/.instafy/origin-staging/*) return 0 ;;
  esac

  if [[ -n "$deny_extra" ]]; then
    local IFS=','; read -ra parts <<< "$deny_extra"
    for raw in "${{parts[@]}}"; do
      local pat; pat="$(trim "$raw")"
      [[ -z "$pat" ]] && continue
      # Treat pattern as a shell glob (e.g. "**/vendor/**" isn't supported; use "*/vendor/*").
      if [[ "$p" == $pat ]]; then
        return 0
      fi
    done
  fi

  return 1
}}

diff_args=()
if [[ "$oldrev" =~ ^0{{40}}$ ]]; then
  diff_args=(--root "$newrev")
else
  diff_args=("$oldrev" "$newrev")
fi

while IFS=$'\t' read -r status path1 path2; do
  [[ -z "$status" ]] && continue

  local_path="$path1"
  case "$status" in
    R*|C*)
      local_path="$path2"
      ;;
  esac

  if [[ -n "$local_path" ]] && is_denied_path "$local_path"; then
    echo "instafy: blocked path '$local_path' (repo hygiene policy)" >&2
    exit 1
  fi

  case "$status" in
    D*)
      continue
      ;;
  esac

  # Enforce per-blob size limit for new/updated paths.
  if [[ -n "$local_path" ]]; then
    oid=""
    if read -r _mode _kind oid _tree_path < <(git ls-tree -r "$newrev" -- "$local_path" 2>/dev/null); then
      true
    fi
    [[ -z "$oid" ]] && continue
    obj_type="$(git cat-file -t "$oid" 2>/dev/null || true)"
    if [[ "$obj_type" != "blob" ]]; then
      echo "instafy: blocked non-blob object for '$local_path' (type=$obj_type)" >&2
      exit 1
    fi
    size="$(git cat-file -s "$oid" 2>/dev/null || echo 0)"
    if [[ "$size" -gt "$max_blob_bytes" ]]; then
      echo "instafy: file too large '$local_path' ($size bytes > $max_blob_bytes)" >&2
      exit 1
    fi
  fi
done < <(git diff-tree --no-commit-id --name-status -r "${{diff_args[@]}}")

exit 0
"#
    );

    std::fs::write(&hook_path, script.as_bytes())
        .with_context(|| format!("failed to write update hook {:?}", hook_path))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&hook_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&hook_path, perms)?;
    }

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

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }
}
