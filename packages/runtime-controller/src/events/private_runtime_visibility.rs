use std::collections::HashSet;

use axum::http::StatusCode;
use axum::Json;
use serde_json::Value as JsonValue;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::state::{AppState, ControllerEvent};
use crate::{database_unavailable, forbidden, ApiError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VisibilityScope {
    Runtime,
    Origin,
    Tunnel,
    LocalWorkspace,
}

#[derive(Debug, Default)]
struct RuntimeReferences {
    runtime_ids: HashSet<Uuid>,
    runtime_lease_ids: HashSet<Uuid>,
    origin_ids: HashSet<Uuid>,
    tunnel_grant_ids: HashSet<Uuid>,
    tunnel_ids: HashSet<String>,
}

pub(super) async fn ensure_visible(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: Uuid,
    event: &ControllerEvent,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.is_service_role {
        return Ok(());
    }

    let mut payload_runtime_ids = HashSet::new();
    let has_payload_runtime_reference =
        collect_keyed_uuids(&event.data, runtime_id_key, true, &mut payload_runtime_ids)
            .ok_or_else(private_event)?;
    let scope = visibility_scope(&event.kind);
    if scope.is_none() && !has_payload_runtime_reference {
        return Ok(());
    }

    if scope == Some(VisibilityScope::LocalWorkspace)
        && !event
            .target_user_id
            .is_some_and(|target| context.user_id == Some(target))
    {
        return Err(private_event());
    }

    let mut references = match scope {
        Some(scope) => event_references(event, scope).ok_or_else(private_event)?,
        None => RuntimeReferences::default(),
    };
    references.runtime_ids.extend(payload_runtime_ids);

    if scope == Some(VisibilityScope::Origin) {
        resolve_origin_runtime_ids(
            state,
            transaction,
            project_id,
            &references.origin_ids,
            &mut references.runtime_ids,
        )
        .await?;
    }

    if scope == Some(VisibilityScope::Tunnel) {
        resolve_tunnel_runtime_ids(transaction, project_id, &mut references).await?;
        if references.runtime_ids.is_empty() {
            return Err(private_event());
        }
    }

    ensure_runtime_ids_visible(
        state,
        transaction,
        project_id,
        &references.runtime_ids,
        context,
    )
    .await
}

fn visibility_scope(kind: &str) -> Option<VisibilityScope> {
    if kind.starts_with("runtime.") {
        Some(VisibilityScope::Runtime)
    } else if kind.starts_with("origin.") || kind == "workspace.commit" {
        Some(VisibilityScope::Origin)
    } else if kind.starts_with("tunnel.") {
        Some(VisibilityScope::Tunnel)
    } else if kind.starts_with("local_workspace.") {
        Some(VisibilityScope::LocalWorkspace)
    } else {
        None
    }
}

fn event_references(event: &ControllerEvent, scope: VisibilityScope) -> Option<RuntimeReferences> {
    let mut references = RuntimeReferences::default();

    match scope {
        VisibilityScope::Runtime => {
            collect_keyed_uuids(
                &event.data,
                runtime_id_key,
                true,
                &mut references.runtime_ids,
            )?;
            if event.kind == "runtime.shared_tenants" {
                references.runtime_ids.insert(event.session_id?);
            }
            if event.kind == "runtime.stopped" {
                references.runtime_ids.insert(event.run_id?);
            }
            if references.runtime_ids.is_empty()
                && !matches!(
                    event.kind.as_str(),
                    "runtime.preference_updated" | "runtime.unavailable"
                )
            {
                return None;
            }
        }
        VisibilityScope::Origin => {
            collect_keyed_uuids(
                &event.data,
                |key| key == "originid" || key == "originids",
                false,
                &mut references.origin_ids,
            )?;
            if references.origin_ids.is_empty() {
                return None;
            }
        }
        VisibilityScope::Tunnel => {
            collect_keyed_uuids(
                &event.data,
                runtime_id_key,
                false,
                &mut references.runtime_ids,
            )?;
            collect_keyed_uuids(
                &event.data,
                runtime_lease_id_key,
                false,
                &mut references.runtime_lease_ids,
            )?;
            collect_top_level_uuid(&event.data, "id", &mut references.tunnel_grant_ids)?;
            collect_top_level_strings(&event.data, "tunnelid", &mut references.tunnel_ids)?;
            if let Some(runtime_id) = event.run_id {
                references.runtime_ids.insert(runtime_id);
            }
            if let Some(runtime_lease_id) = event.job_id {
                references.runtime_lease_ids.insert(runtime_lease_id);
            }
        }
        VisibilityScope::LocalWorkspace => {
            collect_keyed_uuids(
                &event.data,
                runtime_id_key,
                false,
                &mut references.runtime_ids,
            )?;
        }
    }

    Some(references)
}

fn collect_keyed_uuids(
    value: &JsonValue,
    key_matches: impl Copy + Fn(&str) -> bool,
    recursive: bool,
    output: &mut HashSet<Uuid>,
) -> Option<bool> {
    let mut found = false;
    match value {
        JsonValue::Object(entries) => {
            for (key, value) in entries {
                let normalized = normalize_key(key);
                if key_matches(&normalized) {
                    found = true;
                    collect_uuid_values(value, output)?;
                } else if recursive {
                    found |= collect_keyed_uuids(value, key_matches, true, output)?;
                }
            }
        }
        JsonValue::Array(values) if recursive => {
            for nested in values {
                found |= collect_keyed_uuids(nested, key_matches, true, output)?;
            }
        }
        _ => {}
    }
    Some(found)
}

fn collect_top_level_uuid(
    value: &JsonValue,
    expected_key: &str,
    output: &mut HashSet<Uuid>,
) -> Option<()> {
    let JsonValue::Object(entries) = value else {
        return None;
    };
    for (key, value) in entries {
        if normalize_key(key) == expected_key {
            collect_uuid_values(value, output)?;
        }
    }
    Some(())
}

fn collect_top_level_strings(
    value: &JsonValue,
    expected_key: &str,
    output: &mut HashSet<String>,
) -> Option<()> {
    let JsonValue::Object(entries) = value else {
        return None;
    };
    for (key, value) in entries {
        if normalize_key(key) != expected_key {
            continue;
        }
        match value {
            JsonValue::Null => {}
            JsonValue::String(value) if !value.trim().is_empty() => {
                output.insert(value.trim().to_string());
            }
            JsonValue::Array(values) => {
                for value in values {
                    let value = value.as_str()?.trim();
                    if value.is_empty() {
                        return None;
                    }
                    output.insert(value.to_string());
                }
            }
            _ => return None,
        }
    }
    Some(())
}

fn collect_uuid_values(value: &JsonValue, output: &mut HashSet<Uuid>) -> Option<()> {
    match value {
        JsonValue::Null => Some(()),
        JsonValue::String(value) => {
            output.insert(Uuid::parse_str(value.trim()).ok()?);
            Some(())
        }
        JsonValue::Array(values) => {
            for value in values {
                collect_uuid_values(value, output)?;
            }
            Some(())
        }
        _ => None,
    }
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn runtime_id_key(key: &str) -> bool {
    (key.ends_with("runtimeid") || key.ends_with("runtimeids")) && !runtime_lease_id_key(key)
}

fn runtime_lease_id_key(key: &str) -> bool {
    key.ends_with("runtimeleaseid") || key.ends_with("runtimeleaseids")
}

async fn resolve_origin_runtime_ids(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: Uuid,
    origin_ids: &HashSet<Uuid>,
    runtime_ids: &mut HashSet<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let origin_ids = origin_ids.iter().copied().collect::<Vec<_>>();
    let rows = transaction
        .query(
            "select workspace_origin.id as origin_id,
                    workspace_origin.mode,
                    workspace_origin.endpoint,
                    origin_instance.runtime_id
             from workspace_origins workspace_origin
             left join origin_instances origin_instance
               on origin_instance.origin_id = workspace_origin.id
              and origin_instance.project_id = workspace_origin.project_id
             where workspace_origin.project_id = $1
               and workspace_origin.id = any($2::uuid[])",
            &[&project_id, &origin_ids],
        )
        .await
        .map_err(|error| database_unavailable("Controller event origin visibility", error))?;

    let mut resolved_origins = HashSet::new();
    let mut runtime_bound_origins = HashSet::new();
    let mut configured_hosted_origins = HashSet::new();
    for row in rows {
        let origin_id = row.get::<_, Uuid>("origin_id");
        resolved_origins.insert(origin_id);
        if let Some(runtime_id) = row.get::<_, Option<Uuid>>("runtime_id") {
            runtime_bound_origins.insert(origin_id);
            runtime_ids.insert(runtime_id);
        } else {
            let mode: String = row.get("mode");
            let endpoint: String = row.get("endpoint");
            if is_configured_hosted_gateway(
                project_id,
                origin_id,
                &mode,
                &endpoint,
                state.config.hosted_origin_endpoint.as_deref(),
            ) {
                configured_hosted_origins.insert(origin_id);
            }
        }
    }
    runtime_bound_origins.extend(configured_hosted_origins);
    if resolved_origins.len() != origin_ids.len() || runtime_bound_origins.len() != origin_ids.len()
    {
        return Err(private_event());
    }
    Ok(())
}

fn is_configured_hosted_gateway(
    project_id: Uuid,
    origin_id: Uuid,
    mode: &str,
    endpoint: &str,
    configured_endpoint: Option<&str>,
) -> bool {
    mode == "hosted"
        && origin_id == stable_hosted_origin_id(project_id)
        && configured_endpoint == Some(endpoint)
}

fn stable_hosted_origin_id(project_id: Uuid) -> Uuid {
    let name = format!("instafy:hosted-origin:{project_id}");
    Uuid::new_v5(&Uuid::NAMESPACE_URL, name.as_bytes())
}

async fn resolve_tunnel_runtime_ids(
    transaction: &Transaction<'_>,
    project_id: Uuid,
    references: &mut RuntimeReferences,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if !references.tunnel_grant_ids.is_empty() || !references.tunnel_ids.is_empty() {
        let grant_ids = references
            .tunnel_grant_ids
            .iter()
            .copied()
            .collect::<Vec<_>>();
        let tunnel_ids = references.tunnel_ids.iter().cloned().collect::<Vec<_>>();
        let rows = transaction
            .query(
                "select id, tunnel_id, runtime_id, runtime_lease_id
                 from runtime_tunnel_grants
                 where project_id = $1
                   and (id = any($2::uuid[]) or tunnel_id = any($3::text[]))",
                &[&project_id, &grant_ids, &tunnel_ids],
            )
            .await
            .map_err(|error| database_unavailable("Controller event tunnel visibility", error))?;
        let mut resolved_grant_ids = HashSet::new();
        let mut resolved_tunnel_ids = HashSet::new();
        for row in rows {
            resolved_grant_ids.insert(row.get::<_, Uuid>("id"));
            resolved_tunnel_ids.insert(row.get::<_, String>("tunnel_id"));
            if let Some(runtime_id) = row.get::<_, Option<Uuid>>("runtime_id") {
                references.runtime_ids.insert(runtime_id);
            }
            if let Some(runtime_lease_id) = row.get::<_, Option<Uuid>>("runtime_lease_id") {
                references.runtime_lease_ids.insert(runtime_lease_id);
            }
        }
        if !references
            .tunnel_grant_ids
            .iter()
            .all(|id| resolved_grant_ids.contains(id))
            || !references
                .tunnel_ids
                .iter()
                .all(|id| resolved_tunnel_ids.contains(id))
        {
            return Err(private_event());
        }
    }

    if !references.runtime_lease_ids.is_empty() {
        let runtime_lease_ids = references
            .runtime_lease_ids
            .iter()
            .copied()
            .collect::<Vec<_>>();
        let rows = transaction
            .query(
                "select id, runtime_id
                 from runtime_leases
                 where project_id = $1 and id = any($2::uuid[])",
                &[&project_id, &runtime_lease_ids],
            )
            .await
            .map_err(|error| {
                database_unavailable("Controller event tunnel lease visibility", error)
            })?;
        let mut resolved_runtime_lease_ids = HashSet::new();
        for row in rows {
            resolved_runtime_lease_ids.insert(row.get::<_, Uuid>("id"));
            let runtime_id = row
                .get::<_, Option<Uuid>>("runtime_id")
                .ok_or_else(private_event)?;
            references.runtime_ids.insert(runtime_id);
        }
        if !references
            .runtime_lease_ids
            .iter()
            .all(|id| resolved_runtime_lease_ids.contains(id))
        {
            return Err(private_event());
        }
    }

    Ok(())
}

async fn ensure_runtime_ids_visible(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: Uuid,
    runtime_ids: &HashSet<Uuid>,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if runtime_ids.is_empty() {
        return Ok(());
    }

    let runtime_ids = runtime_ids.iter().copied().collect::<Vec<_>>();
    let rows = transaction
        .query(
            "select id, provider, capabilities
             from runtimes
             where project_id = $1 and id = any($2::uuid[])",
            &[&project_id, &runtime_ids],
        )
        .await
        .map_err(|error| database_unavailable("Controller event runtime visibility", error))?;
    if rows.len() != runtime_ids.len() {
        return Err(private_event());
    }

    for row in rows {
        let provider: String = row.get("provider");
        let capabilities: JsonValue = row.get("capabilities");
        if !runtime_is_visible_to_context(state, &provider, &capabilities, context) {
            return Err(private_event());
        }
    }
    Ok(())
}

fn runtime_is_visible_to_context(
    state: &AppState,
    provider: &str,
    capabilities: &JsonValue,
    context: &RequestContext,
) -> bool {
    let is_self_hosted =
        crate::runtime::runtime_is_private_self_hosted(state, provider, capabilities);
    !is_self_hosted
        || context.user_id.is_some_and(|user_id| {
            crate::runtime::self_hosted_owner_user_id(capabilities) == Some(user_id)
        })
}

fn private_event() -> (StatusCode, Json<ApiError>) {
    forbidden("controller event is private to another runtime owner")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;

    fn event(kind: &str, data: JsonValue) -> ControllerEvent {
        ControllerEvent {
            kind: kind.to_string(),
            project_id: Some(Uuid::new_v4()),
            session_id: None,
            conversation_id: None,
            run_id: None,
            job_id: None,
            channel: None,
            channels: Vec::new(),
            target_user_id: None,
            data,
            timestamp: Utc::now(),
        }
    }

    #[test]
    fn runtime_events_collect_nested_and_plural_runtime_ids() {
        let preferred = Uuid::new_v4();
        let requested = Uuid::new_v4();
        let reconnect = Uuid::new_v4();
        let lease = Uuid::new_v4();
        let event = event(
            "runtime.dev_isolation",
            json!({
                "preferredRuntimeId": preferred,
                "runtimeIds": [requested],
                "reconnect": { "runtime_id": reconnect },
                "runtimeLeaseId": lease,
            }),
        );

        let references = event_references(&event, VisibilityScope::Runtime).expect("valid refs");
        assert_eq!(
            references.runtime_ids,
            HashSet::from([preferred, requested, reconnect])
        );
        assert!(references.runtime_lease_ids.is_empty());
    }

    #[test]
    fn malformed_runtime_reference_fails_closed() {
        let event = event(
            "runtime.preference_updated",
            json!({ "runtimeId": "not-a-uuid" }),
        );
        assert!(event_references(&event, VisibilityScope::Runtime).is_none());
    }

    #[test]
    fn non_runtime_event_kind_still_collects_runtime_reference() {
        let runtime_id = Uuid::new_v4();
        let event = event(
            "telemetry.system_issue.created",
            json!({
                "details": {
                    "runtimeId": runtime_id,
                }
            }),
        );
        let mut runtime_ids = HashSet::new();
        assert_eq!(
            collect_keyed_uuids(&event.data, runtime_id_key, true, &mut runtime_ids),
            Some(true)
        );
        assert_eq!(runtime_ids, HashSet::from([runtime_id]));
        assert_eq!(visibility_scope(&event.kind), None);
    }

    #[test]
    fn unbound_runtime_lifecycle_fails_closed_except_project_level_states() {
        let strict_mode = event(
            "runtime.strict_mode",
            json!({ "action": "missing_runtime_scope" }),
        );
        assert!(event_references(&strict_mode, VisibilityScope::Runtime).is_none());

        let cleared_preference = event(
            "runtime.preference_updated",
            json!({ "runtimeId": JsonValue::Null }),
        );
        assert!(event_references(&cleared_preference, VisibilityScope::Runtime).is_some());
        let unavailable = event(
            "runtime.unavailable",
            json!({ "reason": "runtime_unavailable" }),
        );
        assert!(event_references(&unavailable, VisibilityScope::Runtime).is_some());
    }

    #[test]
    fn origin_and_tunnel_bindings_are_required() {
        let missing_origin = event("origin.heartbeat", json!({ "status": "online" }));
        assert!(event_references(&missing_origin, VisibilityScope::Origin).is_none());

        let tunnel = event(
            "tunnel.status_updated",
            json!({ "runtimeLeaseId": Uuid::new_v4(), "tunnelId": "tun-1" }),
        );
        let references = event_references(&tunnel, VisibilityScope::Tunnel).expect("valid refs");
        assert_eq!(references.runtime_lease_ids.len(), 1);
        assert_eq!(references.tunnel_ids, HashSet::from(["tun-1".to_string()]));
    }

    #[test]
    fn only_exact_configured_stable_hosted_origin_can_be_unbound() {
        let project_id = Uuid::new_v4();
        let origin_id = stable_hosted_origin_id(project_id);
        let endpoint = "https://origin.instafy.test";

        assert!(is_configured_hosted_gateway(
            project_id,
            origin_id,
            "hosted",
            endpoint,
            Some(endpoint),
        ));
        assert!(!is_configured_hosted_gateway(
            project_id,
            Uuid::new_v4(),
            "hosted",
            endpoint,
            Some(endpoint),
        ));
        assert!(!is_configured_hosted_gateway(
            project_id,
            origin_id,
            "desktop",
            endpoint,
            Some(endpoint),
        ));
        assert!(!is_configured_hosted_gateway(
            project_id,
            origin_id,
            "hosted",
            "https://attacker.invalid",
            Some(endpoint),
        ));
        assert!(!is_configured_hosted_gateway(
            project_id, origin_id, "hosted", endpoint, None,
        ));
    }

    #[test]
    fn local_workspace_events_require_a_human_target() {
        let mut event = event(
            "local_workspace.registered",
            json!({ "runtimeId": Uuid::new_v4() }),
        );
        let user_id = Uuid::new_v4();
        let context = RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: None,
        };
        assert!(!event
            .target_user_id
            .is_some_and(|target| context.user_id == Some(target)));
        event.target_user_id = Some(user_id);
        assert!(event
            .target_user_id
            .is_some_and(|target| context.user_id == Some(target)));
    }
}
