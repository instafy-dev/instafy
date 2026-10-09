//! Server-side push policy for every repository on a shard.
//!
//! `git-shard` renders an `update` and a `post-receive` hook at startup into
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
///
/// Because the hook also refuses deleting these paths, the list is for build
/// output and caches only. File patterns such as secrets belong in a
/// publisher's own filter, or a repository that already holds one could never
/// remove it.
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

/// Namespace for refs Instafy itself manages. A push may create or move only
/// recovery refs here (see [`RECOVERY_REF_ROOT`]); deletes are allowed except
/// under [`SALVAGE_REF_ROOT`].
pub const INSTAFY_REF_ROOT: &str = "refs/instafy";

/// Recovery refs are `<root>/<origin id>/<name>`, where the origin id is a
/// lower-case UUID and the name uses only `[0-9A-Za-z._-]`. Any holder of
/// `git.write` may create or delete them. A recovery ref is named after its
/// content, so a push never moves one, except a working slot (see
/// [`WORKING_SLOT_NAME`]).
pub const RECOVERY_REF_ROOT: &str = "refs/instafy/recovery";

/// The name of a working folder's rolling save:
/// `<RECOVERY_REF_ROOT>/<working-set id>/working`, where the working-set id
/// is a lower-case UUID that names one working folder. It is the only
/// recovery ref a push may move: each save replaces it under a lease on the
/// exact tip the saver last confirmed. Its updates are checked against its
/// own parent: that parent alone when it is on the default branch, and also
/// against the old tip (or the default branch) when it is not.
pub const WORKING_SLOT_NAME: &str = "working";

/// Whether `refname` is a working slot: `<RECOVERY_REF_ROOT>/<lower-case
/// uuid>/working`. The rendered hook applies the same rule.
pub fn is_working_slot_ref(refname: &str) -> bool {
    let Some(rest) = refname
        .strip_prefix(RECOVERY_REF_ROOT)
        .and_then(|rest| rest.strip_prefix('/'))
    else {
        return false;
    };
    let Some((id, name)) = rest.split_once('/') else {
        return false;
    };
    name == WORKING_SLOT_NAME
        && id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// Refs at or under this name are reserved for work salvaged from retired
/// workspaces. No push may create, move or delete one, in any letter case.
pub const SALVAGE_REF_ROOT: &str = "refs/instafy/salvage";

/// Hook environment variable naming the file where `post-receive` appends the
/// refs one push updated, as `<old> <new> <ref>` lines (see
/// [`crate::events::parse_push_report`]). Only the shard sets it, per request.
pub const PUSH_REPORT_ENV: &str = "INSTAFY_GIT_PUSH_REPORT";

/// Hook environment variable the shard sets to `1`, per request, for a push
/// Git Edge authorized only through a rolling save's credential
/// (`git.persist`, see `crate::routing::GIT_PERSIST_SCOPE`). Such a push may
/// create recovery refs and replace or delete a working slot, and nothing
/// else.
pub const PERSIST_PUSH_ENV: &str = "INSTAFY_GIT_PERSIST_PUSH";

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
    for root in [INSTAFY_REF_ROOT, RECOVERY_REF_ROOT, SALVAGE_REF_ROOT] {
        // The hook compares ref names with these in lower case.
        if !is_literal_pattern(root) || root != root.to_ascii_lowercase() {
            bail!("ref root {root:?} is not a plain lower-case ref name");
        }
    }
    if !WORKING_SLOT_NAME
        .bytes()
        .all(|byte| byte.is_ascii_lowercase())
    {
        bail!("working slot name {WORKING_SLOT_NAME:?} is not a plain lower-case name");
    }
    let instafy_ref_root = INSTAFY_REF_ROOT;
    let recovery_ref_root = RECOVERY_REF_ROOT;
    let working_slot_name = WORKING_SLOT_NAME;
    let salvage_ref_root = SALVAGE_REF_ROOT;
    let persist_push_env = PERSIST_PUSH_ENV;

    Ok(format!(
        r#"#!/usr/bin/env bash
# Rendered by git-shard at startup. Every repository on this shard runs this
# file through core.hooksPath; hooks inside a repository are not used.
set -euo pipefail
# Byte-wise patterns and ASCII-only case mapping, whatever the shard's locale.
export LC_ALL=C

refname="$1"
oldrev="$2"
newrev="$3"

main_ref="refs/heads/{default_branch}"
instafy_root="{instafy_ref_root}"
recovery_root="{recovery_ref_root}"
salvage_root="{salvage_ref_root}"
recovery_ref_pattern='^{recovery_ref_root}/[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}/[0-9A-Za-z._-]+$'
working_slot_name="{working_slot_name}"
ascii_ref_pattern='^[!-~]+$'

is_zero() {{
  [[ "$1" =~ ^0+$ ]]
}}

# On a case-insensitive filesystem refs/heads/MAIN and refs/heads/main are the
# same file, so protected names are compared in lower case.
lower_case() {{
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}}
folded_ref="$(lower_case "$refname")"

# ---------------------------------------------------------------------------
# Git sets core.ignorecase when it creates a repository on a case-insensitive
# filesystem. There some non-ASCII letters also name an existing ref's file
# (U+017F for "s", for example), so ref names must be ASCII.
# ---------------------------------------------------------------------------
if [[ ! "$refname" =~ $ascii_ref_pattern ]] \
  && [[ "$(git config --bool core.ignorecase || true)" == "true" ]]; then
  echo "instafy: '$refname' is not an ASCII ref name, which this repository's filesystem requires" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Salvage refs are reserved: a push may not create, move or delete them, in
# any letter case. This is an authorization boundary, so GIT_POLICY_DISABLED
# does not skip it.
# ---------------------------------------------------------------------------
if [[ "$folded_ref" == "$salvage_root" || "$folded_ref" == "$salvage_root/"* ]]; then
  echo "instafy: '$refname' is reserved for salvaged work and cannot be changed by a push" >&2
  exit 1
fi

# A working folder's rolling save:
# {recovery_ref_root}/<working-set id>/{working_slot_name}.
working_slot=0
if [[ "$refname" =~ $recovery_ref_pattern && "${{refname##*/}}" == "$working_slot_name" ]]; then
  working_slot=1
fi

# ---------------------------------------------------------------------------
# A push authorized only by a rolling save's credential (git.persist) may
# create recovery refs and replace or delete a working slot, nothing else:
# no branch, tag or other ref, and no recovery ref but a slot moves or goes.
# An authorization boundary, so GIT_POLICY_DISABLED does not skip it.
# ---------------------------------------------------------------------------
if [[ "${{{persist_push_env}:-}}" == "1" ]]; then
  if [[ ! "$refname" =~ $recovery_ref_pattern ]] \
    || {{ [[ "$working_slot" != "1" ]] && ! is_zero "$oldrev"; }}; then
    echo "instafy: a rolling save may not change '$refname'" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# A recovery ref is named after the work it holds, so a push may create or
# delete one but never move it. The one exception is a working slot, which
# every save replaces under a lease on the tip it last confirmed. This keeps
# saved work from being swapped for other content under the same name, so
# GIT_POLICY_DISABLED does not skip it.
# ---------------------------------------------------------------------------
if [[ "$folded_ref" == "$recovery_root/"* && "$working_slot" != "1" ]] \
  && ! is_zero "$oldrev" && ! is_zero "$newrev"; then
  echo "instafy: '$refname' is a recovery ref; it may be created or deleted, not moved" >&2
  exit 1
fi

if [[ "${{GIT_POLICY_DISABLED:-0}}" == "1" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Protect the default branch (fast-forward only, no delete). A name that
# differs from it only in letter case could delete or replace it on a
# case-insensitive filesystem.
# ---------------------------------------------------------------------------
if [[ "$folded_ref" == "$(lower_case "$main_ref")" && "$refname" != "$main_ref" ]]; then
  echo "instafy: '$refname' differs from $main_ref only in letter case" >&2
  exit 1
fi

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

# ---------------------------------------------------------------------------
# A push may create or move only recovery refs under refs/instafy/. Any other
# name there could block them (a ref named refs/instafy/recovery, say) or
# alias one on a case-insensitive filesystem.
# ---------------------------------------------------------------------------
if [[ "$folded_ref" == "$instafy_root/"* && ! "$refname" =~ $recovery_ref_pattern ]]; then
  echo "instafy: '$refname' is not a recovery ref ({recovery_ref_root}/<origin id>/<name>)" >&2
  exit 1
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
# value, else the current default branch, else the empty tree. Diffing the two
# trees checks the net change, including everything a merge or several new
# commits bring in. Earlier commits are not walked one by one, so a path or
# blob that one new commit adds and a later one removes is not checked.
if ! is_zero "$oldrev"; then
  base="$oldrev"
elif [[ "$refname" != "$main_ref" ]] \
  && base="$(git rev-parse --verify --quiet "$main_ref^{{commit}}")"; then
  true
else
  base="$(git hash-object -t tree /dev/null)"
fi

# Check every path and blob that differs between `$1` and the new commit.
# With -z, diff-tree prints ":<old mode> <new mode> <old oid> <new oid>
# <status>" and the path as separate NUL-terminated fields, so every path is
# checked exactly as stored. The marker after the listing is printed only
# when diff-tree succeeded; without it the push is refused.
check_changes() {{
  local against="$1"
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

    # A working slot may always drop a path: it is never published, and a
    # path denied after the slot saved it must be able to leave.
    [[ "$status" == "D" && "$working_slot" == "1" ]] && continue

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
  done < <(git diff-tree -r -z --no-renames --raw "$against" "$newcommit" && printf 'end\0')

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
}}

# A working slot is checked against its own parent, so a path denied since
# its old tip was accepted (GIT_DENY_PATHS) is refused when the slot keeps
# its own version, even if this save did not change it. A parent on the
# default branch is canonical history, so the slot is checked against it
# alone: everything else the slot holds differs from it, and the slot may go
# back to the parent's version of a denied path, which is what a saver does
# with a path the shard refuses. A parent off the default branch proves
# nothing, so the slot is also checked against what was already accepted.
slot_parent=""
if [[ "$working_slot" == "1" ]] \
  && slot_parent="$(git rev-parse --verify --quiet "$newcommit^1")" \
  && git merge-base --is-ancestor "$slot_parent" "$main_ref" 2>/dev/null; then
  base="$slot_parent"
fi

check_changes "$base"
if [[ -n "$slot_parent" && "$slot_parent" != "$base" ]]; then
  check_changes "$slot_parent"
fi

exit 0
"#
    ))
}

/// Render the shared `post-receive` hook. `git receive-pack` runs it once a
/// push has updated its refs, with one `<old> <new> <ref>` line per updated
/// ref, and it appends those lines to the file named by [`PUSH_REPORT_ENV`].
pub fn render_post_receive_hook() -> String {
    format!(
        r#"#!/usr/bin/env bash
# Rendered by git-shard at startup. Records the refs this push updated for the
# shard's push event; the shard names the file per request.
set -euo pipefail

if [[ -z "${{{PUSH_REPORT_ENV}:-}}" ]]; then
  cat > /dev/null
  exit 0
fi
cat >> "${PUSH_REPORT_ENV}"
"#
    )
}

/// Write the shared hooks for a shard and return the absolute directory to
/// pass as `core.hooksPath`. Each hook is written to a temporary file and
/// renamed into place, so a concurrent push sees either the old or the new
/// script, never a partial one.
pub fn install_shared_hooks(repo_root: &Path, default_branch: &str) -> Result<PathBuf> {
    let update = render_update_hook(default_branch)?;
    let post_receive = render_post_receive_hook();
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

    for (name, script) in [("post-receive", &post_receive), ("update", &update)] {
        install_hook(&hooks_dir, name, script)?;
    }

    let hooks_dir = hooks_dir
        .canonicalize()
        .with_context(|| format!("failed to resolve shared hooks dir {hooks_dir:?}"))?;
    if hooks_dir.to_str().is_none() {
        bail!("shared hooks dir {hooks_dir:?} is not valid utf-8");
    }
    Ok(hooks_dir)
}

/// Check that the installed hooks can run. Git skips a hook it cannot execute
/// (a `noexec` mount, or no `bash`) with only a hint, which would accept every
/// push unchecked, so the shard refuses to start instead.
pub fn verify_shared_hooks(hooks_dir: &Path) -> Result<()> {
    let hook = hooks_dir.join("post-receive");
    let output = std::process::Command::new(&hook)
        .env_remove(PUSH_REPORT_ENV)
        .stdin(std::process::Stdio::null())
        .output()
        .with_context(|| format!("shared hook {hook:?} cannot be executed"))?;
    if !output.status.success() {
        bail!(
            "shared hook {hook:?} failed to run ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn install_hook(hooks_dir: &Path, name: &str, script: &str) -> Result<()> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = hooks_dir.join(format!(".{name}.{}.{nanos}.tmp", std::process::id()));
    let hook_path = hooks_dir.join(name);
    let written = write_executable(&temp_path, script.as_bytes()).and_then(|()| {
        std::fs::rename(&temp_path, &hook_path)
            .with_context(|| format!("failed to install shared {name} hook {hook_path:?}"))
    });
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
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
        assert!(hook.contains(&format!(
            "recovery_ref_pattern='^{RECOVERY_REF_ROOT}/[0-9a-f]{{8}}-"
        )));
        // Patterns and case mapping must not depend on the shard's locale.
        assert!(hook.contains("\nexport LC_ALL=C\n"));
        let salvage_check = hook
            .find("if [[ \"$folded_ref\" == \"$salvage_root\"")
            .unwrap();
        let policy_switch = hook
            .find("if [[ \"${GIT_POLICY_DISABLED:-0}\" == \"1\" ]]")
            .unwrap();
        assert!(
            salvage_check < policy_switch,
            "the salvage ref check must not be skippable by GIT_POLICY_DISABLED"
        );
        // A recovery ref is never moved, whatever the policy switch says.
        let move_rule = hook.find("may be created or deleted, not moved").unwrap();
        assert!(
            move_rule < policy_switch,
            "the recovery ref move rule must not be skippable by GIT_POLICY_DISABLED"
        );
        // Nor does a rolling save's push change anything else.
        let persist_rule = hook
            .find(&format!(
                "if [[ \"${{{PERSIST_PUSH_ENV}:-}}\" == \"1\" ]]; then"
            ))
            .unwrap();
        assert!(
            persist_rule < move_rule,
            "the rolling save rule must not be skippable by GIT_POLICY_DISABLED"
        );
        assert!(hook.contains(&format!("working_slot_name=\"{WORKING_SLOT_NAME}\"")));
        // A single-commit diff-tree prints nothing for a merge, which would
        // skip every path check.
        assert!(!hook.contains("--root"));
        assert!(hook.contains("git diff-tree -r -z --no-renames --raw \"$against\" \"$newcommit\""));
        assert!(hook.contains("check_changes \"$base\"\n"));
        assert!(hook.contains("check_changes \"$slot_parent\"\n"));
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

    fn temp_root(label: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "{label}-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn install_is_atomic_and_idempotent() -> Result<()> {
        let root = temp_root("instafy-git-shared-hooks");
        let first = install_shared_hooks(&root, "main")?;
        let second = install_shared_hooks(&root, "main")?;
        assert_eq!(first, second);
        assert!(first.is_absolute());
        let mut entries = std::fs::read_dir(&first)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort();
        assert_eq!(
            entries,
            vec![
                std::ffi::OsString::from("post-receive"),
                std::ffi::OsString::from("update")
            ]
        );
        assert_eq!(
            std::fs::read_to_string(first.join("update"))?,
            render_update_hook("main")?
        );
        assert_eq!(
            std::fs::read_to_string(first.join("post-receive"))?,
            render_post_receive_hook()
        );
        #[cfg(unix)]
        for name in ["post-receive", "update"] {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(first.join(name))?.permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "{name}");
        }
        verify_shared_hooks(&first)?;
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn verify_refuses_hooks_that_cannot_run() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("instafy-git-shared-hooks-noexec");
        let hooks_dir = install_shared_hooks(&root, "main")?;
        std::fs::set_permissions(
            hooks_dir.join("post-receive"),
            std::fs::Permissions::from_mode(0o644),
        )?;
        assert!(verify_shared_hooks(&hooks_dir).is_err());
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }

    #[test]
    fn post_receive_appends_to_the_report_file_only_when_named() -> Result<()> {
        use std::io::Write;

        let root = temp_root("instafy-git-post-receive");
        let hooks_dir = install_shared_hooks(&root, "main")?;
        let report = root.join("push.report");
        let lines = format!(
            "{zero} {a} refs/heads/feature\n{a} {b} refs/heads/main\n",
            zero = "0".repeat(40),
            a = "a".repeat(40),
            b = "b".repeat(40)
        );
        for named in [false, true] {
            let mut command = std::process::Command::new(hooks_dir.join("post-receive"));
            command
                .env_remove(PUSH_REPORT_ENV)
                .stdin(std::process::Stdio::piped());
            if named {
                command.env(PUSH_REPORT_ENV, &report);
            }
            let mut child = command.spawn()?;
            child
                .stdin
                .take()
                .expect("hook stdin")
                .write_all(lines.as_bytes())?;
            assert!(child.wait()?.success());
            assert_eq!(report.exists(), named);
        }
        assert_eq!(std::fs::read_to_string(&report)?, lines);
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn install_refuses_a_symlinked_hooks_dir() -> Result<()> {
        let root = temp_root("instafy-git-shared-hooks-link");
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere)?;
        std::os::unix::fs::symlink(&elsewhere, root.join(SHARED_HOOKS_DIR_NAME))?;
        assert!(install_shared_hooks(&root, "main").is_err());
        assert!(!elsewhere.join("update").exists());
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }

    /// A bare repository whose shared `update` hook is run directly, the way
    /// `git receive-pack` runs it. Ref-name checks then do not depend on how
    /// the host filesystem treats letter case.
    struct HookRepo {
        root: PathBuf,
        git_dir: PathBuf,
        hook: PathBuf,
        main: String,
        child: String,
    }

    const ZERO: &str = "0000000000000000000000000000000000000000";

    impl HookRepo {
        fn new(label: &str) -> Self {
            let root = temp_root(&format!("instafy-git-hook-{label}"));
            std::fs::create_dir_all(&root).unwrap();
            let git_dir = root.join("repo.git");
            let hooks_dir = install_shared_hooks(&root, "main").unwrap();
            let mut repo = Self {
                hook: hooks_dir.join("update"),
                root,
                git_dir,
                main: String::new(),
                child: String::new(),
            };
            repo.git(&["init", "--bare", "-q"]);
            let tree = repo.git(&["hash-object", "-w", "-t", "tree", "/dev/null"]);
            repo.main = repo.git(&["commit-tree", "-m", "main", &tree]);
            repo.child = repo.git(&["commit-tree", "-p", &repo.main, "-m", "child", &tree]);
            repo.git(&["update-ref", "refs/heads/main", &repo.main]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(args)
                .env("GIT_DIR", &self.git_dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_AUTHOR_NAME", "Test")
                .env("GIT_AUTHOR_EMAIL", "test@example.test")
                .env("GIT_COMMITTER_NAME", "Test")
                .env("GIT_COMMITTER_EMAIL", "test@example.test")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        }

        fn set_ignorecase(&self, value: bool) {
            self.git(&["config", "core.ignorecase", &value.to_string()]);
        }

        /// Run the hook for one ref update and return its stderr on refusal.
        fn run(&self, refname: &str, old: &str, new: &str, env: &[(&str, &str)]) -> Option<String> {
            let output = std::process::Command::new(&self.hook)
                .args([refname, old, new])
                .current_dir(&self.git_dir)
                .env("GIT_DIR", &self.git_dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env_remove("GIT_POLICY_DISABLED")
                .env_remove("GIT_DENY_PATHS")
                .env_remove("GIT_MAX_BLOB_BYTES")
                .envs(env.iter().copied())
                .output()
                .unwrap();
            (!output.status.success()).then(|| String::from_utf8_lossy(&output.stderr).to_string())
        }

        fn accepts(&self, refname: &str, old: &str, new: &str) {
            if let Some(stderr) = self.run(refname, old, new, &[]) {
                panic!("{refname} {old}..{new} was refused: {stderr}");
            }
        }

        fn refuses(&self, refname: &str, old: &str, new: &str, env: &[(&str, &str)]) -> String {
            self.run(refname, old, new, env)
                .unwrap_or_else(|| panic!("{refname} {old}..{new} was accepted"))
        }

        fn accepts_with(&self, refname: &str, old: &str, new: &str, env: &[(&str, &str)]) {
            if let Some(stderr) = self.run(refname, old, new, env) {
                panic!("{refname} {old}..{new} was refused: {stderr}");
            }
        }

        /// A commit on top of main whose tree holds exactly `files`.
        fn commit_with(&self, files: &[(&str, &[u8])]) -> String {
            self.commit_on(&self.main, files)
        }

        /// A commit on top of `parent` whose tree holds exactly `files`.
        fn commit_on(&self, parent: &str, files: &[(&str, &[u8])]) -> String {
            let index = self.root.join("index");
            let _ = std::fs::remove_file(&index);
            for (path, contents) in files {
                let file = self.root.join("blob");
                std::fs::write(&file, contents).unwrap();
                let blob = self.git(&["hash-object", "-w", file.to_str().unwrap()]);
                let output = std::process::Command::new("git")
                    .args(["update-index", "--add", "--cacheinfo"])
                    .arg(format!("100644,{blob},{path}"))
                    .env("GIT_DIR", &self.git_dir)
                    .env("GIT_INDEX_FILE", &index)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .output()
                    .unwrap();
                assert!(output.status.success(), "update-index {path}");
            }
            let path = files.first().map(|(path, _)| *path).unwrap_or("empty");
            let tree = std::process::Command::new("git")
                .arg("write-tree")
                .env("GIT_DIR", &self.git_dir)
                .env("GIT_INDEX_FILE", &index)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(tree.status.success(), "write-tree {path}");
            let tree = String::from_utf8(tree.stdout).unwrap().trim().to_string();
            self.git(&["commit-tree", "-p", parent, "-m", path, &tree])
        }
    }

    impl Drop for HookRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn hook_refuses_letter_case_variants_of_main_and_salvage_refs() {
        let repo = HookRepo::new("case");
        repo.set_ignorecase(false);
        let (main, child) = (repo.main.as_str(), repo.child.as_str());

        for (refname, old, new) in [
            ("refs/heads/MAIN", ZERO, child),
            ("refs/heads/Main", main, ZERO),
            ("refs/heads/MAIN", main, child),
            ("refs/Heads/main", ZERO, child),
        ] {
            let stderr = repo.refuses(refname, old, new, &[]);
            assert!(
                stderr.contains(&format!(
                    "instafy: '{refname}' differs from refs/heads/main only in letter case"
                )),
                "{refname}: {stderr}"
            );
        }
        let stderr = repo.refuses("refs/heads/main", main, ZERO, &[]);
        assert!(
            stderr.contains("instafy: deleting main is not allowed"),
            "{stderr}"
        );
        repo.accepts("refs/heads/main", main, child);
        repo.accepts("refs/heads/Feature", ZERO, child);
        repo.accepts("refs/heads/Feature", child, ZERO);

        for refname in [
            "refs/instafy/salvage/gateway/n1-abc",
            "refs/instafy/SALVAGE/gateway/n1-abc",
            "refs/INSTAFY/salvage/gateway/n1-abc",
            "refs/Instafy/Salvage",
        ] {
            for (old, new) in [(ZERO, child), (main, child), (main, ZERO)] {
                // Policy switched off does not unlock salvage refs.
                let stderr = repo.refuses(refname, old, new, &[("GIT_POLICY_DISABLED", "1")]);
                assert!(
                    stderr.contains(&format!(
                        "instafy: '{refname}' is reserved for salvaged work and cannot be changed by a push"
                    )),
                    "{refname}: {stderr}"
                );
            }
        }
    }

    #[test]
    fn hook_allows_only_recovery_refs_to_be_created_under_refs_instafy() {
        let repo = HookRepo::new("instafy-refs");
        repo.set_ignorecase(false);
        let child = repo.child.as_str();
        let origin = "5d0c7f0e-3b9a-4c41-9a51-1f2e3d4c5b6a";
        let recovery = format!("refs/instafy/recovery/{origin}/20261002T120000Z-unpublished.a_b-1");

        repo.accepts(&recovery, ZERO, child);
        repo.accepts(&recovery, child, ZERO);

        for refname in [
            "refs/instafy/recovery".to_string(),
            format!("refs/instafy/recovery/{origin}"),
            format!("refs/instafy/recovery/{}/x", origin.to_uppercase()),
            format!("refs/instafy/Recovery/{origin}/x"),
            format!("refs/INSTAFY/recovery/{origin}/x"),
            format!("refs/instafy/recovery/{origin}/a/b"),
            "refs/instafy/recovery/not-a-uuid/x".to_string(),
            "refs/instafy/local-recovery/x".to_string(),
            "refs/instafy/notes".to_string(),
        ] {
            let stderr = repo.refuses(&refname, ZERO, child, &[]);
            assert!(
                stderr.contains(&format!("instafy: '{refname}' is not a recovery ref")),
                "{refname}: {stderr}"
            );
            // A stray ref there can still be cleaned up.
            repo.accepts(&refname, child, ZERO);
        }
    }

    #[test]
    fn hook_requires_ascii_ref_names_on_case_insensitive_repositories() {
        let repo = HookRepo::new("ascii");
        let (main, child) = (repo.main.as_str(), repo.child.as_str());
        // U+017F folds to "s" and U+212A (Kelvin) to "k" on a case-insensitive
        // filesystem; U+00E9 is an ordinary non-ASCII letter.
        let non_ascii = [
            "refs/instafy/\u{17f}alvage/gateway/n1",
            "refs/heads/ma\u{212a}e",
            "refs/heads/caf\u{e9}",
        ];

        repo.set_ignorecase(true);
        for refname in non_ascii {
            for (old, new) in [(ZERO, child), (main, ZERO)] {
                let stderr = repo.refuses(refname, old, new, &[("GIT_POLICY_DISABLED", "1")]);
                assert!(
                    stderr.contains("is not an ASCII ref name"),
                    "{refname}: {stderr}"
                );
            }
        }
        repo.accepts("refs/heads/cafe", ZERO, child);

        repo.set_ignorecase(false);
        repo.accepts("refs/heads/caf\u{e9}", ZERO, child);
        repo.accepts("refs/heads/ma\u{212a}e", ZERO, child);
    }

    const POLICY_DISABLED: (&str, &str) = ("GIT_POLICY_DISABLED", "1");

    #[test]
    fn working_slot_names_match_the_hook() {
        let repo = HookRepo::new("slot-names");
        repo.set_ignorecase(false);
        let (main, child) = (repo.main.as_str(), repo.child.as_str());
        let id = "5d0c7f0e-3b9a-4c41-9a51-1f2e3d4c5b6a";
        for (refname, slot) in [
            (
                format!("{RECOVERY_REF_ROOT}/{id}/{WORKING_SLOT_NAME}"),
                true,
            ),
            (format!("{RECOVERY_REF_ROOT}/{id}/Working"), false),
            (format!("{RECOVERY_REF_ROOT}/{id}/working-1"), false),
            (
                format!("{RECOVERY_REF_ROOT}/{id}/20261002T120000Z-unsaved-0123"),
                false,
            ),
            (
                format!("{RECOVERY_REF_ROOT}/{}/working", id.to_uppercase()),
                false,
            ),
            (format!("{RECOVERY_REF_ROOT}/not-a-uuid/working"), false),
            (format!("{RECOVERY_REF_ROOT}/{id}/a/working"), false),
            ("refs/heads/working".to_string(), false),
        ] {
            assert_eq!(is_working_slot_ref(&refname), slot, "{refname}");
            // Only a slot may move; anything else under the recovery root is
            // refused before the policy switch is read.
            let moved = repo
                .run(&refname, main, child, &[POLICY_DISABLED])
                .is_none();
            if refname.starts_with(RECOVERY_REF_ROOT) {
                assert_eq!(moved, slot, "{refname}");
            }
        }
    }

    /// A recovery ref names its own content: a push may create and delete
    /// one, never move it, even with the policy switched off. A working
    /// slot is the one recovery ref that moves.
    #[test]
    fn recovery_refs_are_created_or_deleted_and_only_a_working_slot_moves() {
        let repo = HookRepo::new("recovery-moves");
        repo.set_ignorecase(false);
        let (main, child) = (repo.main.as_str(), repo.child.as_str());
        let origin = "5d0c7f0e-3b9a-4c41-9a51-1f2e3d4c5b6a";
        let content = format!("{RECOVERY_REF_ROOT}/{origin}/20261002T120000Z-unsaved-0123456789ab");
        let slot = format!("{RECOVERY_REF_ROOT}/{origin}/{WORKING_SLOT_NAME}");

        for env in [&[][..], &[POLICY_DISABLED][..]] {
            for (old, new) in [(main, child), (child, main)] {
                let stderr = repo.refuses(&content, old, new, env);
                assert!(
                    stderr.contains(&format!(
                        "instafy: '{content}' is a recovery ref; it may be created or deleted, not moved"
                    )),
                    "{env:?} {old}..{new}: {stderr}"
                );
            }
            // Letter-case variants of the root are refused by the same rule.
            let folded = content.replace("refs/instafy/recovery", "refs/INSTAFY/Recovery");
            let stderr = repo.refuses(&folded, main, child, env);
            assert!(
                stderr.contains("may be created or deleted, not moved"),
                "{stderr}"
            );

            repo.accepts_with(&content, ZERO, child, env);
            repo.accepts_with(&content, child, ZERO, env);
            repo.accepts_with(&slot, ZERO, child, env);
            repo.accepts_with(&slot, child, main, env);
            repo.accepts_with(&slot, main, ZERO, env);
        }
    }

    /// A push only a rolling save's credential authorized (`git.persist`,
    /// which Git Edge passes on to the shard) may create recovery refs and
    /// replace or delete a working slot, and change nothing else, whatever
    /// the policy switch says.
    #[test]
    fn a_rolling_saves_push_changes_only_recovery_refs() {
        let repo = HookRepo::new("persist-push");
        repo.set_ignorecase(false);
        let (main, child) = (repo.main.as_str(), repo.child.as_str());
        let origin = "5d0c7f0e-3b9a-4c41-9a51-1f2e3d4c5b6a";
        let slot = format!("{RECOVERY_REF_ROOT}/{origin}/{WORKING_SLOT_NAME}");
        let content = format!("{RECOVERY_REF_ROOT}/{origin}/20261002T120000Z-unsaved-0123456789ab");
        let other_slot =
            format!("{RECOVERY_REF_ROOT}/0b4f2c1e-6a3d-4f5e-8c7b-9a8d7e6f5a4b/{WORKING_SLOT_NAME}");
        let replace = format!("refs/replace/{main}");
        let upper = format!("{RECOVERY_REF_ROOT}/{}/x", origin.to_uppercase());
        let persist = (PERSIST_PUSH_ENV, "1");

        for env in [&[persist][..], &[persist, POLICY_DISABLED][..]] {
            repo.accepts_with(&slot, ZERO, child, env);
            repo.accepts_with(&slot, child, main, env);
            repo.accepts_with(&slot, main, ZERO, env);
            repo.accepts_with(&other_slot, ZERO, child, env);
            repo.accepts_with(&content, ZERO, child, env);
            for (refname, old, new) in [
                ("refs/heads/main", main, child),
                ("refs/heads/feature", ZERO, child),
                ("refs/heads/feature", child, ZERO),
                ("refs/tags/v1", ZERO, child),
                ("refs/notes/commits", ZERO, child),
                (replace.as_str(), ZERO, child),
                (content.as_str(), child, ZERO),
                (content.as_str(), main, child),
                (upper.as_str(), ZERO, child),
            ] {
                let stderr = repo.refuses(refname, old, new, env);
                assert!(
                    stderr.contains(&format!(
                        "instafy: a rolling save may not change '{refname}'"
                    )),
                    "{env:?} {refname} {old}..{new}: {stderr}"
                );
            }
        }
        // The same updates of an ordinary push.
        repo.accepts("refs/heads/main", main, child);
        repo.accepts("refs/heads/feature", ZERO, child);
        repo.accepts(&content, child, ZERO);
    }

    /// A slot update is checked against its own parent: a path its old tip
    /// already held, denied since, is refused.
    #[test]
    fn a_working_slot_is_checked_against_its_parent() {
        let repo = HookRepo::new("slot-parent");
        repo.set_ignorecase(false);
        let slot =
            format!("{RECOVERY_REF_ROOT}/5d0c7f0e-3b9a-4c41-9a51-1f2e3d4c5b6a/{WORKING_SLOT_NAME}");
        let earlier = repo.commit_with(&[("assets/archive.zip", b"zip\n")]);
        let later = repo.commit_with(&[("assets/archive.zip", b"zip\n"), ("notes.md", b"notes\n")]);
        let deny_zip = [("GIT_DENY_PATHS", "*.zip")];

        // Accepted while the policy allows it.
        repo.accepts(&slot, ZERO, &earlier);
        repo.accepts(&slot, &earlier, &later);

        // The old tip already held the archive; its parent did not.
        let stderr = repo.refuses(&slot, &earlier, &later, &deny_zip);
        assert!(
            stderr.contains("instafy: blocked path 'assets/archive.zip'"),
            "{stderr}"
        );
        // A ref whose update is compared with its old tip alone lets the
        // same change through.
        repo.accepts_with("refs/heads/feature", &earlier, &later, &deny_zip[..]);
        // A new slot on the same parent is refused too.
        let stderr = repo.refuses(&slot, ZERO, &earlier, &deny_zip);
        assert!(
            stderr.contains("blocked path 'assets/archive.zip'"),
            "{stderr}"
        );

        // The slot may drop the archive: a slot is never published, so a
        // path denied after it was saved can leave it. Any other ref still
        // may not delete a denied path.
        let without = repo.commit_with(&[("notes.md", b"notes\n")]);
        repo.accepts_with(&slot, &earlier, &without, &deny_zip);
        let stderr = repo.refuses("refs/heads/feature", &earlier, &without, &deny_zip);
        assert!(
            stderr.contains("blocked path 'assets/archive.zip'"),
            "{stderr}"
        );
    }

    /// A new slot is compared with its own parent. When main holds a path
    /// added before it was denied and the slot's parent (the folder's merge
    /// base) does not, a slot without the path is accepted, and one with it
    /// is refused.
    #[test]
    fn a_new_working_slot_may_leave_out_a_path_main_holds_and_policy_denies() {
        let repo = HookRepo::new("slot-create");
        repo.set_ignorecase(false);
        let slot =
            format!("{RECOVERY_REF_ROOT}/5d0c7f0e-3b9a-4c41-9a51-1f2e3d4c5b6a/{WORKING_SLOT_NAME}");
        let deny_zip = [("GIT_DENY_PATHS", "*.zip")];
        // main moved on to a commit holding the archive; the folder's merge
        // base is the main before it.
        let newer_main = repo.commit_with(&[("assets/archive.zip", b"zip\n")]);
        repo.git(&["update-ref", "refs/heads/main", &newer_main]);

        let without = repo.commit_with(&[("notes.md", b"notes\n")]);
        repo.accepts_with(&slot, ZERO, &without, &deny_zip);
        let with = repo.commit_with(&[("assets/archive.zip", b"zip\n"), ("notes.md", b"notes\n")]);
        let stderr = repo.refuses(&slot, ZERO, &with, &deny_zip);
        assert!(
            stderr.contains("blocked path 'assets/archive.zip'"),
            "{stderr}"
        );
    }

    /// A slot built on a commit of main is checked against that commit
    /// alone. When the parent holds a path policy denies since, the slot may
    /// go back to the parent's version (what a saver does with a refused
    /// path), on an update, on a create on an older main and after the
    /// folder followed main, but may not keep a version of its own or main's
    /// newer one. A parent off main proves nothing, so that slot is compared
    /// with its old tip or main as well.
    #[test]
    fn a_working_slot_on_main_may_go_back_to_its_parents_version_of_a_denied_path() {
        let repo = HookRepo::new("slot-on-main");
        repo.set_ignorecase(false);
        let slot =
            format!("{RECOVERY_REF_ROOT}/5d0c7f0e-3b9a-4c41-9a51-1f2e3d4c5b6a/{WORKING_SLOT_NAME}");
        let deny_zip = [("GIT_DENY_PATHS", "*.zip")];
        let refused = |old: &str, new: &str| {
            let stderr = repo.refuses(&slot, old, new, &deny_zip);
            assert!(
                stderr.contains("blocked path 'assets/archive.zip'"),
                "{stderr}"
            );
        };
        // main holds the archive from before the deny, and an earlier save
        // changed it while the policy allowed that.
        let canonical = repo.commit_with(&[("assets/archive.zip", b"v1\n")]);
        repo.git(&["update-ref", "refs/heads/main", &canonical]);
        let earlier = repo.commit_on(&canonical, &[("assets/archive.zip", b"v2\n")]);
        repo.accepts(&slot, ZERO, &earlier);

        let kept = repo.commit_on(
            &canonical,
            &[("assets/archive.zip", b"v2\n"), ("notes.md", b"notes\n")],
        );
        refused(&earlier, &kept);
        let put_back = repo.commit_on(
            &canonical,
            &[("assets/archive.zip", b"v1\n"), ("notes.md", b"notes\n")],
        );
        repo.accepts_with(&slot, &earlier, &put_back, &deny_zip);

        // main changed the archive since the folder's merge base.
        let newer_main = repo.commit_on(&canonical, &[("assets/archive.zip", b"v3\n")]);
        repo.git(&["update-ref", "refs/heads/main", &newer_main]);
        repo.accepts_with(&slot, ZERO, &put_back, &deny_zip);
        let mains = repo.commit_on(
            &canonical,
            &[("assets/archive.zip", b"v3\n"), ("notes.md", b"notes\n")],
        );
        refused(ZERO, &mains);
        // A folder that follows main moves the slot onto main's version.
        let followed = repo.commit_on(
            &newer_main,
            &[("assets/archive.zip", b"v3\n"), ("notes.md", b"notes\n")],
        );
        repo.accepts_with(&slot, &earlier, &followed, &deny_zip);

        // A parent off main that holds the archive.
        let off_main = repo.commit_with(&[("assets/archive.zip", b"v4\n")]);
        let on_it = repo.commit_on(
            &off_main,
            &[("assets/archive.zip", b"v4\n"), ("notes.md", b"notes\n")],
        );
        refused(ZERO, &on_it);
        refused(&earlier, &on_it);
    }
}
