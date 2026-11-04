//! Regressions at the prompt and learning entry points, not just the I/O helpers.

use super::*;

#[cfg(unix)]
#[test]
fn automatic_memory_discovery_omits_linked_skills_and_linked_learned_blocks() {
    use std::os::unix::fs::symlink;

    for linked_parent in [false, true] {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = workspace.path();
        fs::write(root.join("INSTAFY.md"), "# Memory\nInside workspace.\n").unwrap();
        let skills = root.join(learn::SKILLS_ROOT_RELATIVE_PATH);
        fs::create_dir_all(&skills).unwrap();
        let outside_skill = outside.path().join("SKILL.md");
        fs::write(&outside_skill, "---\nname: external-observation\ndescription: Inventory observations\nalways_include: true\nrouting_keywords: inventory\n---\nOUTSIDE_PROJECT_MARKER\n").unwrap();
        let linked = skills.join("external-observation");
        if linked_parent {
            symlink(outside.path(), &linked).unwrap();
        } else {
            fs::create_dir(&linked).unwrap();
            symlink(&outside_skill, linked.join("SKILL.md")).unwrap();
        }
        let learned = root.join(learn::LEARNED_BLOCKS_DIR_RELATIVE_PATH);
        fs::create_dir_all(&learned).unwrap();
        if linked_parent {
            symlink(outside.path(), learned.join("external-inventory")).unwrap();
        } else {
            fs::create_dir(learned.join("external-inventory")).unwrap();
            symlink(&outside_skill, learned.join("external-inventory/SKILL.md")).unwrap();
        }
        let safe = learned.join("inside-inventory");
        fs::create_dir(&safe).unwrap();
        fs::write(safe.join("SKILL.md"), "---\nname: inside-inventory\ndescription: Inventory observations\nrouting_keywords: inventory\n---\nINSIDE_PROJECT_MARKER\n").unwrap();

        let snapshot =
            format_project_memory_snapshot(root, "Inspect inventory observations").unwrap();
        assert!(!snapshot.text.contains("OUTSIDE_PROJECT_MARKER"));
        assert!(!snapshot.text.contains("external-observation"));
        assert!(snapshot.text.contains("INSIDE_PROJECT_MARKER"));
        assert_eq!(snapshot.loaded_learned_blocks.len(), 1);
        assert_eq!(snapshot.loaded_learned_blocks[0].name, "inside-inventory");
    }
}

#[cfg(unix)]
#[test]
fn automatic_memory_discovery_rejects_a_linked_skills_root() {
    use std::os::unix::fs::symlink;
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = workspace.path();
    fs::create_dir(root.join(".agents")).unwrap();
    fs::create_dir(outside.path().join("outside-skill")).unwrap();
    fs::write(
        outside.path().join("outside-skill/SKILL.md"),
        "---\nname: outside-skill\nalways_include: true\n---\nOUTSIDE_PROJECT_MARKER\n",
    )
    .unwrap();
    symlink(outside.path(), root.join(learn::SKILLS_ROOT_RELATIVE_PATH)).unwrap();
    let snapshot = format_project_memory_snapshot(root, "Explain this project").unwrap();
    assert!(!snapshot.text.contains("OUTSIDE_PROJECT_MARKER"));
    assert!(!snapshot.text.contains("outside-skill"));
}

#[cfg(unix)]
#[test]
fn scaffold_and_optimizer_never_write_through_linked_memory_destinations() {
    use std::os::unix::fs::symlink;
    for (relative, directory) in [
        (".agents", true),
        (".agents/skills", true),
        (".agents/skills/instafy-learned", true),
        (learn::LEARNED_INDEX_RELATIVE_PATH, false),
        (learn::LEARNED_USAGE_RELATIVE_PATH, false),
        (".agents/skills/instafy-learned/ARCHIVE.md", false),
        (learn::LEARNING_POLICY_RELATIVE_PATH, false),
        (learn::COLLABORATION_RELATIVE_PATH, false),
        (learn::INSTAFY_FILENAME, false),
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let external = outside.path().join("keep.txt");
        fs::write(&external, "OUTSIDE_PROJECT_MARKER").unwrap();
        let linked = root.join(relative);
        fs::create_dir_all(linked.parent().unwrap()).unwrap();
        symlink(if directory { outside.path() } else { &external }, &linked).unwrap();
        if !directory && relative != learn::INSTAFY_FILENAME {
            fs::write(root.join("INSTAFY.md"), "# Memory\n").unwrap();
        }
        // Ensure an archive write is attempted when its own destination is linked.
        if relative.ends_with("ARCHIVE.md") {
            let block = root
                .join(learn::LEARNED_BLOCKS_DIR_RELATIVE_PATH)
                .join("bad-replay");
            fs::create_dir_all(&block).unwrap();
            fs::write(
                block.join("SKILL.md"),
                "# Replay\nrun exactly `bash -lc example`\n",
            )
            .unwrap();
        }
        learn::ensure_project_memory_scaffold(root);
        learn::optimize_learned_memory(root, None);
        assert_eq!(
            fs::read_to_string(&external).unwrap(),
            "OUTSIDE_PROJECT_MARKER",
            "{relative}"
        );
        assert_eq!(
            fs::read_dir(outside.path()).unwrap().count(),
            1,
            "{relative}"
        );
        assert!(
            fs::symlink_metadata(&linked)
                .unwrap()
                .file_type()
                .is_symlink(),
            "{relative}"
        );
    }
}

#[cfg(unix)]
#[test]
fn learned_optimizer_does_not_index_linked_block_content() {
    use std::os::unix::fs::symlink;
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = workspace.path();
    let blocks = root.join(learn::LEARNED_BLOCKS_DIR_RELATIVE_PATH);
    fs::create_dir_all(&blocks).unwrap();
    fs::write(
        outside.path().join("SKILL.md"),
        "---\nname: outside\ndescription: OUTSIDE_PROJECT_MARKER\n---\n## Verify\nDone.\n",
    )
    .unwrap();
    symlink(outside.path(), blocks.join("outside")).unwrap();
    learn::optimize_learned_memory(root, None);
    let index = fs::read_to_string(root.join(learn::LEARNED_INDEX_RELATIVE_PATH)).unwrap();
    assert!(!index.contains("OUTSIDE_PROJECT_MARKER"));
    assert!(!index.contains("blocks/outside"));
}
