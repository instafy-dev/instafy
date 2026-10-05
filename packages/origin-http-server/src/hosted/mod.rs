//! The hosted workspace gateway (`ORIGIN_MULTI_TENANT=1`): one process that
//! serves every cloud space straight from its canonical repository.
//!
//! It keeps no working copy. Reads come from git objects in a disposable
//! per-space bare mirror under `<root>/.git-cache`, writes become commits
//! pushed to canonical `main`, and nothing in the cache is ever the only
//! copy of anything. The single-tenant origin (hosted runtimes, Desktop)
//! lives in [`crate::routes`] and is unchanged by this module.

mod answers;
mod cache;
mod cas;
mod change;
pub mod config;
mod disk;
mod legacy;
mod read;
mod routes;
#[cfg(test)]
mod tests;
mod write;
#[cfg(test)]
mod write_tests;

pub(crate) use cache::MirrorCache;
pub use config::HostedGatewayConfig;
pub(crate) use legacy::park_legacy_checkouts;
pub(crate) use routes::{router, HostedState};
