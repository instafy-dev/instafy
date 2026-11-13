//! A refused team plan beside a managed-AI dispatch into the root of its
//! planning turn's thread, on the migrated database.
//!
//! The refusal gives the planning turn's reserve back, which locks the org's
//! balance, and writes its notice into the thread, which updates the thread,
//! then the root. A dispatch locks the root `for update`, then reserves. The
//! refusal locks the thread and the root before the balance, so it never
//! waits for the dispatch while it holds the balance
//! (`crate::tests_balance_lock_order`).

use super::*;
use crate::system_turns::SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON;
use crate::tests_balance_lock_order::{
    beside_a_held_dispatch, child_conversation, move_turn_into, on_the_fixtures_org, refund_reason,
    reserved,
};
use crate::tests_lock_waits::controller_error;
use crate::tests_managed_ai_refund::seed_reserved_managed_ai_prompt;

/// What the refusal says, in its notice too.
const NO_WORKER: &str = "No eligible worker runtime";

#[tokio::test]
async fn a_refused_plan_in_a_thread_and_a_dispatch_into_its_root_both_finish() -> anyhow::Result<()>
{
    let Some(fixture) =
        seed_reserved_managed_ai_prompt("refused-plan-beside-root-dispatch").await?
    else {
        eprintln!("skipping the refused plan beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        // An automatic retry in a thread wrote a team plan that no worker
        // can take.
        let (thread, root) = child_conversation(&fixture, Some("thread")).await?;
        move_turn_into(&fixture, thread, true).await?;
        pool.get()
            .await?
            .execute(
                "update agent_jobs set status = 'leased', lease_attempts = 1 where id = $1",
                &[&fixture.job_id],
            )
            .await?;

        let state = fixture.state.clone();
        let (project, job, run) = (fixture.project_id, fixture.job_id, fixture.run_id);
        let outcome = beside_a_held_dispatch(&fixture, root, async move {
            finish_parent_plan_job(
                &state,
                project,
                thread,
                None,
                job,
                Some(run),
                "Two scouts will read the pages the browser found.",
                ParentPlanOutcome::Refused {
                    group_id: Uuid::new_v4(),
                    reason: NO_WORKER,
                    code: "test_plan_refused",
                },
                None,
                None,
            )
            .await
            .map_err(|error| controller_error("the plan's refusal", error))
        })
        .await?;

        assert!(
            !outcome.balance_held,
            "the refusal waits for the root while it holds the org's balance"
        );
        let dispatched = outcome.dispatched?;
        assert_eq!(dispatched.status, "queued", "the prompt is queued");
        assert!(
            reserved(pool, project, dispatched.prompt_id).await?,
            "the dispatch reserves the org's credit past its fence"
        );
        outcome.written?;
        assert_eq!(
            refund_reason(pool, project, fixture.prompt_id).await?,
            Some(json!(SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON)),
            "the refused retry gives its reserve back"
        );
        let notices: i64 = pool
            .get()
            .await?
            .query_one(
                "select count(*) from conversation_messages
                  where conversation_id = $1 and content = $2",
                &[&thread, &NO_WORKER],
            )
            .await?
            .get(0);
        assert_eq!(notices, 1, "the refusal's notice is in the thread");
        Ok(())
    })
    .await
}
