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
