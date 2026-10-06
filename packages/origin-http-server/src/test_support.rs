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

/// Plain git in `dir`, without global or system configuration, its output
/// captured.
fn git_command(dir: &Path, args: &[&str]) -> Command {
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
    command
}

pub(crate) fn git_output(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Output {
    let mut command = git_command(dir, args);
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

/// [`git_output`] with `stdin`, given at most `limit`: past it the git
/// process is killed and the answer is `None`, so a test fails with a
/// message instead of waiting forever on a git that never returns.
pub(crate) fn git_output_within(
    dir: &Path,
    args: &[&str],
    stdin: &[u8],
    limit: std::time::Duration,
) -> Option<Output> {
    use std::io::{Read as _, Write as _};
    use std::os::unix::process::CommandExt as _;
    let mut command = git_command(dir, args);
    // Its own process group, so whatever git started goes with it.
    command.stdin(Stdio::piped()).process_group(0);
    let mut child = command.spawn().expect("spawn git");
    let mut input = child.stdin.take().unwrap();
    let input_bytes = stdin.to_vec();
    // Pipes are fed and drained on their own threads, so a full pipe never
    // looks like a git that does not return.
    let writer = std::thread::spawn(move || {
        let _ = input.write_all(&input_bytes);
    });
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait().expect("wait for git") {
            break Some(status);
        }
        if std::time::Instant::now() >= deadline {
            let group = rustix::process::Pid::from_child(&child);
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    let _ = writer.join();
    let stdout = out.join().unwrap();
    let stderr = err.join().unwrap();
    status.map(|status| Output {
        status,
        stdout,
        stderr,
    })
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

/// Set only when [`install_script`] starts a script to see that it starts:
/// the line after the script's `#!` line then exits at once.
const SCRIPT_PROBE_ENV: &str = "INSTAFY_TEST_SCRIPT_PROBE";

/// How long [`install_script`] waits for a new script to be startable.
const SCRIPT_START_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Write `script` (a shell script whose first line is its `#!` line) to
/// `path` as an executable that starts whenever it is run after this
/// returns.
///
/// Linux refuses to start a file that any process holds open for writing
/// (`ETXTBSY`). A child that another test thread forks while the script is
/// being written keeps a copy of the writing descriptor until it starts its
/// own program, so the first start of a script just written can fail for a
/// moment on a busy host. The script is written under a temporary name and
/// renamed into place, then started with [`SCRIPT_PROBE_ENV`] set (a guard
/// right after the `#!` line exits at once, so none of the script's own
/// work runs) until the system lets it start, for at most
/// [`SCRIPT_START_WAIT`]. Nothing opens the file for writing again, so
/// every later start succeeds too.
pub(crate) fn install_script(path: &Path, script: &str) {
    use std::os::unix::fs::PermissionsExt as _;
    let (interpreter, body) = script
        .split_once('\n')
        .filter(|(first, _)| first.starts_with("#!"))
        .expect("a script starts with its #! line");
    let folder = path.parent().expect("a script lives in a folder");
    let name = path
        .file_name()
        .expect("a script has a name")
        .to_string_lossy();
    let temporary = folder.join(format!(".{name}.{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(
        &temporary,
        format!("{interpreter}\n[ -n \"${SCRIPT_PROBE_ENV}\" ] && exit 0\n{body}"),
    )
    .unwrap();
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(&temporary, path).unwrap();
    start_once_free(path);
}

/// Start the script [`install_script`] wrote at `path`, with
/// [`SCRIPT_PROBE_ENV`] set, until the system lets it start: a start that
/// fails because a process still holds the file open for writing is tried
/// again, for at most [`SCRIPT_START_WAIT`].
fn start_once_free(path: &Path) {
    let deadline = std::time::Instant::now() + SCRIPT_START_WAIT;
    loop {
        match probe_start(path) {
            Ok(status) => {
                assert!(status.success(), "{path:?} did not start cleanly: {status}");
                return;
            }
            Err(error) if is_busy(&error) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => panic!("{path:?} could not be started: {error}"),
        }
    }
}

/// Run `path` once with [`SCRIPT_PROBE_ENV`] set.
fn probe_start(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    Command::new(path)
        .env(SCRIPT_PROBE_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
}

/// The start failed because a process holds the file open for writing.
fn is_busy(error: &std::io::Error) -> bool {
    rustix::io::Errno::from_io_error(error) == Some(rustix::io::Errno::TXTBSY)
}

/// Install the shard's update hook in the bare repository `remote`, with
/// `env` exported for it (policy settings such as `GIT_DENY_PATHS`).
pub(crate) fn install_shard_hook(remote: &Path, env: &[(&str, &str)]) {
    let hooks = remote.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let real = hooks.join("update.shard");
    install_script(
        &real,
        &git_service::policy::render_update_hook("main").unwrap(),
    );
    let mut wrapper = String::from("#!/bin/sh\n");
    for (key, value) in env {
        wrapper.push_str(&format!("export {key}='{value}'\n"));
    }
    wrapper.push_str(&format!("exec '{}' \"$@\"\n", real.display()));
    install_script(&hooks.join("update"), &wrapper);
}

/// Runs git through a shell script for commands built on the current thread
/// only (the server's `GIT_PROGRAM_OVERRIDE`): `prelude` runs first with the
/// command's arguments in "$@", then the real git. Dropping it restores git.
pub(crate) struct GitWrapper;

impl GitWrapper {
    pub(crate) fn install(dir: &Path, prelude: &str) -> Self {
        let script = dir.join(format!("git-wrapper-{}", uuid::Uuid::new_v4().simple()));
        install_script(&script, &format!("#!/bin/sh\n{prelude}\nexec git \"$@\"\n"));
        crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = Some(script));
        Self
    }
}

impl Drop for GitWrapper {
    fn drop(&mut self) {
        crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = None);
    }
}

/// Quarantines created under these parents fail with this OS error (a full
/// disk is error 28), for tests of what a write does when the disk fills.
static QUARANTINE_FAILURES: std::sync::Mutex<Vec<(PathBuf, i32)>> =
    std::sync::Mutex::new(Vec::new());

/// Make every quarantine created under `parent` fail with OS error `code`
/// until [`clear_quarantine_failure`].
pub(crate) fn fail_quarantines_in(parent: &Path, code: i32) {
    QUARANTINE_FAILURES
        .lock()
        .unwrap()
        .push((parent.to_path_buf(), code));
}

pub(crate) fn clear_quarantine_failure(parent: &Path) {
    QUARANTINE_FAILURES
        .lock()
        .unwrap()
        .retain(|(failing, _)| failing != parent);
}

/// The OS error a quarantine under `parent` fails with, if any.
pub(crate) fn quarantine_failure(parent: &Path) -> Option<std::io::Error> {
    QUARANTINE_FAILURES
        .lock()
        .unwrap()
        .iter()
        .find(|(failing, _)| failing == parent)
        .map(|(_, code)| std::io::Error::from_raw_os_error(*code))
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{install_script, is_busy, probe_start, start_once_free};

    /// A script that another process holds open for writing (as a child
    /// forked while the script was written does, until it starts its own
    /// program) is started only once that process lets it go, and starting
    /// it to see that it starts never runs its work.
    #[test]
    fn a_script_held_open_for_writing_starts_once_it_is_let_go() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("held");
        let ran = dir.path().join("ran");
        install_script(&script, &format!("#!/bin/sh\n: > '{}'\n", ran.display()));
        assert!(
            !ran.exists(),
            "starting it to see that it starts ran its work"
        );

        // The holder keeps the script open for writing until its input
        // ends.
        let opened = dir.path().join("opened");
        let mut holder = Command::new("sh")
            .arg("-c")
            .arg("exec 3>>\"$1\"; : > \"$2\"; read -r line; exit 0")
            .arg("sh")
            .arg(&script)
            .arg(&opened)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !opened.exists() {
            assert!(
                Instant::now() < deadline,
                "the holder never opened the script"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let first = probe_start(&script);
        let input = holder.stdin.take().unwrap();
        let let_go = Arc::new(AtomicBool::new(false));
        let letting_go = {
            let let_go = let_go.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                let_go.store(true, Ordering::SeqCst);
                drop(input);
            })
        };
        start_once_free(&script);
        let started_after_let_go = let_go.load(Ordering::SeqCst);
        letting_go.join().unwrap();
        assert!(holder.wait().unwrap().success());
        match first {
            // Linux refuses to start a file open for writing: the start
            // waited until the holder let it go.
            Err(error) => {
                assert!(is_busy(&error), "{error}");
                assert!(started_after_let_go, "the script started while held");
            }
            // Other systems start it at once.
            Ok(status) => assert!(status.success()),
        }
        assert!(!ran.exists());

        Command::new(&script).status().unwrap();
        assert!(ran.exists(), "the script's own work never ran");
    }
}
