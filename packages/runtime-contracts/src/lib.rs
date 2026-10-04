pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/instafy.runtime.rs"));
}

pub use proto::*;
pub mod types;
pub use types::{AccessTokenClaims, CreditSnapshotPayload, ProxyEnvelopePayload};

/// Destructive Git cleanup is a deliberately exact controller-to-service
/// capability shared by the token minter, edge, and shard.
pub const GIT_DELETE_SCOPE: &str = "git.delete";
pub const GIT_DELETE_TOKEN_SUBJECT: &str = "instafy-controller";
pub const GIT_DELETE_TOKEN_TTL_SECONDS: i64 = 60;

/// Writing work salvaged from retired workspace copies is another exact
/// controller-to-service capability. A push carrying it may only create refs
/// under `refs/instafy/salvage/gateway/`; it can never update or delete a ref,
/// and it grants no read or ordinary write access.
pub const GIT_SALVAGE_SCOPE: &str = "git.salvage";
pub const GIT_SALVAGE_TOKEN_SUBJECT: &str = "instafy-controller-salvage";
pub const GIT_SALVAGE_TOKEN_TTL_SECONDS: i64 = 120;
