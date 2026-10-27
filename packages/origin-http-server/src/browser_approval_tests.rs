use std::fs;
#[cfg(unix)]
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tempfile::TempDir;
use uuid::Uuid;

use super::*;

struct ApprovalFixture {
    _temp: TempDir,
    marker_path: PathBuf,
    approval_dir: PathBuf,
    bridge: BrowserApprovalBridge,
    runtime_id: String,
    marker: AgentControlMarker,
    request: PendingApprovalRequest,
}

impl ApprovalFixture {
    fn origin() -> Self {
        Self::new(ApprovalKind::Origin)
    }

    fn action() -> Self {
        Self::new(ApprovalKind::Action)
    }

    fn new(kind: ApprovalKind) -> Self {
        let temp = tempfile::tempdir().expect("approval fixture directory");
        let marker_path = temp.path().join("agent-control.json");
        let approval_dir = temp.path().join("approvals");
        fs::create_dir(&approval_dir).expect("approval directory");
        set_mode(&approval_dir, APPROVAL_DIRECTORY_MODE);

        let now = unix_time_millis();
        let marker = AgentControlMarker {
            version: 2,
            owner_id: Uuid::new_v4().to_string(),
            run_id: Uuid::new_v4().to_string(),
            initiator_user_id: Uuid::new_v4().to_string(),
            browser_page_id: "PAGE_fixture-1".to_string(),
            display_name: "Octo".to_string(),
            expires_at_ms: now + 30_000,
        };
        write_private_json(&marker_path, &marker);

        let (
            operation,
            source_origin,
            destination_origin,
            destination_fingerprint,
            snapshot_id,
            target_fingerprint,
            payload_fingerprint,
            label,
        ) = match kind {
            ApprovalKind::Origin => (
                ApprovalOperation::ApproveOrigin,
                Some("https://example.test".to_string()),
                Some("https://example.test".to_string()),
                sha256_hex(b"https://example.test/"),
                None,
                None,
                None,
                "Allow example.test for this run".to_string(),
            ),
            ApprovalKind::Action => (
                ApprovalOperation::Click,
                Some("https://example.test".to_string()),
                None,
                sha256_hex(b"no-destination"),
                Some(sha256_hex(b"snapshot")),
                Some(sha256_hex(b"target")),
                Some(sha256_hex(b"click")),
                "Activate this control".to_string(),
            ),
        };
        let mut request = PendingApprovalRequest {
            version: 1,
            approval_id: Uuid::new_v4().to_string(),
            kind,
            owner_id: marker.owner_id.clone(),
            run_id: marker.run_id.clone(),
            initiator_user_id: marker.initiator_user_id.clone(),
            browser_page_id: marker.browser_page_id.clone(),
            operation,
            source_origin,
            destination_origin: destination_origin.clone(),
            destination_fingerprint,
            snapshot_id,
            target_fingerprint,
            payload_fingerprint,
            requested_at_ms: now,
            expires_at_ms: now + 20_000,
            request_fingerprint: String::new(),
            display: ApprovalDisplay {
                label,
                destination_origin,
            },
        };
        request.request_fingerprint =
            request_fingerprint(&request).expect("fingerprint test request");
        write_private_json(&approval_dir.join("request.json"), &request);

        let runtime_id = Uuid::new_v4().to_string();
        let bridge = BrowserApprovalBridge::for_test(marker_path.clone(), approval_dir.clone());
        Self {
            _temp: temp,
            marker_path,
            approval_dir,
            bridge,
            runtime_id,
            marker,
            request,
        }
    }

    fn claims(&self, scopes: &[&str]) -> OriginClaims {
        claims(&self.marker.initiator_user_id, &self.runtime_id, scopes)
    }

    fn query(&self) -> PendingApprovalQuery {
        PendingApprovalQuery {
            runtime_id: self.runtime_id.clone(),
            browser_page_id: self.marker.browser_page_id.clone(),
        }
    }

    fn decision(&self, decision: ApprovalDecision) -> ApprovalDecisionRequest {
        ApprovalDecisionRequest {
            version: 1,
            runtime_id: self.runtime_id.clone(),
            owner_id: self.marker.owner_id.clone(),
            run_id: self.marker.run_id.clone(),
            browser_page_id: self.marker.browser_page_id.clone(),
            approval_id: self.request.approval_id.clone(),
            request_fingerprint: self.request.request_fingerprint.clone(),
            decision,
        }
    }

    fn rewrite_marker(&self) {
        write_private_json(&self.marker_path, &self.marker);
    }

    fn rewrite_request(&self) {
        write_private_json(&self.approval_dir.join("request.json"), &self.request);
    }
}

fn claims(subject: &str, runtime_id: &str, scopes: &[&str]) -> OriginClaims {
    OriginClaims {
        aud: Uuid::new_v4().to_string(),
        sub: subject.to_string(),
        project_id: Uuid::new_v4().to_string(),
        origin_id: Some(Uuid::new_v4().to_string()),
        runtime_id: Some(runtime_id.to_string()),
        protocol: Some("http".to_string()),
        scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
        lease_id: None,
        run_id: None,
        prefer_runtime: None,
        iat: None,
        exp: Some(unix_time_seconds() + 60),
        jti: Some(Uuid::new_v4().to_string()),
        actor_label: Some("Approval test user".to_string()),
        browser_session_id: Some(Uuid::new_v4().to_string()),
        author_name: None,
        author_email: None,
    }
}

fn unix_time_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn write_private_json(path: &Path, value: &impl Serialize) {
    fs::write(
        path,
        serde_json::to_vec(value).expect("serialize fixture JSON"),
    )
    .expect("write fixture JSON");
    set_mode(path, APPROVAL_FILE_MODE);
}

fn set_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set fixture mode");
    #[cfg(not(unix))]
    let _ = (path, mode);
}

fn assert_not_found<T>(result: Result<T, OriginError>) {
    assert!(matches!(result, Err(OriginError::NotFound(_))));
}

fn assert_conflict<T>(result: Result<T, OriginError>) {
    assert!(matches!(result, Err(OriginError::Conflict(_))));
}

fn assert_unavailable<T>(result: Result<T, OriginError>) {
    assert!(matches!(result, Err(OriginError::Unavailable(_))));
}

#[tokio::test]
async fn only_the_exact_initiator_can_observe_pending_request_contents() {
    let fixture = ApprovalFixture::origin();
    let envelope = fixture
        .bridge
        .observe_pending(&fixture.claims(&["browser.view"]), fixture.query())
        .await
        .expect("initiator observes pending request");
    let value = serde_json::to_value(envelope).expect("pending envelope JSON");
    assert_eq!(value["pending"]["runtimeId"], fixture.runtime_id);
    assert_eq!(value["pending"]["request"]["version"], 1);
    assert_eq!(
        value["pending"]["request"]["requestFingerprint"],
        fixture.request.request_fingerprint
    );
    assert_eq!(
        value["pending"]["request"]
            .as_object()
            .expect("request object")
            .len(),
        18
    );

    let teammate = claims(
        &Uuid::new_v4().to_string(),
        &fixture.runtime_id,
        &["browser.view", "browser.control"],
    );
    assert_not_found(
        fixture
            .bridge
            .observe_pending(&teammate, fixture.query())
            .await,
    );
    assert_not_found(
        fixture
            .bridge
            .submit_decision(&teammate, fixture.decision(ApprovalDecision::AllowOrigin))
            .await,
    );

    let control_only = fixture.claims(&["browser.control"]);
    assert!(matches!(
        fixture
            .bridge
            .observe_pending(&control_only, fixture.query())
            .await,
        Err(OriginError::Unauthorized(_))
    ));
}

#[tokio::test]
async fn origin_and_action_decisions_are_kind_bound_and_written_privately() {
    let origin = ApprovalFixture::origin();
    let response = origin
        .bridge
        .submit_decision(
            &origin.claims(&["browser.control"]),
            origin.decision(ApprovalDecision::AllowOrigin),
        )
        .await
        .expect("allow origin");
    assert!(response.accepted);
    assert_eq!(response.approval_id, origin.request.approval_id);
    assert_stored_decision(&origin, "allow_origin");
    let after_decision = origin
        .bridge
        .observe_pending(&origin.claims(&["browser.view"]), origin.query())
        .await
        .expect("decided request is no longer observable");
    assert!(
        serde_json::to_value(after_decision).expect("pending envelope JSON")["pending"].is_null()
    );

    let action = ApprovalFixture::action();
    action
        .bridge
        .submit_decision(
            &action.claims(&["browser.control"]),
            action.decision(ApprovalDecision::AllowOnce),
        )
        .await
        .expect("allow action once");
    assert_stored_decision(&action, "allow_once");

    let denied = ApprovalFixture::action();
    denied
        .bridge
        .submit_decision(
            &denied.claims(&["browser.control"]),
            denied.decision(ApprovalDecision::Deny),
        )
        .await
        .expect("deny action");
    assert_stored_decision(&denied, "deny");

    let wrong_origin_kind = ApprovalFixture::origin();
    assert!(matches!(
        wrong_origin_kind
            .bridge
            .submit_decision(
                &wrong_origin_kind.claims(&["browser.control"]),
                wrong_origin_kind.decision(ApprovalDecision::AllowOnce),
            )
            .await,
        Err(OriginError::BadRequest(_))
    ));
    let wrong_action_kind = ApprovalFixture::action();
    assert!(matches!(
        wrong_action_kind
            .bridge
            .submit_decision(
                &wrong_action_kind.claims(&["browser.control"]),
                wrong_action_kind.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
        Err(OriginError::BadRequest(_))
    ));

    let view_only = ApprovalFixture::origin();
    assert!(matches!(
        view_only
            .bridge
            .submit_decision(
                &view_only.claims(&["browser.view"]),
                view_only.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
        Err(OriginError::Unauthorized(_))
    ));
}

#[tokio::test]
async fn routine_policy_requires_an_exact_origin_prompt_and_cannot_be_granted_by_another_user() {
    let origin = ApprovalFixture::origin();
    origin
        .bridge
        .submit_decision(
            &origin.claims(&["browser.control"]),
            origin.decision(ApprovalDecision::AllowRoutine),
        )
        .await
        .expect("explicit routine origin grant");
    assert_stored_decision(&origin, "allow_routine");
    assert_conflict(
        origin
            .bridge
            .submit_decision(
                &origin.claims(&["browser.control"]),
                origin.decision(ApprovalDecision::AllowRoutine),
            )
            .await,
    );

    let action = ApprovalFixture::action();
    assert!(matches!(
        action
            .bridge
            .submit_decision(
                &action.claims(&["browser.control"]),
                action.decision(ApprovalDecision::AllowRoutine),
            )
            .await,
        Err(OriginError::BadRequest(_))
    ));

    let unapproved = ApprovalFixture::origin();
    let mut teammate = unapproved.claims(&["browser.control"]);
    teammate.sub = Uuid::new_v4().to_string();
    assert_not_found(
        unapproved
            .bridge
            .submit_decision(
                &teammate,
                unapproved.decision(ApprovalDecision::AllowRoutine),
            )
            .await,
    );
}

fn assert_stored_decision(fixture: &ApprovalFixture, expected: &str) {
    let decision_path = fixture.approval_dir.join("decision.json");
    let raw = fs::read(&decision_path).expect("stored decision");
    let value: JsonValue = serde_json::from_slice(&raw).expect("decision JSON");
    assert_eq!(value["version"], 1);
    assert_eq!(value["approvalId"], fixture.request.approval_id);
    assert_eq!(
        value["requestFingerprint"],
        fixture.request.request_fingerprint
    );
    assert_eq!(value["decision"], expected);
    assert_eq!(value["decidedByUserId"], fixture.marker.initiator_user_id);
    assert_eq!(value["expiresAtMs"], fixture.request.expires_at_ms);
    assert_eq!(value.as_object().expect("decision object").len(), 7);
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(decision_path)
            .expect("decision metadata")
            .permissions()
            .mode()
            & 0o777,
        APPROVAL_FILE_MODE
    );
}

#[tokio::test]
async fn routine_state_is_additive_and_keeps_consequential_decisions_bound() {
    for routine in [
        None,
        Some(json!(false)),
        Some(json!(true)),
        Some(json!("true")),
    ] {
        let fixture = ApprovalFixture::action();
        let mut state = json!({
            "version": 1,
            "ownerId": fixture.marker.owner_id,
            "runId": fixture.marker.run_id,
            "initiatorUserId": fixture.marker.initiator_user_id,
            "browserPageId": fixture.marker.browser_page_id,
            "approvedOrigins": [],
            "consumedApprovalIds": [],
        });
        if let Some(value) = routine.as_ref() {
            state["routineBrowsingAllowed"] = value.clone();
        }
        write_private_json(&fixture.approval_dir.join("state.json"), &state);
        let observed = fixture
            .bridge
            .observe_pending(&fixture.claims(&["browser.view"]), fixture.query())
            .await;
        let decided = fixture
            .bridge
            .submit_decision(
                &fixture.claims(&["browser.control"]),
                fixture.decision(ApprovalDecision::AllowOnce),
            )
            .await;
        if routine.as_ref().is_some_and(JsonValue::is_string) {
            assert_unavailable(observed);
            assert_unavailable(decided);
        } else {
            assert!(observed
                .expect("bounded consequential request")
                .pending
                .is_some());
            assert!(decided.is_ok());
            assert_stored_decision(&fixture, "allow_once");
        }
    }
}

#[tokio::test]
async fn a_run_that_declined_a_site_still_shows_and_takes_its_next_prompt() {
    // After the person declines one site, the run goes on and asks about the
    // next one; the state then lists the declined site.
    for declined in [None, Some(json!([])), Some(json!(["https://declined.example"]))] {
        let fixture = ApprovalFixture::action();
        let mut state = json!({
            "version": 1,
            "ownerId": fixture.marker.owner_id,
            "runId": fixture.marker.run_id,
            "initiatorUserId": fixture.marker.initiator_user_id,
            "browserPageId": fixture.marker.browser_page_id,
            "approvedOrigins": [],
            "consumedApprovalIds": [],
        });
        if let Some(value) = declined.as_ref() {
            state["declinedOrigins"] = value.clone();
        }
        write_private_json(&fixture.approval_dir.join("state.json"), &state);
        let observed = fixture
            .bridge
            .observe_pending(&fixture.claims(&["browser.view"]), fixture.query())
            .await;
        assert!(observed.expect("the next prompt").pending.is_some());
        let decided = fixture
            .bridge
            .submit_decision(
                &fixture.claims(&["browser.control"]),
                fixture.decision(ApprovalDecision::AllowOnce),
            )
            .await;
        assert!(decided.is_ok());
        assert_stored_decision(&fixture, "allow_once");
    }
}

#[test]
fn non_activating_type_and_press_key_require_exact_target_payload_and_no_destination() {
    for operation in [ApprovalOperation::Type, ApprovalOperation::PressKey] {
        let mut valid = ApprovalFixture::action();
        valid.request.operation = operation;
        valid.request.request_fingerprint =
            request_fingerprint(&valid.request).expect("refingerprint non-activating action");
        assert!(
            validate_pending_request(&valid.request, unix_time_millis()).is_ok(),
            "valid {operation} request was rejected"
        );

        let mut with_destination = ApprovalFixture::action();
        with_destination.request.operation = operation;
        with_destination.request.destination_origin =
            Some("https://destination.example".to_string());
        with_destination.request.destination_fingerprint =
            sha256_hex(b"https://destination.example/path");
        with_destination.request.display.destination_origin =
            with_destination.request.destination_origin.clone();
        with_destination.request.request_fingerprint =
            request_fingerprint(&with_destination.request)
                .expect("refingerprint destination mismatch");
        assert!(
            validate_pending_request(&with_destination.request, unix_time_millis()).is_err(),
            "{operation} unexpectedly accepted a destination binding"
        );

        let mut without_target = ApprovalFixture::action();
        without_target.request.operation = operation;
        without_target.request.target_fingerprint = None;
        without_target.request.request_fingerprint =
            request_fingerprint(&without_target.request).expect("refingerprint target mismatch");
        assert!(
            validate_pending_request(&without_target.request, unix_time_millis()).is_err(),
            "{operation} unexpectedly accepted a missing target binding"
        );
    }
}

#[tokio::test]
async fn every_runtime_page_run_owner_and_request_binding_is_exact() {
    let fixture = ApprovalFixture::origin();

    let mut wrong_runtime_query = fixture.query();
    wrong_runtime_query.runtime_id = Uuid::new_v4().to_string();
    assert!(matches!(
        fixture
            .bridge
            .observe_pending(&fixture.claims(&["browser.view"]), wrong_runtime_query)
            .await,
        Err(OriginError::Unauthorized(_))
    ));
    let wrong_runtime_claims = claims(
        &fixture.marker.initiator_user_id,
        &Uuid::new_v4().to_string(),
        &["browser.view"],
    );
    assert!(matches!(
        fixture
            .bridge
            .observe_pending(&wrong_runtime_claims, fixture.query())
            .await,
        Err(OriginError::Unauthorized(_))
    ));

    let mut wrong_page = fixture.query();
    wrong_page.browser_page_id = "PAGE_other".to_string();
    assert_not_found(
        fixture
            .bridge
            .observe_pending(&fixture.claims(&["browser.view"]), wrong_page)
            .await,
    );

    for mutation in ["runtime", "owner", "run", "page", "approval", "fingerprint"] {
        let mut body = fixture.decision(ApprovalDecision::AllowOrigin);
        match mutation {
            "runtime" => body.runtime_id = Uuid::new_v4().to_string(),
            "owner" => body.owner_id = Uuid::new_v4().to_string(),
            "run" => body.run_id = Uuid::new_v4().to_string(),
            "page" => body.browser_page_id = "PAGE_other".to_string(),
            "approval" => body.approval_id = Uuid::new_v4().to_string(),
            "fingerprint" => body.request_fingerprint = sha256_hex(b"other request"),
            _ => unreachable!(),
        }
        let result = fixture
            .bridge
            .submit_decision(&fixture.claims(&["browser.control"]), body)
            .await;
        if mutation == "runtime" {
            assert!(matches!(result, Err(OriginError::Unauthorized(_))));
        } else if mutation == "page" {
            assert_not_found(result);
        } else {
            assert_conflict(result);
        }
    }

    let mut request_mismatch = ApprovalFixture::origin();
    request_mismatch.request.run_id = Uuid::new_v4().to_string();
    request_mismatch.request.request_fingerprint =
        request_fingerprint(&request_mismatch.request).expect("refingerprint request");
    request_mismatch.rewrite_request();
    assert_conflict(
        request_mismatch
            .bridge
            .observe_pending(
                &request_mismatch.claims(&["browser.view"]),
                request_mismatch.query(),
            )
            .await,
    );
}

#[tokio::test]
async fn stale_or_expired_authority_and_requests_fail_closed() {
    let mut stale_marker = ApprovalFixture::origin();
    stale_marker.marker.expires_at_ms = unix_time_millis().saturating_sub(1);
    stale_marker.rewrite_marker();
    assert_conflict(
        stale_marker
            .bridge
            .observe_pending(
                &stale_marker.claims(&["browser.view"]),
                stale_marker.query(),
            )
            .await,
    );
    assert_conflict(
        stale_marker
            .bridge
            .submit_decision(
                &stale_marker.claims(&["browser.control"]),
                stale_marker.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
    );

    let mut stale_request = ApprovalFixture::origin();
    stale_request.request.requested_at_ms = unix_time_millis().saturating_sub(10_000);
    stale_request.request.expires_at_ms = unix_time_millis().saturating_sub(1);
    stale_request.request.request_fingerprint =
        request_fingerprint(&stale_request.request).expect("refingerprint stale request");
    stale_request.rewrite_request();
    assert_unavailable(
        stale_request
            .bridge
            .observe_pending(
                &stale_request.claims(&["browser.view"]),
                stale_request.query(),
            )
            .await,
    );
    assert_conflict(
        stale_request
            .bridge
            .submit_decision(
                &stale_request.claims(&["browser.control"]),
                stale_request.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
    );
}

#[tokio::test]
async fn malformed_unknown_oversized_and_unprotected_files_are_rejected() {
    let malformed = ApprovalFixture::origin();
    let request_path = malformed.approval_dir.join("request.json");
    fs::write(&request_path, b"{not-json").expect("malformed request");
    set_mode(&request_path, APPROVAL_FILE_MODE);
    let teammate = claims(
        &Uuid::new_v4().to_string(),
        &malformed.runtime_id,
        &["browser.view"],
    );
    assert_not_found(
        malformed
            .bridge
            .observe_pending(&teammate, malformed.query())
            .await,
    );
    assert_unavailable(
        malformed
            .bridge
            .observe_pending(&malformed.claims(&["browser.view"]), malformed.query())
            .await,
    );

    let unknown = ApprovalFixture::origin();
    let mut unknown_value = serde_json::to_value(&unknown.request).expect("request value");
    unknown_value["pageText"] = json!("must never cross the origin boundary");
    write_private_json(&unknown.approval_dir.join("request.json"), &unknown_value);
    assert_unavailable(
        unknown
            .bridge
            .observe_pending(&unknown.claims(&["browser.view"]), unknown.query())
            .await,
    );

    let mut non_normalized = ApprovalFixture::origin();
    non_normalized.request.display.label = "Allow  this site".to_string();
    non_normalized.request.request_fingerprint =
        request_fingerprint(&non_normalized.request).expect("refingerprint request");
    non_normalized.rewrite_request();
    assert_unavailable(
        non_normalized
            .bridge
            .observe_pending(
                &non_normalized.claims(&["browser.view"]),
                non_normalized.query(),
            )
            .await,
    );

    let oversized = ApprovalFixture::origin();
    let oversized_path = oversized.approval_dir.join("request.json");
    fs::write(
        &oversized_path,
        vec![b'x'; APPROVAL_REQUEST_MAX_BYTES as usize + 1],
    )
    .expect("oversized request");
    set_mode(&oversized_path, APPROVAL_FILE_MODE);
    assert_unavailable(
        oversized
            .bridge
            .observe_pending(&oversized.claims(&["browser.view"]), oversized.query())
            .await,
    );

    #[cfg(unix)]
    {
        let unprotected = ApprovalFixture::origin();
        set_mode(&unprotected.approval_dir.join("request.json"), 0o644);
        assert_unavailable(
            unprotected
                .bridge
                .observe_pending(&unprotected.claims(&["browser.view"]), unprotected.query())
                .await,
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_marker_directory_request_and_decision_slots_are_rejected() {
    let marker_link = ApprovalFixture::origin();
    let real_marker = marker_link.marker_path.with_extension("real");
    fs::rename(&marker_link.marker_path, &real_marker).expect("move marker");
    symlink(&real_marker, &marker_link.marker_path).expect("marker symlink");
    assert!(matches!(
        marker_link.bridge.read_agent_control().await,
        AgentControlMarkerObservation::Unavailable(_)
    ));

    let request_link = ApprovalFixture::origin();
    let request_path = request_link.approval_dir.join("request.json");
    let real_request = request_link.approval_dir.join("request-real.json");
    fs::rename(&request_path, &real_request).expect("move request");
    symlink(&real_request, &request_path).expect("request symlink");
    assert_unavailable(
        request_link
            .bridge
            .observe_pending(
                &request_link.claims(&["browser.view"]),
                request_link.query(),
            )
            .await,
    );

    let directory_link = ApprovalFixture::origin();
    let real_dir = directory_link.approval_dir.with_extension("real");
    fs::rename(&directory_link.approval_dir, &real_dir).expect("move approval dir");
    symlink(&real_dir, &directory_link.approval_dir).expect("approval directory symlink");
    assert_unavailable(
        directory_link
            .bridge
            .observe_pending(
                &directory_link.claims(&["browser.view"]),
                directory_link.query(),
            )
            .await,
    );

    let decision_link = ApprovalFixture::origin();
    let external = decision_link.approval_dir.join("external.json");
    write_private_json(&external, &json!({"doNotOverwrite": true}));
    symlink(&external, decision_link.approval_dir.join("decision.json")).expect("decision symlink");
    assert_unavailable(
        decision_link
            .bridge
            .observe_pending(
                &decision_link.claims(&["browser.view"]),
                decision_link.query(),
            )
            .await,
    );
    assert_unavailable(
        decision_link
            .bridge
            .submit_decision(
                &decision_link.claims(&["browser.control"]),
                decision_link.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
    );
    assert_eq!(
        fs::read_to_string(external).expect("external decision target"),
        "{\"doNotOverwrite\":true}"
    );
}

#[tokio::test]
async fn consumed_existing_and_replayed_decisions_are_rejected() {
    let consumed = ApprovalFixture::origin();
    write_private_json(
        &consumed.approval_dir.join("state.json"),
        &json!({
            "version": 1,
            "ownerId": consumed.marker.owner_id,
            "runId": consumed.marker.run_id,
            "initiatorUserId": consumed.marker.initiator_user_id,
            "browserPageId": consumed.marker.browser_page_id,
            "approvedOrigins": [],
            "consumedApprovalIds": [consumed.request.approval_id],
        }),
    );
    assert_conflict(
        consumed
            .bridge
            .submit_decision(
                &consumed.claims(&["browser.control"]),
                consumed.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
    );

    let existing = ApprovalFixture::origin();
    write_private_json(
        &existing.approval_dir.join("decision.json"),
        &json!({"mismatched": true}),
    );
    assert_conflict(
        existing
            .bridge
            .submit_decision(
                &existing.claims(&["browser.control"]),
                existing.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
    );

    let replay = ApprovalFixture::origin();
    replay
        .bridge
        .submit_decision(
            &replay.claims(&["browser.control"]),
            replay.decision(ApprovalDecision::AllowOrigin),
        )
        .await
        .expect("first decision");
    fs::remove_file(replay.approval_dir.join("decision.json")).expect("agent consumes decision");
    assert_conflict(
        replay
            .bridge
            .submit_decision(
                &replay.claims(&["browser.control"]),
                replay.decision(ApprovalDecision::AllowOrigin),
            )
            .await,
    );
}

#[test]
fn marker_heartbeats_preserve_the_same_exact_authority_binding() {
    let fixture = ApprovalFixture::origin();
    let mut heartbeat = fixture.marker.clone();
    heartbeat.expires_at_ms += 3_000;
    heartbeat.display_name = "Assistant".to_string();
    assert!(same_agent_authority(&fixture.marker, &heartbeat));
    heartbeat.run_id = Uuid::new_v4().to_string();
    assert!(!same_agent_authority(&fixture.marker, &heartbeat));
}

#[tokio::test]
async fn independent_origin_publishers_cannot_replace_each_others_decision() {
    let fixture = ApprovalFixture::origin();
    let other_bridge =
        BrowserApprovalBridge::for_test(fixture.marker_path.clone(), fixture.approval_dir.clone());
    let first_claims = fixture.claims(&["browser.control"]);
    let second_claims = fixture.claims(&["browser.control"]);
    let first = fixture.bridge.submit_decision(
        &first_claims,
        fixture.decision(ApprovalDecision::AllowOrigin),
    );
    let second =
        other_bridge.submit_decision(&second_claims, fixture.decision(ApprovalDecision::Deny));
    let (first, second) = tokio::join!(first, second);
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert_eq!(
        usize::from(matches!(first, Err(OriginError::Conflict(_))))
            + usize::from(matches!(second, Err(OriginError::Conflict(_)))),
        1
    );

    let value: JsonValue = serde_json::from_slice(
        &fs::read(fixture.approval_dir.join("decision.json")).expect("winning decision"),
    )
    .expect("winning decision JSON");
    assert!(matches!(
        value["decision"].as_str(),
        Some("allow_origin" | "deny")
    ));
    assert_eq!(value["approvalId"], fixture.request.approval_id);
    assert_eq!(
        value["requestFingerprint"],
        fixture.request.request_fingerprint
    );
}

#[test]
fn decision_schema_and_enums_are_exact_and_bounded() {
    let fixture = ApprovalFixture::origin();
    let base = json!({
        "version": 1,
        "runtimeId": fixture.runtime_id,
        "ownerId": fixture.marker.owner_id,
        "runId": fixture.marker.run_id,
        "browserPageId": fixture.marker.browser_page_id,
        "approvalId": fixture.request.approval_id,
        "requestFingerprint": fixture.request.request_fingerprint,
        "decision": "allow_origin",
    });
    assert!(serde_json::from_value::<ApprovalDecisionRequest>(base.clone()).is_ok());
    let mut unknown = base.clone();
    unknown["reason"] = json!("extra fields are rejected");
    assert!(serde_json::from_value::<ApprovalDecisionRequest>(unknown).is_err());
    let mut invalid_enum = base;
    invalid_enum["decision"] = json!("allow");
    assert!(serde_json::from_value::<ApprovalDecisionRequest>(invalid_enum).is_err());

    let response = no_store_json(json!({"pending": null}));
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL),
        Some(&HeaderValue::from_static("private, no-store, max-age=0"))
    );
}

#[test]
fn request_fingerprint_matches_the_node_protocol_field_order() {
    let request = PendingApprovalRequest {
        version: 1,
        approval_id: "11111111-1111-4111-8111-111111111111".to_string(),
        kind: ApprovalKind::Action,
        owner_id: "22222222-2222-4222-8222-222222222222".to_string(),
        run_id: "33333333-3333-4333-8333-333333333333".to_string(),
        initiator_user_id: "44444444-4444-4444-8444-444444444444".to_string(),
        browser_page_id: "PAGE_1".to_string(),
        operation: ApprovalOperation::Click,
        source_origin: Some("https://example.test".to_string()),
        destination_origin: None,
        destination_fingerprint: "a".repeat(64),
        snapshot_id: Some("b".repeat(64)),
        target_fingerprint: Some("c".repeat(64)),
        payload_fingerprint: Some("d".repeat(64)),
        requested_at_ms: 1_700_000_000_000,
        expires_at_ms: 1_700_000_030_000,
        request_fingerprint: String::new(),
        display: ApprovalDisplay {
            label: "Activate this control".to_string(),
            destination_origin: None,
        },
    };
    assert_eq!(
        request_fingerprint(&request).expect("fingerprint request"),
        "3016f261e701963ec8b0809b047e1c7b9b36c750b621f25519e90b2bf28a905c"
    );
}

/// The Shared Browser script gives a person two minutes by default and at
/// most five. A request the script publishes must reach the person whatever
/// its lifetime within that range; anything longer is still refused.
#[tokio::test]
async fn requests_live_as_long_as_the_runtime_approval_window() {
    for (lifetime, accepted) in [
        (120_000, true),
        (MAX_APPROVAL_LIFETIME_MS, true),
        (MAX_APPROVAL_LIFETIME_MS + 1, false),
        (MIN_APPROVAL_LIFETIME_MS - 1, false),
    ] {
        let mut fixture = ApprovalFixture::action();
        let now = unix_time_millis();
        fixture.request.requested_at_ms = now;
        fixture.request.expires_at_ms = now + lifetime;
        fixture.request.request_fingerprint =
            request_fingerprint(&fixture.request).expect("refingerprint request");
        fixture.rewrite_request();
        assert_eq!(
            validate_pending_request(&fixture.request, now).is_ok(),
            accepted,
            "lifetime {lifetime}"
        );
        let observed = fixture
            .bridge
            .observe_pending(&fixture.claims(&["browser.view"]), fixture.query())
            .await;
        if accepted {
            assert!(
                observed.expect("pending request").pending.is_some(),
                "lifetime {lifetime}"
            );
            assert!(fixture
                .bridge
                .submit_decision(
                    &fixture.claims(&["browser.control"]),
                    fixture.decision(ApprovalDecision::AllowOnce),
                )
                .await
                .is_ok());
            assert_stored_decision(&fixture, "allow_once");
        } else {
            assert_unavailable(observed);
        }
    }
}

#[test]
fn a_page_a_credential_step_opens_stays_withheld_for_a_sent_page() {
    let fixture = ApprovalFixture::origin();
    let record = fixture.approval_dir.join("withhold-next.json");
    // No step is waiting for the page it opens.
    assert_eq!(
        fixture.bridge.carried_withholding(),
        CarriedWithholding::Nothing
    );

    // The record the Shared Browser controller writes before such a step.
    write_private_json(
        &record,
        &json!({
            "version": 1,
            "ownerId": fixture.marker.owner_id,
            "runId": fixture.marker.run_id,
            "initiatorUserId": fixture.marker.initiator_user_id,
            "browserPageId": fixture.marker.browser_page_id,
            "afterDocument": "LOADER_step-1",
        }),
    );
    let carried = fixture.bridge.carried_withholding();
    assert_eq!(
        carried,
        CarriedWithholding::After("LOADER_step-1".to_string())
    );
    assert!(!carried.withholds("LOADER_step-1"));
    assert!(carried.withholds("LOADER_opened-2"));

    // A record that cannot be trusted withholds every page.
    for bad in [
        &b"not json"[..],
        &br#"{"afterDocument":"../x"}"#[..],
        &b"{}"[..],
    ] {
        fs::write(&record, bad).expect("rewrite record");
        set_mode(&record, APPROVAL_FILE_MODE);
        assert_eq!(
            fixture.bridge.carried_withholding(),
            CarriedWithholding::Unknown
        );
    }
    #[cfg(unix)]
    {
        write_private_json(&record, &json!({ "afterDocument": "LOADER_step-1" }));
        set_mode(&record, 0o644);
        assert_eq!(
            fixture.bridge.carried_withholding(),
            CarriedWithholding::Unknown
        );
    }
    assert!(CarriedWithholding::Unknown.withholds("LOADER_step-1"));
    assert!(!CarriedWithholding::Nothing.withholds("LOADER_step-1"));
}

/// The run's tab record as the controller writes it: tab N of `tab_ids` is
/// "Octo's tab N + 1".
fn write_agent_tabs(fixture: &ApprovalFixture, tab_ids: &[&str]) {
    write_private_json(
        &fixture.approval_dir.join(AGENT_TABS_FILE),
        &json!({
            "version": 2,
            "ownerId": fixture.marker.owner_id,
            "runId": fixture.marker.run_id,
            "initiatorUserId": fixture.marker.initiator_user_id,
            "browserPageId": fixture.marker.browser_page_id,
            "currentTabId": tab_ids.first(),
            "lastTabNumber": tab_ids.len(),
            "tabs": tab_ids
                .iter()
                .enumerate()
                .map(|(index, tab_id)| json!({ "tabId": tab_id, "number": index + 1, "approvedOrigins": ["https://example.test"] }))
                .collect::<Vec<_>>(),
        }),
    );
}

fn write_leftover_tabs(fixture: &ApprovalFixture, tabs: JsonValue) {
    write_private_json(
        &fixture.approval_dir.join(LEFTOVER_AGENT_TABS_FILE),
        &json!({ "version": 1, "tabs": tabs }),
    );
}

fn kept_record(fixture: &ApprovalFixture) -> JsonValue {
    serde_json::from_slice(
        &fs::read(fixture.approval_dir.join(KEPT_AGENT_TABS_FILE)).expect("kept tabs"),
    )
    .expect("kept tabs JSON")
}

#[tokio::test]
async fn octos_tabs_are_read_only_from_the_running_turns_own_record() {
    let fixture = ApprovalFixture::origin();
    assert_eq!(fixture.bridge.agent_tabs().await, AgentTabs::default());
    write_agent_tabs(&fixture, &["TAB-A", "TAB-B"]);
    assert_eq!(
        fixture.bridge.agent_tabs().await,
        AgentTabs {
            tab_ids: vec!["TAB-A".to_string(), "TAB-B".to_string()],
            kept: Vec::new(),
            numbers: vec![("TAB-A".to_string(), 1), ("TAB-B".to_string(), 2)],
            leftover: Vec::new(),
        }
    );

    // Another run's record, a record naming the run's own page, a fourth
    // tab or an unprotected file badges nothing.
    let mut other = fixture.marker.clone();
    other.run_id = Uuid::new_v4().to_string();
    let own = |tabs: JsonValue, last_tab_number: u64| {
        json!({
            "version": 2, "ownerId": fixture.marker.owner_id, "runId": fixture.marker.run_id,
            "initiatorUserId": fixture.marker.initiator_user_id,
            "browserPageId": fixture.marker.browser_page_id, "currentTabId": null,
            "lastTabNumber": last_tab_number, "tabs": tabs,
        })
    };
    for record in [
        json!({
            "version": 2, "ownerId": other.owner_id, "runId": other.run_id,
            "initiatorUserId": other.initiator_user_id, "browserPageId": other.browser_page_id,
            "currentTabId": null, "lastTabNumber": 1,
            "tabs": [{ "tabId": "TAB-A", "number": 1, "approvedOrigins": [] }],
        }),
        own(json!([{ "tabId": fixture.marker.browser_page_id, "number": 1, "approvedOrigins": [] }]), 1),
        own(json!(["A", "B", "C", "D"].iter().enumerate().map(|(index, tab_id)| json!({ "tabId": tab_id, "number": index + 1, "approvedOrigins": [] })).collect::<Vec<_>>()), 4),
        // Numbers out of bounds, repeated, or past the run's last number.
        own(json!([{ "tabId": "TAB-A", "number": 0, "approvedOrigins": [] }]), 1),
        own(json!([{ "tabId": "TAB-A", "number": 2, "approvedOrigins": [] }]), 1),
        own(json!([{ "tabId": "TAB-A", "number": 1, "approvedOrigins": [] }, { "tabId": "TAB-B", "number": 1, "approvedOrigins": [] }]), 2),
        own(json!([{ "tabId": "TAB-A", "number": 1, "approvedOrigins": [] }]), 1000),
        // An earlier record without numbers.
        json!({
            "version": 1, "ownerId": fixture.marker.owner_id, "runId": fixture.marker.run_id,
            "initiatorUserId": fixture.marker.initiator_user_id,
            "browserPageId": fixture.marker.browser_page_id, "currentTabId": null,
            "tabs": [{ "tabId": "TAB-A", "approvedOrigins": [] }],
        }),
    ] {
        write_private_json(&fixture.approval_dir.join(AGENT_TABS_FILE), &record);
        assert_eq!(
            fixture.bridge.agent_tabs().await,
            AgentTabs::default(),
            "{record}"
        );
    }
    write_agent_tabs(&fixture, &["TAB-A"]);
    set_mode(&fixture.approval_dir.join(AGENT_TABS_FILE), 0o644);
    assert_eq!(fixture.bridge.agent_tabs().await, AgentTabs::default());

    // When the run ends its marker goes, and so do the badges.
    write_agent_tabs(&fixture, &["TAB-A"]);
    fs::remove_file(&fixture.marker_path).expect("run ends");
    assert_eq!(fixture.bridge.agent_tabs().await, AgentTabs::default());
}

#[tokio::test]
async fn a_person_keeps_only_octos_tabs_of_the_running_turn() {
    let fixture = ApprovalFixture::origin();
    write_agent_tabs(&fixture, &["TAB-A", "TAB-B"]);

    // The run's own page and any other tab are not Octo's to keep.
    assert_not_found(
        fixture
            .bridge
            .keep_agent_tab(&fixture.marker.browser_page_id)
            .await,
    );
    assert_not_found(fixture.bridge.keep_agent_tab("SOMEONE-ELSES-TAB").await);
    assert!(matches!(
        fixture.bridge.keep_agent_tab("../tabs.json").await,
        Err(OriginError::BadRequest(_))
    ));
    assert!(!fixture.approval_dir.join(KEPT_AGENT_TABS_FILE).exists());

    let kept = fixture
        .bridge
        .keep_agent_tab("TAB-B")
        .await
        .expect("keep TAB-B");
    assert!(kept.kept);
    fixture
        .bridge
        .keep_agent_tab("TAB-B")
        .await
        .expect("keep again");
    fixture
        .bridge
        .keep_agent_tab("TAB-A")
        .await
        .expect("keep TAB-A");
    let record = kept_record(&fixture);
    assert_eq!(record["tabIds"], json!(["TAB-B", "TAB-A"]));
    assert_eq!(record["ownerId"], fixture.marker.owner_id);
    assert_eq!(record["runId"], fixture.marker.run_id);
    assert_eq!(record["browserPageId"], fixture.marker.browser_page_id);
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(fixture.approval_dir.join(KEPT_AGENT_TABS_FILE))
            .expect("kept tabs")
            .permissions()
            .mode()
            & 0o777,
        APPROVAL_FILE_MODE
    );
    assert_eq!(
        fixture.bridge.agent_tabs().await.kept,
        vec!["TAB-B".to_string(), "TAB-A".to_string()]
    );
    // No leftover temporary file in the run's directory.
    assert_eq!(
        fs::read_dir(&fixture.approval_dir)
            .expect("approval directory")
            .filter(|entry| entry
                .as_ref()
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with('.'))
            .count(),
        0
    );

    // Once the turn has ended nothing is kept.
    fs::remove_file(&fixture.marker_path).expect("run ends");
    assert_not_found(fixture.bridge.keep_agent_tab("TAB-A").await);
}

#[tokio::test]
async fn tabs_an_earlier_run_left_open_stay_badged_as_earlier_tabs() {
    let fixture = ApprovalFixture::origin();
    // A run that ended without a confirmed shutdown left two of Octo's tabs
    // open; runtime-agent recorded them before revoking the run.
    fs::remove_file(&fixture.marker_path).expect("the run is gone");
    write_leftover_tabs(
        &fixture,
        json!([{ "tabId": "EARLIER-A" }, { "tabId": "EARLIER-B" }]),
    );
    assert_eq!(
        fixture.bridge.agent_tabs().await,
        AgentTabs {
            tab_ids: vec!["EARLIER-A".to_string(), "EARLIER-B".to_string()],
            kept: Vec::new(),
            numbers: Vec::new(),
            leftover: vec!["EARLIER-A".to_string(), "EARLIER-B".to_string()],
        }
    );

    // While a new run holds the browser, its own tabs come first and carry
    // its numbers. The earlier tabs carry none, so no label repeats one of
    // the new run's, and they are not the new run's tabs.
    write_private_json(&fixture.marker_path, &fixture.marker);
    write_agent_tabs(&fixture, &["TAB-A"]);
    let tabs = fixture.bridge.agent_tabs().await;
    assert_eq!(tabs.tab_ids, vec!["TAB-A", "EARLIER-A", "EARLIER-B"]);
    assert_eq!(tabs.number_of("TAB-A"), Some(1));
    assert_eq!(tabs.number_of("EARLIER-A"), None);
    assert!(!tabs.is_leftover("TAB-A"));
    assert!(tabs.is_leftover("EARLIER-A"));
    assert!(tabs.is_leftover("EARLIER-B"));

    // A record that cannot be read safely badges nothing of its own.
    for record in [
        json!({ "version": 2, "tabs": [{ "tabId": "EARLIER-A" }] }),
        json!({ "version": 1, "tabs": [{ "tabId": "../tabs.json" }] }),
        json!({ "version": 1, "tabs": [{ "tabId": "EARLIER-A" }, { "tabId": "EARLIER-A" }] }),
        json!({ "version": 1, "tabs": [{ "tabId": "EARLIER-A", "number": 1 }] }),
        json!({ "version": 1, "tabs": [{ "tabId": "EARLIER-A", "approvedOrigins": [] }] }),
        json!({ "version": 1, "tabs": (0..13).map(|index| json!({ "tabId": format!("T{index}") })).collect::<Vec<_>>() }),
    ] {
        write_private_json(
            &fixture.approval_dir.join(LEFTOVER_AGENT_TABS_FILE),
            &record,
        );
        let tabs = fixture.bridge.agent_tabs().await;
        assert_eq!(tabs.tab_ids, vec!["TAB-A"], "{record}");
        assert!(tabs.leftover.is_empty(), "{record}");
    }
    write_leftover_tabs(&fixture, json!([{ "tabId": "EARLIER-A" }]));
    set_mode(&fixture.approval_dir.join(LEFTOVER_AGENT_TABS_FILE), 0o644);
    assert_eq!(fixture.bridge.agent_tabs().await.tab_ids, vec!["TAB-A"]);
}

#[tokio::test]
async fn keeping_a_tab_an_earlier_run_left_open_makes_it_an_ordinary_tab() {
    let fixture = ApprovalFixture::origin();
    write_agent_tabs(&fixture, &["TAB-A"]);
    write_leftover_tabs(
        &fixture,
        json!([{ "tabId": "EARLIER-A" }, { "tabId": "EARLIER-B" }]),
    );

    // During a run, Keep tab on a leftover tab takes it off the record that
    // runtime-agent closes; it is not added to this run's kept tabs.
    let kept = fixture
        .bridge
        .keep_agent_tab("EARLIER-A")
        .await
        .expect("keep a leftover tab");
    assert!(kept.kept);
    assert!(!fixture.approval_dir.join(KEPT_AGENT_TABS_FILE).exists());
    assert_eq!(
        fixture.bridge.agent_tabs().await.tab_ids,
        vec!["TAB-A", "EARLIER-B"]
    );
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(fixture.approval_dir.join(LEFTOVER_AGENT_TABS_FILE))
            .expect("leftover tabs")
            .permissions()
            .mode()
            & 0o777,
        APPROVAL_FILE_MODE
    );

    // With no run holding the browser, the same.
    fs::remove_file(&fixture.marker_path).expect("the run ends");
    fixture
        .bridge
        .keep_agent_tab("EARLIER-B")
        .await
        .expect("keep a leftover tab");
    assert_eq!(fixture.bridge.agent_tabs().await, AgentTabs::default());
    let record: JsonValue = serde_json::from_slice(
        &fs::read(fixture.approval_dir.join(LEFTOVER_AGENT_TABS_FILE)).expect("leftover"),
    )
    .expect("leftover JSON");
    assert_eq!(record, json!({ "version": 1, "tabs": [] }));

    // Anything else is not Octo's to keep.
    assert_not_found(fixture.bridge.keep_agent_tab("EARLIER-A").await);
    assert_not_found(fixture.bridge.keep_agent_tab("SOMEONE-ELSES-TAB").await);
    fs::remove_dir_all(&fixture.approval_dir).expect("no approval directory");
    assert_not_found(fixture.bridge.keep_agent_tab("EARLIER-A").await);
}

#[cfg(unix)]
#[tokio::test]
async fn keeping_an_earlier_tab_never_undoes_runtime_agents_update_of_the_record() {
    let fixture = ApprovalFixture::origin();
    fs::remove_file(&fixture.marker_path).expect("no run holds the browser");
    write_leftover_tabs(
        &fixture,
        json!([{ "tabId": "EARLIER-A" }, { "tabId": "EARLIER-B" }]),
    );
    // A run ends meanwhile: under the approval directory's lock,
    // runtime-agent adds the run's tab it could not close to the record.
    let (locked, runtime_agent_holds_the_lock) = std::sync::mpsc::channel();
    let approval_dir = fixture.approval_dir.clone();
    let runtime_agent = std::thread::spawn(move || {
        let directory = fs::File::open(&approval_dir).expect("open the approval directory");
        fs2::FileExt::lock_exclusive(&directory).expect("lock the approval directory");
        locked.send(()).expect("report the lock");
        std::thread::sleep(std::time::Duration::from_millis(300));
        write_private_json(
            &approval_dir.join(LEFTOVER_AGENT_TABS_FILE),
            &json!({ "version": 1, "tabs": [
                { "tabId": "EARLIER-A" }, { "tabId": "EARLIER-B" }, { "tabId": "TAB-A" }
            ] }),
        );
        fs2::FileExt::unlock(&directory).expect("unlock the approval directory");
    });
    runtime_agent_holds_the_lock
        .recv()
        .expect("runtime-agent holds the lock");

    // A person keeps EARLIER-A in that moment: both changes stand.
    fixture
        .bridge
        .keep_agent_tab("EARLIER-A")
        .await
        .expect("keep a leftover tab");
    runtime_agent
        .join()
        .expect("runtime-agent settles the record");
    assert_eq!(
        fixture.bridge.agent_tabs().await.tab_ids,
        vec!["EARLIER-B", "TAB-A"]
    );
}
