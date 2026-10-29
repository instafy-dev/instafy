use super::*;
use crate::research_budget;
use runtime_contracts::research::{ResearchSettings, RESEARCH_RESERVE_SCOPE};
use serde_json::Value;

async fn budget_request(
    app: &axum::Router,
    token: &str,
    reservation: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let mut request = Request::builder()
        .method(if reservation.is_some() { "POST" } else { "GET" })
        .uri("/agent/research-budget")
        .header("authorization", format!("Bearer {token}"));
    let body = if let Some(value) = reservation {
        request = request.header("content-type", "application/json");
        Body::from(value.to_string())
    } else {
        Body::empty()
    };
    let response = app.clone().oneshot(request.body(body)?).await?;
    Ok((
        response.status(),
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await?)?,
    ))
}
fn reservation(host: &str) -> Value {
    json!({"loadId":Uuid::new_v4(),"requestId":Uuid::new_v4(),"host":host,"remainingMs":60000})
}

#[tokio::test]
async fn research_legacy_siblings_and_nested_jobs_share_one_immutable_pool() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("legacy research hierarchy").await?;
    let project = Uuid::new_v4();
    let jobs: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
    let settings = ResearchSettings {
        max_page_loads: 3,
        max_page_loads_per_site: 2,
    };
    with_shared_db_fixture(
        SharedDbFixture {
            projects: vec![project],
            ..Default::default()
        },
        async {
            {
                let mut db = pool.get().await?;
                let tx = db.transaction().await?;
                tx.execute(
                    "insert into projects(id,project_type,status) values($1,'customer','active')",
                    &[&project],
                )
                .await?;
                for (index, parent) in [None, Some(jobs[0]), Some(jobs[0]), Some(jobs[2]), Some(jobs[3]), None]
                    .into_iter()
                    .enumerate()
                {
                    // The last job has only an untrusted metadata parent, and must stay separate.
                    tx.execute(
                        "insert into agent_jobs(id,project_id,parent_job_id,payload) values($1,$2,$3,$4)",
                        &[&jobs[index], &project, &parent, &json!({"metadata":{"multiAgentPlan":{"parentJobId":jobs[0]}}})],
                    )
                    .await?;
                }
                tx.execute(
                    "insert into project_research_settings(project_id,max_page_loads,max_page_loads_per_site) values($1,3,2)",
                    &[&project],
                )
                .await?;
                tx.commit().await?;
            }

            // The first settings fetches happen on two runtimes at once, before the root or
            // either branch has any binding. Each transaction must commit without a deadlock.
            let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
            let bind = |job| {
                let pool = pool.clone();
                let barrier = barrier.clone();
                async move {
                    let mut db = pool.get().await?;
                    let tx = db.transaction().await?;
                    tx.batch_execute("set local lock_timeout = '5s'").await?;
                    barrier.wait().await;
                    assert_eq!(
                        research_budget::job_settings(&tx, project, job)
                            .await
                            .map_err(|e| controller_error("legacy research settings", e))?,
                        settings
                    );
                    let budget = research_budget::bind_job(&tx, project, job, None)
                        .await
                        .map_err(|e| controller_error("legacy research binding", e))?;
                    tx.commit().await?;
                    Ok::<_, anyhow::Error>(budget)
                }
            };
            let (sibling, nested) = tokio::join!(bind(jobs[1]), bind(jobs[3]));
            let budget = sibling?;
            assert_eq!(budget, nested?);

            let mut db = pool.get().await?;
            let tx = db.transaction().await?;
            let bound: i64 = tx
                .query_one(
                    "select count(*) from agent_job_research_budgets where job_id=any($1) and budget_id=$2",
                    &[&jobs[..4].to_vec(), &budget],
                )
                .await?
                .get(0);
            assert_eq!(bound, 4, "both branches and their root must share the pool");
            assert_eq!(
                tx.query_one("select count(*) from agent_research_budgets where project_id=$1", &[&project])
                    .await?
                    .get::<_, i64>(0),
                1
            );
            let spent = json!({"loads":{Uuid::new_v4().to_string():{"hosts":["example.com"],"hops":1}},"hosts":{"example.com":{"loads":1,"lastAt":1000}},"grants":{}});
            tx.execute("update agent_research_budgets set state=$2 where id=$1", &[&budget, &spent]).await?;
            tx.execute("update project_research_settings set max_page_loads=20,max_page_loads_per_site=8 where project_id=$1", &[&project]).await?;
            assert_eq!(
                research_budget::job_settings(&tx, project, jobs[4])
                    .await
                    .map_err(|e| controller_error("late legacy research settings", e))?,
                settings,
                "a later descendant must retain the original snapshot"
            );
            assert_eq!(
                research_budget::bind_job(&tx, project, jobs[4], None)
                    .await
                    .map_err(|e| controller_error("late legacy research binding", e))?,
                budget
            );
            assert_eq!(
                tx.query_one("select state from agent_research_budgets where id=$1", &[&budget])
                    .await?
                    .get::<_, Value>(0),
                spent,
                "lazy inheritance must not replenish a spent pool"
            );
            let separate = research_budget::bind_job(&tx, project, jobs[5], None)
                .await
                .map_err(|e| controller_error("metadata-only research parent", e))?;
            assert_ne!(separate, budget);
            assert!(research_budget::bind_job(&tx, project, jobs[4], Some(jobs[5]))
                .await
                .is_err());
            assert_eq!(
                research_budget::bind_job(&tx, project, jobs[4], None)
                    .await
                    .map_err(|e| controller_error("immutable legacy research binding", e))?,
                budget
            );
            tx.commit().await?;
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn research_legacy_invalid_ancestry_creates_no_partial_bindings() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("invalid legacy research hierarchy").await?;
    let project = Uuid::new_v4();
    let other_project = Uuid::new_v4();
    with_shared_db_fixture(
        SharedDbFixture {
            projects: vec![project, other_project],
            ..Default::default()
        },
        async {
            let mut db = pool.get().await?;
            let tx = db.transaction().await?;
            tx.execute(
                "insert into projects(id,project_type,status) select unnest($1::uuid[]),'customer','active'",
                &[&vec![project, other_project]],
            )
            .await?;
            let cycle = [Uuid::new_v4(), Uuid::new_v4()];
            let foreign_parent = Uuid::new_v4();
            let foreign_child = Uuid::new_v4();
            for (job, job_project) in [
                (cycle[0], project),
                (cycle[1], project),
                (foreign_parent, other_project),
                (foreign_child, project),
            ] {
                tx.execute("insert into agent_jobs(id,project_id) values($1,$2)", &[&job, &job_project]).await?;
            }
            for (child, parent) in [(cycle[0], cycle[1]), (cycle[1], cycle[0]), (foreign_child, foreign_parent)] {
                tx.execute("update agent_jobs set parent_job_id=$2 where id=$1", &[&child, &parent]).await?;
            }
            let deep: Vec<Uuid> = (0..129).map(|_| Uuid::new_v4()).collect();
            tx.execute(
                "insert into agent_jobs(id,project_id,parent_job_id)
                 select id,$2,case when n=1 then null else ($1::uuid[])[(n-1)::int] end
                 from unnest($1::uuid[]) with ordinality as chain(id,n)",
                &[&deep, &project],
            )
            .await?;
            for job in [cycle[0], foreign_child, *deep.last().unwrap()] {
                assert_eq!(
                    research_budget::bind_job(&tx, project, job, None)
                        .await
                        .unwrap_err()
                        .0,
                    StatusCode::BAD_REQUEST
                );
            }
            assert_eq!(
                tx.query_one("select count(*) from agent_research_budgets where project_id=any($1)", &[&vec![project, other_project]])
                    .await?
                    .get::<_, i64>(0),
                0
            );
            assert_eq!(
                tx.query_one("select count(*) from agent_job_research_budgets b join agent_jobs j on j.id=b.job_id where j.project_id=any($1)", &[&vec![project, other_project]])
                    .await?
                    .get::<_, i64>(0),
                0
            );
            tx.commit().await?;
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn research_shared_pool_is_atomic_snapshotted_and_bound_to_active_jobs() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool("shared research budget").await?;
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let project = Uuid::new_v4();
    let conversation = Uuid::new_v4();
    let generation = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    let runtimes = [Uuid::new_v4(), Uuid::new_v4()];
    let leases = [Uuid::new_v4(), Uuid::new_v4()];
    let jobs = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    let runs = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "research-budget-test",
    );
    config.credential_keys =
        Some(crate::config::CredentialEncryptionKey::for_test("research budget token").into());
    {
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        tx.execute(
            "insert into auth.users(id,email,created_at,updated_at) values($1,$2,now(),now())",
            &[&owner, &format!("research-{owner}@example.invalid")],
        )
        .await?;
        tx.execute(
            "insert into auth.users(id,email,created_at,updated_at) values($1,$2,now(),now())",
            &[&viewer, &format!("research-{viewer}@example.invalid")],
        )
        .await?;
        tx.execute("insert into projects(id,owner_user_id,project_type,status) values($1,$2,'customer','active')", &[&project,&owner]).await?;
        tx.execute(
            "insert into project_memberships(project_id,user_id,role) values($1,$2,'viewer')",
            &[&project, &viewer],
        )
        .await?;
        tx.execute("insert into conversations(id,project_id,created_by,visibility) values($1,$2,$3,'public')", &[&conversation,&project,&owner]).await?;
        tx.execute("insert into user_credentials(id,user_id,kind,label,nonce_b64,ciphertext_b64,metadata,is_default) values($1,$2,'openai_api_key','Research route fixture','test-nonce','test-ciphertext','{}',true)", &[&credential_id,&owner]).await?;
        for (runtime, lease) in runtimes.iter().zip(leases.iter()) {
            tx.execute("insert into runtimes(id,project_id,provider,status,capabilities,last_seen_at) values($1,$2,'self-hosted','ready',$3,now())", &[&runtime,&project,&json!({"agent":true,"origin":true,"_instafySelfHostedAccess":{"mode":"private","ownerUserId":owner},"_instafyRuntimeTokenGeneration":generation})]).await?;
            tx.execute("insert into runtime_leases(id,project_id,runtime_id,status,requested_at,launched_at) values($1,$2,$3,'active',now(),now())", &[lease,&project,runtime]).await?;
            tx.execute(
                "update runtimes set active_lease_id=$2 where id=$1",
                &[runtime, lease],
            )
            .await?;
        }
        for (index, job) in jobs.iter().enumerate() {
            tx.execute("insert into runs(id,project_id,status,conversation_id,run_type) values($1,$2,'in_progress',$3,'prompt')", &[&runs[index],&project,&conversation]).await?;
            tx.execute("insert into agent_jobs(id,project_id,run_id,conversation_id,status,leased_by_runtime_id,lease_expires_at,payload) values($1,$2,$3,$4,'leased',$5,now()+interval '10 minutes',$6)", &[job,&project,&runs[index],&conversation,&runtimes[index%2],&json!({"user_id":owner,"conversation_id":conversation,"metadata":{"userId":Uuid::new_v4(),"researchBudget":{"maxPageLoads":200,"maxPageLoadsPerSite":200}}})]).await?;
        }
        tx.execute("insert into project_research_settings(project_id,max_page_loads,max_page_loads_per_site) values($1,3,2)", &[&project]).await?;
        let root = research_budget::bind_job(&tx, project, jobs[0], None)
            .await
            .map_err(|e| controller_error("bind research root", e))?;
        let child = research_budget::bind_job(&tx, project, jobs[1], Some(jobs[0]))
            .await
            .map_err(|e| controller_error("bind research child", e))?;
        assert_eq!(root, child);
        tx.execute("update project_research_settings set max_page_loads=10,max_page_loads_per_site=6 where project_id=$1", &[&project]).await?;
        let next = research_budget::bind_job(&tx, project, jobs[2], None)
            .await
            .map_err(|e| controller_error("bind new research task", e))?;
        assert_ne!(root, next);
        let nested = research_budget::bind_job(&tx, project, jobs[3], Some(jobs[1]))
            .await
            .map_err(|e| controller_error("bind nested research worker", e))?;
        assert_eq!(root, nested);
        assert!(
            research_budget::bind_job(&tx, project, jobs[2], Some(jobs[0]))
                .await
                .is_err()
        );
        assert_eq!(
            research_budget::job_settings(&tx, project, jobs[1])
                .await
                .map_err(|e| controller_error("research snapshot", e))?,
            ResearchSettings {
                max_page_loads: 3,
                max_page_loads_per_site: 2
            }
        );
        let human = crate::auth::RequestContext {
            user_id: Some(owner),
            is_service_role: false,
            scoped_claims: None,
        };
        let state = build_test_state(pool.clone(), config.clone());
        assert!(research_budget::dispatch_parent(
            &tx,
            &state,
            &human,
            &json!({"multiAgentPlan":{"parentJobId":jobs[0]},"researchBudgetId":root})
        )
        .await
        .map_err(|e| controller_error("untrusted research parent", e))?
        .is_none());
        let service = crate::auth::RequestContext {
            is_service_role: true,
            ..human
        };
        assert_eq!(
            research_budget::dispatch_parent(
                &tx,
                &state,
                &service,
                &json!({"multiAgentPlan":{"parentJobId":jobs[0]}})
            )
            .await
            .map_err(|e| controller_error("trusted research parent", e))?,
            Some(jobs[0])
        );
        tx.commit().await?;
    }
    let token = |index: usize, scope: &str, token_generation: Uuid| -> anyhow::Result<String> {
        Ok(crate::tokens::mint_scoped_token_with_runtime_generation(
            &config,
            ScopedTokenRequest {
                audience: runtimes[index % 2].to_string(),
                subject: owner.to_string(),
                project_id: project.to_string(),
                origin_id: None,
                runtime_id: Some(runtimes[index % 2].to_string()),
                protocol: None,
                scopes: vec![scope.into()],
                lease_id: Some(leases[index % 2].to_string()),
                run_id: Some(runs[index].to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(600),
            },
            Some(token_generation),
        )
        .map_err(|e| controller_error("research token", e))?
        .token)
    };
    let parent_token = token(0, RESEARCH_RESERVE_SCOPE, generation)?;
    let child_token = token(1, RESEARCH_RESERVE_SCOPE, generation)?;
    let new_token = token(2, RESEARCH_RESERVE_SCOPE, generation)?;
    let nested_token = token(3, RESEARCH_RESERVE_SCOPE, generation)?;
    let app = research_budget::router()
        .merge(crate::research_settings::router())
        .merge(crate::secrets::router())
        .merge(crate::conversations::router())
        .with_state(build_test_state(pool.clone(), config.clone()));
    let result = with_shared_db_fixture(
        SharedDbFixture {
            projects: vec![project],
            organizations: vec![],
        },
        async {
            let agent_token = crate::auth::issue_agent_token(
                &config,
                &project,
                &runtimes[0],
                Some(&leases[0]),
                Some(generation),
            )
            .map_err(|e| controller_error("research agent token", e))?
            .token;
            let secrets = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/agent/secrets")
                        .header("authorization", format!("Bearer {agent_token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({"job_id":jobs[0],"touch":false}).to_string(),
                        ))?,
                )
                .await?;
            assert_eq!(secrets.status(), StatusCode::OK);
            let secrets: Value =
                serde_json::from_slice(&to_bytes(secrets.into_body(), 64 * 1024).await?)?;
            let research_token = secrets["researchBudgetToken"]
                .as_str()
                .expect("controller minted research capability");
            let claims = decode_scoped_token(&config, research_token, "research test")
                .map_err(|e| controller_error("decode research token", e))?;
            assert_eq!(claims.scopes, vec![RESEARCH_RESERVE_SCOPE.to_string()]);
            assert_eq!(claims.sub, owner.to_string());
            assert_eq!(claims.run_id.as_deref(), Some(runs[0].to_string().as_str()));
            assert!(claims.exp - claims.iat >= 600);
            assert_eq!(
                budget_request(&app, research_token, None).await?.0,
                StatusCode::OK
            );
            let mut db = pool.get().await?;
            let tx = db.transaction().await?;
            let narrow = crate::auth::RequestContext {
                user_id: Some(owner),
                is_service_role: false,
                scoped_claims: Some(claims),
            };
            assert_eq!(
                research_budget::dispatch_parent(
                    &tx,
                    &build_test_state(pool.clone(), config.clone()),
                    &narrow,
                    &json!({})
                )
                .await
                .unwrap_err()
                .0,
                StatusCode::UNAUTHORIZED
            );
            let prompt_claims = decode_scoped_token(
                &config,
                &token(0, "prompt.execute", generation)?,
                "prompt test",
            )
            .map_err(|e| controller_error("decode prompt token", e))?;
            let prompt = crate::auth::RequestContext {
                scoped_claims: Some(prompt_claims),
                ..narrow
            };
            assert_eq!(
                research_budget::dispatch_parent(
                    &tx,
                    &build_test_state(pool.clone(), config.clone()),
                    &prompt,
                    &json!({"multiAgentPlan":{"parentJobId":jobs[2]}})
                )
                .await
                .map_err(|e| controller_error("bound research parent", e))?,
                Some(jobs[0])
            );
            tx.rollback().await?;
            drop(db);
            // Exercise CLI chat's real path, which uses the job's subject for
            // downstream access checks. Its server-only delegation binding must survive.
            let prompt_token=token(0,"prompt.execute",generation)?;
            let delegated=app.clone().oneshot(Request::builder().method("POST").uri(format!("/conversations/{conversation}/messages")).header("authorization",format!("Bearer {prompt_token}")).header("content-type","application/json").body(Body::from(json!({
                "promptText":"Read the supplied reference and report one supported fact.","runtimeId":runtimes[0],"preferRuntime":true,
                "metadata":{"agentSelection":{"active":["octo"],"mentions":["octo"]},"multiAgentPlan":{"parentJobId":jobs[2]},"delegatingJobId":jobs[2]},
                "delegatingJobId":jobs[2]
            }).to_string()))?).await?;
            let status=delegated.status();
            let delegated:Value=serde_json::from_slice(&to_bytes(delegated.into_body(),64*1024).await?)?;
            assert_eq!(status,StatusCode::OK,"delegation response: {delegated}");
            let delegated_job=Uuid::parse_str(delegated["jobId"].as_str().expect("delegated job"))?;
            let rows=pool.get().await?.query("select job_id,budget_id from agent_job_research_budgets where job_id=any($1)", &[&vec![jobs[0],jobs[2],delegated_job]]).await?;
            let bindings:HashMap<Uuid,Uuid>=rows.iter().map(|row|(row.get(0),row.get(1))).collect();
            assert_eq!(bindings[&delegated_job],bindings[&jobs[0]]);
            assert_ne!(bindings[&delegated_job],bindings[&jobs[2]]);
            let (budget_status, parent_budget) = budget_request(&app, &parent_token, None).await?;
            assert_eq!(budget_status, StatusCode::OK, "parent research response after delegation: {parent_budget}");
            assert_eq!(parent_budget["budget"]["loadsPerTurn"], 3);
            assert_eq!(
                budget_request(&app, &new_token, None).await?.1["budget"]["loadsPerTurn"],
                10
            );
            let requests = [
                reservation("a.example"),
                reservation("a.example"),
                reservation("a.example"),
                reservation("a.example"),
            ];
            let (a, b, c, d) = tokio::join!(
                budget_request(&app, &parent_token, Some(requests[0].clone())),
                budget_request(&app, &child_token, Some(requests[1].clone())),
                budget_request(&app, &nested_token, Some(requests[2].clone())),
                budget_request(&app, &child_token, Some(requests[3].clone()))
            );
            let outcomes = [a?, b?, c?, d?];
            assert!(outcomes.iter().all(|(status, _)| *status == StatusCode::OK));
            assert_eq!(
                outcomes
                    .iter()
                    .filter(|(_, body)| body["allowed"] == true)
                    .count(),
                2
            );
            assert_eq!(budget_request(&app,&parent_token,None).await?.1["budget"]["hosts"]["a.example"]["loads"],2);
            let (other_a,other_b)=tokio::join!(budget_request(&app,&parent_token,Some(reservation("b.example"))),budget_request(&app,&child_token,Some(reservation("c.example"))));
            assert_eq!([other_a?,other_b?].iter().filter(|(_,body)|body["allowed"]==true).count(),1);
            let accepted = outcomes
                .iter()
                .position(|(_, body)| body["allowed"] == true)
                .unwrap();
            assert_eq!(
                budget_request(&app, &child_token, Some(requests[accepted].clone()))
                    .await?
                    .1["budget"]["loadsUsed"],
                3
            );
            assert_eq!(
                budget_request(&app, &new_token, None).await?.1["budget"]["loadsUsed"],
                0
            );
            assert_eq!(
                budget_request(&app, &token(0, "prompt.execute", generation)?, None)
                    .await?
                    .0,
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                budget_request(
                    &app,
                    &token(0, RESEARCH_RESERVE_SCOPE, Uuid::new_v4())?,
                    None
                )
                .await?
                .0,
                StatusCode::UNAUTHORIZED
            );
            let human = crate::auth::issue_controller_token(&config, &owner)
                .map_err(|e| controller_error("research human token", e))?
                .token;
            assert_eq!(
                budget_request(&app, &human, None).await?.0,
                StatusCode::UNAUTHORIZED
            );
            let viewer_token = crate::auth::issue_controller_token(&config, &viewer)
                .map_err(|e| controller_error("research viewer token", e))?
                .token;
            assert_eq!(
                settings_request(&app, project, &viewer_token, None)
                    .await?
                    .1["canManage"],
                false
            );
            for rejected in [&viewer_token, &child_token] {
                assert_eq!(
                    settings_request(&app, project, rejected, Some(json!({"maxPageLoads":20})))
                        .await?
                        .0,
                    StatusCode::FORBIDDEN
                );
            }
            let changed = settings_request(
                &app,
                project,
                &human,
                Some(json!({"maxPageLoads":20,"maxPageLoadsPerSite":8})),
            )
            .await?;
            assert_eq!(changed.0, StatusCode::OK);
            assert_eq!(changed.1["maxPageLoads"], 20);
            assert_eq!(
                budget_request(&app, &new_token, None).await?.1["budget"]["loadsPerTurn"],
                10
            );
            pool.get()
                .await?
                .execute(
                    "update agent_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
                    &[&jobs[1]],
                )
                .await?;
            assert_eq!(
                budget_request(&app, &child_token, Some(reservation("unused.example")))
                    .await?
                    .0,
                StatusCode::UNAUTHORIZED
            );
            Ok(())
        },
    )
    .await;
    pool.get()
        .await?
        .execute(
            "delete from auth.users where id=any($1)",
            &[&vec![owner, viewer]],
        )
        .await?;
    result
}

async fn settings_request(
    app: &axum::Router,
    project: Uuid,
    token: &str,
    patch: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let mut request = Request::builder()
        .method(if patch.is_some() { "PATCH" } else { "GET" })
        .uri(format!("/projects/{project}/research-settings"))
        .header("authorization", format!("Bearer {token}"));
    let body = if let Some(patch) = patch {
        request = request.header("content-type", "application/json");
        Body::from(patch.to_string())
    } else {
        Body::empty()
    };
    let response = app.clone().oneshot(request.body(body)?).await?;
    Ok((
        response.status(),
        serde_json::from_slice(&to_bytes(response.into_body(), 16 * 1024).await?)?,
    ))
}
