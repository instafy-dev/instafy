pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/instafy.runtime.rs"));
}

pub use proto::*;
pub mod agent_face;
pub mod chat_activity;
pub mod claude_code_lane;
pub mod multi_agent;
pub mod own_ai_model;
pub mod proxy_route;
pub mod research;
pub mod types;
pub use types::{AccessTokenClaims, ProxyEnvelopePayload};

/// Destructive Git cleanup is a deliberately exact controller-to-service
/// capability shared by the token minter, edge, and shard.
pub const GIT_DELETE_SCOPE: &str = "git.delete";
pub const GIT_DELETE_TOKEN_SUBJECT: &str = "instafy-controller";
pub const GIT_DELETE_TOKEN_TTL_SECONDS: i64 = 60;

/// The newest Claude Code version that local-engine turns are verified on
/// (docs/Local-Engine-Turns.md, 2.10 and 8). runtime-agent attests a runtime's
/// `claudeCode.verified` as whether its probed `claude` version is at most this one,
/// and Studio reads that flag instead of keeping a copy. It is the version floor,
/// 2.1.325, the version Phase 0's checks ran on (B.4); a reviewed change raises it
/// after the live suite passes on a newer one.
pub const CLAUDE_CODE_LANE_VERIFIED_THROUGH: &str = "2.1.325";
