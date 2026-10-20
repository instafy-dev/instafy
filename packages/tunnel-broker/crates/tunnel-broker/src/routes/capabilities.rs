use axum::{extract::State, Json};
use tunnel_broker_types::BrokerCapabilities;

use crate::{config::BrokerConfig, state::AppState};

/// `GET /capabilities`: what this broker is configured to serve. Callers check it before they
/// ask for a feature that is off by default, instead of finding out from a refused request.
pub async fn capabilities(State(state): State<AppState>) -> Json<BrokerCapabilities> {
    Json(capabilities_for(state.config()))
}

fn capabilities_for(cfg: &BrokerConfig) -> BrokerCapabilities {
    // The same condition `POST /tunnels` uses to accept a private tunnel, so the answer never
    // promises something the broker would refuse.
    let preview_domain = cfg
        .preview
        .as_ref()
        .filter(|_| cfg.private_previews_enabled())
        .map(|preview| preview.domain.clone());
    BrokerCapabilities {
        private_previews: preview_domain.is_some(),
        preview_domain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_broker_config;

    #[tokio::test]
    async fn reports_private_previews_with_their_domain_when_configured() {
        let state = AppState::for_tests(test_broker_config());
        let Json(body) = capabilities(State(state)).await;
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            serde_json::json!({"privatePreviews": true, "previewDomain": "preview.localhost"})
        );
    }

    #[test]
    fn reports_private_previews_off_without_full_config() {
        for strip in [
            |cfg: &mut BrokerConfig| cfg.preview = None,
            |cfg: &mut BrokerConfig| cfg.preview_auth_hook = None,
            |cfg: &mut BrokerConfig| {
                cfg.preview = None;
                cfg.preview_auth_hook = None;
            },
        ] {
            let mut cfg = test_broker_config();
            strip(&mut cfg);
            assert_eq!(
                serde_json::to_value(capabilities_for(&cfg)).unwrap(),
                serde_json::json!({"privatePreviews": false})
            );
        }
    }
}
