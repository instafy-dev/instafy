//! git-edge and git-shard (the `server` feature, on by default), and the
//! repository push policy they share with origin-http-server (`policy`,
//! always built).

#[cfg(feature = "server")]
pub mod auth;
#[cfg(feature = "server")]
pub mod config;
#[cfg(feature = "server")]
pub mod error;
#[cfg(feature = "server")]
pub mod events;
#[cfg(feature = "server")]
pub mod git_http_backend;
#[cfg(feature = "server")]
pub mod jwks;
pub mod policy;
#[cfg(feature = "server")]
pub mod repo;
#[cfg(feature = "server")]
pub mod routing;
