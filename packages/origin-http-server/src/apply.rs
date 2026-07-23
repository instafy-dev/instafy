use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use tempfile::Builder as TempDirBuilder;
use tracing::warn;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zip::ZipArchive;

use crate::config::ServerConfig;
use crate::error::OriginError;
use crate::paths::{is_reserved_import_delete_path, is_reserved_path};
use crate::safe_fs::{
    create_new_content_options, open_dir_path, open_or_create_child, open_workspace_root,
    read_nofollow_options, remove_child_entry, sync_dir, ScopedTempDir,
};
use crate::workspace_fs::WorkspaceDir;

const MAX_APPLY_ENTRY_COUNT: usize = 50_000;
const MAX_APPLY_PATH_BYTES: usize = 4096;
const MAX_APPLY_TOTAL_PATH_BYTES: usize = 12 * 1024 * 1024;
// Exact rollback through concurrent ancestor renames requires one retained
// capability per unique destination parent. Keep that set bounded even when a
// service has a very high descriptor limit; lower-limit processes derive a
// smaller effective budget below.
const MAX_APPLY_ROLLBACK_DIR_CAPABILITIES: usize = 4096;
const APPLY_NON_ROLLBACK_FD_MIN_RESERVE: usize = 128;
const MULTI_TENANT_ORIGIN_MIN_NOFILE: usize = 8192;

#[cfg(unix)]
fn process_nofile_soft_limit() -> Option<usize> {
    rustix::process::getrlimit(rustix::process::Resource::Nofile)
        .current
        .and_then(|limit| usize::try_from(limit).ok())
}

#[cfg(not(unix))]
fn process_nofile_soft_limit() -> Option<usize> {
    None
}

fn apply_rollback_dir_capability_limit_for_nofile(soft_limit: Option<usize>) -> usize {
    let Some(soft_limit) = soft_limit else {
        return MAX_APPLY_ROLLBACK_DIR_CAPABILITIES;
    };
    // Retain at least 128 descriptors and at least one quarter of a constrained
    // process limit for the archive, staging, sockets, Git, and transient
    // no-follow traversal. The apply admission semaphore serializes this budget
    // across workspaces served by the same origin process.
    let reserve = APPLY_NON_ROLLBACK_FD_MIN_RESERVE.max(soft_limit / 4);
    soft_limit
        .saturating_sub(reserve)
        .clamp(1, MAX_APPLY_ROLLBACK_DIR_CAPABILITIES)
}

fn apply_rollback_dir_capability_limit() -> usize {
    apply_rollback_dir_capability_limit_for_nofile(process_nofile_soft_limit())
}

fn validate_multi_tenant_apply_fd_contract_for_nofile(soft_limit: Option<usize>) -> Result<()> {
    let Some(soft_limit) = soft_limit else {
        return Ok(());
    };
    if soft_limit < MULTI_TENANT_ORIGIN_MIN_NOFILE {
        anyhow::bail!(
            "multi-tenant origin requires a nofile soft limit of at least {MULTI_TENANT_ORIGIN_MIN_NOFILE} (found {soft_limit})"
        );
    }
    Ok(())
}

pub(crate) fn validate_multi_tenant_apply_fd_contract() -> Result<()> {
    validate_multi_tenant_apply_fd_contract_for_nofile(process_nofile_soft_limit())
}

#[derive(Debug, Deserialize)]
pub struct ManifestFileEntry {
    pub path: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub encoding: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApplyManifest {
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(rename = "leaseId")]
    pub lease_id: Option<String>,
    #[serde(default)]
    pub files: Vec<ManifestFileEntry>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(rename = "generatedAt")]
    pub generated_at: Option<String>,
    #[serde(rename = "sourceDeviceId")]
    pub source_device_id: Option<String>,
    #[serde(default, rename = "autoCommitAfterApply")]
    pub auto_commit_after_apply: bool,
    #[serde(default, rename = "commitMessage")]
    pub commit_message: Option<String>,
    #[serde(default, rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(default, rename = "requestFingerprint")]
    pub request_fingerprint: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ApplySummary {
    pub rev: String,
    pub bytes_written: u64,
    pub file_count: usize,
    pub lease_id: Option<String>,
    pub applied_paths: Vec<String>,
    pub deleted_paths: Vec<String>,
}

/// Apply a manifest through the hardened, transactional pipeline and discard
/// the rollback handle on success.
///
/// Two apply pipelines coexist in this module:
/// - [`apply_changes_in`] operates against an already-opened [`WorkspaceDir`]
///   capability and keeps the lenient warn-and-skip semantics used by the
///   collaboration sync routes (blocked deletes are contained no-ops).
/// - [`apply_changes_transactional`] / [`apply_changes_transactional_file`]
///   validate the entire destination set up front, reject invalid manifests
///   outright, and return an [`ApplyTransaction`] so downstream failures (Git
///   commit, idempotency receipt) can restore the exact pre-apply workspace.
pub fn apply_changes(
    config: &ServerConfig,
    workspace_root: &Path,
    manifest: ApplyManifest,
    archive_bytes: &[u8],
) -> Result<ApplySummary, OriginError> {
    let (summary, transaction) =
        apply_changes_transactional(config, workspace_root, manifest, archive_bytes)?;
    transaction.finish();
    Ok(summary)
}

pub fn apply_changes_in(
    config: &ServerConfig,
    workspace: &WorkspaceDir,
    manifest: ApplyManifest,
    archive_bytes: &[u8],
) -> Result<ApplySummary, OriginError> {
    if let Some(project_id) = manifest.project_id.as_deref() {
        if !config.multi_tenant && project_id != config.project_id.to_string() {
            return Err(OriginError::bad_request("manifest project mismatch"));
        }
    }

    if archive_bytes.len() as u64 > config.max_archive_bytes {
        return Err(OriginError::bad_request("archive exceeds size limit"));
    }

    // The old default staged below `.instafy` by ambient path, which could
    // itself be redirected through a symlink. Use the OS temp root unless an
    // administrator supplied a trusted staging base. Destination writes are
    // copied into same-directory temporary leaves and atomically renamed by
    // WorkspaceDir, so staging need not share the workspace filesystem.
    let temp_dir = if let Some(staging_root) = config.staging_base.as_deref() {
        fs::create_dir_all(staging_root)
            .with_context(|| format!("failed to create staging root {:?}", staging_root))
            .map_err(|error| OriginError::internal(error.to_string()))?;
        TempDirBuilder::new()
            .prefix("apply-")
            .tempdir_in(staging_root)
    } else {
        TempDirBuilder::new().prefix("instafy-apply-").tempdir()
    }
    .map_err(|error| {
        OriginError::internal(format!("failed to create apply staging dir: {error}"))
    })?;

    let mut archive = ZipArchive::new(Cursor::new(archive_bytes))
        .map_err(|error| OriginError::bad_request(format!("invalid workspace archive: {error}")))?;

    // Stage each file under a synthetic filename so case-only path differences
    // in upstream repos do not collide on case-insensitive workspace mounts.
    let mut staged_files: Vec<(String, File, bool)> = Vec::new();
    let mut dedupe: HashSet<String> = HashSet::new();
    let mut delete_paths: Vec<String> = Vec::new();
    let mut delete_dedupe: HashSet<String> = HashSet::new();
    let mut bytes_written: u64 = 0;
    let mut file_count: usize = 0;

    for entry in manifest.files {
        let normalized = match normalize_relative_path(&entry.path) {
            Some(value) => value,
            None => {
                warn!(path = %entry.path, "skipping manifest entry with invalid path");
                continue;
            }
        };

        if normalized.eq_ignore_ascii_case(".instafy") || is_reserved_path(&normalized) {
            warn!(path = %normalized, "skipping manifest entry with reserved path");
            continue;
        }

        if !dedupe.insert(normalized.clone()) {
            warn!(path = %normalized, "duplicate manifest path detected");
            continue;
        }

        let mut zip_file = match archive.by_name(&normalized) {
            Ok(file) => file,
            Err(error) => {
                warn!(path = %normalized, ?error, "archive missing manifest file");
                continue;
            }
        };
        let archive_mode = zip_file.unix_mode();

        let staged_index = staged_files.len();
        let staging_path = temp_dir.path().join(format!("entry-{staged_index:08}"));

        let mut staging_file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&staging_path)
            .with_context(|| format!("failed to open staging file {:?}", staging_path))
            .map_err(|error| OriginError::internal(error.to_string()))?;

        let remaining = config.max_archive_bytes.saturating_sub(bytes_written);
        let written =
            copy_archive_entry(&mut zip_file, &mut staging_file, remaining).map_err(|error| {
                if error.kind() == std::io::ErrorKind::InvalidData {
                    OriginError::bad_request("expanded archive exceeds size limit")
                } else {
                    OriginError::internal(error.to_string())
                }
            })?;
        bytes_written += written;
        file_count += 1;

        staging_file
            .sync_all()
            .with_context(|| format!("failed to flush staging file {:?}", staging_path))
            .map_err(|error| OriginError::internal(error.to_string()))?;

        staged_files.push((
            normalized,
            staging_file,
            archive_mode.is_some_and(|mode| mode & 0o111 != 0),
        ));
    }

    // Apply files by renaming from staging into workspace.
    for (relative, staging_file, executable) in &mut staged_files {
        staging_file
            .seek(SeekFrom::Start(0))
            .with_context(|| format!("failed to rewind staging file for {relative:?}"))
            .map_err(|error| OriginError::internal(error.to_string()))?;
        workspace
            .replace_file(relative, staging_file, *executable)
            .with_context(|| format!("failed to replace workspace file {relative:?}"))
            .map_err(|error| OriginError::internal(error.to_string()))?;
    }

    // Handle deletes.
    for entry in &manifest.deletes {
        let normalized = match normalize_relative_path(entry) {
            Some(value) => value,
            None => continue,
        };

        if normalized.eq_ignore_ascii_case(".instafy") || is_reserved_path(&normalized) {
            warn!(path = %normalized, "skipping delete for reserved path");
            continue;
        }

        if !delete_dedupe.insert(normalized.clone()) {
            continue;
        }
        delete_paths.push(normalized.clone());

        if let Err(error) = workspace.remove(&normalized) {
            if error.kind() != std::io::ErrorKind::NotFound {
                warn!(?error, path = %normalized, "failed to delete workspace entry");
            }
        }
    }

    let rev = DateTime::<Utc>::from(SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    Ok(ApplySummary {
        rev,
        bytes_written,
        file_count,
        lease_id: manifest.lease_id,
        applied_paths: staged_files.into_iter().map(|(path, _, _)| path).collect(),
        deleted_paths: delete_paths,
    })
}

pub fn apply_changes_transactional(
    config: &ServerConfig,
    workspace_root: &Path,
    manifest: ApplyManifest,
    archive_bytes: &[u8],
) -> Result<(ApplySummary, ApplyTransaction), OriginError> {
    apply_changes_transactional_reader(
        config,
        workspace_root,
        manifest,
        Cursor::new(archive_bytes),
        archive_bytes.len() as u64,
    )
}

pub fn apply_changes_transactional_file(
    config: &ServerConfig,
    workspace_root: &Path,
    manifest: ApplyManifest,
    archive_file: File,
    archive_size: u64,
) -> Result<(ApplySummary, ApplyTransaction), OriginError> {
    apply_changes_transactional_reader(config, workspace_root, manifest, archive_file, archive_size)
}

fn apply_changes_transactional_reader<R: Read + Seek>(
    config: &ServerConfig,
    workspace_root: &Path,
    manifest: ApplyManifest,
    archive_reader: R,
    archive_size: u64,
) -> Result<(ApplySummary, ApplyTransaction), OriginError> {
    if let Some(project_id) = manifest.project_id.as_deref() {
        if !config.multi_tenant && project_id != config.project_id.to_string() {
            return Err(OriginError::bad_request("manifest project mismatch"));
        }
    }

    if archive_size > config.max_archive_bytes {
        return Err(OriginError::bad_request("archive exceeds size limit"));
    }
    let combined_entry_count = manifest
        .files
        .len()
        .checked_add(manifest.deletes.len())
        .ok_or_else(|| OriginError::bad_request("manifest entry count overflow"))?;
    if combined_entry_count > MAX_APPLY_ENTRY_COUNT {
        return Err(OriginError::bad_request(format!(
            "manifest exceeds combined entry count limit ({MAX_APPLY_ENTRY_COUNT})"
        )));
    }

    // Validate the entire destination set before staging or mutating anything.
    // This rejects portable case collisions and ancestor overlaps that would
    // otherwise make a sequential apply order-dependent.
    let (validated_files, delete_paths) =
        validate_manifest_destinations(manifest.files, manifest.deletes)?;
    let rollback_dir_capability_limit = apply_rollback_dir_capability_limit();
    let validated_install_paths = validated_files
        .iter()
        .map(|(path, _)| path.as_str())
        .collect::<Vec<_>>();
    validate_install_parent_capability_limit(
        &validated_install_paths,
        rollback_dir_capability_limit,
    )?;
    let lease_id = manifest.lease_id;
    let max_uncompressed_bytes = config.max_archive_bytes.saturating_mul(4);

    let workspace = open_workspace_root(workspace_root)
        .map_err(|error| OriginError::bad_request(format!("workspace root is unsafe: {error}")))?;
    let staging_parent = if let Some(custom_staging) = config.staging_base.as_deref() {
        // This is operator-controlled storage rather than a manifest path. It is
        // opened once as its own capability; all staged entries remain relative
        // to that handle afterward.
        fs::create_dir_all(custom_staging)
            .with_context(|| format!("failed to create staging root {custom_staging:?}"))
            .map_err(|error| OriginError::internal(error.to_string()))?;
        Dir::open_ambient_dir(custom_staging, ambient_authority()).map_err(|error| {
            OriginError::internal(format!("failed to open staging root: {error}"))
        })?
    } else {
        let staging_relative = PathBuf::from(".instafy")
            .join("origin-staging")
            .join(config.origin_id.to_string());
        open_dir_path(&workspace, &staging_relative, true).map_err(|error| {
            OriginError::bad_request(format!("workspace staging path is unsafe: {error}"))
        })?
    };
    let temp_dir = ScopedTempDir::new(&staging_parent, "apply-").map_err(|error| {
        OriginError::internal(format!("failed to create apply staging dir: {error}"))
    })?;

    let mut archive = ZipArchive::new(archive_reader)
        .map_err(|error| OriginError::bad_request(format!("invalid workspace archive: {error}")))?;
    if archive.len() > MAX_APPLY_ENTRY_COUNT {
        return Err(OriginError::bad_request(format!(
            "archive exceeds entry count limit ({MAX_APPLY_ENTRY_COUNT})"
        )));
    }

    let selected_paths = validated_files
        .iter()
        .map(|(path, _)| path.as_str())
        .collect::<HashSet<_>>();
    let mut archive_member_counts: HashMap<String, usize> = HashMap::new();
    for index in 0..archive.len() {
        let zip_file = archive.by_index(index).map_err(|error| {
            OriginError::bad_request(format!("invalid workspace archive entry: {error}"))
        })?;
        if selected_paths.contains(zip_file.name()) {
            let count = archive_member_counts
                .entry(zip_file.name().to_string())
                .or_default();
            *count = count
                .checked_add(1)
                .ok_or_else(|| OriginError::bad_request("archive entry count overflow"))?;
        }
    }
    for (path, _) in &validated_files {
        match archive_member_counts.get(path).copied().unwrap_or(0) {
            1 => {}
            0 => {
                return Err(OriginError::bad_request(format!(
                    "archive is missing manifest file {path:?}"
                )))
            }
            _ => {
                return Err(OriginError::bad_request(format!(
                    "archive contains duplicate manifest file {path:?}"
                )))
            }
        }
    }

    // Stage each file under a synthetic filename so case-only path differences
    // in upstream repos do not collide on case-insensitive workspace mounts.
    let mut staged_files: Vec<(String, OsString)> = Vec::new();
    let mut bytes_written: u64 = 0;
    let mut file_count: usize = 0;

    for (normalized, entry) in validated_files {
        let mut zip_file = archive.by_name(&normalized).map_err(|error| {
            OriginError::bad_request(format!(
                "failed to open archive member {normalized:?}: {error}"
            ))
        })?;
        if zip_file.is_dir() {
            return Err(OriginError::bad_request(format!(
                "manifest file {normalized:?} refers to an archive directory"
            )));
        }
        let archive_mode = zip_file.unix_mode();
        let declared_size = zip_file.size();
        if declared_size > max_uncompressed_bytes.saturating_sub(bytes_written) {
            return Err(OriginError::bad_request(
                "uncompressed archive contents exceed size limit",
            ));
        }
        if let Some(manifest_size) = entry.size {
            if manifest_size != declared_size {
                return Err(OriginError::bad_request(format!(
                    "manifest size mismatch for {normalized:?}"
                )));
            }
        }

        let staged_index = staged_files.len();
        let staging_name = OsString::from(format!("entry-{staged_index:08}"));
        let mut staging_file = temp_dir
            .dir()
            .open_with(&staging_name, &create_new_content_options())
            .map_err(|error| {
                OriginError::internal(format!("failed to open staging file: {error}"))
            })?
            .into_std();

        let remaining = max_uncompressed_bytes.saturating_sub(bytes_written);
        let written =
            copy_archive_entry(&mut zip_file, &mut staging_file, remaining).map_err(|error| {
                if error.kind() == io::ErrorKind::InvalidData {
                    OriginError::bad_request(error.to_string())
                } else {
                    OriginError::internal(error.to_string())
                }
            })?;
        if written != declared_size {
            return Err(OriginError::bad_request(format!(
                "archive size mismatch for {normalized:?}"
            )));
        }
        bytes_written = bytes_written
            .checked_add(written)
            .ok_or_else(|| OriginError::bad_request("uncompressed archive size overflow"))?;
        file_count = file_count
            .checked_add(1)
            .ok_or_else(|| OriginError::bad_request("manifest file count overflow"))?;

        apply_executable_archive_mode(&staging_file, archive_mode)
            .map_err(|error| OriginError::internal(error.to_string()))?;

        staging_file
            .sync_all()
            .context("failed to flush staging file")
            .map_err(|error| OriginError::internal(error.to_string()))?;

        staged_files.push((normalized, staging_name));
    }

    let install_paths = staged_files
        .iter()
        .map(|(path, _)| path.as_str())
        .collect::<Vec<_>>();
    let mutation_paths = install_paths
        .iter()
        .copied()
        .chain(delete_paths.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let mut rollback = ApplyRollback::capture_with_limit(
        &workspace,
        &mutation_paths,
        &install_paths,
        rollback_dir_capability_limit,
        config.origin_id,
    )?;
    if let Err(apply_error) = install_staged_files(temp_dir.dir(), &staged_files, &rollback) {
        if let Err(rollback_error) = rollback.rollback() {
            return Err(OriginError::internal(format!(
                "apply failed ({apply_error}); workspace rollback also failed ({rollback_error})"
            )));
        }
        return Err(apply_error);
    }
    // Existing delete targets were atomically moved into the rollback area.
    // Finishing discards those backups only after every file install succeeded.
    let rev = DateTime::<Utc>::from(SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    Ok((
        ApplySummary {
            rev,
            bytes_written,
            file_count,
            lease_id,
            applied_paths: staged_files.into_iter().map(|(path, _)| path).collect(),
            deleted_paths: delete_paths,
        },
        ApplyTransaction { rollback },
    ))
}

fn validate_manifest_destinations(
    files: Vec<ManifestFileEntry>,
    deletes: Vec<String>,
) -> Result<(Vec<(String, ManifestFileEntry)>, Vec<String>), OriginError> {
    let mut validated_files = Vec::with_capacity(files.len());
    let mut validated_deletes = Vec::with_capacity(deletes.len());
    let mut portable_destinations = HashMap::<String, String>::new();
    let mut total_path_bytes = 0usize;

    for entry in files {
        let normalized = validate_manifest_path(&entry.path, false)?;
        total_path_bytes = total_path_bytes
            .checked_add(normalized.len())
            .ok_or_else(|| OriginError::bad_request("manifest path bytes overflow"))?;
        insert_portable_destination(&mut portable_destinations, &normalized)?;
        validated_files.push((normalized, entry));
    }
    for entry in deletes {
        let normalized = validate_manifest_path(&entry, true)?;
        total_path_bytes = total_path_bytes
            .checked_add(normalized.len())
            .ok_or_else(|| OriginError::bad_request("manifest path bytes overflow"))?;
        insert_portable_destination(&mut portable_destinations, &normalized)?;
        validated_deletes.push(normalized);
    }
    if total_path_bytes > MAX_APPLY_TOTAL_PATH_BYTES {
        return Err(OriginError::bad_request(format!(
            "manifest exceeds total path-byte limit ({MAX_APPLY_TOTAL_PATH_BYTES})"
        )));
    }

    for (descendant_key, descendant_path) in &portable_destinations {
        for (separator_index, _) in descendant_key.match_indices('/') {
            let ancestor_key = &descendant_key[..separator_index];
            if let Some(ancestor_path) = portable_destinations.get(ancestor_key) {
                return Err(OriginError::bad_request(format!(
                    "manifest destinations overlap: {ancestor_path:?} and {descendant_path:?}"
                )));
            }
        }
    }

    Ok((validated_files, validated_deletes))
}

fn validate_manifest_path(path: &str, delete: bool) -> Result<String, OriginError> {
    if path.contains('\\') {
        return Err(OriginError::bad_request(
            "manifest paths must use forward slashes",
        ));
    }
    let normalized = normalize_relative_path(path)
        .ok_or_else(|| OriginError::bad_request(format!("invalid manifest path {path:?}")))?;
    if normalized.len() > MAX_APPLY_PATH_BYTES {
        return Err(OriginError::bad_request(format!(
            "manifest path exceeds {MAX_APPLY_PATH_BYTES} bytes"
        )));
    }
    // The bare metadata root stays reserved regardless of how the shared
    // reserved-path helpers classify it: staging and rollback live below it.
    let reserved = normalized.eq_ignore_ascii_case(".instafy")
        || if delete {
            is_reserved_import_delete_path(&normalized)
        } else {
            is_reserved_path(&normalized)
        };
    if reserved {
        return Err(OriginError::bad_request(format!(
            "manifest path {normalized:?} is reserved"
        )));
    }
    for component in normalized.split('/') {
        validate_portable_component(component)?;
    }
    Ok(normalized)
}

fn validate_portable_component(component: &str) -> Result<(), OriginError> {
    if component.ends_with([' ', '.'])
        || component.contains(':')
        || component.chars().any(|value| value <= '\u{1f}')
    {
        return Err(OriginError::bad_request(format!(
            "manifest path component {component:?} is not portable"
        )));
    }
    let device_stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .to_ascii_uppercase();
    let is_dos_device = matches!(device_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device_stem
            .strip_prefix("COM")
            .or_else(|| device_stem.strip_prefix("LPT"))
            .is_some_and(|number| matches!(number.as_bytes(), [b'1'..=b'9']));
    if is_dos_device {
        return Err(OriginError::bad_request(format!(
            "manifest path component {component:?} is a reserved device name"
        )));
    }
    Ok(())
}

fn insert_portable_destination(
    destinations: &mut HashMap<String, String>,
    normalized: &str,
) -> Result<(), OriginError> {
    // APFS/HFS and Windows commonly collapse case and canonical Unicode forms;
    // reject those aliases even when the current origin host is Linux.
    let portable_key = normalized
        .nfc()
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if let Some(existing) = destinations.insert(portable_key, normalized.to_string()) {
        return Err(OriginError::bad_request(format!(
            "manifest destinations collide: {existing:?} and {normalized:?}"
        )));
    }
    Ok(())
}

fn install_staged_files(
    staging: &Dir,
    staged_files: &[(String, OsString)],
    rollback: &ApplyRollback,
) -> Result<(), OriginError> {
    install_staged_files_with_hook(staging, staged_files, rollback, |_| Ok(()))
}

fn install_staged_files_with_hook<F>(
    staging: &Dir,
    staged_files: &[(String, OsString)],
    rollback: &ApplyRollback,
    mut after_install: F,
) -> Result<(), OriginError>
where
    F: FnMut(usize) -> Result<(), OriginError>,
{
    for (index, (relative, staging_name)) in staged_files.iter().enumerate() {
        let target = rollback.install_targets.get(relative).ok_or_else(|| {
            OriginError::internal(format!(
                "apply destination {relative:?} was not resolved during rollback preflight"
            ))
        })?;
        // Every existing and apply-created parent is resolved once during
        // rollback capture and retained behind the same bounded capability
        // cache. Never re-walk even an initially missing ancestor by name: it
        // may have been renamed or replaced between two file installations.
        install_staged_file_at_parent(
            staging,
            relative,
            staging_name,
            &rollback.parents[target.parent_index],
            &target.leaf,
        )?;
        after_install(index)?;
    }
    Ok(())
}

struct RollbackTarget {
    parent_index: usize,
    leaf: OsString,
    backup_name: Option<OsString>,
}

struct ResolvedRollbackTarget {
    parent_index: usize,
    leaf: OsString,
}

struct ResolvedInstallTarget {
    parent_index: usize,
    leaf: OsString,
}

struct PlannedInstallTarget {
    relative: String,
    parent_components: Vec<OsString>,
    leaf: OsString,
    needs_leaf_cleanup: bool,
}

struct ResolvedRollbackTargets {
    parents: Vec<Dir>,
    parent_indexes: HashMap<String, usize>,
    targets: Vec<ResolvedRollbackTarget>,
    target_keys: HashSet<String>,
    install_plans: Vec<PlannedInstallTarget>,
}

struct ApplyRollback {
    temp_dir: ScopedTempDir,
    parents: Vec<Dir>,
    targets: Vec<RollbackTarget>,
    install_targets: HashMap<String, ResolvedInstallTarget>,
    active: bool,
}

/// Keeps pre-apply filesystem backups alive across the Git commit and durable
/// idempotency receipt. Known downstream failures can therefore restore the
/// exact pre-apply workspace instead of exposing a partial import.
pub struct ApplyTransaction {
    rollback: ApplyRollback,
}

impl ApplyTransaction {
    pub fn rollback(&mut self) -> Result<(), OriginError> {
        self.rollback.rollback()
    }

    pub fn finish(self) {
        self.rollback.finish();
    }
}

impl ApplyRollback {
    #[cfg(test)]
    fn capture(
        workspace: &Dir,
        mutation_paths: &[&str],
        install_paths: &[&str],
        origin_id: Uuid,
    ) -> Result<Self, OriginError> {
        Self::capture_with_limit(
            workspace,
            mutation_paths,
            install_paths,
            apply_rollback_dir_capability_limit(),
            origin_id,
        )
    }

    fn capture_with_limit(
        workspace: &Dir,
        mutation_paths: &[&str],
        install_paths: &[&str],
        rollback_dir_capability_limit: usize,
        origin_id: Uuid,
    ) -> Result<Self, OriginError> {
        // Resolve every ancestor before the first user-visible mutation. The
        // held directory capabilities remain anchored if a path is swapped
        // concurrently after this preflight. A conservative capability limit
        // rejects extreme directory fan-out before workspace mutation instead
        // of allowing the process to exhaust its descriptors.
        let ResolvedRollbackTargets {
            parents,
            mut parent_indexes,
            targets: resolved,
            mut target_keys,
            install_plans,
        } = resolve_rollback_targets(
            workspace,
            mutation_paths,
            install_paths,
            rollback_dir_capability_limit,
        )?;

        let rollback_parent = open_dir_path(
            workspace,
            &PathBuf::from(".instafy")
                .join("origin-staging")
                .join(origin_id.to_string())
                .join("rollback"),
            true,
        )
        .map_err(|error| {
            OriginError::bad_request(format!("workspace rollback path is unsafe: {error}"))
        })?;
        let temp_dir = ScopedTempDir::new(&rollback_parent, "rollback-").map_err(|error| {
            OriginError::internal(format!("failed to create rollback staging dir: {error}"))
        })?;
        let mut rollback = Self {
            temp_dir,
            parents,
            targets: Vec::with_capacity(resolved.len() + install_plans.len()),
            install_targets: HashMap::with_capacity(install_plans.len()),
            active: true,
        };

        for (index, resolved_target) in resolved.into_iter().enumerate() {
            let parent = &rollback.parents[resolved_target.parent_index];
            let leaf = resolved_target.leaf;
            let backup_name = match parent.symlink_metadata(&leaf) {
                Ok(_) => {
                    let backup_name = OsString::from(format!("target-{index:08}"));
                    parent
                        .rename(&leaf, rollback.temp_dir.dir(), &backup_name)
                        .map_err(|error| {
                            OriginError::internal(format!(
                                "failed to snapshot apply destination {:?}: {error}",
                                leaf
                            ))
                        })?;
                    Some(backup_name)
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(OriginError::bad_request(format!(
                        "failed to inspect apply destination {:?}: {error}",
                        leaf
                    )))
                }
            };
            rollback.targets.push(RollbackTarget {
                parent_index: resolved_target.parent_index,
                leaf,
                backup_name,
            });
            sync_dir(parent).map_err(|error| {
                OriginError::internal(format!("failed to flush apply snapshot: {error}"))
            })?;
            sync_dir(rollback.temp_dir.dir()).map_err(|error| {
                OriginError::internal(format!("failed to flush rollback staging: {error}"))
            })?;
        }

        // Create and retain every missing install parent once, after the
        // rollback snapshots exist but before file installation begins. The
        // lexical preflight above has already proved this cache cannot exceed
        // the process-aware descriptor budget. Cleanup targets for newly-created
        // descendants run before their outer rollback unit, so applied content
        // can still be removed if a concurrent process renames that unit.
        for plan in install_plans {
            let mut parent_index = 0usize;
            let mut key_parts = Vec::with_capacity(plan.parent_components.len());
            for name in &plan.parent_components {
                key_parts.push(name.to_string_lossy().to_string());
                let directory_key = key_parts.join("/");
                if let Some(index) = parent_indexes.get(&directory_key).copied() {
                    parent_index = index;
                    continue;
                }
                if rollback.parents.len() >= rollback_dir_capability_limit {
                    return Err(OriginError::internal(
                        "apply directory capability plan exceeded its preflight bound",
                    ));
                }
                let child = open_or_create_child(&rollback.parents[parent_index], name).map_err(
                    |error| {
                        OriginError::bad_request(format!(
                            "apply path {:?} has an unsafe ancestor: {error}",
                            plan.relative
                        ))
                    },
                )?;
                if target_keys.insert(directory_key.clone()) {
                    rollback.targets.push(RollbackTarget {
                        parent_index,
                        leaf: name.clone(),
                        backup_name: None,
                    });
                }
                parent_index = rollback.parents.len();
                rollback.parents.push(child);
                parent_indexes.insert(directory_key, parent_index);
            }
            if plan.needs_leaf_cleanup {
                let target_key = if key_parts.is_empty() {
                    plan.leaf.to_string_lossy().to_string()
                } else {
                    format!("{}/{}", key_parts.join("/"), plan.leaf.to_string_lossy())
                };
                if target_keys.insert(target_key) {
                    rollback.targets.push(RollbackTarget {
                        parent_index,
                        leaf: plan.leaf.clone(),
                        backup_name: None,
                    });
                }
            }
            rollback.install_targets.insert(
                plan.relative,
                ResolvedInstallTarget {
                    parent_index,
                    leaf: plan.leaf,
                },
            );
        }
        Ok(rollback)
    }

    fn rollback(&mut self) -> Result<(), OriginError> {
        if !self.active {
            return Ok(());
        }
        for target in self.targets.iter().rev() {
            let parent = &self.parents[target.parent_index];
            remove_child_entry(parent, &target.leaf).map_err(|error| {
                OriginError::internal(format!(
                    "failed to remove partially applied destination {:?}: {error}",
                    target.leaf
                ))
            })?;
            if let Some(backup_name) = target.backup_name.as_deref() {
                self.temp_dir
                    .dir()
                    .rename(backup_name, parent, &target.leaf)
                    .map_err(|error| {
                        OriginError::internal(format!(
                            "failed to restore apply destination {:?}: {error}",
                            target.leaf
                        ))
                    })?;
                sync_dir(parent).map_err(|error| {
                    OriginError::internal(format!("failed to flush restored destination: {error}"))
                })?;
            }
        }
        self.active = false;
        Ok(())
    }

    fn finish(mut self) {
        self.active = false;
    }
}

impl Drop for ApplyRollback {
    fn drop(&mut self) {
        if self.active {
            let _ = self.rollback();
        }
    }
}

fn rollback_dir_capability_limit_error(limit: usize) -> OriginError {
    OriginError::bad_request(format!(
        "apply exceeds rollback directory capability limit ({limit}); split the change into smaller batches or raise the service file-descriptor limit"
    ))
}

fn planned_install_parent_keys(install_paths: &[&str]) -> Result<HashSet<String>, OriginError> {
    let mut planned_parent_keys = HashSet::new();
    for relative in install_paths {
        let names = apply_path_names(relative)?;
        let mut key_parts = Vec::with_capacity(names.len().saturating_sub(1));
        for name in &names[..names.len() - 1] {
            key_parts.push(name.to_string_lossy().to_string());
            planned_parent_keys.insert(key_parts.join("/"));
        }
    }
    Ok(planned_parent_keys)
}

fn validate_install_parent_capability_limit(
    install_paths: &[&str],
    rollback_dir_capability_limit: usize,
) -> Result<(), OriginError> {
    let planned_parent_count = planned_install_parent_keys(install_paths)?.len();
    if planned_parent_count.saturating_add(1) > rollback_dir_capability_limit {
        return Err(rollback_dir_capability_limit_error(
            rollback_dir_capability_limit,
        ));
    }
    Ok(())
}

fn resolve_rollback_targets(
    workspace: &Dir,
    mutation_paths: &[&str],
    install_paths: &[&str],
    rollback_dir_capability_limit: usize,
) -> Result<ResolvedRollbackTargets, OriginError> {
    // Count all logical parents, including parents that do not exist yet,
    // before taking a snapshot or creating a directory. A flat batch may
    // contain tens of thousands of leaves but still needs only one capability
    // per unique parent. Directory-heavy batches fail before mutation.
    let planned_parent_keys = planned_install_parent_keys(install_paths)?;
    if planned_parent_keys.len().saturating_add(1) > rollback_dir_capability_limit {
        return Err(rollback_dir_capability_limit_error(
            rollback_dir_capability_limit,
        ));
    }

    // Delete-only tails are never created or retained. Add only the ancestors
    // that actually open below, while reserving capacity for every planned
    // install parent so their union is bounded before snapshots begin.
    let mut required_parent_keys = planned_parent_keys;
    let install_path_set = install_paths.iter().copied().collect::<HashSet<_>>();
    let root = workspace.try_clone().map_err(|error| {
        OriginError::bad_request(format!("workspace root is unsafe during apply: {error}"))
    })?;
    let mut parents = vec![root];
    let mut parent_indexes = HashMap::from([(String::new(), 0usize)]);
    let mut targets = Vec::new();
    let mut target_keys = HashSet::new();
    let mut install_plans = Vec::with_capacity(install_paths.len());

    for relative in mutation_paths {
        let names = apply_path_names(relative)?;
        let (leaf, ancestors) = names
            .split_last()
            .ok_or_else(|| OriginError::bad_request(format!("apply path {relative:?} is empty")))?;
        let mut parent_index = 0usize;
        let mut key_parts = Vec::with_capacity(names.len());
        let mut missing_ancestor = false;

        for name in ancestors {
            key_parts.push(name.to_string_lossy().to_string());
            let directory_key = key_parts.join("/");
            if let Some(index) = parent_indexes.get(&directory_key).copied() {
                parent_index = index;
                continue;
            }
            match parents[parent_index].open_dir_nofollow(name) {
                Ok(child) => {
                    if required_parent_keys.insert(directory_key.clone())
                        && required_parent_keys.len().saturating_add(1)
                            > rollback_dir_capability_limit
                    {
                        return Err(rollback_dir_capability_limit_error(
                            rollback_dir_capability_limit,
                        ));
                    }
                    parent_index = parents.len();
                    parents.push(child);
                    parent_indexes.insert(directory_key, parent_index);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if target_keys.insert(directory_key) {
                        targets.push(ResolvedRollbackTarget {
                            parent_index,
                            leaf: name.clone(),
                        });
                    }
                    missing_ancestor = true;
                    break;
                }
                Err(error) => {
                    return Err(OriginError::bad_request(format!(
                        "apply path {relative:?} has an unsafe ancestor: {error}"
                    )))
                }
            }
        }

        if !missing_ancestor {
            key_parts.push(leaf.to_string_lossy().to_string());
            if target_keys.insert(key_parts.join("/")) {
                targets.push(ResolvedRollbackTarget {
                    parent_index,
                    leaf: leaf.clone(),
                });
            }
        }
        if install_path_set.contains(relative) {
            install_plans.push(PlannedInstallTarget {
                relative: (*relative).to_string(),
                parent_components: ancestors.to_vec(),
                leaf: leaf.clone(),
                needs_leaf_cleanup: missing_ancestor,
            });
        }
    }

    if install_plans.len() != install_path_set.len() {
        return Err(OriginError::internal(
            "install paths must be included in the apply mutation plan",
        ));
    }

    Ok(ResolvedRollbackTargets {
        parents,
        parent_indexes,
        targets,
        target_keys,
        install_plans,
    })
}

fn apply_path_names(relative: &str) -> Result<Vec<OsString>, OriginError> {
    let names = Path::new(relative)
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.to_os_string()),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsafe rollback path component",
            )),
        })
        .collect::<io::Result<Vec<_>>>()
        .map_err(|error| {
            OriginError::bad_request(format!(
                "apply path {relative:?} has an unsafe ancestor: {error}"
            ))
        })?;
    if names.is_empty() {
        return Err(OriginError::bad_request(format!(
            "apply path {relative:?} is empty"
        )));
    }
    Ok(names)
}

fn install_staged_file_at_parent(
    staging: &Dir,
    relative: &str,
    staging_name: &OsStr,
    parent: &Dir,
    leaf: &OsStr,
) -> Result<(), OriginError> {
    if let Err(rename_error) = staging.rename(staging_name, parent, leaf) {
        warn!(
            ?rename_error,
            path = %relative,
            "rename failed; attempting sibling-temp copy fallback"
        );
        copy_staged_file_via_sibling_temp(staging, staging_name, parent, leaf)?;
        staging.remove_file(staging_name).map_err(|error| {
            OriginError::internal(format!("failed to remove staging file after copy: {error}"))
        })?;
    }
    sync_dir(parent).map_err(|error| {
        OriginError::internal(format!(
            "failed to flush applied file parent for {relative:?}: {error}"
        ))
    })?;
    Ok(())
}

fn copy_staged_file_via_sibling_temp(
    staging: &Dir,
    staging_name: &OsStr,
    parent: &Dir,
    leaf: &OsStr,
) -> Result<(), OriginError> {
    let temporary_name = OsString::from(format!(".instafy-apply-{}.tmp", Uuid::new_v4()));
    let copy_result = (|| -> Result<(), OriginError> {
        let mut source = staging
            .open_with(staging_name, &read_nofollow_options())
            .map_err(|error| {
                OriginError::internal(format!("failed to open staged file: {error}"))
            })?;
        let permissions = source
            .metadata()
            .map_err(|error| {
                OriginError::internal(format!("failed to read staging permissions: {error}"))
            })?
            .permissions();
        let mut temporary = parent
            .open_with(&temporary_name, &create_new_content_options())
            .map_err(|error| {
                OriginError::internal(format!("failed to create sibling apply temp: {error}"))
            })?;
        io::copy(&mut source, &mut temporary).map_err(|error| {
            OriginError::internal(format!("failed to copy staged file: {error}"))
        })?;
        temporary.set_permissions(permissions).map_err(|error| {
            OriginError::internal(format!("failed to apply staging permissions: {error}"))
        })?;
        temporary.sync_all().map_err(|error| {
            OriginError::internal(format!("failed to flush sibling apply temp: {error}"))
        })?;
        drop(temporary);
        parent
            .rename(&temporary_name, parent, leaf)
            .map_err(|error| {
                OriginError::internal(format!("failed to install sibling apply temp: {error}"))
            })?;
        sync_dir(parent).map_err(|error| {
            OriginError::internal(format!("failed to flush apply parent: {error}"))
        })?;
        Ok(())
    })();
    if copy_result.is_err() {
        let _ = parent.remove_file(&temporary_name);
    }
    copy_result
}

pub fn normalize_relative_path(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut buf = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(segment) => buf.push(segment),
            Component::CurDir => continue,
            Component::Prefix(_) | Component::ParentDir | Component::RootDir => return None,
        }
    }

    if buf.as_os_str().is_empty() {
        return None;
    }

    Some(pathbuf_to_string(&buf))
}

fn pathbuf_to_string(path: &Path) -> String {
    path.iter()
        .map(|component| component.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn copy_archive_entry<R, W>(zip_file: &mut R, writer: &mut W, max_bytes: u64) -> io::Result<u64>
where
    R: Read,
    W: Write,
{
    let mut buf = [0u8; 8192];
    let mut total = 0u64;
    loop {
        let bytes = zip_file.read(&mut buf)?;
        if bytes == 0 {
            break;
        }
        let next_total = total.checked_add(bytes as u64).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "archive entry size overflow")
        })?;
        if next_total > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "uncompressed archive contents exceed size limit",
            ));
        }
        writer.write_all(&buf[..bytes])?;
        total = next_total;
    }
    writer.flush()?;
    Ok(total)
}

#[cfg(unix)]
fn apply_executable_archive_mode(file: &File, unix_mode: Option<u32>) -> Result<()> {
    let Some(mode) = unix_mode else {
        return Ok(());
    };
    if mode & 0o111 == 0 {
        return Ok(());
    }

    let mut permissions = file.metadata()?.permissions();
    permissions.set_mode(0o755);
    file.set_permissions(permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_executable_archive_mode(_file: &File, _unix_mode: Option<u32>) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_changes, apply_changes_in, apply_rollback_dir_capability_limit,
        apply_rollback_dir_capability_limit_for_nofile, install_staged_file_at_parent,
        install_staged_files, install_staged_files_with_hook, normalize_relative_path,
        validate_install_parent_capability_limit,
        validate_multi_tenant_apply_fd_contract_for_nofile, ApplyManifest, ApplyRollback,
        ApplySummary, ManifestFileEntry, MAX_APPLY_ROLLBACK_DIR_CAPABILITIES,
        MULTI_TENANT_ORIGIN_MIN_NOFILE,
    };
    use crate::config::ServerConfig;
    use crate::error::OriginError;
    use crate::safe_fs::{create_new_content_options, open_workspace_root};
    use crate::workspace_fs::WorkspaceDir;
    use cap_fs_ext::DirExt;
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use reqwest::Url;
    use std::io::{Cursor, Write};
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::process::Command;
    use std::time::Duration;
    use tempfile::TempDir;
    use uuid::Uuid;
    use zip::write::{FileOptions, ZipWriter};

    fn test_config(
        workspace: &TempDir,
        staging: Option<&TempDir>,
        max_archive_bytes: u64,
    ) -> ServerConfig {
        ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: workspace.path().to_path_buf(),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "instafy-origin".to_string(),
            git_author_email: "origin@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 54332,
            controller_base_url: Url::parse("http://127.0.0.1:8788").unwrap(),
            controller_internal_token: None,
            jwks_url: Url::parse("http://127.0.0.1:8788/.well-known/jwks.json").unwrap(),
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes,
            staging_base: staging.map(|dir| dir.path().to_path_buf()),
            multi_tenant: false,
        }
    }

    fn manifest(config: &ServerConfig, files: &[&str], deletes: &[&str]) -> ApplyManifest {
        ApplyManifest {
            project_id: Some(config.project_id.to_string()),
            lease_id: None,
            files: files
                .iter()
                .map(|path| ManifestFileEntry {
                    path: (*path).to_string(),
                    size: None,
                    encoding: None,
                })
                .collect(),
            deletes: deletes.iter().map(|path| (*path).to_string()).collect(),
            generated_at: None,
            source_device_id: None,
            auto_commit_after_apply: false,
            commit_message: None,
            idempotency_key: None,
            request_fingerprint: None,
        }
    }

    fn manifest_with(files: &[&str], deletes: &[&str]) -> ApplyManifest {
        ApplyManifest {
            project_id: None,
            lease_id: None,
            files: files
                .iter()
                .map(|path| ManifestFileEntry {
                    path: (*path).to_string(),
                    size: None,
                    encoding: None,
                })
                .collect(),
            deletes: deletes.iter().map(|path| (*path).to_string()).collect(),
            generated_at: None,
            source_device_id: None,
            auto_commit_after_apply: false,
            commit_message: None,
            idempotency_key: None,
            request_fingerprint: None,
        }
    }

    fn zip_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, bytes) in entries {
            writer
                .start_file(*path, FileOptions::<()>::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[cfg(unix)]
    fn archive_with(path: &str, contents: &[u8]) -> Vec<u8> {
        zip_archive(&[(path, contents)])
    }

    /// Drive the lenient `WorkspaceDir`-backed pipeline the collaboration
    /// routes use, mirroring how `apply_changes` behaved before the
    /// transactional import pipeline became the path-based default.
    fn apply_changes_via_workspace_dir(
        config: &ServerConfig,
        workspace_root: &std::path::Path,
        manifest: ApplyManifest,
        archive_bytes: &[u8],
    ) -> Result<ApplySummary, OriginError> {
        let workspace = WorkspaceDir::open(workspace_root).expect("open workspace dir");
        apply_changes_in(config, &workspace, manifest, archive_bytes)
    }

    #[test]
    fn normalize_relative_path_allows_simple_relative_segments() {
        assert_eq!(
            normalize_relative_path("src/components/Button.tsx"),
            Some("src/components/Button.tsx".to_string())
        );
        assert_eq!(
            normalize_relative_path("./styles/theme.css"),
            Some("styles/theme.css".to_string())
        );
    }

    #[test]
    fn normalize_relative_path_rejects_traversal_and_absolute_forms() {
        assert_eq!(normalize_relative_path(""), None);
        assert_eq!(normalize_relative_path(".."), None);
        assert_eq!(normalize_relative_path("../secrets.env"), None);
        assert_eq!(normalize_relative_path("/etc/passwd"), None);
        assert_eq!(normalize_relative_path("./../../env"), None);
        assert_eq!(normalize_relative_path("assets/../env/.env"), None);
    }

    #[test]
    fn apply_manifest_parses_optional_idempotency_fields() {
        let without_key: ApplyManifest = serde_json::from_value(serde_json::json!({
            "files": [],
            "deletes": []
        }))
        .unwrap();
        assert_eq!(without_key.idempotency_key, None);
        assert_eq!(without_key.request_fingerprint, None);

        let with_key: ApplyManifest = serde_json::from_value(serde_json::json!({
            "files": [],
            "deletes": [],
            "idempotencyKey": "github-import-v1:stable_key-1",
            "requestFingerprint": "sha256:abc123"
        }))
        .unwrap();
        assert_eq!(
            with_key.idempotency_key.as_deref(),
            Some("github-import-v1:stable_key-1")
        );
        assert_eq!(
            with_key.request_fingerprint.as_deref(),
            Some("sha256:abc123")
        );
    }

    #[test]
    fn apply_rejects_invalid_reserved_duplicate_case_and_prefix_destinations() {
        let workspace = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);
        std::fs::write(workspace.path().join("sentinel"), b"unchanged").unwrap();

        let cases = [
            manifest(&config, &["../outside"], &[]),
            manifest(&config, &[".instafy/receipt"], &[]),
            manifest(&config, &[".INSTAFY/receipt"], &[]),
            manifest(&config, &["src/.GIT/config"], &[]),
            manifest(&config, &["same", "same"], &[]),
            manifest(&config, &["Case.txt", "case.txt"], &[]),
            manifest(&config, &["caf\u{e9}.txt", "cafe\u{301}.txt"], &[]),
            manifest(&config, &["a", "a/b"], &[]),
            manifest(&config, &["a", "a/b"], &["unrelated"]),
            manifest(&config, &["tree/file"], &["tree"]),
            manifest(&config, &["same"], &["same"]),
            manifest(&config, &["trailing."], &[]),
            manifest(&config, &["trailing "], &[]),
            manifest(&config, &["stream:ads"], &[]),
            manifest(&config, &["CON.txt"], &[]),
            manifest(&config, &["dir\\child"], &[]),
        ];
        for invalid in cases {
            assert!(apply_changes(&config, workspace.path(), invalid, &[]).is_err());
            assert_eq!(
                std::fs::read(workspace.path().join("sentinel")).unwrap(),
                b"unchanged"
            );
            assert!(!workspace.path().join("a").exists());
            assert!(!workspace.path().join("same").exists());
            assert!(!workspace.path().join("tree").exists());
        }
    }

    #[test]
    fn apply_rejects_missing_and_oversized_archive_members() {
        let workspace = TempDir::new().unwrap();
        let mut config = test_config(&workspace, None, 1024 * 1024);

        let missing = zip_archive(&[]);
        assert!(apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &["missing.txt"], &[]),
            &missing,
        )
        .is_err());

        config.max_archive_bytes = 4;
        let oversized = zip_archive(&[("large.txt", b"12345")]);
        assert!(apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &["large.txt"], &[]),
            &oversized,
        )
        .is_err());
        assert!(!workspace.path().join("large.txt").exists());

        config.max_archive_bytes = 1024;
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "bomb.txt",
                FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(&vec![b'x'; 4097]).unwrap();
        let bomb = writer.finish().unwrap().into_inner();
        assert!(bomb.len() < config.max_archive_bytes as usize);
        assert!(apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &["bomb.txt"], &[]),
            &bomb,
        )
        .is_err());
        assert!(!workspace.path().join("bomb.txt").exists());
    }

    #[test]
    fn failed_second_install_rolls_back_every_touched_destination() {
        let workspace = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("first.txt"), b"old-first").unwrap();
        std::fs::write(workspace.path().join("second.txt"), b"old-second").unwrap();
        let workspace_dir = open_workspace_root(workspace.path()).unwrap();
        let staging_dir = Dir::open_ambient_dir(staging.path(), ambient_authority()).unwrap();
        let mut first = staging_dir
            .open_with("entry-1", &create_new_content_options())
            .unwrap();
        first.write_all(b"new-first").unwrap();
        first.sync_all().unwrap();

        let paths = ["first.txt", "second.txt"];
        let mut rollback =
            ApplyRollback::capture(&workspace_dir, &paths, &paths, Uuid::new_v4()).unwrap();
        let staged = vec![
            ("first.txt".to_string(), "entry-1".into()),
            ("second.txt".to_string(), "missing-entry".into()),
        ];
        assert!(install_staged_files(&staging_dir, &staged, &rollback).is_err());
        rollback.rollback().unwrap();
        assert_eq!(
            std::fs::read(workspace.path().join("first.txt")).unwrap(),
            b"old-first"
        );
        assert_eq!(
            std::fs::read(workspace.path().join("second.txt")).unwrap(),
            b"old-second"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rollback_restores_through_anchored_parent_after_ancestor_swap() {
        let workspace = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(workspace.path().join("safe")).unwrap();
        std::fs::write(workspace.path().join("safe/file.txt"), b"original").unwrap();
        std::fs::write(outside.path().join("sentinel.txt"), b"outside").unwrap();
        std::fs::write(staging.path().join("entry"), b"partial-apply").unwrap();
        let workspace_dir = open_workspace_root(workspace.path()).unwrap();
        let staging_dir = Dir::open_ambient_dir(staging.path(), ambient_authority()).unwrap();
        let paths = ["safe/file.txt"];
        let mut rollback =
            ApplyRollback::capture(&workspace_dir, &paths, &paths, Uuid::new_v4()).unwrap();

        std::fs::rename(
            workspace.path().join("safe"),
            workspace.path().join("moved-safe"),
        )
        .unwrap();
        symlink(outside.path(), workspace.path().join("safe")).unwrap();
        {
            let target = &rollback.targets[0];
            install_staged_file_at_parent(
                &staging_dir,
                "safe/file.txt",
                std::ffi::OsStr::new("entry"),
                &rollback.parents[target.parent_index],
                &target.leaf,
            )
            .unwrap();
        }

        rollback.rollback().unwrap();

        assert_eq!(
            std::fs::read(workspace.path().join("moved-safe/file.txt")).unwrap(),
            b"original"
        );
        assert_eq!(
            std::fs::read(outside.path().join("sentinel.txt")).unwrap(),
            b"outside"
        );
        assert!(!outside.path().join("file.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_install_after_ancestor_swap_rolls_back_the_anchored_tree() {
        let workspace = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        std::fs::create_dir(workspace.path().join("safe")).unwrap();
        std::fs::write(workspace.path().join("safe/first.txt"), b"old-first").unwrap();
        std::fs::write(workspace.path().join("safe/second.txt"), b"old-second").unwrap();
        std::fs::write(staging.path().join("entry-1"), b"new-first").unwrap();
        let workspace_dir = open_workspace_root(workspace.path()).unwrap();
        let staging_dir = Dir::open_ambient_dir(staging.path(), ambient_authority()).unwrap();
        let paths = ["safe/first.txt", "safe/second.txt"];
        let mut rollback =
            ApplyRollback::capture(&workspace_dir, &paths, &paths, Uuid::new_v4()).unwrap();

        std::fs::rename(
            workspace.path().join("safe"),
            workspace.path().join("moved-safe"),
        )
        .unwrap();
        std::fs::create_dir(workspace.path().join("safe")).unwrap();
        std::fs::write(workspace.path().join("safe/sentinel.txt"), b"replacement").unwrap();

        let staged = vec![
            ("safe/first.txt".to_string(), "entry-1".into()),
            ("safe/second.txt".to_string(), "missing-entry".into()),
        ];
        assert!(install_staged_files(&staging_dir, &staged, &rollback).is_err());
        rollback.rollback().unwrap();

        assert_eq!(
            std::fs::read(workspace.path().join("moved-safe/first.txt")).unwrap(),
            b"old-first"
        );
        assert_eq!(
            std::fs::read(workspace.path().join("moved-safe/second.txt")).unwrap(),
            b"old-second"
        );
        assert_eq!(
            std::fs::read(workspace.path().join("safe/sentinel.txt")).unwrap(),
            b"replacement"
        );
        assert!(!workspace.path().join("safe/first.txt").exists());
        assert!(!workspace.path().join("safe/second.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn missing_ancestor_swap_between_installs_leaves_no_applied_content() {
        let workspace = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        std::fs::write(staging.path().join("entry-1"), b"new-first").unwrap();
        std::fs::write(staging.path().join("entry-2"), b"new-second").unwrap();
        let workspace_dir = open_workspace_root(workspace.path()).unwrap();
        let staging_dir = Dir::open_ambient_dir(staging.path(), ambient_authority()).unwrap();
        let paths = ["new/first.txt", "new/nested/second.txt"];
        let mut rollback =
            ApplyRollback::capture(&workspace_dir, &paths, &paths, Uuid::new_v4()).unwrap();
        assert_eq!(rollback.parents.len(), 3, "root, new, and new/nested");

        let staged = vec![
            ("new/first.txt".to_string(), "entry-1".into()),
            ("new/nested/second.txt".to_string(), "entry-2".into()),
        ];
        let install_error =
            install_staged_files_with_hook(&staging_dir, &staged, &rollback, |installed_index| {
                if installed_index == 0 {
                    std::fs::rename(
                        workspace.path().join("new"),
                        workspace.path().join("moved-new"),
                    )
                    .unwrap();
                    std::fs::create_dir(workspace.path().join("new")).unwrap();
                    std::fs::write(workspace.path().join("new/replacement.txt"), b"replacement")
                        .unwrap();
                    return Ok(());
                }

                assert_eq!(
                    std::fs::read(workspace.path().join("moved-new/nested/second.txt")).unwrap(),
                    b"new-second",
                    "the second install must use the retained initially-missing parent"
                );
                assert!(!workspace.path().join("new/nested/second.txt").exists());
                Err(OriginError::internal("forced post-install failure"))
            })
            .expect_err("the test hook must force rollback after the second install");
        assert!(matches!(install_error, OriginError::Internal(_)));

        rollback.rollback().unwrap();

        assert!(
            workspace.path().join("moved-new").is_dir(),
            "a concurrently renamed top-level directory has no discoverable unlink name"
        );
        assert!(
            std::fs::read_dir(workspace.path().join("moved-new"))
                .unwrap()
                .next()
                .is_none(),
            "all applied files and nested apply-created directories must be cleaned"
        );
        assert!(
            !workspace.path().join("new").exists(),
            "the replacement at the original rollback path must be removed"
        );
    }

    #[test]
    fn delete_only_missing_directory_fanout_remains_an_allowed_noop() {
        let workspace = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);
        let delete_paths = (0..1_100)
            .map(|index| format!("stale/dir-{index:04}/file.txt"))
            .collect::<Vec<_>>();
        let delete_refs = delete_paths.iter().map(String::as_str).collect::<Vec<_>>();

        let summary = apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &[], &delete_refs),
            &zip_archive(&[]),
        )
        .expect("missing delete-only tails must not consume directory capabilities");

        assert_eq!(summary.deleted_paths.len(), delete_paths.len());
        assert!(!workspace.path().join("stale").exists());
    }

    #[test]
    fn rollback_descriptor_budget_tracks_the_process_contract() {
        assert_eq!(
            apply_rollback_dir_capability_limit_for_nofile(None),
            MAX_APPLY_ROLLBACK_DIR_CAPABILITIES
        );
        assert_eq!(
            apply_rollback_dir_capability_limit_for_nofile(Some(8192)),
            MAX_APPLY_ROLLBACK_DIR_CAPABILITIES
        );
        assert_eq!(
            apply_rollback_dir_capability_limit_for_nofile(Some(1024)),
            768
        );
        assert_eq!(
            apply_rollback_dir_capability_limit_for_nofile(Some(384)),
            256
        );
        assert!(validate_multi_tenant_apply_fd_contract_for_nofile(Some(
            MULTI_TENANT_ORIGIN_MIN_NOFILE - 1
        ))
        .is_err());
        assert!(validate_multi_tenant_apply_fd_contract_for_nofile(Some(
            MULTI_TENANT_ORIGIN_MIN_NOFILE
        ))
        .is_ok());
    }

    #[test]
    fn install_parent_capability_boundary_is_inclusive() {
        const TEST_LIMIT: usize = 300;
        let exact_paths = (0..TEST_LIMIT - 2)
            .map(|index| format!("fanout/dir-{index:04}/file.txt"))
            .collect::<Vec<_>>();
        let exact_refs = exact_paths.iter().map(String::as_str).collect::<Vec<_>>();
        validate_install_parent_capability_limit(&exact_refs, TEST_LIMIT)
            .expect("root plus every unique parent at the exact limit must be accepted");

        let mut over_paths = exact_paths;
        over_paths.push("fanout/one-more/file.txt".to_string());
        let over_refs = over_paths.iter().map(String::as_str).collect::<Vec<_>>();
        let error = validate_install_parent_capability_limit(&over_refs, TEST_LIMIT)
            .expect_err("one parent over the exact limit must be rejected");
        assert!(matches!(
            error,
            OriginError::BadRequest(message)
                if message.contains("rollback directory capability limit (300)")
        ));
    }

    #[test]
    fn applies_directory_rich_repo_above_the_legacy_256_parent_limit() {
        const FILE_COUNT: usize = 360;
        let workspace = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);
        assert!(
            apply_rollback_dir_capability_limit() > FILE_COUNT + 1,
            "the test environment must satisfy the repo-scale descriptor contract"
        );

        let paths = (0..FILE_COUNT)
            .map(|index| format!("repo/dir-{index:04}/file.txt"))
            .collect::<Vec<_>>();
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (index, path) in paths.iter().enumerate() {
            writer
                .start_file(path.as_str(), FileOptions::<()>::default())
                .unwrap();
            writer.write_all(index.to_string().as_bytes()).unwrap();
        }
        let archive = writer.finish().unwrap().into_inner();
        let path_refs = paths.iter().map(String::as_str).collect::<Vec<_>>();

        let summary = apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &path_refs, &[]),
            &archive,
        )
        .expect("a normal directory-rich repository must apply in one transaction");

        assert_eq!(summary.file_count, FILE_COUNT);
        assert_eq!(summary.applied_paths.len(), FILE_COUNT);
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("repo/dir-0359/file.txt")).unwrap(),
            "359"
        );
    }

    #[test]
    fn over_limit_directory_rich_apply_is_rejected_before_workspace_mutation() {
        let workspace = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);
        std::fs::write(workspace.path().join("sentinel.txt"), "unchanged").unwrap();
        let capability_limit = apply_rollback_dir_capability_limit();
        let paths = (0..capability_limit)
            .map(|index| format!("fanout/dir-{index:04}/file.txt"))
            .collect::<Vec<_>>();
        let path_refs = paths.iter().map(String::as_str).collect::<Vec<_>>();

        let error = apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &path_refs, &[]),
            &zip_archive(&[]),
        )
        .expect_err("an over-limit directory fan-out must fail before archive staging");

        assert!(matches!(
            error,
            OriginError::BadRequest(message)
                if message.contains(&format!("rollback directory capability limit ({capability_limit})"))
        ));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("sentinel.txt")).unwrap(),
            "unchanged"
        );
        assert!(!workspace.path().join("fanout").exists());
        assert!(
            !workspace.path().join(".instafy").exists(),
            "capability admission must run before workspace-local staging is created"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rollback_directory_fanout_is_rejected_before_mutation_under_low_fd_limit() {
        const CHILD_ENV: &str = "INSTAFY_LOW_FD_ROLLBACK_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            let executable = std::env::current_exe().expect("current test executable");
            let status = Command::new("/bin/sh")
                .args([
                    "-c",
                    "ulimit -n 384 && exec \"$@\"",
                    "instafy-low-fd",
                ])
                .arg(executable)
                .args([
                    "--exact",
                    "apply::tests::rollback_directory_fanout_is_rejected_before_mutation_under_low_fd_limit",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .status()
                .expect("run low-descriptor child test");
            assert!(status.success(), "low-descriptor child test failed");
            return;
        }

        let workspace = TempDir::new().unwrap();
        let paths = (0..1_100)
            .map(|index| {
                let directory = format!("fanout/dir-{index:04}");
                std::fs::create_dir_all(workspace.path().join(&directory)).unwrap();
                format!("{directory}/file.txt")
            })
            .collect::<Vec<_>>();
        std::fs::write(workspace.path().join("sentinel.txt"), "unchanged").unwrap();
        let workspace_dir = open_workspace_root(workspace.path()).unwrap();
        let path_refs = paths.iter().map(String::as_str).collect::<Vec<_>>();

        let error =
            match ApplyRollback::capture(&workspace_dir, &path_refs, &path_refs, Uuid::new_v4()) {
                Ok(_) => panic!("directory fan-out must be rejected"),
                Err(error) => error,
            };

        assert!(matches!(
            error,
            OriginError::BadRequest(message)
                if message.contains("rollback directory capability limit (256)")
        ));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("sentinel.txt")).unwrap(),
            "unchanged"
        );
        assert!(!workspace.path().join(".instafy").exists());

        let missing_workspace = TempDir::new().unwrap();
        let missing_paths = (0..1_100)
            .map(|index| format!("missing/dir-{index:04}/file.txt"))
            .collect::<Vec<_>>();
        let missing_refs = missing_paths.iter().map(String::as_str).collect::<Vec<_>>();
        let missing_workspace_dir = open_workspace_root(missing_workspace.path()).unwrap();
        let missing_error = match ApplyRollback::capture(
            &missing_workspace_dir,
            &missing_refs,
            &missing_refs,
            Uuid::new_v4(),
        ) {
            Ok(_) => panic!("missing directory fan-out must be rejected before creation"),
            Err(error) => error,
        };
        assert!(matches!(
            missing_error,
            OriginError::BadRequest(message)
                if message.contains("rollback directory capability limit (256)")
        ));
        assert!(!missing_workspace.path().join("missing").exists());
        assert!(!missing_workspace.path().join(".instafy").exists());

        let flat_workspace = TempDir::new().unwrap();
        std::fs::create_dir_all(flat_workspace.path().join("playwright/large-dirty")).unwrap();
        let flat_paths = (0..1_100)
            .map(|index| format!("playwright/large-dirty/file-{index:04}.txt"))
            .collect::<Vec<_>>();
        let flat_path_refs = flat_paths.iter().map(String::as_str).collect::<Vec<_>>();
        let flat_workspace_dir = open_workspace_root(flat_workspace.path()).unwrap();

        let flat_rollback = ApplyRollback::capture(
            &flat_workspace_dir,
            &flat_path_refs,
            &flat_path_refs,
            Uuid::new_v4(),
        )
        .expect("a 1,100-file flat batch must remain supported");

        assert_eq!(flat_rollback.targets.len(), flat_paths.len());
        assert_eq!(flat_rollback.parents.len(), 3);
    }

    #[test]
    fn installs_more_than_one_thousand_flat_files_with_bounded_parent_descriptors() {
        let workspace = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        std::fs::create_dir_all(workspace.path().join("playwright/large-dirty")).unwrap();
        let workspace_dir = open_workspace_root(workspace.path()).unwrap();
        let staging_dir = Dir::open_ambient_dir(staging.path(), ambient_authority()).unwrap();
        let staged = (0..1_100)
            .map(|index| {
                let staging_name = format!("entry-{index:08}");
                std::fs::write(staging.path().join(&staging_name), index.to_string()).unwrap();
                (
                    format!("playwright/large-dirty/file-{index:04}.txt"),
                    staging_name.into(),
                )
            })
            .collect::<Vec<_>>();

        let paths = staged
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>();
        let rollback =
            ApplyRollback::capture(&workspace_dir, &paths, &paths, Uuid::new_v4()).unwrap();
        assert_eq!(rollback.parents.len(), 3);

        install_staged_files(&staging_dir, &staged, &rollback).expect("install flat batch");
        rollback.finish();

        assert_eq!(
            std::fs::read_to_string(
                workspace
                    .path()
                    .join("playwright/large-dirty/file-1099.txt")
            )
            .unwrap(),
            "1099"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_write_and_delete_ancestors_fail_without_escape() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);
        std::fs::write(outside.path().join("secret"), b"outside").unwrap();
        symlink(outside.path(), workspace.path().join("link")).unwrap();

        let archive = zip_archive(&[("link/new.txt", b"pwned")]);
        assert!(apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &["link/new.txt"], &[]),
            &archive,
        )
        .is_err());
        assert!(!outside.path().join("new.txt").exists());

        let empty = zip_archive(&[]);
        assert!(apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &[], &["link/secret"]),
            &empty,
        )
        .is_err());
        assert_eq!(
            std::fs::read(outside.path().join("secret")).unwrap(),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn leaf_symlinks_are_replaced_or_deleted_without_following() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);
        let outside_file = outside.path().join("target.txt");
        std::fs::write(&outside_file, b"outside").unwrap();
        symlink(&outside_file, workspace.path().join("write-link")).unwrap();
        symlink(&outside_file, workspace.path().join("delete-link")).unwrap();

        let archive = zip_archive(&[("write-link", b"workspace")]);
        apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &["write-link"], &["delete-link"]),
            &archive,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(workspace.path().join("write-link")).unwrap(),
            b"workspace"
        );
        assert!(!workspace.path().join("delete-link").exists());
        assert_eq!(std::fs::read(outside_file).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_default_staging_directory_fails_closed() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);
        std::fs::create_dir(workspace.path().join(".instafy")).unwrap();
        symlink(
            outside.path(),
            workspace.path().join(".instafy/origin-staging"),
        )
        .unwrap();
        let archive = zip_archive(&[("file.txt", b"content")]);
        assert!(apply_changes(
            &config,
            workspace.path(),
            manifest(&config, &["file.txt"], &[]),
            &archive,
        )
        .is_err());
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
        assert!(!workspace.path().join("file.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn held_destination_capability_ignores_ancestor_symlink_swap() {
        use super::install_staged_file_at_parent;

        let workspace = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(workspace.path().join("safe")).unwrap();
        let workspace_dir = open_workspace_root(workspace.path()).unwrap();
        let held_parent = workspace_dir.open_dir_nofollow("safe").unwrap();
        std::fs::rename(
            workspace.path().join("safe"),
            workspace.path().join("moved-safe"),
        )
        .unwrap();
        symlink(outside.path(), workspace.path().join("safe")).unwrap();

        let staging_dir = Dir::open_ambient_dir(staging.path(), ambient_authority()).unwrap();
        let mut staged = staging_dir
            .open_with("entry", &create_new_content_options())
            .unwrap();
        staged.write_all(b"anchored").unwrap();
        staged.sync_all().unwrap();
        install_staged_file_at_parent(
            &staging_dir,
            "safe/file.txt",
            std::ffi::OsStr::new("entry"),
            &held_parent,
            std::ffi::OsStr::new("file.txt"),
        )
        .unwrap();

        assert_eq!(
            std::fs::read(workspace.path().join("moved-safe/file.txt")).unwrap(),
            b"anchored"
        );
        assert!(!outside.path().join("file.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn apply_changes_restores_executable_archive_mode() {
        let workspace = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        let config = test_config(&workspace, Some(&staging), 1024 * 1024);

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "tools/run",
                FileOptions::<()>::default().unix_permissions(0o100755),
            )
            .unwrap();
        writer.write_all(b"#!/usr/bin/env bash\ntrue\n").unwrap();
        let archive = writer.finish().unwrap().into_inner();

        apply_changes(
            &config,
            workspace.path(),
            ApplyManifest {
                project_id: Some(config.project_id.to_string()),
                lease_id: None,
                files: vec![ManifestFileEntry {
                    path: "tools/run".to_string(),
                    size: None,
                    encoding: None,
                }],
                deletes: vec![],
                generated_at: None,
                source_device_id: None,
                auto_commit_after_apply: false,
                commit_message: None,
                idempotency_key: None,
                request_fingerprint: None,
            },
            &archive,
        )
        .unwrap();

        let mode = std::fs::metadata(workspace.path().join("tools/run"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
    }

    #[cfg(unix)]
    #[test]
    fn apply_changes_in_restores_executable_archive_mode() {
        let workspace = TempDir::new().unwrap();
        let config = test_config(&workspace, None, 1024 * 1024);

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "tools/run",
                FileOptions::<()>::default().unix_permissions(0o100755),
            )
            .unwrap();
        writer.write_all(b"#!/usr/bin/env bash\ntrue\n").unwrap();
        let archive = writer.finish().unwrap().into_inner();

        apply_changes_via_workspace_dir(
            &config,
            workspace.path(),
            manifest_with(&["tools/run"], &[]),
            &archive,
        )
        .unwrap();

        let mode = std::fs::metadata(workspace.path().join("tools/run"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
    }

    #[cfg(unix)]
    #[test]
    fn apply_never_writes_or_deletes_through_an_outbound_symlink_parent() {
        let workspace = TempDir::new().expect("workspace");
        let outside = TempDir::new().expect("outside");
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, b"outside").expect("outside file");
        symlink(outside.path(), workspace.path().join("escape")).expect("outbound link");
        let config = test_config(&workspace, None, 1024 * 1024);

        let archive = archive_with("escape/secret.txt", b"overwritten");
        assert!(apply_changes_via_workspace_dir(
            &config,
            workspace.path(),
            manifest_with(&["escape/secret.txt"], &[]),
            &archive,
        )
        .is_err());
        assert_eq!(std::fs::read(&outside_file).unwrap(), b"outside");

        let empty = ZipWriter::new(Cursor::new(Vec::new()))
            .finish()
            .unwrap()
            .into_inner();
        apply_changes_via_workspace_dir(
            &config,
            workspace.path(),
            manifest_with(&[], &["escape/secret.txt"]),
            &empty,
        )
        .expect("blocked delete remains a contained no-op");
        assert_eq!(std::fs::read(&outside_file).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn apply_replaces_a_final_symlink_without_touching_its_target() {
        let workspace = TempDir::new().expect("workspace");
        let outside = TempDir::new().expect("outside");
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, b"outside").expect("outside file");
        symlink(&outside_file, workspace.path().join("replace-me")).expect("final link");
        let config = test_config(&workspace, None, 1024 * 1024);
        let archive = archive_with("replace-me", b"inside");

        apply_changes_via_workspace_dir(
            &config,
            workspace.path(),
            manifest_with(&["replace-me"], &[]),
            &archive,
        )
        .expect("replace final link");

        assert_eq!(
            std::fs::read(workspace.path().join("replace-me")).unwrap(),
            b"inside"
        );
        assert_eq!(std::fs::read(&outside_file).unwrap(), b"outside");
    }

    #[test]
    fn apply_bounds_total_expanded_archive_bytes() {
        let workspace = TempDir::new().expect("workspace");
        let max_archive_bytes = 1024;
        let config = test_config(&workspace, None, max_archive_bytes);
        let contents = vec![b'x'; 32 * 1024];
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "large.txt",
                FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(&contents).unwrap();
        let archive = writer.finish().unwrap().into_inner();
        assert!(archive.len() < max_archive_bytes as usize);

        let error = apply_changes_via_workspace_dir(
            &config,
            workspace.path(),
            manifest_with(&["large.txt"], &[]),
            &archive,
        )
        .expect_err("expanded payload must be rejected");
        assert!(error
            .to_string()
            .contains("expanded archive exceeds size limit"));
        assert!(!workspace.path().join("large.txt").exists());
    }
}
