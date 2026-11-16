//! A project secret never replaces the proxy route: the environment that sends a
//! turn's model traffic, and its proxy grant, through the Instafy proxy
//! (`runtime_contracts::proxy_route`).
//!
//! A sequential job's secrets and its turn's proxy route share this process's
//! environment. `apply_job_secrets` sets the secrets before the turn starts and
//! again at every refresh while it runs (every 15 s by default), and
//! `jobs::ProxyEnvGuard` sets the route from the turn's proxy envelope, reading
//! `PROXY_BASE_URL` as it does. What starts later reads the route from here: the
//! turn's Codex configuration, the direct worker lanes and every command the
//! model runs.
//!
//! Every value here is an inert stand-in.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;

use codex_protocol::config_types::ShellEnvironmentPolicy;
use codex_protocol::shell_environment::create_env_from_vars;
use parking_lot::Mutex;
use runtime_contracts::ProxyEnvelopePayload;

use super::{AgentRuntimeSettings, AgentSecretInventoryItem, JobSecrets, apply_job_secrets};

const PROXY_URL: &str = "http://proxy.test:8789";
const PROXY_GRANT: &str = "inert-proxy-grant";
const LAUNCH_PROXY_URL: &str = "http://launch-proxy.test:8789";
const CHOSEN_URL: &str = "http://project-chosen.invalid";
const INVENTORY_KEY: &str = "INSTAFY_PROJECT_SECRET_INVENTORY";

/// Every name a project secret might take to replace the route.
const ROUTE_NAMES: [&str; 7] = [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_ENDPOINT",
    "CODEX_CHATGPT_ENDPOINT",
    "CODEX_PROXY_CHATGPT_ENDPOINT",
    "PROXY_BASE_URL",
];

/// What the turn's guard sets, for a proxy reached at `base`.
fn route_from(base: &str) -> Vec<(&'static str, String)> {
    vec![
        ("OPENAI_API_KEY", PROXY_GRANT.to_string()),
        ("CODEX_API_KEY", PROXY_GRANT.to_string()),
        ("OPENAI_BASE_URL", format!("{base}/v1")),
        ("CODEX_API_ENDPOINT", format!("{base}/api")),
        (
            "CODEX_CHATGPT_ENDPOINT",
            format!("{base}/backend-api/codex/responses"),
        ),
        (
            "CODEX_PROXY_CHATGPT_ENDPOINT",
            format!("{base}/backend-api/codex/responses"),
        ),
    ]
}

fn envelope() -> ProxyEnvelopePayload {
    ProxyEnvelopePayload {
        url: PROXY_URL.to_string(),
        token: PROXY_GRANT.to_string(),
        expires_at: None,
    }
}

/// Secrets a project member saved under `names`, beside an ordinary one.
fn chosen_secrets(names: &[&str]) -> JobSecrets {
    let mut env: HashMap<String, String> = names
        .iter()
        .map(|name| {
            let value = if name.ends_with("_KEY") {
                format!("inert-project-{}", name.to_ascii_lowercase())
            } else {
                CHOSEN_URL.to_string()
            };
            (name.to_string(), value)
        })
        .collect();
    env.insert("DEPLOY_TOKEN".into(), "inert-deploy-token".into());
    let inventory = env
        .keys()
        .map(|name| AgentSecretInventoryItem {
            name: name.clone(),
            description: None,
        })
        .collect();
    JobSecrets {
        env,
        inventory,
        inventory_complete: true,
        runtime_settings: AgentRuntimeSettings::default(),
        research_budget: Default::default(),
    }
}

fn no_secrets() -> JobSecrets {
    JobSecrets {
        env: HashMap::new(),
        inventory: Vec::new(),
        inventory_complete: true,
        runtime_settings: AgentRuntimeSettings::default(),
        research_budget: Default::default(),
    }
}

/// Puts back every variable these tests touch, however a test ends.
struct RestoreEnvironment(Vec<(&'static str, Option<OsString>)>);

impl RestoreEnvironment {
    fn capture() -> Self {
        Self(
            ROUTE_NAMES
                .iter()
                .copied()
                .chain(["DEPLOY_TOKEN", INVENTORY_KEY])
                .chain(crate::research_budget::ENV_KEYS)
                .map(|name| (name, std::env::var_os(name)))
                .collect(),
        )
    }
}

impl Drop for RestoreEnvironment {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => unsafe { std::env::set_var(name, value) },
                None => unsafe { std::env::remove_var(name) },
            }
        }
    }
}

fn set(name: &str, value: Option<&str>) {
    match value {
        Some(value) => unsafe { std::env::set_var(name, value) },
        None => unsafe { std::env::remove_var(name) },
    }
}

/// What a command the model runs inherits, built as Codex builds it.
fn command_environment() -> HashMap<String, String> {
    create_env_from_vars(std::env::vars(), &ShellEnvironmentPolicy::default(), None)
}

fn assert_route(base: &str, moment: &str) {
    let command = command_environment();
    for (name, expected) in route_from(base) {
        assert_eq!(
            std::env::var(name).ok().as_deref(),
            Some(expected.as_str()),
            "{moment}: this process's {name}"
        );
        assert_eq!(
            command.get(name).map(String::as_str),
            Some(expected.as_str()),
            "{moment}: a command's {name}"
        );
    }
    assert!(
        !std::env::vars().any(|(_, value)| value.contains(CHOSEN_URL)),
        "{moment}: an address a project member chose is in the environment"
    );
}

/// Clears the route as a runtime launched without it has it.
fn clear_route() {
    for name in ROUTE_NAMES {
        set(name, None);
    }
}

#[test]
fn a_project_secret_named_proxy_base_url_never_routes_the_turn() {
    let _lock = crate::codex::process_env_test_lock();
    let _restore = RestoreEnvironment::capture();
    clear_route();
    let managed = Mutex::new(HashSet::new());

    // The job's secrets go in before its turn starts, as `install_fetched_job_secrets` puts them,
    // and the turn's guard reads `PROXY_BASE_URL` after them.
    apply_job_secrets(&managed, &chosen_secrets(&["PROXY_BASE_URL"]));
    let guard = crate::jobs::ProxyEnvGuard::new(&envelope());
    assert_route(PROXY_URL, "as the turn starts");
    assert_eq!(std::env::var("PROXY_BASE_URL").ok(), None);

    drop(guard);
    apply_job_secrets(&managed, &no_secrets());
}

#[test]
fn a_refresh_never_replaces_the_turns_proxy_route() {
    let _lock = crate::codex::process_env_test_lock();
    let _restore = RestoreEnvironment::capture();
    clear_route();
    let managed = Mutex::new(HashSet::new());
    // The addresses the guard sets, without the keys: what is set after a refresh would carry the
    // turn's grant to an address a project member chose.
    let secrets = chosen_secrets(&ROUTE_NAMES[2..6]);

    apply_job_secrets(&managed, &secrets);
    let guard = crate::jobs::ProxyEnvGuard::new(&envelope());
    assert_route(PROXY_URL, "as the turn starts");

    // A refresh in the middle of the turn, as `SecretsRefreshTask` makes one every 15 s.
    apply_job_secrets(&managed, &secrets);
    assert_route(PROXY_URL, "after a refresh");

    drop(guard);
    apply_job_secrets(&managed, &no_secrets());
}

#[test]
fn a_job_keeps_its_other_secrets_and_lists_only_those() {
    assert_eq!(
        ROUTE_NAMES,
        runtime_contracts::proxy_route::PROXY_ROUTE_ENV_KEYS
    );
    let _lock = crate::codex::process_env_test_lock();
    let _restore = RestoreEnvironment::capture();
    clear_route();
    let managed = Mutex::new(HashSet::new());
    let secrets = chosen_secrets(&ROUTE_NAMES);

    apply_job_secrets(&managed, &secrets);
    let guard = crate::jobs::ProxyEnvGuard::new(&envelope());
    assert_route(PROXY_URL, "as the turn starts");
    apply_job_secrets(&managed, &secrets);
    assert_route(PROXY_URL, "after a refresh");
    // The project's other secrets still reach its commands, and the list of the project's
    // secrets the agent reads names only those.
    assert_eq!(
        command_environment()
            .get("DEPLOY_TOKEN")
            .map(String::as_str),
        Some("inert-deploy-token")
    );
    let inventory: Vec<String> =
        serde_json::from_str::<Vec<serde_json::Value>>(&std::env::var(INVENTORY_KEY).unwrap())
            .unwrap()
            .iter()
            .filter_map(|item| item["name"].as_str().map(str::to_string))
            .collect();
    assert_eq!(inventory, ["DEPLOY_TOKEN"]);

    // The turn ends: the route goes with its guard, and the secrets with the job.
    drop(guard);
    apply_job_secrets(&managed, &no_secrets());
    for name in ROUTE_NAMES.iter().chain(&["DEPLOY_TOKEN", INVENTORY_KEY]) {
        assert_eq!(std::env::var(name).ok(), None, "{name} after the turn");
    }
}

#[test]
fn a_runtimes_own_proxy_base_url_outlasts_a_project_secret_of_that_name() {
    let _lock = crate::codex::process_env_test_lock();
    let _restore = RestoreEnvironment::capture();
    clear_route();
    // A Desktop runtime is told at launch where it reaches the proxy.
    set("PROXY_BASE_URL", Some(LAUNCH_PROXY_URL));
    let managed = Mutex::new(HashSet::new());
    let secrets = chosen_secrets(&ROUTE_NAMES);

    for turn in ["the first turn", "the next turn"] {
        apply_job_secrets(&managed, &secrets);
        let guard = crate::jobs::ProxyEnvGuard::new(&envelope());
        assert_route(LAUNCH_PROXY_URL, turn);
        apply_job_secrets(&managed, &secrets);
        assert_route(LAUNCH_PROXY_URL, turn);
        drop(guard);
        apply_job_secrets(&managed, &no_secrets());
        assert_eq!(
            std::env::var("PROXY_BASE_URL").ok().as_deref(),
            Some(LAUNCH_PROXY_URL),
            "after {turn}"
        );
    }
}
