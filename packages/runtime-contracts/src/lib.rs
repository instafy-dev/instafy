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
/// controller-to-service capability. Git Edge and Git Shard accept it only for
/// the two requests of a push, and that push may only create refs under
/// `refs/instafy/salvage/gateway/`. It can never update or delete a ref, fetch
/// an object, or write like `git.write`.
pub const GIT_SALVAGE_SCOPE: &str = "git.salvage";
pub const GIT_SALVAGE_TOKEN_SUBJECT: &str = "instafy-controller-salvage";
pub const GIT_SALVAGE_TOKEN_TTL_SECONDS: i64 = 120;
