//! Private, bounded working copies for tool-capable scoped workers.
//!
//! This module never invokes Git or writes the source workspace. The caller must
//! stop the worker (including its descendants), collect its changes, then hold
//! the workspace apply lock across conflict validation and descriptor-relative
//! application through `source_handle()`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::Metadata;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use origin_http_server::publish_policy::is_unpublishable;
use origin_http_server::workspace_fs::{WorkspaceDir, WorkspaceEntryKind};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

#[derive(Clone, Copy, Debug)]
pub(super) struct SnapshotLimits {
    /// Includes directories and excluded entries, preventing a wide tree from
    /// consuming unbounded enumeration memory even if its files are empty.
    pub max_entries: usize,
    pub max_bytes: u64,
    pub max_file_bytes: u64,
    pub max_depth: usize,
}

impl Default for SnapshotLimits {
    fn default() -> Self {
        Self {
            max_entries: 20_000,
            max_bytes: 128 * 1024 * 1024,
            max_file_bytes: 20 * 1024 * 1024,
            max_depth: 64,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct IsolatedFileChange {
    pub path: String,
    /// `None` means delete. Empty bytes mean an existing, empty file.
    pub contents: Option<Vec<u8>>,
    pub executable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Fingerprint {
    digest: [u8; 32],
    executable: bool,
}

#[derive(Default)]
struct Tree {
    files: BTreeMap<String, Fingerprint>,
    directories: BTreeSet<String>,
    excluded: Vec<String>,
}

pub(super) struct IsolatedWorkspace {
    _private: TempDir,
    workspace_dir: PathBuf,
    home_dir: PathBuf,
    source: WorkspaceDir,
    baseline: Tree,
    limits: SnapshotLimits,
}

impl IsolatedWorkspace {
    pub fn snapshot(source: &Path, limits: SnapshotLimits) -> Result<Self> {
        ensure!(
            limits.max_entries > 0 && limits.max_bytes > 0 && limits.max_file_bytes > 0,
            "isolated workspace limits must be positive"
        );
        // Resolve trusted root aliases (e.g. macOS /var -> /private/var) only for
        // the outside-project check. WorkspaceDir itself rejects a linked root.
        let source_path = source.canonicalize().context("resolve source workspace")?;
        let source = WorkspaceDir::open(source).context("open source workspace without links")?;
        let private = tempfile::Builder::new()
            .prefix("instafy-worker-")
            .tempdir()
            .context("create private worker directory")?;
        let private_path = private.path().canonicalize()?;
        ensure!(
            !private_path.starts_with(&source_path),
            "worker temporary directory is inside the source project; configure an external temporary directory"
        );
        let workspace_dir = private_path.join("workspace");
        let home_dir = private_path.join("home");
        std::fs::create_dir(&workspace_dir)?;
        std::fs::create_dir(&home_dir)?;
        let destination = WorkspaceDir::open(&workspace_dir)?;
        let baseline = scan(&source, limits, true, |path, bytes, fingerprint| {
            destination.replace_file(path, &mut Cursor::new(bytes), fingerprint.executable)?;
            Ok(())
        })?;
        for directory in &baseline.directories {
            destination.create_dir_all(directory)?;
        }
        Ok(Self {
            _private: private,
            workspace_dir,
            home_dir,
            source,
            baseline,
            limits,
        })
    }

    pub fn workspace_dir(&self) -> &Path {
        &self.workspace_dir
    }

    /// HOME, CODEX_HOME and other runtime state must stay outside the copy that
    /// is compared and imported. They still remain private to this worker.
    pub fn home_dir(&self) -> &Path {
        &self.home_dir
    }

    pub fn source_handle(&self) -> &WorkspaceDir {
        &self.source
    }

    pub fn excluded_paths(&self) -> &[String] {
        &self.baseline.excluded
    }

    /// Reject the entire result on any undeclared mutation. `owns` must include
    /// the caller's read-only exclusions; returning false for every path makes
    /// this a read-only worker. Ignored/build files created by the worker are
    /// checked too: no change is silently dropped during collection.
    pub fn collect_changes(&self, owns: impl Fn(&str) -> bool) -> Result<Vec<IsolatedFileChange>> {
        let private = WorkspaceDir::open(&self.workspace_dir)?;
        let mut changes = BTreeMap::new();
        let current = scan(&private, self.limits, false, |path, bytes, fingerprint| {
            if self.baseline.files.get(path) != Some(fingerprint) {
                ensure_owned(path, &owns)?;
                changes.insert(
                    path.to_owned(),
                    IsolatedFileChange {
                        path: path.to_owned(),
                        contents: Some(bytes.to_vec()),
                        executable: fingerprint.executable,
                    },
                );
            }
            Ok(())
        })?;
        for (path, fingerprint) in &self.baseline.files {
            if !current.files.contains_key(path) {
                ensure_owned(path, &owns)?;
                changes.insert(
                    path.clone(),
                    IsolatedFileChange {
                        path: path.clone(),
                        contents: None,
                        executable: fingerprint.executable,
                    },
                );
            }
        }
        // File-only checkpoint descriptors cannot faithfully represent empty
        // directory changes or file/directory replacements. Refuse them before
        // the caller applies any files, instead of partially importing a tree.
        for path in current.directories.difference(&self.baseline.directories) {
            ensure!(
                !self.baseline.files.contains_key(path),
                "isolated worker replaced a file with a directory: {path}"
            );
            ensure!(
                changes.values().any(|change| change.contents.is_some()
                    && change.path.starts_with(&format!("{path}/"))),
                "isolated worker created an unsupported empty directory: {path}"
            );
        }
        for path in self.baseline.directories.difference(&current.directories) {
            ensure!(
                !current.files.contains_key(path),
                "isolated worker replaced a directory with a file: {path}"
            );
            ensure!(
                self.baseline
                    .files
                    .keys()
                    .any(|file| file.starts_with(&format!("{path}/"))),
                "isolated worker deleted an unsupported empty directory: {path}"
            );
        }
        Ok(changes.into_values().collect())
    }

    /// Call under the caller's workspace apply mutex, immediately before applying
    /// the collected changes with `source_handle()`. Validate the *whole owned
    /// scope*, including new parent files and files the worker left untouched.
    /// Unrelated sibling changes do not invalidate this worker's result.
    pub fn validate_source_unchanged(
        &self,
        owns: impl Fn(&str) -> bool,
        changes: &[IsolatedFileChange],
    ) -> Result<()> {
        let current = scan(&self.source, self.limits, true, |_, _, _| Ok(()))?;
        for path in self.baseline.files.keys().chain(current.files.keys()) {
            if owns(path) && self.baseline.files.get(path) != current.files.get(path) {
                bail!("source workspace changed concurrently inside worker scope: {path}");
            }
        }
        for change in changes {
            ensure_owned(&change.path, &owns)?;
            // entry_kind rejects symlink ancestors and final links. A missing
            // target is valid for creation/deletion; a file in place of a parent
            // directory (NotADirectory) must fail before any other file applies.
            match self.source.entry_kind(&change.path) {
                Ok(WorkspaceEntryKind::File) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                result => bail!(
                    "source target changed or is not a regular file: {} ({result:?})",
                    change.path
                ),
            }
            ensure!(
                self.baseline.files.get(&change.path) == current.files.get(&change.path),
                "source workspace changed concurrently inside worker scope: {}",
                change.path
            );
        }
        Ok(())
    }

    /// Capture bounded rollback payloads before the first source mutation. Each
    /// changed target is checked again against the baseline while it is read.
    /// This is used only while the caller holds its workspace apply lock.
    pub fn source_versions(
        &self,
        changes: &[IsolatedFileChange],
    ) -> Result<Vec<IsolatedFileChange>> {
        let mut originals = Vec::with_capacity(changes.len());
        let mut total_bytes = 0u64;
        for change in changes {
            let original = match self.source.open_file(&change.path) {
                Ok(mut file) => {
                    let metadata = file.metadata()?;
                    let allowance = self
                        .limits
                        .max_file_bytes
                        .min(self.limits.max_bytes.saturating_sub(total_bytes));
                    ensure!(
                        metadata.len() <= allowance,
                        "rollback source exceeds byte limit: {}",
                        change.path
                    );
                    let mut contents = Vec::new();
                    (&mut file)
                        .take(allowance.saturating_add(1))
                        .read_to_end(&mut contents)?;
                    ensure!(
                        contents.len() as u64 <= allowance,
                        "rollback source exceeds byte limit: {}",
                        change.path
                    );
                    total_bytes += contents.len() as u64;
                    let fingerprint = Fingerprint {
                        digest: Sha256::digest(&contents).into(),
                        executable: is_executable(&metadata),
                    };
                    ensure!(
                        self.baseline.files.get(&change.path) == Some(&fingerprint),
                        "source workspace changed before apply: {}",
                        change.path
                    );
                    IsolatedFileChange {
                        path: change.path.clone(),
                        contents: Some(contents),
                        executable: fingerprint.executable,
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ensure!(
                        !self.baseline.files.contains_key(&change.path),
                        "source workspace was deleted before apply: {}",
                        change.path
                    );
                    IsolatedFileChange {
                        path: change.path.clone(),
                        contents: None,
                        executable: false,
                    }
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("read rollback source {}", change.path));
                }
            };
            originals.push(original);
        }
        Ok(originals)
    }
}

fn ensure_owned(path: &str, owns: &impl Fn(&str) -> bool) -> Result<()> {
    ensure!(
        !snapshot_excluded(path) && owns(path),
        "isolated worker changed a path outside its writable scope: {path}"
    );
    Ok(())
}

// Reuse the publication policy for dependencies, build output, credentials and
// controller metadata. Do not run Git or read global ignore/config files. Other
// ignored source files remain readable; if they exceed bounds, snapshot fails.
fn snapshot_excluded(path: &str) -> bool {
    is_unpublishable(path)
        || is_unpublishable(&format!("{path}/"))
        || path
            .split('/')
            .any(|part| part.to_ascii_lowercase().starts_with(".codex-runtime"))
}

fn scan(
    root: &WorkspaceDir,
    limits: SnapshotLimits,
    omit_excluded: bool,
    mut visit: impl FnMut(&str, &[u8], &Fingerprint) -> Result<()>,
) -> Result<Tree> {
    let mut tree = Tree::default();
    let mut pending = vec![(root.clone(), String::new(), 0usize)];
    let mut entries = 0usize;
    let mut bytes_read = 0u64;
    while let Some((directory, prefix, depth)) = pending.pop() {
        let names = directory
            .list_names(limits.max_entries.saturating_sub(entries))
            .with_context(|| format!("enumerate isolated workspace at {prefix:?}"))?;
        entries += names.len();
        for name in names {
            let name = name
                .to_str()
                .context("workspace filename is not valid UTF-8")?;
            ensure!(
                !name.is_empty()
                    && !name.contains(['/', '\\', ':'])
                    && name != "."
                    && name != ".."
                    && !name.ends_with([' ', '.']),
                "workspace filename cannot be represented safely: {name:?}"
            );
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if omit_excluded && snapshot_excluded(&path) {
                tree.excluded.push(path);
                continue;
            }
            match directory
                .entry_kind(name)
                .with_context(|| format!("validate workspace entry {path}"))?
            {
                WorkspaceEntryKind::Directory => {
                    ensure!(
                        depth < limits.max_depth,
                        "isolated workspace exceeds directory depth limit at {path}"
                    );
                    let child = directory
                        .open_dir(name)
                        .with_context(|| format!("open workspace directory {path}"))?;
                    tree.directories.insert(path.clone());
                    pending.push((child, path, depth + 1));
                }
                WorkspaceEntryKind::File => {
                    let mut file = directory
                        .open_file(name)
                        .with_context(|| format!("read workspace file {path}"))?;
                    let metadata = file.metadata()?;
                    let allowance = limits
                        .max_file_bytes
                        .min(limits.max_bytes.saturating_sub(bytes_read));
                    ensure!(
                        metadata.len() <= allowance,
                        "isolated workspace exceeds byte limit at {path}"
                    );
                    let mut bytes = Vec::new();
                    (&mut file)
                        .take(allowance.saturating_add(1))
                        .read_to_end(&mut bytes)?;
                    ensure!(
                        bytes.len() as u64 <= allowance,
                        "isolated workspace exceeds byte limit at {path}"
                    );
                    bytes_read += bytes.len() as u64;
                    let fingerprint = Fingerprint {
                        digest: Sha256::digest(&bytes).into(),
                        executable: is_executable(&metadata),
                    };
                    visit(&path, &bytes, &fingerprint)?;
                    tree.files.insert(path, fingerprint);
                }
            }
        }
    }
    Ok(tree)
}

#[cfg(unix)]
fn is_executable(metadata: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn put(root: &Path, path: &str, bytes: &[u8]) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn snapshot(root: &Path) -> IsolatedWorkspace {
        IsolatedWorkspace::snapshot(root, SnapshotLimits::default()).unwrap()
    }

    #[test]
    fn copies_current_unsaved_source_and_skills_without_runtime_state() {
        let root = TempDir::new().unwrap();
        put(root.path(), "src/current.txt", b"not committed anywhere");
        put(
            root.path(),
            ".agents/skills/team/SKILL.md",
            b"project skill",
        );
        put(root.path(), ".git/config", b"never copy git metadata");
        put(root.path(), ".instafy/state.json", b"private state");
        put(root.path(), ".codex-runtime-job/auth.json", b"private auth");
        put(root.path(), "node_modules/pkg/main.js", b"dependency");
        put(root.path(), ".env", b"private configuration");
        let isolated = snapshot(root.path());
        assert_eq!(
            fs::read(isolated.workspace_dir().join("src/current.txt")).unwrap(),
            b"not committed anywhere"
        );
        assert_eq!(
            fs::read(
                isolated
                    .workspace_dir()
                    .join(".agents/skills/team/SKILL.md")
            )
            .unwrap(),
            b"project skill"
        );
        for name in [
            ".git",
            ".instafy",
            ".codex-runtime-job",
            "node_modules",
            ".env",
        ] {
            assert!(
                !isolated.workspace_dir().join(name).exists(),
                "copied {name}"
            );
            assert!(isolated.excluded_paths().iter().any(|path| path == name));
        }
        assert!(!isolated.workspace_dir().starts_with(root.path()));
        assert!(!isolated.home_dir().starts_with(isolated.workspace_dir()));
        assert!(isolated.collect_changes(|_| false).unwrap().is_empty());
    }

    #[test]
    fn a_bound_sites_binder_state_never_reaches_an_isolated_worker() {
        let root = TempDir::new().unwrap();
        put(root.path(), "sites/shoes/index.html", b"<p>shoes</p>");
        put(
            root.path(),
            "sites/shoes/.bind/admin-token",
            b"approves confirm jobs",
        );
        put(root.path(), "sites/shoes/.bind/binder.log", b"prompts");
        put(root.path(), ".bind/admin-token", b"gallery admin");
        let isolated = snapshot(root.path());
        assert!(
            isolated
                .workspace_dir()
                .join("sites/shoes/index.html")
                .is_file()
        );
        for name in ["sites/shoes/.bind", ".bind"] {
            assert!(
                !isolated.workspace_dir().join(name).exists(),
                "copied {name}"
            );
        }
        assert!(snapshot_excluded("sites/shoes/.bind/admin-token"));
    }

    #[test]
    fn collects_binary_creations_edits_and_deletions_without_touching_source() {
        let root = TempDir::new().unwrap();
        put(root.path(), "owned/edit.txt", b"before");
        put(root.path(), "owned/delete.txt", b"delete");
        put(root.path(), "sibling.txt", b"untouched");
        let isolated = snapshot(root.path());
        put(isolated.workspace_dir(), "owned/edit.txt", b"after");
        put(isolated.workspace_dir(), "owned/new.bin", &[0, 255, 128]);
        fs::remove_file(isolated.workspace_dir().join("owned/delete.txt")).unwrap();
        let owns = |path: &str| path.starts_with("owned/");
        let changes = isolated.collect_changes(owns).unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "owned/delete.txt");
        assert!(changes[0].contents.is_none());
        assert_eq!(changes[1].contents.as_deref(), Some(b"after".as_slice()));
        assert_eq!(
            changes[2].contents.as_deref(),
            Some([0, 255, 128].as_slice())
        );
        isolated.validate_source_unchanged(owns, &changes).unwrap();
        assert_eq!(
            fs::read(root.path().join("owned/edit.txt")).unwrap(),
            b"before"
        );
        assert!(root.path().join("owned/delete.txt").is_file());
        assert!(!root.path().join("owned/new.bin").exists());
    }

    #[test]
    fn rejects_undeclared_write_instead_of_importing_only_the_owned_subset() {
        let root = TempDir::new().unwrap();
        put(root.path(), "sibling.txt", b"original");
        let isolated = snapshot(root.path());
        put(isolated.workspace_dir(), "owned.txt", b"allowed");
        put(isolated.workspace_dir(), "sibling.txt", b"not allowed");
        let error = isolated
            .collect_changes(|path| path == "owned.txt")
            .unwrap_err();
        assert!(error.to_string().contains("sibling.txt"));
        assert!(isolated.collect_changes(|_| false).is_err());
        assert_eq!(
            fs::read(root.path().join("sibling.txt")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn ignored_worker_output_is_rejected_even_with_a_broad_owned_scope() {
        let root = TempDir::new().unwrap();
        let isolated = snapshot(root.path());
        put(isolated.workspace_dir(), "node_modules/pkg/new.js", b"new");
        assert!(
            isolated
                .collect_changes(|_| true)
                .unwrap_err()
                .to_string()
                .contains("outside its writable scope")
        );
    }

    #[test]
    fn detects_owned_parent_edits_and_new_files_but_tolerates_sibling_edits() {
        let root = TempDir::new().unwrap();
        put(root.path(), "owned/original.txt", b"original");
        put(root.path(), "sibling.txt", b"original");
        let isolated = snapshot(root.path());
        put(isolated.workspace_dir(), "owned/new.txt", b"worker");
        let owns = |path: &str| path.starts_with("owned/");
        let changes = isolated.collect_changes(owns).unwrap();
        put(root.path(), "sibling.txt", b"another worker");
        isolated.validate_source_unchanged(owns, &changes).unwrap();
        put(
            root.path(),
            "owned/parent-new.txt",
            b"a concurrent new owned file",
        );
        assert!(isolated.validate_source_unchanged(owns, &changes).is_err());
        fs::remove_file(root.path().join("owned/parent-new.txt")).unwrap();
        put(
            root.path(),
            "owned/original.txt",
            b"concurrent edit to untouched owned file",
        );
        assert!(isolated.validate_source_unchanged(owns, &changes).is_err());
    }

    #[test]
    fn rejects_parent_file_replacing_a_directory_for_a_new_target() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("owned")).unwrap();
        let isolated = snapshot(root.path());
        put(isolated.workspace_dir(), "owned/new.txt", b"worker");
        let owns = |path: &str| path == "owned/new.txt";
        let changes = isolated.collect_changes(owns).unwrap();
        fs::remove_dir(root.path().join("owned")).unwrap();
        put(root.path(), "owned", b"concurrent parent file");
        assert!(isolated.validate_source_unchanged(owns, &changes).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_source_and_worker_symlink_escapes_without_reading_outside() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        put(outside.path(), "secret.txt", b"outside");
        symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(IsolatedWorkspace::snapshot(root.path(), SnapshotLimits::default()).is_err());
        fs::remove_file(root.path().join("escape")).unwrap();
        // Dependency links are excluded by policy before traversal.
        symlink(outside.path(), root.path().join("node_modules")).unwrap();
        let isolated = snapshot(root.path());
        symlink(outside.path(), isolated.workspace_dir().join("escape")).unwrap();
        assert!(isolated.collect_changes(|_| true).is_err());
        assert_eq!(
            fs::read(outside.path().join("secret.txt")).unwrap(),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_parent_target_symlink_inserted_after_snapshot() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        put(outside.path(), "secret.txt", b"outside");
        let isolated = snapshot(root.path());
        put(isolated.workspace_dir(), "owned.txt", b"worker");
        let owns = |path: &str| path == "owned.txt";
        let changes = isolated.collect_changes(owns).unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("owned.txt"),
        )
        .unwrap();
        assert!(isolated.validate_source_unchanged(owns, &changes).is_err());
        assert_eq!(
            fs::read(outside.path().join("secret.txt")).unwrap(),
            b"outside"
        );
    }

    #[test]
    fn bounds_are_errors_not_partial_snapshots() {
        let root = TempDir::new().unwrap();
        put(root.path(), "a", b"1234");
        put(root.path(), "b", b"5678");
        for limits in [
            SnapshotLimits {
                max_entries: 1,
                ..Default::default()
            },
            SnapshotLimits {
                max_bytes: 7,
                ..Default::default()
            },
            SnapshotLimits {
                max_file_bytes: 3,
                ..Default::default()
            },
        ] {
            assert!(IsolatedWorkspace::snapshot(root.path(), limits).is_err());
        }
        let isolated = snapshot(root.path());
        fs::create_dir(isolated.workspace_dir().join("empty-new-directory")).unwrap();
        assert!(isolated.collect_changes(|_| true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn executable_modes_are_copied_and_part_of_scope_and_conflict_checks() {
        let root = TempDir::new().unwrap();
        put(root.path(), "script.sh", b"#!/bin/sh\n");
        fs::set_permissions(
            root.path().join("script.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let isolated = snapshot(root.path());
        assert!(is_executable(
            &fs::metadata(isolated.workspace_dir().join("script.sh")).unwrap()
        ));
        fs::set_permissions(
            isolated.workspace_dir().join("script.sh"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(isolated.collect_changes(|_| false).is_err());
        let changes = isolated.collect_changes(|_| true).unwrap();
        assert!(!changes[0].executable);
        fs::set_permissions(
            root.path().join("script.sh"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(
            isolated
                .validate_source_unchanged(|_| true, &changes)
                .is_err()
        );
    }
}
