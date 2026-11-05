//! The routing check's command (docs/Octo-Turn-Eval.md, "Routing check"): fixed messages, each
//! with its chat, through the runtime's own routing step, and the route each one gets. Built
//! with `harness = false`, so it takes its own arguments:
//!
//! ```text
//! cargo test --manifest-path packages/runtime-agent/Cargo.toml --test routing_check -- [options]
//! ```
//!
//! See [`USAGE`]. Every mode that runs the routing step runs it in a child process with an
//! emptied environment and a HOME, TMPDIR and Codex home of its own, so no login, key or config
//! of the machine is read. The model is sent an inert key: the endpoint given to `--live` must
//! serve the model without one. Without arguments, or under a test filter, it is the offline test
//! `routing_check_offline`.

use std::convert::Infallible;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use axum::Router;
use axum::extract::{Json, State};
use axum::response::IntoResponse;
use axum::response::sse::{Event, Sse};
use axum::routing::post;
use futures_util::stream;
use runtime_agent::jobs::routing_check::{
    self, Case, CaseResult, RoutingInput, Run, Verdict, load_cases, prepare_workspace, route_once,
    routing_input,
};
use serde_json::{Value, json};
use uuid::Uuid;

const TEST_NAME: &str = "routing_check_offline";
const CHILD: &str = "INSTAFY_ROUTING_CHECK_CHILD";
/// What the model is sent instead of a key.
const INERT_KEY: &str = "routing-check-inert-key";
/// Instafy AI's model, which a managed turn's routing step uses (the controller's
/// `DEFAULT_MANAGED_AI_MODEL_ID`).
const DEFAULT_MODEL: &str = "gpt-6-luna";
const DEFAULT_RUNS: usize = 3;
const DEFAULT_TIMEOUT_SECONDS: u64 = 180;

const USAGE: &str = "\
Usage: cargo test --manifest-path packages/runtime-agent/Cargo.toml --test routing_check -- [options]

  (no options)       Offline: every case builds, and goes once through the runtime's routing
                     step to a stand-in model on this machine, which answers the expected route.
  --dump <dir>       Write each case's routing input, with no model: <id>.prompt.md (the routing
                     prompt) and <id>.request.json (the whole request the routing step sends).
  --live <url>       Ask the model at <url>, an OpenAI Responses endpoint such as
                     http://127.0.0.1:8790/v1 that serves the model without a key, --runs times
                     per case. Prints a table; exits 1 when a case's majority is wrong.
  --runs <n>         Runs per case with --live (default 3).
  --model <id>       The model (default gpt-6-luna, Instafy AI's).
  --case <id>        Only this case; repeat for more.
  --cases <file>     Another case file (default tests/fixtures/routing-check-cases.json).
  --json <file>      Also write the results as JSON.
  --timeout <secs>   Time for one routing step (default 180).";

#[derive(Debug, Clone)]
enum Mode {
    /// Every case once to the stand-in, which answers the expected route.
    Offline,
    Dump(PathBuf),
    Live(String),
}

#[derive(Debug, Clone)]
struct Options {
    mode: Mode,
    runs: usize,
    model: String,
    case_ids: Vec<String>,
    cases: PathBuf,
    json: Option<PathBuf>,
    timeout: Duration,
}

enum Invocation {
    /// As a test binary under `cargo test`: run `routing_check_offline` when selected.
    Test {
        list: bool,
        selected: bool,
    },
    Command(Options),
}

fn default_cases() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/routing-check-cases.json")
}

fn absolute(path: &str) -> Result<PathBuf> {
    let path = PathBuf::from(path);
    Ok(if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    })
}

fn parse(args: &[String]) -> Result<Invocation> {
    const FLAGS: &[&str] = &[
        "--dump",
        "--live",
        "--runs",
        "--model",
        "--case",
        "--cases",
        "--json",
        "--timeout",
        "--help",
    ];
    if !args.iter().any(|arg| FLAGS.contains(&arg.as_str())) {
        // `cargo test` passes libtest's own options and any filter to every test binary.
        let exact = args.iter().any(|arg| arg == "--exact");
        let filters: Vec<&String> = args.iter().filter(|arg| !arg.starts_with('-')).collect();
        let only_ignored = args.iter().any(|arg| arg == "--ignored");
        let selected = !only_ignored
            && (filters.is_empty()
                || filters.iter().any(|filter| {
                    if exact {
                        filter.as_str() == TEST_NAME
                    } else {
                        TEST_NAME.contains(filter.as_str())
                    }
                }));
        return Ok(Invocation::Test {
            list: args.iter().any(|arg| arg == "--list"),
            selected,
        });
    }
    let mut options = Options {
        mode: Mode::Offline,
        runs: DEFAULT_RUNS,
        model: DEFAULT_MODEL.to_string(),
        case_ids: Vec::new(),
        cases: default_cases(),
        json: None,
        timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECONDS),
    };
    let mut runs_given = false;
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        if flag == "--help" {
            bail!("help");
        }
        let value = args
            .next()
            .with_context(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--dump" | "--live" if !matches!(options.mode, Mode::Offline) => {
                bail!("give --dump or --live, not both")
            }
            "--dump" => options.mode = Mode::Dump(absolute(value)?),
            "--live" => {
                let url = reqwest::Url::parse(value)
                    .with_context(|| format!("--live {value}: not a URL"))?;
                ensure!(
                    matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
                    "--live {value}: an http or https endpoint"
                );
                options.mode = Mode::Live(value.trim_end_matches('/').to_string());
            }
            "--runs" => {
                options.runs = value
                    .parse()
                    .ok()
                    .filter(|runs| (1..=20).contains(runs))
                    .context("--runs takes 1 to 20")?;
                runs_given = true;
            }
            "--model" => {
                ensure!(!value.trim().is_empty(), "--model needs a model");
                options.model = value.trim().to_string();
            }
            "--case" => options.case_ids.push(value.clone()),
            "--cases" => options.cases = absolute(value)?,
            "--json" => options.json = Some(absolute(value)?),
            "--timeout" => {
                options.timeout = Duration::from_secs(
                    value
                        .parse()
                        .ok()
                        .filter(|secs| *secs > 0)
                        .context("--timeout takes seconds")?,
                )
            }
            other => bail!("unknown option {other}"),
        }
    }
    ensure!(
        !runs_given || matches!(options.mode, Mode::Live(_)),
        "--runs goes with --live"
    );
    Ok(Invocation::Command(options))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let invocation = match parse(&args) {
        Ok(invocation) => invocation,
        Err(error) if error.to_string() == "help" => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("routing check: {error:#}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if std::env::var_os(CHILD).is_some() {
        let Invocation::Command(options) = invocation else {
            eprintln!("routing check: the child was started without its options");
            return ExitCode::from(2);
        };
        return run_child(options);
    }
    match invocation {
        Invocation::Test { list: true, .. } => {
            println!("{TEST_NAME}: test");
            ExitCode::SUCCESS
        }
        Invocation::Test {
            selected: false, ..
        } => {
            println!("test result: ok. 0 passed; 0 failed; 1 filtered out");
            ExitCode::SUCCESS
        }
        Invocation::Test { .. } => {
            println!("test {TEST_NAME} ...");
            let mut child_args = vec!["--cases".to_string()];
            child_args.push(default_cases().display().to_string());
            match spawn_isolated_child(&child_args) {
                Ok(code) if code == 0 => {
                    println!("test {TEST_NAME} ... ok");
                    ExitCode::SUCCESS
                }
                Ok(_) => {
                    println!("test {TEST_NAME} ... FAILED");
                    ExitCode::FAILURE
                }
                Err(error) => {
                    eprintln!("routing check: {error:#}");
                    ExitCode::FAILURE
                }
            }
        }
        Invocation::Command(_) => match spawn_isolated_child(&args) {
            Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Err(error) => {
                eprintln!("routing check: {error:#}");
                ExitCode::from(2)
            }
        },
    }
}

/// Runs this binary again with `args` in a child with an emptied environment and a HOME and
/// TMPDIR of its own, so nothing reads the machine's Codex login, keys or config. Its output is
/// this run's output.
fn spawn_isolated_child(args: &[String]) -> Result<i32> {
    let isolated = tempfile::TempDir::new()?;
    let home = isolated.path().join("home");
    let scratch = isolated.path().join("tmp");
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&scratch)?;
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .args(args)
        .env_clear()
        .env(CHILD, "1")
        .env("HOME", &home)
        .env("TMPDIR", &scratch)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        // A runtime machine's shell and clock, as the routing step there sees them.
        .env("SHELL", "/bin/bash")
        .env("TZ", "Etc/UTC")
        .env("LANG", "C.UTF-8")
        .env("RUST_MIN_STACK", "33554432")
        .current_dir(&home)
        .stdin(std::process::Stdio::null());
    if let Some(filter) = std::env::var_os("RUST_LOG") {
        command.env("RUST_LOG", filter);
    }
    let status = command
        .status()
        .context("failed to start the routing check")?;
    Ok(status.code().unwrap_or(1))
}

fn run_child(options: Options) -> ExitCode {
    const STACK: usize = 32 * 1024 * 1024;
    let outcome = std::thread::Builder::new()
        .name("routing-check".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(4)
                .thread_stack_size(STACK)
                .build()?
                .block_on(check(options))
        })
        .map_err(anyhow::Error::from)
        .and_then(|thread| {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("the routing check panicked"))?
        });
    match outcome {
        Ok(code) => code,
        Err(error) => {
            eprintln!("routing check: {error:#}");
            ExitCode::from(2)
        }
    }
}

fn set_env(key: &str, value: impl AsRef<std::ffi::OsStr>) {
    // SAFETY: the child runs one routing step at a time, and sets these before the first; the
    // runtime reads its model settings from the process environment, as in a runtime machine.
    unsafe { std::env::set_var(key, value) };
}

/// A model on this machine that answers each routing step with `answer` and keeps each request.
#[derive(Default)]
struct StandIn {
    answer: Mutex<Value>,
    requests: Mutex<Vec<Value>>,
}

async fn stand_in_answer(
    State(stand_in): State<Arc<StandIn>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    stand_in.requests.lock().unwrap().push(body);
    let text = stand_in.answer.lock().unwrap().to_string();
    let id = format!("resp_{}", Uuid::new_v4().simple());
    let item = json!({
        "id": format!("msg_{}", Uuid::new_v4().simple()), "type": "message", "role": "assistant",
        "status": "completed", "phase": "final_answer",
        "content": [{"type": "output_text", "text": text}]
    });
    let response = json!({
        "id": id, "object": "response", "status": "completed", "output": [item.clone()],
        "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    });
    let events = [
        json!({"type": "response.created", "response": {"id": id, "status": "in_progress", "output": []}}),
        json!({"type": "response.output_item.done", "output_index": 0, "item": item}),
        json!({"type": "response.completed", "response": response}),
    ];
    Sse::new(stream::iter(events.into_iter().map(|event| {
        Ok::<Event, Infallible>(Event::default().data(event.to_string()))
    })))
    .into_response()
}

async fn start_stand_in() -> Result<(Arc<StandIn>, String)> {
    let stand_in = Arc::new(StandIn::default());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let address = listener.local_addr()?;
    let app = Router::new()
        .route("/v1/responses", post(stand_in_answer))
        .with_state(stand_in.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((stand_in, format!("http://{address}/v1")))
}

/// The answer the stand-in gives a case: the one it expects.
fn expected_answer(case: &Case) -> Value {
    let requirement = case
        .expect
        .workspace_file_change_requirement
        .as_ref()
        .and_then(|allowed| allowed.first().cloned())
        .unwrap_or_else(|| "none".to_string());
    json!({
        "summary": "The stand-in model's answer.",
        "route": case.expect.route,
        "reason": "The stand-in model answers the expected route.",
        "selectedSkills": [],
        "confidence": 100,
        "requiresContextLookup": false,
        "requiresCommandExecution": false,
        "workspaceFileChangeRequirement": requirement,
        "observationCommands": [],
        "workerQuestionReply": null
    })
}

/// Code-mode-only models (gpt-6-luna among them) start no turn without `codex-code-mode-host`
/// beside the runtime's executable, here this binary in `target/<profile>/deps`. Links the host
/// that the build command in DEV_SETUP.md leaves in `target/<profile>`.
fn stage_code_mode_host(model: &str) -> Result<()> {
    if !runtime_agent::code_mode_host::bundled_model_is_code_mode_only(model)? {
        return Ok(());
    }
    let name = runtime_agent::code_mode_host::EXECUTABLE_NAME;
    let executable = std::env::current_exe()?;
    let deps = executable.parent().context("this binary's directory")?;
    let built = deps
        .parent()
        .context("the Cargo profile directory")?
        .join(name);
    ensure!(
        built.is_file(),
        "{model} runs only with {name}, which is not built in {}: build it with `cargo build --manifest-path packages/runtime-agent/Cargo.toml --features code-mode-host -p runtime-agent -p codex-code-mode-host` (DEV_SETUP.md), or pass --model gpt-5.5",
        deps.parent().unwrap_or(deps).display()
    );
    let staged = deps.join(name);
    // Replace an earlier copy, so a rebuilt host is the one used.
    let _ = fs::remove_file(&staged);
    if fs::hard_link(&built, &staged).is_err() {
        fs::copy(&built, &staged)?;
    }
    Ok(())
}

/// Gives each id and time a run makes up the same placeholder.
fn without_run_ids(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, entry) in map.iter_mut() {
                match key.as_str() {
                    "client_metadata" => *entry = Value::from("<this run's ids>"),
                    "id" | "create_time" | "turn_id" | "prompt_cache_key"
                        if !entry.is_object() && !entry.is_array() =>
                    {
                        *entry = Value::from("<this run's>")
                    }
                    _ => without_run_ids(entry),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(without_run_ids),
        _ => {}
    }
}

/// The request as a dump keeps it: this run's own ids, times and folders by name, so two dumps
/// differ only where the routing input does.
fn normalized_request(request: &Value, folders: &[(&Path, &str)]) -> Result<String> {
    let mut request = request.clone();
    without_run_ids(&mut request);
    let mut text = serde_json::to_string_pretty(&request)?;
    for (folder, name) in folders {
        for spelling in [
            folder.display().to_string(),
            fs::canonicalize(folder)?.display().to_string(),
        ] {
            text = text.replace(&spelling, name);
        }
    }
    Ok(text + "\n")
}

/// The texts of a request's input, in order.
fn input_texts(request: &Value) -> Vec<String> {
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str().map(str::to_string))
        .collect()
}

/// Whether the stand-in got the routing step a job sends: this case's routing prompt, this
/// model, the routing answer's schema and the routing step's reasoning effort.
fn check_request(request: &Value, input: &RoutingInput, model: &str) -> Result<()> {
    ensure!(
        input_texts(request)
            .iter()
            .any(|text| text.contains(input.prompt.trim())),
        "the request does not carry the case's routing prompt"
    );
    ensure!(
        request["model"].as_str() == Some(model),
        "the request asks for {:?}, not {model}",
        request["model"]
    );
    ensure!(
        request["text"]["format"]["schema"]["properties"]["route"].is_object(),
        "the request does not carry the routing answer's schema"
    );
    ensure!(
        request["reasoning"]["effort"].as_str() == Some("low"),
        "the request's reasoning effort is {:?}",
        request["reasoning"]["effort"]
    );
    Ok(())
}

async fn check(options: Options) -> Result<ExitCode> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("error")),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
    let mut cases = load_cases(&options.cases)?;
    if !options.case_ids.is_empty() {
        for id in &options.case_ids {
            ensure!(cases.iter().any(|case| &case.id == id), "no case {id}");
        }
        cases.retain(|case| options.case_ids.contains(&case.id));
    }

    // A new space's folder with the files this checkout ships, and a Codex home of the check's
    // own with only an inert key.
    let scratch = PathBuf::from(std::env::var_os("TMPDIR").context("TMPDIR")?);
    let workspace = scratch.join("workspace").join(Uuid::new_v4().to_string());
    prepare_workspace(&workspace)?;
    let codex_home = scratch.join("codex-home");
    fs::create_dir_all(&codex_home)?;
    let auth = codex_home.join("auth.json");
    fs::write(&auth, json!({"OPENAI_API_KEY": INERT_KEY}).to_string())?;
    let inputs = cases
        .iter()
        .map(|case| routing_input(case, &workspace))
        .collect::<Result<Vec<_>>>()?;
    if let Mode::Dump(dir) = &options.mode {
        fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
        for (case, input) in cases.iter().zip(&inputs) {
            fs::write(dir.join(format!("{}.prompt.md", case.id)), &input.prompt)?;
        }
    }

    let (stand_in, endpoint) = match &options.mode {
        Mode::Live(url) => (None, url.clone()),
        Mode::Offline | Mode::Dump(_) => {
            let (stand_in, endpoint) = start_stand_in().await?;
            (Some(stand_in), endpoint)
        }
    };
    for (key, value) in [
        ("OPENAI_BASE_URL", endpoint.as_str()),
        ("OPENAI_API_KEY", INERT_KEY),
        ("CODEX_API_KEY", INERT_KEY),
        // A managed turn's job carries its model, as `CODEX_MODEL`.
        ("CODEX_MODEL", options.model.as_str()),
        ("CODEX_DISABLED", "false"),
    ] {
        set_env(key, value);
    }
    set_env("CODEX_HOME", &codex_home);
    set_env("CODEX_AUTH_PATH", &auth);
    if let Err(error) = stage_code_mode_host(&options.model) {
        if let Mode::Dump(dir) = &options.mode {
            println!(
                "Wrote {} routing prompts to {}. No requests: {error:#}",
                cases.len(),
                dir.display()
            );
            return Ok(ExitCode::SUCCESS);
        }
        return Err(error);
    }

    let runs = match options.mode {
        Mode::Live(_) => options.runs,
        Mode::Offline | Mode::Dump(_) => 1,
    };
    if let Mode::Live(url) = &options.mode {
        eprintln!(
            "Routing check: {}, {} each, {} at {url}.",
            routing_check::plural(cases.len(), "case"),
            routing_check::plural(runs, "run"),
            options.model
        );
    }
    let mut results = Vec::new();
    for (case, input) in cases.iter().zip(&inputs) {
        let mut case_runs: Vec<Run> = Vec::new();
        for attempt in 1..=runs {
            if let Some(stand_in) = &stand_in {
                *stand_in.answer.lock().unwrap() = match options.mode {
                    Mode::Dump(_) => json!({
                        "summary": "s", "route": "direct", "reason": "r", "selectedSkills": [],
                        "confidence": 100, "requiresContextLookup": false,
                        "requiresCommandExecution": false,
                        "workspaceFileChangeRequirement": "none", "observationCommands": [],
                        "workerQuestionReply": null
                    }),
                    _ => expected_answer(case),
                };
                stand_in.requests.lock().unwrap().clear();
            }
            let run = route_once(&workspace, case, input, options.timeout).await;
            if let Mode::Live(_) = options.mode {
                eprintln!(
                    "  {} {attempt}/{runs}: {} ({:.1} s)",
                    case.id,
                    run.answer
                        .as_ref()
                        .map(|answer| answer.route.as_str())
                        .unwrap_or("error"),
                    run.seconds
                );
            }
            if let Some(error) = &run.error {
                let hint = if error.contains("401") || error.contains("nauthorized") {
                    " (this endpoint wants a key or a turn's own token: give --live an endpoint that serves the model without one, see docs/Octo-Turn-Eval.md)"
                } else {
                    ""
                };
                eprintln!("  {}: the routing step failed: {error}{hint}", case.id);
            }
            if let Some(stand_in) = &stand_in {
                let requests = stand_in.requests.lock().unwrap().clone();
                let request = requests.first().with_context(|| {
                    format!("case {}: no request reached the stand-in", case.id)
                })?;
                match &options.mode {
                    Mode::Dump(dir) => {
                        let text = normalized_request(
                            request,
                            &[
                                (&workspace, "<workspace>"),
                                (&codex_home, "<codex-home>"),
                                (&scratch, "<tmp>"),
                            ],
                        )?;
                        fs::write(dir.join(format!("{}.request.json", case.id)), text)?;
                    }
                    _ => check_request(request, input, &options.model)
                        .with_context(|| format!("case {}", case.id))?,
                }
            }
            case_runs.push(run);
        }
        results.push(CaseResult::new(case, case_runs));
    }

    if let Some(path) = &options.json {
        fs::write(
            path,
            serde_json::to_string_pretty(&json!({
                "model": options.model,
                "endpoint": match &options.mode { Mode::Live(url) => Value::from(url.as_str()), _ => Value::Null },
                "runsPerCase": runs,
                "cases": results,
            }))? + "\n",
        )?;
    }
    if let Mode::Dump(dir) = &options.mode {
        println!(
            "Wrote the routing input of {} cases to {}: <case>.prompt.md and <case>.request.json.",
            cases.len(),
            dir.display()
        );
        return Ok(ExitCode::SUCCESS);
    }
    println!("{}", routing_check::table(&cases, &results));
    let wrong = results
        .iter()
        .filter(|result| result.verdict == Verdict::Wrong)
        .count();
    Ok(if wrong == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}
