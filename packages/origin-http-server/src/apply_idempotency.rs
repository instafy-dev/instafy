use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::OriginError;
use crate::paths::ORIGIN_APPLY_RECEIPTS_DIR;
use crate::safe_fs::{
    create_new_private_options, open_or_create_child, open_workspace_root, read_nofollow_options,
    read_write_nofollow_options, sync_dir,
};

const APPLY_IDEMPOTENCY_VALUE_MAX_LEN: usize = 256;
const APPLY_RECEIPT_NAMESPACE_PREFIX: &str = "instafy:origin-apply-receipt:v1:";
// The controller allows an origin apply to run for 15 minutes. A four-times
// larger recovery window avoids reclaiming work merely because the caller
// timed out, while ensuring a crashed process cannot strand a key forever.
const APPLY_PENDING_CLAIM_TTL: Duration = Duration::from_secs(60 * 60);
#[cfg(not(test))]
const MAX_APPLY_RECEIPTS_PER_WORKSPACE: usize = 10_000;
#[cfg(test)]
const MAX_APPLY_RECEIPTS_PER_WORKSPACE: usize = 64;
const APPLY_RECEIPT_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ApplyReceiptStatus {
    Pending,
    Succeeded,
}

/// The on-disk shape intentionally keeps every new field optional so receipts
/// written before write-ahead claims were introduced remain readable.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredApplyIdempotencyReceipt {
    idempotency_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<ApplyReceiptStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claim_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claim_created_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claim_expires_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_rev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bytes_written: Option<u64>,
}

#[derive(Debug)]
pub struct ApplyIdempotencyClaim {
    idempotency_key: String,
    claim_id: String,
    request_fingerprint: Option<String>,
    receipt_dir: Dir,
    receipt_name: OsString,
    _receipt_lock: ApplyReceiptLock,
}

#[derive(Debug)]
struct ApplyReceiptLock {
    file: File,
}

impl Drop for ApplyReceiptLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ApplyIdempotencySuccess {
    pub rev: String,
    pub base_rev: Option<String>,
    pub file_count: Option<usize>,
    pub bytes_written: Option<u64>,
}

#[derive(Debug)]
pub enum ApplyIdempotencyClaimOutcome {
    Acquired(ApplyIdempotencyClaim),
    Pending,
    Succeeded(ApplyIdempotencySuccess),
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum ApplyIdempotencyLookup {
    Pending,
    Succeeded(ApplyIdempotencySuccess),
}

pub fn normalize_apply_idempotency_key(value: Option<&str>) -> Result<Option<String>, OriginError> {
    normalize_transport_value(value, "idempotencyKey")
}

pub fn normalize_apply_request_fingerprint(
    value: Option<&str>,
) -> Result<Option<String>, OriginError> {
    normalize_transport_value(value, "requestFingerprint")
}

fn normalize_transport_value(
    value: Option<&str>,
    field_name: &str,
) -> Result<Option<String>, OriginError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > APPLY_IDEMPOTENCY_VALUE_MAX_LEN {
        return Err(OriginError::bad_request(format!(
            "{field_name} is too long (max {APPLY_IDEMPOTENCY_VALUE_MAX_LEN} chars)"
        )));
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return Err(OriginError::bad_request(format!(
            "{field_name} must contain only letters, numbers, ':', '.', '_' or '-'"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

pub fn apply_receipt_relative_path(idempotency_key: &str) -> PathBuf {
    let namespace_name = format!("{APPLY_RECEIPT_NAMESPACE_PREFIX}{idempotency_key}");
    let receipt_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, namespace_name.as_bytes());
    PathBuf::from(ORIGIN_APPLY_RECEIPTS_DIR).join(format!("{receipt_id}.json"))
}

pub fn claim_apply_idempotency(
    workspace_root: &Path,
    idempotency_key: &str,
    request_fingerprint: Option<&str>,
) -> Result<ApplyIdempotencyClaimOutcome, OriginError> {
    claim_apply_idempotency_at(
        workspace_root,
        idempotency_key,
        request_fingerprint,
        Utc::now(),
    )
}

/// Inspect a durable apply receipt without claiming or recovering it. A held
/// per-receipt lock means the owning apply may still be writing its terminal
/// receipt, so callers conservatively observe `Pending` until that lock is
/// released. Status lookup deliberately never performs stale recovery.
pub fn lookup_apply_idempotency(
    workspace_root: &Path,
    idempotency_key: &str,
    request_fingerprint: Option<&str>,
) -> Result<Option<ApplyIdempotencyLookup>, OriginError> {
    let normalized_key = normalize_apply_idempotency_key(Some(idempotency_key))?
        .ok_or_else(|| OriginError::bad_request("idempotencyKey is required"))?;
    let normalized_fingerprint = normalize_apply_request_fingerprint(request_fingerprint)?;
    let Some(receipt_dir) = open_existing_receipt_dir(workspace_root)? else {
        return Ok(None);
    };
    let receipt_name = apply_receipt_file_name(&normalized_key);
    let _receipt_lock = match try_acquire_existing_receipt_lock(&receipt_dir, &receipt_name)? {
        ExistingReceiptLock::Busy => return Ok(Some(ApplyIdempotencyLookup::Pending)),
        ExistingReceiptLock::Acquired(lock) => Some(lock),
        ExistingReceiptLock::Missing => None,
    };
    let Some(receipt) = read_optional_stored_receipt(&receipt_dir, &receipt_name, &normalized_key)?
    else {
        return Ok(None);
    };

    let is_legacy_success = receipt.status.is_none();
    if !is_legacy_success
        && receipt.request_fingerprint.as_deref() != normalized_fingerprint.as_deref()
    {
        return Err(OriginError::conflict(
            "idempotencyKey was already used with a different requestFingerprint",
        ));
    }

    match receipt.status {
        Some(ApplyReceiptStatus::Pending) => Ok(Some(ApplyIdempotencyLookup::Pending)),
        Some(ApplyReceiptStatus::Succeeded) | None => {
            let rev = receipt
                .rev
                .filter(|rev| !rev.trim().is_empty())
                .ok_or_else(|| {
                    OriginError::internal("succeeded apply receipt is missing its revision")
                })?;
            Ok(Some(ApplyIdempotencyLookup::Succeeded(
                ApplyIdempotencySuccess {
                    rev,
                    base_rev: receipt.base_rev,
                    file_count: receipt.file_count,
                    bytes_written: receipt.bytes_written,
                },
            )))
        }
    }
}

fn claim_apply_idempotency_at(
    workspace_root: &Path,
    idempotency_key: &str,
    request_fingerprint: Option<&str>,
    now: DateTime<Utc>,
) -> Result<ApplyIdempotencyClaimOutcome, OriginError> {
    let normalized_key = normalize_apply_idempotency_key(Some(idempotency_key))?
        .ok_or_else(|| OriginError::bad_request("idempotencyKey is required"))?;
    let normalized_fingerprint = normalize_apply_request_fingerprint(request_fingerprint)?;
    let receipt_dir = open_receipt_dir(workspace_root)?;
    let receipt_name = apply_receipt_file_name(&normalized_key);
    let Some(receipt_lock) = try_acquire_receipt_lock(&receipt_dir, &receipt_name)? else {
        return Ok(ApplyIdempotencyClaimOutcome::Pending);
    };

    if let Some(existing) =
        read_optional_stored_receipt(&receipt_dir, &receipt_name, &normalized_key)?
    {
        return classify_existing_receipt(
            existing,
            receipt_dir,
            receipt_name,
            &normalized_key,
            normalized_fingerprint.as_deref(),
            now,
            receipt_lock,
        );
    }

    // Serialize namespace accounting across processes. Terminal receipts are
    // retained for replay, but a hard cap plus age-based eviction prevents an
    // fs.write token from growing metadata inodes without bound.
    let _maintenance_lock = acquire_receipt_maintenance_lock(&receipt_dir)?;
    if let Err(error) = ensure_receipt_capacity(&receipt_dir, now) {
        let _ = remove_receipt_lock(&receipt_dir, &receipt_name);
        return Err(error);
    }

    let (claim, stored) = new_pending_claim(
        &normalized_key,
        normalized_fingerprint.as_deref(),
        now,
        receipt_dir,
        receipt_name,
        receipt_lock,
    );
    if persist_new_receipt(&claim.receipt_dir, &claim.receipt_name, &stored)? {
        return Ok(ApplyIdempotencyClaimOutcome::Acquired(claim));
    }

    // A process that predates the lock protocol may have won the no-clobber
    // create. Drop our unused claim/lock only after re-reading under the lock.
    let ApplyIdempotencyClaim {
        receipt_dir,
        receipt_name,
        _receipt_lock: receipt_lock,
        ..
    } = claim;
    let existing = read_stored_receipt(&receipt_dir, &receipt_name, &normalized_key)?;
    classify_existing_receipt(
        existing,
        receipt_dir,
        receipt_name,
        &normalized_key,
        normalized_fingerprint.as_deref(),
        now,
        receipt_lock,
    )
}

pub fn complete_apply_idempotency_claim(
    _workspace_root: &Path,
    claim: &ApplyIdempotencyClaim,
    success: &ApplyIdempotencySuccess,
) -> Result<(), OriginError> {
    // The claim retains the cross-process lock from creation through apply and
    // completion. Its claim id is still verified against disk as a second
    // generation check before replacing the receipt.
    let _held_lock = &claim._receipt_lock;
    let existing = read_stored_receipt(
        &claim.receipt_dir,
        &claim.receipt_name,
        &claim.idempotency_key,
    )?;
    if existing.status != Some(ApplyReceiptStatus::Pending)
        || existing.claim_id.as_deref() != Some(claim.claim_id.as_str())
        || existing.request_fingerprint != claim.request_fingerprint
    {
        return Err(OriginError::conflict(
            "apply idempotency claim is no longer owned by this request",
        ));
    }
    if success.rev.trim().is_empty() {
        return Err(OriginError::internal(
            "cannot complete apply idempotency claim without a revision",
        ));
    }

    let completed = StoredApplyIdempotencyReceipt {
        idempotency_key: claim.idempotency_key.clone(),
        status: Some(ApplyReceiptStatus::Succeeded),
        claim_id: Some(claim.claim_id.clone()),
        request_fingerprint: claim.request_fingerprint.clone(),
        claim_created_at: existing.claim_created_at,
        claim_expires_at: existing.claim_expires_at,
        rev: Some(success.rev.clone()),
        base_rev: success.base_rev.clone(),
        file_count: success.file_count,
        bytes_written: success.bytes_written,
    };
    replace_receipt(&claim.receipt_dir, &claim.receipt_name, &completed)?;
    remove_receipt_lock(&claim.receipt_dir, &claim.receipt_name)?;
    Ok(())
}

/// Remove an owned pending receipt after a synchronous, known failure. Crashes,
/// cancellation, and ambiguous completion never call this path and therefore
/// retain the bounded stale-recovery record.
pub fn abort_apply_idempotency_claim(
    _workspace_root: &Path,
    claim: &ApplyIdempotencyClaim,
) -> Result<(), OriginError> {
    let _held_lock = &claim._receipt_lock;
    let existing = read_stored_receipt(
        &claim.receipt_dir,
        &claim.receipt_name,
        &claim.idempotency_key,
    )?;
    if existing.status != Some(ApplyReceiptStatus::Pending)
        || existing.claim_id.as_deref() != Some(claim.claim_id.as_str())
        || existing.request_fingerprint != claim.request_fingerprint
    {
        return Err(OriginError::conflict(
            "apply idempotency claim is no longer owned by this request",
        ));
    }
    claim
        .receipt_dir
        .remove_file(&claim.receipt_name)
        .map_err(|error| {
            OriginError::internal(format!(
                "failed to abort apply receipt {:?}: {error}",
                claim.receipt_name
            ))
        })?;
    remove_receipt_lock(&claim.receipt_dir, &claim.receipt_name)?;
    sync_dir(&claim.receipt_dir).map_err(|error| {
        OriginError::internal(format!("failed to flush apply receipt directory: {error}"))
    })
}

fn classify_existing_receipt(
    receipt: StoredApplyIdempotencyReceipt,
    receipt_dir: Dir,
    receipt_name: OsString,
    idempotency_key: &str,
    request_fingerprint: Option<&str>,
    now: DateTime<Utc>,
    receipt_lock: ApplyReceiptLock,
) -> Result<ApplyIdempotencyClaimOutcome, OriginError> {
    let is_legacy_success = receipt.status.is_none();
    if !is_legacy_success && receipt.request_fingerprint.as_deref() != request_fingerprint {
        return Err(OriginError::conflict(
            "idempotencyKey was already used with a different requestFingerprint",
        ));
    }

    match receipt.status {
        Some(ApplyReceiptStatus::Pending) => {
            if !pending_claim_is_expired(&receipt, &receipt_dir, &receipt_name, now)? {
                return Ok(ApplyIdempotencyClaimOutcome::Pending);
            }
            let (claim, replacement) = new_pending_claim(
                idempotency_key,
                request_fingerprint,
                now,
                receipt_dir,
                receipt_name,
                receipt_lock,
            );
            replace_receipt(&claim.receipt_dir, &claim.receipt_name, &replacement)?;
            Ok(ApplyIdempotencyClaimOutcome::Acquired(claim))
        }
        Some(ApplyReceiptStatus::Succeeded) | None => {
            let rev = receipt
                .rev
                .filter(|rev| !rev.trim().is_empty())
                .ok_or_else(|| {
                    OriginError::internal("succeeded apply receipt is missing its revision")
                })?;
            remove_receipt_lock(&receipt_dir, &receipt_name)?;
            Ok(ApplyIdempotencyClaimOutcome::Succeeded(
                ApplyIdempotencySuccess {
                    rev,
                    base_rev: receipt.base_rev,
                    file_count: receipt.file_count,
                    bytes_written: receipt.bytes_written,
                },
            ))
        }
    }
}

fn new_pending_claim(
    idempotency_key: &str,
    request_fingerprint: Option<&str>,
    now: DateTime<Utc>,
    receipt_dir: Dir,
    receipt_name: OsString,
    receipt_lock: ApplyReceiptLock,
) -> (ApplyIdempotencyClaim, StoredApplyIdempotencyReceipt) {
    let claim_id = Uuid::new_v4().to_string();
    let request_fingerprint = request_fingerprint.map(str::to_string);
    let claim = ApplyIdempotencyClaim {
        idempotency_key: idempotency_key.to_string(),
        claim_id: claim_id.clone(),
        request_fingerprint: request_fingerprint.clone(),
        receipt_dir,
        receipt_name,
        _receipt_lock: receipt_lock,
    };
    let stored = StoredApplyIdempotencyReceipt {
        idempotency_key: idempotency_key.to_string(),
        status: Some(ApplyReceiptStatus::Pending),
        claim_id: Some(claim_id),
        request_fingerprint,
        claim_created_at: Some(now),
        claim_expires_at: Some(
            now + chrono::Duration::seconds(APPLY_PENDING_CLAIM_TTL.as_secs() as i64),
        ),
        rev: None,
        base_rev: None,
        file_count: None,
        bytes_written: None,
    };
    (claim, stored)
}

fn pending_claim_is_expired(
    receipt: &StoredApplyIdempotencyReceipt,
    receipt_dir: &Dir,
    receipt_name: &OsStr,
    now: DateTime<Utc>,
) -> Result<bool, OriginError> {
    let expires_at = if let Some(expires_at) = receipt.claim_expires_at {
        expires_at
    } else {
        // Pending receipts written by the initial protocol had no timestamp.
        // Use their durable file mtime so rolling upgrades still wait the same
        // conservative window before reclaiming them.
        let modified = receipt_dir
            .metadata(receipt_name)
            .and_then(|metadata| metadata.modified())
            .map_err(|error| {
                OriginError::internal(format!(
                    "failed to read apply receipt timestamp {:?}: {error}",
                    receipt_name
                ))
            })?;
        DateTime::<Utc>::from(modified.into_std())
            + chrono::Duration::seconds(APPLY_PENDING_CLAIM_TTL.as_secs() as i64)
    };
    Ok(now >= expires_at)
}

const MAX_APPLY_RECEIPT_BYTES: u64 = 64 * 1024;

fn read_stored_receipt(
    receipt_dir: &Dir,
    receipt_name: &OsStr,
    expected_key: &str,
) -> Result<StoredApplyIdempotencyReceipt, OriginError> {
    let receipt = read_stored_receipt_unchecked(receipt_dir, receipt_name)?;
    if receipt.idempotency_key != expected_key {
        return Err(OriginError::internal(format!(
            "apply receipt key mismatch at {:?}",
            receipt_name
        )));
    }
    Ok(receipt)
}

fn read_stored_receipt_unchecked(
    receipt_dir: &Dir,
    receipt_name: &OsStr,
) -> Result<StoredApplyIdempotencyReceipt, OriginError> {
    let mut file = receipt_dir
        .open_with(receipt_name, &read_nofollow_options())
        .map_err(|error| {
            OriginError::internal(format!(
                "failed to open apply receipt {:?}: {error}",
                receipt_name
            ))
        })?;
    let metadata = file.metadata().map_err(|error| {
        OriginError::internal(format!(
            "failed to inspect apply receipt {:?}: {error}",
            receipt_name
        ))
    })?;
    if !metadata.is_file() || metadata.len() > MAX_APPLY_RECEIPT_BYTES {
        return Err(OriginError::bad_request(
            "apply receipt must be a bounded regular file",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_APPLY_RECEIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            OriginError::internal(format!(
                "failed to read apply receipt {:?}: {error}",
                receipt_name
            ))
        })?;
    if bytes.len() as u64 > MAX_APPLY_RECEIPT_BYTES {
        return Err(OriginError::bad_request("apply receipt is too large"));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        OriginError::internal(format!(
            "failed to parse apply receipt {:?}: {error}",
            receipt_name
        ))
    })
}

fn read_optional_stored_receipt(
    receipt_dir: &Dir,
    receipt_name: &OsStr,
    expected_key: &str,
) -> Result<Option<StoredApplyIdempotencyReceipt>, OriginError> {
    match receipt_dir.symlink_metadata(receipt_name) {
        Ok(_) => read_stored_receipt(receipt_dir, receipt_name, expected_key).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(OriginError::internal(format!(
            "failed to inspect apply receipt {:?}: {error}",
            receipt_name
        ))),
    }
}

fn try_acquire_receipt_lock(
    receipt_dir: &Dir,
    receipt_name: &OsStr,
) -> Result<Option<ApplyReceiptLock>, OriginError> {
    let lock_name = PathBuf::from(receipt_name)
        .with_extension("lock")
        .into_os_string();
    let (file, created) = match receipt_dir.open_with(&lock_name, &create_new_private_options()) {
        Ok(file) => (file, true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let file = receipt_dir
                .open_with(&lock_name, &read_write_nofollow_options())
                .map_err(|error| {
                    OriginError::internal(format!(
                        "failed to open apply receipt lock {:?}: {error}",
                        lock_name
                    ))
                })?;
            (file, false)
        }
        Err(error) => {
            return Err(OriginError::internal(format!(
                "failed to create apply receipt lock {:?}: {error}",
                lock_name
            )))
        }
    };
    if !file
        .metadata()
        .map_err(|error| {
            OriginError::internal(format!("failed to inspect apply receipt lock: {error}"))
        })?
        .is_file()
    {
        return Err(OriginError::bad_request(
            "apply receipt lock must be a regular file",
        ));
    }
    let file = file.into_std();
    if created {
        file.sync_all().map_err(|error| {
            OriginError::internal(format!(
                "failed to flush apply receipt lock {:?}: {error}",
                lock_name
            ))
        })?;
        sync_dir(receipt_dir).map_err(|error| {
            OriginError::internal(format!("failed to flush apply receipt directory: {error}"))
        })?;
    }

    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(ApplyReceiptLock { file })),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(OriginError::internal(format!(
            "failed to lock apply receipt {:?}: {error}",
            lock_name
        ))),
    }
}

fn acquire_receipt_maintenance_lock(receipt_dir: &Dir) -> Result<ApplyReceiptLock, OriginError> {
    let lock_name = OsStr::new(".receipt-maintenance.lock");
    let (file, created) = match receipt_dir.open_with(lock_name, &create_new_private_options()) {
        Ok(file) => (file, true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (
            receipt_dir
                .open_with(lock_name, &read_write_nofollow_options())
                .map_err(|error| {
                    OriginError::internal(format!(
                        "failed to open receipt maintenance lock: {error}"
                    ))
                })?,
            false,
        ),
        Err(error) => {
            return Err(OriginError::internal(format!(
                "failed to create receipt maintenance lock: {error}"
            )))
        }
    };
    if !file
        .metadata()
        .map_err(|error| {
            OriginError::internal(format!(
                "failed to inspect receipt maintenance lock: {error}"
            ))
        })?
        .is_file()
    {
        return Err(OriginError::bad_request(
            "receipt maintenance lock must be a regular file",
        ));
    }
    let file = file.into_std();
    if created {
        file.sync_all().map_err(|error| {
            OriginError::internal(format!("failed to flush receipt maintenance lock: {error}"))
        })?;
        sync_dir(receipt_dir).map_err(|error| {
            OriginError::internal(format!("failed to flush apply receipt directory: {error}"))
        })?;
    }
    FileExt::lock_exclusive(&file).map_err(|error| {
        OriginError::internal(format!("failed to lock receipt maintenance: {error}"))
    })?;
    Ok(ApplyReceiptLock { file })
}

fn ensure_receipt_capacity(receipt_dir: &Dir, now: DateTime<Utc>) -> Result<(), OriginError> {
    let mut receipts = Vec::new();
    let entries = receipt_dir.entries().map_err(|error| {
        OriginError::internal(format!("failed to enumerate apply receipts: {error}"))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            OriginError::internal(format!("failed to inspect apply receipt entry: {error}"))
        })?;
        let name = entry.file_name();
        if Path::new(&name).extension() != Some(OsStr::new("json")) {
            continue;
        }
        let metadata = receipt_dir.symlink_metadata(&name).map_err(|error| {
            OriginError::internal(format!(
                "failed to inspect apply receipt {:?}: {error}",
                name
            ))
        })?;
        let modified = metadata
            .modified()
            .map(|time| DateTime::<Utc>::from(time.into_std()))
            .unwrap_or(now);
        receipts.push((name, modified));
    }
    if receipts.len() < MAX_APPLY_RECEIPTS_PER_WORKSPACE {
        return Ok(());
    }

    receipts.sort_by_key(|(_, modified)| *modified);
    let cutoff = now - chrono::Duration::seconds(APPLY_RECEIPT_RETENTION.as_secs() as i64);
    let mut count = receipts.len();
    for (name, modified) in receipts {
        if count < MAX_APPLY_RECEIPTS_PER_WORKSPACE || modified > cutoff {
            break;
        }
        let lock = match try_acquire_existing_receipt_lock(receipt_dir, &name)? {
            ExistingReceiptLock::Busy => continue,
            ExistingReceiptLock::Acquired(lock) => Some(lock),
            ExistingReceiptLock::Missing => None,
        };
        let receipt = match read_stored_receipt_unchecked(receipt_dir, &name) {
            Ok(receipt) => receipt,
            Err(_) => continue,
        };
        if matches!(receipt.status, Some(ApplyReceiptStatus::Pending)) {
            continue;
        }
        receipt_dir.remove_file(&name).map_err(|error| {
            OriginError::internal(format!("failed to evict apply receipt {:?}: {error}", name))
        })?;
        remove_receipt_lock(receipt_dir, &name)?;
        drop(lock);
        count -= 1;
    }
    if count >= MAX_APPLY_RECEIPTS_PER_WORKSPACE {
        return Err(OriginError::unavailable(format!(
            "apply receipt quota reached ({MAX_APPLY_RECEIPTS_PER_WORKSPACE}); retry after retained receipts expire"
        )));
    }
    sync_dir(receipt_dir).map_err(|error| {
        OriginError::internal(format!("failed to flush apply receipt directory: {error}"))
    })
}

fn remove_receipt_lock(receipt_dir: &Dir, receipt_name: &OsStr) -> Result<(), OriginError> {
    let lock_name = PathBuf::from(receipt_name)
        .with_extension("lock")
        .into_os_string();
    match receipt_dir.remove_file(&lock_name) {
        Ok(()) => sync_dir(receipt_dir).map_err(|error| {
            OriginError::internal(format!("failed to flush apply receipt directory: {error}"))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(OriginError::internal(format!(
            "failed to remove terminal apply receipt lock {:?}: {error}",
            lock_name
        ))),
    }
}

enum ExistingReceiptLock {
    Missing,
    Busy,
    Acquired(ApplyReceiptLock),
}

/// Read-only status probes must never create a lock for an arbitrary absent
/// key. Claims create locks; lookup only opens one if it already exists.
fn try_acquire_existing_receipt_lock(
    receipt_dir: &Dir,
    receipt_name: &OsStr,
) -> Result<ExistingReceiptLock, OriginError> {
    let lock_name = PathBuf::from(receipt_name)
        .with_extension("lock")
        .into_os_string();
    let file = match receipt_dir.open_with(&lock_name, &read_write_nofollow_options()) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ExistingReceiptLock::Missing)
        }
        Err(error) => {
            return Err(OriginError::internal(format!(
                "failed to open apply receipt lock {:?}: {error}",
                lock_name
            )))
        }
    };
    if !file
        .metadata()
        .map_err(|error| {
            OriginError::internal(format!("failed to inspect apply receipt lock: {error}"))
        })?
        .is_file()
    {
        return Err(OriginError::bad_request(
            "apply receipt lock must be a regular file",
        ));
    }
    let file = file.into_std();
    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(ExistingReceiptLock::Acquired(ApplyReceiptLock { file })),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            Ok(ExistingReceiptLock::Busy)
        }
        Err(error) => Err(OriginError::internal(format!(
            "failed to lock apply receipt {:?}: {error}",
            lock_name
        ))),
    }
}

fn persist_new_receipt(
    receipt_dir: &Dir,
    receipt_name: &OsStr,
    receipt: &StoredApplyIdempotencyReceipt,
) -> Result<bool, OriginError> {
    let temporary_name = write_temporary_receipt(receipt_dir, receipt)?;
    let link_result = receipt_dir.hard_link(&temporary_name, receipt_dir, receipt_name);
    let _ = receipt_dir.remove_file(&temporary_name);
    match link_result {
        Ok(()) => {
            sync_dir(receipt_dir).map_err(|error| {
                OriginError::internal(format!("failed to flush apply receipt directory: {error}"))
            })?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(OriginError::internal(format!(
            "failed to create apply receipt {:?}: {}",
            receipt_name, error
        ))),
    }
}

fn replace_receipt(
    receipt_dir: &Dir,
    receipt_name: &OsStr,
    receipt: &StoredApplyIdempotencyReceipt,
) -> Result<(), OriginError> {
    let temporary_name = write_temporary_receipt(receipt_dir, receipt)?;
    let replace_result = receipt_dir.rename(&temporary_name, receipt_dir, receipt_name);
    if replace_result.is_err() {
        let _ = receipt_dir.remove_file(&temporary_name);
    }
    replace_result.map_err(|error| {
        OriginError::internal(format!(
            "failed to replace apply receipt {:?}: {error}",
            receipt_name
        ))
    })?;
    sync_dir(receipt_dir).map_err(|error| {
        OriginError::internal(format!("failed to flush apply receipt directory: {error}"))
    })
}

fn open_receipt_dir(workspace_root: &Path) -> Result<Dir, OriginError> {
    let workspace = open_workspace_root(workspace_root)
        .map_err(|error| OriginError::bad_request(format!("workspace root is unsafe: {error}")))?;
    let instafy = open_or_create_child(&workspace, OsStr::new(".instafy")).map_err(|error| {
        OriginError::bad_request(format!("workspace metadata directory is unsafe: {error}"))
    })?;
    open_or_create_child(&instafy, OsStr::new("origin-apply-receipts")).map_err(|error| {
        OriginError::bad_request(format!("apply receipt directory is unsafe: {error}"))
    })
}

fn open_existing_receipt_dir(workspace_root: &Path) -> Result<Option<Dir>, OriginError> {
    let workspace = open_workspace_root(workspace_root)
        .map_err(|error| OriginError::bad_request(format!("workspace root is unsafe: {error}")))?;
    let instafy = match workspace.open_dir_nofollow(OsStr::new(".instafy")) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(OriginError::bad_request(format!(
                "workspace metadata directory is unsafe: {error}"
            )))
        }
    };
    match instafy.open_dir_nofollow(OsStr::new("origin-apply-receipts")) {
        Ok(dir) => Ok(Some(dir)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(OriginError::bad_request(format!(
            "apply receipt directory is unsafe: {error}"
        ))),
    }
}

fn write_temporary_receipt(
    receipt_dir: &Dir,
    receipt: &StoredApplyIdempotencyReceipt,
) -> Result<OsString, OriginError> {
    let bytes = serde_json::to_vec(receipt).map_err(|error| {
        OriginError::internal(format!("failed to serialize apply receipt: {error}"))
    })?;
    let temporary_name = OsString::from(format!(".receipt-{}.tmp", Uuid::new_v4()));
    let mut temporary = receipt_dir
        .open_with(&temporary_name, &create_new_private_options())
        .map_err(|error| {
            OriginError::internal(format!("failed to create temporary apply receipt: {error}"))
        })?;
    temporary.write_all(&bytes).map_err(|error| {
        OriginError::internal(format!("failed to write temporary apply receipt: {error}"))
    })?;
    temporary.sync_all().map_err(|error| {
        OriginError::internal(format!("failed to flush temporary apply receipt: {error}"))
    })?;
    Ok(temporary_name)
}

fn apply_receipt_file_name(idempotency_key: &str) -> OsString {
    apply_receipt_relative_path(idempotency_key)
        .file_name()
        .expect("receipt path has a filename")
        .to_os_string()
}

#[cfg(test)]
mod tests {
    use super::{
        abort_apply_idempotency_claim, apply_receipt_file_name, apply_receipt_relative_path,
        claim_apply_idempotency, claim_apply_idempotency_at, complete_apply_idempotency_claim,
        lookup_apply_idempotency, normalize_apply_idempotency_key,
        normalize_apply_request_fingerprint, open_receipt_dir, read_stored_receipt,
        try_acquire_receipt_lock, ApplyIdempotencyClaim, ApplyIdempotencyClaimOutcome,
        ApplyIdempotencyLookup, ApplyIdempotencySuccess, ApplyReceiptStatus,
        APPLY_PENDING_CLAIM_TTL,
    };
    use crate::paths::is_reserved_path;
    use chrono::Utc;
    use std::fs;
    use std::sync::{Arc, Barrier};
    use tempfile::TempDir;

    #[test]
    fn idempotency_values_are_bounded_and_transport_safe() {
        assert_eq!(
            normalize_apply_idempotency_key(Some(" github-import-v1:stable_key-1 ")).unwrap(),
            Some("github-import-v1:stable_key-1".to_string())
        );
        assert_eq!(normalize_apply_idempotency_key(Some("  ")).unwrap(), None);
        assert!(normalize_apply_idempotency_key(Some("unsafe/key")).is_err());
        assert!(normalize_apply_idempotency_key(Some(&"x".repeat(257))).is_err());
        assert_eq!(
            normalize_apply_request_fingerprint(Some("sha256:abc_123")).unwrap(),
            Some("sha256:abc_123".to_string())
        );
        assert!(normalize_apply_request_fingerprint(Some("sha256/abc")).is_err());
    }

    #[test]
    fn apply_receipt_path_is_stable_safe_and_reserved() {
        let first = apply_receipt_relative_path("github-import-v1:stable_key-1");
        let second = apply_receipt_relative_path("github-import-v1:stable_key-1");
        assert_eq!(first, second);
        let normalized = first.to_string_lossy();
        assert!(is_reserved_path(&normalized));
        assert!(normalized.starts_with(".instafy/origin-apply-receipts/"));
        assert!(normalized.ends_with(".json"));
        assert!(!normalized.contains("stable_key"));
    }

    #[test]
    fn claim_is_write_ahead_pending_then_cached_success() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:roundtrip";
        let fingerprint = "sha256:abc123";

        let first = claim_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap();
        let ApplyIdempotencyClaimOutcome::Acquired(claim) = first else {
            panic!("first caller should acquire the claim");
        };
        assert!(matches!(
            claim_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap(),
            ApplyIdempotencyClaimOutcome::Pending
        ));

        let success = ApplyIdempotencySuccess {
            rev: "abc123".to_string(),
            base_rev: Some("base123".to_string()),
            file_count: Some(2),
            bytes_written: Some(42),
        };
        complete_apply_idempotency_claim(workspace.path(), &claim, &success).unwrap();
        assert!(
            !workspace
                .path()
                .join(apply_receipt_relative_path(key))
                .with_extension("lock")
                .exists(),
            "terminal receipts must not retain one lock inode per key"
        );
        drop(claim);
        let ApplyIdempotencyClaimOutcome::Succeeded(cached) =
            claim_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap()
        else {
            panic!("completed claim should replay success");
        };
        assert_eq!(cached, success);
    }

    #[test]
    fn concurrent_claims_have_exactly_one_cross_process_style_winner() {
        let workspace = TempDir::new().unwrap();
        let workspace_path = workspace.path().to_path_buf();
        let contenders = 8;
        let barrier = Arc::new(Barrier::new(contenders));
        let handles = (0..contenders)
            .map(|_| {
                let barrier = barrier.clone();
                let workspace_path = workspace_path.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    claim_apply_idempotency(
                        &workspace_path,
                        "github-import-v1:concurrent",
                        Some("sha256:same-request"),
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();

        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, ApplyIdempotencyClaimOutcome::Acquired(_)))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, ApplyIdempotencyClaimOutcome::Pending))
                .count(),
            contenders - 1
        );
    }

    #[test]
    fn claim_rejects_fingerprint_mismatch() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:fingerprint";
        claim_apply_idempotency(workspace.path(), key, Some("sha256:first")).unwrap();
        let error = claim_apply_idempotency(workspace.path(), key, Some("sha256:second"))
            .expect_err("fingerprint reuse should fail");
        assert!(error.to_string().contains("different requestFingerprint"));
    }

    #[test]
    fn crashed_fresh_pending_claim_is_not_recovered_early() {
        let workspace = TempDir::new().unwrap();
        let now = Utc::now();
        let acquired = claim_apply_idempotency_at(
            workspace.path(),
            "github-import-v1:fresh-crash",
            Some("sha256:fresh"),
            now,
        )
        .unwrap();
        let ApplyIdempotencyClaimOutcome::Acquired(claim) = acquired else {
            panic!("first claim should be acquired");
        };
        drop(claim); // Simulate process death releasing the OS lock.

        let before_expiry =
            now + chrono::Duration::seconds(APPLY_PENDING_CLAIM_TTL.as_secs() as i64 - 1);
        assert!(matches!(
            claim_apply_idempotency_at(
                workspace.path(),
                "github-import-v1:fresh-crash",
                Some("sha256:fresh"),
                before_expiry,
            )
            .unwrap(),
            ApplyIdempotencyClaimOutcome::Pending
        ));
    }

    #[test]
    fn stale_pending_claim_is_recovered_with_a_new_generation() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:stale-crash";
        let fingerprint = "sha256:stale";
        let now = Utc::now();
        let ApplyIdempotencyClaimOutcome::Acquired(first) =
            claim_apply_idempotency_at(workspace.path(), key, Some(fingerprint), now).unwrap()
        else {
            panic!("first claim should be acquired");
        };
        let first_claim_id = first.claim_id.clone();
        drop(first);

        let after_expiry =
            now + chrono::Duration::seconds(APPLY_PENDING_CLAIM_TTL.as_secs() as i64 + 1);
        let ApplyIdempotencyClaimOutcome::Acquired(recovered) =
            claim_apply_idempotency_at(workspace.path(), key, Some(fingerprint), after_expiry)
                .unwrap()
        else {
            panic!("stale claim should be recovered");
        };
        assert_ne!(recovered.claim_id, first_claim_id);
    }

    #[test]
    fn active_owner_is_never_reclaimed_even_after_expiry() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:active-owner";
        let fingerprint = "sha256:active";
        let now = Utc::now();
        let ApplyIdempotencyClaimOutcome::Acquired(owner) =
            claim_apply_idempotency_at(workspace.path(), key, Some(fingerprint), now).unwrap()
        else {
            panic!("first claim should be acquired");
        };
        let well_after_expiry =
            now + chrono::Duration::seconds(APPLY_PENDING_CLAIM_TTL.as_secs() as i64 * 2);
        assert!(matches!(
            claim_apply_idempotency_at(
                workspace.path(),
                key,
                Some(fingerprint),
                well_after_expiry,
            )
            .unwrap(),
            ApplyIdempotencyClaimOutcome::Pending
        ));

        let success = ApplyIdempotencySuccess {
            rev: "owner-rev".to_string(),
            base_rev: None,
            file_count: Some(1),
            bytes_written: Some(1),
        };
        complete_apply_idempotency_claim(workspace.path(), &owner, &success).unwrap();
    }

    #[test]
    fn concurrent_stale_reclaimers_have_exactly_one_winner() {
        let workspace = TempDir::new().unwrap();
        let workspace_path = workspace.path().to_path_buf();
        let key = "github-import-v1:stale-race";
        let fingerprint = "sha256:stale-race";
        let now = Utc::now();
        let ApplyIdempotencyClaimOutcome::Acquired(first) =
            claim_apply_idempotency_at(&workspace_path, key, Some(fingerprint), now).unwrap()
        else {
            panic!("first claim should be acquired");
        };
        drop(first);

        let contenders = 8;
        let barrier = Arc::new(Barrier::new(contenders));
        let after_expiry =
            now + chrono::Duration::seconds(APPLY_PENDING_CLAIM_TTL.as_secs() as i64 + 1);
        let handles = (0..contenders)
            .map(|_| {
                let barrier = barrier.clone();
                let workspace_path = workspace_path.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    claim_apply_idempotency_at(
                        &workspace_path,
                        key,
                        Some(fingerprint),
                        after_expiry,
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, ApplyIdempotencyClaimOutcome::Acquired(_)))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, ApplyIdempotencyClaimOutcome::Pending))
                .count(),
            contenders - 1
        );
    }

    #[test]
    fn stale_owner_generation_cannot_complete_over_recovered_claim() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:stale-owner";
        let fingerprint = "sha256:stale-owner";
        let now = Utc::now();
        let ApplyIdempotencyClaimOutcome::Acquired(first) =
            claim_apply_idempotency_at(workspace.path(), key, Some(fingerprint), now).unwrap()
        else {
            panic!("first claim should be acquired");
        };
        let stale_claim_id = first.claim_id.clone();
        drop(first);
        let after_expiry =
            now + chrono::Duration::seconds(APPLY_PENDING_CLAIM_TTL.as_secs() as i64 + 1);
        let ApplyIdempotencyClaimOutcome::Acquired(recovered) =
            claim_apply_idempotency_at(workspace.path(), key, Some(fingerprint), after_expiry)
                .unwrap()
        else {
            panic!("stale claim should be recovered");
        };
        let recovered_claim_id = recovered.claim_id.clone();
        drop(recovered);

        let receipt_dir = open_receipt_dir(workspace.path()).unwrap();
        let receipt_name = apply_receipt_file_name(key);
        let receipt_lock = try_acquire_receipt_lock(&receipt_dir, &receipt_name)
            .unwrap()
            .expect("recovered owner released test lock");
        let stale_owner = ApplyIdempotencyClaim {
            idempotency_key: key.to_string(),
            claim_id: stale_claim_id,
            request_fingerprint: Some(fingerprint.to_string()),
            receipt_dir,
            receipt_name: receipt_name.clone(),
            _receipt_lock: receipt_lock,
        };
        let error = complete_apply_idempotency_claim(
            workspace.path(),
            &stale_owner,
            &ApplyIdempotencySuccess {
                rev: "wrong-rev".to_string(),
                base_rev: None,
                file_count: None,
                bytes_written: None,
            },
        )
        .expect_err("stale generation must not complete");
        assert!(error.to_string().contains("no longer owned"));
        let stored = read_stored_receipt(&stale_owner.receipt_dir, &receipt_name, key).unwrap();
        assert_eq!(
            stored.claim_id.as_deref(),
            Some(recovered_claim_id.as_str())
        );
        assert_eq!(stored.status, Some(super::ApplyReceiptStatus::Pending));
    }

    #[test]
    fn legacy_success_receipt_without_status_or_fingerprint_is_replayed() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:legacy";
        let receipt_dir = open_receipt_dir(workspace.path()).unwrap();
        let receipt_path = workspace.path().join(apply_receipt_relative_path(key));
        fs::write(
            receipt_path,
            serde_json::to_vec(&serde_json::json!({
                "idempotencyKey": key,
                "rev": "legacy123",
                "baseRev": "legacy-base"
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(receipt_dir.metadata(".").unwrap().is_dir());

        let ApplyIdempotencyClaimOutcome::Succeeded(success) =
            claim_apply_idempotency(workspace.path(), key, Some("sha256:new-client")).unwrap()
        else {
            panic!("legacy receipt should replay success");
        };
        assert_eq!(
            success,
            ApplyIdempotencySuccess {
                rev: "legacy123".to_string(),
                base_rev: Some("legacy-base".to_string()),
                file_count: None,
                bytes_written: None,
            }
        );
    }

    #[test]
    fn known_failure_aborts_pending_claim_for_immediate_retry() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:abort";
        let fingerprint = "sha256:abort";
        let ApplyIdempotencyClaimOutcome::Acquired(claim) =
            claim_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap()
        else {
            panic!("first claim should be acquired");
        };
        abort_apply_idempotency_claim(workspace.path(), &claim).unwrap();
        drop(claim);
        assert!(matches!(
            claim_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap(),
            ApplyIdempotencyClaimOutcome::Acquired(_)
        ));
    }

    #[test]
    fn lookup_reports_absent_pending_success_and_fingerprint_conflict() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:lookup";
        let fingerprint = "sha256:lookup";
        assert_eq!(
            lookup_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap(),
            None
        );
        assert!(
            !workspace.path().join(".instafy").exists(),
            "an absent status probe must not create metadata or lock files"
        );

        let ApplyIdempotencyClaimOutcome::Acquired(claim) =
            claim_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap()
        else {
            panic!("claim should be acquired");
        };
        assert_eq!(
            lookup_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap(),
            Some(ApplyIdempotencyLookup::Pending)
        );
        let success = ApplyIdempotencySuccess {
            rev: "lookup-rev".to_string(),
            base_rev: Some("lookup-base".to_string()),
            file_count: Some(3),
            bytes_written: Some(99),
        };
        complete_apply_idempotency_claim(workspace.path(), &claim, &success).unwrap();
        drop(claim);
        assert_eq!(
            lookup_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap(),
            Some(ApplyIdempotencyLookup::Succeeded(success))
        );
        let mismatch =
            lookup_apply_idempotency(workspace.path(), key, Some("sha256:other")).unwrap_err();
        assert!(mismatch
            .to_string()
            .contains("different requestFingerprint"));
    }

    #[test]
    fn oversized_and_symlinked_receipts_fail_closed() {
        use std::os::unix::fs::symlink;

        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:unsafe-receipt";
        let receipt_dir = open_receipt_dir(workspace.path()).unwrap();
        let receipt_name = apply_receipt_file_name(key);
        fs::write(
            workspace.path().join(apply_receipt_relative_path(key)),
            vec![b'x'; super::MAX_APPLY_RECEIPT_BYTES as usize + 1],
        )
        .unwrap();
        assert!(lookup_apply_idempotency(workspace.path(), key, None).is_err());
        receipt_dir.remove_file(&receipt_name).unwrap();

        let outside = workspace.path().join("outside-receipt.json");
        fs::write(&outside, b"{}").unwrap();
        symlink(
            &outside,
            workspace.path().join(apply_receipt_relative_path(key)),
        )
        .unwrap();
        assert!(lookup_apply_idempotency(workspace.path(), key, None).is_err());
    }

    #[test]
    fn symlinked_receipt_directory_and_lock_fail_closed() {
        use std::os::unix::fs::symlink;

        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::create_dir_all(workspace.path().join(".instafy")).unwrap();
        symlink(
            outside.path(),
            workspace.path().join(".instafy/origin-apply-receipts"),
        )
        .unwrap();
        assert!(
            claim_apply_idempotency(workspace.path(), "github-import-v1:symlink-dir", None)
                .is_err()
        );

        fs::remove_file(workspace.path().join(".instafy/origin-apply-receipts")).unwrap();
        let receipt_dir = open_receipt_dir(workspace.path()).unwrap();
        let receipt_name = apply_receipt_file_name("github-import-v1:symlink-lock");
        let lock_name = std::path::PathBuf::from(&receipt_name).with_extension("lock");
        let outside_lock = outside.path().join("outside.lock");
        fs::write(&outside_lock, b"lock").unwrap();
        symlink(
            &outside_lock,
            workspace
                .path()
                .join(".instafy/origin-apply-receipts")
                .join(&lock_name),
        )
        .unwrap();
        assert!(try_acquire_receipt_lock(&receipt_dir, &receipt_name).is_err());
    }

    #[test]
    fn stored_pending_shape_remains_explicit() {
        let workspace = TempDir::new().unwrap();
        let key = "github-import-v1:stored-pending";
        let ApplyIdempotencyClaimOutcome::Acquired(claim) =
            claim_apply_idempotency(workspace.path(), key, None).unwrap()
        else {
            panic!("claim should be acquired");
        };
        let receipt = read_stored_receipt(&claim.receipt_dir, &claim.receipt_name, key).unwrap();
        assert_eq!(receipt.status, Some(ApplyReceiptStatus::Pending));
    }

    #[test]
    fn receipt_namespace_has_a_hard_inode_quota() {
        let workspace = TempDir::new().unwrap();
        let receipt_dir = open_receipt_dir(workspace.path()).unwrap();
        let receipt_path = workspace.path().join(".instafy/origin-apply-receipts");
        for index in 0..super::MAX_APPLY_RECEIPTS_PER_WORKSPACE {
            fs::write(receipt_path.join(format!("quota-{index}.json")), b"{}").unwrap();
        }
        let error = claim_apply_idempotency(
            workspace.path(),
            "github-import-v1:over-quota",
            Some("sha256:over-quota"),
        )
        .expect_err("a full receipt namespace must reject a new idempotency key");
        assert!(error.to_string().contains("receipt quota reached"));
        assert!(receipt_dir
            .symlink_metadata(apply_receipt_file_name("github-import-v1:over-quota"))
            .is_err());
    }

    #[test]
    fn expired_terminal_receipts_are_evicted_at_quota() {
        let workspace = TempDir::new().unwrap();
        let receipt_path = workspace.path().join(".instafy/origin-apply-receipts");
        open_receipt_dir(workspace.path()).unwrap();
        for index in 0..super::MAX_APPLY_RECEIPTS_PER_WORKSPACE {
            fs::write(
                receipt_path.join(format!("expired-{index}.json")),
                serde_json::to_vec(&serde_json::json!({
                    "idempotencyKey": format!("expired-{index}"),
                    "status": "succeeded",
                    "rev": format!("rev-{index}"),
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let future = Utc::now()
            + chrono::Duration::seconds(super::APPLY_RECEIPT_RETENTION.as_secs() as i64 + 1);
        assert!(matches!(
            claim_apply_idempotency_at(
                workspace.path(),
                "github-import-v1:after-retention",
                Some("sha256:after-retention"),
                future,
            )
            .unwrap(),
            ApplyIdempotencyClaimOutcome::Acquired(_)
        ));
    }
}
