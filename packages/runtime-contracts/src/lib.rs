pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/instafy.runtime.rs"));
}

pub use proto::*;
pub mod types;
pub use types::{AccessTokenClaims, CreditSnapshotPayload, ProxyEnvelopePayload};
