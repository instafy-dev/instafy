use super::*;
use crate::jobs::project_preferences::ProjectPreferencesSnapshot;

fn padding(bytes: usize) -> String {
    "ordinary fact\n".repeat(bytes / 14 + 1)
}

#[test]
fn optimizer_preserves_explicit_preferences_across_cutoff_and_eof() {
    let section = "## Project preferences\nKeep qualifications intact.\nUse concise prose.\n";
    for source in [
        format!("{}\n{section}", padding(12_000)),
        format!(
            "{}\n{section}\n## Facts\n{}",
            "a".repeat(9_950),
            padding(2_000)
        ),
        format!("{section}\n## Facts\n{}", padding(12_000)),
        format!("{}\n## Project preferences\n\n", padding(12_000)),
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join(INSTAFY_FILENAME);
        fs::write(&path, &source).unwrap();
        let before = ProjectPreferencesSnapshot::load(workspace.path()).metrics();
        let mut changed = Vec::new();
        optimize_instafy_md(workspace.path(), &mut changed);
        let after = ProjectPreferencesSnapshot::load(workspace.path()).metrics();
        assert_eq!(before, after, "optimizer changed explicit defaults");
        let result = fs::read_to_string(&path).unwrap();
        assert!(result.len() <= MAX_INSTAFY_MD_BYTES);
        if before["state"] == "loaded" {
            assert!(result.contains(section));
        }
        let overflow = fs::read_to_string(
            workspace
                .path()
                .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
                .join("instafy-memory-overflow/DETAILS.md"),
        )
        .unwrap();
        assert!(!overflow.contains("## Project preferences"));
        changed.clear();
        optimize_instafy_md(workspace.path(), &mut changed);
        assert_eq!(fs::read_to_string(path).unwrap(), result);
        assert!(changed.is_empty(), "repeat optimization churned memory");
    }
}

#[test]
fn optimizer_does_not_activate_invalid_preference_sections() {
    for source in [
        format!(
            "## Project preferences\nFirst.\n## Facts\n{}\n## Project preferences\nConflicting.\n",
            padding(12_000)
        ),
        format!(
            "{}\n## Project preferences\n{}",
            padding(8_000),
            "- preference\n".repeat(400)
        ),
        format!(
            "{}\n## Project preferences\n```\nNever closed",
            padding(12_000)
        ),
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join(INSTAFY_FILENAME);
        fs::write(&path, &source).unwrap();
        assert_eq!(
            ProjectPreferencesSnapshot::load(workspace.path()).metrics()["state"],
            "unavailable"
        );
        let mut changed = Vec::new();
        optimize_instafy_md(workspace.path(), &mut changed);
        assert!(
            fs::read_to_string(path).unwrap() == source,
            "source was changed"
        );
        assert!(changed.is_empty());
    }
}

#[test]
fn optimizer_retains_crlf_unicode_and_skips_unrepresentable_boundary() {
    for body in ["é🦀\r\n".repeat(400), "x".repeat(4096)] {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join(INSTAFY_FILENAME);
        let section = format!("## Project preferences\r\n{body}");
        let source = format!("{}\n{section}", padding(12_000));
        fs::write(&path, &source).unwrap();
        let before = ProjectPreferencesSnapshot::load(workspace.path()).metrics();
        assert_eq!(before["state"], "loaded");
        let mut changed = Vec::new();
        let (_, _, reason) = optimize_instafy_md(workspace.path(), &mut changed);
        assert_eq!(
            ProjectPreferencesSnapshot::load(workspace.path()).metrics(),
            before
        );
        let result = fs::read_to_string(path).unwrap();
        assert!(result.contains(&section));
        if body.len() == 4096 {
            assert_eq!(reason, Some("preferences_would_change"));
            assert!(result == source);
            assert!(changed.is_empty());
        } else {
            assert_eq!(reason, None);
            assert!(result.len() <= MAX_INSTAFY_MD_BYTES);
        }
    }
}

#[test]
fn optimizer_never_restores_defaults_from_overflow() {
    for current_section in ["", "## Project preferences\nCorrected default.\n"] {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join(INSTAFY_FILENAME);
        let overflow = workspace
            .path()
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("instafy-memory-overflow/DETAILS.md");
        fs::create_dir_all(overflow.parent().unwrap()).unwrap();
        fs::write(&overflow, "## Project preferences\nObsolete default.\n").unwrap();
        fs::write(&path, format!("{}\n{current_section}", padding(12_000))).unwrap();
        let before = ProjectPreferencesSnapshot::load(workspace.path()).metrics();
        let mut changed = Vec::new();
        assert_eq!(optimize_instafy_md(workspace.path(), &mut changed).2, None);
        assert_eq!(
            ProjectPreferencesSnapshot::load(workspace.path()).metrics(),
            before
        );
        assert!(
            !fs::read_to_string(path)
                .unwrap()
                .contains("Obsolete default")
        );
    }
}

#[test]
fn optimizer_leaves_unreadable_or_oversized_source_untouched_and_reports_skip() {
    for source in [vec![b'x'; 65537], vec![0xff; 12_000]] {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join(INSTAFY_FILENAME);
        fs::write(&path, &source).unwrap();
        let result = optimize_learned_memory(workspace.path(), None).unwrap();
        assert!(result.instafy_skip_reason.is_some());
        assert_eq!(result.instafy_bytes_before, source.len());
        assert_eq!(result.instafy_bytes_after, source.len());
        assert!(fs::read(path).unwrap() == source);
        assert!(!result.changed_paths.iter().any(|p| p == INSTAFY_FILENAME));
    }
}

#[cfg(unix)]
#[test]
fn optimizer_rejects_source_and_archive_symlink_escapes() {
    use std::os::unix::fs::symlink;
    for link in [
        INSTAFY_FILENAME,
        ".agents",
        ".agents/skills/instafy-learned/blocks/instafy-memory-overflow/DETAILS.md",
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = workspace.path().join(INSTAFY_FILENAME);
        let source = format!("{}\n## Project preferences\nKeep this.\n", padding(12_000));
        let outside_file = outside.path().join("memory.md");
        fs::write(&outside_file, &source).unwrap();
        if link != INSTAFY_FILENAME {
            fs::write(&path, &source).unwrap();
        }
        let linked_path = workspace.path().join(link);
        fs::create_dir_all(linked_path.parent().unwrap()).unwrap();
        symlink(
            if link == ".agents" {
                outside.path()
            } else {
                &outside_file
            },
            linked_path,
        )
        .unwrap();
        let mut changed = Vec::new();
        assert!(
            optimize_instafy_md(workspace.path(), &mut changed)
                .2
                .is_some()
        );
        assert!(fs::read_to_string(&path).unwrap() == source);
        assert!(fs::read_to_string(outside_file).unwrap() == source);
        assert!(!outside.path().join("skills").exists());
        assert!(changed.is_empty());
    }
}

#[test]
fn optimizer_does_not_promote_heading_examples() {
    let source = format!(
        "```markdown\n## Project preferences\nExample only.\n```\n{}",
        padding(12_000)
    );
    let workspace = tempfile::tempdir().unwrap();
    fs::write(workspace.path().join(INSTAFY_FILENAME), &source).unwrap();
    let before = ProjectPreferencesSnapshot::load(workspace.path()).metrics();
    let mut changed = Vec::new();
    assert_eq!(optimize_instafy_md(workspace.path(), &mut changed).2, None);
    assert_eq!(
        ProjectPreferencesSnapshot::load(workspace.path()).metrics(),
        before
    );
}

#[test]
fn optimizer_cuts_ordinary_unicode_on_a_character_boundary() {
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join(INSTAFY_FILENAME);
    let ordinary = "🦀".repeat(3_000);
    fs::write(&path, &ordinary).unwrap();
    let mut changed = Vec::new();
    assert_eq!(optimize_instafy_md(workspace.path(), &mut changed).2, None);
    let retained = fs::read_to_string(path).unwrap();
    let archived = fs::read_to_string(
        workspace
            .path()
            .join(LEARNED_BLOCKS_DIR_RELATIVE_PATH)
            .join("instafy-memory-overflow/DETAILS.md"),
    )
    .unwrap();
    assert!(retained.len() <= MAX_INSTAFY_MD_BYTES);
    assert!(!retained.contains('�') && !archived.contains('�'));
    assert_eq!(
        retained.matches('🦀').count() + archived.matches('🦀').count(),
        3_000
    );
}
