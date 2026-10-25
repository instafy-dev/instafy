//! Controller-owned settings for one job, independent of project secrets and process env.
//!
//! A new job (including a resumed conversation) fetches these again. Refreshing its
//! credentials does not change an active run's limits. The task scope also prevents
//! a failed fetch, cancellation, or a concurrent isolated worker inheriting another job's limit.

use std::future::Future;
use std::pin::Pin;

use runtime_contracts::multi_agent::AgentRuntimeSettings;

tokio::task_local! {
    static JOB_SETTINGS: AgentRuntimeSettings;
}

/// Keep the large executor future on the heap before entering Tokio's task-local
/// wrapper. An async wrapper would store both its argument and TaskLocalFuture
/// inline, doubling that state and adding large moves to Codex startup's stack.
pub(crate) fn scope<F: Future>(
    settings: AgentRuntimeSettings,
    future: Pin<Box<F>>,
) -> impl Future<Output = F::Output> {
    JOB_SETTINGS.scope(settings, future)
}

pub(crate) fn current() -> Option<AgentRuntimeSettings> {
    JOB_SETTINGS.try_with(|settings| *settings).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_contracts::multi_agent::NativeSubagentLimit;

    #[test]
    fn native_settings_scope_does_not_store_the_executor_future_inline() {
        fn returned_size<T, R>(_: impl FnOnce(T) -> R) -> usize {
            std::mem::size_of::<R>()
        }
        fn scoped_size<F: Future>(
            _: impl FnOnce(
                &'static crate::agent_executor::AgentExecutor,
                std::sync::Arc<crate::controller::ControllerClient>,
                &'static crate::controller::Registration,
                &'static crate::controller::LeaseJob,
                Option<crate::job_cancel::JobCancelSignal>,
                Option<crate::active_turn_input::ActiveTurnInputReceiver>,
            ) -> F,
        ) -> (usize, usize) {
            (
                std::mem::size_of::<F>(),
                returned_size(|future: Pin<Box<F>>| scope(AgentRuntimeSettings::default(), future)),
            )
        }
        let (executor_bytes, scope_bytes) =
            scoped_size(crate::agent_executor::AgentExecutor::run_apply_with_progress);
        eprintln!("executor future: {executor_bytes} bytes; settings scope: {scope_bytes} bytes");
        assert!(
            scope_bytes <= 256,
            "the job-settings scope must hold a heap pointer, not the executor future"
        );
    }

    #[tokio::test]
    async fn native_subagent_settings_are_per_job_and_restore_after_the_scope() {
        let settings = |limit| AgentRuntimeSettings {
            max_native_subagents: NativeSubagentLimit::try_from(limit).unwrap(),
        };
        let observe = || async {
            tokio::task::yield_now().await;
            current().unwrap().max_native_subagents.get()
        };
        assert_eq!(current(), None);
        let (first, second) = tokio::join!(
            scope(settings(10), Box::pin(observe())),
            scope(settings(1), Box::pin(observe()))
        );
        assert_eq!((first, second), (10, 1));
        assert_eq!(current(), None);

        scope(
            settings(10),
            Box::pin(async {
                // An unrelated spawned job receives no authority from its parent's task.
                assert_eq!(tokio::spawn(async { current() }).await.unwrap(), None);
                scope(
                    settings(64),
                    Box::pin(async { assert_eq!(current(), Some(settings(64))) }),
                )
                .await;
                assert_eq!(current(), Some(settings(10)));
            }),
        )
        .await;
        assert_eq!(current(), None);
    }
}
