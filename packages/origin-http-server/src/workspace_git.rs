//! Git commands against a single-tenant workspace checkout: the repository in
//! `.instafy/.git` with the workspace itself as the work tree.
//!
//! Every process starts from [`crate::git::server_git_command`], so hooks,
//! helpers, config includes, protocols and the transfer-speed bound are pinned
//! exactly as for the rest of the origin server. Before each command the
//! workspace-writable `.instafy/.git/config` is reduced to data-only settings,
//! and the bearer token is attached only to commands that talk to the remote.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use anyhow::{bail, Context, Result};

use crate::git::{
    instafy_git_dir, is_network_git_command, pin_command_cwd, refresh_instafy_git_worktree_config,
    server_git_command, validate_instafy_git_layout,
};
use crate::workspace_fs::WorkspaceDir;

/// Environment a caller may not inherit into a workspace git process: each
/// one would point the command at another repository, index or object store,
/// or change how pathspecs and identities are read.
const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_LITERAL_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "GIT_REFLOG_ACTION",
    "GIT_QUARANTINE_PATH",
    "GIT_REPLACE_REF_BASE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_SHALLOW_FILE",
    "GIT_GRAFT_FILE",
];

/// Options for one git process.
#[derive(Default)]
pub(crate) struct RunOpts<'b> {
    /// Use this index file instead of `.instafy/.git/index`.
    pub index_file: Option<&'b Path>,
    /// Extra environment, applied after the scrub.
    pub env: Vec<(&'static str, OsString)>,
    /// Bytes written to the process's stdin.
    pub stdin: Option<&'b [u8]>,
    /// Treat every pathspec as a literal path.
    pub literal_pathspecs: bool,
}

/// An identity for a commit's author or committer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
    /// `<epoch seconds> <+hhmm>`, or `None` for the current time.
    pub date: Option<String>,
}

impl GitIdentity {
    pub fn new(name: impl Into<String>, email: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            email: email.into(),
            date: None,
        }
    }

    pub fn at(mut self, date: Option<String>) -> Self {
        self.date = date;
        self
    }
}

/// Git in one workspace, optionally holding a bearer token for the remote.
#[derive(Clone, Copy)]
pub(crate) struct WorkspaceGit<'a> {
    root: &'a Path,
    token: Option<&'a str>,
    /// A shorter stall window for commands that talk to the remote.
    stall_seconds: Option<u32>,
}

impl<'a> WorkspaceGit<'a> {
    pub(crate) fn new(root: &'a Path, token: Option<&'a str>) -> Self {
        Self {
            root,
            token,
            stall_seconds: None,
        }
    }

    /// Give up on a fetch, push or ls-remote that moves no data for
    /// `seconds`, instead of the server-wide window. A stop has a fixed
    /// time to keep its work, and everything it parks is stored locally
    /// before it talks to the remote.
    pub(crate) fn with_stall_limit(mut self, seconds: u32) -> Self {
        self.stall_seconds = Some(seconds);
        self
    }

    pub(crate) fn root(&self) -> &'a Path {
        self.root
    }

    /// The repository directory, `.instafy/.git` under the workspace.
    pub(crate) fn git_dir(&self) -> PathBuf {
        instafy_git_dir(self.root)
    }

    /// Run git and return its output, whatever the exit status.
    pub(crate) fn run(&self, args: &[&str]) -> Result<Output> {
        self.run_opts(args, &RunOpts::default())
    }

    pub(crate) fn run_opts(&self, args: &[&str], opts: &RunOpts<'_>) -> Result<Output> {
        let network = is_network_git_command(args);
        let mut attempts = 0usize;
        loop {
            let output = self.spawn(args, opts, network)?;
            if output.status.success() || network || attempts >= 4 {
                return Ok(output);
            }
            // A git process the agent runs in the same checkout can hold the
            // index or a ref lock for a moment. Never remove a lock file; wait
            // and retry a bounded number of times instead.
            let stderr = String::from_utf8_lossy(&output.stderr);
            let busy = (stderr.contains(".lock") && stderr.contains("File exists"))
                || stderr.contains("Another git process seems to be running")
                || (stderr.contains("cannot lock ref") && stderr.contains("Unable to create"));
            if !busy {
                return Ok(output);
            }
            std::thread::sleep(Duration::from_millis(50u64 << attempts));
            attempts += 1;
        }
    }

    fn spawn(&self, args: &[&str], opts: &RunOpts<'_>, network: bool) -> Result<Output> {
        validate_instafy_git_layout(self.root)?;
        refresh_instafy_git_worktree_config(self.root)?;
        let workspace = WorkspaceDir::open(self.root)
            .with_context(|| format!("failed to open workspace {:?}", self.root))?;

        let mut command = server_git_command();
        pin_command_cwd(&mut command, &workspace)?;
        for key in SCRUBBED_ENV {
            command.env_remove(key);
        }
        command
            .arg("--git-dir")
            .arg(".instafy/.git")
            .arg("--work-tree")
            .arg(".");
        if network {
            if let Some(token) = self.token {
                command
                    .arg("-c")
                    .arg(format!("http.extraHeader=Authorization: Bearer {token}"));
            }
            if let Some(seconds) = self.stall_seconds {
                // The environment overrides the configured window.
                command.env("GIT_HTTP_LOW_SPEED_TIME", seconds.to_string());
            }
        }
        if let Some(index) = opts.index_file {
            command.env("GIT_INDEX_FILE", index);
        }
        if opts.literal_pathspecs {
            command.env("GIT_LITERAL_PATHSPECS", "1");
        }
        for (key, value) in &opts.env {
            command.env(key, value);
        }
        command.args(args);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        command.stdin(if opts.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to start git {}", describe(args)))?;
        let writer = match (opts.stdin, child.stdin.take()) {
            (Some(input), Some(mut stdin)) => {
                let input = input.to_vec();
                // Write from another thread so a command that answers while
                // it reads (cat-file --batch) never blocks on a full pipe.
                Some(std::thread::spawn(move || {
                    let _ = stdin.write_all(&input);
                }))
            }
            _ => None,
        };
        let output = child
            .wait_with_output()
            .with_context(|| format!("failed to run git {}", describe(args)))?;
        if let Some(writer) = writer {
            let _ = writer.join();
        }
        Ok(output)
    }

    /// Run git, require success, and return stdout.
    pub(crate) fn bytes_opts(&self, args: &[&str], opts: &RunOpts<'_>) -> Result<Vec<u8>> {
        let output = self.run_opts(args, opts)?;
        if !output.status.success() {
            bail!("{}", failure(args, &output));
        }
        Ok(output.stdout)
    }

    pub(crate) fn bytes(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.bytes_opts(args, &RunOpts::default())
    }

    /// Run git, require success, and return stdout without trailing newlines.
    pub(crate) fn stdout_opts(&self, args: &[&str], opts: &RunOpts<'_>) -> Result<String> {
        let bytes = self.bytes_opts(args, opts)?;
        Ok(String::from_utf8_lossy(&bytes).trim_end().to_string())
    }

    pub(crate) fn stdout(&self, args: &[&str]) -> Result<String> {
        self.stdout_opts(args, &RunOpts::default())
    }

    pub(crate) fn ok_opts(&self, args: &[&str], opts: &RunOpts<'_>) -> Result<()> {
        self.bytes_opts(args, opts).map(|_| ())
    }

    pub(crate) fn ok(&self, args: &[&str]) -> Result<()> {
        self.ok_opts(args, &RunOpts::default())
    }

    /// Run a yes/no command: exit 0 is true and exit 1 false. Anything else
    /// is an error, so a corrupt repository is never read as "no".
    pub(crate) fn test(&self, args: &[&str]) -> Result<bool> {
        let output = self.run(args)?;
        match output.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => bail!("{}", failure(args, &output)),
        }
    }

    /// Resolve `rev` to a full commit id, or `None` when it does not exist.
    pub(crate) fn commit_id(&self, rev: &str) -> Result<Option<String>> {
        let spec = format!("{rev}^{{commit}}");
        let output = self.run(&[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &spec,
        ])?;
        if output.status.success() {
            let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !id.is_empty() {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    /// The tree id of a commit or tree.
    pub(crate) fn tree_id(&self, rev: &str) -> Result<String> {
        let spec = format!("{rev}^{{tree}}");
        self.stdout(&["rev-parse", "--verify", "--end-of-options", &spec])
    }

    /// The empty tree, written so every later command can read it.
    pub(crate) fn empty_tree(&self) -> Result<String> {
        self.stdout_opts(
            &["hash-object", "-w", "-t", "tree", "--stdin"],
            &RunOpts {
                stdin: Some(b""),
                ..RunOpts::default()
            },
        )
    }

    /// Whether `ancestor` is reachable from `descendant` (or equal to it).
    pub(crate) fn is_ancestor(&self, ancestor: &str, descendant: &str) -> Result<bool> {
        self.test(&["merge-base", "--is-ancestor", ancestor, descendant])
    }

    pub(crate) fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>> {
        let output = self.run(&["merge-base", a, b])?;
        match output.status.code() {
            Some(0) => Ok(Some(
                String::from_utf8_lossy(&output.stdout).trim().to_string(),
            )),
            Some(1) => Ok(None),
            _ => bail!("{}", failure(&["merge-base", a, b], &output)),
        }
    }

    /// Set a ref only if it still holds `old` (`None`: it must not exist).
    pub(crate) fn update_ref(
        &self,
        reference: &str,
        new: &str,
        old: Option<&str>,
        reason: &str,
    ) -> Result<()> {
        let zero = zero_oid(new);
        let old = old.unwrap_or(zero.as_str());
        self.ok(&["update-ref", "-m", reason, reference, new, old])
    }

    pub(crate) fn delete_ref(&self, reference: &str, old: &str) -> Result<()> {
        self.ok(&["update-ref", "-d", reference, old])
    }

    /// `(name, id)` for every ref under `prefix`.
    pub(crate) fn refs_under(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let raw = self.stdout(&[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            prefix,
        ])?;
        Ok(raw
            .lines()
            .filter_map(|line| {
                let (name, id) = line.split_once('\0')?;
                Some((name.to_string(), id.to_string()))
            })
            .collect())
    }

    /// Commit `tree` with the given parents, identities and message, without
    /// touching any ref, index or file.
    pub(crate) fn commit_tree(
        &self,
        tree: &str,
        parents: &[&str],
        author: &GitIdentity,
        committer: &GitIdentity,
        message: &[u8],
    ) -> Result<String> {
        let mut args: Vec<&str> = vec!["commit-tree", "--no-gpg-sign", tree];
        for parent in parents {
            args.push("-p");
            args.push(parent);
        }
        let mut env = vec![
            ("GIT_AUTHOR_NAME", OsString::from(&author.name)),
            ("GIT_AUTHOR_EMAIL", OsString::from(&author.email)),
            ("GIT_COMMITTER_NAME", OsString::from(&committer.name)),
            ("GIT_COMMITTER_EMAIL", OsString::from(&committer.email)),
        ];
        if let Some(date) = author.date.as_deref() {
            env.push(("GIT_AUTHOR_DATE", OsString::from(date)));
        }
        if let Some(date) = committer.date.as_deref() {
            env.push(("GIT_COMMITTER_DATE", OsString::from(date)));
        }
        self.stdout_opts(
            &args,
            &RunOpts {
                env,
                stdin: Some(message),
                ..RunOpts::default()
            },
        )
    }

    /// Read objects with one `cat-file --batch`, in request order. A missing
    /// object is an error.
    pub(crate) fn read_objects(&self, ids: &[String]) -> Result<Vec<GitObject>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut input = Vec::new();
        for id in ids {
            input.extend_from_slice(id.as_bytes());
            input.push(b'\n');
        }
        let raw = self.bytes_opts(
            &["cat-file", "--batch"],
            &RunOpts {
                stdin: Some(&input),
                ..RunOpts::default()
            },
        )?;
        let mut objects = Vec::with_capacity(ids.len());
        let mut rest = raw.as_slice();
        for id in ids {
            let newline = rest
                .iter()
                .position(|byte| *byte == b'\n')
                .context("truncated cat-file output")?;
            let header = String::from_utf8_lossy(&rest[..newline]).to_string();
            rest = &rest[newline + 1..];
            let mut fields = header.split(' ');
            let _oid = fields.next();
            let kind = fields.next().unwrap_or_default().to_string();
            if kind == "missing" || kind.is_empty() {
                bail!("git object {id} is missing");
            }
            let size: usize = fields
                .next()
                .and_then(|value| value.parse().ok())
                .context("cat-file printed no size")?;
            if rest.len() < size + 1 {
                bail!("truncated cat-file output for {id}");
            }
            objects.push(GitObject {
                kind,
                data: rest[..size].to_vec(),
            });
            rest = &rest[size + 1..];
        }
        Ok(objects)
    }

    /// `(type, size)` for each id with one `cat-file --batch-check`; `None`
    /// for a missing object.
    pub(crate) fn object_sizes(&self, ids: &[String]) -> Result<Vec<Option<(String, u64)>>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut input = Vec::new();
        for id in ids {
            input.extend_from_slice(id.as_bytes());
            input.push(b'\n');
        }
        let raw = self.stdout_opts(
            &["cat-file", "--batch-check=%(objecttype) %(objectsize)"],
            &RunOpts {
                stdin: Some(&input),
                ..RunOpts::default()
            },
        )?;
        let lines: Vec<&str> = raw.lines().collect();
        if lines.len() != ids.len() {
            bail!(
                "cat-file --batch-check printed {} of {} lines",
                lines.len(),
                ids.len()
            );
        }
        Ok(lines
            .into_iter()
            .map(|line| {
                let mut fields = line.split(' ');
                let kind = fields.next()?.to_string();
                let size = fields.next()?.parse().ok()?;
                (size_or_missing(&kind)).then_some((kind, size))
            })
            .collect())
    }

    /// Entries of `tree` at exactly the given paths.
    pub(crate) fn tree_entries(
        &self,
        tree: &str,
        paths: &[String],
    ) -> Result<std::collections::BTreeMap<String, TreeEntry>> {
        let mut entries = std::collections::BTreeMap::new();
        if paths.is_empty() {
            return Ok(entries);
        }
        for chunk in paths.chunks(256) {
            let mut args: Vec<&str> = vec!["ls-tree", "-z", "--full-tree", tree, "--"];
            args.extend(chunk.iter().map(String::as_str));
            let raw = self.bytes_opts(
                &args,
                &RunOpts {
                    literal_pathspecs: true,
                    ..RunOpts::default()
                },
            )?;
            for entry in parse_ls_tree(&raw) {
                if chunk.iter().any(|path| path == &entry.path) {
                    entries.insert(entry.path.clone(), entry);
                }
            }
        }
        Ok(entries)
    }
}

/// One object read by [`WorkspaceGit::read_objects`].
pub(crate) struct GitObject {
    pub kind: String,
    pub data: Vec<u8>,
}

/// One `ls-tree` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TreeEntry {
    pub mode: String,
    pub kind: String,
    pub oid: String,
    pub path: String,
}

pub(crate) fn parse_ls_tree(raw: &[u8]) -> Vec<TreeEntry> {
    raw.split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let tab = record.iter().position(|byte| *byte == b'\t')?;
            let meta = std::str::from_utf8(&record[..tab]).ok()?;
            let path = std::str::from_utf8(&record[tab + 1..]).ok()?.to_string();
            let mut fields = meta.split(' ');
            Some(TreeEntry {
                mode: fields.next()?.to_string(),
                kind: fields.next()?.to_string(),
                oid: fields.next()?.to_string(),
                path,
            })
        })
        .collect()
}

fn size_or_missing(kind: &str) -> bool {
    kind != "missing"
}

/// The all-zero id in the same object format as `like`.
pub(crate) fn zero_oid(like: &str) -> String {
    "0".repeat(if like.len() == 64 { 64 } else { 40 })
}

fn describe(args: &[&str]) -> String {
    // Never echo a header that could carry a credential.
    args.iter()
        .filter(|arg| !arg.to_ascii_lowercase().contains("authorization"))
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn failure(args: &[&str], output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    format!(
        "git {} failed ({}): {}",
        describe(args),
        output.status,
        detail
    )
}

/// The `-z` path list format git reads with `--pathspec-file-nul`.
pub(crate) fn nul_list<S: AsRef<str>>(paths: &[S]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend_from_slice(path.as_ref().as_bytes());
        out.push(0);
    }
    out
}

/// Make a private directory for temporary index files inside the
/// repository, so they live on the same filesystem as the objects.
pub(crate) fn temp_index_dir(git: &WorkspaceGit<'_>) -> Result<tempfile::TempDir> {
    tempfile::Builder::new()
        .prefix("instafy-index-")
        .tempdir_in(git.git_dir())
        .context("failed to create a temporary index directory")
}

/// The git blob id of `content` (SHA-1 object format), computed in process
/// from bytes the caller already read without following links.
pub fn blob_oid(content: &[u8]) -> String {
    use sha1::{Digest as _, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", content.len()).as_bytes());
    hasher.update(content);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Largest file whose blob id a directory listing computes. Editors compare
/// ids of text files; larger files are listed without one.
pub const MAX_LISTED_BLOB_BYTES: u64 = 2 * 1024 * 1024;

/// Blob id of a workspace file read without following links; `None` for a
/// missing file, anything that is not a regular file, or a file larger than
/// `max_bytes`.
pub fn workspace_file_blob_oid(
    workspace: &crate::workspace_fs::WorkspaceDir,
    relative: &str,
    max_bytes: u64,
) -> std::io::Result<Option<String>> {
    use std::io::Read as _;
    let mut file = match workspace.open_file(relative) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if file.metadata()?.len() > max_bytes {
        return Ok(None);
    }
    let mut content = Vec::new();
    file.read_to_end(&mut content)?;
    Ok(Some(blob_oid(&content)))
}

#[cfg(test)]
mod blob_tests {
    #[test]
    fn blob_ids_match_git() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(
            super::blob_oid(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
        assert_eq!(
            super::blob_oid(b""),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
    }
}
