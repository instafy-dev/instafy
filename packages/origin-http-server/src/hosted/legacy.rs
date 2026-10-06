//! Working copies left by the stateful gateway.
//!
//! Earlier gateway images kept one checkout per space at `<root>/<space id>`
//! and saved from it. This gateway never reads those folders, but an older
//! image started again on the same volume (an automatic rollback) would pick
//! them up and could save drafts from them over newer work. So before the
//! listener is bound, every such folder is moved to `<root>/.legacy/`, where
//! no image looks for a checkout; the old image then clones fresh. The
//! salvage subcommand reads `.legacy/` later.
//!
//! The root must be the gateway's own. A runtime provider keeps its
//! runtimes' checkouts the same way (`<repo base>/<space id>`), and those
//! hold work that exists nowhere else until a runtime pushes it, so a root
//! that looks like a provider's repo base stops the start before anything
//! is moved ([`provider_checkouts_in`]).

use std::io;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tracing::info;
use uuid::Uuid;

use super::disk::{ensure_private_dir, rename_no_replace};

/// Where parked working copies go, under the workspace root. Not a space id,
/// so no gateway image ever treats it as a checkout.
pub(crate) const LEGACY_DIR: &str = ".legacy";

/// What [`park_legacy_checkouts`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ParkedCheckouts {
    /// `(space id, where it went)` for each folder moved.
    pub moved: Vec<(Uuid, PathBuf)>,
    /// How many empty folders were removed instead.
    pub removed_empty: usize,
}

/// Move every working copy of the stateful gateway out of `root`.
///
/// A direct child of `root` counts when its name is a space id exactly as
/// the old gateway wrote it (a lower-case, hyphenated UUID) and it is a
/// directory or a symbolic link; a link is moved as a link, never followed.
/// An empty directory is removed. Anything else is moved, with or without a
/// git directory, since a folder without one can still hold written files,
/// to `<root>/.legacy/<id>`, or `<id>-<UTC time>` when that name is taken;
/// nothing is ever replaced. `.legacy/` is created with mode 0700.
///
/// Any failure is returned, and the caller must not start serving: an old
/// image could otherwise find a folder that was left in place. So is a root
/// that looks like a runtime provider's repo base, before anything is moved
/// ([`provider_checkouts_in`]).
pub(crate) fn park_legacy_checkouts(root: &Path) -> Result<ParkedCheckouts> {
    let mut parked = ParkedCheckouts::default();
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(root)
        .with_context(|| format!("failed to list workspace root {root:?}"))?
    {
        let entry = entry.with_context(|| format!("failed to list workspace root {root:?}"))?;
        if let Some(id) = entry.file_name().to_str().and_then(space_id) {
            ids.push(id);
        }
    }
    ids.sort();
    let checkouts: Vec<PathBuf> = ids
        .iter()
        .map(|id| root.join(id.as_hyphenated().to_string()))
        .collect();
    if let Some(clash) = provider_checkouts_in(root, &checkouts) {
        bail!(
            "the workspace root {root:?} looks like a runtime provider's checkout folder \
             ({clash}); the gateway moves every space folder of its root out of the way, so \
             ORIGIN_WORKSPACE_ROOT must be a folder of the gateway's own, never the \
             providers' DOCKER_REPO_HOST"
        );
    }

    for id in ids {
        let name = id.as_hyphenated().to_string();
        let path = root.join(&name);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("failed to inspect {path:?}"));
            }
        };
        let kind = metadata.file_type();
        if kind.is_dir() {
            // Only an empty directory can be removed this way.
            match std::fs::remove_dir(&path) {
                Ok(()) => {
                    parked.removed_empty += 1;
                    continue;
                }
                // POSIX lets a non-empty directory answer either way.
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::AlreadyExists
                    ) => {}
                Err(error) => {
                    return Err(error).with_context(|| format!("failed to inspect {path:?}"));
                }
            }
        } else if !kind.is_symlink() {
            // A plain file was never a working copy.
            continue;
        }
        let legacy = root.join(LEGACY_DIR);
        ensure_private_dir(&legacy)?;
        let target = move_to_free_name(&path, &legacy, &name)?;
        info!(space = %id, to = ?target, "moved a gateway working copy to .legacy");
        parked.moved.push((id, target));
    }
    Ok(parked)
}

/// The provider's folders next to its checkouts (`STAMP_DIR` and
/// `TRASH_DIR` in `runtime-provider-core`'s checkout eviction).
const PROVIDER_FOLDERS: [&str; 2] = [".instafy-checkout-stamps", ".instafy-evicted"];

/// What a runtime's own origin leaves in its checkout and the stateful
/// gateway never wrote: the clean-stop marker of its shutdown, and local
/// recovery refs (`refs/instafy/local-recovery*`) a publish or a stop
/// stored, loose or packed.
const CLEAN_STOP_MARKER: &str = "instafy-stopped-clean";
const LOCAL_RECOVERY_PREFIX: &str = "local-recovery";

/// Why `root`, whose checkouts are `checkouts` (its space folders, and for
/// the salvage subcommand also the entries parked under `.legacy/`), looks
/// like a runtime provider's repo base rather than the gateway's own
/// folder, if it does: the provider's stamp or eviction folder in it, or a
/// checkout holding what a runtime's origin leaves there. Nothing is
/// followed through a link, and a folder that cannot be read says nothing.
/// The gateway's start and the salvage both decide by this one rule, so an
/// entry the gateway parks never stops the salvage.
pub(crate) fn provider_checkouts_in(root: &Path, checkouts: &[PathBuf]) -> Option<String> {
    for name in PROVIDER_FOLDERS {
        let path = root.join(name);
        if std::fs::symlink_metadata(&path).is_ok() {
            return Some(format!("{path:?} exists"));
        }
    }
    for checkout in checkouts {
        let Some(git_dir) = real_dir(checkout)
            .then(|| checkout.join(".instafy"))
            .filter(|path| real_dir(path))
            .map(|path| path.join(".git"))
            .filter(|path| real_dir(path))
        else {
            continue;
        };
        let marker = git_dir.join(CLEAN_STOP_MARKER);
        if std::fs::symlink_metadata(&marker).is_ok() {
            return Some(format!("{marker:?} exists"));
        }
        if let Some(reference) = local_recovery_ref(&git_dir) {
            return Some(format!("{checkout:?} holds {reference}"));
        }
    }
    None
}

/// Whether `path` is a directory itself, not a link to one.
fn real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

/// A `refs/instafy/local-recovery*` ref of the repository `git_dir`, loose
/// (any file below such a folder of `refs/instafy/`) or packed (in a
/// `packed-refs` that is a file itself, never read through a link).
fn local_recovery_ref(git_dir: &Path) -> Option<String> {
    let refs = git_dir.join("refs").join("instafy");
    if real_dir(&refs) {
        for entry in std::fs::read_dir(&refs).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(LOCAL_RECOVERY_PREFIX) && holds_a_file(&entry.path(), 0) {
                return Some(format!("refs/instafy/{name}/..."));
            }
        }
    }
    let packed_refs = git_dir.join("packed-refs");
    if !std::fs::symlink_metadata(&packed_refs).is_ok_and(|metadata| metadata.file_type().is_file())
    {
        return None;
    }
    let packed = std::fs::read(packed_refs).ok()?;
    let wanted = format!("refs/instafy/{LOCAL_RECOVERY_PREFIX}");
    String::from_utf8_lossy(&packed)
        .lines()
        .filter(|line| !line.starts_with('#') && !line.starts_with('^'))
        .filter_map(|line| line.split_once(' ').map(|(_, name)| name.trim()))
        .find(|name| name.starts_with(&wanted))
        .map(str::to_string)
}

/// Whether `path` is a file, or a real folder with a file somewhere below
/// it (at most 16 folders deep).
fn holds_a_file(path: &Path, depth: usize) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_file() {
        return true;
    }
    if !metadata.file_type().is_dir() || depth >= 16 {
        return false;
    }
    std::fs::read_dir(path).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| holds_a_file(&entry.path(), depth + 1))
    })
}

/// The id a child of the workspace root names, when it is spelled exactly
/// as the stateful gateway spelled space folders.
fn space_id(name: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(name).ok()?;
    (id.as_hyphenated().to_string() == name).then_some(id)
}

/// Move `path` into `folder` as `name`, or as `name-<UTC time>[-<n>]` when
/// that is taken; an existing entry is never replaced.
fn move_to_free_name(path: &Path, folder: &Path, name: &str) -> Result<PathBuf> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut candidates = vec![name.to_string(), format!("{name}-{stamp}")];
    candidates.extend((2..100).map(|n| format!("{name}-{stamp}-{n}")));
    for candidate in candidates {
        let target = folder.join(&candidate);
        match rename_no_replace(path, &target) {
            Ok(()) => return Ok(target),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to move {path:?} to {target:?}"));
            }
        }
    }
    bail!("no free name for {path:?} in {folder:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn id(n: u8) -> String {
        Uuid::from_bytes([n; 16]).as_hyphenated().to_string()
    }

    #[test]
    fn every_old_working_copy_is_moved_out_before_serving() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        // The layouts an old gateway left: its own git dir, a plain .git,
        // written files without any git dir, and an empty folder.
        write(
            &root.join(id(1)).join(".instafy/.git/HEAD"),
            "ref: refs/heads/main\n",
        );
        write(&root.join(id(1)).join("README.md"), "draft\n");
        write(
            &root.join(id(2)).join(".git/HEAD"),
            "ref: refs/heads/main\n",
        );
        write(&root.join(id(3)).join("notes.md"), "unsaved\n");
        std::fs::create_dir(root.join(id(4))).unwrap();
        // Not space folders: other names, upper-case ids, a file, the cache.
        write(&root.join("not-a-space/file"), "x");
        write(&root.join(id(0xab).to_uppercase()).join("file"), "x");
        write(&root.join(id(6)), "a plain file");
        write(&root.join(".git-cache/x"), "x");
        // A .legacy entry from an earlier start keeps its name.
        write(
            &root.join(".legacy").join(id(3)).join("older.md"),
            "older\n",
        );

        let parked = park_legacy_checkouts(&root).unwrap();

        assert_eq!(parked.removed_empty, 1);
        assert!(!root.join(id(4)).exists());
        let moved: Vec<Uuid> = parked.moved.iter().map(|(id, _)| *id).collect();
        assert_eq!(moved.len(), 3);
        for n in [1, 2, 3] {
            assert!(!root.join(id(n)).exists(), "{n} must be moved");
        }
        assert_eq!(
            std::fs::read_to_string(root.join(".legacy").join(id(1)).join("README.md")).unwrap(),
            "draft\n"
        );
        assert!(root.join(".legacy").join(id(2)).join(".git/HEAD").is_file());
        // The older entry is untouched; the new one got a timestamped name.
        assert_eq!(
            std::fs::read_to_string(root.join(".legacy").join(id(3)).join("older.md")).unwrap(),
            "older\n"
        );
        let renamed = &parked
            .moved
            .iter()
            .find(|(moved, _)| moved.as_hyphenated().to_string() == id(3))
            .unwrap()
            .1;
        let renamed_name = renamed.file_name().unwrap().to_str().unwrap();
        assert!(
            renamed_name.starts_with(&format!("{}-", id(3))),
            "{renamed_name}"
        );
        assert!(renamed_name.ends_with('Z'), "{renamed_name}");
        assert_eq!(
            std::fs::read_to_string(renamed.join("notes.md")).unwrap(),
            "unsaved\n"
        );
        for kept in ["not-a-space/file", ".git-cache/x"] {
            assert!(root.join(kept).is_file(), "{kept}");
        }
        assert!(root.join(id(0xab).to_uppercase()).join("file").is_file());
        assert!(root.join(id(6)).is_file());

        // A second start finds nothing to move.
        assert_eq!(
            park_legacy_checkouts(&root).unwrap(),
            ParkedCheckouts::default()
        );
    }

    /// A root a runtime provider keeps its runtimes' checkouts in (the local
    /// stack once mounted one folder as both) is never parked: those hold
    /// work that exists nowhere else. The start stops before anything is
    /// moved, and the error names what showed it.
    #[test]
    fn a_providers_checkout_folder_stops_the_start_before_anything_moves() {
        let git_dir = |root: &Path| root.join(id(2)).join(".instafy/.git");
        let cases: [(&str, &str); 6] = [
            ("stamps", ".instafy-checkout-stamps"),
            // The local stack keeps an empty one while a runtime checkout
            // it could not move stays (scripts/lib/runtimeEnvHelpers.mjs).
            ("empty stamps", ".instafy-checkout-stamps"),
            ("evicted", ".instafy-evicted"),
            ("clean stop", "instafy-stopped-clean"),
            ("loose ref", "refs/instafy/local-recovery/..."),
            ("packed ref", "refs/instafy/local-recovery-pushed/x"),
        ];
        for (case, named) in cases {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap();
            write(&root.join(id(1)).join("draft.md"), "draft\n");
            write(&git_dir(&root).join("HEAD"), "ref: refs/heads/main\n");
            std::fs::create_dir(root.join(id(3))).unwrap();
            match case {
                "stamps" => write(&root.join(".instafy-checkout-stamps").join(id(2)), ""),
                "empty stamps" => std::fs::create_dir(root.join(".instafy-checkout-stamps")).unwrap(),
                "evicted" => std::fs::create_dir(root.join(".instafy-evicted")).unwrap(),
                "clean stop" => write(&git_dir(&root).join("instafy-stopped-clean"), ""),
                "loose ref" => write(
                    &git_dir(&root)
                        .join("refs/instafy/local-recovery/20261006T101010Z-unsaved-abc"),
                    &format!("{}\n", "1".repeat(40)),
                ),
                _ => write(
                    &git_dir(&root).join("packed-refs"),
                    &format!(
                        "# pack-refs with: peeled fully-peeled sorted\n{} refs/instafy/local-recovery-pushed/x\n",
                        "1".repeat(40)
                    ),
                ),
            }

            let error = park_legacy_checkouts(&root).unwrap_err().to_string();

            assert!(error.contains(named), "{case}: {error}");
            assert!(error.contains("ORIGIN_WORKSPACE_ROOT"), "{case}: {error}");
            assert_eq!(
                std::fs::read_to_string(root.join(id(1)).join("draft.md")).unwrap(),
                "draft\n",
                "{case}"
            );
            assert!(git_dir(&root).join("HEAD").is_file(), "{case}");
            assert!(
                root.join(id(3)).is_dir(),
                "{case}: an empty folder was removed"
            );
            assert!(!root.join(LEGACY_DIR).exists(), "{case}");
        }

        // A folder of local recovery refs with no ref left in it, and refs
        // of other names, are what the stateful gateway may leave: parked.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(git_dir(&root).join("refs/instafy/local-recovery/x")).unwrap();
        write(
            &git_dir(&root).join("refs/instafy/recovery/a"),
            &format!("{}\n", "1".repeat(40)),
        );
        let parked = park_legacy_checkouts(&root).unwrap();
        assert_eq!(parked.moved.len(), 1);
        assert!(root.join(LEGACY_DIR).join(id(2)).is_dir());
    }

    /// A `packed-refs` that is a link is never read through, whatever it
    /// names: git never writes one, so it is no sign of a runtime's
    /// checkout, and the folder is parked.
    #[cfg(unix)]
    #[test]
    fn a_linked_packed_refs_is_never_read_for_local_recovery_refs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let git_dir = root.join(id(2)).join(".instafy/.git");
        write(&git_dir.join("HEAD"), "ref: refs/heads/main\n");
        let outside = tempfile::tempdir().unwrap();
        let listed = outside.path().join("packed-refs");
        write(
            &listed,
            &format!("{} refs/instafy/local-recovery-pushed/x\n", "1".repeat(40)),
        );
        std::os::unix::fs::symlink(&listed, git_dir.join("packed-refs")).unwrap();

        let parked = park_legacy_checkouts(&root).unwrap();

        assert_eq!(parked.moved.len(), 1);
        assert!(root.join(LEGACY_DIR).join(id(2)).is_dir());
        assert!(listed.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_space_folder_is_moved_as_a_link_and_never_followed() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("root");
        std::fs::create_dir(&root).unwrap();
        let elsewhere = dir.path().canonicalize().unwrap().join("elsewhere");
        write(&elsewhere.join("README.md"), "outside\n");
        std::os::unix::fs::symlink(&elsewhere, root.join(id(7))).unwrap();
        // A dangling link counts too.
        std::os::unix::fs::symlink(dir.path().join("missing"), root.join(id(8))).unwrap();

        let parked = park_legacy_checkouts(&root).unwrap();

        assert_eq!(parked.moved.len(), 2);
        for n in [7, 8] {
            let moved = root.join(".legacy").join(id(n));
            assert!(std::fs::symlink_metadata(&moved)
                .unwrap()
                .file_type()
                .is_symlink());
        }
        // The folder the link named was neither moved nor changed.
        assert_eq!(
            std::fs::read_to_string(elsewhere.join("README.md")).unwrap(),
            "outside\n"
        );
        let mode = std::fs::metadata(root.join(".legacy"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_legacy_folder_that_is_a_link_stops_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("root");
        std::fs::create_dir(&root).unwrap();
        let elsewhere = dir.path().canonicalize().unwrap().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join(LEGACY_DIR)).unwrap();
        write(&root.join(id(9)).join("draft.md"), "draft\n");

        assert!(park_legacy_checkouts(&root).is_err());
        assert!(root.join(id(9)).join("draft.md").is_file());
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_moved_stops_the_start() {
        use std::os::unix::fs::PermissionsExt as _;
        if rustix::process::geteuid().is_root() {
            // Permission bits do not stop root.
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("root");
        std::fs::create_dir(&root).unwrap();
        write(&root.join(id(10)).join("draft.md"), "draft\n");
        std::fs::create_dir(root.join(LEGACY_DIR)).unwrap();
        std::fs::set_permissions(
            root.join(LEGACY_DIR),
            std::fs::Permissions::from_mode(0o500),
        )
        .unwrap();

        let result = park_legacy_checkouts(&root);

        std::fs::set_permissions(
            root.join(LEGACY_DIR),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        assert!(result.is_err());
        assert!(root.join(id(10)).join("draft.md").is_file());
    }
}
