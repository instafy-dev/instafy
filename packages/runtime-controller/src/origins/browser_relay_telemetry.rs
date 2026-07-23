use std::time::{Duration, Instant};

use tracing::info;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BrowserRelayTransport {
    Rfb,
    CdpScreencast,
    CdpInput,
    Collaboration,
}

impl BrowserRelayTransport {
    fn as_str(self) -> &'static str {
        match self {
            Self::Rfb => "rfb",
            Self::CdpScreencast => "cdp-screencast",
            Self::CdpInput => "cdp-input",
            Self::Collaboration => "collaboration",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BrowserRelayDirection {
    ClientToOrigin,
    OriginToClient,
}

impl BrowserRelayDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::ClientToOrigin => "client_to_origin",
            Self::OriginToClient => "origin_to_client",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BrowserRelayOutcome {
    RequestBuildError,
    OriginConnectError,
    ClientEof,
    OriginSendError,
    ClientClosed,
    ClientReceiveError,
    OriginEof,
    ClientSendError,
    OriginClosed,
    OriginReceiveError,
}

impl BrowserRelayOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::RequestBuildError => "request_build_error",
            Self::OriginConnectError => "origin_connect_error",
            Self::ClientEof => "client_eof",
            Self::OriginSendError => "origin_send_error",
            Self::ClientClosed => "client_closed",
            Self::ClientReceiveError => "client_receive_error",
            Self::OriginEof => "origin_eof",
            Self::ClientSendError => "client_send_error",
            Self::OriginClosed => "origin_closed",
            Self::OriginReceiveError => "origin_receive_error",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct BrowserRelayContext {
    relay_id: String,
    transport: BrowserRelayTransport,
    project_id: String,
    origin_id: String,
    runtime_id: Option<String>,
    page_id: Option<String>,
    lease_id: Option<String>,
    run_id: Option<String>,
}

impl BrowserRelayContext {
    pub(super) fn new(
        transport: BrowserRelayTransport,
        project_id: String,
        origin_id: String,
        runtime_id: Option<String>,
        page_id: Option<String>,
        lease_id: Option<String>,
        run_id: Option<String>,
    ) -> Self {
        Self {
            relay_id: Uuid::new_v4().to_string(),
            transport,
            project_id,
            origin_id,
            runtime_id,
            page_id,
            lease_id,
            run_id,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct BrowserRelayDirectionStats {
    messages: u64,
    bytes: u64,
}

impl BrowserRelayDirectionStats {
    fn observe(&mut self, bytes: usize) {
        self.messages = self.messages.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes as u64);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BrowserRelayCloseRecord {
    relay_id: String,
    transport: &'static str,
    direction: &'static str,
    messages: u64,
    bytes: u64,
    duration_ms: u64,
    outcome: &'static str,
    project_id: String,
    origin_id: String,
    runtime_id: Option<String>,
    page_id: Option<String>,
    lease_id: Option<String>,
    run_id: Option<String>,
}

fn browser_relay_close_records(
    context: &BrowserRelayContext,
    client_to_origin: BrowserRelayDirectionStats,
    origin_to_client: BrowserRelayDirectionStats,
    duration: Duration,
    outcome: BrowserRelayOutcome,
) -> [BrowserRelayCloseRecord; 2] {
    [
        (BrowserRelayDirection::ClientToOrigin, client_to_origin),
        (BrowserRelayDirection::OriginToClient, origin_to_client),
    ]
    .map(|(direction, stats)| BrowserRelayCloseRecord {
        relay_id: context.relay_id.clone(),
        transport: context.transport.as_str(),
        direction: direction.as_str(),
        messages: stats.messages,
        bytes: stats.bytes,
        duration_ms: duration.as_millis().try_into().unwrap_or(u64::MAX),
        outcome: outcome.as_str(),
        project_id: context.project_id.clone(),
        origin_id: context.origin_id.clone(),
        runtime_id: context.runtime_id.clone(),
        page_id: context.page_id.clone(),
        lease_id: context.lease_id.clone(),
        run_id: context.run_id.clone(),
    })
}

#[derive(Debug)]
pub(super) struct BrowserRelayTelemetry {
    context: BrowserRelayContext,
    started_at: Instant,
    client_to_origin: BrowserRelayDirectionStats,
    origin_to_client: BrowserRelayDirectionStats,
}

impl BrowserRelayTelemetry {
    pub(super) fn new(context: BrowserRelayContext) -> Self {
        Self {
            context,
            started_at: Instant::now(),
            client_to_origin: BrowserRelayDirectionStats::default(),
            origin_to_client: BrowserRelayDirectionStats::default(),
        }
    }

    pub(super) fn observe(&mut self, direction: BrowserRelayDirection, bytes: usize) {
        match direction {
            BrowserRelayDirection::ClientToOrigin => self.client_to_origin.observe(bytes),
            BrowserRelayDirection::OriginToClient => self.origin_to_client.observe(bytes),
        }
    }

    pub(super) fn close(self, outcome: BrowserRelayOutcome) {
        for record in browser_relay_close_records(
            &self.context,
            self.client_to_origin,
            self.origin_to_client,
            self.started_at.elapsed(),
            outcome,
        ) {
            info!(
                relay_id = record.relay_id.as_str(),
                transport = record.transport,
                direction = record.direction,
                messages = record.messages,
                bytes = record.bytes,
                duration_ms = record.duration_ms,
                outcome = record.outcome,
                project_id = record.project_id.as_str(),
                origin_id = record.origin_id.as_str(),
                runtime_id = record.runtime_id.as_deref().unwrap_or(""),
                page_id = record.page_id.as_deref().unwrap_or(""),
                lease_id = record.lease_id.as_deref().unwrap_or(""),
                run_id = record.run_id.as_deref().unwrap_or(""),
                "shared browser relay closed"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_records_keep_counts_directional_and_ids_as_fields() {
        let context = BrowserRelayContext {
            relay_id: "relay-1".to_string(),
            transport: BrowserRelayTransport::CdpScreencast,
            project_id: "project-1".to_string(),
            origin_id: "origin-1".to_string(),
            runtime_id: Some("runtime-1".to_string()),
            page_id: Some("page-1".to_string()),
            lease_id: Some("lease-1".to_string()),
            run_id: Some("run-1".to_string()),
        };
        let client_to_origin = BrowserRelayDirectionStats {
            messages: 2,
            bytes: 22,
        };
        let origin_to_client = BrowserRelayDirectionStats {
            messages: 1,
            bytes: 1_024,
        };

        let records = browser_relay_close_records(
            &context,
            client_to_origin,
            origin_to_client,
            Duration::from_millis(250),
            BrowserRelayOutcome::ClientClosed,
        );

        assert_eq!(records[0].relay_id, "relay-1");
        assert_eq!(records[0].transport, "cdp-screencast");
        assert_eq!(records[0].direction, "client_to_origin");
        assert_eq!(records[0].messages, 2);
        assert_eq!(records[0].bytes, 22);
        assert_eq!(records[0].duration_ms, 250);
        assert_eq!(records[0].outcome, "client_closed");
        assert_eq!(records[0].project_id, "project-1");
        assert_eq!(records[0].origin_id, "origin-1");
        assert_eq!(records[0].runtime_id.as_deref(), Some("runtime-1"));
        assert_eq!(records[0].page_id.as_deref(), Some("page-1"));
        assert_eq!(records[0].lease_id.as_deref(), Some("lease-1"));
        assert_eq!(records[0].run_id.as_deref(), Some("run-1"));

        assert_eq!(records[1].relay_id, "relay-1");
        assert_eq!(records[1].transport, "cdp-screencast");
        assert_eq!(records[1].direction, "origin_to_client");
        assert_eq!(records[1].messages, 1);
        assert_eq!(records[1].bytes, 1_024);
        assert_eq!(records[1].duration_ms, 250);
        assert_eq!(records[1].outcome, "client_closed");
    }

    #[test]
    fn direction_stats_count_messages_and_bytes() {
        let context = BrowserRelayContext {
            relay_id: "relay-2".to_string(),
            transport: BrowserRelayTransport::Rfb,
            project_id: "project-2".to_string(),
            origin_id: "origin-2".to_string(),
            runtime_id: None,
            page_id: None,
            lease_id: None,
            run_id: None,
        };
        let mut telemetry = BrowserRelayTelemetry::new(context);
        telemetry.observe(BrowserRelayDirection::ClientToOrigin, 17);
        telemetry.observe(BrowserRelayDirection::ClientToOrigin, 5);
        telemetry.observe(BrowserRelayDirection::OriginToClient, 1_024);

        assert_eq!(telemetry.client_to_origin.messages, 2);
        assert_eq!(telemetry.client_to_origin.bytes, 22);
        assert_eq!(telemetry.origin_to_client.messages, 1);
        assert_eq!(telemetry.origin_to_client.bytes, 1_024);
    }
}
