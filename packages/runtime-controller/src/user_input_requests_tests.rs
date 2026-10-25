use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use tower::ServiceExt;

fn question() -> Question {
    Question {
        id: "device".into(),
        header: "Device".into(),
        question: "Which device should I test?".into(),
        options: Some(vec![QuestionOption {
            label: "Phone".into(),
            description: "Small screen".into(),
        }]),
        is_other: false,
        is_secret: false,
    }
}

#[test]
fn questions_reject_secret_duplicate_and_unbounded_content() {
    let q = question();
    assert!(validate_questions(std::slice::from_ref(&q), "Continue the mobile test").is_ok());
    assert!(validate_questions(&[q.clone(), q.clone()], "Continue").is_err());
    let mut secret = q.clone();
    secret.is_secret = true;
    assert!(validate_questions(&[secret], "Continue").is_err());
    let mut long = q;
    long.question = "x".repeat(2001);
    assert!(validate_questions(&[long], "Continue").is_err());
    assert!(validate_questions(&[], "Continue").is_err());
}

#[test]
fn answers_require_exact_ids_but_allow_free_text() {
    let q = question();
    let answer = Answers::from([("device".into(), vec!["Tablet instead".into()])]);
    assert!(validate_answers(std::slice::from_ref(&q), &answer).is_ok());
    assert!(validate_answers(
        std::slice::from_ref(&q),
        &Answers::from([("other".into(), vec!["Phone".into()])])
    )
    .is_err());
    assert!(validate_answers(
        std::slice::from_ref(&q),
        &Answers::from([("device".into(), vec![])])
    )
    .is_err());
    assert!(validate_answers(
        std::slice::from_ref(&q),
        &Answers::from([("device".into(), vec!["Phone".into(), "Tablet".into()])])
    )
    .is_err());
    assert!(validate_answers(
        &[q],
        &Answers::from([("device".into(), vec!["x".repeat(4001)])])
    )
    .is_err());
}

struct Fixture {
    state: AppState,
    app: Router,
    project: Uuid,
    conversation: Uuid,
    runtime: Uuid,
    owner: Uuid,
    teammate: Uuid,
    owner_token: String,
    teammate_token: String,
    agent_token: String,
}

impl Fixture {
    async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("worker user input routing").await?;
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "worker-input",
        );
        let project = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        let runtime = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let teammate = Uuid::new_v4();
        let token = |user| {
            crate::auth::issue_controller_token(&config, &user)
                .map(|v| v.token)
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))
        };
        let owner_token = token(owner)?;
        let teammate_token = token(teammate)?;
        let agent_token = mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: runtime.to_string(),
                subject: "agent:test".into(),
                project_id: project.to_string(),
                runtime_id: Some(runtime.to_string()),
                origin_id: None,
                protocol: None,
                scopes: vec!["agent.input".into()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
        .token;
        let state = build_test_state(pool, config);
        let app = router()
            .merge(crate::conversations::router())
            .with_state(state.clone());
        Ok(Self {
            state,
            app,
            project,
            conversation,
            runtime,
            owner,
            teammate,
            owner_token,
            teammate_token,
            agent_token,
        })
    }

    async fn run(
        &self,
        body: impl std::future::Future<Output = anyhow::Result<()>>,
    ) -> anyhow::Result<()> {
        use futures_util::FutureExt;
        let outcome=std::panic::AssertUnwindSafe(with_shared_db_fixture(SharedDbFixture{projects:vec![self.project],..Default::default()},async{
            ensure_test_user(&self.state.pool,&self.owner).await?;
            ensure_test_user(&self.state.pool,&self.teammate).await?;
            let db=self.state.pool.get().await?;
            db.execute("insert into projects(id,owner_user_id,name,project_type,status) values($1,$2,'Worker questions','customer','active')",&[&self.project,&self.owner]).await?;
            db.execute("insert into project_memberships(project_id,user_id,role) values($1,$2,'builder')",&[&self.project,&self.teammate]).await?;
            db.execute("insert into conversations(id,project_id,created_by,visibility,metadata,root_conversation_id) values($1,$2,$3,'public','{}',$1)",&[&self.conversation,&self.project,&self.owner]).await?;
            db.execute("insert into runtimes(id,project_id,provider,status,capabilities) values($1,$2,'default','ready','{}')",&[&self.runtime,&self.project]).await?;
            drop(db);body.await
        })).catch_unwind().await;
        self.state
            .pool
            .get()
            .await?
            .execute(
                "delete from auth.users where id=any($1)",
                &[&vec![self.owner, self.teammate]],
            )
            .await?;
        match outcome {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    async fn job(&self, parent: Option<Uuid>, owner: Option<Uuid>) -> anyhow::Result<Uuid> {
        let job = Uuid::new_v4();
        let run = Uuid::new_v4();
        let prompt = Uuid::new_v4();
        let group = Uuid::new_v4();
        let db = self.state.pool.get().await?;
        let payload = json!({
            "user_id":owner.unwrap_or(self.teammate),
            "prompt_text":"Test only the mobile view in reports/mobile.txt",
            "plan_seed":{"type":"multi_agent_plan","mode":"write_scoped",
                "agents":[{"handle":"tester","label":"Mobile check","prompt":"Test only the mobile view in reports/mobile.txt",
                    "scopeSummary":"Mobile report","writeScope":{"ownedPaths":["reports/mobile.txt"]}}],
                "lead":{"leadHandle":"octo","continuationPrompt":"Summarize the report","expectedReportFormat":"text"}},
            "metadata":{"agent":{"handle":"tester"},"writeScope":{"ownedPaths":["reports/mobile.txt"]},
                "multiAgentPlan":{"role":"worker","mode":"write_scoped","groupId":group,"parentJobId":parent,
                    "parentRuntimeId":self.runtime,"lead":{"leadHandle":"octo","continuationPrompt":"Summarize the report","expectedReportFormat":"text"}}}
        });
        db.execute("insert into prompts(id,project_id,conversation_id,user_id,prompt_text,metadata) values($1,$2,$3,$4,'Test mobile','{}')",&[&prompt,&self.project,&self.conversation,&owner]).await?;
        db.execute("insert into runs(id,project_id,conversation_id,run_type,status,metadata) values($1,$2,$3,'prompt','in_progress','{\"agent\":{\"handle\":\"tester\"}}')",&[&run,&self.project,&self.conversation]).await?;
        db.execute("insert into agent_jobs(id,project_id,conversation_id,prompt_id,run_id,status,payload,leased_by_runtime_id,leased_at,lease_expires_at,plan_group_id) values($1,$2,$3,$4,$5,'leased',$6,$7,now(),now()+interval '5 minutes',$8)",
            &[&job,&self.project,&self.conversation,&prompt,&run,&PgJson(payload),&self.runtime,&group]).await?;
        Ok(job)
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((status, serde_json::from_slice(&bytes)?))
    }

    async fn create(&self, job: Uuid) -> anyhow::Result<(StatusCode, Value)> {
        self.call("POST",&format!("/agent/jobs/{job}/user-input-requests"),&self.agent_token,
            json!({"runtimeId":self.runtime,"questions":[question()],"continuationNote":"Continue mobile test with the chosen device"})).await
    }

    async fn routing_job(&self, text: &str) -> anyhow::Result<(Uuid, Uuid, Value)> {
        let job = self.job(None, Some(self.owner)).await?;
        let message = Uuid::new_v4();
        let mut db = self.state.pool.get().await?;
        let tx = db.transaction().await?;
        let row = tx
            .query_one(
                "select prompt_id,run_id,payload from agent_jobs where id=$1",
                &[&job],
            )
            .await?;
        let prompt: Uuid = row.get("prompt_id");
        let run: Uuid = row.get("run_id");
        tx.execute("insert into conversation_messages(id,project_id,conversation_id,prompt_id,run_id,role,content,created_by,metadata) values($1,$2,$3,$4,$5,'user',$6,$7,'{}')", &[&message,&self.project,&self.conversation,&prompt,&run,&text,&self.owner]).await?;
        let snapshot = routing::snapshot(
            &tx,
            &RequestContext {
                user_id: Some(self.owner),
                is_service_role: false,
                scoped_claims: None,
            },
            self.project,
            self.conversation,
            message,
        )
        .await
        .map_err(|(_, Json(error))| anyhow::anyhow!(error.message))?
        .unwrap();
        let mut payload = row.get::<_, PgJson<Value>>("payload").0;
        payload.as_object_mut().unwrap().remove("plan_seed");
        payload["metadata"] = json!({"agent":{"handle":"octo"},"workerInputRouting":snapshot});
        payload["prompt_text"] = json!(text);
        tx.execute(
            "update agent_jobs set payload=$2,plan_group_id=null where id=$1",
            &[&job, &PgJson(payload)],
        )
        .await?;
        tx.commit().await?;
        Ok((job, message, snapshot))
    }
}

#[tokio::test]
async fn natural_replies_apply_atomic_batches_and_replay_the_source_once() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let first=f.job(None,Some(f.owner)).await?; let second=f.job(None,Some(f.owner)).await?;
        let (_,a)=f.create(first).await?;let (_,b)=f.create(second).await?;
        let a=Uuid::parse_str(a["requestId"].as_str().unwrap())?;let b=Uuid::parse_str(b["requestId"].as_str().unwrap())?;
        let (job,source,_)=f.routing_job("Use Phone for both").await?;
        let body=json!({"runtimeId":f.runtime,"disposition":"answer","answers":[
            {"requestId":a,"questionId":"device","sourceMessageId":source,"value":"Phone"},
            {"requestId":b,"questionId":"device","sourceMessageId":source,"value":"Phone"}
        ],"clarification":null,"remainingRequest":null});
        // The second target becomes stale after routing; neither answer commits.
        let db=f.state.pool.get().await?;
        db.execute("update agent_user_input_requests set status='expired' where id=$1",&[&b]).await?;drop(db);
        let path=format!("/agent/jobs/{job}/user-input-replies");
        let (status,error)=f.call("POST",&path,&f.agent_token,body.clone()).await?;
        assert_eq!(status,StatusCode::CONFLICT,"{error}");
        let db=f.state.pool.get().await?;
        assert_eq!(db.query_one("select status from agent_user_input_requests where id=$1",&[&a]).await?.get::<_,String>(0),"pending");drop(db);

        let (next,source,_)=f.routing_job("Use Phone").await?;
        let body=json!({"runtimeId":f.runtime,"disposition":"answer","answers":[{"requestId":a,"questionId":"device","sourceMessageId":source,"value":"Phone"}],"clarification":null,"remainingRequest":null});
        let path=format!("/agent/jobs/{next}/user-input-replies");
        let (status,result)=f.call("POST",&path,&f.agent_token,body.clone()).await?;assert_eq!(status,StatusCode::OK,"{result}");
        let (status,replay)=f.call("POST",&path,&f.agent_token,body.clone()).await?;assert_eq!(status,StatusCode::OK,"{replay}");assert_eq!(result,replay);
        let mut changed=body;changed["answers"][0]["value"]=json!("Use Phone");
        let (status,_)=f.call("POST",&path,&f.agent_token,changed).await?;assert_eq!(status,StatusCode::CONFLICT);
        let db=f.state.pool.get().await?;
        let row=db.query_one("select status,answers,answer_message_id,answered_by from agent_user_input_requests where id=$1",&[&a]).await?;
        assert_eq!(row.get::<_,String>("status"),"answered");assert_eq!(row.get::<_,PgJson<Value>>("answers").0,json!({"device":["Phone"]}));
        assert_eq!(row.get::<_,Uuid>("answer_message_id"),source);assert_eq!(row.get::<_,Uuid>("answered_by"),f.owner);
        assert_eq!(db.query_one("select count(*) from conversation_messages where conversation_id=$1 and role='user'",&[&f.conversation]).await?.get::<_,i64>(0),2);
        Ok(())
    }).await
}

#[tokio::test]
async fn natural_reply_rejects_forged_sources_wrong_owner_and_stopped_route() -> anyhow::Result<()>
{
    let f = Fixture::new().await?;
    f.run(async {
        let worker=f.job(None,Some(f.owner)).await?;let (_,request)=f.create(worker).await?;
        let request=Uuid::parse_str(request["requestId"].as_str().unwrap())?;
        let (job,source,_)=f.routing_job("Phone").await?;let path=format!("/agent/jobs/{job}/user-input-replies");
        let body=json!({"runtimeId":f.runtime,"disposition":"answer","answers":[{"requestId":request,"questionId":"device","sourceMessageId":source,"value":"Phone"}],"clarification":null,"remainingRequest":null});
        let mut forged=body.clone();forged["answers"][0]["sourceMessageId"]=json!(Uuid::new_v4());
        let (status,_)=f.call("POST",&path,&f.agent_token,forged).await?;assert_eq!(status,StatusCode::BAD_REQUEST);
        let db=f.state.pool.get().await?;
        db.execute("update agent_user_input_requests set requested_user_id=$2 where id=$1",&[&request,&f.teammate]).await?;drop(db);
        let (status,_)=f.call("POST",&path,&f.agent_token,body.clone()).await?;assert_eq!(status,StatusCode::FORBIDDEN);
        let db=f.state.pool.get().await?;
        db.execute("update agent_jobs set status='canceled' where id=$1",&[&job]).await?;drop(db);
        let (status,_)=f.call("POST",&path,&f.agent_token,body).await?;assert_eq!(status,StatusCode::CONFLICT);
        Ok(())
    }).await
}

#[tokio::test]
async fn clarification_keeps_original_human_answer_and_separate_remaining_request(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let worker=f.job(None,Some(f.owner)).await?;let (_,request)=f.create(worker).await?;
        let request=Uuid::parse_str(request["requestId"].as_str().unwrap())?;
        let (job,source,_)=f.routing_job("yes; also summarize the report").await?;
        let body=json!({"runtimeId":f.runtime,"disposition":"clarify","answers":[],"clarification":"Which task?","remainingRequest":{"sourceMessageId":source,"text":"summarize the report"}});
        let (status,result)=f.call("POST",&format!("/agent/jobs/{job}/user-input-replies"),&f.agent_token,body).await?;assert_eq!(status,StatusCode::OK,"{result}");
        let db=f.state.pool.get().await?;
        db.execute("insert into conversation_messages(id,project_id,conversation_id,prompt_id,run_id,role,content,metadata) select $1,project_id,conversation_id,prompt_id,run_id,'assistant','Which task?',$2 from agent_jobs where id=$3",&[&Uuid::new_v4(),&PgJson(json!({"jobId":job})),&job]).await?;drop(db);
        let (next,current,snapshot)=f.routing_job("Documentation").await?;
        assert_eq!(snapshot["sources"].as_array().unwrap().len(),2,"{snapshot}");
        assert_eq!(snapshot["remainingRequest"]["text"],"summarize the report");
        assert_eq!(snapshot["clarificationRequestIds"],json!([request]));
        let answer=json!({"runtimeId":f.runtime,"disposition":"answer","answers":[{"requestId":request,"questionId":"device","sourceMessageId":source,"value":"yes"}],"clarification":null,"remainingRequest":{"sourceMessageId":source,"text":"summarize the report"}});
        let (status,result)=f.call("POST",&format!("/agent/jobs/{next}/user-input-replies"),&f.agent_token,answer).await?;assert_eq!(status,StatusCode::OK,"{result}");
        let db=f.state.pool.get().await?;let row=db.query_one("select answers,answer_message_id from agent_user_input_requests where id=$1",&[&request]).await?;
        assert_eq!(row.get::<_,PgJson<Value>>("answers").0,json!({"device":["yes"]}));assert_eq!(row.get::<_,Uuid>("answer_message_id"),current);
        Ok(())
    }).await
}

#[tokio::test]
async fn natural_reply_replay_survives_runtime_reassignment_but_not_revoked_access(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let mut ids=Vec::new();
        for _ in 0..2 { let worker=f.job(None,Some(f.owner)).await?;let (_,request)=f.create(worker).await?;ids.push(Uuid::parse_str(request["requestId"].as_str().unwrap())?); }
        let (job,source,_)=f.routing_job("Phone for both").await?;
        let mut body=json!({"runtimeId":f.runtime,"disposition":"answer","answers":ids.iter().map(|request|json!({"requestId":request,"questionId":"device","sourceMessageId":source,"value":"Phone"})).collect::<Vec<_>>(),"clarification":null,"remainingRequest":null});
        let path=format!("/agent/jobs/{job}/user-input-replies");
        let (status,first)=f.call("POST",&path,&f.agent_token,body.clone()).await?;assert_eq!(status,StatusCode::OK,"{first}");
        let runtime=Uuid::new_v4();let db=f.state.pool.get().await?;
        db.execute("insert into runtimes(id,project_id,provider,status,capabilities) values($1,$2,'default','ready','{}')",&[&runtime,&f.project]).await?;
        db.execute("update agent_jobs set leased_by_runtime_id=$2,lease_attempts=lease_attempts+1 where id=$1",&[&job,&runtime]).await?;drop(db);
        let token=mint_scoped_token(&f.state.config,ScopedTokenRequest{audience:runtime.to_string(),subject:"agent:test".into(),project_id:f.project.to_string(),runtime_id:Some(runtime.to_string()),origin_id:None,protocol:None,scopes:vec!["agent.input".into()],lease_id:None,run_id:None,prefer_runtime:None,ttl_seconds:Some(300)}).map_err(|(_,Json(error))|anyhow::anyhow!(error.message))?.token;
        body["runtimeId"]=json!(runtime);body["answers"].as_array_mut().unwrap().reverse();
        let (status,replay)=f.call("POST",&path,&token,body.clone()).await?;assert_eq!(status,StatusCode::OK,"{replay}");assert_eq!(first,replay);
        let db=f.state.pool.get().await?;db.execute("update projects set owner_user_id=$2 where id=$1",&[&f.project,&f.teammate]).await?;drop(db);
        let (status,result)=f.call("POST",&path,&token,body).await?;assert_eq!(status,StatusCode::FORBIDDEN,"{result}");
        Ok(())
    }).await
}

#[tokio::test]
async fn deferred_question_routes_to_prompt_owner_and_exact_worker_once() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async{
        let parent=f.job(None,Some(f.owner)).await?;
        let worker=f.job(Some(parent),None).await?;
        let (status,created)=f.create(worker).await?;assert_eq!(status,StatusCode::OK,"{created}");
        let request=created["requestId"].as_str().unwrap();
        let (status,replay)=f.create(worker).await?;assert_eq!(status,StatusCode::OK);assert_eq!(replay,created);
        let db=f.state.pool.get().await?;
        let row=db.query_one("select job_id,requested_user_id,message_id from agent_user_input_requests where id=$1",&[&Uuid::parse_str(request)?]).await?;
        assert_eq!(row.get::<_,Uuid>("job_id"),worker);assert_eq!(row.get::<_,Uuid>("requested_user_id"),f.owner);
        let message_id:Uuid=row.get("message_id");
        let message=db.query_one("select conversation_id,metadata from conversation_messages where id=$1",&[&message_id]).await?;
        assert_eq!(message.get::<_,Uuid>("conversation_id"),f.conversation);
        assert_eq!(message.get::<_,PgJson<Value>>("metadata").0["details"]["userInputRequestId"],request);
        drop(db);
        let path=format!("/user-input-requests/{request}/answer");let answer=json!({"answers":{"device":["Tablet"]}});
        let (status,_)=f.call("POST",&path,&f.teammate_token,answer.clone()).await?;assert_eq!(status,StatusCode::FORBIDDEN);
        let (status,_)=f.call("POST",&path,&f.agent_token,answer.clone()).await?;assert!(status.is_client_error());
        let (status,value)=f.call("POST",&path,&f.owner_token,answer.clone()).await?;assert_eq!(status,StatusCode::OK,"{value}");assert_eq!(value["status"],"answered");
        let (status,_)=f.call("POST",&path,&f.owner_token,answer).await?;assert_eq!(status,StatusCode::OK);
        let (status,_)=f.call("POST",&path,&f.owner_token,json!({"answers":{"device":["Phone"]}})).await?;assert_eq!(status,StatusCode::CONFLICT);
        let (status,value)=f.call("GET",&format!("/user-input-requests/{request}"),&f.owner_token,Value::Null).await?;assert_eq!(status,StatusCode::OK);
        assert!(value.get("runtimeId").is_none());assert!(value.get("jobId").is_none());
        let db=f.state.pool.get().await?;
        assert_eq!(db.query_one("select count(*) from conversation_messages where conversation_id=$1 and role='user'",&[&f.conversation]).await?.get::<_,i64>(0),1);
        Ok(())
    }).await
}

#[tokio::test]
async fn canceled_and_released_workers_cannot_receive_answers() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        for next_status in ["canceled", "failed", "queued"] {
            let job = f.job(None, Some(f.owner)).await?;
            let (status, value) = f.create(job).await?;
            assert_eq!(status, StatusCode::OK, "{value}");
            let request = value["requestId"].as_str().unwrap();
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update agent_jobs set status=$2 where id=$1",
                    &[&job, &next_status],
                )
                .await?;
            let (status, _) = f
                .call(
                    "POST",
                    &format!("/user-input-requests/{request}/answer"),
                    &f.owner_token,
                    json!({"answers":{"device":["Phone"]}}),
                )
                .await?;
            assert_eq!(status, StatusCode::CONFLICT);
        }
        let job = f.job(None, Some(f.owner)).await?;
        let (_, value) = f.create(job).await?;
        let request = value["requestId"].as_str().unwrap();
        f.state
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set status='completed' where id=$1",
                &[&job],
            )
            .await?;
        let (_, value) = f
            .call(
                "GET",
                &format!("/user-input-requests/{request}"),
                &f.owner_token,
                Value::Null,
            )
            .await?;
        assert_eq!(
            value["status"], "pending",
            "normal completion must release the lease without losing the question"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn question_creation_rejects_rebound_runtime_and_changed_payload() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async{
        let job=f.job(None,Some(f.owner)).await?;
        let (status,_)=f.create(job).await?;assert_eq!(status,StatusCode::OK);
        let (status,_)=f.call("POST",&format!("/agent/jobs/{job}/user-input-requests"),&f.agent_token,
            json!({"runtimeId":f.runtime,"questions":[question()],"continuationNote":"Different"})).await?;
        assert_eq!(status,StatusCode::CONFLICT);
        let (status,_)=f.call("POST",&format!("/agent/jobs/{job}/user-input-requests"),&f.agent_token,
            json!({"runtimeId":Uuid::new_v4(),"questions":[question()],"continuationNote":"Continue"})).await?;
        assert_eq!(status,StatusCode::FORBIDDEN);
        let (status,_)=f.create(Uuid::new_v4()).await?;assert_eq!(status,StatusCode::CONFLICT);
        Ok(())
    }).await
}

#[tokio::test]
async fn completed_answer_resumes_exact_assignment_once_with_original_scope() -> anyhow::Result<()>
{
    let f = Fixture::new().await?;
    f.run(async {
        let job=f.job(None,Some(f.owner)).await?;
        f.state.pool.get().await?.execute(
            "update agent_jobs set payload=jsonb_set(payload,'{metadata,multiAgentPlan,continuation}',$2) where id=$1",
            &[&job,&PgJson(json!({"turn":2,"of":Uuid::new_v4()}))],
        ).await?;
        let (status,created)=f.create(job).await?;
        assert_eq!(status,StatusCode::OK,"{created}");
        let request=created["requestId"].as_str().unwrap();
        f.state.pool.get().await?.execute("update agent_jobs set status='completed' where id=$1",&[&job]).await?;
        let path=format!("/user-input-requests/{request}/answer");
        let answer=json!({"answers":{"device":["Tablet"]}});
        let (status,result)=f.call("POST",&path,&f.owner_token,answer.clone()).await?;
        assert_eq!(status,StatusCode::OK,"{result}");
        assert_eq!(result["status"],"resumed","{result}");
        let (status,replay)=f.call("POST",&path,&f.owner_token,answer).await?;
        assert_eq!(status,StatusCode::OK,"{replay}");
        assert_eq!(result,replay);
        let db=f.state.pool.get().await?;
        let rows=db.query("select id,payload,conversation_id from agent_jobs where project_id=$1 and payload #>> '{metadata,multiAgentPlan,userInputContinuation,requestId}'=$2",&[&f.project,&request]).await?;
        assert_eq!(rows.len(),1,"one exact continuation after repeated answers");
        assert_eq!(rows[0].get::<_,Option<Uuid>>("conversation_id"),Some(f.conversation));
        let payload=rows[0].get::<_,PgJson<Value>>("payload").0;
        assert_eq!(payload["metadata"]["agent"]["handle"],"tester");
        assert_eq!(payload["metadata"]["multiAgentPlan"]["userInputContinuation"]["of"],job.to_string());
        assert_eq!(payload["metadata"]["multiAgentPlan"]["continuation"]["turn"],2);
        assert!(payload["metadata"]["multiAgentPlan"]["continuation"].get("of").is_none());
        assert_eq!(payload["plan_seed"]["agents"][0]["writeScope"]["ownedPaths"],json!(["reports/mobile.txt"]));
        assert_eq!(payload["plan_seed"]["agents"][0]["scopeSummary"],"Mobile report");
        let prompt=payload["prompt_text"].as_str().unwrap();
        assert!(prompt.contains("Tablet") && prompt.contains("reports/mobile.txt"));
        let run_meta=db.query_one("select r.metadata from runs r join agent_jobs j on j.run_id=r.id where j.id=$1",&[&job]).await?.get::<_,PgJson<Value>>(0).0;
        assert_eq!(run_meta["userInputRequest"]["status"],"resumed");
        Ok(())
    }).await
}

#[tokio::test]
async fn completed_questions_expire_on_chat_group_and_space_stop() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        for stop in ["chat", "group", "space"] {
            let job = f.job(None, Some(f.owner)).await?;
            let (_, created) = f.create(job).await?;
            let request = created["requestId"].as_str().unwrap();
            let mut db = f.state.pool.get().await?;
            db.execute(
                "update agent_jobs set status='completed' where id=$1",
                &[&job],
            )
            .await?;
            let group: Uuid = db
                .query_one(
                    "select group_id from agent_user_input_requests where id=$1",
                    &[&Uuid::parse_str(request)?],
                )
                .await?
                .get(0);
            if stop == "space" {
                let mut tx = db.transaction().await?;
                let canceled =
                    crate::project_work_cancellation::cancel_project_work_in_transaction(
                        &mut tx, f.project,
                    )
                    .await
                    .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?;
                assert_eq!(canceled.expired_user_input_requests, 1);
                tx.commit().await?;
                drop(db);
            } else {
                drop(db);
                let path = if stop == "chat" {
                    format!("/conversations/{}/interrupt", f.conversation)
                } else {
                    format!("/jobs/plan-groups/{group}/cancel")
                };
                let (status, value) = f
                    .call(
                        "POST",
                        &path,
                        &f.owner_token,
                        json!({"reason":"Stop this work"}),
                    )
                    .await?;
                assert_eq!(status, StatusCode::OK, "{value}");
            }
            let (status, value) = f
                .call(
                    "GET",
                    &format!("/user-input-requests/{request}"),
                    &f.owner_token,
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{value}");
            assert_eq!(value["status"], "expired", "{stop}: {value}");
            let (status, _) = f
                .call(
                    "POST",
                    &format!("/user-input-requests/{request}/answer"),
                    &f.owner_token,
                    json!({"answers":{"device":["Phone"]}}),
                )
                .await?;
            assert_eq!(status, StatusCode::CONFLICT);
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn questions_keep_private_chat_and_project_boundaries() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let job = f.job(None, Some(f.owner)).await?;
        let (_, created) = f.create(job).await?;
        let path = format!(
            "/user-input-requests/{}",
            created["requestId"].as_str().unwrap()
        );
        f.state
            .pool
            .get()
            .await?
            .execute(
                "update conversations set visibility='private' where id=$1",
                &[&f.conversation],
            )
            .await?;
        let (status, _) = f.call("GET", &path, &f.teammate_token, Value::Null).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = f.call("GET", &path, &f.agent_token, Value::Null).await?;
        assert!(status.is_client_error());
        f.state
            .pool
            .get()
            .await?
            .execute(
                "delete from project_memberships where project_id=$1 and user_id=$2",
                &[&f.project, &f.teammate],
            )
            .await?;
        f.state
            .pool
            .get()
            .await?
            .execute(
                "update conversations set visibility='public' where id=$1",
                &[&f.conversation],
            )
            .await?;
        let (status, _) = f.call("GET", &path, &f.teammate_token, Value::Null).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn saved_answer_does_not_resume_after_human_loses_space_access() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let job = f.job(None, Some(f.owner)).await?;
        let (_, created) = f.create(job).await?;
        let request = created["requestId"].as_str().unwrap();
        let request_id = Uuid::parse_str(request)?;
        let (status, result) = f.call("POST", &format!("/user-input-requests/{request}/answer"),
            &f.owner_token, json!({"answers":{"device":["Tablet"]}})).await?;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["status"], "answered");
        let db = f.state.pool.get().await?;
        db.execute("update projects set owner_user_id=$2 where id=$1", &[&f.project,&f.teammate]).await?;
        db.execute("delete from project_memberships where project_id=$1 and user_id=$2", &[&f.project,&f.owner]).await?;
        db.execute("update agent_jobs set status='completed' where id=$1", &[&job]).await?;
        drop(db);
        crate::multi_agent_plan::user_input::resume_answered_request(&f.state,request_id).await
            .map_err(|(_,e)|anyhow::anyhow!(e.0.message))?;
        let db=f.state.pool.get().await?;
        let row=db.query_one("select status from agent_user_input_requests where id=$1",&[&request_id]).await?;
        assert_eq!(row.get::<_,String>(0),"expired");
        assert_eq!(db.query_one("select count(*) from agent_jobs where payload #>> '{metadata,multiAgentPlan,userInputContinuation,requestId}'=$1",&[&request]).await?.get::<_,i64>(0),0);
        Ok(())
    }).await
}

#[tokio::test]
async fn expired_job_lease_rejects_answer_before_idle_cleanup() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let job = f.job(None, Some(f.owner)).await?;
        let (_, created) = f.create(job).await?;
        let request = created["requestId"].as_str().unwrap();
        f.state
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
                &[&job],
            )
            .await?;
        let (status, result) = f
            .call(
                "POST",
                &format!("/user-input-requests/{request}/answer"),
                &f.owner_token,
                json!({"answers":{"device":["Tablet"]}}),
            )
            .await?;
        assert_eq!(status, StatusCode::CONFLICT, "{result}");
        let (_, result) = f
            .call(
                "GET",
                &format!("/user-input-requests/{request}"),
                &f.owner_token,
                Value::Null,
            )
            .await?;
        assert_eq!(result["status"], "expired");
        assert!(result.get("answers").is_none());
        Ok(())
    })
    .await
}

#[tokio::test]
async fn space_deletion_does_not_deadlock_with_answer_redispatch() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let job = f.job(None, Some(f.owner)).await?;
        let (_, created) = f.create(job).await?;
        let request = created["requestId"].as_str().unwrap();
        let request_id = Uuid::parse_str(request)?;
        let (status, value) = f.call("POST", &format!("/user-input-requests/{request}/answer"),
            &f.owner_token, json!({"answers":{"device":["Tablet"]}})).await?;
        assert_eq!(status, StatusCode::OK, "{value}");
        let mut deleting = f.state.pool.get().await?;
        deleting.execute("update agent_jobs set status='completed' where id=$1", &[&job]).await?;
        let blocker: i32 = deleting.query_one("select pg_backend_pid()", &[]).await?.get(0);
        let mut tx = deleting.transaction().await?;
        tx.query_one("select id from projects where id=$1 for update", &[&f.project]).await?;
        let resume_state=f.state.clone();
        let resume=tokio::spawn(async move {
            crate::multi_agent_plan::user_input::resume_answered_request(&resume_state,request_id).await
        });
        // Wait for the real nested dispatch's project FK check, rather than
        // guessing when the coordinator has entered its critical section.
        let observer=f.state.pool.get().await?;
        tokio::time::timeout(std::time::Duration::from_secs(10),async {
            loop {
                let blocked:bool=observer.query_one("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid)))", &[&blocker]).await?.get(0);
                if blocked { return Ok::<(),anyhow::Error>(()); }
                if resume.is_finished() { anyhow::bail!("redispatch ended before exercising the project-lock race"); }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await??;
        drop(observer);
        tx.execute("update projects set status='deleted' where id=$1", &[&f.project]).await?;
        tokio::time::timeout(std::time::Duration::from_secs(3),
            crate::project_work_cancellation::cancel_project_work_in_transaction(&mut tx,f.project))
            .await?.map_err(|(_,error)|anyhow::anyhow!(error.0.message))?;
        tx.commit().await?;
        drop(deleting);
        let result=tokio::time::timeout(std::time::Duration::from_secs(10),resume).await??;
        if let Err((status,_))=result { assert!(status.is_client_error()); }
        let db=f.state.pool.get().await?;
        assert_eq!(db.query_one("select status from agent_user_input_requests where id=$1",&[&request_id]).await?.get::<_,String>(0),"expired");
        assert_eq!(db.query_one("select count(*) from agent_jobs where payload #>> '{metadata,multiAgentPlan,userInputContinuation,requestId}'=$1",&[&request]).await?.get::<_,i64>(0),0);
        Ok(())
    }).await
}

#[tokio::test]
async fn lost_resume_transition_cancels_only_its_exact_continuation() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let source=f.job(None,Some(f.owner)).await?;
        let (_,created)=f.create(source).await?;
        let request=Uuid::parse_str(created["requestId"].as_str().unwrap())?;
        let next=f.job(None,Some(f.owner)).await?;
        let unrelated=f.job(None,Some(f.owner)).await?;
        let mut db=f.state.pool.get().await?;
        let group:Uuid=db.query_one("select group_id from agent_user_input_requests where id=$1",&[&request]).await?.get(0);
        db.execute("update agent_user_input_requests set status='expired' where id=$1",&[&request]).await?;
        db.execute("update agent_jobs set status='queued',plan_group_id=$2,payload=jsonb_set(payload,'{metadata,multiAgentPlan,userInputContinuation}',$3) where id=$1",
            &[&next,&group,&PgJson(json!({"requestId":request,"of":source}))]).await?;
        let tx=db.transaction().await?;
        cancel_undeliverable_continuation(&tx,request,unrelated).await.map_err(|(_,e)|anyhow::anyhow!(e.0.message))?;
        cancel_undeliverable_continuation(&tx,request,next).await.map_err(|(_,e)|anyhow::anyhow!(e.0.message))?;
        tx.commit().await?;
        assert_eq!(db.query_one("select status from agent_jobs where id=$1",&[&unrelated]).await?.get::<_,String>(0),"leased");
        assert_eq!(db.query_one("select status from agent_jobs where id=$1",&[&next]).await?.get::<_,String>(0),"canceled");
        assert_eq!(db.query_one("select resumed_job_id from agent_user_input_requests where id=$1",&[&request]).await?.get::<_,Option<Uuid>>(0),Some(next));
        Ok(())
    }).await
}
