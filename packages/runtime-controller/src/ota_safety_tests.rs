use super::*;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use serde_json::json;
use tower::ServiceExt;

async fn wait_for_channel_lock_waiters(
    pool: &PgPool,
    channel: &str,
    count: i64,
) -> anyhow::Result<()> {
    let key = channel_lock_id(OtaPlatform::Ios, channel) as u64;
    let connection = pool.get().await?;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let row = connection
                .query_one(
                    "select count(*) from pg_locks where locktype = 'advisory' and not granted
                   and classid = $1::text::oid and objid = $2::text::oid and objsubid = 1",
                    &[&((key >> 32) as u32).to_string(), &(key as u32).to_string()],
                )
                .await?;
            if row.get::<_, i64>(0) == count {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await??;
    Ok(())
}

async fn assert_concurrent_channel_cas(
    first: OtaRegistry,
    second: OtaRegistry,
    pool: Option<PgPool>,
) -> anyhow::Result<()> {
    let app_a = app_for(first.clone()).await?;
    let app_b = app_for(second).await?;
    let channel = format!("race-{}", Uuid::new_v4());
    let a = release_for(&channel, "a");
    let b = release_for(&channel, "b");
    for release in [&a, &b] {
        assert_eq!(
            post(&app_a, "/ota/releases", json!(release)).await?.0,
            StatusCode::CREATED
        );
    }
    let path = format!("/ota/channels/ios/{channel}/activate");
    // Deliberately queue independent controllers behind the same lock while the channel is absent.
    let mut connection = match &pool {
        Some(pool) => Some(pool.get().await?),
        None => None,
    };
    let transaction = match connection.as_mut() {
        Some(connection) => Some(connection.transaction().await?),
        None => None,
    };
    if let Some(transaction) = &transaction {
        lock_channel(transaction, OtaPlatform::Ios, &channel)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    }
    let task_a = tokio::spawn({
        let app = app_a.clone();
        let path = path.clone();
        let id = a.release_id.clone();
        async move {
            post(
                &app,
                &path,
                json!({"release_id":id,"activated_by":"a","expected_active_release_id":null}),
            )
            .await
        }
    });
    let task_b = tokio::spawn({
        let app = app_b.clone();
        let path = path.clone();
        let id = b.release_id.clone();
        async move {
            post(
                &app,
                &path,
                json!({"release_id":id,"activated_by":"b","expected_active_release_id":null}),
            )
            .await
        }
    });
    let waiting = match &pool {
        Some(pool) => wait_for_channel_lock_waiters(pool, &channel, 2).await,
        None => Ok(()),
    };
    if let Some(transaction) = transaction {
        transaction.commit().await?;
    }
    let results = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        Ok::<_, anyhow::Error>([task_a.await??, task_b.await??])
    })
    .await??;
    waiting?;
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::CONFLICT)
            .count(),
        1
    );
    let history = first
        .list_channel_history(OtaPlatform::Ios, channel.clone(), 100)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    assert_eq!(history.len(), 1);
    let active = history[0].next_release_id.clone();
    let target = if active == a.release_id {
        b.release_id.clone()
    } else {
        a.release_id.clone()
    };
    // Activation versus rollback must share the same CAS namespace too.
    let rollback_path = format!("/ota/channels/ios/{channel}/rollback");
    let (activate_result, rollback_result) = tokio::join!(
        post(
            &app_a,
            &path,
            json!({"release_id":target,"activated_by":"test","expected_active_release_id":active})
        ),
        post(
            &app_b,
            &rollback_path,
            json!({"release_id":target,"activated_by":"test","expected_active_release_id":active})
        ),
    );
    let results = [activate_result?, rollback_result?];
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::CONFLICT)
            .count(),
        1
    );
    Ok(())
}

async fn assert_concurrent_registration(
    first: OtaRegistry,
    second: OtaRegistry,
) -> anyhow::Result<()> {
    let app_a = app_for(first).await?;
    let app_b = app_for(second).await?;
    let channel = format!("register-race-{}", Uuid::new_v4());
    let a = release_for(&channel, "a");
    let mut b = a.clone();
    b.artifact_sha256 = "b".repeat(64);
    let (a_result, b_result) = tokio::join!(
        post(&app_a, "/ota/releases", json!(a)),
        post(&app_b, "/ota/releases", json!(b))
    );
    let results = [a_result?, b_result?];
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::CONFLICT)
            .count(),
        1
    );
    let winning = results
        .into_iter()
        .find(|result| result.0 == StatusCode::CREATED)
        .unwrap()
        .1;
    let (a_retry, b_retry) = tokio::join!(
        post(&app_a, "/ota/releases", winning.clone()),
        post(&app_b, "/ota/releases", winning.clone())
    );
    for retry in [a_retry?, b_retry?] {
        assert_eq!(retry.0, StatusCode::CREATED);
        assert_eq!(retry.1, winning);
    }
    Ok(())
}

#[tokio::test]
async fn concurrent_channel_cas_in_memory() -> anyhow::Result<()> {
    let registry = OtaRegistry::new_in_memory();
    assert_concurrent_channel_cas(registry.clone(), registry, None).await
}
#[tokio::test]
async fn concurrent_channel_cas_postgres() -> anyhow::Result<()> {
    let Some((first, second, pool)) = postgres_registries().await? else {
        return Ok(());
    };
    assert_concurrent_channel_cas(first, second, Some(pool)).await
}
#[tokio::test]
async fn concurrent_registration_in_memory() -> anyhow::Result<()> {
    let registry = OtaRegistry::new_in_memory();
    assert_concurrent_registration(registry.clone(), registry).await
}
#[tokio::test]
async fn concurrent_registration_postgres() -> anyhow::Result<()> {
    let Some((first, second, _)) = postgres_registries().await? else {
        return Ok(());
    };
    assert_concurrent_registration(first, second).await
}

#[tokio::test]
async fn legacy_channel_writes_take_the_cas_lock_postgres() -> anyhow::Result<()> {
    let Some((first, _, pool)) = postgres_registries().await? else {
        return Ok(());
    };
    let app = app_for(first).await?;
    let channel = format!("legacy-lock-{}", Uuid::new_v4());
    let release = release_for(&channel, "a");
    assert_eq!(
        post(&app, "/ota/releases", json!(release)).await?.0,
        StatusCode::CREATED
    );
    for action in ["activate", "rollback"] {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        lock_channel(&transaction, OtaPlatform::Ios, &channel)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let task = tokio::spawn({
            let app = app.clone();
            let path = format!("/ota/channels/ios/{channel}/{action}");
            let id = release.release_id.clone();
            async move {
                post(
                    &app,
                    &path,
                    json!({"release_id":id,"activated_by":"legacy"}),
                )
                .await
            }
        });
        let waiting = wait_for_channel_lock_waiters(&pool, &channel, 1).await;
        transaction.commit().await?;
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), task).await???;
        waiting?;
        assert_eq!(response.0, StatusCode::OK);
    }
    Ok(())
}

fn release_for(channel: &str, label: &str) -> OtaReleaseRecord {
    let mut release = super::tests::sample_release();
    release.channel = channel.to_string();
    release.release_id = format!("{channel}-{label}");
    release.bundle_version = release.release_id.clone();
    release.git_sha = format!("abcdef0{label}");
    release
}

async fn post(
    app: &Router,
    path: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", "Bearer service-role-token")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body)?))?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((
        status,
        if body.is_empty() {
            JsonValue::Null
        } else {
            serde_json::from_slice(&body)?
        },
    ))
}

async fn app_for(registry: OtaRegistry) -> anyhow::Result<Router> {
    let (mut state, _temp_dir) = super::tests::test_state().await?;
    state.ota_registry = registry;
    Ok(router().with_state(state))
}

async fn postgres_registries() -> anyhow::Result<Option<(OtaRegistry, OtaRegistry, PgPool)>> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("skipping OTA PostgreSQL safety test: TEST_DATABASE_URL not set; run pnpm test:controller ota::");
        return Ok(None);
    };
    let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
        url,
        crate::config::database_tls(),
    )?;
    let pool = bb8::Pool::builder().max_size(5).build(manager).await?;
    let first = OtaRegistry::new_postgres(pool.clone());
    let second = OtaRegistry::new_postgres(pool.clone());
    // Initialize independent controller registries before racing their mutations.
    first
        .list_releases()
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    second
        .list_releases()
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    Ok(Some((first, second, pool)))
}

async fn assert_native_build_guards(registry: OtaRegistry) -> anyhow::Result<()> {
    let app = app_for(registry.clone()).await?;
    let channel = format!("native-{}", Uuid::new_v4());
    let mut release = release_for(&channel, "guarded");
    release.required_native_build = Some("80".to_string());
    assert_eq!(
        post(&app, "/ota/releases", json!(release)).await?.0,
        StatusCode::CREATED
    );
    let activate_path = format!("/ota/channels/ios/{channel}/activate");
    assert_eq!(post(&app, &activate_path, json!({"release_id": release.release_id, "activated_by":"test", "expected_active_release_id":null})).await?.0, StatusCode::OK);
    for build in [
        None,
        Some("79"),
        Some("81"),
        Some("080"),
        Some("80.0"),
        Some(" 80"),
        Some("80 "),
        Some("80\n"),
        Some(""),
        Some("８０"),
        Some("80..0"),
    ] {
        let (status, response) = post(&app, "/ota/check", json!({"device_id":"guarded-device", "platform":"ios", "channel":channel, "native_version":"1.2.0", "native_build":build})).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response["update_available"], false, "build {build:?}");
        assert_eq!(response["reason"], "native_build_incompatible");
        assert!(response.get("artifact_url").is_none());
    }
    let (_, response) = post(&app, "/ota/check", json!({"device_id":"guarded-device", "platform":"ios", "channel":channel, "native_version":"1.2.0", "native_build":"80"})).await?;
    assert_eq!(response["update_available"], true);
    assert_eq!(response["required_native_build"], "80");
    // Device state and lifecycle telemetry preserve build independently of version.
    let devices = registry
        .list_device_states(ResolvedDeviceStateListParams {
            limit: 100,
            platform: None,
            channel: Some(channel.clone()),
            query: None,
            attention_only: false,
            before_seen_at: None,
        })
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    assert_eq!(devices[0].native_build.as_deref(), Some("80"));
    let event_id = Uuid::new_v4().to_string();
    let (status, _) = post(&app, "/ota/events", json!({"event_id":event_id,"event_type":"app_reloaded","occurred_at":Utc::now(),"device_id":"guarded-device","platform":"ios","channel":channel,"native_version":"1.2.0","native_build":"80","bundle_version":release.bundle_version})).await?;
    assert_eq!(status, StatusCode::ACCEPTED);
    let events = registry
        .list_events(ResolvedEventListParams {
            limit: 100,
            platform: None,
            channel: Some(channel.clone()),
            event_type: None,
            query: None,
            before_occurred_at: None,
        })
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    assert_eq!(
        events
            .iter()
            .find(|event| event.event_id == event_id)
            .unwrap()
            .native_build
            .as_deref(),
        Some("80")
    );
    // Legacy releases remain available to older clients with no build field.
    let legacy = release_for(&channel, "legacy");
    assert_eq!(
        post(&app, "/ota/releases", json!(legacy)).await?.0,
        StatusCode::CREATED
    );
    assert_eq!(
        post(
            &app,
            &activate_path,
            json!({"release_id":legacy.release_id,"activated_by":"test"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    for build in [None, Some("invalid")] {
        let (_, response) = post(&app, "/ota/check", json!({"device_id":"legacy-device","platform":"ios","channel":channel,"native_version":"1.2.0","native_build":build})).await?;
        assert_eq!(response["update_available"], true);
        assert!(response.get("required_native_build").is_none());
    }
    for invalid in ["", " 80", "80.", "80..1", "80a", "８０"] {
        let mut invalid_release = release_for(&channel, "invalid");
        invalid_release.required_native_build = Some(invalid.to_string());
        assert_eq!(
            post(&app, "/ota/releases", json!(invalid_release)).await?.0,
            StatusCode::BAD_REQUEST
        );
    }
    Ok(())
}

async fn assert_channel_cas(registry: OtaRegistry) -> anyhow::Result<()> {
    let app = app_for(registry.clone()).await?;
    let channel = format!("cas-{}", Uuid::new_v4());
    let releases = [
        release_for(&channel, "a"),
        release_for(&channel, "b"),
        release_for(&channel, "c"),
    ];
    for release in &releases {
        assert_eq!(
            post(&app, "/ota/releases", json!(release)).await?.0,
            StatusCode::CREATED
        );
    }
    let activate = format!("/ota/channels/ios/{channel}/activate");
    let rollback = format!("/ota/channels/ios/{channel}/rollback");
    assert_eq!(
        post(
            &app,
            &rollback,
            json!({"activated_by":"test","expected_active_release_id":"missing"})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(post(&app,&activate,json!({"release_id":releases[0].release_id,"activated_by":"test","expected_active_release_id":null})).await?.0,StatusCode::OK);
    assert_eq!(post(&app,&activate,json!({"release_id":releases[1].release_id,"activated_by":"test","expected_active_release_id":null})).await?.0,StatusCode::CONFLICT);
    assert_eq!(post(&app,&activate,json!({"release_id":releases[1].release_id,"activated_by":"test","expected_active_release_id":releases[0].release_id})).await?.0,StatusCode::OK);
    assert_eq!(post(&app,&rollback,json!({"release_id":releases[0].release_id,"activated_by":"test","expected_active_release_id":releases[0].release_id})).await?.0,StatusCode::CONFLICT);
    let history = registry
        .list_channel_history(OtaPlatform::Ios, channel.clone(), 100)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    assert_eq!(history.len(), 2, "stale mutations must not change history");
    let (_, assignment) = post(
        &app,
        &rollback,
        json!({"activated_by":"test","expected_active_release_id":releases[1].release_id}),
    )
    .await?;
    assert_eq!(assignment["active_release_id"], releases[0].release_id);
    // Omission keeps the legacy unconditional activation and rollback contracts.
    assert_eq!(
        post(
            &app,
            &activate,
            json!({"release_id":releases[2].release_id,"activated_by":"test"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    assert_eq!(
        post(&app, &rollback, json!({"activated_by":"test"}))
            .await?
            .0,
        StatusCode::OK
    );
    let mut android = release_for(&channel, "android");
    android.platform = OtaPlatform::Android;
    assert_eq!(
        post(&app, "/ota/releases", json!(android)).await?.0,
        StatusCode::CREATED
    );
    assert_eq!(post(&app,&format!("/ota/channels/android/{channel}/activate"),json!({"release_id":android.release_id,"activated_by":"test","expected_active_release_id":null})).await?.0,StatusCode::OK);
    Ok(())
}

async fn assert_immutable_registration(registry: OtaRegistry) -> anyhow::Result<()> {
    let app = app_for(registry.clone()).await?;
    let channel = format!("immutable-{}", Uuid::new_v4());
    let mut release = release_for(&channel, "a");
    release.required_native_build = Some("80".to_string());
    assert_eq!(
        post(&app, "/ota/releases", json!(release)).await?.0,
        StatusCode::CREATED
    );
    assert_eq!(
        post(
            &app,
            &format!("/ota/channels/ios/{channel}/activate"),
            json!({"release_id":release.release_id,"activated_by":"test","rollout_percentage":25})
        )
        .await?
        .0,
        StatusCode::OK
    );
    let mut retry = release.clone();
    retry.notes = Some("retry must not rewrite publication metadata".to_string());
    retry.published_by = "different-retry-actor".to_string();
    let (status, stored) = post(&app, "/ota/releases", json!(retry)).await?;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(stored["status"], "live");
    assert_eq!(stored["rollout_percentage"], 25);
    assert_eq!(stored["published_by"], release.published_by);
    assert_eq!(stored["notes"], json!(release.notes));
    let changes: &[fn(&mut OtaReleaseRecord)] = &[
        |r| r.artifact_url.push_str("?different"),
        |r| r.artifact_sha256 = "b".repeat(64),
        |r| r.artifact_size_bytes += 1,
        |r| r.signature = Some("different".to_string()),
        |r| r.git_sha.push('1'),
        |r| r.bundle_version.push('1'),
        |r| r.native_version = "2.0".to_string(),
        |r| r.min_supported_native_version = "2.0".to_string(),
        |r| r.required_native_build = None,
        |r| r.required_native_build = Some("81".to_string()),
        |r| r.platform = OtaPlatform::Android,
        |r| r.channel.push_str("-other"),
    ];
    for change in changes {
        let mut changed = release.clone();
        change(&mut changed);
        assert_eq!(
            post(&app, "/ota/releases", json!(changed)).await?.0,
            StatusCode::CONFLICT
        );
    }
    let stored = registry
        .list_releases()
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?
        .into_iter()
        .find(|r| r.release_id == release.release_id)
        .unwrap();
    assert_eq!(stored.required_native_build, release.required_native_build);
    assert_eq!(stored.status, OtaReleaseStatus::Live);
    assert_eq!(stored.rollout_percentage, 25);
    Ok(())
}

#[tokio::test]
async fn native_build_guards_in_memory() -> anyhow::Result<()> {
    assert_native_build_guards(OtaRegistry::new_in_memory()).await
}
#[tokio::test]
async fn native_build_guards_postgres() -> anyhow::Result<()> {
    let Some((registry, _, _)) = postgres_registries().await? else {
        return Ok(());
    };
    assert_native_build_guards(registry).await
}
#[tokio::test]
async fn channel_cas_in_memory() -> anyhow::Result<()> {
    assert_channel_cas(OtaRegistry::new_in_memory()).await
}
#[tokio::test]
async fn channel_cas_postgres() -> anyhow::Result<()> {
    let Some((registry, _, _)) = postgres_registries().await? else {
        return Ok(());
    };
    assert_channel_cas(registry).await
}
#[tokio::test]
async fn immutable_registration_in_memory() -> anyhow::Result<()> {
    assert_immutable_registration(OtaRegistry::new_in_memory()).await
}
#[tokio::test]
async fn immutable_registration_postgres() -> anyhow::Result<()> {
    let Some((registry, _, _)) = postgres_registries().await? else {
        return Ok(());
    };
    assert_immutable_registration(registry).await
}

#[test]
fn native_build_format_is_bounded_raw_ascii_numeric_components() {
    for value in ["0", "80", "080", "80.01", "260860838", &"1".repeat(64)] {
        assert!(valid_native_build(value), "{value}");
    }
    for value in [
        "",
        " 80",
        "80 ",
        "80\n",
        ".80",
        "80.",
        "80..0",
        "1a",
        "-1",
        "８０",
        &"1".repeat(65),
    ] {
        assert!(!valid_native_build(value), "{value}");
    }
}

#[test]
fn expected_active_release_distinguishes_missing_null_and_id() -> anyhow::Result<()> {
    for (field, expected) in [
        (None, None),
        (Some(JsonValue::Null), Some(None)),
        (
            Some(json!("release-a")),
            Some(Some("release-a".to_string())),
        ),
    ] {
        let mut body = json!({"release_id":"release-b","activated_by":"test"});
        if let Some(field) = field {
            body["expected_active_release_id"] = field;
        }
        assert_eq!(
            serde_json::from_value::<ActivateChannelRequest>(body.clone())?
                .expected_active_release_id,
            expected
        );
        assert_eq!(
            serde_json::from_value::<RollbackChannelRequest>(body)?.expected_active_release_id,
            expected
        );
    }
    Ok(())
}
