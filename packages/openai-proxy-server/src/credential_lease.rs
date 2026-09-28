use std::time::Instant;

use anyhow::{Result, anyhow};

use crate::auth::Credentials;

/// Request-ready credentials plus the model policy the controller attached to
/// them.
///
/// Like [`CredentialLease`], this deliberately does not implement `Debug`.
#[derive(Clone)]
pub struct LeasedCredentials {
    pub credentials: Credentials,
    /// The only model the controller lets these credentials serve (the
    /// managed lane, where the operator pays). `None` keeps the requested
    /// model, as for user credentials, static proxy credentials and leases
    /// from a controller that predates the pin.
    pub pinned_model: Option<String>,
}

impl LeasedCredentials {
    /// Credentials the controller attached no model policy to.
    pub fn unpinned(credentials: Credentials) -> Self {
        Self {
            credentials,
            pinned_model: None,
        }
    }

    pub fn pinned_model(&self) -> Option<&str> {
        self.pinned_model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

/// Why the proxy is asking the controller for request-ready credential material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialLeasePurpose {
    InitialRequest,
    AfterUpstreamRejection,
}

/// Short-lived access to request-ready credential material.
///
/// This type intentionally does not implement `Debug`: doing so would make it
/// too easy for secret material to reach diagnostics.
pub struct CredentialLease<T> {
    material: T,
    expires_at: Instant,
}

impl<T> CredentialLease<T> {
    pub fn new(material: T, expires_at: Instant) -> Self {
        Self {
            material,
            expires_at,
        }
    }

    pub fn into_material(self) -> Result<T> {
        if Instant::now() >= self.expires_at {
            return Err(anyhow!("credential lease expired before use"));
        }
        Ok(self.material)
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::CredentialLease;

    #[test]
    fn expired_lease_refuses_to_release_material() {
        let lease = CredentialLease::new(
            "credential-material",
            Instant::now() - Duration::from_secs(1),
        );

        assert!(lease.into_material().is_err());
    }
}
