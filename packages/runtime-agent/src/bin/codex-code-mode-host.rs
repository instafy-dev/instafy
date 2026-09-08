//! The embedded engine resolves this sibling executable for isolated code-mode cells.

fn main() -> anyhow::Result<()> {
    codex_process_hardening::pre_main_hardening();
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.as_slice() == [std::ffi::OsString::from("--version")] {
        println!("codex-code-mode-host {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    anyhow::ensure!(
        args.is_empty(),
        "code-mode host accepts only stdio or --version"
    );
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(codex_code_mode_host::run_stdio())
}
