use super::*;

async fn request_settings(
    app: &axum::Router,
    project_id: Uuid,
    token: Option<&str>,
    patch: Option<serde_json::Value>,
) -> anyhow::Result<axum::response::Response> {
    let mut request = Request::builder()
        .method(if patch.is_some() { "PATCH" } else { "GET" })
        .uri(format!("/projects/{project_id}/multi-agent-settings"));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = match patch {
        Some(value) => {
            request = request.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    Ok(app.clone().oneshot(request.body(body)?).await?)
}

async fn settings_json(response: axum::response::Response) -> anyhow::Result<serde_json::Value> {
    assert_eq!(response.status(), StatusCode::OK);
    Ok(serde_json::from_slice(
        &to_bytes(response.into_body(), 16 * 1024).await?,
    )?)
}

#[tokio::test]
async fn multi_agent_settings_http_enforces_membership_and_preserves_shared_limits(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("multi-agent settings HTTP permissions").await?;
    let [owner_id, admin_id, builder_id, viewer_id, outsider_id] =
        std::array::from_fn(|_| Uuid::new_v4());
    let project_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let users = [owner_id, admin_id, builder_id, viewer_id, outsider_id];
    {
        let db = pool.get().await?;
        for user_id in users {
            db.execute(
                "insert into auth.users (id, email, created_at, updated_at) values ($1, $2, now(), now())",
                &[&user_id, &format!("agent-settings-{user_id}@example.invalid")],
            ).await?;
        }
        db.execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'Agent settings test')",
            &[&org_id, &format!("agent-settings-{org_id}")],
        )
        .await?;
        db.execute(
            "insert into projects (id, org_id, owner_user_id, name, project_type, status)
             values ($1, $2, $3, 'Agent settings test', 'customer', 'active')",
            &[&project_id, &org_id, &owner_id],
        )
        .await?;
        db.execute(
            "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'admin')",
            &[&org_id, &admin_id],
        )
        .await?;
        for (user, role) in [(builder_id, "builder"), (viewer_id, "viewer")] {
            db.execute(
                "insert into project_memberships (project_id, user_id, role) values ($1, $2, $3)",
                &[&project_id, &user, &role],
            )
            .await?;
        }
    }
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "multi-agent-settings-test",
    );
    let token = |user| -> anyhow::Result<String> {
        Ok(crate::auth::issue_controller_token(&config, &user)
            .map_err(|e| controller_error("settings user token", e))?
            .token)
    };
    let owner = token(owner_id)?;
    let admin = token(admin_id)?;
    let builder = token(builder_id)?;
    let viewer = token(viewer_id)?;
    let outsider = token(outsider_id)?;
    let runtime_id = Uuid::new_v4().to_string();
    // Even a manager's subject must not turn a narrow job capability into a settings login.
    let scoped = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: runtime_id.clone(),
            subject: owner_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id),
            protocol: None,
            scopes: vec![
                "agent.lease".into(),
                "agent.complete".into(),
                "fs.write".into(),
            ],
            lease_id: None,
            run_id: Some(Uuid::new_v4().to_string()),
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|e| controller_error("settings scoped token", e))?
    .token;
    let state = build_test_state(pool.clone(), config);
    let app = crate::multi_agent_settings::router().with_state(state.clone());
    let dispatch_app = dispatch::router().with_state(state);

    let result = with_shared_db_fixture(
        SharedDbFixture { projects: vec![project_id], organizations: vec![org_id] },
        async {
            for (token, can_manage) in [(&owner, true), (&admin, true), (&builder, false), (&viewer, false)] {
                let body = settings_json(request_settings(&app, project_id, Some(token), None).await?).await?;
                assert_eq!(body, json!({
                    "maxAgentsPerPlan":64, "maxConcurrentAgents":8, "canManage":can_manage,
                    "limits": {
                        "maxAgentsPerPlan":{"min":1,"max":256,"default":64},
                        "maxConcurrentAgents":{"min":1,"max":64,"default":8}
                    }
                }));
            }
            for (token, status) in [(None, StatusCode::UNAUTHORIZED), (Some(outsider.as_str()), StatusCode::FORBIDDEN), (Some(scoped.as_str()), StatusCode::FORBIDDEN)] {
                assert_eq!(request_settings(&app, project_id, token, None).await?.status(), status);
            }
            for token in [&builder, &viewer, &outsider, &scoped] {
                assert_eq!(request_settings(&app, project_id, Some(token), Some(json!({"maxConcurrentAgents":64}))).await?.status(), StatusCode::FORBIDDEN);
            }
            let updated = settings_json(request_settings(&app, project_id, Some(&owner), Some(json!({"maxConcurrentAgents":3}))).await?).await?;
            assert_eq!(updated["maxAgentsPerPlan"], 64);
            assert_eq!(updated["maxConcurrentAgents"], 3);
            let updated = settings_json(request_settings(&app, project_id, Some(&admin), Some(json!({"maxAgentsPerPlan":128}))).await?).await?;
            assert_eq!(updated["maxAgentsPerPlan"], 128);
            assert_eq!(updated["maxConcurrentAgents"], 3);

            for (patch, status) in [
                (json!({}), StatusCode::BAD_REQUEST),
                (json!({"maxAgentsPerPlan":0}), StatusCode::BAD_REQUEST),
                (json!({"maxAgentsPerPlan":257}), StatusCode::BAD_REQUEST),
                (json!({"maxConcurrentAgents":65}), StatusCode::BAD_REQUEST),
                (json!({"maxAgentsPerPlan":null}), StatusCode::UNPROCESSABLE_ENTITY),
                (json!({"maxConcurrentAgents":-1}), StatusCode::UNPROCESSABLE_ENTITY),
                (json!({"maxConcurrentAgents":1.5}), StatusCode::UNPROCESSABLE_ENTITY),
                (json!({"maxConcurrentAgents":"4"}), StatusCode::UNPROCESSABLE_ENTITY),
                (json!({"maxAgentsPerPlan":256,"unexpected":true}), StatusCode::UNPROCESSABLE_ENTITY),
            ] {
                assert_eq!(request_settings(&app, project_id, Some(&owner), Some(patch.clone())).await?.status(), status, "invalid patch: {patch}");
            }
            let shared = settings_json(request_settings(&app, project_id, Some(&viewer), None).await?).await?;
            assert_eq!(shared["maxAgentsPerPlan"], 128);
            assert_eq!(shared["maxConcurrentAgents"], 3);
            assert_eq!(shared["canManage"], false);

            // Concurrent partial updates serialize without restoring the other field's stale value.
            let (plan, concurrency) = tokio::join!(
                request_settings(&app, project_id, Some(&owner), Some(json!({"maxAgentsPerPlan":256}))),
                request_settings(&app, project_id, Some(&admin), Some(json!({"maxConcurrentAgents":64})))
            );
            assert_eq!(plan?.status(), StatusCode::OK);
            assert_eq!(concurrency?.status(), StatusCode::OK);
            let shared = settings_json(request_settings(&app, project_id, Some(&viewer), None).await?).await?;
            assert_eq!(shared["maxAgentsPerPlan"], 256);
            assert_eq!(shared["maxConcurrentAgents"], 64);

            let service = settings_json(request_settings(&app, project_id, Some("service-role-token"), Some(json!({"maxConcurrentAgents":1}))).await?).await?;
            assert_eq!(service["maxAgentsPerPlan"], 256);
            assert_eq!(service["maxConcurrentAgents"], 1);
            let db = pool.get().await?;
            let stored = db.query_one("select max_agents_per_plan, max_concurrent_agents, updated_by from project_multi_agent_settings where project_id=$1", &[&project_id]).await?;
            assert_eq!(stored.get::<_, i32>("max_agents_per_plan"), 256);
            assert_eq!(stored.get::<_, i32>("max_concurrent_agents"), 1);
            assert!(stored.get::<_, Option<Uuid>>("updated_by").is_none());
            drop(db);

            // Direct team dispatch must enforce the authoritative limit too,
            // including the legacy role spelling and untrusted client snapshots.
            settings_json(request_settings(&app, project_id, Some(&owner), Some(json!({"maxAgentsPerPlan":1}))).await?).await?;
            let db = pool.get().await?;
            let jobs_before: i64 = db.query_one("select count(*) from agent_jobs where project_id=$1", &[&project_id]).await?.get(0);
            drop(db);
            for (intent, plan_key, role) in [
                ("feature", Some("multiAgentPlan"), "worker"),
                ("feature", Some("multi_agent_plan"), " worker "),
                ("multi_agent_plan", None, ""),
            ] {
                let mut metadata = json!({
                    "agentSelection":{"active":["poet-one","poet-two"],"mentions":["poet-one","poet-two"]},
                    "multiAgentSettings":{"maxAgentsPerPlan":256,"maxConcurrentAgents":64}
                });
                if let Some(key) = plan_key {
                    metadata[key] = json!({"role":role,"groupId":Uuid::new_v4()});
                }
                let response = dispatch_app.clone().oneshot(Request::builder()
                    .method("POST")
                    .uri("/dispatch-prompt")
                    .header("authorization",format!("Bearer {owner}"))
                    .header("content-type","application/json")
                    .body(Body::from(json!({
                        "projectId":project_id,"promptText":"Each agent writes a poem.",
                        "intent":intent,"metadata":metadata
                    }).to_string()))?).await?;
                let status = response.status();
                let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(),16*1024).await?)?;
                assert_eq!(status,StatusCode::BAD_REQUEST,"dispatch {plan_key:?}: {body}");
                assert_eq!(body["code"],"multi_agent_plan_invalid");
                assert_eq!(body["details"],json!({"requested":2,"maxAgentsPerPlan":1}));
                let db = pool.get().await?;
                let jobs_after: i64 = db.query_one("select count(*) from agent_jobs where project_id=$1", &[&project_id]).await?.get(0);
                assert_eq!(jobs_after,jobs_before,"over-limit dispatch must not enqueue partial work");
            }
            Ok(())
        },
    ).await;
    for user in users {
        cleanup_test_user(&pool, &user).await?;
    }
    result
}

#[tokio::test]
async fn expired_worker_heartbeat_reacquires_capacity_without_interrupting_active_jobs(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("worker heartbeat capacity").await?;
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let runtime_owner = Uuid::new_v4();
    let [expired, active, other_active, root, lead] = std::array::from_fn(|_| Uuid::new_v4());
    {
        let db = pool.get().await?;
        db.execute(
            "insert into projects (id, project_type, status) values ($1,'customer','active')",
            &[&project_id],
        )
        .await?;
        db.execute(
            "insert into runtimes (id,project_id,provider,status,last_seen_at,capabilities)
                    values ($1,$2,'self-hosted','ready',now(),$3)",
            &[
                &runtime_id,
                &project_id,
                &json!({"_instafySelfHostedAccess":{"mode":"private","ownerUserId":runtime_owner}}),
            ],
        )
        .await?;
        db.execute("insert into project_multi_agent_settings (project_id,max_concurrent_agents) values ($1,1)", &[&project_id]).await?;
        for (id, role) in [
            (expired, "worker"),
            (root, "root"),
            (lead, "lead_continuation"),
        ] {
            db.execute("insert into agent_jobs (id,project_id,status,payload,agent_role,leased_by_runtime_id,lease_expires_at)
                        values ($1,$2,'leased',$3,$4,$5,now()-interval '1 second')",
                &[&id,&project_id,&json!({"metadata":{"multiAgentPlan":{"role":role}}}),
                  &(if id == expired { None } else { Some(role) }),&runtime_id]).await?;
        }
        db.execute("insert into agent_jobs (id,project_id,status,payload,agent_role) values ($1,$2,'queued',$3,'worker')", &[&active,&project_id,&json!({"user_id":runtime_owner})]).await?;
    }
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "heartbeat-capacity",
    );
    let token = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: runtime_id.to_string(),
            subject: "agent:test".into(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: vec!["agent.heartbeat".into()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|e| controller_error("heartbeat capacity token", e))?
    .token;
    let app = agent::router().with_state(build_test_state(pool.clone(), config));
    let heartbeat = |job_id: Uuid| {
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/heartbeat")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"job_id":job_id,"extend_seconds":60}).to_string(),
                ))
                .unwrap(),
        )
    };
    with_shared_db_fixture(SharedDbFixture { projects: vec![project_id], ..Default::default() }, async {
        let lease_worker = || async {
            let mut db = pool.get().await?;
            let tx = db.transaction().await?;
            let job = agent::lease_next_agent_job(&tx,&project_id,Some(&runtime_id),120,true,false,false,false,None,None,false)
                .await.map_err(|e| controller_error("lease replacement worker",e))?;
            tx.commit().await?;
            Ok::<_,anyhow::Error>(job.map(|job|job.id))
        };
        // An expired lease freed this slot. Its delayed heartbeat must not reclaim it now.
        assert_eq!(lease_worker().await?, Some(active));
        assert_eq!(heartbeat(expired).await?.status(), StatusCode::CONFLICT);
        assert_eq!(heartbeat(active).await?.status(), StatusCode::OK);
        for coordinator in [root,lead] {
            assert_eq!(heartbeat(coordinator).await?.status(),StatusCode::OK);
        }

        // Reproduce a manager lowering the limit below work that already started.
        {
            let db = pool.get().await?;
            db.execute("update project_multi_agent_settings set max_concurrent_agents=2 where project_id=$1", &[&project_id]).await?;
            db.execute("insert into agent_jobs (id,project_id,status,payload,agent_role) values ($1,$2,'queued',$3,'worker')", &[&other_active,&project_id,&json!({"user_id":runtime_owner})]).await?;
        }
        assert_eq!(lease_worker().await?, Some(other_active));
        {
            let db = pool.get().await?;
            db.execute("update project_multi_agent_settings set max_concurrent_agents=1 where project_id=$1", &[&project_id]).await?;
        }
        assert_eq!(heartbeat(active).await?.status(), StatusCode::OK);
        assert_eq!(heartbeat(other_active).await?.status(), StatusCode::OK);
        assert_eq!(heartbeat(expired).await?.status(), StatusCode::CONFLICT);

        // Finishing those workers allows the expired worker to rejoin the budget.
        {
            let db = pool.get().await?;
            db.execute("update agent_jobs set status='completed' where id=any($1)", &[&vec![active,other_active]]).await?;
        }
        assert_eq!(heartbeat(expired).await?.status(), StatusCode::OK);

        // A transaction that started earlier must use admission time, not its old now().
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        tx.query_one("select now()", &[]).await?;
        assert!(!crate::multi_agent_settings::worker_slot_available(&tx,&project_id,None)
            .await.map_err(|e| controller_error("occupied worker capacity",e))?);
        assert!(crate::multi_agent_settings::worker_slot_available(&tx,&project_id,Some(&expired))
            .await.map_err(|e| controller_error("renewing worker retains its slot",e))?);
        {
            let other_db = pool.get().await?;
            other_db.execute("update agent_jobs set lease_expires_at=clock_timestamp() where id=$1", &[&expired]).await?;
        }
        assert!(crate::multi_agent_settings::worker_slot_available(&tx,&project_id,None)
            .await.map_err(|e| controller_error("current admission time",e))?);
        tx.rollback().await?;
        Ok(())
    }).await
}
