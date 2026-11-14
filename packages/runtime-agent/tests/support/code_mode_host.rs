//! Finds the `codex-code-mode-host` that the runtime-agent integration tests stage beside their
//! test binary, which is where runtime-agent looks for it.
//!
//! `cargo build --features code-mode-host -p runtime-agent -p codex-code-mode-host` leaves the
//! host in the Cargo profile directory (`target/<profile>`). Where a test binary sits below that
//! directory depends on the Cargo release: `target/<profile>/deps` up to Rust 1.99, and
//! `target/<profile>/build/<package>/<hash>/out` from Rust 1.100 on.

use std::path::{Path, PathBuf};

/// How far the profile directory can be above a test binary's directory: one level for
/// `deps`, four for `build/<package>/<hash>/out`.
const PROFILE_DIRECTORY_DEPTH: usize = 4;

/// The built host in the nearest directory above `test_binary_dir` that holds one. The test
/// binary's own directory is never searched: a copy staged there earlier is not the build.
pub fn built_code_mode_host(test_binary_dir: &Path, name: &str) -> Option<PathBuf> {
    test_binary_dir
        .ancestors()
        .skip(1)
        .take(PROFILE_DIRECTORY_DEPTH)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[test]
fn the_built_host_is_found_above_either_test_binary_layout() {
    let target = tempfile::TempDir::new().expect("temporary target directory");
    let profile = target.path().join("debug");
    let name = "codex-code-mode-host";
    let deps = profile.join("deps");
    let out = profile
        .join("build")
        .join("runtime-agent")
        .join("737fba1b12488efb")
        .join("out");
    for directory in [&deps, &out] {
        std::fs::create_dir_all(directory).expect("test binary directory");
    }
    // The host package has a directory of the same name in the new layout's build directory.
    std::fs::create_dir_all(profile.join("build").join(name).join("2fc287bf7bcead4e"))
        .expect("host package build directory");
    assert_eq!(built_code_mode_host(&deps, name), None);
    assert_eq!(built_code_mode_host(&out, name), None);

    // A copy staged beside a test binary is not taken for the build.
    std::fs::write(out.join(name), b"staged").expect("staged copy");
    assert_eq!(built_code_mode_host(&out, name), None);

    let built = profile.join(name);
    std::fs::write(&built, b"built").expect("built host");
    assert_eq!(built_code_mode_host(&deps, name), Some(built.clone()));
    assert_eq!(built_code_mode_host(&out, name), Some(built));
}
