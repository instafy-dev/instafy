//! Server-side push policy for every repository on a shard.
//!
//! `git-shard` renders one `update` hook at startup into
//! `<repo_root>/.instafy-hooks/` and runs `git http-backend` with
//! `core.hooksPath` pointing there (see [`crate::git_http_backend`]), so
//! requests never write hook files or run `git config`, and hook files inside
//! individual repositories are ignored.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Directory under the shard's repo root that holds the shared hooks. Its name
/// does not end in `.git`, so no Smart HTTP request can address it.
pub const SHARED_HOOKS_DIR_NAME: &str = ".instafy-hooks";

/// Directories that may not be added, changed or deleted anywhere in a
/// repository. A path is denied when it starts with `<entry>/` or contains
/// `/<entry>/`, at any depth. Operators can add shell globs at runtime with
/// `GIT_DENY_PATHS`; those are not listed here.
pub const REPO_POLICY_DENY_PATTERNS: &[&str] = &[
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    ".turbo",
    ".vercel",
    ".cache",
    ".vite",
    "coverage",
    "playwright-report",
    "test-results",
    "tmp",
    ".supabase",
    ".instafy/origin-staging",
];

/// Refs at or under this name hold work salvaged from retired workspaces,
/// which may be the only copy of it. A push may not create, move or delete
/// them unless the shard set [`SALVAGE_PUSH_ENV`] for that request.
pub const SALVAGE_REF_ROOT: &str = "refs/instafy/salvage";

/// Hook environment flag that lets one push change refs under
/// [`SALVAGE_REF_ROOT`]. Only the shard sets hook environment, never from a
/// request header, and no request path sets this flag yet, so every push that
/// touches a salvage ref is refused.
pub const SALVAGE_PUSH_ENV: &str = "INSTAFY_GIT_SALVAGE_PUSH";

/// Whether `path` (a repository-relative path with `/` separators) falls under
/// one of [`REPO_POLICY_DENY_PATTERNS`]. This is the same rule the rendered
/// hook applies with `case "$path" in <entry>/*|*/<entry>/*)`.
pub fn repo_policy_denies_path(path: &str) -> bool {
    REPO_POLICY_DENY_PATTERNS.iter().any(|entry| {
        path.strip_prefix(entry)
            .is_some_and(|rest| rest.starts_with('/'))
            || path.contains(&format!("/{entry}/"))
    })
}

/// Render the shared `update` hook for a shard whose default branch is
/// `default_branch`.
pub fn render_update_hook(default_branch: &str) -> Result<String> {
    validate_default_branch(default_branch)?;
    let mut deny_cases = String::new();
    for entry in REPO_POLICY_DENY_PATTERNS {
        if !is_literal_pattern(entry) {
            bail!("repository policy entry {entry:?} is not a plain path");
        }
        deny_cases.push_str(&format!("    {entry}/*|*/{entry}/*) return 0 ;;\n"));
    }
    if !is_literal_pattern(SALVAGE_REF_ROOT) {
        bail!("salvage ref root {SALVAGE_REF_ROOT:?} is not a plain ref name");
    }
    let salvage_ref_root = SALVAGE_REF_ROOT;
    let salvage_push_env = SALVAGE_PUSH_ENV;

    Ok(format!(
        r#"#!/usr/bin/env bash
# Rendered by git-shard at startup. Every repository on this shard runs this
# file through core.hooksPath; hooks inside a repository are not used.
set -euo pipefail

refname="$1"
oldrev="$2"
newrev="$3"

main_ref="refs/heads/{default_branch}"
salvage_root="{salvage_ref_root}"

is_zero() {{
  [[ "$1" =~ ^0+$ ]]
}}

# ---------------------------------------------------------------------------
# Salvage refs hold work recovered from retired workspaces, possibly the only
# copy. A push may not create, move or delete them unless the shard marked it
# as a salvage push. This is an authorization boundary, so
# GIT_POLICY_DISABLED does not skip it.
# ---------------------------------------------------------------------------
if [[ "$refname" == "$salvage_root" || "$refname" == "$salvage_root/"* ]] \
  && [[ "${{{salvage_push_env}:-}}" != "1" ]]; then
  echo "instafy: '$refname' holds salvaged work and cannot be changed by a push" >&2
  exit 1
fi

if [[ "${{GIT_POLICY_DISABLED:-0}}" == "1" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Protect the default branch (fast-forward only, no delete).
# ---------------------------------------------------------------------------
if [[ "$refname" == "$main_ref" ]]; then
  # Disallow deleting main.
  if is_zero "$newrev"; then
    echo "instafy: deleting {default_branch} is not allowed" >&2
    exit 1
  fi

  # Allow creating main from scratch (should be rare; repos are seeded).
  if ! is_zero "$oldrev"; then
    # Enforce fast-forward only.
    if ! git merge-base --is-ancestor "$oldrev" "$newrev"; then
      echo "instafy: non-fast-forward updates to {default_branch} are not allowed" >&2
      exit 1
    fi
  fi
fi

# Deleting any other ref is allowed (salvage refs are refused above).
if is_zero "$newrev"; then
  exit 0
fi

# Every ref names a commit, directly or through an annotated tag, so the
# checks below always have a tree to inspect.
if ! newcommit="$(git rev-parse --verify --quiet "$newrev^{{commit}}")"; then
  echo "instafy: '$refname' must point to a commit" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Repo hygiene policy (deny paths + blob size).
# ---------------------------------------------------------------------------

max_blob_bytes="${{GIT_MAX_BLOB_BYTES:-20971520}}" # 20 MiB default
if [[ ! "$max_blob_bytes" =~ ^[0-9]+$ ]]; then
  echo "instafy: GIT_MAX_BLOB_BYTES must be a whole number of bytes" >&2
  exit 1
fi
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
{deny_cases}  esac

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

# Compare the new tip with what the repository already accepted: the ref's old
# value, else the current default branch, else the empty tree. Diffing two
# trees lists every path that differs, also when the tip is a merge or the
# last of several new commits.
if ! is_zero "$oldrev"; then
  base="$oldrev"
elif [[ "$refname" != "$main_ref" ]] \
  && base="$(git rev-parse --verify --quiet "$main_ref^{{commit}}")"; then
  true
else
  base="$(git hash-object -t tree /dev/null)"
fi

# With -z, diff-tree prints ":<old mode> <new mode> <old oid> <new oid>
# <status>" and the path as separate NUL-terminated fields, so every path is
# checked exactly as stored. The marker after the listing is printed only
# when diff-tree succeeded; without it the push is refused.
blob_paths=()
blob_oids=()
listed=0
while IFS= read -r -d '' meta; do
  if [[ "$meta" == "end" ]]; then
    listed=1
    break
  fi
  IFS= read -r -d '' path || break
  read -r _old_mode new_mode _old_oid new_oid status <<< "${{meta#:}}"

  if is_denied_path "$path"; then
    echo "instafy: blocked path '$path' (repo hygiene policy)" >&2
    exit 1
  fi

  [[ "$status" == "D" ]] && continue

  if [[ "$new_mode" == "160000" ]]; then
    echo "instafy: blocked non-blob object for '$path' (type=commit)" >&2
    exit 1
  fi
  blob_paths+=("$path")
  blob_oids+=("$new_oid")
done < <(git diff-tree -r -z --no-renames --raw "$base" "$newcommit" && printf 'end\0')

if [[ "$listed" != "1" ]]; then
  echo "instafy: could not list the changes in '$refname'" >&2
  exit 1
fi

# Enforce the object type and per-blob size limit for new and changed paths
# with one cat-file process.
if [[ "${{#blob_oids[@]}}" -gt 0 ]]; then
  checked=0
  while read -r obj_type obj_size; do
    path="${{blob_paths[$checked]}}"
    checked=$((checked + 1))
    if [[ "$obj_size" == "missing" ]]; then
      obj_type="missing"
    fi
    if [[ "$obj_type" != "blob" ]]; then
      echo "instafy: blocked non-blob object for '$path' (type=$obj_type)" >&2
      exit 1
    fi
    if (( 10#$obj_size > 10#$max_blob_bytes )); then
      echo "instafy: file too large '$path' ($obj_size bytes > $max_blob_bytes)" >&2
      exit 1
    fi
  done < <(printf '%s\n' "${{blob_oids[@]}}" | git cat-file --batch-check='%(objecttype) %(objectsize)')

  if [[ "$checked" != "${{#blob_oids[@]}}" ]]; then
    echo "instafy: could not check the objects in '$refname'" >&2
    exit 1
  fi
fi

exit 0
"#
    ))
}

/// Write the shared hooks for a shard and return the absolute directory to
/// pass as `core.hooksPath`. The hook is written to a temporary file and
/// renamed into place, so a concurrent push sees either the old or the new
/// script, never a partial one.
pub fn install_shared_hooks(repo_root: &Path, default_branch: &str) -> Result<PathBuf> {
    let script = render_update_hook(default_branch)?;
    std::fs::create_dir_all(repo_root)
        .with_context(|| format!("failed to create repo root {repo_root:?}"))?;

    let hooks_dir = repo_root.join(SHARED_HOOKS_DIR_NAME);
    match std::fs::symlink_metadata(&hooks_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            bail!("shared hooks path {hooks_dir:?} must be a real directory");
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&hooks_dir)
                .with_context(|| format!("failed to create shared hooks dir {hooks_dir:?}"))?;
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect shared hooks dir {hooks_dir:?}"));
        }
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = hooks_dir.join(format!(".update.{}.{nanos}.tmp", std::process::id()));
    let hook_path = hooks_dir.join("update");
    let written = write_executable(&temp_path, script.as_bytes()).and_then(|()| {
        std::fs::rename(&temp_path, &hook_path)
            .with_context(|| format!("failed to install shared update hook {hook_path:?}"))
    });
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }

    let hooks_dir = hooks_dir
        .canonicalize()
        .with_context(|| format!("failed to resolve shared hooks dir {hooks_dir:?}"))?;
    if hooks_dir.to_str().is_none() {
        bail!("shared hooks dir {hooks_dir:?} is not valid utf-8");
    }
    Ok(hooks_dir)
}

fn write_executable(path: &Path, contents: &[u8]) -> Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o755);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("failed to create {path:?}"))?;
    file.write_all(contents)
        .with_context(|| format!("failed to write {path:?}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The process umask may have cleared bits from the requested mode.
        file.set_permissions(std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("failed to mark {path:?} executable"))?;
    }
    file.sync_all()
        .with_context(|| format!("failed to flush {path:?}"))?;
    Ok(())
}

fn validate_default_branch(default_branch: &str) -> Result<()> {
    let valid = !default_branch.is_empty()
        && is_literal_pattern(default_branch)
        && !default_branch.starts_with('-')
        && !default_branch.contains("..");
    if !valid {
        bail!("default branch {default_branch:?} is not a plain branch name");
    }
    Ok(())
}

/// A path made only of characters that are literal both in a shell `case`
/// pattern and inside a double-quoted shell string.
fn is_literal_pattern(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("//")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_patterns_are_plain_paths() {
        for entry in REPO_POLICY_DENY_PATTERNS {
            assert!(is_literal_pattern(entry), "{entry} is not a plain path");
        }
    }

    #[test]
    fn deny_rule_matches_prefix_or_nested_directory_only() {
        for denied in [
            "node_modules/react/index.js",
            "packages/app/node_modules/x",
            "dist/main.js",
            "web/.next/cache/x",
            ".instafy/origin-staging/a",
            "nested/.instafy/origin-staging/a",
        ] {
            assert!(repo_policy_denies_path(denied), "{denied} was allowed");
        }
        for allowed in [
            "node_modules",
            "src/node_modules.ts",
            "distribution/x",
            "my-dist/x",
            "src/build.rs",
            ".instafy/origin-staging",
            ".instafy/other/a",
            "README.md",
        ] {
            assert!(!repo_policy_denies_path(allowed), "{allowed} was denied");
        }
    }

    #[test]
    fn rendered_hook_lists_every_deny_pattern_and_the_default_branch() {
        let hook = render_update_hook("trunk").unwrap();
        assert!(hook.starts_with("#!/usr/bin/env bash\n"));
        assert!(hook.contains("main_ref=\"refs/heads/trunk\""));
        for entry in REPO_POLICY_DENY_PATTERNS {
            assert!(
                hook.contains(&format!("    {entry}/*|*/{entry}/*) return 0 ;;\n")),
                "hook does not deny {entry}"
            );
        }
        assert!(hook.contains(&format!("salvage_root=\"{SALVAGE_REF_ROOT}\"")));
        let salvage_check = hook
            .find(&format!("\"${{{SALVAGE_PUSH_ENV}:-}}\" != \"1\""))
            .unwrap();
        let policy_switch = hook
            .find("if [[ \"${GIT_POLICY_DISABLED:-0}\" == \"1\" ]]")
            .unwrap();
        assert!(
            salvage_check < policy_switch,
            "the salvage ref check must not be skippable by GIT_POLICY_DISABLED"
        );
        // A single-commit diff-tree prints nothing for a merge, which would
        // skip every path check.
        assert!(!hook.contains("--root"));
        assert!(hook.contains("git diff-tree -r -z --no-renames --raw \"$base\" \"$newcommit\""));
    }

    #[test]
    fn unsafe_default_branch_is_refused() {
        for branch in [
            "",
            "main\"; rm -rf /",
            "-main",
            "a..b",
            "/main",
            "main/",
            "ma in",
        ] {
            assert!(render_update_hook(branch).is_err(), "{branch:?} rendered");
        }
        assert!(render_update_hook("release/v1").is_ok());
    }

    #[test]
    fn install_is_atomic_and_idempotent() -> Result<()> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "instafy-git-shared-hooks-{}-{nanos}",
            std::process::id()
        ));
        let first = install_shared_hooks(&root, "main")?;
        let second = install_shared_hooks(&root, "main")?;
        assert_eq!(first, second);
        assert!(first.is_absolute());
        let entries = std::fs::read_dir(&first)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        assert_eq!(entries, vec![std::ffi::OsString::from("update")]);
        assert_eq!(
            std::fs::read_to_string(first.join("update"))?,
            render_update_hook("main")?
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(first.join("update"))?
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn install_refuses_a_symlinked_hooks_dir() -> Result<()> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "instafy-git-shared-hooks-link-{}-{nanos}",
            std::process::id()
        ));
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere)?;
        std::os::unix::fs::symlink(&elsewhere, root.join(SHARED_HOOKS_DIR_NAME))?;
        assert!(install_shared_hooks(&root, "main").is_err());
        assert!(!elsewhere.join("update").exists());
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }
}
