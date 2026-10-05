//! Which workspace paths a runtime may publish to canonical history.
//!
//! The shard's push hook refuses the shared deny list
//! ([`git_service::policy::REPO_POLICY_DENY_PATTERNS`]) and blobs over its
//! size cap. A publish checks the same rules first, plus rules only the
//! publisher can apply: Instafy's own metadata, secret files, and legacy chat
//! attachments. Those extra rules are never added to the hook, because the
//! hook also refuses deletions and a repository that already holds such a
//! file must stay able to remove it.

use serde::Serialize;

use crate::git::is_sync_reserved_path;

/// Largest blob a publish sends, matching the shard's default
/// `GIT_MAX_BLOB_BYTES`. A shard configured lower names the path in its
/// rejection and the publish drops it then.
pub const MAX_PUBLISH_BLOB_BYTES: u64 = 20 * 1024 * 1024;

/// Why a path was left out of a publish.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    /// Build output, caches, dependencies or Instafy metadata.
    Excluded,
    /// A credential file such as `.env` or a private key.
    Secret,
    /// A chat attachment from before attachments moved to storage.
    Attachment,
    /// Matched by `.gitignore`.
    Ignored,
    /// Larger than [`MAX_PUBLISH_BLOB_BYTES`].
    TooLarge,
    /// Refused by the repository's push policy.
    Policy,
    /// Not a regular file, link or directory git can store safely.
    Unsupported,
}

impl RejectReason {
    /// The reason's name in answers (`excluded`, `secret`, `attachment`,
    /// `ignored`, `too_large`, `policy`, `unsupported`), as it serializes.
    pub fn name(self) -> &'static str {
        match self {
            Self::Excluded => "excluded",
            Self::Secret => "secret",
            Self::Attachment => "attachment",
            Self::Ignored => "ignored",
            Self::TooLarge => "too_large",
            Self::Policy => "policy",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Why a restore of unsaved work may never bring a change at `path` back,
/// if so, by the rules a save follows: a delete only where deletes are
/// allowed; a write never to an excluded, secret or attachment path, an
/// unsafe or reserved path or as a submodule (`new_mode` 160000), nor of a
/// blob larger than [`MAX_PUBLISH_BLOB_BYTES`] (`size`, when known). Desktop
/// and the hosted gateway restore by it; the space's ignore rules each mode
/// applies itself.
pub fn restore_refusal(
    path: &str,
    deleted: bool,
    new_mode: &str,
    size: Option<u64>,
) -> Option<RejectReason> {
    if deleted {
        return (!deletion_allowed(path)).then_some(RejectReason::Excluded);
    }
    if let Some(reason) = unpublishable_reason(path) {
        return Some(reason);
    }
    if is_unsafe_path(path) || new_mode == "160000" {
        return Some(RejectReason::Unsupported);
    }
    size.is_some_and(|size| size > MAX_PUBLISH_BLOB_BYTES)
        .then_some(RejectReason::TooLarge)
}

/// The reason `path` may never be published, if any.
pub fn unpublishable_reason(path: &str) -> Option<RejectReason> {
    if git_service::policy::repo_policy_denies_path(path) || is_sync_reserved_path(path) {
        return Some(RejectReason::Excluded);
    }
    if is_secret_path(path) {
        return Some(RejectReason::Secret);
    }
    if is_legacy_attachment_path(path) {
        return Some(RejectReason::Attachment);
    }
    None
}

/// Whether `path` may never be added to or changed in canonical history.
pub fn is_unpublishable(path: &str) -> bool {
    unpublishable_reason(path).is_some()
}

/// Whether a publish may delete `path` from canonical history. Secrets and
/// legacy attachments may be removed; excluded paths are refused by the hook
/// in both directions, so their deletion is never sent.
pub fn deletion_allowed(path: &str) -> bool {
    !matches!(unpublishable_reason(path), Some(RejectReason::Excluded)) && !is_unsafe_path(path)
}

/// File names that hold credentials. Matched on the last path segment,
/// ignoring ASCII case because macOS folders are case-insensitive.
pub fn is_secret_path(path: &str) -> bool {
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.starts_with(".env") {
        return !matches!(
            name.as_str(),
            ".env.example" | ".env.sample" | ".env.template"
        );
    }
    name.ends_with(".pem")
        || name.ends_with(".key")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || matches!(name.as_str(), ".npmrc" | ".pypirc" | ".netrc")
}

/// Chat images the web app used to write into the workspace root, and the
/// merge snapshots it wrote under `artifacts/instafy-merge/`.
pub fn is_legacy_attachment_path(path: &str) -> bool {
    let path = path.trim_start_matches('/');
    let lower = path.to_ascii_lowercase();
    (!lower.contains('/') && lower.starts_with("chat-upload-"))
        || lower.starts_with("artifacts/instafy-merge/")
}

/// Paths git must never write into a tree: empty, `.` or `..` segments,
/// and any `.git` alias.
pub fn is_unsafe_path(path: &str) -> bool {
    path.is_empty()
        || path.starts_with('/')
        || path.split('/').any(|segment| {
            let trimmed = segment.trim_end_matches([' ', '.']);
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || trimmed.eq_ignore_ascii_case(".git")
        })
        || crate::paths::is_reserved_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_deny_list_and_instafy_metadata_are_excluded() {
        for path in [
            "node_modules/react/index.js",
            "web/dist/app.js",
            "packages/x/.next/cache/a",
            "tmp/scratch.txt",
            ".instafy/space.json",
            ".instafy/origin-staging/x",
            "vendor/.git/config",
        ] {
            assert_eq!(
                unpublishable_reason(path),
                Some(RejectReason::Excluded),
                "{path}"
            );
            assert!(!deletion_allowed(path), "{path}");
        }
    }

    #[test]
    fn secret_files_are_never_published_but_may_be_deleted() {
        for path in [
            ".env",
            ".env.local",
            "app/.env.production",
            ".ENV",
            "certs/server.pem",
            "tls/private.KEY",
            "id_rsa",
            "home/.ssh/id_rsa.pub",
            "id_ed25519",
            "keys/id_ecdsa_sk",
            ".npmrc",
            "sub/.pypirc",
            ".netrc",
        ] {
            assert_eq!(
                unpublishable_reason(path),
                Some(RejectReason::Secret),
                "{path}"
            );
            assert!(deletion_allowed(path), "{path}");
        }
        for path in [
            ".env.example",
            "app/.env.sample",
            ".env.template",
            "src/environment.ts",
            "docs/keys.md",
            "README.md",
            "src/pem.rs",
            "keyboard.key.json",
        ] {
            assert_eq!(unpublishable_reason(path), None, "{path}");
        }
    }

    #[test]
    fn legacy_chat_attachments_are_never_published_but_may_be_deleted() {
        for path in [
            "chat-upload-1700000000000-abc-photo.png",
            "Chat-Upload-1-x.jpg",
            "artifacts/instafy-merge/2026/notes.md",
        ] {
            assert_eq!(
                unpublishable_reason(path),
                Some(RejectReason::Attachment),
                "{path}"
            );
            assert!(deletion_allowed(path), "{path}");
        }
        for path in [
            "images/chat-upload-1-x.png",
            "artifacts/other/notes.md",
            "chat-uploads.md.txt",
        ] {
            assert_eq!(unpublishable_reason(path), None, "{path}");
        }
    }

    #[test]
    fn unsafe_tree_paths_are_recognised() {
        for path in [
            "",
            "/abs",
            "a//b",
            "./a",
            "a/../b",
            ".git/config",
            "x/.GIT/y",
            "x/.git./y",
        ] {
            assert!(is_unsafe_path(path), "{path:?}");
        }
        for path in ["a", "a/b.txt", ".gitignore", "src/.github/workflows/ci.yml"] {
            assert!(!is_unsafe_path(path), "{path:?}");
        }
    }
}
