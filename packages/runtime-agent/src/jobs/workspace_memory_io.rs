//! Bounded memory I/O through the workspace's no-follow directory capability.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use origin_http_server::workspace_fs::{WorkspaceDir, WorkspaceEntryKind};

fn relative_path<'a>(workspace_dir: &Path, path: &'a Path) -> io::Result<&'a str> {
    path.strip_prefix(workspace_dir)
        .ok()
        .and_then(Path::to_str)
        .filter(|relative| !relative.is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "memory path is outside workspace",
            )
        })
}

pub(super) fn open_file(workspace_dir: &Path, path: &Path) -> io::Result<File> {
    WorkspaceDir::open(workspace_dir)?.open_file(relative_path(workspace_dir, path)?)
}

/// Read at most the projection budget plus one byte, never the entire source first.
pub(super) fn read_prefix(
    workspace_dir: &Path,
    path: &Path,
    max_bytes: usize,
) -> io::Result<(Vec<u8>, bool)> {
    let file = open_file(workspace_dir, path)?;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > max_bytes;
    bytes.truncate(max_bytes);
    Ok((bytes, truncated))
}

pub(super) fn child_directories(workspace_dir: &Path, relative: &str) -> Vec<PathBuf> {
    WorkspaceDir::open(workspace_dir)
        .and_then(|root| root.list(Some(relative)))
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.kind == WorkspaceEntryKind::Directory)
        .map(|entry| workspace_dir.join(relative).join(entry.name))
        .collect()
}

/// Skip linked destinations, compare only enough bytes to establish equality, then
/// replace through the pinned directory. A raced-in leaf link is replaced, never followed.
pub(super) fn write_if_changed(
    workspace_dir: &Path,
    path: &Path,
    content: &str,
) -> io::Result<bool> {
    let relative = relative_path(workspace_dir, path)?;
    let root = WorkspaceDir::open(workspace_dir)?;
    let permissions = match root.open_file(relative) {
        Ok(file) => {
            let permissions = file.metadata()?.permissions();
            let mut existing = Vec::new();
            file.take(content.len().saturating_add(1) as u64)
                .read_to_end(&mut existing)?;
            if existing == content.as_bytes() {
                return Ok(false);
            }
            Some(permissions)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A dangling leaf link can also report NotFound on some platforms.
            match root.entry_kind(relative) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid memory destination",
                    ));
                }
            }
        }
        Err(error) => return Err(error),
    };
    let parent = Path::new(relative)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let temporary = parent.join(format!(".instafy-memory-write-{}", uuid::Uuid::new_v4()));
    let temporary = temporary
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid memory destination"))?;
    let result = (|| {
        root.replace_private_file(temporary, &mut content.as_bytes())?;
        if let Some(permissions) = permissions {
            root.set_file_permissions(temporary, permissions)?;
        }
        root.rename(temporary, relative)?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = root.remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn prefix_budget_does_not_require_reading_a_large_memory_source() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("SKILL.md");
        let file = File::create(&path).unwrap();
        file.set_len(1024 * 1024 * 1024).unwrap();
        let (bytes, truncated) = read_prefix(workspace.path(), &path, 4096).unwrap();
        assert_eq!(bytes.len(), 4096);
        assert!(truncated);
    }

    #[test]
    fn generated_memory_updates_are_atomic_and_unchanged_content_is_a_noop() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace
            .path()
            .join(".agents/skills/instafy-learned/usage.json");
        assert!(write_if_changed(workspace.path(), &path, "first").unwrap());
        assert!(!write_if_changed(workspace.path(), &path, "first").unwrap());
        assert!(write_if_changed(workspace.path(), &path, "second").unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn generated_memory_preserves_private_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("usage.json");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(write_if_changed(workspace.path(), &path, "new").unwrap());
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
