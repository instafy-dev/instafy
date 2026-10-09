//! Git commands against one repository, in one of two layouts:
//!
//! - a single-tenant workspace checkout: the repository in `.instafy/.git`
//!   with the workspace itself as the work tree;
//! - a bare repository the server created and is the only writer of (the
//!   hosted gateway's mirror of a canonical repository).
//!
//! Every process starts from [`crate::git::server_git_command`], so hooks,
//! helpers, config includes, protocols and the transfer-speed bound are pinned
//! exactly as for the rest of the origin server, and runs in a working
//! directory pinned to a descriptor opened without following links. Before
//! each checkout command the workspace-writable `.instafy/.git/config` is
//! reduced to data-only settings; a bare repository's layout is checked
//! instead (its config is the server's own). The bearer token is attached only
//! to commands that talk to the remote, and only through the environment,
//! never the argument list.
//!
//! New objects for a commit that is not on the remote yet can be written to a
//! [`Quarantine`] instead of the repository, and moved in only once the push
//! that needed them succeeded, so a refused push leaves nothing behind.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::git::{
    instafy_git_dir, is_network_git_command, pin_command_cwd, refresh_instafy_git_worktree_config,
    server_git_command, validate_instafy_git_layout,
};
use crate::workspace_fs::{WorkspaceDir, WorkspaceEntryKind};

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
    /// Run once: no wait-and-retry when a lock is held. For best-effort
    /// housekeeping that must never hold up its caller.
    pub single_attempt: bool,
    /// Stop the command at this time, local ones too, as a network
    /// deadline stops a fetch ([`WorkspaceGit::with_network_deadline`]).
    pub deadline: Option<Instant>,
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

/// Where a repository's files are.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Layout<'a> {
    /// A workspace checkout: the repository in `.instafy/.git` under `root`,
    /// with `root` as the work tree. The workspace (and so the repository's
    /// config) is writable by code running in it.
    Checkout { root: &'a Path },
    /// A bare repository at `git_dir` (an absolute path) that only the server
    /// writes. Commands run inside it with no work tree.
    Bare { git_dir: &'a Path },
}

/// Commands a quarantined handle may run: they read objects and refs, write
/// objects (into the quarantine) or push. Anything that could make a local
/// ref name an object that only the quarantine holds, or remove objects, is
/// refused, so dropping a quarantine can never leave the repository naming a
/// missing object.
const QUARANTINE_COMMANDS: &[&str] = &[
    "cat-file",
    "check-ignore",
    "commit-tree",
    "diff",
    "diff-tree",
    "for-each-ref",
    "hash-object",
    "log",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "merge-base",
    "merge-file",
    "mktree",
    "push",
    "read-tree",
    "rev-list",
    "rev-parse",
    "update-index",
    "write-tree",
];

/// Git in one repository, optionally holding a bearer token for the remote.
#[derive(Clone, Copy)]
pub(crate) struct WorkspaceGit<'a> {
    layout: Layout<'a>,
    token: Option<&'a str>,
    /// A shorter stall window for commands that talk to the remote.
    stall_seconds: Option<u32>,
    /// Commands that talk to the remote are stopped at this time, and none
    /// starts after it.
    network_deadline: Option<Instant>,
    /// New objects go to this objects directory (bare repositories only).
    quarantine: Option<&'a Path>,
    /// A work tree for commands that read files (bare repositories only).
    work_tree: Option<&'a Path>,
}

impl<'a> WorkspaceGit<'a> {
    /// Git in the workspace checkout at `root`.
    pub(crate) fn new(root: &'a Path, token: Option<&'a str>) -> Self {
        Self::with_layout(Layout::Checkout { root }, token)
    }

    fn with_layout(layout: Layout<'a>, token: Option<&'a str>) -> Self {
        Self {
            layout,
            token,
            stall_seconds: None,
            network_deadline: None,
            quarantine: None,
            work_tree: None,
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

    /// Stop every fetch, push or ls-remote at `deadline`, connecting
    /// included, and start none after it. A stop's time to keep its work is
    /// fixed; what it parked locally first stays for the next publish.
    pub(crate) fn with_network_deadline(mut self, deadline: Instant) -> Self {
        self.network_deadline = Some(deadline);
        self
    }

    /// The workspace root of a checkout. Only checkout code (publish, stale
    /// copy repair) asks for it; a bare repository has no workspace, and
    /// asking is a programming error.
    #[track_caller]
    pub(crate) fn root(&self) -> &'a Path {
        match self.layout {
            Layout::Checkout { root } => root,
            Layout::Bare { git_dir } => {
                panic!("the bare repository {git_dir:?} has no workspace root")
            }
        }
    }

    /// The repository directory: `.instafy/.git` under a checkout's
    /// workspace, or the bare repository itself. Temporary index and merge
    /// files are made here, on the same filesystem as the objects.
    pub(crate) fn git_dir(&self) -> PathBuf {
        match self.layout {
            Layout::Checkout { root } => instafy_git_dir(root),
            Layout::Bare { git_dir } => git_dir.to_path_buf(),
        }
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
            if output.status.success() || network || opts.single_attempt || attempts >= 4 {
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
        let deadline = match (self.network_deadline.filter(|_| network), opts.deadline) {
            (Some(network), Some(own)) => Some(network.min(own)),
            (network, own) => network.or(own),
        };
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            bail!("no time left to run git {}", describe(args));
        }
        let mut command = server_git_command();
        match self.layout {
            Layout::Checkout { root } => {
                if self.quarantine.is_some() || self.work_tree.is_some() {
                    bail!("a workspace checkout takes no quarantine or separate work tree");
                }
                validate_instafy_git_layout(root)?;
                refresh_instafy_git_worktree_config(root)?;
                let workspace = WorkspaceDir::open(root)
                    .with_context(|| format!("failed to open workspace {root:?}"))?;
                pin_command_cwd(&mut command, &workspace)?;
                for key in SCRUBBED_ENV {
                    command.env_remove(key);
                }
                command
                    .arg("--git-dir")
                    .arg(".instafy/.git")
                    .arg("--work-tree")
                    .arg(".");
            }
            Layout::Bare { git_dir } => {
                let repository = open_bare_repository(git_dir)?;
                if self.quarantine.is_some()
                    && !QUARANTINE_COMMANDS.contains(&args.first().copied().unwrap_or_default())
                {
                    bail!(
                        "git {} may not run with a quarantine: it could leave a ref naming a \
                         quarantined object",
                        describe(args)
                    );
                }
                match self.work_tree {
                    // The work tree is the working directory; the repository
                    // was just checked by its descriptor.
                    Some(work_tree) => {
                        if !work_tree.is_absolute() {
                            bail!("a work tree path must be absolute: {work_tree:?}");
                        }
                        let work_tree = WorkspaceDir::open(work_tree)
                            .with_context(|| format!("failed to open work tree {work_tree:?}"))?;
                        pin_command_cwd(&mut command, &work_tree)?;
                        command
                            .arg("--git-dir")
                            .arg(git_dir)
                            .arg("--work-tree")
                            .arg(".");
                    }
                    None => {
                        pin_command_cwd(&mut command, &repository)?;
                        command
                            .arg("--git-dir")
                            .arg(".")
                            .arg("-c")
                            .arg("core.bare=true");
                    }
                }
                // Ignore and attribute rules come only from the trees the
                // server reads, never from the server user's home.
                command
                    .arg("-c")
                    .arg("core.excludesFile=/dev/null")
                    .arg("-c")
                    .arg("core.attributesFile=/dev/null");
                // No automatic maintenance: after a fetch git would start a
                // detached `maintenance run` that repacks the repository
                // once the request is answered, outside any bound the
                // server keeps (and, under a PID 1 that does not reap, as a
                // zombie). The owner packs on purpose instead; a caller's
                // own `-c` comes later and wins.
                command
                    .arg("-c")
                    .arg("maintenance.auto=false")
                    .arg("-c")
                    .arg("gc.auto=0");
                for key in SCRUBBED_ENV {
                    command.env_remove(key);
                }
                if let Some(objects) = self.quarantine {
                    command.env("GIT_OBJECT_DIRECTORY", objects).env(
                        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                        quoted_alternate(&git_dir.join("objects"))?,
                    );
                }
            }
        }
        if network {
            if let Some(token) = self.token {
                // Through the environment, never the argument list, which
                // any process on the machine can read. `server_git_command`
                // removed every inherited `GIT_CONFIG_*` variable, so this is
                // the only entry.
                command
                    .env("GIT_CONFIG_COUNT", "1")
                    .env("GIT_CONFIG_KEY_0", "http.extraHeader")
                    .env(
                        "GIT_CONFIG_VALUE_0",
                        format!("Authorization: Bearer {token}"),
                    );
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
        let output = match deadline {
            // Read the output on other threads so a full pipe never blocks
            // the command, and kill it at the deadline.
            Some(deadline) => {
                let stdout = child.stdout.take().map(read_on_thread);
                let stderr = child.stderr.take().map(read_on_thread);
                let status = loop {
                    if let Some(status) = child
                        .try_wait()
                        .with_context(|| format!("failed to run git {}", describe(args)))?
                    {
                        break status;
                    }
                    if Instant::now() >= deadline {
                        terminate(&mut child);
                        // A helper the command started can hold the pipes
                        // open, so the readers are left to finish on their own.
                        bail!("git {} ran out of time", describe(args));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                };
                Output {
                    status,
                    stdout: joined(stdout),
                    stderr: joined(stderr),
                }
            }
            None => child
                .wait_with_output()
                .with_context(|| format!("failed to run git {}", describe(args)))?,
        };
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

    /// Entries of `tree_ish` (a full commit or tree id) at exactly `paths`
    /// (relative and `/`-separated, as reads normalize them): a folder, a
    /// file, a link or a submodule. A path that is absent, or lies below a
    /// file, has none. Folders are read by id from the root down
    /// ([`Self::folder_listings`]), with ids on stdin, so a path is never an
    /// argument of git, and a folder whose object cannot be read is an
    /// error, never an absent path. A path holding a newline is found in one
    /// full listing instead.
    pub(crate) fn entries_by_path(
        &self,
        tree_ish: &str,
        paths: &[String],
    ) -> Result<std::collections::BTreeMap<String, TreeEntry>> {
        let mut found = std::collections::BTreeMap::new();
        if paths.is_empty() {
            return Ok(found);
        }
        if paths.iter().any(|path| path.contains('\n')) {
            let raw = self.bytes(&[
                "ls-tree",
                "-r",
                "-t",
                "-z",
                "--full-tree",
                "--end-of-options",
                tree_ish,
            ])?;
            let wanted: std::collections::HashSet<&str> =
                paths.iter().map(String::as_str).collect();
            for entry in parse_ls_tree(&raw) {
                if wanted.contains(entry.path.as_str()) {
                    found.insert(entry.path.clone(), entry);
                }
            }
            return Ok(found);
        }
        let folders: Vec<&str> = paths.iter().map(|path| folder_of(path)).collect();
        let listings = self
            .folder_listings(std::slice::from_ref(&tree_ish.to_string()), &folders)?
            .pop()
            .unwrap_or_default();
        for path in paths {
            let entry = listings
                .get(folder_of(path))
                .and_then(|entries| entries.iter().find(|entry| entry.path == *path));
            if let Some(entry) = entry {
                found.insert(path.clone(), entry.clone());
            }
        }
        Ok(found)
    }

    /// The entry at `path` in each of `tree_ishes` (full commit or tree
    /// ids), in order, as [`Self::entries_by_path`] finds one, with one
    /// `cat-file --batch` per folder level for all of them.
    pub(crate) fn entry_in_each(
        &self,
        tree_ishes: &[String],
        path: &str,
    ) -> Result<Vec<Option<TreeEntry>>> {
        if path.contains('\n') {
            let wanted = [path.to_string()];
            return tree_ishes
                .iter()
                .map(|tree_ish| Ok(self.entries_by_path(tree_ish, &wanted)?.remove(path)))
                .collect();
        }
        let folder = folder_of(path);
        Ok(self
            .folder_listings(tree_ishes, &[folder])?
            .into_iter()
            .map(|listings| {
                listings
                    .get(folder)
                    .and_then(|entries| entries.iter().find(|entry| entry.path == path))
                    .cloned()
            })
            .collect())
    }

    /// For each of `tree_ishes`, the listings of `folders` and of every
    /// folder above them that it has, by folder path ("" is the root). Each
    /// level is one `cat-file --batch` of tree ids (the root's from the
    /// commit itself), so a tree a listing names but the repository cannot
    /// give is an error (`git object <id> is missing`) rather than a folder
    /// that is not there.
    fn folder_listings(
        &self,
        tree_ishes: &[String],
        folders: &[&str],
    ) -> Result<Vec<std::collections::HashMap<String, Vec<TreeEntry>>>> {
        let mut levels: std::collections::BTreeMap<usize, std::collections::BTreeSet<&str>> =
            std::collections::BTreeMap::new();
        for folder in folders {
            let mut current = *folder;
            while !current.is_empty() {
                levels
                    .entry(current.matches('/').count() + 1)
                    .or_default()
                    .insert(current);
                current = folder_of(current);
            }
        }
        // The root trees.
        let mut roots = Vec::with_capacity(tree_ishes.len());
        for (tree_ish, object) in tree_ishes.iter().zip(self.read_objects(tree_ishes)?) {
            roots.push(match object.kind.as_str() {
                "tree" => object,
                "commit" => {
                    let tree = String::from_utf8_lossy(&object.data)
                        .lines()
                        .next()
                        .and_then(|line| line.strip_prefix("tree "))
                        .map(str::to_string)
                        .with_context(|| format!("commit {tree_ish} names no tree"))?;
                    self.read_objects(std::slice::from_ref(&tree))?
                        .pop()
                        .with_context(|| format!("tree {tree} was not read"))?
                }
                other => bail!("{tree_ish} is a {other}, not a commit or tree"),
            });
        }
        let id_bytes = |tree_ish: &str| if tree_ish.len() == 64 { 32 } else { 20 };
        let mut listings = Vec::with_capacity(tree_ishes.len());
        for (tree_ish, root) in tree_ishes.iter().zip(roots) {
            if root.kind != "tree" {
                bail!("the tree of {tree_ish} is a {}", root.kind);
            }
            let mut by_folder = std::collections::HashMap::new();
            by_folder.insert(
                String::new(),
                parse_tree_object(&root.data, id_bytes(tree_ish), "")?,
            );
            listings.push(by_folder);
        }
        for level in levels.values() {
            let mut wanted: Vec<(usize, &str)> = Vec::new();
            let mut ids: Vec<String> = Vec::new();
            for (index, by_folder) in listings.iter().enumerate() {
                for folder in level {
                    let tree = by_folder
                        .get(folder_of(folder))
                        .and_then(|entries| entries.iter().find(|entry| entry.path == *folder))
                        .filter(|entry| entry.kind == "tree");
                    if let Some(tree) = tree {
                        wanted.push((index, folder));
                        ids.push(tree.oid.clone());
                    }
                }
            }
            for ((index, folder), object) in wanted.into_iter().zip(self.read_objects(&ids)?) {
                if object.kind != "tree" {
                    bail!("the folder {folder} is a {}", object.kind);
                }
                let entries =
                    parse_tree_object(&object.data, id_bytes(&tree_ishes[index]), folder)?;
                listings[index].insert(folder.to_string(), entries);
            }
        }
        Ok(listings)
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

/// Bare repositories, quarantines and separate work trees: the hosted
/// gateway's layout.
#[cfg_attr(not(test), allow(dead_code))]
impl<'a> WorkspaceGit<'a> {
    /// Git in the bare repository at `git_dir`, an absolute path. The
    /// repository must have been created by the server ([`Self::init_bare`]);
    /// its config is not sanitised before each command.
    pub(crate) fn bare(git_dir: &'a Path, token: Option<&'a str>) -> Self {
        Self::with_layout(Layout::Bare { git_dir }, token)
    }

    /// Create an empty bare repository at `git_dir` (an absolute path whose
    /// last component must not exist yet), private to the server, with
    /// `main` as its initial branch and no template files (no sample hooks).
    pub(crate) fn init_bare(git_dir: &Path) -> Result<()> {
        if !git_dir.is_absolute() {
            bail!("a bare repository path must be absolute: {git_dir:?}");
        }
        create_private_dir(git_dir)
            .with_context(|| format!("failed to create bare repository {git_dir:?}"))?;
        WorkspaceGit::bare(git_dir, None).ok(&[
            "init",
            "--bare",
            "--quiet",
            "--template=",
            "--initial-branch=main",
        ])
    }

    /// Write new objects to `quarantine` instead of the repository, while
    /// still reading the repository's own objects. Only for a bare
    /// repository, and only for the commands in [`QUARANTINE_COMMANDS`].
    pub(crate) fn with_quarantine(mut self, quarantine: &'a Quarantine) -> Self {
        self.quarantine = Some(quarantine.objects_dir());
        self
    }

    /// Run commands with `work_tree` (an absolute path to a directory the
    /// server prepared) as the work tree, for commands that read files such
    /// as `check-ignore --no-index`. Only for a bare repository.
    pub(crate) fn with_work_tree(mut self, work_tree: &'a Path) -> Self {
        self.work_tree = Some(work_tree);
        self
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

/// The folder `path` lies in ("" for the root).
fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

/// The entries of a raw tree object (`<mode> <name>\0<id>` records, ids of
/// `id_bytes` bytes) of the folder at `folder`, as `ls-tree` shows them:
/// full paths, canonical six-digit modes and the object type. Names that
/// are not UTF-8 are left out, as [`parse_ls_tree`] leaves them out.
fn parse_tree_object(data: &[u8], id_bytes: usize, folder: &str) -> Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let space = rest
            .iter()
            .position(|byte| *byte == b' ')
            .context("malformed tree object")?;
        let mode = std::str::from_utf8(&rest[..space])
            .ok()
            .and_then(|mode| u32::from_str_radix(mode, 8).ok())
            .context("malformed tree object")?;
        rest = &rest[space + 1..];
        let nul = rest
            .iter()
            .position(|byte| *byte == 0)
            .context("malformed tree object")?;
        let name = &rest[..nul];
        rest = &rest[nul + 1..];
        if rest.len() < id_bytes {
            bail!("malformed tree object");
        }
        let oid: String = rest[..id_bytes]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        rest = &rest[id_bytes..];
        let Ok(name) = std::str::from_utf8(name) else {
            continue;
        };
        // Git's `canon_mode`.
        let (mode, kind) = match mode & 0o170000 {
            0o100000 if mode & 0o100 != 0 => ("100755", "blob"),
            0o100000 => ("100644", "blob"),
            0o120000 => ("120000", "blob"),
            0o040000 => ("040000", "tree"),
            _ => ("160000", "commit"),
        };
        entries.push(TreeEntry {
            mode: mode.to_string(),
            kind: kind.to_string(),
            oid,
            path: if folder.is_empty() {
                name.to_string()
            } else {
                format!("{folder}/{name}")
            },
        });
    }
    Ok(entries)
}

fn size_or_missing(kind: &str) -> bool {
    kind != "missing"
}

/// The all-zero id in the same object format as `like`.
pub(crate) fn zero_oid(like: &str) -> String {
    "0".repeat(if like.len() == 64 { 64 } else { 40 })
}

/// Open a bare repository's directory without following a link, and check
/// that what git reads to find its objects and refs are real files and
/// directories, never links, and that nothing points git at another
/// repository's objects or history.
fn open_bare_repository(git_dir: &Path) -> Result<WorkspaceDir> {
    if !git_dir.is_absolute() {
        bail!("a bare repository path must be absolute: {git_dir:?}");
    }
    let repository = WorkspaceDir::open(git_dir)
        .with_context(|| format!("failed to open bare repository {git_dir:?}"))?;
    for (relative, expected) in [
        ("HEAD", WorkspaceEntryKind::File),
        ("config", WorkspaceEntryKind::File),
        ("packed-refs", WorkspaceEntryKind::File),
        ("objects", WorkspaceEntryKind::Directory),
        ("refs", WorkspaceEntryKind::Directory),
    ] {
        match repository.entry_kind(relative) {
            Ok(kind) if kind == expected => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => bail!("{relative:?} in bare repository {git_dir:?} has the wrong type"),
            Err(error) => {
                bail!(
                    "{relative:?} in bare repository {git_dir:?} is not safely contained: {error}"
                )
            }
        }
    }
    for redirect in ["commondir", "objects/info/alternates", "info/grafts"] {
        match repository.entry_kind(redirect) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => {
                bail!("bare repository {git_dir:?} has {redirect:?}, which the server never writes")
            }
        }
    }
    Ok(repository)
}

/// `path` as one entry of `GIT_ALTERNATE_OBJECT_DIRECTORIES`. Git splits
/// that list on `:` (`;` on Windows) and C-unquotes an entry that starts
/// with `"`, so the path is always quoted: a `:` in a self-hoster's root
/// must not split it. A path with control bytes is refused.
fn quoted_alternate(path: &Path) -> Result<OsString> {
    let text = path
        .to_str()
        .with_context(|| format!("the repository path {path:?} is not UTF-8"))?;
    if text.chars().any(char::is_control) {
        bail!("the repository path {path:?} holds a control character");
    }
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        if matches!(character, '"' | '\\') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    Ok(OsString::from(quoted))
}

/// Create one directory, readable only by the server's user. Fails when the
/// name exists in any form, a link included.
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// A private objects directory for one change that is not on the remote yet.
///
/// A handle made with [`WorkspaceGit::with_quarantine`] writes every new
/// object here while still reading the repository's own objects, so a commit
/// can be built and pushed without adding anything to the repository.
/// [`Quarantine::promote`] moves the objects in once the push succeeded;
/// dropping the quarantine removes it with whatever was not promoted, so a
/// refused push leaves no object behind.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct Quarantine {
    dir: PathBuf,
    objects: PathBuf,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Quarantine {
    /// A new quarantine under `parent`: an absolute path to an existing
    /// directory (not a link) on the same filesystem as the repositories it
    /// serves. It is named by a fresh UUID and readable only by the server.
    pub(crate) fn create_in(parent: &Path) -> Result<Self> {
        if !parent.is_absolute() {
            bail!("a quarantine parent must be an absolute path: {parent:?}");
        }
        WorkspaceDir::open(parent)
            .with_context(|| format!("failed to open quarantine parent {parent:?}"))?;
        let dir = parent.join(uuid::Uuid::new_v4().as_hyphenated().to_string());
        #[cfg(test)]
        if let Some(error) = crate::test_support::quarantine_failure(parent) {
            return Err(error).with_context(|| format!("failed to create quarantine {dir:?}"));
        }
        create_private_dir(&dir).with_context(|| format!("failed to create quarantine {dir:?}"))?;
        let quarantine = Self {
            objects: dir.join("objects"),
            dir,
        };
        for relative in ["", "info", "pack"] {
            let path = quarantine.objects.join(relative);
            create_private_dir(&path)
                .with_context(|| format!("failed to create quarantine directory {path:?}"))?;
        }
        Ok(quarantine)
    }

    /// The quarantine's own directory.
    pub(crate) fn path(&self) -> &Path {
        &self.dir
    }

    /// The objects directory new objects are written to.
    pub(crate) fn objects_dir(&self) -> &Path {
        &self.objects
    }

    /// Move every object written here into the bare repository `git` works
    /// in, never replacing an object it already has, and returns how many
    /// files were moved. Call it only after the push that needed the
    /// objects succeeded, and before any local ref is set to them.
    ///
    /// Objects move in an order that keeps the rule "a commit in the
    /// repository has everything it names": loose blobs and trees, then
    /// packs (each index after its pack), then loose commits with every
    /// parent before its children, then anything else. A promotion that
    /// stops partway (a full disk, a stop) leaves commits out, never their
    /// trees, so a reader that finds a commit can read all of it, and a
    /// later promotion of the same quarantine finishes the job.
    pub(crate) fn promote(&self, git: &WorkspaceGit<'_>) -> Result<usize> {
        let Layout::Bare { git_dir } = git.layout else {
            bail!("only a bare repository takes quarantined objects");
        };
        open_bare_repository(git_dir)?;
        let target = git_dir.join("objects");
        let (loose, mut packs) = self.contents()?;

        // Each object's type, read through the quarantine.
        let staged = WorkspaceGit::bare(git_dir, None).with_quarantine(self);
        let ids: Vec<String> = loose.iter().map(|(id, _)| id.clone()).collect();
        let kinds = staged.object_sizes(&ids)?;
        let mut contents = Vec::new();
        let mut commits = Vec::new();
        let mut others = Vec::new();
        for (object, kind) in loose.into_iter().zip(kinds) {
            match kind.as_ref().map(|(kind, _)| kind.as_str()) {
                Some("blob") => contents.push((0, object)),
                Some("tree") => contents.push((1, object)),
                Some("commit") => commits.push(object),
                _ => others.push(object),
            }
        }
        contents.sort_by_key(|(rank, _)| *rank);
        let commits = parents_first(&staged, commits)?;

        let mut moved = 0usize;
        for (_, (id, path)) in contents {
            moved += usize::from(move_loose_object(&target, &id, &path)?);
        }
        if !packs.is_empty() {
            let pack_dir = target.join("pack");
            ensure_object_dir(&pack_dir)?;
            // An index makes git look for its pack: move it last.
            packs.sort_by_key(|name| (name.ends_with(".idx"), name.clone()));
            for name in packs {
                let from = self.objects.join("pack").join(&name);
                moved += usize::from(move_object(&from, &pack_dir.join(&name))?);
            }
        }
        for (id, path) in commits.into_iter().chain(others) {
            moved += usize::from(move_loose_object(&target, &id, &path)?);
        }
        Ok(moved)
    }

    /// The loose objects (`(id, file)`) and pack file names written here.
    fn contents(&self) -> Result<(Vec<(String, PathBuf)>, Vec<String>)> {
        let mut loose = Vec::new();
        let mut packs = Vec::new();
        for entry in std::fs::read_dir(&self.objects)
            .with_context(|| format!("failed to read quarantine {:?}", self.objects))?
        {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if name == "pack" {
                for file in std::fs::read_dir(entry.path())? {
                    let file = file?;
                    let file_name = file.file_name().to_string_lossy().to_string();
                    if file.file_type()?.is_file() && is_pack_file_name(&file_name) {
                        packs.push(file_name);
                    }
                }
                continue;
            }
            if name.len() != 2 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                continue;
            }
            for file in std::fs::read_dir(entry.path())? {
                let file = file?;
                let file_name = file.file_name().to_string_lossy().to_string();
                let is_object = matches!(file_name.len(), 38 | 62)
                    && file_name.bytes().all(|byte| byte.is_ascii_hexdigit());
                if is_object && file.file_type()?.is_file() {
                    loose.push((format!("{name}{file_name}"), file.path()));
                }
            }
        }
        Ok((loose, packs))
    }
}

/// Move the loose object `id` (at `path`) into the objects directory
/// `target`. Returns whether it was new there.
fn move_loose_object(target: &Path, id: &str, path: &Path) -> Result<bool> {
    let fan_out = target.join(&id[..2]);
    ensure_object_dir(&fan_out)?;
    move_object(path, &fan_out.join(&id[2..]))
}

/// `commits` (loose quarantined commits, `(id, file)`) ordered so that every
/// commit comes after the parents among them.
fn parents_first(
    staged: &WorkspaceGit<'_>,
    commits: Vec<(String, PathBuf)>,
) -> Result<Vec<(String, PathBuf)>> {
    if commits.len() < 2 {
        return Ok(commits);
    }
    let ids: Vec<String> = commits.iter().map(|(id, _)| id.clone()).collect();
    let objects = staged.read_objects(&ids)?;
    let mut waiting: Vec<((String, PathBuf), Vec<String>)> = commits
        .into_iter()
        .zip(objects)
        .map(|(commit, object)| {
            let header_end = object
                .data
                .windows(2)
                .position(|window| window == b"\n\n")
                .unwrap_or(object.data.len());
            let parents = String::from_utf8_lossy(&object.data[..header_end])
                .lines()
                .filter_map(|line| line.strip_prefix("parent "))
                .map(|parent| parent.trim().to_string())
                .filter(|parent| ids.contains(parent))
                .collect();
            (commit, parents)
        })
        .collect();
    let mut ordered: Vec<(String, PathBuf)> = Vec::with_capacity(waiting.len());
    while !waiting.is_empty() {
        let ready = waiting.iter().position(|(_, parents)| {
            parents
                .iter()
                .all(|parent| ordered.iter().any(|(id, _)| id == parent))
        });
        let Some(ready) = ready else {
            bail!("quarantined commits name each other as parents");
        };
        ordered.push(waiting.remove(ready).0);
    }
    Ok(ordered)
}

impl Drop for Quarantine {
    fn drop(&mut self) {
        // Does not follow links inside the directory.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn is_pack_file_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("pack-") else {
        return false;
    };
    let Some((hash, extension)) = rest.split_once('.') else {
        return false;
    };
    matches!(hash.len(), 40 | 64)
        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        && matches!(extension, "pack" | "idx" | "rev" | "mtimes")
}

/// Make sure `dir` (an object fan-out or pack directory of a bare
/// repository) exists and is a real directory.
fn ensure_object_dir(dir: &Path) -> Result<()> {
    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).with_context(|| format!("failed to create {dir:?}")),
    }
    let metadata = std::fs::symlink_metadata(dir)?;
    if !metadata.file_type().is_dir() {
        bail!("{dir:?} is not a directory");
    }
    Ok(())
}

/// Move one object file without replacing an existing one: a hard link (the
/// quarantine's own name goes when it is dropped), or a rename where the
/// filesystem has no hard links. Returns whether the object was new.
fn move_object(from: &Path, to: &Path) -> Result<bool> {
    match std::fs::hard_link(from, to) {
        Ok(()) => Ok(true),
        // Objects are named by their content: the one there is the same.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => match std::fs::symlink_metadata(to) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::rename(from, to)
                    .with_context(|| format!("failed to move {from:?} to {to:?}"))?;
                Ok(true)
            }
            Err(error) => Err(error).with_context(|| format!("failed to inspect {to:?}")),
        },
    }
}

/// How long a command that ran out of time has to exit after SIGTERM.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

/// Stop a command that ran out of time: SIGTERM first, so git removes the
/// lock files it holds (a ref update killed outright leaves `*.lock` files
/// behind that make every later fetch and save of the checkout fail), and
/// SIGKILL only when it is still running after [`TERMINATE_GRACE`].
fn terminate(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = rustix::process::Pid::from_child(child);
        if rustix::process::kill_process(pid, rustix::process::Signal::TERM).is_ok() {
            let grace = Instant::now() + TERMINATE_GRACE;
            while Instant::now() < grace {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Read all of `pipe` on a thread of its own.
fn read_on_thread<R: std::io::Read + Send + 'static>(
    mut pipe: R,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    })
}

fn joined(reader: Option<std::thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    reader
        .map(|reader| reader.join().unwrap_or_default())
        .unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::io::{Read as _, Write as _};
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::publish_policy::RejectReason;
    use crate::push::{push, PushClass};
    use crate::test_support::{git_in, git_output, install_shard_hook};
    use crate::tree_merge::three_way;

    /// A canonical bare repository with one commit on `main`, a mirror the
    /// server's own handle created and filled from it, and a directory for
    /// quarantines.
    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        canonical: PathBuf,
        mirror: PathBuf,
        quarantines: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            Self::under("")
        }

        /// The fixture inside a folder named `name` ("" for none).
        fn under(name: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap().join(name);
            std::fs::create_dir_all(&root).unwrap();
            let canonical = root.join("canonical.git");
            git_in(
                &root,
                &["init", "--quiet", "--bare", "-b", "main", "canonical.git"],
            );
            let seed = root.join("seed");
            git_in(&root, &["init", "--quiet", "-b", "main", "seed"]);
            std::fs::write(seed.join("README.md"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
            std::fs::create_dir_all(seed.join("src")).unwrap();
            std::fs::write(seed.join("src/lib.rs"), "pub fn lib() {}\n").unwrap();
            git_in(&seed, &["add", "."]);
            git_in(
                &seed,
                &[
                    "-c",
                    "user.name=Seed",
                    "-c",
                    "user.email=seed@instafy.dev",
                    "commit",
                    "--quiet",
                    "-m",
                    "seed",
                ],
            );
            git_in(
                &seed,
                &["push", "--quiet", canonical.to_str().unwrap(), "main"],
            );

            let mirror = root.join("mirror.git");
            WorkspaceGit::init_bare(&mirror).unwrap();
            let fixture = Self {
                _dir: dir,
                quarantines: root.join("quarantine"),
                root,
                canonical,
                mirror,
            };
            std::fs::create_dir(&fixture.quarantines).unwrap();
            fixture.fetch_main();
            fixture
        }

        fn url(&self) -> String {
            self.canonical.to_string_lossy().to_string()
        }

        fn git(&self) -> WorkspaceGit<'_> {
            WorkspaceGit::bare(&self.mirror, None)
        }

        fn fetch_main(&self) {
            self.git()
                .ok(&[
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    &self.url(),
                    "+refs/heads/main:refs/heads/main",
                ])
                .unwrap();
        }

        fn main(&self) -> String {
            self.git().commit_id("refs/heads/main").unwrap().unwrap()
        }

        fn canonical_main(&self) -> String {
            git_in(&self.canonical, &["rev-parse", "refs/heads/main"])
        }
    }

    fn identity() -> GitIdentity {
        GitIdentity::new("Instafy Origin", "origin@instafy.dev")
    }

    /// A child of `parent` with `path` set to `content`, built through `git`.
    fn commit_in(git: &WorkspaceGit<'_>, parent: &str, path: &str, content: &[u8]) -> String {
        let blob = git
            .stdout_opts(
                &["hash-object", "-w", "--stdin"],
                &RunOpts {
                    stdin: Some(content),
                    ..RunOpts::default()
                },
            )
            .unwrap();
        let scratch = temp_index_dir(git).unwrap();
        let index = scratch.path().join("index");
        let opts = RunOpts {
            index_file: Some(&index),
            ..RunOpts::default()
        };
        git.ok_opts(&["read-tree", parent], &opts).unwrap();
        let cacheinfo = format!("100644,{blob},{path}");
        git.ok_opts(&["update-index", "--add", "--cacheinfo", &cacheinfo], &opts)
            .unwrap();
        let tree = git.stdout_opts(&["write-tree"], &opts).unwrap();
        git.commit_tree(&tree, &[parent], &identity(), &identity(), b"change\n")
            .unwrap()
    }

    /// Every loose object and pack file of a repository.
    fn object_files(git_dir: &Path) -> BTreeSet<String> {
        let mut files = BTreeSet::new();
        let objects = git_dir.join("objects");
        for entry in std::fs::read_dir(&objects).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "info" || !entry.file_type().unwrap().is_dir() {
                continue;
            }
            for file in std::fs::read_dir(entry.path()).unwrap() {
                let file = file.unwrap().file_name().to_string_lossy().to_string();
                files.insert(format!("{name}/{file}"));
            }
        }
        files
    }

    #[test]
    fn init_bare_makes_a_private_repository_without_hooks() {
        let fixture = Fixture::new();
        let git = fixture.git();
        assert_eq!(
            git.stdout(&["rev-parse", "--is-bare-repository"]).unwrap(),
            "true"
        );
        assert_eq!(
            git.stdout(&["symbolic-ref", "HEAD"]).unwrap(),
            "refs/heads/main"
        );
        assert!(!fixture.mirror.join("hooks").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&fixture.mirror)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        assert_eq!(git.git_dir(), fixture.mirror);
        assert_eq!(fixture.main(), fixture.canonical_main());

        // Never over an existing name, and only at an absolute path.
        assert!(WorkspaceGit::init_bare(&fixture.mirror).is_err());
        assert!(WorkspaceGit::init_bare(Path::new("relative.git")).is_err());
    }

    /// Plan test 8: a refused push leaves no object in the mirror, and a
    /// promoted write is readable without the canonical repository.
    #[test]
    fn a_refused_push_leaves_nothing_and_a_promoted_write_needs_no_download() {
        let fixture = Fixture::new();
        install_shard_hook(&fixture.canonical, &[]);
        let git = fixture.git();
        let main = fixture.main();
        let before = object_files(&fixture.mirror);

        let refused = {
            let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
            let staged = git.with_quarantine(&quarantine);
            let commit = commit_in(&staged, &main, "node_modules/left.js", b"blocked\n");
            // Readable through the quarantine, absent from the mirror.
            assert!(staged.commit_id(&commit).unwrap().is_some());
            assert!(git.commit_id(&commit).unwrap().is_none());
            let result = push(
                &staged,
                &fixture.url(),
                &[format!("{commit}:refs/heads/main")],
                &[],
            )
            .unwrap();
            assert_eq!(
                result.class,
                PushClass::PathRejected {
                    path: "node_modules/left.js".to_string(),
                    reason: RejectReason::Policy,
                    others: Vec::new(),
                }
            );
            assert!(quarantine.path().exists());
            quarantine.path().to_path_buf()
        };
        assert!(!refused.exists(), "the quarantine outlived its drop");
        assert_eq!(object_files(&fixture.mirror), before);
        assert_eq!(fixture.canonical_main(), main);

        let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
        let staged = git.with_quarantine(&quarantine);
        let commit = commit_in(&staged, &main, "notes.md", b"kept\n");
        let result = push(
            &staged,
            &fixture.url(),
            &[format!("{commit}:refs/heads/main")],
            &[],
        )
        .unwrap();
        assert_eq!(result.class, PushClass::Pushed);
        // Blob, tree and commit.
        assert_eq!(quarantine.promote(&git).unwrap(), 3);
        // Promoting again finds every object already there.
        assert_eq!(quarantine.promote(&git).unwrap(), 0);
        drop(quarantine);
        git.update_ref("refs/heads/main", &commit, Some(&main), "test")
            .unwrap();
        assert_eq!(object_files(&fixture.mirror).len(), before.len() + 3);

        std::fs::rename(&fixture.canonical, fixture.root.join("gone.git")).unwrap();
        assert_eq!(
            git.stdout(&["cat-file", "-p", &format!("{commit}:notes.md")])
                .unwrap(),
            "kept"
        );
        assert_eq!(fixture.main(), commit);
    }

    /// The quarantine's fan-out directories in the order a directory read
    /// lists them: the order a promotion that ignored object types followed.
    fn read_dir_order(quarantine: &Quarantine) -> Vec<String> {
        std::fs::read_dir(quarantine.objects_dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.len() == 2)
            .collect()
    }

    /// A promotion that stops partway (here a fan-out directory that cannot
    /// be made, standing in for a full disk) never leaves a commit in the
    /// mirror without its tree, or without a parent quarantined with it,
    /// whatever order the quarantine's directories are read in; promoting
    /// again finishes.
    #[test]
    fn a_promotion_that_stops_partway_never_leaves_a_commit_without_its_objects() {
        let fixture = Fixture::new();
        let git = fixture.git();
        let main = fixture.main();
        let objects = fixture.mirror.join("objects");
        let prefix = |id: &str| id[..2].to_string();

        // A commit whose fan-out is read before its tree's; the tree's
        // fan-out cannot be made.
        let mut found = false;
        for attempt in 0..1000 {
            let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
            let staged = git.with_quarantine(&quarantine);
            let content = format!("v{attempt}\n");
            let commit = commit_in(&staged, &main, "notes.md", content.as_bytes());
            let tree = staged.tree_id(&commit).unwrap();
            let (tree_at, commit_at) = (prefix(&tree), prefix(&commit));
            let order = read_dir_order(&quarantine);
            let position = |name: &String| order.iter().position(|entry| entry == name);
            if tree_at == commit_at
                || objects.join(&tree_at).exists()
                || position(&commit_at) > position(&tree_at)
            {
                continue;
            }
            std::fs::write(objects.join(&tree_at), b"").unwrap();
            assert!(quarantine.promote(&git).is_err());
            assert!(
                git.commit_id(&commit).unwrap().is_none(),
                "the commit reached the mirror before its tree"
            );
            std::fs::remove_file(objects.join(&tree_at)).unwrap();
            quarantine.promote(&git).unwrap();
            assert_eq!(git.commit_id(&commit).unwrap(), Some(commit.clone()));
            assert!(git.test(&["cat-file", "-e", &tree]).unwrap());
            found = true;
            break;
        }
        assert!(found, "no commit was read before its tree");

        // A child whose fan-out is read before its quarantined parent's;
        // the parent's fan-out cannot be made.
        let main = fixture.main();
        let mut found = false;
        for attempt in 0..1000 {
            let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
            let staged = git.with_quarantine(&quarantine);
            let parent = commit_in(&staged, &main, "a.md", format!("a{attempt}\n").as_bytes());
            let child = commit_in(&staged, &parent, "b.md", format!("b{attempt}\n").as_bytes());
            let others = [
                staged.tree_id(&parent).unwrap(),
                staged.tree_id(&child).unwrap(),
                staged
                    .stdout(&["rev-parse", &format!("{child}:a.md")])
                    .unwrap(),
                staged
                    .stdout(&["rev-parse", &format!("{child}:b.md")])
                    .unwrap(),
                child.clone(),
            ];
            let (parent_at, child_at) = (prefix(&parent), prefix(&child));
            let order = read_dir_order(&quarantine);
            let position = |name: &String| order.iter().position(|entry| entry == name);
            if others.iter().any(|id| prefix(id) == parent_at)
                || objects.join(&parent_at).exists()
                || position(&child_at) > position(&parent_at)
            {
                continue;
            }
            std::fs::write(objects.join(&parent_at), b"").unwrap();
            assert!(quarantine.promote(&git).is_err());
            assert!(
                git.commit_id(&child).unwrap().is_none(),
                "the child reached the mirror before its parent"
            );
            std::fs::remove_file(objects.join(&parent_at)).unwrap();
            quarantine.promote(&git).unwrap();
            assert_eq!(git.commit_id(&child).unwrap(), Some(child.clone()));
            assert_eq!(git.commit_id(&parent).unwrap(), Some(parent.clone()));
            found = true;
            break;
        }
        assert!(found, "no child was read before its parent");
    }

    /// Git splits the alternates list on `:`: a mirror under a folder
    /// whose name holds one still lends its objects to the quarantine.
    #[test]
    fn a_quarantine_works_under_a_path_with_a_colon() {
        let fixture = Fixture::under("instafy:data \"x\" \\y");
        let git = fixture.git();
        let main = fixture.main();
        let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
        let staged = git.with_quarantine(&quarantine);
        let commit = commit_in(&staged, &main, "notes.md", b"kept\n");
        let result = push(
            &staged,
            &fixture.url(),
            &[format!("{commit}:refs/heads/main")],
            &[],
        )
        .unwrap();
        assert_eq!(result.class, PushClass::Pushed);
        assert_eq!(quarantine.promote(&git).unwrap(), 3);
        assert_eq!(git.commit_id(&commit).unwrap(), Some(commit.clone()));

        // A control character cannot be quoted for git: refused.
        let fixture = Fixture::under("line\nbreak");
        let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
        let error = fixture
            .git()
            .with_quarantine(&quarantine)
            .run(&["rev-parse", "HEAD"])
            .unwrap_err()
            .to_string();
        assert!(error.contains("control character"), "{error}");
    }

    #[test]
    fn promotion_moves_packs_with_their_index() {
        let fixture = Fixture::new();
        let main = fixture.canonical_main();
        let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
        let base = quarantine.objects_dir().join("pack").join("pack");
        let output = git_output(
            &fixture.canonical,
            &["pack-objects", "--revs", "-q", base.to_str().unwrap()],
            Some(b"refs/heads/main\n"),
        );
        assert!(output.status.success(), "{output:?}");

        let empty = fixture.root.join("empty.git");
        WorkspaceGit::init_bare(&empty).unwrap();
        let git = WorkspaceGit::bare(&empty, None);
        assert!(git.commit_id(&main).unwrap().is_none());
        // The pack and its index (and, on newer git, its reverse index).
        let written = std::fs::read_dir(quarantine.objects_dir().join("pack"))
            .unwrap()
            .count();
        assert!(written >= 2, "{written}");
        assert_eq!(quarantine.promote(&git).unwrap(), written);
        drop(quarantine);
        assert_eq!(
            git.commit_id(&main).unwrap().as_deref(),
            Some(main.as_str())
        );
        assert_eq!(
            git.stdout(&["cat-file", "-p", &format!("{main}:src/lib.rs")])
                .unwrap(),
            "pub fn lib() {}"
        );
    }

    #[test]
    fn a_quarantined_handle_never_moves_a_ref() {
        let fixture = Fixture::new();
        let main = fixture.main();
        let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
        let staged = fixture.git().with_quarantine(&quarantine);
        let commit = commit_in(&staged, &main, "a.txt", b"a\n");
        for args in [
            vec![
                "update-ref",
                "refs/heads/main",
                commit.as_str(),
                main.as_str(),
            ],
            vec!["fetch", fixture.canonical.to_str().unwrap(), "main"],
            vec!["gc"],
        ] {
            let error = staged.run(&args).unwrap_err().to_string();
            assert!(error.contains("quarantine"), "{error}");
        }
        assert_eq!(fixture.main(), main);

        // A checkout takes neither a quarantine nor a separate work tree.
        let workspace = fixture.root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        crate::test_support::init_workspace_repo(&workspace);
        let checkout = WorkspaceGit::new(&workspace, None);
        assert!(checkout
            .with_quarantine(&quarantine)
            .run(&["status"])
            .is_err());
        assert!(checkout
            .with_work_tree(&fixture.root)
            .run(&["status"])
            .is_err());
        assert!(checkout.run(&["status"]).unwrap().status.success());
    }

    #[test]
    #[should_panic(expected = "has no workspace root")]
    fn a_bare_repository_has_no_workspace_root() {
        let fixture = Fixture::new();
        fixture.git().root();
    }

    #[cfg(unix)]
    #[test]
    fn a_bare_repository_is_never_reached_through_a_link_or_borrows_objects() {
        let fixture = Fixture::new();
        assert!(WorkspaceGit::bare(Path::new("mirror.git"), None)
            .run(&["rev-parse", "HEAD"])
            .is_err());

        let link = fixture.root.join("link.git");
        std::os::unix::fs::symlink(&fixture.mirror, &link).unwrap();
        assert!(WorkspaceGit::bare(&link, None)
            .run(&["rev-parse", "HEAD"])
            .is_err());

        let borrowing = fixture.root.join("borrowing.git");
        WorkspaceGit::init_bare(&borrowing).unwrap();
        std::fs::create_dir_all(borrowing.join("objects/info")).unwrap();
        std::fs::write(
            borrowing.join("objects/info/alternates"),
            format!("{}\n", fixture.mirror.join("objects").display()),
        )
        .unwrap();
        let error = WorkspaceGit::bare(&borrowing, None)
            .run(&["rev-parse", "HEAD"])
            .unwrap_err()
            .to_string();
        assert!(error.contains("never writes"), "{error}");

        let linked_config = fixture.root.join("linked-config.git");
        WorkspaceGit::init_bare(&linked_config).unwrap();
        std::fs::remove_file(linked_config.join("config")).unwrap();
        std::os::unix::fs::symlink(fixture.mirror.join("config"), linked_config.join("config"))
            .unwrap();
        assert!(WorkspaceGit::bare(&linked_config, None)
            .run(&["rev-parse", "HEAD"])
            .is_err());

        // A quarantine is only made inside a real directory.
        assert!(Quarantine::create_in(&link).is_err());
        assert!(Quarantine::create_in(Path::new("relative")).is_err());
    }

    /// Each file git would read to find another repository's objects or
    /// history, and each link or wrong type where git reads refs, objects
    /// or config, stops every command in the repository.
    #[cfg(unix)]
    #[test]
    fn every_redirect_link_or_wrong_type_in_a_bare_repository_is_refused() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let elsewhere = fixture.root.join("elsewhere.git");
        WorkspaceGit::init_bare(&elsewhere).unwrap();
        let swap_for_link = |repository: &Path, name: &str| {
            let path = repository.join(name);
            if path.is_dir() {
                std::fs::remove_dir_all(&path).unwrap();
            } else {
                std::fs::remove_file(&path).unwrap();
            }
            symlink(elsewhere.join(name), &path).unwrap();
        };
        type Setup<'s> = Box<dyn Fn(&Path) + 's>;
        let cases: Vec<(&str, Setup<'_>, &str)> = vec![
            (
                "commondir",
                Box::new(|repository: &Path| {
                    std::fs::write(repository.join("commondir"), "../elsewhere.git\n").unwrap()
                }),
                "\"commondir\"",
            ),
            (
                "grafts",
                Box::new(|repository: &Path| {
                    std::fs::create_dir_all(repository.join("info")).unwrap();
                    std::fs::write(repository.join("info/grafts"), "").unwrap();
                }),
                "\"info/grafts\"",
            ),
            (
                "alternates",
                Box::new(|repository: &Path| {
                    std::fs::write(repository.join("objects/info/alternates"), "/x\n").unwrap()
                }),
                "\"objects/info/alternates\"",
            ),
            (
                "linked HEAD",
                Box::new(|repository: &Path| swap_for_link(repository, "HEAD")),
                "\"HEAD\" in bare repository",
            ),
            (
                "linked config",
                Box::new(|repository: &Path| swap_for_link(repository, "config")),
                "\"config\" in bare repository",
            ),
            (
                "linked packed-refs",
                Box::new(|repository: &Path| {
                    std::fs::write(elsewhere.join("packed-refs"), "").unwrap();
                    std::fs::write(repository.join("packed-refs"), "").unwrap();
                    swap_for_link(repository, "packed-refs");
                }),
                "\"packed-refs\" in bare repository",
            ),
            (
                "linked refs",
                Box::new(|repository: &Path| swap_for_link(repository, "refs")),
                "\"refs\" in bare repository",
            ),
            (
                "objects is a file",
                Box::new(|repository: &Path| {
                    std::fs::remove_dir_all(repository.join("objects")).unwrap();
                    std::fs::write(repository.join("objects"), "").unwrap();
                }),
                "\"objects\" in bare repository",
            ),
            (
                "HEAD is a folder",
                Box::new(|repository: &Path| {
                    std::fs::remove_file(repository.join("HEAD")).unwrap();
                    std::fs::create_dir(repository.join("HEAD")).unwrap();
                }),
                "\"HEAD\" in bare repository",
            ),
        ];
        for (index, (label, setup, expected)) in cases.iter().enumerate() {
            let repository = fixture.root.join(format!("case-{index}.git"));
            WorkspaceGit::init_bare(&repository).unwrap();
            WorkspaceGit::bare(&repository, None)
                .run(&["rev-parse", "--git-dir"])
                .unwrap();
            setup(&repository);
            let error = WorkspaceGit::bare(&repository, None)
                .run(&["rev-parse", "--git-dir"])
                .err()
                .unwrap_or_else(|| panic!("{label}: not refused"))
                .to_string();
            assert!(error.contains(expected), "{label}: {error}");
        }
    }

    /// Ignore and attribute files in the server user's home never change
    /// what a bare repository's commands see.
    #[test]
    fn a_bare_repository_ignores_the_server_users_git_files() {
        let fixture = Fixture::new();
        let home = fixture.root.join("home");
        std::fs::create_dir_all(home.join("git")).unwrap();
        std::fs::write(home.join("git/ignore"), "b.txt\n").unwrap();
        std::fs::write(home.join("git/attributes"), "*.md -diff\n").unwrap();
        let env = || -> Vec<(&'static str, OsString)> {
            vec![
                ("XDG_CONFIG_HOME", home.clone().into_os_string()),
                ("HOME", home.clone().into_os_string()),
            ]
        };
        let work_tree = fixture.root.join("ignore-check");
        std::fs::create_dir_all(&work_tree).unwrap();
        let ignored = fixture
            .git()
            .with_work_tree(&work_tree)
            .run_opts(
                &["check-ignore", "--no-index", "-z", "--stdin"],
                &RunOpts {
                    stdin: Some(b"b.txt\0"),
                    env: env(),
                    ..RunOpts::default()
                },
            )
            .unwrap();
        assert_eq!(ignored.status.code(), Some(1), "{ignored:?}");
        assert!(ignored.stdout.is_empty(), "{ignored:?}");
        let attributes = fixture
            .git()
            .stdout_opts(
                &["check-attr", "--all", "--", "README.md"],
                &RunOpts {
                    env: env(),
                    ..RunOpts::default()
                },
            )
            .unwrap();
        assert_eq!(attributes, "");

        // The same files do reach a git that is not pinned, so the test
        // would see them.
        let plain = git_output_env(
            &work_tree,
            &[
                "--git-dir",
                fixture.mirror.to_str().unwrap(),
                "--work-tree",
                ".",
                "check-ignore",
                "--no-index",
                "b.txt",
            ],
            &home,
        );
        assert_eq!(String::from_utf8_lossy(&plain.stdout).trim(), "b.txt");
    }

    /// Plain git in `dir` with the given home, outside the server's handle.
    fn git_output_env(dir: &Path, args: &[&str], home: &Path) -> std::process::Output {
        std::process::Command::new("git")
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("XDG_CONFIG_HOME", home)
            .env("HOME", home)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .args(args)
            .output()
            .unwrap()
    }

    /// A local command given a deadline is stopped there, as a fetch is at
    /// its network deadline, and one with no time left is never started.
    #[cfg(unix)]
    #[test]
    fn a_local_command_stops_at_its_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().canonicalize().unwrap().join("r.git");
        WorkspaceGit::init_bare(&repository).unwrap();
        let git = WorkspaceGit::bare(&repository, None);
        let _slow = crate::test_support::GitWrapper::install(dir.path(), "sleep 20");
        let started = Instant::now();
        let error = git
            .run_opts(
                &["rev-list", "--all"],
                &RunOpts {
                    deadline: Some(Instant::now() + Duration::from_millis(300)),
                    ..RunOpts::default()
                },
            )
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("ran out of time"),
            "{error:#}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        let error = git
            .run_opts(
                &["rev-list", "--all"],
                &RunOpts {
                    deadline: Some(Instant::now()),
                    ..RunOpts::default()
                },
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("no time left"), "{error:#}");
    }

    /// A wrapper around git that records each command line and the
    /// `GIT_CONFIG_*` entries it was given, for the current thread only.
    struct RecordingGit {
        log: PathBuf,
    }

    impl RecordingGit {
        fn install(dir: &Path) -> Self {
            let log = dir.join("git-calls.log");
            let script = dir.join("recording-git");
            crate::test_support::install_script(
                &script,
                &format!(
                    "#!/bin/sh\n\
                     {{ printf 'argv'; for arg in \"$@\"; do printf ' [%s]' \"$arg\"; done; \
                     printf '\\n'; env | grep -E '^GIT_CONFIG_(COUNT|KEY_|VALUE_)' | sort; \
                     printf 'end\\n'; }} >> '{}'\n\
                     exec git \"$@\"\n",
                    log.display()
                ),
            );
            crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = Some(script));
            Self { log }
        }

        /// The recorded calls whose command line contains `needle`.
        fn calls_with(&self, needle: &str) -> Vec<String> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .split("end\n")
                .filter(|call| {
                    call.lines()
                        .next()
                        .is_some_and(|argv| argv.contains(needle))
                })
                .map(str::to_string)
                .collect()
        }
    }

    impl Drop for RecordingGit {
        fn drop(&mut self) {
            crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = None);
        }
    }

    /// In both layouts the bearer reaches git only through the environment,
    /// never its argument list, which any process on the machine can read
    /// (`/proc/<pid>/cmdline`, `ps`).
    #[cfg(unix)]
    #[test]
    fn the_bearer_reaches_git_only_in_the_environment() {
        let fixture = Fixture::new();
        let recording = RecordingGit::install(&fixture.root);
        let token = "token-for-this-test";
        let git = WorkspaceGit::bare(&fixture.mirror, Some(token));

        assert!(git
            .run(&["ls-remote", &fixture.url()])
            .unwrap()
            .status
            .success());
        assert!(git.run(&["rev-parse", "HEAD"]).unwrap().status.success());

        let listed = recording.calls_with("[ls-remote]");
        assert_eq!(listed.len(), 1, "{listed:?}");
        let (argv, env) = listed[0].split_once('\n').unwrap();
        assert!(!argv.contains(token), "{argv}");
        assert!(argv.contains("[--git-dir] [.]"), "{argv}");
        assert_eq!(
            env.lines().collect::<Vec<_>>(),
            vec![
                "GIT_CONFIG_COUNT=1",
                "GIT_CONFIG_KEY_0=http.extraHeader",
                &format!("GIT_CONFIG_VALUE_0=Authorization: Bearer {token}"),
            ]
        );
        // Local commands never get the token at all.
        let parsed = recording.calls_with("[rev-parse]");
        assert_eq!(parsed.len(), 1, "{parsed:?}");
        assert!(!parsed[0].contains(token), "{parsed:?}");
        assert!(!parsed[0].contains("GIT_CONFIG_COUNT"), "{parsed:?}");

        // So does a checkout's.
        let workspace = fixture.root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        crate::test_support::init_workspace_repo(&workspace);
        WorkspaceGit::new(&workspace, Some(token))
            .run(&["ls-remote", &fixture.url()])
            .unwrap();
        let checkout = recording.calls_with(&format!("[ls-remote] [{}]", fixture.url()));
        assert_eq!(checkout.len(), 2, "{checkout:?}");
        let (argv, env) = checkout[1].split_once('\n').unwrap();
        assert!(!argv.contains(token), "{argv}");
        assert!(
            argv.contains("[--git-dir] [.instafy/.git] [--work-tree] [.] [ls-remote]"),
            "{argv}"
        );
        assert_eq!(
            env.lines().collect::<Vec<_>>(),
            vec![
                "GIT_CONFIG_COUNT=1",
                "GIT_CONFIG_KEY_0=http.extraHeader",
                &format!("GIT_CONFIG_VALUE_0=Authorization: Bearer {token}"),
            ]
        );
    }

    /// The environment entry is a real header on the wire.
    #[test]
    fn both_layouts_send_the_bearer_as_an_http_header() {
        let fixture = Fixture::new();
        let workspace = fixture.root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        crate::test_support::init_workspace_repo(&workspace);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(20)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                requests.push(String::from_utf8_lossy(&request).to_string());
            }
            requests
        });
        for git in [
            WorkspaceGit::bare(&fixture.mirror, Some("header-value")),
            WorkspaceGit::new(&workspace, Some("header-value")),
        ] {
            let output = git
                .with_stall_limit(20)
                .run_opts(
                    &["ls-remote", &format!("http://127.0.0.1:{port}/repo.git")],
                    &RunOpts {
                        // The request must reach this listener, not a proxy.
                        env: vec![("no_proxy", "*".into()), ("NO_PROXY", "*".into())],
                        ..RunOpts::default()
                    },
                )
                .unwrap();
            assert!(!output.status.success());
        }
        for request in server.join().unwrap() {
            assert!(
                request
                    .lines()
                    .any(|line| line.trim() == "Authorization: Bearer header-value"),
                "{request}"
            );
        }
    }

    #[test]
    fn merges_and_ignore_checks_run_on_a_bare_repository() {
        let fixture = Fixture::new();
        let git = fixture.git();
        let main = fixture.main();
        let quarantine = Quarantine::create_in(&fixture.quarantines).unwrap();
        let staged = git.with_quarantine(&quarantine);
        let ours = commit_in(
            &staged,
            &main,
            "README.md",
            b"ONE\ntwo\nthree\nfour\nfive\n",
        );
        let theirs = commit_in(
            &staged,
            &main,
            "README.md",
            b"one\ntwo\nthree\nfour\nFIVE\n",
        );
        let merged = three_way(&staged, Some(&main), &ours, &theirs).unwrap();
        assert!(merged.conflicts.is_empty(), "{merged:?}");
        let readme = staged
            .stdout(&["rev-parse", &format!("{}:README.md", merged.tree)])
            .unwrap();
        assert_eq!(
            staged.stdout(&["cat-file", "-p", &readme]).unwrap(),
            "ONE\ntwo\nthree\nfour\nFIVE"
        );
        // The merged file exists only in the quarantine.
        assert!(!git.test(&["cat-file", "-e", &readme]).unwrap());

        let work_tree = fixture.root.join("ignore-check");
        std::fs::create_dir_all(work_tree.join("keep")).unwrap();
        std::fs::write(work_tree.join(".gitignore"), "*.env\n").unwrap();
        std::fs::write(work_tree.join("keep/.gitignore"), "!x.env\n").unwrap();
        let ignored = git
            .with_work_tree(&work_tree)
            .bytes_opts(
                &["check-ignore", "--no-index", "-z", "--stdin"],
                &RunOpts {
                    stdin: Some(b"a.env\0keep/x.env\0b.txt\0"),
                    ..RunOpts::default()
                },
            )
            .unwrap();
        assert_eq!(ignored, b"a.env\0");
        assert!(git
            .with_work_tree(Path::new("relative"))
            .run(&["check-ignore", "--no-index", "x"])
            .is_err());
    }

    /// Entries found with their paths on stdin are exactly what `ls-tree`
    /// with the path as an argument finds, for names git reads specially
    /// elsewhere (blanks, `:`, a word git prints for a missing object,
    /// non-ASCII, a newline), for links, submodules, executables and folders,
    /// and for paths that are absent or below a file.
    #[test]
    fn paths_found_on_stdin_match_ls_tree() {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().canonicalize().unwrap().join("r.git");
        WorkspaceGit::init_bare(&repository).unwrap();
        let git = WorkspaceGit::bare(&repository, None);
        let blob = |content: &str| {
            git.stdout_opts(
                &["hash-object", "-w", "--stdin"],
                &RunOpts {
                    stdin: Some(content.as_bytes()),
                    ..RunOpts::default()
                },
            )
            .unwrap()
        };
        let commit_of = |entries: &[(&str, String, &str)], parents: &[&str]| {
            let scratch = temp_index_dir(&git).unwrap();
            let index = scratch.path().join("index");
            let mut info = Vec::new();
            for (mode, oid, path) in entries {
                info.extend_from_slice(format!("{mode} {oid}\t{path}").as_bytes());
                info.push(0);
            }
            git.ok_opts(
                &["update-index", "-z", "--index-info"],
                &RunOpts {
                    index_file: Some(&index),
                    stdin: Some(&info),
                    ..RunOpts::default()
                },
            )
            .unwrap();
            let tree = git
                .stdout_opts(
                    &["write-tree"],
                    &RunOpts {
                        index_file: Some(&index),
                        ..RunOpts::default()
                    },
                )
                .unwrap();
            let identity = GitIdentity::new("t", "t@example.com");
            git.commit_tree(&tree, parents, &identity, &identity, b"c\n")
                .unwrap()
        };
        let gitlink = "0123456789abcdef0123456789abcdef01234567".to_string();
        let first = commit_of(
            &[
                ("100644", blob("a\n"), "a b.txt"),
                ("100644", blob("b\n"), "x:y"),
                ("100644", blob("c\n"), "dir/sub file"),
                ("100644", blob("d\n"), "dir/nested/deep.txt"),
                ("100644", blob("e\n"), "caf\u{e9} \u{2713}.md"),
                ("100644", blob("f\n"), "nothing missing"),
                ("100644", blob("g\n"), " lead"),
                ("100644", blob("h\n"), "new\nline.txt"),
                ("100755", blob("#!/bin/sh\n"), "run.sh"),
                ("120000", blob("a b.txt"), "link"),
                ("160000", gitlink.clone(), "dir/sub"),
            ],
            &[],
        );
        let second = commit_of(&[("100644", blob("other\n"), "x:y")], &[&first]);
        let paths = [
            "a b.txt",
            "x:y",
            "dir",
            "dir/nested",
            "dir/sub file",
            "dir/nested/deep.txt",
            "caf\u{e9} \u{2713}.md",
            "nothing missing",
            " lead",
            "run.sh",
            "link",
            "dir/sub",
            "absent.txt",
            "a b.txt/below",
            "dir/absent/x",
            "new\nline.txt",
        ]
        .map(str::to_string);
        let listed = |commit: &str, path: &str| -> Option<TreeEntry> {
            let raw = git
                .bytes_opts(
                    &["ls-tree", "-z", "--full-tree", commit, "--", path],
                    &RunOpts {
                        literal_pathspecs: true,
                        ..RunOpts::default()
                    },
                )
                .unwrap();
            parse_ls_tree(&raw)
                .into_iter()
                .find(|entry| entry.path == path)
        };
        // One lookup with every path, and with the newline path left out (its
        // own fallback is a full listing).
        for wanted in [&paths[..], &paths[..paths.len() - 1]] {
            let found = git.entries_by_path(&first, wanted).unwrap();
            for path in wanted {
                assert_eq!(found.get(path), listed(&first, path).as_ref(), "{path:?}");
            }
        }
        assert_eq!(
            git.entries_by_path(&first, &["link".to_string()]).unwrap()["link"].mode,
            "120000"
        );
        assert_eq!(
            git.entries_by_path(&first, &["dir/sub".to_string()])
                .unwrap()["dir/sub"]
                .kind,
            "commit"
        );
        let both = [second.clone(), first.clone()];
        for path in ["x:y", "dir/sub file", "absent.txt", "new\nline.txt"] {
            let each = git.entry_in_each(&both, path).unwrap();
            assert_eq!(
                each,
                vec![listed(&second, path), listed(&first, path)],
                "{path:?}"
            );
        }
    }
}
