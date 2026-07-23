use chrono::{DateTime, Utc};
use prost_types::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::{CreditSnapshot, ProxyEnvelope};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    pub aud: String,
    pub sub: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    /// Stable controller-owned runtime generation for self-hosted runtimes.
    /// Unlike `jti`, this value is preserved across ordinary token renewals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefer_runtime: Option<String>,
    /// Controller-attested display label for short-lived collaborative UI.
    /// This is presentation metadata only; authorization remains bound to
    /// `sub`, scopes, project, runtime, and the browser client session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_label: Option<String>,
    /// Per-tab/device browser client identity, supplied while minting the
    /// token and then signed by the controller. Shared Browser control leases
    /// bind to `(sub, browser_session_id)` so two devices for one account do
    /// not silently share input authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyEnvelopePayload {
    pub url: String,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl ProxyEnvelopePayload {
    pub fn from_proto(proto: &ProxyEnvelope) -> Self {
        let expires_at = proto
            .expires_at
            .as_ref()
            .and_then(timestamp_to_datetime)
            .map(|dt| dt.to_rfc3339());

        Self {
            url: proto.url.clone(),
            token: proto.token.clone(),
            expires_at,
        }
    }

    pub fn into_proto(self) -> ProxyEnvelope {
        ProxyEnvelope {
            url: self.url,
            token: self.token,
            expires_at: self
                .expires_at
                .and_then(|value| datetime_to_timestamp(&value)),
        }
    }

    pub fn from_parts(url: String, token: String, expires_at: DateTime<Utc>) -> Self {
        Self {
            url,
            token,
            expires_at: Some(expires_at.to_rfc3339()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreditSnapshotPayload {
    pub balance: i32,
    pub credit_limit: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_burn_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refill_at: Option<String>,
}

impl CreditSnapshotPayload {
    pub fn from_proto(proto: &CreditSnapshot) -> Self {
        Self {
            balance: proto.balance,
            credit_limit: proto.credit_limit,
            last_burn_at: proto
                .last_burn_at
                .as_ref()
                .and_then(timestamp_to_datetime)
                .map(|dt| dt.to_rfc3339()),
            last_refill_at: proto
                .last_refill_at
                .as_ref()
                .and_then(timestamp_to_datetime)
                .map(|dt| dt.to_rfc3339()),
        }
    }

    pub fn into_proto(self) -> CreditSnapshot {
        CreditSnapshot {
            balance: self.balance,
            credit_limit: self.credit_limit,
            last_burn_at: self
                .last_burn_at
                .and_then(|value| datetime_to_timestamp(&value)),
            last_refill_at: self
                .last_refill_at
                .and_then(|value| datetime_to_timestamp(&value)),
        }
    }

    pub fn to_json(&self) -> JsonValue {
        let mut map = JsonMap::new();
        map.insert("balance".to_string(), JsonValue::from(self.balance));
        map.insert(
            "creditLimit".to_string(),
            JsonValue::from(self.credit_limit),
        );
        if let Some(ref value) = self.last_burn_at {
            map.insert("lastBurnAt".to_string(), JsonValue::from(value.clone()));
        }
        if let Some(ref value) = self.last_refill_at {
            map.insert("lastRefillAt".to_string(), JsonValue::from(value.clone()));
        }
        JsonValue::Object(map)
    }

    pub fn from_json(value: &JsonValue) -> Option<Self> {
        let balance = value.get("balance").and_then(number_to_i32).unwrap_or(0);
        let credit_limit = value
            .get("creditLimit")
            .and_then(number_to_i32)
            .unwrap_or(0);

        Some(Self {
            balance,
            credit_limit,
            last_burn_at: value
                .get("lastBurnAt")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            last_refill_at: value
                .get("lastRefillAt")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
        })
    }
}

fn timestamp_to_datetime(timestamp: &Timestamp) -> Option<DateTime<Utc>> {
    let seconds = timestamp.seconds;
    let nanos = timestamp.nanos;
    DateTime::<Utc>::from_timestamp(seconds, nanos as u32)
}

fn datetime_to_timestamp(input: &str) -> Option<Timestamp> {
    let parsed = chrono::DateTime::parse_from_rfc3339(input).ok()?;
    let utc = parsed.with_timezone(&Utc);
    Some(Timestamp {
        seconds: utc.timestamp(),
        nanos: utc.timestamp_subsec_nanos() as i32,
    })
}

fn number_to_i32(value: &JsonValue) -> Option<i32> {
    if let Some(as_i64) = value.as_i64() {
        i32::try_from(as_i64).ok()
    } else if let Some(as_f64) = value.as_f64() {
        i32::try_from(as_f64.round() as i64).ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_payload_roundtrip_proto() {
        let timestamp = Timestamp {
            seconds: 1_700_000_000,
            nanos: 0,
        };
        let proto = ProxyEnvelope {
            url: "https://proxy.example.com".to_string(),
            token: "token".to_string(),
            expires_at: Some(timestamp.clone()),
        };

        let payload = ProxyEnvelopePayload::from_proto(&proto);
        assert_eq!(payload.url, proto.url);
        assert_eq!(payload.token, proto.token);
        assert_eq!(
            payload.expires_at,
            Some("2023-11-14T22:13:20+00:00".to_string())
        );

        let restored = payload.into_proto();
        assert_eq!(restored.url, proto.url);
        assert_eq!(restored.token, proto.token);
        assert_eq!(restored.expires_at, Some(timestamp));
    }

    #[test]
    fn credit_snapshot_json_roundtrip() {
        let payload = CreditSnapshotPayload {
            balance: 10,
            credit_limit: 50,
            last_burn_at: Some("2025-01-01T00:00:00Z".to_string()),
            last_refill_at: None,
        };
        let json = payload.to_json();
        let restored = CreditSnapshotPayload::from_json(&json).expect("restore payload");
        assert_eq!(restored.balance, 10);
        assert_eq!(restored.credit_limit, 50);
        assert_eq!(
            restored.last_burn_at,
            Some("2025-01-01T00:00:00Z".to_string())
        );
        assert_eq!(restored.last_refill_at, None);
    }
}
