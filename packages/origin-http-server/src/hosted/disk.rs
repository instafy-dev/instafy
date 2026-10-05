//! Filesystem steps the gateway takes on its own directories (the cache and
//! `.legacy/`). Nothing here follows a symbolic link: entries are inspected
//! with `symlink_metadata`, links are moved or removed as links, and trees
//! are removed with `remove_dir_all`, which never descends through a link.

use std::io;
use std::path::Path;
use std::time::SystemTime;

use anyhow::{bail, Context, Result};

/// Create one directory readable only by the server's user. Fails when the
/// name exists in any form.
pub(crate) fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// `path` as a private directory: created (mode 0700) when missing, and
/// refused when something other than a real directory (a link included) is
/// there.
pub(crate) fn ensure_private_dir(path: &Path) -> Result<()> {
    match create_private_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path)
                .with_context(|| format!("failed to inspect {path:?}"))?;
            if !metadata.file_type().is_dir() {
                bail!("{path:?} exists and is not a directory (links are never followed)");
            }
            Ok(())
        }
        Err(error) => Err(error).with_context(|| format!("failed to create {path:?}")),
    }
}

/// Rename `from` to `to` only if nothing is at `to`: an existing entry is
/// never replaced (`AlreadyExists`). A link at `from` is moved as a link.
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    {
        match rustix::fs::renameat_with(
            rustix::fs::CWD,
            from,
            rustix::fs::CWD,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        ) {
            Ok(()) => return Ok(()),
            Err(errno) if errno == rustix::io::Errno::EXIST => {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists))
            }
            // A filesystem without exclusive renames: fall back below.
            Err(errno)
                if errno == rustix::io::Errno::INVAL || errno == rustix::io::Errno::NOSYS => {}
            Err(errno) => return Err(io::Error::from_raw_os_error(errno.raw_os_error())),
        }
    }
    // No other process renames into these directories while the gateway
    // runs; the check only has to keep this process from replacing an entry.
    match std::fs::symlink_metadata(to) {
        Ok(_) => Err(io::Error::from(io::ErrorKind::AlreadyExists)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => std::fs::rename(from, to),
        Err(error) => Err(error),
    }
}

/// Remove whatever is at `path`: a directory tree (never descending through
/// a link), a file or a link. Nothing there is not an error.
pub(crate) fn remove_entry(path: &Path) -> io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let result = if metadata.file_type().is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// The bytes of every regular file under `path`, links not followed.
/// Entries that vanish while it walks are skipped.
pub(crate) fn tree_size(path: &Path) -> u64 {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(metadata) if metadata.file_type().is_file() => return metadata.len(),
        _ => return 0,
    }
    let mut total = 0u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.file_type().is_dir() {
                pending.push(entry.path());
            } else if metadata.file_type().is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    total
}

/// When `path` (not followed) last changed, if it exists.
pub(crate) fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::symlink_metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exclusive_rename_never_replaces_anything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("a")).unwrap();
        std::fs::write(root.join("a/kept"), b"a").unwrap();
        // An empty directory would be replaced by a plain rename(2).
        std::fs::create_dir(root.join("empty")).unwrap();
        let error = rename_no_replace(&root.join("a"), &root.join("empty")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(root.join("a/kept").is_file());

        rename_no_replace(&root.join("a"), &root.join("b")).unwrap();
        assert!(root.join("b/kept").is_file());
        assert!(!root.join("a").exists());
    }

    #[cfg(unix)]
    #[test]
    fn links_are_moved_and_removed_as_links_and_never_taken_for_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("target")).unwrap();
        std::fs::write(root.join("target/file"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("target"), root.join("link")).unwrap();

        rename_no_replace(&root.join("link"), &root.join("moved")).unwrap();
        assert!(std::fs::symlink_metadata(root.join("moved"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(tree_size(&root.join("moved")), 0, "a link is never walked");

        remove_entry(&root.join("moved")).unwrap();
        assert!(root.join("target/file").is_file(), "the target survives");
        remove_entry(&root.join("moved")).unwrap();

        assert!(ensure_private_dir(&root.join("target/file")).is_err());
        std::os::unix::fs::symlink(root.join("target"), root.join("link2")).unwrap();
        assert!(ensure_private_dir(&root.join("link2")).is_err());
        assert_eq!(tree_size(&root.join("target")), 1);
        assert!(modified(&root.join("link2")).is_some());
        assert!(modified(&root.join("nothing")).is_none());
        ensure_private_dir(&root.join("fresh")).unwrap();
        ensure_private_dir(&root.join("fresh")).unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(root.join("fresh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
