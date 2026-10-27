use super::*;
use crate::previews::wake::{sanitize_wake_error, WAKES_PER_PREVIEW};

const SERVE: &str = r#"{ "argv": ["python3", "-m", "http.server", "4173"], "cwd": "./site/" }"#;

fn serve() -> Value {
    serde_json::from_str(SERVE).unwrap()
}

/// A runtime provider that accepts every launch, as the docker provider does
/// before the runtime registers, and counts the launches.
async fn stub_provider() -> anyhow::Result<(
    String,
    Arc<std::sync::atomic::AtomicUsize>,
    crate::tests::AbortingTask<()>,
)> {
    let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = launches.clone();
    let app = Router::new().route(
        "/runtime/ensure",
        axum::routing::post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Json(json!({ "message": "runtime ensured" }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = crate::tests::spawn_aborting(async move {
        axum::serve(listener, app)
            .await
            .expect("serve stub provider");
    });
    Ok((format!("http://{address}"), launches, server))
}

impl Fixture {
    /// The preview routes on a state whose `default` provider is `endpoint`.
    fn app_with_provider(&self, endpoint: &str) -> Router {
        let mut state = self.state.clone();
        let mut providers = HashMap::new();
        providers.insert(
            "default".to_string(),
            crate::config::RuntimeProviderConfig {
                id: "default".to_string(),
                display_name: "Stub provider".to_string(),
                kind: "test".to_string(),
                owner_org_id: None,
                allowed_org_ids: vec![],
                endpoint: Some(endpoint.to_string()),
                auth_token: None,
                metadata: None,
            },
        );
        state.provider_registry =
            crate::state::ProviderRegistry::new(providers, "default".to_string());
        router().with_state(state)
    }

    /// The newest lease of `runtime_id` other than `except`.
    async fn newest_lease(&self, runtime_id: Uuid, except: Uuid) -> anyhow::Result<Option<Uuid>> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_opt(
                "select id from runtime_leases
                 where runtime_id = $1 and id <> $2
                 order by requested_at desc nulls last limit 1",
                &[&runtime_id, &except],
            )
            .await?
            .map(|row| row.get(0)))
    }

    /// The launched runtime registered on `lease_id`, as the agent's
    /// registration marks it.
    async fn registered(&self, runtime_id: Uuid, lease_id: Uuid) -> anyhow::Result<()> {
        let db = self.state.pool.get().await?;
        db.execute(
            "update runtime_leases set status = 'active', launched_at = coalesce(launched_at, now())
             where id = $1",
            &[&lease_id],
        )
        .await?;
        db.execute(
            "update runtimes set status = 'running', active_lease_id = $2 where id = $1",
            &[&runtime_id, &lease_id],
        )
        .await?;
        Ok(())
    }

    /// Open the preview on `job`'s runtime with a recorded start command.
    async fn open_restartable(&self, job: &Job) -> anyhow::Result<String> {
        let mut body = self.open_body(job, 4173);
        body["serve"] = serve();
        let (status, created) = self
            .request(&job.token, "POST", &self.path(""), body)
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert_eq!(created["restartable"], json!(true));
        Ok(created["previewId"]
            .as_str()
            .context("previewId")?
            .to_string())
    }

    async fn wake(&self, user: usize, preview_id: &str) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            &self.tokens[user],
            "POST",
            &self.path(&format!("/{preview_id}/wake")),
            json!({}),
        )
        .await
    }

    async fn get_preview(&self, preview_id: &str) -> anyhow::Result<Value> {
        let (status, body) = self
            .request(
                &self.tokens[2],
                "GET",
                &self.path(&format!("/{preview_id}?fresh=1")),
                Value::Null,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(body)
    }

    async fn count(&self, sql: &str) -> anyhow::Result<i64> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(sql, &[&self.project])
            .await?
            .get(0))
    }

    /// Rows that would mean a model turn, a chat message or a run was made.
    async fn model_footprint(&self) -> anyhow::Result<(i64, i64, i64)> {
        Ok((
            self.count("select count(*) from agent_jobs where project_id = $1")
                .await?,
            self.count("select count(*) from runs where project_id = $1")
                .await?,
            self.count("select count(*) from conversation_messages where project_id = $1")
                .await?,
        ))
    }

    /// What the idle sweep does to a runtime: stop it and revoke its tunnels.
    async fn stop_runtime_like_the_idle_sweep(&self, job: &Job) -> anyhow::Result<()> {
        revoke_tunnels_for_scope(
            &self.state,
            &self.project,
            Some(&job.runtime_id),
            Some(&job.lease_id),
            "idle",
        )
        .await
        .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
        let db = self.state.pool.get().await?;
        db.execute(
            "update runtime_leases set status = 'released', released_at = now() where id = $1",
            &[&job.lease_id],
        )
        .await?;
        db.execute(
            "update runtimes set status = 'stopped', active_lease_id = null where id = $1",
            &[&job.runtime_id],
        )
        .await?;
        Ok(())
    }

    /// The runtime came back on a new lease, as a provider launch does.
    async fn relaunch(&self, runtime_id: Uuid) -> anyhow::Result<Uuid> {
        let lease_id = Uuid::new_v4();
        let db = self.state.pool.get().await?;
        db.execute(
            "insert into runtime_leases(id, project_id, runtime_id, status, launched_at)
             values($1, $2, $3, 'active', now())",
            &[&lease_id, &self.project, &runtime_id],
        )
        .await?;
        db.execute(
            "update runtimes set status = 'running', active_lease_id = $2 where id = $1",
            &[&runtime_id, &lease_id],
        )
        .await?;
        Ok(lease_id)
    }

    fn agent_token(&self, runtime_id: Uuid, lease_id: Uuid) -> anyhow::Result<String> {
        Ok(crate::auth::issue_agent_token(
            &self.state.config,
            &self.project,
            &runtime_id,
            Some(&lease_id),
            None,
        )
        .map_err(|(_, error)| anyhow::anyhow!(error.0.message))?
        .token)
    }

    async fn claim(&self, agent_token: &str) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            agent_token,
            "POST",
            "/agent/preview-restarts/claim",
            json!({}),
        )
        .await
    }

    async fn report(
        &self,
        agent_token: &str,
        wake_id: &str,
        body: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            agent_token,
            "POST",
            &format!("/agent/preview-restarts/{wake_id}/result"),
            body,
        )
        .await
    }

    async fn activity_at(&self) -> anyhow::Result<Option<chrono::DateTime<Utc>>> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_opt(
                "select last_active_at from project_user_activity where project_id = $1",
                &[&self.project],
            )
            .await?
            .map(|row| row.get(0)))
    }

    async fn clear_activity(&self) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "delete from project_user_activity where project_id = $1",
                &[&self.project],
            )
            .await?;
        Ok(())
    }
}

#[test]
fn wake_errors_are_one_bounded_line() {
    assert_eq!(
        sanitize_wake_error("  python3: not found\n\tline two  "),
        "python3: not found line two"
    );
    assert_eq!(sanitize_wake_error("x".repeat(900).as_str()).len(), 300);
    assert_eq!(
        sanitize_wake_error("\u{7}\n"),
        "the preview could not be restarted"
    );
}

#[tokio::test]
async fn preview_open_records_the_start_command_only_when_it_is_valid() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            let metadata = f.grant_metadata(&preview_id).await?;
            assert_eq!(
                metadata[PREVIEW_TUNNEL_METADATA_KEY]["serve"],
                json!({ "argv": ["python3", "-m", "http.server", "4173"], "cwd": "site" })
            );
            let preview = f.get_preview(&preview_id).await?;
            assert_eq!(preview["restartable"], json!(true));
            assert_eq!(preview["wake"], json!({ "state": "idle" }));

            for bad in [
                json!({ "argv": ["x"], "cwd": "/etc" }),
                json!({ "argv": ["x"], "cwd": "../up" }),
                json!({ "argv": "python3 -m http.server" }),
                json!({ "argv": [] }),
            ] {
                let mut body = f.open_body(&job, 4175);
                body["serve"] = bad.clone();
                let (status, result) = f.request(&job.token, "POST", &f.path(""), body).await?;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{bad} {result}");
            }

            // A re-open without a start command (not detectable) is not
            // restartable any more: the latest open says how the site runs.
            let (status, created) = f
                .request(&job.token, "POST", &f.path(""), f.open_body(&job, 4173))
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            assert_eq!(created["previewId"], json!(preview_id));
            assert_eq!(created["restartable"], json!(false));
            assert!(
                f.grant_metadata(&preview_id).await?[PREVIEW_TUNNEL_METADATA_KEY]
                    .get("serve")
                    .is_none()
            );
            assert_eq!(
                f.get_preview(&preview_id).await?["restartable"],
                json!(false)
            );
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn wake_answers_live_for_a_running_site_and_only_to_members_who_may_view_it(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            // A read-only member may wake (as they may view).
            let (status, body) = f.wake(2, &preview_id).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body, json!({ "state": "live" }));
            assert_eq!(
                f.count("select count(*) from runtime_preview_wakes where project_id = $1")
                    .await?,
                0
            );
            let (status, _) = f.wake(3, &preview_id).await?;
            assert!(
                matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
                "an outsider: {status}"
            );
            let (status, _) = f
                .request(
                    &job.token,
                    "POST",
                    &f.path(&format!("/{preview_id}/wake")),
                    json!({}),
                )
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "a job token");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_preview_stopped_by_the_idle_sweep_wakes_on_the_next_lease_without_a_model_turn(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            let ready = f.ready(&job.token, &preview_id).await?;
            let card = ready["messageId"].clone();
            let (_, old_label) = f.view(0, &preview_id).await?;
            let other = f.job(None).await?;
            f.stop_runtime_like_the_idle_sweep(&job).await?;
            let footprint = f.model_footprint().await?;

            let stopped = f.get_preview(&preview_id).await?;
            assert_eq!(stopped["status"], "revoked");
            assert_eq!(stopped["restartable"], json!(true));

            // A read-only member can't start the stopped runtime (it costs
            // the space credits); nothing is recorded or launched. GET says
            // so before anyone presses Open.
            assert_eq!(f.get_preview(&preview_id).await?["canStart"], json!(false));
            let (status, builder_view) = f
                .request(&f.tokens[1], "GET", &f.path(&format!("/{preview_id}")), Value::Null)
                .await?;
            assert_eq!(status, StatusCode::OK, "{builder_view}");
            assert_eq!(builder_view["canStart"], json!(true));
            let (provider, launches, _provider) = stub_provider().await?;
            let app = f.app_with_provider(&provider);
            let wake_path = f.path(&format!("/{preview_id}/wake"));
            let (status, refused) = f.request_on(&app, &f.tokens[2], "POST", &wake_path, json!({})).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
            assert_eq!(refused["code"], "start_needs_builder", "{refused}");
            assert_eq!(
                f.count("select count(*) from runtime_preview_wakes where project_id = $1")
                    .await?,
                0
            );
            // A builder's Open wakes it; asking again is harmless, and the
            // read-only member now joins the wake under way.
            // (a preview opened from a conversation's turn names it)
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_tunnel_grants
                     set metadata = jsonb_set(metadata, '{_instafyPreview,conversationId}', to_jsonb($2::text))
                     where tunnel_id = $1",
                    &[&preview_id, &f.conversation.to_string()],
                )
                .await?;
            let mut wake_events = f.state.events.subscribe();
            let (status, first) = f.request_on(&app, &f.tokens[1], "POST", &wake_path, json!({})).await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{first}");
            assert_eq!(first["state"], "waking");
            // The event carries the preview's conversation and runtime, so
            // private conversations and private runtimes stay private.
            let event = wake_events.try_recv().context("preview.wake event")?;
            assert_eq!(event.kind, "preview.wake");
            assert_eq!(event.conversation_id, Some(f.conversation));
            assert_eq!(event.data["runtimeId"], json!(job.runtime_id));
            assert_eq!(event.data["state"], "waking");
            let (status, second) = f.request_on(&app, &f.tokens[0], "POST", &wake_path, json!({})).await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{second}");
            assert_eq!(second["startedAt"], first["startedAt"]);
            let (status, joined) = f.request_on(&app, &f.tokens[2], "POST", &wake_path, json!({})).await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{joined}");
            assert_eq!(joined["startedAt"], first["startedAt"]);
            assert_eq!(
                f.count("select count(*) from runtime_preview_wakes where project_id = $1")
                    .await?,
                1
            );
            let waking = f.get_preview(&preview_id).await?;
            assert_eq!(waking["wake"]["state"], "waking");
            assert_eq!(waking["wake"]["startedAt"], first["startedAt"]);

            // The wake started the runtime through the ensure path: one
            // provider launch of the same runtime on a new lease.
            let mut lease_id = None;
            for _ in 0..100 {
                if launches.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                    lease_id = f.newest_lease(job.runtime_id, job.lease_id).await?;
                    if lease_id.is_some() {
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let lease_id = lease_id.context("the wake did not launch the runtime")?;
            assert_eq!(launches.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert_eq!(f.get_preview(&preview_id).await?["wake"]["state"], "waking");
            // The launched runtime registers on that lease.
            f.registered(job.runtime_id, lease_id).await?;
            let agent = f.agent_token(job.runtime_id, lease_id)?;

            // The old lease's agent token is no longer the runtime's.
            let stale_agent = f.agent_token(job.runtime_id, job.lease_id)?;
            let (status, _) = f.claim(&stale_agent).await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            // Another runtime's agent sees nothing.
            let (status, body) = f
                .claim(&f.agent_token(other.runtime_id, other.lease_id)?)
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["restarts"], json!([]));

            let (status, claimed) = f.claim(&agent).await?;
            assert_eq!(status, StatusCode::OK, "{claimed}");
            let restarts = claimed["restarts"].as_array().context("restarts")?;
            assert_eq!(restarts.len(), 1, "{claimed}");
            let restart = &restarts[0];
            assert_eq!(restart["previewId"], json!(preview_id), "same preview id");
            assert_eq!(restart["port"], json!(4173));
            assert_eq!(restart["path"], "/");
            assert_eq!(
                restart["serve"],
                json!({ "argv": ["python3", "-m", "http.server", "4173"], "cwd": "site" })
            );
            assert!(restart["credentials"]["token"].is_string());
            assert_eq!(restart["credentials"]["localPort"], json!(4173));
            assert!(restart.get("hostSuffix").is_none(), "{restart}");
            let wake_id = restart["wakeId"].as_str().context("wakeId")?.to_string();
            // Claimed once: a second poll gets nothing.
            let (_, again) = f.claim(&agent).await?;
            assert_eq!(again["restarts"], json!([]));

            // The same tunnel came back on the new lease with its cards.
            let request = f
                .broker
                .requests
                .lock()
                .unwrap()
                .last()
                .cloned()
                .context("broker request")?;
            assert_eq!(request.lease_id, Some(lease_id));
            assert_eq!(
                request.idempotency_key.as_deref(),
                Some(format!("preview:{}:4173", job.runtime_id).as_str())
            );
            let metadata = f.grant_metadata(&preview_id).await?;
            assert!(metadata[PREVIEW_TUNNEL_METADATA_KEY].is_object(), "{metadata}");
            assert_eq!(metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageId"], card);
            assert!(metadata.get("autoRevokedSource").is_none(), "{metadata}");
            let lease: Option<Uuid> = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select runtime_lease_id from runtime_tunnel_grants where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert_eq!(lease, Some(lease_id));
            // A capability minted before the stop stays dead.
            assert!(!f.allowed(&preview_id, &old_label).await?);

            let (status, result) = f.report(&agent, &wake_id, json!({ "ok": true })).await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            assert_eq!(result, json!({ "state": "idle" }));
            let live = f.get_preview(&preview_id).await?;
            assert_eq!(live["status"], "active");
            assert_eq!(live["health"]["listening"], json!(true));
            assert_eq!(live["wake"], json!({ "state": "idle" }));
            let (_, label) = f.view(2, &preview_id).await?;
            assert!(f.allowed(&preview_id, &label).await?);
            let (status, body) = f.wake(2, &preview_id).await?;
            assert_eq!((status, body), (StatusCode::OK, json!({ "state": "live" })));

            // No agent job, run or chat message anywhere in the space.
            assert_eq!(f.model_footprint().await?, footprint);
            let row = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select state, requested_by, claim_count from runtime_preview_wakes
                     where id = $1",
                    &[&Uuid::parse_str(&wake_id)?],
                )
                .await?;
            assert_eq!(row.get::<_, String>("state"), "done");
            assert_eq!(row.get::<_, Option<Uuid>>("requested_by"), Some(f.users[1]));
            assert_eq!(row.get::<_, i32>("claim_count"), 1);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_wake_whose_runtime_cannot_start_fails_with_the_reason() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            f.stop_runtime_like_the_idle_sweep(&job).await?;
            let jobs_before = f
                .count("select count(*) from agent_jobs where project_id = $1")
                .await?;
            // The fixture's provider has no endpoint, so the ensure the wake
            // starts cannot launch anything.
            let (status, body) = f.wake(0, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{body}");
            let mut wake = None;
            for _ in 0..100 {
                wake = f
                    .state
                    .pool
                    .get()
                    .await?
                    .query_opt(
                        "select state, error from runtime_preview_wakes
                         where tunnel_id = $1 and state = 'failed'",
                        &[&preview_id],
                    )
                    .await?
                    .map(|row| (row.get::<_, String>(0), row.get::<_, Option<String>>(1)));
                if wake.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            // Members see why at once instead of waiting ten minutes.
            let (_, error) = wake.context("the wake did not fail")?;
            // A plain line: the provider's own words stay in the log.
            assert_eq!(
                error.as_deref(),
                Some("the space could not start; try again in a few minutes")
            );
            let preview = f.get_preview(&preview_id).await?;
            assert_eq!(preview["wake"]["state"], "failed", "{preview}");
            assert_eq!(
                f.count("select count(*) from agent_jobs where project_id = $1")
                    .await?,
                jobs_before
            );
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn wakes_are_refused_when_replaced_unrecorded_or_too_frequent() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            // No recorded start command: today's Restart asks Octo instead.
            let plain = f.open(&job).await?;
            f.stop_runtime_like_the_idle_sweep(&job).await?;
            let (status, body) = f.wake(0, &plain).await?;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body["code"], "not_restartable");
            assert_eq!(f.get_preview(&plain).await?["restartable"], json!(false));

            let lease_id = f.relaunch(job.runtime_id).await?;
            let next = Job {
                lease_id,
                ..f.job(Some(&job)).await?
            };
            let next = Job {
                token: f.machine_token(&next, f.users[0])?,
                ..next
            };
            let mut body = f.open_body(&next, 4180);
            body["serve"] = serve();
            body["conversationId"] = json!(f.conversation);
            let (status, created) = f
                .request(&next.token, "POST", &f.path(""), body.clone())
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let replaced = created["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            // The broker replaced the port's tunnel: the newer preview is the
            // one to wake, so the one it replaced is not restartable.
            f.broker.remint(&preview_tunnel_key(&next.runtime_id, 4180));
            let (status, newer) = f.request(&next.token, "POST", &f.path(""), body).await?;
            assert_eq!(status, StatusCode::CREATED, "{newer}");
            assert_ne!(newer["previewId"], json!(replaced));
            assert_eq!(newer["restartable"], json!(true));
            let (status, body) = f.wake(0, &replaced).await?;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body["code"], "not_restartable");
            assert_eq!(f.get_preview(&replaced).await?["restartable"], json!(false));

            // Rate limit: six wakes of one preview in ten minutes.
            let mut body = f.open_body(&next, 4181);
            body["serve"] = serve();
            body["conversationId"] = json!(f.conversation);
            let (_, created) = f.request(&next.token, "POST", &f.path(""), body).await?;
            let busy = created["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            let db = f.state.pool.get().await?;
            for _ in 0..WAKES_PER_PREVIEW {
                db.execute(
                    "insert into runtime_preview_wakes
                       (tunnel_id, project_id, runtime_id, requested_by, state, finished_at)
                     values ($1, $2, $3, $4, 'failed', now())",
                    &[&busy, &f.project, &job.runtime_id, &f.users[1]],
                )
                .await?;
            }
            drop(db);
            f.broker
                .silent_probes
                .store(100, std::sync::atomic::Ordering::SeqCst);
            let (status, body) = f.wake(0, &busy).await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            assert_eq!(body["code"], "rate_limited");

            // And thirty wakes by one person in a space per hour.
            let mut body = f.open_body(&next, 4182);
            body["serve"] = serve();
            body["conversationId"] = json!(f.conversation);
            let (_, created) = f.request(&next.token, "POST", &f.path(""), body).await?;
            let fresh = created["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            let db = f.state.pool.get().await?;
            for _ in 0..crate::previews::wake::WAKES_PER_USER {
                db.execute(
                    "insert into runtime_preview_wakes
                       (tunnel_id, project_id, runtime_id, requested_by, state, finished_at)
                     values ($1, $2, $3, $4, 'done', now())",
                    &[
                        &Uuid::new_v4().to_string(),
                        &f.project,
                        &job.runtime_id,
                        &f.users[2],
                    ],
                )
                .await?;
            }
            drop(db);
            let (status, body) = f.wake(2, &fresh).await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            let (status, body) = f.wake(0, &fresh).await?;
            assert_eq!(
                status,
                StatusCode::ACCEPTED,
                "another member still may: {body}"
            );
            Ok(())
        })
    })
    .await
}

/// "Stop the preview server": Octo stops the site and closes its preview.
/// The card then reads Stopped, and Open by someone who may change the space
/// starts the same site again from its recorded command, with no turn.
#[tokio::test]
async fn a_preview_closed_on_purpose_starts_again_on_open_by_people_who_may_change_the_space(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            let card = f.ready(&job.token, &preview_id).await?["messageId"].clone();
            let (_, old_label) = f.view(0, &preview_id).await?;
            let (status, _) = f
                .request(
                    &job.token,
                    "POST",
                    &f.path(&format!("/{preview_id}/close")),
                    json!({}),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert!(
                f.grant_metadata(&preview_id).await?[PREVIEW_TUNNEL_METADATA_KEY]["closedAt"]
                    .is_string()
            );
            let footprint = f.model_footprint().await?;

            // The record says Open can start it; a view-only member may not
            // undo the close, even with the machine up, and reads why first.
            let closed = f.get_preview(&preview_id).await?;
            assert_eq!(closed["status"], "revoked");
            assert_eq!(closed["restartable"], json!(true));
            assert_eq!(closed["canStart"], json!(false));
            let (status, builder_view) = f
                .request(
                    &f.tokens[1],
                    "GET",
                    &f.path(&format!("/{preview_id}")),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{builder_view}");
            assert_eq!(builder_view["restartable"], json!(true));
            assert_eq!(builder_view["canStart"], json!(true));
            let (status, refused) = f.wake(2, &preview_id).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
            assert_eq!(refused["code"], "start_needs_builder");
            assert_eq!(
                f.count("select count(*) from runtime_preview_wakes where project_id = $1")
                    .await?,
                0
            );

            // A builder's Open restarts it on the running machine.
            let (status, woken) = f.wake(1, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{woken}");
            assert_eq!(woken["state"], "waking");
            let agent = f.agent_token(job.runtime_id, job.lease_id)?;
            let (status, claimed) = f.claim(&agent).await?;
            assert_eq!(status, StatusCode::OK, "{claimed}");
            let restarts = claimed["restarts"].as_array().context("restarts")?;
            assert_eq!(restarts.len(), 1, "{claimed}");
            assert_eq!(
                restarts[0]["previewId"],
                json!(preview_id),
                "same preview id"
            );
            assert_eq!(
                restarts[0]["serve"],
                json!({ "argv": ["python3", "-m", "http.server", "4173"], "cwd": "site" })
            );
            let wake_id = restarts[0]["wakeId"]
                .as_str()
                .context("wakeId")?
                .to_string();
            // The reconnect drops the close and keeps the card.
            let metadata = f.grant_metadata(&preview_id).await?;
            assert!(
                metadata[PREVIEW_TUNNEL_METADATA_KEY]
                    .get("closedAt")
                    .is_none(),
                "{metadata}"
            );
            assert_eq!(metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageId"], card);
            // A capability minted before the close stays dead.
            assert!(!f.allowed(&preview_id, &old_label).await?);

            let (status, result) = f.report(&agent, &wake_id, json!({ "ok": true })).await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            let live = f.get_preview(&preview_id).await?;
            assert_eq!(live["status"], "active");
            assert_eq!(live["health"]["listening"], json!(true));
            assert_eq!(live["restartable"], json!(true));
            // Open again: no longer closed, so a viewer may restart its site.
            assert_eq!(live["canStart"], json!(true));
            assert_eq!(f.model_footprint().await?, footprint);
            Ok(())
        })
    })
    .await
}

/// A preview someone closed, whose port the broker later gave another tunnel
/// when a newer site opened on it, is replaced as surely as one that was
/// still open: the retirement skips a closed preview, so it carries no
/// `supersededBy`. Its card must not offer Open, and a wake of it (one asked
/// for before the newer site opened, say) must not reconnect the port's key
/// with the old site's command and title, which the broker answers with the
/// newer preview's tunnel and so would write over the newer preview.
#[tokio::test]
async fn a_closed_preview_that_a_newer_one_replaced_does_not_wake_over_it() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let closed = f.open_restartable(&job).await?;
            f.ready(&job.token, &closed).await?;
            let (status, _) = f
                .request(
                    &job.token,
                    "POST",
                    &f.path(&format!("/{closed}/close")),
                    json!({}),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            // A wake asked for while it was closed, before the newer site
            // opened, still waits for the agent.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "insert into runtime_preview_wakes (tunnel_id, project_id, runtime_id, requested_by)
                     values ($1, $2, $3, $4)",
                    &[&closed, &f.project, &job.runtime_id, &f.users[0]],
                )
                .await?;

            f.broker.remint(&preview_tunnel_key(&job.runtime_id, 4173));
            let mut body = f.open_body(&job, 4173);
            body["title"] = json!("Newer site");
            body["serve"] = json!({ "argv": ["node", "server.js"], "cwd": "newer" });
            let (status, created) = f.request(&job.token, "POST", &f.path(""), body).await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let newer = created["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            assert_ne!(newer, closed);
            let newer_before = f.grant_metadata(&newer).await?;

            assert_eq!(f.get_preview(&closed).await?["restartable"], json!(false));
            let (status, refused) = f.wake(0, &closed).await?;
            assert_eq!(status, StatusCode::CONFLICT, "{refused}");
            assert_eq!(refused["code"], "not_restartable");

            let agent = f.agent_token(job.runtime_id, job.lease_id)?;
            let (status, claimed) = f.claim(&agent).await?;
            assert_eq!(status, StatusCode::OK, "{claimed}");
            assert_eq!(claimed["restarts"], json!([]), "{claimed}");
            let newer_after = f.grant_metadata(&newer).await?;
            assert_eq!(
                newer_after[PREVIEW_TUNNEL_METADATA_KEY]["title"],
                json!("Newer site")
            );
            assert_eq!(
                newer_after[PREVIEW_TUNNEL_METADATA_KEY]["serve"],
                newer_before[PREVIEW_TUNNEL_METADATA_KEY]["serve"]
            );
            let newer_view = f.get_preview(&newer).await?;
            assert_eq!(newer_view["title"], "Newer site");
            assert_eq!(newer_view["restartable"], json!(true));
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn wake_outcomes_reach_get_failed_runs_time_out_and_foreign_reports_are_refused(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            f.stop_runtime_like_the_idle_sweep(&job).await?;
            let lease_id = f.relaunch(job.runtime_id).await?;
            let agent = f.agent_token(job.runtime_id, lease_id)?;

            // The agent could not start it: members see why, on one line.
            let (status, _) = f.wake(0, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            let (_, claimed) = f.claim(&agent).await?;
            let wake_id = claimed["restarts"][0]["wakeId"]
                .as_str()
                .context("wakeId")?
                .to_string();
            let other = f.job(None).await?;
            let (status, _) = f
                .report(
                    &f.agent_token(other.runtime_id, other.lease_id)?,
                    &wake_id,
                    json!({ "ok": true }),
                )
                .await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "another runtime's report");
            let (status, result) = f
                .report(
                    &agent,
                    &wake_id,
                    json!({ "ok": false, "error": "python3: not found\n(exit 127)" }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            // The claim reconnected the tunnel, so the grant is live, but the
            // site does not answer: members see the failure and why at once
            // (not a 150 s wait that ends in "taking too long").
            assert_eq!(result["state"], "failed", "{result}");
            assert_eq!(result["error"], "python3: not found (exit 127)");
            f.broker
                .silent_probes
                .store(100, std::sync::atomic::Ordering::SeqCst);
            let failed = f.get_preview(&preview_id).await?;
            assert_eq!(failed["status"], "active", "{failed}");
            assert_eq!(failed["wake"]["state"], "failed", "{failed}");
            assert_eq!(failed["wake"]["error"], "python3: not found (exit 127)");
            f.broker
                .silent_probes
                .store(0, std::sync::atomic::Ordering::SeqCst);
            // Once the site answers, the old failure is gone.
            assert_eq!(f.get_preview(&preview_id).await?["wake"]["state"], "idle");
            let db = f.state.pool.get().await?;
            db.execute(
                "update runtime_tunnel_grants set status = 'revoked' where tunnel_id = $1",
                &[&preview_id],
            )
            .await?;
            let failed = f.get_preview(&preview_id).await?;
            assert_eq!(failed["wake"]["state"], "failed");

            // Reported fine, yet nothing answers through the tunnel.
            let (status, _) = f.wake(0, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            let (_, claimed) = f.claim(&agent).await?;
            let wake_id = claimed["restarts"][0]["wakeId"]
                .as_str()
                .context("wakeId")?
                .to_string();
            f.broker
                .silent_probes
                .store(100, std::sync::atomic::Ordering::SeqCst);
            let (_, _) = f.report(&agent, &wake_id, json!({ "ok": true })).await?;
            let state: String = db
                .query_one(
                    "select state from runtime_preview_wakes where id = $1",
                    &[&Uuid::parse_str(&wake_id)?],
                )
                .await?
                .get(0);
            assert_eq!(state, "failed");
            f.broker
                .silent_probes
                .store(0, std::sync::atomic::Ordering::SeqCst);

            // A wake nobody claims in time fails; so does one claimed three
            // times without a report.
            db.execute(
                "update runtime_tunnel_grants set status = 'revoked' where tunnel_id = $1",
                &[&preview_id],
            )
            .await?;
            db.execute(
                "update runtime_preview_wakes set created_at = created_at - interval '1 hour'
                 where tunnel_id = $1",
                &[&preview_id],
            )
            .await?;
            let (status, _) = f.wake(0, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            db.execute(
                "update runtime_preview_wakes set created_at = now() - interval '11 minutes'
                 where tunnel_id = $1 and state = 'pending'",
                &[&preview_id],
            )
            .await?;
            let timed_out = f.get_preview(&preview_id).await?;
            assert_eq!(timed_out["wake"]["state"], "failed");
            assert_eq!(
                timed_out["wake"]["error"],
                "the space did not start in time"
            );
            let (_, claimed) = f.claim(&agent).await?;
            assert_eq!(
                claimed["restarts"],
                json!([]),
                "a timed-out wake is not claimed"
            );

            let (status, _) = f.wake(0, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            db.execute(
                "update runtime_preview_wakes
                 set state = 'claimed', claim_count = 3, claimed_at = now() - interval '4 minutes'
                 where tunnel_id = $1 and state = 'pending'",
                &[&preview_id],
            )
            .await?;
            assert_eq!(f.get_preview(&preview_id).await?["wake"]["state"], "failed");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn viewing_by_members_who_may_change_the_space_is_activity_for_four_hours(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            // A view-only member's viewing keeps nothing awake: they may not
            // start the machine either, and the space pays for it.
            f.clear_activity().await?;
            let (readonly_url, readonly_label) = f.view(2, &preview_id).await?;
            assert_eq!(f.activity_at().await?, None, "a view-only member's Open");
            // Past the once-a-minute debounce, so the heartbeat would count.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_preview_sessions set last_used_at = now() - interval '2 minutes'
                     where capability_hash = $1",
                    &[&capability_hash(&readonly_label)],
                )
                .await?;
            let (status, _) = f
                .request(
                    &f.tokens[2],
                    "POST",
                    &f.path(&format!("/{preview_id}/view/heartbeat")),
                    json!({ "viewerUrl": readonly_url }),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert_eq!(f.activity_at().await?, None, "a view-only member's heartbeat");
            crate::previews::sessions::record_viewing_activity(&f.state.pool, &f.project, &f.users[2]).await;
            assert_eq!(f.activity_at().await?, None, "any viewing by a view-only member");

            // Opening it is activity.
            f.clear_activity().await?;
            let (viewer_url, label) = f.view(1, &preview_id).await?;
            assert!(f.activity_at().await?.is_some(), "the Open counts");
            let hash = capability_hash(&label);
            let db = f.state.pool.get().await?;
            let age_session = |hash: String, minutes_used: i64, hours_old: i64| {
                let pool = f.state.pool.clone();
                async move {
                    pool.get()
                        .await?
                        .execute(
                            "update runtime_preview_sessions
                             set last_used_at = now() - make_interval(mins => $2::int),
                                 created_at = now() - make_interval(hours => $3::int)
                             where capability_hash = $1",
                            &[&hash, &(minutes_used as i32), &(hours_old as i32)],
                        )
                        .await?;
                    anyhow::Ok(())
                }
            };
            let idle_minutes = |hash: String| {
                let pool = f.state.pool.clone();
                async move {
                    anyhow::Ok(
                        pool.get()
                            .await?
                            .query_one(
                                "select (extract(epoch from now() - last_used_at) / 60)::float8
                                 from runtime_preview_sessions where capability_hash = $1",
                                &[&hash],
                            )
                            .await?
                            .get::<_, Option<f64>>(0)
                            .unwrap_or(99.0),
                    )
                }
            };
            let age_window = |hours: i32| {
                let pool = f.state.pool.clone();
                let (project, user) = (f.project, f.users[1]);
                async move {
                    pool.get()
                        .await?
                        .execute(
                            "update runtime_preview_viewing_windows
                             set started_at = now() - make_interval(hours => $3)
                             where project_id = $1 and user_id = $2",
                            &[&project, &user, &hours],
                        )
                        .await?;
                    anyhow::Ok(())
                }
            };

            // Requests through the preview (the broker's hook) neither keep a
            // pane's session alive nor count as activity: the label travels
            // in the page's Origin to every third party the site calls, so
            // traffic is not proof that the member is still looking.
            f.clear_activity().await?;
            age_session(hash.clone(), 2, 0).await?;
            forget_viewer_access(&f.users[1], &f.project);
            assert!(f.allowed(&preview_id, &label).await?);
            assert!(idle_minutes(hash.clone()).await? >= 1.9, "the hook only checks");
            assert_eq!(f.activity_at().await?, None, "the hook is not activity");
            age_session(hash.clone(), 31, 0).await?;
            assert!(
                !f.allowed(&preview_id, &label).await?,
                "a pane session whose pane stopped heartbeating idles out, traffic or not"
            );
            age_session(hash.clone(), 2, 0).await?;

            // A session opened for a separate tab has no heartbeat, so its
            // own traffic keeps it alive (and counts).
            let (status, tab) = f
                .request(&f.tokens[1], "POST", &f.path(&format!("/{preview_id}/view?tab=true")), json!({}))
                .await?;
            assert_eq!(status, StatusCode::OK, "{tab}");
            let tab_host = url::Url::parse(tab["viewerUrl"].as_str().context("viewerUrl")?)?
                .host_str()
                .context("host")?
                .to_string();
            let (tab_label, _) = parse_viewer_host(&tab_host).context("tab label")?;
            age_session(capability_hash(&tab_label), 2, 0).await?;
            f.clear_activity().await?;
            assert!(f.allowed(&preview_id, &tab_label).await?);
            assert!(idle_minutes(capability_hash(&tab_label)).await? < 1.0, "a tab session is kept by use");
            assert!(f.activity_at().await?.is_some(), "the tab's traffic counts");

            // The open pane's heartbeat is what counts and keeps the session.
            f.clear_activity().await?;
            let heartbeat = f.path(&format!("/{preview_id}/view/heartbeat"));
            let beat = |url: String| {
                let heartbeat = heartbeat.clone();
                let f = f.clone();
                async move {
                    let (status, _) = f
                        .request(&f.tokens[1], "POST", &heartbeat, json!({ "viewerUrl": url }))
                        .await?;
                    anyhow::Ok(status)
                }
            };
            assert_eq!(beat(viewer_url.clone()).await?, StatusCode::NO_CONTENT);
            assert!(f.activity_at().await?.is_some(), "the heartbeat counts");
            age_session(hash.clone(), 29, 0).await?;
            assert_eq!(beat(viewer_url.clone()).await?, StatusCode::NO_CONTENT);
            assert!(idle_minutes(hash.clone()).await? < 1.0, "the heartbeat keeps it");
            // Beats within the same minute write nothing.
            f.clear_activity().await?;
            for _ in 0..3 {
                assert_eq!(beat(viewer_url.clone()).await?, StatusCode::NO_CONTENT);
            }
            assert_eq!(f.activity_at().await?, None, "debounced to once a minute");

            // Past four hours of viewing that day, viewing no longer keeps it
            // awake: not the heartbeat, not a new session, not another way in.
            age_window(5).await?;
            f.clear_activity().await?;
            age_session(hash.clone(), 2, 0).await?;
            assert_eq!(beat(viewer_url.clone()).await?, StatusCode::NO_CONTENT);
            assert_eq!(f.activity_at().await?, None, "its heartbeat after 5 h");
            let (fresh_url, _) = f.view(1, &preview_id).await?;
            assert_eq!(f.activity_at().await?, None, "a new Open after 5 h");
            assert_eq!(beat(fresh_url).await?, StatusCode::NO_CONTENT);
            assert_eq!(f.activity_at().await?, None, "the new session's heartbeat");
            crate::previews::sessions::record_viewing_activity(&f.state.pool, &f.project, &f.users[1]).await;
            assert_eq!(
                f.activity_at().await?,
                None,
                "every source of viewing shares the one window, even with no session"
            );
            // Another person's viewing still counts, and so does a new day.
            f.view(0, &preview_id).await?;
            assert!(f.activity_at().await?.is_some(), "another member");
            f.clear_activity().await?;
            age_window(25).await?;
            f.view(1, &preview_id).await?;
            assert!(f.activity_at().await?.is_some(), "the next day");

            // Someone else's session, or a revoked one, is gone (410).
            let (status, _) = f
                .request(
                    &f.tokens[0],
                    "POST",
                    &heartbeat,
                    json!({ "viewerUrl": viewer_url }),
                )
                .await?;
            assert_eq!(status, StatusCode::GONE);
            let (status, _) = f
                .request(
                    &f.tokens[1],
                    "POST",
                    &f.path(&format!("/{preview_id}/view/revoke")),
                    json!({ "viewerUrl": viewer_url }),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert_eq!(beat(viewer_url.clone()).await?, StatusCode::GONE);

            // A member removed from the space loses the heartbeat too, and
            // with it the session.
            let (member_url, member_label) = f.view(1, &preview_id).await?;
            age_session(capability_hash(&member_label), 2, 0).await?;
            db.execute(
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&f.project, &f.users[1]],
            )
            .await?;
            forget_viewer_access(&f.users[1], &f.project);
            f.clear_activity().await?;
            assert_eq!(beat(member_url).await?, StatusCode::GONE, "removed member");
            assert_eq!(f.activity_at().await?, None, "keeps nothing awake");
            let revoked: bool = db
                .query_one(
                    "select revoked_at is not null from runtime_preview_sessions where capability_hash = $1",
                    &[&capability_hash(&member_label)],
                )
                .await?
                .get(0);
            assert!(revoked, "the removed member's session is revoked");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn an_expired_preview_reconnects_without_reviving_its_old_viewer_sessions(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            let (_, old_label) = f.view(0, &preview_id).await?;
            assert!(f.allowed(&preview_id, &old_label).await?);
            // Past its 12 h: still `active`, never revoked, so its sessions
            // were never ended either.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_tunnel_grants set expires_at = now() - interval '1 minute'
                     where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?;
            assert_eq!(f.get_preview(&preview_id).await?["status"], "expired");
            let (status, body) = f.wake(2, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{body}");
            let agent = f.agent_token(job.runtime_id, job.lease_id)?;
            let (_, claimed) = f.claim(&agent).await?;
            assert_eq!(claimed["restarts"][0]["previewId"], json!(preview_id));
            assert_eq!(f.get_preview(&preview_id).await?["status"], "active");
            assert!(
                !f.allowed(&preview_id, &old_label).await?,
                "a capability minted before it expired came back"
            );
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn members_never_see_the_start_command_and_a_revoke_cannot_move_the_port_a_wake_uses(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let mut body = f.open_body(&job, 4173);
            // A command line is private to the space (paths, names): only the
            // runtime gets it. (One that looks like it carries a secret is not
            // recorded at all: see serve.rs.)
            body["serve"] = json!({ "argv": ["node", "server.js", "--data-dir", "private-marker-7f3a"], "cwd": "site" });
            let (status, created) = f.request(&job.token, "POST", &f.path(""), body).await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let preview_id = created["previewId"].as_str().context("previewId")?.to_string();
            // Stored for the wake…
            assert_eq!(
                f.grant_metadata(&preview_id).await?[PREVIEW_TUNNEL_METADATA_KEY]["serve"]["argv"][3],
                "private-marker-7f3a"
            );
            // …but no member's tunnel list carries it (nor the broker key).
            let (status, list) = f
                .request(
                    &f.tokens[2],
                    "GET",
                    &format!("/projects/{}/tunnels", f.project),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{list}");
            assert!(!list.to_string().contains("private-marker-7f3a"), "{list}");
            let grant = list["grants"]
                .as_array()
                .context("grants")?
                .iter()
                .find(|grant| grant["tunnelId"] == json!(preview_id))
                .cloned()
                .context("the preview is listed")?;
            let preview = &grant["metadata"][PREVIEW_TUNNEL_METADATA_KEY];
            assert!(preview.is_object(), "{grant}");
            for key in ["serve", "wakeId"] {
                assert!(grant["metadata"].get(key).is_none(), "{key}: {grant}");
                assert!(preview.get(key).is_none(), "{key}: {grant}");
            }

            // A builder's revoke override cannot move the port a wake
            // reconnects to (or its source); other notes are kept.
            let (status, result) = f
                .request(
                    &f.tokens[1],
                    "POST",
                    &format!("/projects/{}/tunnels/{preview_id}/revoke", f.project),
                    json!({ "metadata": {
                        "localPort": 9222,
                        "source": "x",
                        "note": "kept",
                        // Nor swap the command a wake runs on the runtime.
                        "serve": { "argv": ["sh", "-c", "evil"], "cwd": "." },
                        (PREVIEW_TUNNEL_METADATA_KEY): {
                            "serve": { "argv": ["sh", "-c", "evil"], "cwd": "." },
                        },
                    } }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            assert!(
                result["metadata"][PREVIEW_TUNNEL_METADATA_KEY]
                    .get("serve")
                    .is_none(),
                "{result}"
            );
            let metadata = f.grant_metadata(&preview_id).await?;
            assert_eq!(metadata["localPort"], json!(4173), "{metadata}");
            assert_ne!(metadata["source"], json!("x"), "{metadata}");
            assert_eq!(metadata["note"], "kept");
            assert_eq!(
                metadata[PREVIEW_TUNNEL_METADATA_KEY]["serve"]["argv"][0],
                "node",
                "{metadata}"
            );

            // A stored port the open route refuses is never reconnected.
            let db = f.state.pool.get().await?;
            db.execute(
                "update runtime_tunnel_grants
                 set metadata = jsonb_set(metadata, '{localPort}', '9222'::jsonb)
                 where tunnel_id = $1",
                &[&preview_id],
            )
            .await?;
            f.stop_runtime_like_the_idle_sweep(&job).await?;
            let lease_id = f.relaunch(job.runtime_id).await?;
            let agent = f.agent_token(job.runtime_id, lease_id)?;
            let (status, _) = f.wake(0, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            let (status, claimed) = f.claim(&agent).await?;
            assert_eq!(status, StatusCode::OK, "{claimed}");
            assert_eq!(claimed["restarts"], json!([]), "{claimed}");
            let error: Option<String> = db
                .query_one(
                    "select error from runtime_preview_wakes where tunnel_id = $1
                     order by created_at desc limit 1",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert!(
                error.as_deref().is_some_and(|error| error.contains("not allowed on port 9222")),
                "{error:?}"
            );
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn the_restart_channel_is_not_offered_where_previews_are_off() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let agent = f.agent_token(job.runtime_id, job.lease_id)?;
            let (status, body) = f.claim(&agent).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            // Unconfigured, the agent hears "not offered here" and backs off.
            let mut state = f.state.clone();
            state.config.previews = PreviewSettings::default();
            let app = router().with_state(state);
            let (status, body) = f
                .request_on(
                    &app,
                    &agent,
                    "POST",
                    "/agent/preview-restarts/claim",
                    json!({}),
                )
                .await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_private_computer_that_is_offline_fails_its_wake_at_once_without_a_launch(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            f.stop_runtime_like_the_idle_sweep(&job).await?;
            // The space runs on its owner's own computer.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtimes set capabilities = $2 where id = $1",
                    &[
                        &job.runtime_id,
                        &json!({ "_instafySelfHostedAccess": { "mode": "private", "ownerUserId": f.users[0] } }),
                    ],
                )
                .await?;
            let (provider, launches, _provider) = stub_provider().await?;
            let app = f.app_with_provider(&provider);
            let wake_path = f.path(&format!("/{preview_id}/wake"));
            let (status, refused) = f
                .request_on(&app, &f.tokens[0], "POST", &wake_path, json!({}))
                .await?;
            assert_eq!(status, StatusCode::CONFLICT, "{refused}");
            assert_eq!(refused["code"], "runtime_offline", "{refused}");
            let row = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select state, error from runtime_preview_wakes where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?;
            assert_eq!(row.get::<_, String>("state"), "failed");
            assert!(row
                .get::<_, Option<String>>("error")
                .is_some_and(|error| error.contains("offline")));
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            assert_eq!(
                launches.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "nothing here can start someone's computer"
            );
            let (status, preview) = f
                .request_on(&app, &f.tokens[0], "GET", &f.path(&format!("/{preview_id}")), Value::Null)
                .await?;
            assert_eq!(status, StatusCode::OK, "{preview}");
            assert_eq!(preview["wake"]["state"], "failed", "{preview}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_view_only_member_restarts_a_site_on_a_running_machine_and_an_unchecked_restart_is_not_announced_live(
) -> anyhow::Result<()> {
    use std::sync::atomic::Ordering;
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open_restartable(&job).await?;
            // With the machine up, anyone who may view may restart the site.
            assert_eq!(f.get_preview(&preview_id).await?["canStart"], json!(true));

            // The machine is up but the site stopped answering: restarting it
            // costs nothing, so a view-only member may.
            f.broker.silent_probes.store(1_000, Ordering::SeqCst);
            let (status, body) = f.wake(2, &preview_id).await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{body}");
            assert_eq!(body["state"], "waking");
            let agent = f.agent_token(job.runtime_id, job.lease_id)?;
            let (status, claimed) = f.claim(&agent).await?;
            assert_eq!(status, StatusCode::OK, "{claimed}");
            let restarts = claimed["restarts"].as_array().context("restarts")?;
            assert_eq!(restarts.len(), 1, "{claimed}");
            let wake_id = restarts[0]["wakeId"]
                .as_str()
                .context("wakeId")?
                .to_string();

            // The agent says it worked, but the broker cannot be asked: the
            // wake ends without telling anyone the site is live.
            f.broker.silent_probes.store(0, Ordering::SeqCst);
            f.broker.probe_fails.store(true, Ordering::SeqCst);
            let mut events = f.state.events.subscribe();
            let (status, result) = f.report(&agent, &wake_id, json!({ "ok": true })).await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            let event = std::iter::from_fn(|| events.try_recv().ok())
                .find(|event| event.kind == "preview.wake")
                .context("preview.wake event")?;
            assert_eq!(event.data["state"], "unverified", "{:?}", event.data);
            let state: String = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select state from runtime_preview_wakes where id = $1",
                    &[&Uuid::parse_str(&wake_id)?],
                )
                .await?
                .get(0);
            assert_eq!(state, "done");
            f.broker.probe_fails.store(false, Ordering::SeqCst);
            Ok(())
        })
    })
    .await
}
