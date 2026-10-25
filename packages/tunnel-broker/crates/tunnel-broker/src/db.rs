use crate::{config::BrokerConfig, error::AppError};
use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{postgres::PgPoolOptions, FromRow, PgPool};
use tunnel_broker_types::{RatholeClientConfig, TunnelDescriptor, TunnelStatus};
use uuid::Uuid;

pub type DbPool = PgPool;

#[derive(Debug, Clone, FromRow)]
#[allow(dead_code)]
pub struct IngressRecord {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: i32,
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
#[allow(dead_code)]
pub struct DnsNodeRecord {
    pub id: Uuid,
    pub hostname: String,
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
#[allow(dead_code)]
pub struct TunnelRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub org_id: Option<Uuid>,
    pub runtime_id: Option<Uuid>,
    pub lease_id: Option<Uuid>,
    pub idempotency_key: Option<String>,
    pub ingress_id: Uuid,
    pub hostname: String,
    pub rathole_service: Option<String>,
    pub rathole_port: Option<i32>,
    pub status: String,
    pub token: String,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub metadata: Option<serde_json::Value>,
    /// When the ingress sidecar last probed this tunnel's site ([`record_tunnel_listening`]).
    pub listening_checked_at: Option<DateTime<Utc>>,
    /// The HTTP status that probe got back, or `None` when nothing answered.
    pub listening_status: Option<i32>,
}

/// An active public tunnel row for handler tests.
#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn test_tunnel_record() -> TunnelRecord {
    let now = Utc::now();
    TunnelRecord {
        id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        org_id: None,
        runtime_id: None,
        lease_id: None,
        idempotency_key: Some("preview:rt:lease:4173".into()),
        ingress_id: Uuid::new_v4(),
        hostname: "abc.rt.test".into(),
        rathole_service: Some("tunnel_abc".into()),
        rathole_port: Some(20000),
        status: "active".into(),
        token: "tok".into(),
        token_expires_at: None,
        url: None,
        created_at: now,
        updated_at: now,
        expires_at: None,
        metadata: None,
        listening_checked_at: None,
        listening_status: None,
    }
}

pub struct TunnelInsert {
    pub id: Uuid,
    pub project_id: Uuid,
    pub org_id: Option<Uuid>,
    pub runtime_id: Option<Uuid>,
    pub lease_id: Option<Uuid>,
    pub idempotency_key: Option<String>,
    pub ingress_id: Uuid,
    pub hostname: String,
    pub rathole_service: Option<String>,
    pub rathole_port: Option<i32>,
    pub url: Option<String>,
    pub status: TunnelStatus,
    pub token: String,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub metadata: Option<serde_json::Value>,
    pub ttl_seconds: i32,
}

impl TunnelRecord {
    pub fn into_descriptor(self, _cfg: &BrokerConfig, ingress: &IngressRecord) -> TunnelDescriptor {
        let status = status_from_str(&self.status);
        let ingress_host = ingress
            .ipv4
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| {
                ingress
                    .ipv6
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| format!("[{value}]"))
            })
            .unwrap_or_else(|| ingress.host.clone());
        let client = RatholeClientConfig {
            server: format!("{}:{}", ingress_host, ingress.port),
            token: self.token.clone(),
            hostname: self.hostname.clone(),
            service: self.rathole_service.clone(),
            remote_port: self.rathole_port.map(|value| value as u16),
            protocol: Default::default(),
            local_http_port: None,
            local_tcp_port: None,
        };

        TunnelDescriptor {
            tunnel_id: self.id,
            hostname: self.hostname,
            status,
            ingress_host: ingress.host.clone(),
            ingress_port: ingress.port as u16,
            token: self.token,
            token_expires_at: self.token_expires_at,
            url: self.url,
            created_at: self.created_at,
            expires_at: self.expires_at,
            metadata: self.metadata,
            client,
        }
    }
}

pub async fn connect_pool(database_url: &str, database_pool_size: u32) -> Result<DbPool> {
    let max_connections = database_pool_size.max(1);
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(database_url)
        .await?;
    Ok(pool)
}

async fn notify_ingress_refresh(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    cfg: &BrokerConfig,
    ingress_id: Uuid,
) -> Result<()> {
    let channel = cfg.rathole_config_notify_channel.trim();
    if channel.is_empty() {
        return Ok(());
    }

    sqlx::query("select pg_notify($1, $2)")
        .bind(channel)
        .bind(ingress_id.to_string())
        .execute(&mut **tx)
        .await?;

    Ok(())
}

pub async fn run_migrations(pool: &DbPool) -> Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    lock_down_public_api_access(pool).await?;
    Ok(())
}

async fn lock_down_public_api_access(pool: &DbPool) -> Result<()> {
    sqlx::query(
        r#"
        DO $$
        DECLARE
          tbl text;
        BEGIN
          FOREACH tbl IN ARRAY ARRAY[
            '_sqlx_migrations',
            'ingress_nodes',
            'tunnels',
            'dns_records',
            'dns_nodes',
            'pdns_domains',
            'domains',
            'records',
            'domainmetadata',
            'cryptokeys',
            'tsigkeys',
            'supermasters',
            'comments'
          ]
          LOOP
            IF EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = tbl
                AND c.relkind = 'r'
            ) THEN
              EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', tbl);
              END IF;
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', tbl);
              END IF;
            END IF;
          END LOOP;
        END
        $$;
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        DO $$
        DECLARE
          seq_name text;
        BEGIN
          FOREACH seq_name IN ARRAY ARRAY[
            'pdns_domains_id_seq',
            'domains_id_seq',
            'records_id_seq',
            'domainmetadata_id_seq',
            'cryptokeys_id_seq',
            'tsigkeys_id_seq',
            'comments_id_seq'
          ]
          LOOP
            IF EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = seq_name
                AND c.relkind = 'S'
            ) THEN
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM anon', seq_name);
              END IF;
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM authenticated', seq_name);
              END IF;
            END IF;
          END LOOP;
        END
        $$;
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn ensure_pdns_domain(pool: &DbPool, cfg: &BrokerConfig) -> Result<i32> {
    let mut tx = pool.begin().await?;
    let domain_id = ensure_pdns_domain_row(&mut tx, &cfg.tunnel_domain).await?;
    ensure_pdns_zone_records(&mut tx, cfg, domain_id).await?;
    tx.commit().await?;
    Ok(domain_id)
}

async fn ensure_pdns_domain_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    zone: &str,
) -> Result<i32> {
    let zone = zone.trim();
    if zone.is_empty() {
        anyhow::bail!("tunnel domain cannot be empty");
    }

    let domain_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO domains (name, type)
        VALUES ($1, 'NATIVE')
        ON CONFLICT (name)
        DO UPDATE SET type = EXCLUDED.type
        RETURNING id
        "#,
    )
    .bind(zone)
    .fetch_one(&mut **tx)
    .await?;

    Ok(domain_id)
}

#[derive(Debug, Clone, FromRow)]
struct ZoneDnsNode {
    hostname: String,
    ipv4: Option<String>,
    ipv6: Option<String>,
}

async fn ensure_pdns_zone_records(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    cfg: &BrokerConfig,
    domain_id: i32,
) -> Result<()> {
    let zone = cfg.tunnel_domain.trim();
    if zone.is_empty() {
        return Ok(());
    }

    let mut nodes: Vec<ZoneDnsNode> = sqlx::query_as(
        r#"
        SELECT hostname, ipv4, ipv6
        FROM dns_nodes
        WHERE ipv4 IS NOT NULL OR ipv6 IS NOT NULL
        ORDER BY hostname ASC
        "#,
    )
    .fetch_all(&mut **tx)
    .await?;

    if nodes.is_empty() {
        let fallback = sqlx::query_as::<_, (Option<String>, Option<String>)>(
            r#"
            SELECT ipv4, ipv6
            FROM ingress_nodes
            WHERE ipv4 IS NOT NULL OR ipv6 IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
            "#,
        )
        .fetch_optional(&mut **tx)
        .await?
        .unwrap_or((
            cfg.ingress_ipv4.map(|ip| ip.to_string()),
            cfg.ingress_ipv6.map(|ip| ip.to_string()),
        ));

        let ipv4 = fallback.0.or_else(|| Some("127.0.0.1".to_string()));

        nodes.push(ZoneDnsNode {
            hostname: "ns1".to_string(),
            ipv4,
            ipv6: fallback.1,
        });
    }

    let primary = nodes
        .first()
        .map(|node| node.hostname.as_str())
        .unwrap_or("ns1");

    let ns_values: Vec<String> = nodes
        .iter()
        .map(|node| format!("{}.{}", node.hostname, zone))
        .collect();

    sqlx::query("DELETE FROM records WHERE domain_id = $1 AND name = $2 AND type = 'NS'")
        .bind(domain_id)
        .bind(zone)
        .execute(&mut **tx)
        .await?;

    for ns in &ns_values {
        sqlx::query(
            r#"
            INSERT INTO records (domain_id, name, type, content, ttl, prio, change_date, disabled, auth)
            VALUES ($1, $2, 'NS', $3, 60, 0, EXTRACT(EPOCH FROM NOW())::int, false, true)
            "#,
        )
        .bind(domain_id)
        .bind(zone)
        .bind(ns)
        .execute(&mut **tx)
        .await?;
    }

    sqlx::query("DELETE FROM records WHERE domain_id = $1 AND name = $2 AND type = 'SOA'")
        .bind(domain_id)
        .bind(zone)
        .execute(&mut **tx)
        .await?;

    let soa = format!("{}.{} admin.{} 1 120 60 86400 30", primary, zone, zone);
    sqlx::query(
        r#"
        INSERT INTO records (domain_id, name, type, content, ttl, prio, change_date, disabled, auth)
        VALUES ($1, $2, 'SOA', $3, 60, 0, EXTRACT(EPOCH FROM NOW())::int, false, true)
        "#,
    )
    .bind(domain_id)
    .bind(zone)
    .bind(soa)
    .execute(&mut **tx)
    .await?;

    for node in &nodes {
        let fqdn = format!("{}.{}", node.hostname, zone);

        if let Some(ipv4) = node.ipv4.as_deref().filter(|value| !value.is_empty()) {
            replace_record(tx, domain_id, &fqdn, "A", ipv4, 60).await?;
        }
        if let Some(ipv6) = node.ipv6.as_deref().filter(|value| !value.is_empty()) {
            replace_record(tx, domain_id, &fqdn, "AAAA", ipv6, 60).await?;
        }
    }

    Ok(())
}

async fn replace_record(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    domain_id: i32,
    name: &str,
    record_type: &str,
    content: &str,
    ttl: i32,
) -> Result<()> {
    sqlx::query("DELETE FROM records WHERE domain_id = $1 AND name = $2 AND type = $3")
        .bind(domain_id)
        .bind(name)
        .bind(record_type)
        .execute(&mut **tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO records (domain_id, name, type, content, ttl, prio, change_date, disabled, auth)
        VALUES ($1, $2, $3, $4, $5, 0, EXTRACT(EPOCH FROM NOW())::int, false, true)
        "#,
    )
    .bind(domain_id)
    .bind(name)
    .bind(record_type)
    .bind(content)
    .bind(ttl)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

#[allow(dead_code)]
pub async fn ensure_dns_node(
    pool: &DbPool,
    hostname: &str,
    ipv4: Option<String>,
    ipv6: Option<String>,
) -> Result<DnsNodeRecord> {
    let hostname = hostname.trim();
    if hostname.is_empty() {
        anyhow::bail!("dns node hostname cannot be empty");
    }

    let id = Uuid::new_v5(&Uuid::NAMESPACE_DNS, hostname.as_bytes());

    let record = sqlx::query_as::<_, DnsNodeRecord>(
        r#"
        INSERT INTO dns_nodes (id, hostname, ipv4, ipv6)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (hostname)
        DO UPDATE SET
            ipv4 = COALESCE(EXCLUDED.ipv4, dns_nodes.ipv4),
            ipv6 = COALESCE(EXCLUDED.ipv6, dns_nodes.ipv6),
            updated_at = NOW()
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(hostname)
    .bind(ipv4)
    .bind(ipv6)
    .fetch_one(pool)
    .await?;

    Ok(record)
}

pub async fn ensure_ingress(pool: &DbPool, cfg: &BrokerConfig) -> Result<IngressRecord> {
    let id = cfg.ingress_id();

    let record = sqlx::query_as::<_, IngressRecord>(
        r#"
        INSERT INTO ingress_nodes (id, name, host, port, ipv4, ipv6)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (host, port)
        DO UPDATE SET
            ipv4 = COALESCE(EXCLUDED.ipv4, ingress_nodes.ipv4),
            ipv6 = COALESCE(EXCLUDED.ipv6, ingress_nodes.ipv6),
            updated_at = NOW()
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(format!("{}:{}", cfg.ingress_host, cfg.ingress_port))
    .bind(&cfg.ingress_host)
    .bind(cfg.ingress_port as i32)
    .bind(cfg.ingress_ipv4.map(|ip| ip.to_string()))
    .bind(cfg.ingress_ipv6.map(|ip| ip.to_string()))
    .fetch_one(pool)
    .await?;

    Ok(record)
}

pub async fn get_ingress(pool: &DbPool, ingress_id: Uuid) -> Result<Option<IngressRecord>> {
    let record = sqlx::query_as::<_, IngressRecord>("select * from ingress_nodes where id = $1")
        .bind(ingress_id)
        .fetch_optional(pool)
        .await?;
    Ok(record)
}

pub async fn pick_ingress(pool: &DbPool) -> Result<IngressRecord> {
    let record = sqlx::query_as::<_, IngressRecord>(
        r#"
        with active_tunnels as (
            select ingress_id, count(*)::bigint as active_count
            from tunnels
            where status != 'revoked'
              and (expires_at is null or expires_at > now())
            group by ingress_id
        )
        select ingress_nodes.*
        from ingress_nodes
        left join active_tunnels on active_tunnels.ingress_id = ingress_nodes.id
        where (ingress_nodes.ipv4 is not null or ingress_nodes.ipv6 is not null)
          and ingress_nodes.updated_at > now() - interval '5 minutes'
        order by coalesce(active_tunnels.active_count, 0) asc, ingress_nodes.updated_at desc
        limit 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    record.ok_or_else(|| anyhow::anyhow!("no ingress nodes available"))
}

pub async fn create_tunnel(
    pool: &DbPool,
    cfg: &BrokerConfig,
    ingress: &IngressRecord,
    new: TunnelInsert,
) -> Result<TunnelRecord> {
    let mut tx = pool.begin().await?;
    let record = insert_tunnel(&mut tx, cfg, ingress, new).await?;
    tx.commit().await?;
    Ok(record)
}

/// Retires `stale` and creates `new` under the same idempotency key, in one transaction.
///
/// The stale row is revoked, its credential scrubbed, its address records removed from
/// whichever zone holds them, and its idempotency key released, so it can never be reused or
/// refreshed again; `new` then takes the key through the ordinary insert. The retirement only
/// applies while `stale` still holds the key: a concurrent replacement that already moved it
/// leaves nothing to retire, and the insert then resolves to the row that replacement created.
/// Returns the resolved row and the retired one, if this call retired it.
pub async fn replace_tunnel(
    pool: &DbPool,
    cfg: &BrokerConfig,
    ingress: &IngressRecord,
    stale: &TunnelRecord,
    new: TunnelInsert,
) -> Result<(TunnelRecord, Option<TunnelRecord>)> {
    let key = stale
        .idempotency_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("only an idempotent tunnel can be replaced"))?;
    let mut tx = pool.begin().await?;
    // Take the locks a create or refresh takes, in their order (zone row, the ingress
    // allocation lock, then the expired rows its sweep revokes), before touching the stale
    // row, so a replacement never waits on them while holding a tunnel row one of those
    // writers wants. The sweep also locks expired rows in the order the ingress sidecar's
    // sweep does, so an expired stale row is taken there rather than ahead of the rest. The
    // insert re-takes all of them freely.
    ensure_pdns_domain_row(&mut tx, &cfg.tunnel_domain).await?;
    lock_ingress_allocations(&mut tx, ingress.id).await?;
    revoke_expired_on_ingress(&mut tx, ingress.id).await?;
    let retired = sqlx::query_as::<_, TunnelRecord>(
        r#"
        UPDATE tunnels
        SET status = 'revoked',
            token = '',
            token_expires_at = NULL,
            idempotency_key = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND project_id = $2
          AND idempotency_key = $3
        RETURNING *
        "#,
    )
    .bind(stale.id)
    .bind(stale.project_id)
    .bind(key)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(retired) = &retired {
        delete_address_records(&mut tx, std::slice::from_ref(&retired.hostname)).await?;
        if retired.ingress_id != ingress.id {
            notify_ingress_refresh(&mut tx, cfg, retired.ingress_id).await?;
        }
    }

    let record = insert_tunnel(&mut tx, cfg, ingress, new).await?;
    tx.commit().await?;
    Ok((record, retired))
}

/// Drops a tunnel's `A`/`AAAA` records by name, whatever zone they were written under, so
/// retiring a tunnel minted before a `TUNNEL_DOMAIN` change still clears its old records.
async fn delete_address_records(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hostnames: &[String],
) -> Result<()> {
    if hostnames.is_empty() {
        return Ok(());
    }
    sqlx::query("DELETE FROM records WHERE name = ANY($1) AND type IN ('A','AAAA')")
        .bind(hostnames)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn insert_tunnel(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    cfg: &BrokerConfig,
    ingress: &IngressRecord,
    mut new: TunnelInsert,
) -> Result<TunnelRecord> {
    let domain_id = ensure_pdns_domain_row(tx, &cfg.tunnel_domain).await?;

    let idempotency_key = new
        .idempotency_key
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    if new.rathole_service.is_none() || new.rathole_port.is_none() {
        let (service, port) = allocate_rathole_binding(tx, cfg, new.ingress_id, new.id).await?;
        new.rathole_service = Some(service);
        new.rathole_port = Some(port);
    }

    let record = if let Some(key) = idempotency_key {
        let inserted = sqlx::query_as::<_, TunnelRecord>(
            r#"
            INSERT INTO tunnels (
                id, project_id, org_id, runtime_id, lease_id, idempotency_key, ingress_id,
                hostname, rathole_service, rathole_port, status, token, token_expires_at, url, expires_at, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, COALESCE($16, '{}'::jsonb))
            ON CONFLICT (project_id, idempotency_key) DO NOTHING
            RETURNING *
            "#,
        )
        .bind(new.id)
        .bind(new.project_id)
        .bind(new.org_id)
        .bind(new.runtime_id)
        .bind(new.lease_id)
        .bind(key)
        .bind(new.ingress_id)
        .bind(&new.hostname)
        .bind(&new.rathole_service)
        .bind(new.rathole_port)
        .bind(status_to_str(&new.status))
        .bind(&new.token)
        .bind(new.token_expires_at)
        .bind(&new.url)
        .bind(new.expires_at)
        .bind(new.metadata)
        .fetch_optional(&mut **tx)
        .await?;

        match inserted {
            Some(record) => Some(record),
            None => {
                let existing = sqlx::query_as::<_, TunnelRecord>(
                    "select * from tunnels where project_id = $1 and idempotency_key = $2 limit 1",
                )
                .bind(new.project_id)
                .bind(key)
                .fetch_optional(&mut **tx)
                .await?;
                existing
            }
        }
    } else {
        Some(
            sqlx::query_as::<_, TunnelRecord>(
                r#"
                INSERT INTO tunnels (
                    id, project_id, org_id, runtime_id, lease_id, ingress_id,
                    hostname, rathole_service, rathole_port, status, token, token_expires_at, url, expires_at, metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, '{}'::jsonb))
                RETURNING *
                "#,
            )
            .bind(new.id)
            .bind(new.project_id)
            .bind(new.org_id)
            .bind(new.runtime_id)
            .bind(new.lease_id)
            .bind(new.ingress_id)
            .bind(&new.hostname)
            .bind(&new.rathole_service)
            .bind(new.rathole_port)
            .bind(status_to_str(&new.status))
            .bind(&new.token)
            .bind(new.token_expires_at)
            .bind(&new.url)
            .bind(new.expires_at)
            .bind(new.metadata)
            .fetch_one(&mut **tx)
            .await?,
        )
    };

    let record = record.ok_or_else(|| anyhow::anyhow!("failed to resolve tunnel record"))?;

    // Always re-assert A/AAAA records for the resolved hostname.
    // If the broker returns an existing tunnel on idempotency-key reuse, this
    // self-heals missing DNS records instead of returning a stale hostname.
    if let Some(ipv4) = &ingress.ipv4 {
        replace_record(tx, domain_id, &record.hostname, "A", ipv4, new.ttl_seconds).await?;
    }

    if let Some(ipv6) = &ingress.ipv6 {
        replace_record(
            tx,
            domain_id,
            &record.hostname,
            "AAAA",
            ipv6,
            new.ttl_seconds,
        )
        .await?;
    }

    notify_ingress_refresh(tx, cfg, ingress.id).await?;
    Ok(record)
}

pub async fn ensure_tunnel_dns_records(
    pool: &DbPool,
    cfg: &BrokerConfig,
    ingress: &IngressRecord,
    hostname: &str,
    ttl_seconds: i32,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let domain_id = ensure_pdns_domain_row(&mut tx, &cfg.tunnel_domain).await?;

    if let Some(ipv4) = &ingress.ipv4 {
        replace_record(&mut tx, domain_id, hostname, "A", ipv4, ttl_seconds).await?;
    }

    if let Some(ipv6) = &ingress.ipv6 {
        replace_record(&mut tx, domain_id, hostname, "AAAA", ipv6, ttl_seconds).await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn refresh_tunnel(
    pool: &DbPool,
    cfg: &BrokerConfig,
    ingress: &IngressRecord,
    existing: &TunnelRecord,
    org_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    token: String,
    token_expires_at: Option<DateTime<Utc>>,
    url: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    metadata: Option<serde_json::Value>,
) -> Result<TunnelRecord> {
    let mut tx = pool.begin().await?;
    let domain_id = ensure_pdns_domain_row(&mut tx, &cfg.tunnel_domain).await?;

    let (service, port) = allocate_rathole_binding(&mut tx, cfg, ingress.id, existing.id).await?;

    let status = status_to_str(&TunnelStatus::Requested);
    let record = sqlx::query_as::<_, TunnelRecord>(
        r#"
        UPDATE tunnels
        SET org_id = $1,
            runtime_id = $2,
            lease_id = $3,
            ingress_id = $4,
            rathole_service = $5,
            rathole_port = $6,
            status = $7,
            token = $8,
            token_expires_at = $9,
            url = $10,
            expires_at = $11,
            metadata = COALESCE($12, metadata),
            listening_checked_at = NULL,
            listening_status = NULL,
            updated_at = NOW()
        WHERE id = $13
        RETURNING *
        "#,
    )
    .bind(org_id)
    .bind(runtime_id)
    .bind(lease_id)
    .bind(ingress.id)
    .bind(&service)
    .bind(port)
    .bind(status)
    .bind(&token)
    .bind(token_expires_at)
    .bind(&url)
    .bind(expires_at)
    .bind(metadata)
    .bind(existing.id)
    .fetch_one(&mut *tx)
    .await?;

    if let Some(ipv4) = &ingress.ipv4 {
        replace_record(
            &mut tx,
            domain_id,
            &existing.hostname,
            "A",
            ipv4,
            cfg.default_ttl_seconds,
        )
        .await?;
    }

    if let Some(ipv6) = &ingress.ipv6 {
        replace_record(
            &mut tx,
            domain_id,
            &existing.hostname,
            "AAAA",
            ipv6,
            cfg.default_ttl_seconds,
        )
        .await?;
    }

    notify_ingress_refresh(&mut tx, cfg, ingress.id).await?;
    tx.commit().await?;
    Ok(record)
}

pub async fn get_tunnel_by_idempotency_key(
    pool: &DbPool,
    project_id: Uuid,
    idempotency_key: &str,
) -> Result<Option<TunnelRecord>> {
    let trimmed = idempotency_key.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let record = sqlx::query_as::<_, TunnelRecord>(
        "select * from tunnels where project_id = $1 and idempotency_key = $2 limit 1",
    )
    .bind(project_id)
    .bind(trimmed)
    .fetch_optional(pool)
    .await?;
    Ok(record)
}

async fn allocate_rathole_binding(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    cfg: &BrokerConfig,
    ingress_id: Uuid,
    tunnel_id: Uuid,
) -> Result<(String, i32)> {
    lock_ingress_allocations(tx, ingress_id).await?;
    revoke_expired_on_ingress(tx, ingress_id).await?;

    let start = cfg.rathole_port_range_start.max(1024);
    let end = cfg.rathole_port_range_end.max(start);
    let used: Vec<i32> = sqlx::query_scalar(
        r#"
        select rathole_port
        from tunnels
        where ingress_id = $1
          and rathole_port between $2 and $3
          and status != 'revoked'
          and (expires_at is null or expires_at > now())
        order by rathole_port
        "#,
    )
    .bind(ingress_id)
    .bind(start)
    .bind(end)
    .fetch_all(&mut **tx)
    .await?;
    let Some(port) = lowest_free_port(&used, start, end) else {
        anyhow::bail!("rathole port range exhausted ({start}-{end})");
    };

    let service = format!("tunnel_{}", tunnel_id.simple());
    Ok((service, port))
}

/// Revokes the ingress's expired tunnels so their ports can be reused. Callers hold the
/// allocation lock.
async fn revoke_expired_on_ingress(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ingress_id: Uuid,
) -> Result<()> {
    sqlx::query(
        r#"
        update tunnels
        set status = 'revoked',
            token = '',
            token_expires_at = null,
            updated_at = now()
        where ingress_id = $1
          and status != 'revoked'
          and expires_at is not null
          and expires_at <= now()
        "#,
    )
    .bind(ingress_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Serializes port allocation on one ingress for the rest of the transaction. A transaction
/// that already holds it takes it again without waiting, so callers may take it early.
async fn lock_ingress_allocations(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ingress_id: Uuid,
) -> Result<()> {
    let bytes = ingress_id.as_bytes();
    let lock_key_1 = i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let lock_key_2 = i32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    sqlx::query("select pg_advisory_xact_lock($1, $2)")
        .bind(lock_key_1)
        .bind(lock_key_2)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The lowest port in `start..=end` that `used` (sorted ascending) does not
/// hold. Ports freed below the highest live one are reused, so a single
/// long-lived tunnel near the top of the range cannot pin the allocator and
/// exhaust the range for every tenant while the ports below it sit free.
fn lowest_free_port(used: &[i32], start: i32, end: i32) -> Option<i32> {
    let mut candidate = start;
    for &port in used {
        if port < candidate {
            continue;
        }
        if port > candidate {
            break;
        }
        candidate += 1;
    }
    (candidate <= end).then_some(candidate)
}

pub async fn get_tunnel(pool: &DbPool, id: Uuid) -> Result<Option<TunnelRecord>> {
    let record = sqlx::query_as::<_, TunnelRecord>("SELECT * FROM tunnels WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(record)
}

pub async fn revoke_tunnel(
    pool: &DbPool,
    cfg: &BrokerConfig,
    id: Uuid,
) -> Result<Option<TunnelRecord>> {
    let mut tx = pool.begin().await?;
    let record = sqlx::query_as::<_, TunnelRecord>(
        r#"
        UPDATE tunnels
        SET status = 'revoked',
            token = '',
            token_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(tunnel) = &record {
        delete_address_records(&mut tx, std::slice::from_ref(&tunnel.hostname)).await?;
        notify_ingress_refresh(&mut tx, cfg, tunnel.ingress_id).await?;
    }

    tx.commit().await?;
    Ok(record)
}

/// Marks expired tunnels as revoked and expires their DNS records.
/// Returns the number of tunnels revoked.
#[allow(dead_code)]
pub async fn revoke_expired_tunnels(pool: &DbPool, _cfg: &BrokerConfig) -> Result<u64> {
    let mut tx = pool.begin().await?;

    #[derive(Debug, FromRow)]
    struct RevokedTunnel {
        hostname: String,
    }

    let revoked: Vec<RevokedTunnel> = sqlx::query_as(
        r#"
        update tunnels
        set status = 'revoked',
            token = '',
            token_expires_at = null,
            updated_at = now()
        where status != 'revoked'
          and expires_at is not null
          and expires_at <= now()
        returning hostname
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;

    let revoked_count = revoked.len() as u64;
    let hostnames: Vec<String> = revoked.into_iter().map(|row| row.hostname).collect();
    delete_address_records(&mut tx, &hostnames).await?;

    tx.commit().await?;
    Ok(revoked_count)
}

#[allow(dead_code)]
pub async fn revoke_expired_tunnels_for_ingress(
    pool: &DbPool,
    _cfg: &BrokerConfig,
    ingress_id: Uuid,
) -> Result<Vec<TunnelRecord>> {
    let mut tx = pool.begin().await?;

    let revoked: Vec<TunnelRecord> = sqlx::query_as::<_, TunnelRecord>(
        r#"
        update tunnels
        set status = 'revoked',
            token = '',
            token_expires_at = null,
            updated_at = now()
        where ingress_id = $1
          and status != 'revoked'
          and expires_at is not null
          and expires_at <= now()
        returning *
        "#,
    )
    .bind(ingress_id)
    .fetch_all(&mut *tx)
    .await?;

    let hostnames: Vec<String> = revoked
        .iter()
        .map(|record| record.hostname.clone())
        .collect();
    delete_address_records(&mut tx, &hostnames).await?;

    tx.commit().await?;
    Ok(revoked)
}

#[derive(Debug, Clone, FromRow)]
#[allow(dead_code)]
pub struct RatholeBinding {
    pub tunnel_id: Uuid,
    pub rathole_service: String,
    pub rathole_port: i32,
    pub token: String,
    pub hostname: String,
    /// `labels.visibility`, `public` when unset.
    pub visibility: String,
    /// `labels.kind`, `tunnel` when unset.
    pub kind: String,
}

#[allow(dead_code)]
impl RatholeBinding {
    /// Anything other than an explicit `public` routes through preview auth.
    pub fn is_private(&self) -> bool {
        visibility_is_private(&self.visibility)
    }

    /// The tunnel id as it appears in preview hostnames.
    pub fn tunnel_hex(&self) -> String {
        self.tunnel_id.simple().to_string()
    }
}

#[allow(dead_code)]
pub fn visibility_is_private(visibility: &str) -> bool {
    !visibility.trim().eq_ignore_ascii_case("public")
}

/// Shared by both binding queries so routing never sees a binding without its labels.
const RATHOLE_BINDING_COLUMNS: &str =
    "id as tunnel_id, rathole_service, rathole_port, token, hostname, \
    coalesce(metadata->'labels'->>'visibility', 'public') as visibility, \
    coalesce(metadata->'labels'->>'kind', 'tunnel') as kind";

#[allow(dead_code)]
pub async fn list_active_rathole_bindings(pool: &DbPool) -> Result<Vec<RatholeBinding>> {
    let query = format!(
        r#"
        select {RATHOLE_BINDING_COLUMNS}
        from tunnels
        where rathole_service is not null
          and rathole_port is not null
          and status != 'revoked'
          and (expires_at is null or expires_at > now())
        order by rathole_port asc
        "#
    );
    let bindings = sqlx::query_as::<_, RatholeBinding>(&query)
        .fetch_all(pool)
        .await?;
    Ok(bindings)
}

#[allow(dead_code)]
pub async fn list_active_rathole_bindings_for_ingress(
    pool: &DbPool,
    ingress_id: Uuid,
) -> Result<Vec<RatholeBinding>> {
    let query = format!(
        r#"
        select {RATHOLE_BINDING_COLUMNS}
        from tunnels
        where ingress_id = $1
          and rathole_service is not null
          and rathole_port is not null
          and status != 'revoked'
          and (expires_at is null or expires_at > now())
        order by rathole_port asc
        "#
    );
    let bindings = sqlx::query_as::<_, RatholeBinding>(&query)
        .bind(ingress_id)
        .fetch_all(pool)
        .await?;
    Ok(bindings)
}

/// What the ingress sidecar saw when it probed one of its bindings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListeningObservation {
    pub tunnel_id: Uuid,
    /// The rathole port that was dialled; a binding that moved since is left alone.
    pub rathole_port: i32,
    /// The HTTP status that came back, or `None` when nothing answered.
    pub status: Option<u16>,
}

/// Records what the ingress sidecar saw on its own live tunnels. A tunnel whose site answered
/// is `active` from then on, until a refresh re-issues it; that is the only place the broker
/// marks a tunnel active. Rows on another ingress, revoked rows and rows whose rathole port
/// changed since the probe are left alone. Returns the ids that just became active.
pub async fn record_tunnel_listening(
    pool: &DbPool,
    ingress_id: Uuid,
    observations: &[ListeningObservation],
) -> Result<Vec<Uuid>> {
    if observations.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Uuid> = observations.iter().map(|seen| seen.tunnel_id).collect();
    let ports: Vec<i32> = observations.iter().map(|seen| seen.rathole_port).collect();
    let statuses: Vec<Option<i32>> = observations
        .iter()
        .map(|seen| seen.status.map(i32::from))
        .collect();
    let promoted: Vec<(Uuid, bool)> = sqlx::query_as(
        r#"
        update tunnels t
        set listening_checked_at = now(),
            listening_status = seen.status,
            status = case when seen.promote then 'active' else t.status end,
            updated_at = case when seen.promote then now() else t.updated_at end
        from (
            select observed.id,
                   observed.port,
                   observed.status,
                   observed.status is not null
                       and live.status in ('requested', 'refreshing') as promote
            from unnest($2::uuid[], $3::int4[], $4::int4[]) as observed(id, port, status)
            join tunnels live on live.id = observed.id
        ) as seen
        where t.id = seen.id
          and t.ingress_id = $1
          and t.rathole_port = seen.port
          and t.status <> 'revoked'
        returning t.id, seen.promote
        "#,
    )
    .bind(ingress_id)
    .bind(&ids)
    .bind(&ports)
    .bind(&statuses)
    .fetch_all(pool)
    .await?;
    Ok(promoted
        .into_iter()
        .filter_map(|(id, promoted)| promoted.then_some(id))
        .collect())
}

fn status_to_str(status: &TunnelStatus) -> &'static str {
    match status {
        TunnelStatus::Requested => "requested",
        TunnelStatus::Active => "active",
        TunnelStatus::Refreshing => "refreshing",
        TunnelStatus::Revoking => "revoking",
        TunnelStatus::Revoked => "revoked",
        TunnelStatus::Error => "error",
    }
}

fn status_from_str(status: &str) -> TunnelStatus {
    match status {
        "active" => TunnelStatus::Active,
        "refreshing" => TunnelStatus::Refreshing,
        "revoking" => TunnelStatus::Revoking,
        "revoked" => TunnelStatus::Revoked,
        "error" => TunnelStatus::Error,
        _ => TunnelStatus::Requested,
    }
}

pub fn not_found(id: Uuid) -> AppError {
    AppError::not_found(format!("tunnel {id} not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips() {
        let statuses = [
            TunnelStatus::Requested,
            TunnelStatus::Active,
            TunnelStatus::Refreshing,
            TunnelStatus::Revoking,
            TunnelStatus::Revoked,
            TunnelStatus::Error,
        ];

        for status in statuses {
            let as_str = status_to_str(&status);
            let parsed = status_from_str(as_str);
            assert_eq!(parsed as u8, status as u8);
        }
    }

    #[test]
    fn binding_queries_read_visibility_and_kind_from_labels() {
        let source = include_str!("db.rs");
        assert!(RATHOLE_BINDING_COLUMNS.contains("id as tunnel_id"));
        assert!(RATHOLE_BINDING_COLUMNS
            .contains("coalesce(metadata->'labels'->>'visibility', 'public') as visibility"));
        assert!(RATHOLE_BINDING_COLUMNS
            .contains("coalesce(metadata->'labels'->>'kind', 'tunnel') as kind"));
        let uses = ["select {", "RATHOLE_BINDING_COLUMNS}"].concat();
        assert_eq!(source.matches(&uses).count(), 2);
    }

    #[test]
    fn binding_visibility_fails_closed() {
        let binding = |visibility: &str| RatholeBinding {
            tunnel_id: Uuid::parse_str("0123456789abcdef0123456789abcdef").unwrap(),
            rathole_service: "tunnel_abc".into(),
            rathole_port: 20000,
            token: "tok".into(),
            hostname: "abc.rt.test".into(),
            visibility: visibility.into(),
            kind: "preview".into(),
        };
        assert!(!binding("public").is_private());
        assert!(!binding(" Public ").is_private());
        assert!(binding("private").is_private());
        assert!(binding("members").is_private());
        assert!(binding("").is_private());
        assert_eq!(
            binding("private").tunnel_hex(),
            "0123456789abcdef0123456789abcdef"
        );
    }

    #[test]
    fn rathole_ports_freed_below_the_highest_live_one_are_reused() {
        assert_eq!(lowest_free_port(&[], 20000, 20003), Some(20000));
        assert_eq!(lowest_free_port(&[20000, 20001], 20000, 20003), Some(20002));
        // A tunnel left at the top of the range no longer pins it.
        assert_eq!(lowest_free_port(&[20003], 20000, 20003), Some(20000));
        // A port freed in the middle is the next one handed out.
        assert_eq!(
            lowest_free_port(&[20000, 20002, 20003], 20000, 20003),
            Some(20001)
        );
        assert_eq!(
            lowest_free_port(&[20000, 20000, 20001], 20000, 20003),
            Some(20002)
        );
        assert_eq!(
            lowest_free_port(&[20000, 20001, 20002, 20003], 20000, 20003),
            None
        );
    }

    #[test]
    fn every_revocation_query_scrubs_stored_credentials() {
        let source = include_str!("db.rs").to_ascii_lowercase();
        let revoke_assignment = ["set status", " = 'revoked'"].concat();
        let token_scrub = ["token", " = ''"].concat();
        let expiry_scrub = ["token_expires_at", " = null"].concat();

        let revocation_count = source.matches(&revoke_assignment).count();
        assert!(revocation_count > 0, "expected revocation SQL");
        assert_eq!(source.matches(&token_scrub).count(), revocation_count);
        assert_eq!(source.matches(&expiry_scrub).count(), revocation_count);

        let migration =
            include_str!("../migrations/0013_scrub_revoked_tunnel_tokens.sql").to_ascii_lowercase();
        assert!(migration.contains("update tunnels"));
        assert!(migration.contains("where status = 'revoked'"));
        assert!(migration.contains("tunnels_revoked_token_scrubbed"));
        assert!(migration.contains("validate constraint"));
    }
}
