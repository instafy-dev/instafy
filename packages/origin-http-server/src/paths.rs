pub const ORIGIN_APPLY_RECEIPTS_DIR: &str = ".instafy/origin-apply-receipts";

pub fn is_reserved_path(normalized: &str) -> bool {
    // Default macOS filesystems are case-insensitive. Apply the reserved-name
    // policy case-insensitively on every platform so `.GIT` cannot alias the
    // protected `.git` directory on one runtime but appear harmless on another.
    // Windows additionally treats trailing dots/spaces as aliases of the same
    // name, so those are stripped before comparison.
    let mut segments = normalized.split('/');
    if segments
        .next()
        .is_some_and(|segment| windows_alias_key(segment).eq_ignore_ascii_case(".instafy"))
    {
        return true;
    }
    // `.bind` (any depth) is instafy-bind's state next to a bound site: the
    // admin token that approves confirm-gated jobs and pushes commands to
    // every viewer, the viewer token, the site's thread id and the binder log.
    // It stays on the runtime: never served, listed, written, saved or copied
    // into an isolated worker's snapshot (which reuses this through the
    // publish policy).
    normalized.split('/').any(|segment| {
        let segment = windows_alias_key(segment);
        segment.eq_ignore_ascii_case(".git")
            || segment.eq_ignore_ascii_case(BIND_STATE_DIR)
            || ascii_case_insensitive_starts_with(segment, ".git.instafy-hidden-")
    })
}

/// instafy-bind's per-site and per-root state folder (packages/instafy-bind/src/tokens.mjs BIND_DIR).
pub const BIND_STATE_DIR: &str = ".bind";

pub fn is_reserved_import_delete_path(normalized: &str) -> bool {
    // Deleting the metadata root would also delete every fixed reserved child,
    // including apply receipts, even though the root remains browsable for
    // other Instafy-managed metadata.
    is_reserved_path(normalized)
}

fn windows_alias_key(segment: &str) -> &str {
    segment.trim_end_matches([' ', '.'])
}

fn ascii_case_insensitive_starts_with(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
}

#[cfg(test)]
mod tests {
    use super::{is_reserved_import_delete_path, is_reserved_path, ORIGIN_APPLY_RECEIPTS_DIR};

    #[test]
    fn binder_state_is_reserved_at_any_depth() {
        assert!(is_reserved_path(".bind/admin-token"));
        assert!(is_reserved_path("sites/shoes/.bind/viewer-token"));
        assert!(is_reserved_path("sites/shoes/.BIND/binder.log"));
        assert!(is_reserved_path("sites/shoes/.bind"));
        assert!(is_reserved_path("sites/shoes/.bind./admin-token"));
        assert!(!is_reserved_path("sites/shoes/bind/admin-token"));
        assert!(!is_reserved_path("src/.binder/x"));
        assert!(!is_reserved_path("src/x.bind"));
    }

    #[test]
    fn reserved_paths_are_case_insensitive_for_macos_aliases() {
        assert!(is_reserved_path(".GIT/config"));
        assert!(is_reserved_path("nested/.Git/HEAD"));
        assert!(is_reserved_path(".INSTAFY/ORIGIN-STAGING/file"));
        assert!(!is_reserved_path("src/git/client.rs"));
    }

    #[test]
    fn origin_apply_receipt_namespace_is_reserved() {
        assert!(is_reserved_path(ORIGIN_APPLY_RECEIPTS_DIR));
        assert!(is_reserved_path(
            ".instafy/origin-apply-receipts/receipt.json"
        ));
        assert!(is_reserved_path(".instafy/import-metadata.json"));
        assert!(is_reserved_path(".instafy/origin-apply.lock"));
        assert!(is_reserved_path(".INSTAFY/origin-apply.lock"));
        assert!(is_reserved_path(".instafy./origin-apply.lock"));
        assert!(is_reserved_path("src/.GIT/config"));
        assert!(is_reserved_path("src/.git./config"));
        assert!(is_reserved_path("src/.GIT.INSTAFY-HIDDEN-old/config"));
        assert!(!is_reserved_path("origin-apply-receipts/receipt.json"));

        assert!(is_reserved_import_delete_path(".instafy"));
        assert!(is_reserved_import_delete_path(
            ".instafy/origin-apply-receipts/receipt.json"
        ));
        assert!(is_reserved_import_delete_path(
            ".instafy/import-metadata.json"
        ));
    }
}
