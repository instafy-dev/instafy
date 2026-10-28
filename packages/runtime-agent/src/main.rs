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
    agent::{AgentExit, RuntimeAgent, SPACE_DELETED_EXIT_CODE, exits_when_space_deleted},
    code_mode_host, config,
    config::Config,
    local_browser, loopback_proxy, personal_browser, process_hardening, provider_mcp,
    shared_browser,
};
use tokio::signal;
use tracing::{Level, error, info, warn};
use tracing_subscriber::EnvFilter;

const APPLY_PATCH_COMMANDS: [&str; 2] = ["apply_patch", "applypatch"];

fn main() -> anyhow::Result<()> {
    // Electron-owned Windows runtimes join a KILL_ON_JOB_CLOSE Job Object
    // before any model-controlled process can spawn. If the Rust root exits,
    // Windows then terminates the full descendant tree as one lifetime unit.
    let _parent_owned_process_tree =
        process_hardening::install_parent_owned_process_tree_guard()
            .context("failed to install parent-owned runtime process-tree guard")?;
    // Keep runtime service credentials out of model-controlled processes even
    // when both run as the same Unix user. This must precede every dispatch
    // path because `/proc/<pid>/environ` exposes the process's initial
    // environment independently of later `remove_var` calls.
    process_hardening::harden_runtime_process()
        .context("failed to disable runtime-agent process inspection")?;

    sanitize_tmpdir();
    // Codex's HTTP clients honor HTTP(S)_PROXY, ALL_PROXY and the system proxy, none of which
    // exempts loopback. Device-local endpoints such as the Personal Browser broker (which
    // receives a bearer token) must never be reached through a proxy.
    // SAFETY: no other thread exists yet.
    unsafe { loopback_proxy::exempt_loopback_from_proxy_env() };
    if let Some(exit_code) = maybe_dispatch_apply_patch_with_bootstrapped_updates() {
        std::process::exit(exit_code);
    }
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.as_slice() == [OsString::from("--isolated-tool-worker")] {
        // Read and install only the scoped job environment before creating any threads.
        let request = runtime_agent::isolated_tool_worker::prepare_cli()?;
        let _path_entry = arg0_dispatch();
        if let Some(path) = _path_entry
            .as_ref()
            .and_then(|entry| entry.paths().codex_linux_sandbox_exe.as_ref())
        {
            // SAFETY: the private worker has not created any threads. The path comes from
            // our own executable's dispatch aliases, never the request or workspace config.
            unsafe { std::env::set_var("CODEX_LINUX_SANDBOX_EXE", path) };
        }
        let runtime = build_tokio_runtime()?;
        return runtime.block_on(runtime_agent::isolated_tool_worker::run_cli(request));
    }
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
    if provider_mcp::is_mcp_command(&args) {
        let runtime = build_cli_tokio_runtime()?;
        return runtime.block_on(provider_mcp::run_mcp_stdio());
    }
    if local_browser::is_mcp_command(&args) {
        let runtime = build_cli_tokio_runtime()?;
        return runtime.block_on(local_browser::run_mcp_stdio());
    }
    personal_browser::capture_and_scrub_process_capability()?;
    // Skill packs ship once with the runtime; the small launchers in each space, and model shells,
    // find them through INSTAFY_SKILL_PACKS_DIR.
    // SAFETY: no other thread exists yet.
    let _skill_packs_dir = unsafe { runtime_agent::skill_packs::export_skill_packs_dir_env() };

    // `codex_arg0::arg0_dispatch_or_else` uses Tokio defaults for worker stack sizes on
    // Linux/macOS. Codex can exceed those defaults during startup (flake: hosted runtime
    // container aborts with "thread ... has overflowed its stack"). Build our own runtime
    // with a larger stack to keep local/hosted runtimes stable.
    let _path_entry = arg0_dispatch();
    // Hand the launch-only runtime and origin tokens to the configuration and clear them from
    // this process's environment, so no git, tunnel or helper process spawned later inherits
    // them. This follows `arg0_dispatch`, which may load `$CODEX_HOME/.env` into the
    // environment, so the configuration sees the same values it did before.
    // The unit tests in `config` and `jobs` cover the scrub itself; keep this call before the
    // Tokio runtime and before `Config::from_env`.
    // SAFETY: no other thread exists yet; the Tokio runtime is built on the next line.
    unsafe { config::capture_and_scrub_launch_credentials() }
        .context("failed to capture runtime launch credentials")?;
    // The controller sends each job's model. Keep the launch CODEX_MODEL only as a logged
    // fallback for jobs without one, and out of the process environment so no path reads it
    // implicitly (a stale pin in a dev template used to override the controller this way).
    // SAFETY: no other thread exists yet.
    unsafe { runtime_agent::job_model::capture_and_scrub_launch_model() };
    // Decide once whether this runtime hosts Instafy's browser on demand, from the launch
    // metadata captured above, and in that mode fix the browser ports, paths and isolation
    // settings origin, Codex and the profile code read from the environment.
    // SAFETY: no other thread exists yet.
    unsafe { runtime_agent::browser_host::capture_process_mode() }
        .context("failed to capture the browser host mode")?;
    // Skill pack commands (`bin` in a pack's manifest) on PATH for every shell and worker the
    // runtime starts: a runtime image's shims, or a folder of this run's own at the end of PATH,
    // removed when the runtime exits. This follows the credential scrub above, because it runs
    // `node --version` and a probe.
    // SAFETY: no other thread exists yet; the Tokio runtime is built on the next line.
    let pack_bins = unsafe { runtime_agent::skill_packs::prepare_pack_bins() };
    let runtime = build_tokio_runtime()?;
    let exit = runtime.block_on(async move { run_runtime_agent().await })?;
    if exit == AgentExit::SpaceDeleted {
        drop(pack_bins);
        std::process::exit(SPACE_DELETED_EXIT_CODE);
    }
    Ok(())
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

async fn run_runtime_agent() -> Result<AgentExit> {
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
    code_mode_host::report_startup_availability();
    runtime_agent::skill_packs::report_startup();

    let exit_when_space_deleted = exits_when_space_deleted(&config);
    let agent = RuntimeAgent::new(config);
    let shutdown = agent.shutdown_handle();
    let mut agent_task = tokio::spawn(agent.run());
    let shutdown_signal = wait_for_shutdown();
    tokio::pin!(shutdown_signal);

    tokio::select! {
        _ = &mut shutdown_signal => {}
        exit = &mut agent_task => {
            if matches!(exit, Ok(AgentExit::SpaceDeleted)) {
                if exit_when_space_deleted {
                    info!("runtime-agent exiting: this runtime's space was deleted");
                    return Ok(AgentExit::SpaceDeleted);
                }
                info!("this runtime's space was deleted; waiting for its provider to release it");
            }
            // An agent that stopped on its own keeps the process up until it
            // is signalled, as it always has.
            shutdown_signal.await;
            info!("runtime-agent exiting");
            return Ok(AgentExit::Stopped);
        }
    }
    info!("shutdown signal received; stopping agent");

    shutdown.cancel();

    if let Err(join_error) = agent_task.await {
        if !join_error.is_cancelled() {
            warn!(?join_error, "runtime agent task ended unexpectedly");
        }
    }

    info!("runtime-agent exiting");
    Ok(AgentExit::Stopped)
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
