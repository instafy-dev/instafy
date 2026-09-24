//! Rotating `CREDENTIAL_ENCRYPTION_KEY` without losing stored secrets.
//!
//! The controller opens rows with the primary key or any key listed in
//! `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`, and seals every new value with the
//! primary key. Two service-role-only operator routes finish a rotation:
//!
//! - `GET /operator/credential-encryption/census` reads every stored secret
//!   and counts which configured key opens it. It writes nothing. While the
//!   key derived from the published development `USER_TOKEN_SECRET` is
//!   configured, it also reports how many rows that key opens. The controller
//!   recognises that key by its one-way id only and never decrypts with a key
//!   that is not configured, so once it is removed its rows count as
//!   undecryptable.
//! - `POST /operator/credential-encryption/reencrypt` rewrites every row that
//!   only a previous key opens under the primary key. Rows are listed in
//!   primary-key order a page at a time and rewritten one per transaction,
//!   under a row lock, after the new ciphertext is checked to open to the same
//!   plaintext. Rows no configured key opens are never written. Rerunning it is
//!   safe; a finished pass rewrites nothing.
//!
//! Neither route returns or logs plaintext or key material: responses carry
//! counts and one-way key ids only.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio_postgres::types::ToSql;
use tokio_postgres::GenericClient;
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::config::{CredentialEncryptionKey, PgPool};
use crate::credential_keys::{
    credential_key_id, CredentialKeyRing, CredentialKeySlot, PUBLISHED_DEVELOPMENT_KEY_ID,
};
use crate::errors::service_unavailable;
use crate::{bad_request, forbidden, internal_error, unauthorized, ApiError, AppState};

const DEFAULT_BATCH_SIZE: i64 = 100;
const MAX_BATCH_SIZE: i64 = 1000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/operator/credential-encryption/census", get(census))
        .route("/operator/credential-encryption/reencrypt", post(reencrypt))
}

#[derive(Clone, Copy)]
enum KeyShape {
    /// A single uuid primary-key column.
    Id(&'static str),
    /// `user_oauth_tokens`: primary key `(user_id, provider)`.
    UserProvider,
}

/// A table that stores a sealed value. Every name here is a static literal,
/// so the SQL built from it never contains caller input.
pub(crate) struct SealedTable {
    pub(crate) name: &'static str,
    key: KeyShape,
    nonce_column: &'static str,
    ciphertext_column: &'static str,
}

/// Every table whose rows the credential key seals. A new table that stores a
/// value sealed by `CredentialKeyRing` must be listed here, or rotation would
/// strand it when the previous key is removed.
pub(crate) const SEALED_TABLES: &[SealedTable] = &[
    SealedTable {
        name: "user_credentials",
        key: KeyShape::Id("id"),
        nonce_column: "nonce_b64",
        ciphertext_column: "ciphertext_b64",
    },
    SealedTable {
        name: "project_secrets",
        key: KeyShape::Id("id"),
        nonce_column: "nonce_b64",
        ciphertext_column: "ciphertext_b64",
    },
    SealedTable {
        name: "user_oauth_tokens",
        key: KeyShape::UserProvider,
        nonce_column: "nonce_b64",
        ciphertext_column: "ciphertext_b64",
    },
    SealedTable {
        name: "project_browser_profiles",
        key: KeyShape::Id("id"),
        nonce_column: "nonce_b64",
        ciphertext_column: "ciphertext_b64",
    },
    SealedTable {
        name: "github_device_auth_sessions",
        key: KeyShape::Id("session_id"),
        nonce_column: "token_nonce_b64",
        ciphertext_column: "token_ciphertext_b64",
    },
];

#[derive(Clone, Debug, PartialEq, Eq)]
enum RowKey {
    Id(Uuid),
    UserProvider(Uuid, String),
}

impl RowKey {
    fn params(&self) -> Vec<&(dyn ToSql + Sync)> {
        match self {
            RowKey::Id(id) => vec![id],
            RowKey::UserProvider(user_id, provider) => vec![user_id, provider],
        }
    }
}

impl SealedTable {
    fn key_columns(&self) -> &'static str {
        match self.key {
            KeyShape::Id(column) => column,
            KeyShape::UserProvider => "user_id, provider",
        }
    }

    fn key_arity(&self) -> usize {
        match self.key {
            KeyShape::Id(_) => 1,
            KeyShape::UserProvider => 2,
        }
    }

    fn key_predicate(&self) -> String {
        match self.key {
            KeyShape::Id(column) => format!("{column} = $1"),
            KeyShape::UserProvider => "user_id = $1 and provider = $2".to_string(),
        }
    }

    fn page_sql(&self, after_cursor: bool, limit: i64) -> String {
        let keys = self.key_columns();
        let cursor = match (after_cursor, self.key) {
            (false, _) => String::new(),
            (true, KeyShape::Id(column)) => format!(" and {column} > $1"),
            (true, KeyShape::UserProvider) => " and (user_id, provider) > ($1, $2)".to_string(),
        };
        format!(
            "select {keys} from {table} where {nonce} is not null{cursor} order by {keys} limit {limit}",
            table = self.name,
            nonce = self.nonce_column,
        )
    }

    fn select_sql(&self, lock: bool) -> String {
        format!(
            "select {nonce} as sealed_nonce, {ciphertext} as sealed_ciphertext from {table} \
             where {predicate}{lock}",
            nonce = self.nonce_column,
            ciphertext = self.ciphertext_column,
            table = self.name,
            predicate = self.key_predicate(),
            lock = if lock { " for update" } else { "" },
        )
    }

    /// Rewrites only the sealed columns. Versions, timestamps and status stay
    /// as they were: the plaintext did not change. (`user_credentials` has a
    /// trigger that still bumps its `updated_at`.)
    fn update_sql(&self) -> String {
        let arity = self.key_arity();
        format!(
            "update {table} set {nonce} = ${n}, {ciphertext} = ${c} where {predicate}",
            table = self.name,
            nonce = self.nonce_column,
            ciphertext = self.ciphertext_column,
            n = arity + 1,
            c = arity + 2,
            predicate = self.key_predicate(),
        )
    }

    fn row_key(&self, row: &tokio_postgres::Row) -> RowKey {
        match self.key {
            KeyShape::Id(column) => RowKey::Id(row.get(column)),
            KeyShape::UserProvider => RowKey::UserProvider(row.get("user_id"), row.get("provider")),
        }
    }

    async fn is_present(&self, client: &impl GenericClient) -> anyhow::Result<bool> {
        let row = client
            .query_one(
                &format!("select to_regclass('{}') is not null as present", self.name),
                &[],
            )
            .await?;
        Ok(row.get("present"))
    }

    async fn next_page(
        &self,
        client: &impl GenericClient,
        after: Option<&RowKey>,
        limit: i64,
    ) -> anyhow::Result<Vec<RowKey>> {
        let params = after.map(RowKey::params).unwrap_or_default();
        let rows = client
            .query(&self.page_sql(after.is_some(), limit), &params)
            .await?;
        Ok(rows.iter().map(|row| self.row_key(row)).collect())
    }

    async fn load_sealed(
        &self,
        client: &impl GenericClient,
        key: &RowKey,
        lock: bool,
    ) -> anyhow::Result<Option<(String, String)>> {
        let row = client
            .query_opt(&self.select_sql(lock), &key.params())
            .await?;
        Ok(row.and_then(|row| {
            let nonce: Option<String> = row.get("sealed_nonce");
            let ciphertext: Option<String> = row.get("sealed_ciphertext");
            nonce.zip(ciphertext)
        }))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyDescriptor {
    /// Position in `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`, counting from 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    entry: Option<usize>,
    key_id: String,
    published_development_key: bool,
}

/// `published_key_id` is [`PUBLISHED_DEVELOPMENT_KEY_ID`] outside tests.
fn describe_keys(
    keys: &CredentialKeyRing,
    published_key_id: &str,
) -> (KeyDescriptor, Vec<KeyDescriptor>) {
    let describe = |entry: Option<usize>, key: &CredentialEncryptionKey| {
        let key_id = credential_key_id(key);
        KeyDescriptor {
            entry,
            published_development_key: key_id == published_key_id,
            key_id,
        }
    };
    (
        describe(None, keys.primary()),
        keys.previous()
            .iter()
            .enumerate()
            .map(|(index, key)| describe(Some(index + 1), key))
            .collect(),
    )
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CensusCounts {
    pub(crate) rows: u64,
    pub(crate) primary: u64,
    /// Rows each previous key opens, in `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` order.
    pub(crate) previous: Vec<u64>,
    /// Rows no configured key opens. The census never writes them.
    pub(crate) undecryptable: u64,
    /// Rows the key derived from the published development USER_TOKEN_SECRET
    /// opens, while that key is configured as the primary or a previous key;
    /// null when it is not configured. It overlaps the counts above and is the
    /// number to drive to zero before removing that key. The controller never
    /// decrypts with a key it is not configured with, so after the key is
    /// removed any rows still under it count as undecryptable instead.
    pub(crate) under_published_development_key: Option<u64>,
}

impl CensusCounts {
    fn new(previous_keys: usize, published_key_configured: bool) -> Self {
        Self {
            previous: vec![0; previous_keys],
            under_published_development_key: published_key_configured.then_some(0),
            ..Self::default()
        }
    }

    fn add(&mut self, other: &CensusCounts) {
        self.rows += other.rows;
        self.primary += other.primary;
        for (total, count) in self.previous.iter_mut().zip(&other.previous) {
            *total += count;
        }
        self.undecryptable += other.undecryptable;
        if let (Some(total), Some(count)) = (
            self.under_published_development_key.as_mut(),
            other.under_published_development_key,
        ) {
            *total += count;
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TableCensus {
    pub(crate) table: &'static str,
    /// False when the table does not exist yet, as `project_secrets` before
    /// the first secret is stored.
    pub(crate) present: bool,
    #[serde(flatten)]
    pub(crate) counts: CensusCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialCensus {
    primary_key: KeyDescriptor,
    previous_keys: Vec<KeyDescriptor>,
    pub(crate) tables: Vec<TableCensus>,
    pub(crate) totals: CensusCounts,
}

/// Count, for every sealed row, which configured key opens it. Read-only.
pub(crate) async fn run_census(
    pool: &PgPool,
    keys: &CredentialKeyRing,
    batch_size: i64,
) -> anyhow::Result<CredentialCensus> {
    census_flagging(pool, keys, batch_size, PUBLISHED_DEVELOPMENT_KEY_ID).await
}

/// [`run_census`], reporting the configured key whose id is
/// `published_key_id` as the published development key. Production passes
/// [`PUBLISHED_DEVELOPMENT_KEY_ID`]; tests pass the id of a random key, so
/// they never need the published key itself.
async fn census_flagging(
    pool: &PgPool,
    keys: &CredentialKeyRing,
    batch_size: i64,
    published_key_id: &str,
) -> anyhow::Result<CredentialCensus> {
    let published_slot = keys.slot_of_key_id(published_key_id);
    let (primary_key, previous_keys) = describe_keys(keys, published_key_id);
    let new_counts = || CensusCounts::new(keys.previous().len(), published_slot.is_some());
    let mut totals = new_counts();
    let mut tables = Vec::with_capacity(SEALED_TABLES.len());

    for table in SEALED_TABLES {
        let mut counts = new_counts();
        let present = table.is_present(&*pool.get().await?).await?;
        let mut cursor: Option<RowKey> = None;
        while present {
            let connection = pool.get().await?;
            let page = table
                .next_page(&*connection, cursor.as_ref(), batch_size)
                .await?;
            for key in &page {
                let Some((nonce, ciphertext)) = table.load_sealed(&*connection, key, false).await?
                else {
                    continue;
                };
                counts.rows += 1;
                let opened = keys
                    .open_with_slot(&nonce, &ciphertext)
                    .map(|(_, slot)| slot);
                match opened {
                    Ok(CredentialKeySlot::Primary) => counts.primary += 1,
                    Ok(CredentialKeySlot::Previous(index)) => counts.previous[index] += 1,
                    Err(_) => counts.undecryptable += 1,
                }
                if let (Some(count), Ok(slot)) =
                    (counts.under_published_development_key.as_mut(), &opened)
                {
                    if Some(*slot) == published_slot {
                        *count += 1;
                    }
                }
            }
            if page.len() < batch_size as usize {
                break;
            }
            cursor = page.last().cloned();
        }
        totals.add(&counts);
        tables.push(TableCensus {
            table: table.name,
            present,
            counts,
        });
    }

    Ok(CredentialCensus {
        primary_key,
        previous_keys,
        tables,
        totals,
    })
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReencryptionCounts {
    pub(crate) scanned: u64,
    pub(crate) already_primary: u64,
    pub(crate) reencrypted: u64,
    /// Rows no configured key opens. Never written.
    pub(crate) undecryptable: u64,
    /// Rows deleted between the listing and the rewrite.
    pub(crate) vanished: u64,
}

impl ReencryptionCounts {
    fn add(&mut self, other: &ReencryptionCounts) {
        self.scanned += other.scanned;
        self.already_primary += other.already_primary;
        self.reencrypted += other.reencrypted;
        self.undecryptable += other.undecryptable;
        self.vanished += other.vanished;
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TableReencryption {
    pub(crate) table: &'static str,
    pub(crate) present: bool,
    #[serde(flatten)]
    pub(crate) counts: ReencryptionCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialReencryption {
    /// False when `maxRows` stopped the pass early; `tables` then lists only
    /// the tables it reached. Run it again to continue.
    pub(crate) complete: bool,
    primary_key: KeyDescriptor,
    previous_keys: Vec<KeyDescriptor>,
    pub(crate) tables: Vec<TableReencryption>,
    pub(crate) totals: ReencryptionCounts,
}

#[derive(Debug, PartialEq, Eq)]
enum RowOutcome {
    AlreadyPrimary,
    Reencrypted,
    Undecryptable,
    Vanished,
}

/// Seals a row's plaintext for the rewrite. The pass uses the key ring's own
/// `seal`; tests substitute faulty sealers to prove that a value which fails
/// the post-seal check is never written.
type Sealer<'a> = &'a (dyn Fn(&[u8]) -> anyhow::Result<(String, String)> + Sync);

/// Rewrite every row that only a previous key opens under the primary key.
pub(crate) async fn run_reencryption(
    pool: &PgPool,
    keys: &CredentialKeyRing,
    batch_size: i64,
    max_rows: Option<u64>,
) -> anyhow::Result<CredentialReencryption> {
    let (primary_key, previous_keys) = describe_keys(keys, PUBLISHED_DEVELOPMENT_KEY_ID);
    let seal = |plaintext: &[u8]| keys.seal(plaintext);
    let mut totals = ReencryptionCounts::default();
    let mut tables = Vec::with_capacity(SEALED_TABLES.len());
    let mut complete = true;

    for table in SEALED_TABLES {
        if !complete {
            // `maxRows` was reached; tables not visited are left for the next run.
            break;
        }
        let mut counts = ReencryptionCounts::default();
        let present = table.is_present(&*pool.get().await?).await?;
        let mut cursor: Option<RowKey> = None;
        'pages: while present {
            let mut connection = pool.get().await?;
            let page = table
                .next_page(&*connection, cursor.as_ref(), batch_size)
                .await?;
            for key in &page {
                if max_rows.is_some_and(|limit| totals.reencrypted + counts.reencrypted >= limit) {
                    complete = false;
                    break 'pages;
                }
                counts.scanned += 1;
                match reencrypt_row(&mut connection, table, keys, key, &seal).await? {
                    RowOutcome::AlreadyPrimary => counts.already_primary += 1,
                    RowOutcome::Reencrypted => counts.reencrypted += 1,
                    RowOutcome::Undecryptable => counts.undecryptable += 1,
                    RowOutcome::Vanished => counts.vanished += 1,
                }
            }
            if page.len() < batch_size as usize {
                break;
            }
            cursor = page.last().cloned();
        }
        if present {
            tracing::info!(
                table = table.name,
                scanned = counts.scanned,
                already_primary = counts.already_primary,
                reencrypted = counts.reencrypted,
                undecryptable = counts.undecryptable,
                vanished = counts.vanished,
                "credential re-encryption table pass finished"
            );
        }
        totals.add(&counts);
        tables.push(TableReencryption {
            table: table.name,
            present,
            counts,
        });
    }

    Ok(CredentialReencryption {
        complete,
        primary_key,
        previous_keys,
        tables,
        totals,
    })
}

async fn reencrypt_row(
    connection: &mut tokio_postgres::Client,
    table: &SealedTable,
    keys: &CredentialKeyRing,
    key: &RowKey,
    seal: Sealer<'_>,
) -> anyhow::Result<RowOutcome> {
    // An unlocked read first, so rows already under the primary key (after a
    // rotation, nearly all of them) are never locked against live traffic.
    let Some((nonce, ciphertext)) = table.load_sealed(&*connection, key, false).await? else {
        return Ok(RowOutcome::Vanished);
    };
    match keys.open_with_slot(&nonce, &ciphertext) {
        Ok((_, CredentialKeySlot::Primary)) => return Ok(RowOutcome::AlreadyPrimary),
        Err(_) => return Ok(RowOutcome::Undecryptable),
        Ok((_, CredentialKeySlot::Previous(_))) => {}
    }

    let transaction = connection.transaction().await?;
    // Re-read under the row lock: a concurrent writer may have replaced the
    // value since, and its write must win.
    let locked = table.load_sealed(&transaction, key, true).await?;
    let opened = locked
        .as_ref()
        .map(|(nonce, ciphertext)| keys.open_with_slot(nonce, ciphertext));
    let plaintext = match opened {
        Some(Ok((plaintext, CredentialKeySlot::Previous(_)))) => plaintext,
        unchanged => {
            transaction.rollback().await?;
            return Ok(match unchanged {
                None => RowOutcome::Vanished,
                Some(Err(_)) => RowOutcome::Undecryptable,
                Some(Ok(_)) => RowOutcome::AlreadyPrimary,
            });
        }
    };
    // Returning early drops the transaction, which rolls it back and releases
    // the row lock: a value that fails this check is never written.
    let (new_nonce, new_ciphertext) = seal(&plaintext)?;
    let (check, slot) = keys.open_with_slot(&new_nonce, &new_ciphertext)?;
    anyhow::ensure!(
        slot == CredentialKeySlot::Primary && check == plaintext,
        "re-encrypted value did not open to the original under the primary key"
    );
    let mut params = key.params();
    params.push(&new_nonce);
    params.push(&new_ciphertext);
    let updated = transaction.execute(&table.update_sql(), &params).await?;
    anyhow::ensure!(
        updated == 1,
        "re-encryption of a {} row updated {updated} rows",
        table.name
    );
    transaction.commit().await?;
    Ok(RowOutcome::Reencrypted)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotationQuery {
    /// Rows listed per page (default 100, at most 1000).
    batch_size: Option<i64>,
    /// Re-encryption only: stop after rewriting this many rows.
    max_rows: Option<u64>,
}

fn batch_size(query: &RotationQuery) -> Result<i64, (StatusCode, Json<ApiError>)> {
    match query.batch_size {
        None => Ok(DEFAULT_BATCH_SIZE),
        Some(size) if (1..=MAX_BATCH_SIZE).contains(&size) => Ok(size),
        Some(_) => Err(bad_request(format!(
            "batchSize must be between 1 and {MAX_BATCH_SIZE}"
        ))),
    }
}

/// Only the service role may run these. Operator user sessions, which pass
/// the other `/operator` routes, do not: the census and the rewrite touch
/// every user's secrets at once.
async fn require_service_role<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> Result<&'a CredentialKeyRing, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    if !context.is_service_role {
        if context.user_id.is_none() && context.scoped_claims.is_none() {
            return Err(unauthorized("service-role authorization required"));
        }
        return Err(forbidden(
            "credential key rotation requires the service-role bearer",
        ));
    }
    state
        .config
        .credential_keys
        .as_ref()
        .ok_or_else(|| service_unavailable("CREDENTIAL_ENCRYPTION_KEY is not configured"))
}

async fn census(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RotationQuery>,
) -> Result<Json<CredentialCensus>, (StatusCode, Json<ApiError>)> {
    let keys = require_service_role(&state, &headers).await?;
    if query.max_rows.is_some() {
        return Err(bad_request("maxRows applies only to reencrypt"));
    }
    let census = run_census(&state.pool, keys, batch_size(&query)?)
        .await
        .map_err(|error| internal_error(format!("credential census failed: {error:#}")))?;
    tracing::info!(
        rows = census.totals.rows,
        primary = census.totals.primary,
        previous = ?census.totals.previous,
        undecryptable = census.totals.undecryptable,
        under_published_development_key = ?census.totals.under_published_development_key,
        "credential encryption census finished"
    );
    Ok(Json(census))
}

async fn reencrypt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RotationQuery>,
) -> Result<Json<CredentialReencryption>, (StatusCode, Json<ApiError>)> {
    let keys = require_service_role(&state, &headers).await?;
    if query.max_rows == Some(0) {
        return Err(bad_request("maxRows must be at least 1"));
    }
    let result = run_reencryption(&state.pool, keys, batch_size(&query)?, query.max_rows)
        .await
        .map_err(|error| internal_error(format!("credential re-encryption failed: {error:#}")))?;
    tracing::info!(
        complete = result.complete,
        scanned = result.totals.scanned,
        reencrypted = result.totals.reencrypted,
        undecryptable = result.totals.undecryptable,
        "credential re-encryption finished"
    );
    Ok(Json(result))
}

#[cfg(test)]
#[path = "credential_rotation_tests.rs"]
mod tests;
