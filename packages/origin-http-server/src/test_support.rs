//! Helpers shared by the git tests: plain git processes for building
//! fixtures, remotes and clones. Production code never calls these.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::workspace_git::WorkspaceGit;

pub(crate) fn git_in(dir: &Path, args: &[&str]) -> String {
    let output = git_output(dir, args, None);
    assert!(
        output.status.success(),
        "git {:?} in {:?} failed: {}{}",
        args,
        dir,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string()
}

pub(crate) fn git_output(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Output {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command.spawn().expect("spawn git");
    if let Some(input) = stdin {
        use std::io::Write as _;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input)
            .expect("write git stdin");
    }
    child.wait_with_output().expect("wait for git")
}

/// Git in a workspace checkout (`.instafy/.git` with the workspace as work
/// tree), without the server's command hardening.
pub(crate) fn ig(ws: &Path, args: &[&str]) -> String {
    let mut full: Vec<&str> = vec!["--git-dir", ".instafy/.git", "--work-tree", "."];
    full.extend_from_slice(args);
    git_in(ws, &full)
}

pub(crate) fn ws_git(root: &Path) -> WorkspaceGit<'_> {
    WorkspaceGit::new(root, None)
}

/// A workspace repository with no remote and no commits.
pub(crate) fn init_workspace_repo(root: &Path) {
    std::fs::create_dir_all(root.join(".instafy")).unwrap();
    git_in(
        root,
        &[
            "--git-dir",
            ".instafy/.git",
            "--work-tree",
            ".",
            "init",
            "-q",
            "-b",
            "main",
        ],
    );
    ig(root, &["config", "user.name", "Fixture"]);
    ig(root, &["config", "user.email", "fixture@instafy.dev"]);
}

fn ig_stdin(ws: &Path, args: &[&str], stdin: &[u8], env: &[(&str, &str)]) -> String {
    let mut full: Vec<&str> = vec!["--git-dir", ".instafy/.git", "--work-tree", "."];
    full.extend_from_slice(args);
    let mut command = Command::new("git");
    command
        .current_dir(ws)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(&full)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn git");
    {
        use std::io::Write as _;
        child.stdin.take().unwrap().write_all(stdin).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn index_path(ws: &Path, label: &str) -> PathBuf {
    let dir = ws.join(".instafy/.git");
    dir.join(format!(
        "fixture-index-{label}-{}",
        uuid::Uuid::new_v4().simple()
    ))
}

/// Write a commit whose tree is `parent`'s tree (or empty) with `files`
/// applied: `Some(text)` writes a regular file, `None` deletes it. The
/// worktree, index and refs are not touched.
pub(crate) fn commit_files(
    ws: &Path,
    parent: Option<&str>,
    files: &[(&str, Option<&str>)],
) -> String {
    edit_commit(ws, parent, |index_env| {
        for (path, contents) in files {
            match contents {
                Some(text) => {
                    let oid = ig_stdin(ws, &["hash-object", "-w", "--stdin"], text.as_bytes(), &[]);
                    let cacheinfo = format!("100644,{oid},{path}");
                    ig_stdin(
                        ws,
                        &["update-index", "--add", "--cacheinfo", &cacheinfo],
                        b"",
                        index_env,
                    );
                }
                None => {
                    ig_stdin(
                        ws,
                        &["update-index", "--force-remove", "--", path],
                        b"",
                        index_env,
                    );
                }
            }
        }
    })
}

/// A child of `commit` where `path` keeps its blob but gets `mode`.
pub(crate) fn with_mode(ws: &Path, commit: &str, path: &str, mode: &str) -> String {
    let oid = ig(ws, &["rev-parse", &format!("{commit}:{path}")]);
    with_raw_entry(ws, commit, path, mode, &oid)
}

/// A child of `commit` with `path` set to a new blob holding `content`.
pub(crate) fn with_entry(
    ws: &Path,
    commit: &str,
    path: &str,
    mode: &str,
    content: Option<&str>,
) -> String {
    let content = content.unwrap_or_default();
    let oid = ig_stdin(
        ws,
        &["hash-object", "-w", "--stdin"],
        content.as_bytes(),
        &[],
    );
    with_raw_entry(ws, commit, path, mode, &oid)
}

/// A child of `commit` with `path` set to `mode`/`oid` exactly (gitlinks
/// name commits that need not exist).
pub(crate) fn with_raw_entry(ws: &Path, commit: &str, path: &str, mode: &str, oid: &str) -> String {
    edit_commit(ws, Some(commit), |index_env| {
        let cacheinfo = format!("{mode},{oid},{path}");
        ig_stdin(
            ws,
            &["update-index", "--add", "--cacheinfo", &cacheinfo],
            b"",
            index_env,
        );
    })
}

fn edit_commit(ws: &Path, parent: Option<&str>, edit: impl FnOnce(&[(&str, &str)])) -> String {
    let index = index_path(ws, "edit");
    let index_text = index.to_string_lossy().to_string();
    let env: Vec<(&str, &str)> = vec![("GIT_INDEX_FILE", index_text.as_str())];
    match parent {
        Some(parent) => {
            ig_stdin(ws, &["read-tree", parent], b"", &env);
        }
        None => {
            ig_stdin(ws, &["read-tree", "--empty"], b"", &env);
        }
    }
    edit(&env);
    let tree = ig_stdin(ws, &["write-tree"], b"", &env);
    let _ = std::fs::remove_file(&index);
    let mut args = vec!["commit-tree", tree.as_str()];
    if let Some(parent) = parent {
        args.push("-p");
        args.push(parent);
    }
    ig_stdin(
        ws,
        &args,
        b"fixture\n",
        &[
            ("GIT_AUTHOR_NAME", "Fixture"),
            ("GIT_AUTHOR_EMAIL", "fixture@instafy.dev"),
            ("GIT_COMMITTER_NAME", "Fixture"),
            ("GIT_COMMITTER_EMAIL", "fixture@instafy.dev"),
        ],
    )
}

/// Install the shard's update hook in the bare repository `remote`, with
/// `env` exported for it (policy settings such as `GIT_DENY_PATHS`).
pub(crate) fn install_shard_hook(remote: &Path, env: &[(&str, &str)]) {
    use std::os::unix::fs::PermissionsExt as _;
    let hooks = remote.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let real = hooks.join("update.shard");
    std::fs::write(
        &real,
        git_service::policy::render_update_hook("main").unwrap(),
    )
    .unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut wrapper = String::from("#!/bin/sh\n");
    for (key, value) in env {
        wrapper.push_str(&format!("export {key}='{value}'\n"));
    }
    wrapper.push_str(&format!("exec '{}' \"$@\"\n", real.display()));
    let update = hooks.join("update");
    std::fs::write(&update, wrapper).unwrap();
    std::fs::set_permissions(&update, std::fs::Permissions::from_mode(0o755)).unwrap();
}
