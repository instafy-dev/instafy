use super::tests::{test_job_processor, test_lease_job, test_registration_with_proxy};
use super::*;

fn worker() -> LeaseJob {
    let mut job = test_lease_job(
        Some("feature"),
        json!({
            "prompt_text":"Run a real timer, then write docs/result.txt.",
            "metadata":{
                "multiAgentPlan":{"role":"worker","groupId":"test-group"},
                "writeScope":{"mode":"owned","ownedPaths":["docs/result.txt"]},
                "runtimeExpectations":{"commandExecution":true,"workspaceFileChanges":true}
            }
        }),
    );
    job.controller_token = Some("inert-admission-only-token".into());
    job
}

#[test]
fn isolated_worker_admission_is_explicit_and_does_not_touch_the_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let mut processor = test_job_processor(temp.path());
    let registration = test_registration_with_proxy();
    let job = worker();
    processor.isolated_workers.enabled = false;
    assert!(!processor.can_run_isolated_scoped_worker(&registration, &job));
    processor.isolated_workers.enabled = true;
    assert!(processor.can_run_isolated_scoped_worker(&registration, &job));
    assert_eq!(
        std::fs::read_dir(temp.path()).unwrap().count(),
        0,
        "admission must not create or read a project before claim verification"
    );
}

#[test]
fn isolated_worker_does_not_borrow_another_jobs_proxy_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let mut processor = test_job_processor(temp.path());
    processor.isolated_workers.enabled = true;
    let mut registration = test_registration_with_proxy();
    registration.proxy = None;
    let mut job = worker();
    assert!(!processor.can_run_isolated_scoped_worker(&registration, &job));
    job.proxy = Some(ProxyEnvelopePayload {
        url: "http://127.0.0.1:8789".into(),
        token: "inert-job-token".into(),
        expires_at: None,
    });
    assert!(processor.can_run_isolated_scoped_worker(&registration, &job));
}

#[test]
fn isolated_worker_rejects_unsupported_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let mut processor = test_job_processor(temp.path());
    processor.isolated_workers.enabled = true;
    let registration = test_registration_with_proxy();
    let mut job = worker();
    job.payload["conversation_history"] = json!([{
        "metadata":{"attachments":[{"kind":"image","fileName":"reference.png"}]}
    }]);
    assert!(!processor.can_run_isolated_scoped_worker(&registration, &job));
    job.payload
        .as_object_mut()
        .unwrap()
        .remove("conversation_history");
    job.payload["metadata"]["runtimeExpectations"]["genericMcpToolExecution"] = json!(true);
    assert!(!processor.can_run_isolated_scoped_worker(&registration, &job));
}

#[tokio::test]
async fn opted_in_scoped_jobs_cannot_fall_back_to_the_unrestricted_native_lane() {
    let temp = tempfile::tempdir().unwrap();
    let mut processor = test_job_processor(temp.path());
    processor.isolated_workers.enabled = true;
    let registration = test_registration_with_proxy();
    let mut job = worker();
    job.payload["metadata"]["attachments"] = json!([{"kind":"image"}]);
    let error = processor
        .run_apply_job(&registration, &job, true, None, None, None)
        .await
        .err()
        .expect("unsupported input must fail closed");
    assert!(
        error
            .to_string()
            .contains("require the isolated worker dispatch path")
    );
    assert_eq!(
        std::fs::read_dir(temp.path()).unwrap().count(),
        0,
        "rejection must precede workspace preparation and model execution"
    );
}
