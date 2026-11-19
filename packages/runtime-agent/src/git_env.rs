//! git that reads and writes only the repository its folder or its own arguments name.

use std::process::Command;

/// `git` without the inherited variables that would point it at another repository, index or
/// object store ([`origin_http_server::git::REPOSITORY_ENV`]). git exports GIT_DIR, as an absolute
/// path in a linked worktree, to the commands `git rebase --exec` runs and to hooks, and
/// GIT_INDEX_FILE to commit hooks, so the agent or its tests started from one would otherwise read
/// and write the repository that started them.
pub fn git_command() -> Command {
    let mut command = Command::new("git");
    for key in origin_http_server::git::REPOSITORY_ENV {
        command.env_remove(key);
    }
    command
}

// Two of the fixture helpers below exist only on unix.
#[cfg(all(test, unix))]
mod tests {
    use std::path::Path;
    use std::process::{Command, Stdio};

    use super::git_command;

    /// One test from each family of fixture helpers, and from the agent's own git they drive,
    /// that git once let write into, or read, the repository that started the run.
    const RUN_BY_GIT: &[&str] = &[
        "jobs::tests::routing_pre_observation_runs_safe_command",
        "jobs::workspace_change_detection::tests::fingerprints_dirty_embedded_edits_in_canonical_layout_without_touching_git_metadata",
        "jobs::learn::tests::runtime_pack_files_reach_a_canonical_checkout_with_history_and_stay_unsaved",
        "jobs::runtime_pack_files::tests::runtime_pack_files_are_excluded_in_a_plain_git_checkout",
        "jobs::stopped_turn::tests::a_turn_that_lost_its_lease_carries_what_it_changed",
        "jobs::tests::conditional_write_receipts_capture_real_and_resumed_edits_without_forcing_a_patch",
        "jobs::chat_attachments::tests::downloads_land_in_the_conversations_folder_and_are_ignored_by_git",
        "jobs::workspace_commit::tests::isolated_checkpoint_preserves_a_studio_save_after_the_scoped_commit",
        "jobs::space_pages::tests::a_held_pages_entry_goes_back_into_the_record",
        "agent::claude_code_tests::a_failed_turn_saves_nothing_and_reports_its_code",
        "claude_code::preflight::tests::a_seeded_space_passes",
    ];

    /// Run from `git rebase --exec` or a commit hook in a linked worktree, the tests get that
    /// worktree's GIT_DIR, an absolute path, and its GIT_INDEX_FILE. They must still build their
    /// fixtures in their own temp folders and leave that repository's config, refs, index and
    /// objects as they were.
    #[test]
    fn tests_run_by_git_leave_its_repository_alone() {
        let named = tempfile::tempdir().unwrap();
        let main = named.path().join("main");
        let linked = named.path().join("linked");
        std::fs::create_dir(&main).unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let output = git_command()
                .current_dir(dir)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args([
                    "-c",
                    "user.name=Named",
                    "-c",
                    "user.email=named@example.invalid",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        git(&main, &["init", "-q", "-b", "main"]);
        std::fs::write(main.join("README.md"), "not a fixture\n").unwrap();
        git(&main, &["add", "README.md"]);
        git(&main, &["commit", "-q", "-m", "named"]);
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked",
                linked.to_str().unwrap(),
            ],
        );
        let git_dir = git(&linked, &["rev-parse", "--absolute-git-dir"]);
        let config = || std::fs::read_to_string(main.join(".git/config")).unwrap();
        let exclude = || std::fs::read_to_string(main.join(".git/info/exclude")).ok();
        let state = || {
            [
                git(
                    &linked,
                    &["for-each-ref", "--format=%(refname) %(objectname)"],
                ),
                git(&linked, &["symbolic-ref", "HEAD"]),
                git(&linked, &["ls-files", "--stage"]),
                git(&linked, &["count-objects"]),
                git(&linked, &["status", "--porcelain", "--untracked-files=all"]),
            ]
        };
        let config_before = config();
        let exclude_before = exclude();
        let before = state();

        let run = Command::new(std::env::current_exe().unwrap())
            .args(RUN_BY_GIT)
            .args(["--exact", "--test-threads=1"])
            .env("GIT_DIR", &git_dir)
            .env("GIT_INDEX_FILE", Path::new(&git_dir).join("index"))
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let output = format!(
            "{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        );

        assert_eq!(
            config(),
            config_before,
            "a test changed the config of the repository GIT_DIR names"
        );
        assert_eq!(
            exclude(),
            exclude_before,
            "a test changed the info/exclude of the repository GIT_DIR names"
        );
        assert_eq!(
            state(),
            before,
            "a test changed the repository GIT_DIR names"
        );
        assert!(run.status.success(), "{output}");
        let all_passed = format!("test result: ok. {} passed;", RUN_BY_GIT.len());
        assert!(output.contains(&all_passed), "{output}");
    }
}
