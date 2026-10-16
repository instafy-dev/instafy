use super::*;
use crate::tests_managed_ai_refund::seed_reserved_managed_ai_prompt;

async fn lease(pool: &crate::config::PgPool, project: Uuid) -> anyhow::Result<Option<Uuid>> {
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let job = crate::agent::lease_next_agent_job(
        &transaction,
        &project,
        None,
        120,
        true,
        false,
        false,
        false,
        None,
        None,
        false,
    )
    .await
    .map_err(|(status, Json(error))| anyhow::anyhow!("{status}: {}", error.message))?;
    transaction.commit().await?;
    Ok(job.map(|job| job.id))
}

#[tokio::test]
async fn team_capacity_is_atomic_across_polls_and_does_not_block_coordination() -> anyhow::Result<()>
{
    let Some(fixture) = seed_reserved_managed_ai_prompt("team-capacity").await? else {
        eprintln!("skipping team capacity integration: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let result: anyhow::Result<()> = async {
        let connection = fixture.pool.get().await?;
        connection.execute("update agent_jobs set status='completed' where id=$1", &[&fixture.job_id]).await?;
        connection.execute("insert into project_multi_agent_settings (project_id,max_concurrent_agents) values ($1,3)", &[&fixture.project_id]).await?;
        // Include an older payload-only worker: it must consume the same budget.
        for i in 0..10 {
            connection.execute("insert into agent_jobs (project_id,status,agent_role,payload)
                values ($1,'queued',$2,$3)", &[&fixture.project_id,
                &(if i == 0 { None } else { Some("worker") }),
                &json!({"metadata":{"multiAgentPlan":{"role":"worker"}}})]).await?;
        }
        drop(connection);
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..10 {
            let pool = fixture.pool.clone();
            let project = fixture.project_id;
            tasks.spawn(async move { lease(&pool, project).await });
        }
        let mut admitted = Vec::new();
        while let Some(result) = tasks.join_next().await {
            if let Some(id) = result?? { admitted.push(id); }
        }
        assert_eq!(admitted.len(), 3, "racing runtime polls must share one budget");
        let connection = fixture.pool.get().await?;
        for role in ["root", "lead"] {
            connection.execute("insert into agent_jobs (project_id,status,agent_role,payload)
                values ($1,'queued',$2,'{}')", &[&fixture.project_id,&role]).await?;
        }
        drop(connection);
        assert!(lease(&fixture.pool, fixture.project_id).await?.is_some());
        assert!(lease(&fixture.pool, fixture.project_id).await?.is_some());
        assert!(lease(&fixture.pool, fixture.project_id).await?.is_none());

        // Lowering the budget leaves active jobs intact; expired leases free slots.
        let connection = fixture.pool.get().await?;
        connection.execute("update project_multi_agent_settings set max_concurrent_agents=1 where project_id=$1", &[&fixture.project_id]).await?;
        drop(connection);
        assert!(lease(&fixture.pool, fixture.project_id).await?.is_none());
        let connection = fixture.pool.get().await?;
        let active: i64 = connection.query_one("select count(*) from agent_jobs where id=any($1) and status='leased'", &[&admitted]).await?.get(0);
        assert_eq!(active, 3);
        connection.execute("update agent_jobs set lease_expires_at=now()-interval '1 second' where id=any($1)", &[&admitted]).await?;
        drop(connection);
        assert!(lease(&fixture.pool, fixture.project_id).await?.is_some());
        assert!(lease(&fixture.pool, fixture.project_id).await?.is_none());
        Ok(())
    }.await;
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}
