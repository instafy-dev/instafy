//! The platform job record: one `ai_usage_jobs` row per platform-lane job, a
//! credential-less AI job served on the platform key.
//!
//! Dispatch writes the record once, in the transaction that enqueues the job,
//! and it is the job's immutable billing identity. The job lease then binds
//! every job token it mints to it. A job without a record has no platform
//! lane: BYO jobs and terminal commands never get one.

use axum::http::StatusCode;
use axum::Json;
use uuid::Uuid;

use crate::auth::proxy_token_sha256;
use crate::{internal_error, ApiError};

/// Every record is measured and never posted to the ledger until the
/// cutover. Until then the legacy reserve still bills the job, so a job
/// dispatched now never posts meter charges later.
const BILLING_MODE_RECORD_ONLY: &str = "record_only";

/// The billing identity dispatch stamps on a platform job.
pub(crate) struct PlatformJobRecord {
    pub(crate) job_id: Uuid,
    pub(crate) org_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) run_id: Uuid,
    pub(crate) prompt_id: Uuid,
    /// `MANAGED_AI_DECLINE_WAIVER_UNITS` when dispatch itself decided the job
    /// is a skill-mode ambient evaluation, else 0. Never read from the job
    /// payload, which a client or a later decline can change.
    pub(crate) decline_waiver_units: i32,
}

/// Inserts the record of a job dispatch has just enqueued. The job row is
/// brand new, so nothing else can hold it or its record yet.
pub(crate) async fn insert_platform_job_record(
    transaction: &tokio_postgres::Transaction<'_>,
    record: &PlatformJobRecord,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "insert into ai_usage_jobs (
                 job_id, org_id, project_id, run_id, prompt_id,
                 billing_mode, decline_waiver_units
             ) values ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &record.job_id,
                &record.org_id,
                &record.project_id,
                &record.run_id,
                &record.prompt_id,
                &BILLING_MODE_RECORD_ONLY,
                &record.decline_waiver_units,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record platform AI job: {error}")))?;
    Ok(())
}

/// Records the sha256 of the job token the lease minted for `lease_attempt`,
/// in the lease transaction, which already holds the job row. Settle and the
/// managed-key lease accept only a token recorded for its attempt, so even a
/// holder of the signing secret can use only tokens the controller minted
/// for that job. The lease calls it only for a platform job (no credential,
/// an intent that needs AI), so BYO and terminal leases never write here. A
/// platform job without a record, such as one in a project without an org,
/// has nothing to bind and is left alone.
pub(crate) async fn bind_job_token(
    transaction: &tokio_postgres::Transaction<'_>,
    job_id: &Uuid,
    lease_attempt: i32,
    token: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "update ai_usage_jobs
             set token_sha256_by_attempt =
                     token_sha256_by_attempt || jsonb_build_object($2::text, $3::text),
                 updated_at = now()
             where job_id = $1",
            &[
                job_id,
                &lease_attempt.to_string(),
                &proxy_token_sha256(token),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to bind job token: {error}")))?;
    Ok(())
}
