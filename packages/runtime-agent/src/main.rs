#![recursion_limit = "256"]

use std::ffi::OsString;
use std::io::Write;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;

use anyhow::{Context, Result};
use codex_arg0::arg0_dispatch;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use runtime_agent::{
    agent::RuntimeAgent, config::Config, personal_browser, process_hardening, shared_browser,
};
use tokio::signal;
use tracing::{Level, error, info, warn};
use tracing_subscriber::EnvFilter;

const APPLY_PATCH_COMMANDS: [&str; 2] = ["apply_patch", "applypatch"];

fn main() -> anyhow::Result<()> {
    // Keep runtime service credentials out of model-controlled processes even
    // when both run as the same Unix user. This must precede every dispatch
    // path because `/proc/<pid>/environ` exposes the process's initial
    // environment independently of later `remove_var` calls.
    process_hardening::harden_runtime_process()
        .context("failed to disable runtime-agent process inspection")?;

    sanitize_tmpdir();
    if let Some(exit_code) = maybe_dispatch_apply_patch_with_bootstrapped_updates() {
        std::process::exit(exit_code);
    }
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.as_slice() == [OsString::from("--version")] {
        println!("runtime-agent {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if personal_browser::is_personal_browser_command(&args) {
        let runtime = build_cli_tokio_runtime()?;
        return runtime.block_on(personal_browser::run_cli(args.into_iter().skip(1)));
    }
    if shared_browser::is_shared_browser_mcp_command(&args) {
        let runtime = build_cli_tokio_runtime()?;
        return runtime.block_on(shared_browser::run_mcp_stdio());
    }
    personal_browser::capture_and_scrub_process_capability()?;

    // `codex_arg0::arg0_dispatch_or_else` uses Tokio defaults for worker stack sizes on
    // Linux/macOS. Codex can exceed those defaults during startup (flake: hosted runtime
    // container aborts with "thread ... has overflowed its stack"). Build our own runtime
    // with a larger stack to keep local/hosted runtimes stable.
    let _path_entry = arg0_dispatch();
    let runtime = build_tokio_runtime()?;
    runtime.block_on(async move { run_runtime_agent().await })
}

fn maybe_dispatch_apply_patch_with_bootstrapped_updates() -> Option<i32> {
    let mut args = std::env::args_os();
    let _argv0 = args.next();
    let argv1 = args.next().unwrap_or_default();

    if !APPLY_PATCH_COMMANDS
        .iter()
        .any(|command| argv1 == OsString::from(command))
    {
        return None;
    }

    let patch_arg = match args
        .next()
        .and_then(|value| value.to_str().map(str::to_owned))
    {
        Some(value) => value,
        None => {
            eprintln!("Error: apply_patch requires a UTF-8 PATCH argument.");
            return Some(1);
        }
    };

    let created = bootstrap_missing_update_targets(&patch_arg).unwrap_or_default();

    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let cwd = match AbsolutePathBuf::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            eprintln!("Error: Failed to determine current directory.\n{err}");
            return Some(1);
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Error: Failed to initialize runtime.\n{err}");
            return Some(1);
        }
    };
    let result = runtime.block_on(codex_apply_patch::apply_patch(
        &patch_arg,
        &PathUri::from_abs_path(&cwd),
        &mut stdout,
        &mut stderr,
        codex_exec_server::LOCAL_FS.as_ref(),
        /*sandbox*/ None,
    ));
    if result.is_ok() {
        let _ = stdout.flush();
        return Some(0);
    }

    for path in created {
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() == 0) {
            let _ = std::fs::remove_file(&path);
        }
    }

    Some(1)
}

fn build_tokio_runtime() -> Result<tokio::runtime::Runtime> {
    // Keep this conservative: large enough to avoid Codex startup overflows, small enough not to
    // waste memory per worker thread.
    const WORKER_STACK_SIZE_BYTES: usize = 16 * 1024 * 1024;
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    builder.thread_stack_size(WORKER_STACK_SIZE_BYTES);
    Ok(builder.build()?)
}

fn build_cli_tokio_runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}

fn bootstrap_missing_update_targets(patch: &str) -> Result<Vec<PathBuf>> {
    let parsed = codex_apply_patch::parse_patch(patch).map_err(anyhow::Error::from)?;
    let mut created = Vec::new();

    for hunk in parsed.hunks {
        let codex_apply_patch::Hunk::UpdateFile { path, chunks, .. } = hunk else {
            continue;
        };

        if path.as_os_str().is_empty() {
            continue;
        }
        if std::fs::metadata(&path)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
        {
            continue;
        }

        let looks_like_new_file_update = chunks
            .iter()
            .all(|chunk| chunk.change_context.is_none() && chunk.old_lines.is_empty());
        if !looks_like_new_file_update {
            continue;
        }

        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create parent directories for {}", path.display())
            })?;
        }

        std::fs::write(&path, "")
            .with_context(|| format!("failed to bootstrap missing file {}", path.display()))?;
        created.push(path);
    }

    Ok(created)
}

fn sanitize_tmpdir() {
    #[cfg(unix)]
    {
        for key in ["TMPDIR", "TMP", "TEMP"] {
            if let Ok(value) = std::env::var(key) {
                let trimmed = value.trim();
                if !trimmed.is_empty() && !Path::new(trimmed).is_dir() {
                    unsafe {
                        std::env::set_var(key, "/tmp");
                    }
                }
            }
        }
    }
}

async fn run_runtime_agent() -> Result<()> {
    init_tracing();

    info!("runtime-agent bootstrap starting");

    shared_browser::clear_stale_agent_control_marker_on_startup()
        .context("failed to establish clean Shared Browser authority at process startup")?;

    let config = match Config::from_env() {
        Ok(value) => value,
        Err(error) => {
            error!(?error, "failed to load configuration");
            return Err(error);
        }
    };

    info!(
        strict_mode = config.strict_mode,
        dev_isolation_mode = config.dev_isolation_mode,
        lease_max_jobs = config.lease_max_jobs,
        "runtime agent configuration loaded"
    );

    let agent = RuntimeAgent::new(config);
    let shutdown = agent.shutdown_handle();
    let agent_task = tokio::spawn(agent.run());

    wait_for_shutdown().await;
    info!("shutdown signal received; stopping agent");

    shutdown.notify_waiters();

    if let Err(join_error) = agent_task.await {
        if !join_error.is_cancelled() {
            warn!(?join_error, "runtime agent task ended unexpectedly");
        }
    }

    info!("runtime-agent exiting");
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info"))
        .unwrap_or_else(|_| EnvFilter::default().add_directive(Level::INFO.into()));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

async fn wait_for_shutdown() {
    let ctrl_c = async {
        if let Err(error) = signal::ctrl_c().await {
            error!(?error, "ctrl_c handler terminated");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut stream) = signal(SignalKind::terminate()) {
            stream.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
