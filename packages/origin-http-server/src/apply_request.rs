//! Reading an apply request into its manifest and archive, shared by the
//! single-tenant origin and the hosted gateway: the multipart form
//! (`manifest` + `archive` parts) and the JSON form (`manifest` +
//! `archiveBase64`).

use std::path::Path;

use axum::body::to_bytes;
use axum::extract::{Multipart, Request};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::apply::ApplyManifest;
use crate::config::MAX_APPLY_MANIFEST_BYTES;
use crate::error::OriginError;

/// The largest archive the JSON form carries.
pub(crate) const MAX_APPLY_JSON_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024;
/// The largest JSON apply body.
pub(crate) const MAX_APPLY_JSON_REQUEST_BYTES: usize = 24 * 1024 * 1024;

/// An uploaded archive: decoded in memory (JSON form) or spooled to an
/// anonymous file (multipart form).
pub(crate) enum ApplyArchive {
    InMemory(Vec<u8>),
    TempFile { file: std::fs::File, size: u64 },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyJsonRequest {
    manifest: ApplyManifest,
    archive_base64: String,
}

/// Read the multipart form. The archive is spooled to an anonymous file in
/// `spool_dir` (the system's temporary folder when `None`) and refused
/// once it passes `max_archive_bytes`.
pub(crate) async fn read_apply_multipart(
    multipart: &mut Multipart,
    max_archive_bytes: u64,
    spool_dir: Option<&Path>,
) -> Result<(ApplyManifest, ApplyArchive), OriginError> {
    let mut manifest: Option<ApplyManifest> = None;
    let mut archive: Option<ApplyArchive> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| OriginError::bad_request(format!("invalid multipart payload: {error}")))?
    {
        let name = field
            .name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        if name == "manifest" {
            if manifest.is_some() {
                return Err(OriginError::bad_request("duplicate manifest part"));
            }
            let mut field = field;
            let mut bytes = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|error| {
                OriginError::bad_request(format!("manifest read failed: {error}"))
            })? {
                let next_len = bytes
                    .len()
                    .checked_add(chunk.len())
                    .ok_or_else(|| OriginError::bad_request("manifest size overflow"))?;
                if next_len > MAX_APPLY_MANIFEST_BYTES {
                    return Err(OriginError::bad_request("manifest exceeds size limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let parsed: ApplyManifest = serde_json::from_slice(&bytes).map_err(|error| {
                OriginError::bad_request(format!("manifest parse failed: {error}"))
            })?;
            manifest = Some(parsed);
        } else if name == "archive" {
            if archive.is_some() {
                return Err(OriginError::bad_request("duplicate archive part"));
            }
            let std_file = match spool_dir {
                Some(dir) => tempfile::tempfile_in(dir),
                None => tempfile::tempfile(),
            }
            .map_err(|error| {
                OriginError::internal(format!("failed to create archive staging file: {error}"))
            })?;
            let mut staged_file = tokio::fs::File::from_std(std_file);
            let mut field = field;
            let mut archive_size = 0u64;
            while let Some(chunk) = field.chunk().await.map_err(|error| {
                OriginError::bad_request(format!("archive read failed: {error}"))
            })? {
                archive_size = archive_size
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| OriginError::bad_request("archive size overflow"))?;
                if archive_size > max_archive_bytes {
                    return Err(OriginError::bad_request("archive exceeds size limit"));
                }
                staged_file.write_all(&chunk).await.map_err(|error| {
                    OriginError::internal(format!("archive staging write failed: {error}"))
                })?;
            }
            staged_file.flush().await.map_err(|error| {
                OriginError::internal(format!("archive staging flush failed: {error}"))
            })?;
            staged_file.sync_all().await.map_err(|error| {
                OriginError::internal(format!("archive staging sync failed: {error}"))
            })?;
            archive = Some(ApplyArchive::TempFile {
                file: staged_file.into_std().await,
                size: archive_size,
            });
        } else {
            return Err(OriginError::bad_request(format!(
                "unexpected multipart part {name:?}"
            )));
        }
    }

    let manifest = manifest.ok_or_else(|| OriginError::bad_request("manifest part missing"))?;
    let archive = archive.ok_or_else(|| OriginError::bad_request("archive part missing"))?;
    Ok((manifest, archive))
}

/// Read the JSON form: the archive is base64 and at most
/// [`MAX_APPLY_JSON_ARCHIVE_BYTES`] (or `max_archive_bytes`, if smaller).
pub(crate) async fn read_apply_json(
    request: Request,
    max_archive_bytes: u64,
) -> Result<(ApplyManifest, ApplyArchive), OriginError> {
    let body = to_bytes(request.into_body(), MAX_APPLY_JSON_REQUEST_BYTES)
        .await
        .map_err(|error| {
            OriginError::bad_request(format!("apply JSON body exceeds size limit: {error}"))
        })?;
    let payload: ApplyJsonRequest = serde_json::from_slice(&body)
        .map_err(|error| OriginError::bad_request(format!("invalid apply JSON: {error}")))?;
    let archive_raw = payload.archive_base64.trim();
    if archive_raw.is_empty() {
        return Err(OriginError::bad_request("archiveBase64 is required"));
    }
    let max_archive_bytes = max_archive_bytes.min(MAX_APPLY_JSON_ARCHIVE_BYTES);
    let max_encoded_len = max_archive_bytes
        .saturating_add(2)
        .saturating_div(3)
        .saturating_mul(4);
    if archive_raw.len() as u64 > max_encoded_len {
        return Err(OriginError::bad_request("archiveBase64 exceeds size limit"));
    }
    let archive_bytes = BASE64_STANDARD
        .decode(archive_raw)
        .map_err(|error| OriginError::bad_request(format!("archive decode failed: {error}")))?;
    if archive_bytes.len() as u64 > max_archive_bytes {
        return Err(OriginError::bad_request("archive exceeds size limit"));
    }
    Ok((payload.manifest, ApplyArchive::InMemory(archive_bytes)))
}

/// The manifest's `leaseId` must be the authenticated token's lease (both
/// absent counts as equal).
pub(crate) fn validate_apply_lease(
    manifest_lease_id: Option<&str>,
    claims_lease_id: Option<&str>,
) -> Result<(), OriginError> {
    let manifest = manifest_lease_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let trusted = claims_lease_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if manifest != trusted {
        return Err(OriginError::unauthorized(
            "manifest leaseId does not match the authenticated lease",
        ));
    }
    Ok(())
}
