//! The one place the controller seals and opens stored secrets.
//!
//! `user_credentials`, `project_secrets`, `user_oauth_tokens`,
//! `project_browser_profiles` and `github_device_auth_sessions` all store an
//! AES-256-GCM ciphertext next to its random 96-bit nonce, both base64, with no
//! associated data. A key ring holds the primary key, which seals every new
//! value and opens rows first, plus decrypt-only previous keys that keep rows
//! written before a rotation readable until `credential_rotation` rewrites
//! them. GCM authenticates every open, so a key that did not seal a row fails
//! instead of returning garbage.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::config::CredentialEncryptionKey;

/// Upper bound on decrypt-only keys. Every open that misses the primary tries
/// each of them in turn, and a rotation should retire a key, not collect them.
pub const MAX_PREVIOUS_CREDENTIAL_KEYS: usize = 8;

/// The [`credential_key_id`] of the key earlier releases derived from the
/// development `USER_TOKEN_SECRET` published in this repository.
///
/// This is a one-way digest, not key material. The controller does not know
/// that key and never decrypts with it unless an operator configures it; the
/// id only lets startup and the credential census recognise it when it is
/// configured, as the primary key or in `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`.
/// It was computed offline:
///
/// ```sh
/// printf '%s' 'instafy:credential-encryption-key:v1:dev-user-token-secret' \
///   | openssl dgst -sha256 -binary \
///   | { printf '%s' 'instafy:credential-encryption-key-id:v1:'; cat; } \
///   | openssl dgst -sha256 | awk '{ print substr($NF, 1, 12) }'
/// ```
pub const PUBLISHED_DEVELOPMENT_KEY_ID: &str = "f986c240abce";

const NONCE_BYTES: usize = 12;

#[derive(Clone)]
pub struct CredentialKeyRing {
    primary: CredentialEncryptionKey,
    previous: Vec<CredentialEncryptionKey>,
}

/// Which configured key opened a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialKeySlot {
    Primary,
    /// Index into the decrypt-only keys, in configuration order.
    Previous(usize),
}

impl CredentialKeyRing {
    /// A ring that encrypts with `primary` and also opens rows sealed with
    /// any of `previous`. Refuses duplicates, a previous key equal to the
    /// primary and more than [`MAX_PREVIOUS_CREDENTIAL_KEYS`]: each is a
    /// misconfigured rotation, for example a primary that was never replaced.
    pub fn new(
        primary: CredentialEncryptionKey,
        previous: Vec<CredentialEncryptionKey>,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            previous.len() <= MAX_PREVIOUS_CREDENTIAL_KEYS,
            "at most {MAX_PREVIOUS_CREDENTIAL_KEYS} previous credential encryption keys are \
             supported; re-encrypt and remove retired keys first"
        );
        for (index, key) in previous.iter().enumerate() {
            anyhow::ensure!(
                key.as_bytes() != primary.as_bytes(),
                "previous credential encryption key {} is the primary key; set \
                 CREDENTIAL_ENCRYPTION_KEY to a newly generated key before listing the old one \
                 as a previous key",
                index + 1
            );
            if let Some(earlier) = previous[..index]
                .iter()
                .position(|other| other.as_bytes() == key.as_bytes())
            {
                anyhow::bail!(
                    "previous credential encryption keys {} and {} are the same key",
                    earlier + 1,
                    index + 1
                );
            }
        }
        Ok(Self { primary, previous })
    }

    pub fn primary(&self) -> &CredentialEncryptionKey {
        &self.primary
    }

    pub fn previous(&self) -> &[CredentialEncryptionKey] {
        &self.previous
    }

    /// The configured key whose [`credential_key_id`] is `key_id`, if any.
    pub fn slot_of_key_id(&self, key_id: &str) -> Option<CredentialKeySlot> {
        if credential_key_id(&self.primary) == key_id {
            return Some(CredentialKeySlot::Primary);
        }
        self.previous
            .iter()
            .position(|key| credential_key_id(key) == key_id)
            .map(CredentialKeySlot::Previous)
    }

    /// Where the key derived from the published development secret sits in
    /// this ring, if it is configured at all.
    pub fn published_development_key_slot(&self) -> Option<CredentialKeySlot> {
        self.slot_of_key_id(PUBLISHED_DEVELOPMENT_KEY_ID)
    }

    /// Encrypt under the primary key. Returns `(nonce_b64, ciphertext_b64)`.
    pub fn seal(&self, plaintext: &[u8]) -> anyhow::Result<(String, String)> {
        seal_with(&self.primary, plaintext)
    }

    /// Decrypt a stored value with whichever configured key sealed it.
    pub fn open(&self, nonce_b64: &str, ciphertext_b64: &str) -> anyhow::Result<Vec<u8>> {
        self.open_with_slot(nonce_b64, ciphertext_b64)
            .map(|(plaintext, _)| plaintext)
    }

    /// Decrypt, trying the primary key first, and report which key opened it.
    pub fn open_with_slot(
        &self,
        nonce_b64: &str,
        ciphertext_b64: &str,
    ) -> anyhow::Result<(Vec<u8>, CredentialKeySlot)> {
        let (nonce, ciphertext) = decode_sealed(nonce_b64, ciphertext_b64)?;
        if let Some(plaintext) = open_with(&self.primary, &nonce, &ciphertext) {
            return Ok((plaintext, CredentialKeySlot::Primary));
        }
        for (index, key) in self.previous.iter().enumerate() {
            if let Some(plaintext) = open_with(key, &nonce, &ciphertext) {
                return Ok((plaintext, CredentialKeySlot::Previous(index)));
            }
        }
        anyhow::bail!("stored ciphertext does not authenticate under any configured credential key")
    }
}

impl From<CredentialEncryptionKey> for CredentialKeyRing {
    fn from(primary: CredentialEncryptionKey) -> Self {
        Self {
            primary,
            previous: Vec::new(),
        }
    }
}

impl std::fmt::Debug for CredentialKeyRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialKeyRing")
            .field("primary", &"<redacted>")
            .field("previous_keys", &self.previous.len())
            .finish()
    }
}

/// A short, one-way identifier for a key, so operators can tell configured
/// keys apart in census output without the key itself appearing anywhere.
/// Domain-separated SHA-256, truncated to 48 bits: it confirms a guess only for
/// a key that is already guessable, and these are 256-bit random keys.
pub fn credential_key_id(key: &CredentialEncryptionKey) -> String {
    let digest = Sha256::new()
        .chain_update(b"instafy:credential-encryption-key-id:v1:")
        .chain_update(key.as_bytes())
        .finalize();
    hex::encode(&digest[..6])
}

fn seal_with(key: &CredentialEncryptionKey, plaintext: &[u8]) -> anyhow::Result<(String, String)> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|_| anyhow::anyhow!("failed to encrypt stored secret"))?;
    Ok((BASE64.encode(nonce), BASE64.encode(ciphertext)))
}

fn decode_sealed(
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> anyhow::Result<([u8; NONCE_BYTES], Vec<u8>)> {
    let nonce: [u8; NONCE_BYTES] = BASE64
        .decode(nonce_b64.trim().as_bytes())
        .map_err(|_| anyhow::anyhow!("stored nonce is not valid base64"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid nonce length"))?;
    let ciphertext = BASE64
        .decode(ciphertext_b64.trim().as_bytes())
        .map_err(|_| anyhow::anyhow!("stored ciphertext is not valid base64"))?;
    Ok((nonce, ciphertext))
}

fn open_with(
    key: &CredentialEncryptionKey,
    nonce: &[u8; NONCE_BYTES],
    ciphertext: &[u8],
) -> Option<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes()).ok()?;
    cipher.decrypt(&Nonce::from(*nonce), ciphertext).ok()
}

#[cfg(test)]
mod tests {
    use super::{
        credential_key_id, CredentialKeyRing, CredentialKeySlot, PUBLISHED_DEVELOPMENT_KEY_ID,
    };
    use crate::config::CredentialEncryptionKey;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    fn key(seed: &str) -> CredentialEncryptionKey {
        CredentialEncryptionKey::for_test(seed)
    }

    #[test]
    fn seals_under_the_primary_and_opens_rows_from_every_configured_key() {
        let old = CredentialKeyRing::from(key("old"));
        let older = CredentialKeyRing::from(key("older"));
        let ring = CredentialKeyRing::new(key("new"), vec![key("old"), key("older")])
            .expect("distinct keys");

        let (nonce, ciphertext) = ring.seal(b"fresh").expect("seal");
        assert_eq!(
            ring.open_with_slot(&nonce, &ciphertext).expect("open"),
            (b"fresh".to_vec(), CredentialKeySlot::Primary)
        );
        // New values are never sealed under a previous key.
        assert!(old.open(&nonce, &ciphertext).is_err());

        let (nonce, ciphertext) = old.seal(b"from-old").expect("seal");
        assert_eq!(
            ring.open_with_slot(&nonce, &ciphertext).expect("open"),
            (b"from-old".to_vec(), CredentialKeySlot::Previous(0))
        );
        let (nonce, ciphertext) = older.seal(b"from-older").expect("seal");
        assert_eq!(
            ring.open_with_slot(&nonce, &ciphertext).expect("open"),
            (b"from-older".to_vec(), CredentialKeySlot::Previous(1))
        );
    }

    #[test]
    fn a_key_that_did_not_seal_a_row_fails_instead_of_returning_garbage() {
        let (nonce, ciphertext) = CredentialKeyRing::from(key("sealer"))
            .seal(b"payload")
            .expect("seal");
        let wrong = CredentialKeyRing::new(key("wrong-primary"), vec![key("wrong-previous")])
            .expect("distinct keys");
        let error = wrong
            .open(&nonce, &ciphertext)
            .expect_err("GCM authentication must reject a wrong key")
            .to_string();
        assert!(error.contains("does not authenticate"), "{error}");

        // A tampered ciphertext fails under the right key too.
        let mut tampered = BASE64.decode(&ciphertext).expect("base64");
        tampered[0] ^= 1;
        assert!(CredentialKeyRing::from(key("sealer"))
            .open(&nonce, &BASE64.encode(tampered))
            .is_err());
        assert!(CredentialKeyRing::from(key("sealer"))
            .open(&nonce, &ciphertext)
            .is_ok());
    }

    #[test]
    fn malformed_stored_values_are_errors_without_echoing_them() {
        let ring = CredentialKeyRing::from(key("any"));
        for (nonce, ciphertext) in [
            ("not base64 !", "AAAA"),
            ("AAAA", "AAAA"),
            (&BASE64.encode([0u8; 12])[..], "%%%"),
        ] {
            let error = ring
                .open(nonce, ciphertext)
                .expect_err("malformed")
                .to_string();
            assert!(
                matches!(
                    error.as_str(),
                    "stored nonce is not valid base64"
                        | "invalid nonce length"
                        | "stored ciphertext is not valid base64"
                ),
                "{error}"
            );
        }
    }

    #[test]
    fn misconfigured_rotations_are_refused() {
        let error = CredentialKeyRing::new(key("same"), vec![key("same")])
            .expect_err("previous equal to primary")
            .to_string();
        assert!(error.contains("previous credential encryption key 1 is the primary key"));

        let error = CredentialKeyRing::new(key("primary"), vec![key("a"), key("b"), key("a")])
            .expect_err("duplicate previous keys")
            .to_string();
        assert!(error.contains("keys 1 and 3 are the same key"), "{error}");

        let too_many = (0..=super::MAX_PREVIOUS_CREDENTIAL_KEYS)
            .map(|index| key(&format!("previous-{index}")))
            .collect();
        assert!(CredentialKeyRing::new(key("primary"), too_many).is_err());
    }

    #[test]
    fn key_ids_are_stable_distinct_and_never_the_key() {
        let a = key("a");
        assert_eq!(credential_key_id(&a), credential_key_id(&key("a")));
        assert_ne!(credential_key_id(&a), credential_key_id(&key("b")));
        assert_eq!(credential_key_id(&a).len(), 12);
        assert!(!hex::encode(a.as_bytes()).contains(&credential_key_id(&a)));
        assert_eq!(
            format!(
                "{:?}",
                CredentialKeyRing::new(key("p"), vec![key("q")]).unwrap()
            ),
            "CredentialKeyRing { primary: \"<redacted>\", previous_keys: 1 }"
        );
    }

    /// Pins the id derivation to a checked-in digest, so the published
    /// development key id (a constant computed offline the same way) cannot
    /// silently stop matching. The expected value is the first 12 hex digits of
    /// SHA-256("instafy:credential-encryption-key-id:v1:" || key) for the
    /// test-only key derived from the seed below; it is not a key.
    #[test]
    fn key_ids_match_the_checked_in_digest() {
        assert_eq!(
            credential_key_id(&key("credential-key-id-test-vector")),
            "7bf62185616c"
        );
        assert_eq!(PUBLISHED_DEVELOPMENT_KEY_ID.len(), 12);
        assert!(PUBLISHED_DEVELOPMENT_KEY_ID
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn configured_keys_are_found_by_id_only() {
        let (primary, legacy, other) = (key("primary"), key("legacy"), key("other"));
        let ring =
            CredentialKeyRing::new(primary.clone(), vec![other, legacy.clone()]).expect("ring");
        assert_eq!(
            ring.slot_of_key_id(&credential_key_id(&primary)),
            Some(CredentialKeySlot::Primary)
        );
        assert_eq!(
            ring.slot_of_key_id(&credential_key_id(&legacy)),
            Some(CredentialKeySlot::Previous(1))
        );
        assert_eq!(
            ring.slot_of_key_id(&credential_key_id(&key("absent"))),
            None
        );
        // None of these test keys is the published development key.
        assert_eq!(ring.published_development_key_slot(), None);
    }
}
