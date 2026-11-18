//! The tunnel broker, compiled once for all four binaries: the `tunnel-broker` API, the
//! `ingress_sidecar` and `dns_sidecar` sidecars and the `render_rathole` renderer.
//!
//! Every module is private and the crate root re-exports only what the binaries import, so the
//! dead-code lint (denied in CI) still flags what nothing uses. A name re-exported here always
//! counts as used, so drop it once no binary imports it. So does a `pub` field or method of a type
//! the binaries can reach, exported or named in an exported signature, so the members no binary
//! uses are `pub(crate)`.

mod auth;
mod config;
mod db;
mod error;
mod hooks;
mod ingress;
mod listening;
mod routes;
mod state;
mod tokens;

pub use config::BrokerConfig;
pub use db::{
    connect_pool, ensure_dns_node, ensure_ingress, ensure_pdns_domain,
    list_active_rathole_bindings_for_ingress, revoke_expired_tunnels_for_ingress, run_migrations,
};
pub use hooks::{emit_event, EventPayload};
pub use ingress::{render_rathole_server_config, render_traefik_dynamic_config};
pub use listening::probe_and_record;
pub use routes::router;
pub use state::AppState;
