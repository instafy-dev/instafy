//! Getting the node's Docker address pools back when they run out.
//!
//! Every runtime is a compose project with a network of its own
//! (`<prefix><project id, simple>-<runtime id prefix>_default`), and each
//! network takes a subnet from Docker's predefined address pools. Runtimes
//! left running for spaces that were deleted, and networks a failed start or
//! stop left behind, keep their subnets, so the node runs out and every new
//! start fails with "all predefined address pools have been fully subnetted".
//!
//! When a start fails that way, [`reclaim_runtime_address_space`] frees what
//! no space needs:
//! - the runtimes of spaces the controller says are deleted or gone (see
//!   [`SpaceDirectory`]); a space it cannot vouch for keeps its runtime;
//! - runtime networks no container is attached to.
//!
//! Only names of exactly that runtime shape are touched, so another
//! project's containers and networks on the same Docker (the stack's own
//! `instafy-runtime` project among them) are never removed. The start then
//! retries once.

use std::collections::BTreeMap;
use std::process::{Command, Output};
use std::time::Duration;

use tracing::{info, warn};
use uuid::Uuid;

/// What Docker answers when no subnet is left for a new network.
pub(crate) const ADDRESS_POOLS_EXHAUSTED: &str =
    "all predefined address pools have been fully subnetted";

/// Whether a failed Docker command ran out of address pools.
pub(crate) fn is_address_pool_exhaustion(text: &str) -> bool {
    text.to_ascii_lowercase().contains(ADDRESS_POOLS_EXHAUSTED)
}

/// Runs the Docker CLI. Tests replace it.
pub(crate) trait DockerCli {
    fn docker(&self, args: &[&str]) -> std::io::Result<Output>;
}

/// The node's own `docker`.
pub(crate) struct SystemDocker;

impl DockerCli for SystemDocker {
    fn docker(&self, args: &[&str]) -> std::io::Result<Output> {
        Command::new("docker").args(args).output()
    }
}

/// Which spaces no longer exist. Asked only while reclaiming address space.
pub trait SpaceDirectory: Send + Sync {
    /// Of `project_ids`, the ones whose space is deleted or no longer exists.
    /// A space this cannot vouch for (no answer, an error) is left out.
    fn gone(&self, project_ids: &[Uuid]) -> Vec<Uuid>;
}

/// No directory: no runtime is removed for its space, only unused networks.
pub struct NoSpaceDirectory;

impl SpaceDirectory for NoSpaceDirectory {
    fn gone(&self, _project_ids: &[Uuid]) -> Vec<Uuid> {
        Vec::new()
    }
}

/// The controller as a [`SpaceDirectory`]: `GET /projects/{id}` with the
/// provider's service credential. A 404 or 410, or a space whose status is
/// `deleted`, is gone; any other answer keeps the runtime.
pub struct ControllerSpaceDirectory {
    base_url: String,
    token: String,
}

impl ControllerSpaceDirectory {
    /// The controller this provider registers with (`CONTROLLER_URL`), or
    /// the one its runtimes call (`CONTROLLER_BASE_URL`,
    /// `PROXY_CONTROLLER_BASE_URL`), with the credential it registers with.
    /// `None` without both.
    pub fn from_env() -> Option<Self> {
        let read = |key: &str| {
            std::env::var(key)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let base_url = read("CONTROLLER_URL")
            .or_else(|| read("CONTROLLER_BASE_URL"))
            .or_else(|| read("PROXY_CONTROLLER_BASE_URL"))?;
        let token = read("CONTROLLER_SERVICE_ROLE_KEY")
            .or_else(|| read("SUPABASE_SERVICE_ROLE_KEY"))
            .or_else(|| read("CONTROLLER_INTERNAL_TOKEN"))?;
        Some(Self {
            base_url: reachable_from_this_process(&base_url),
            token,
        })
    }
}

/// A runtime's controller URL names the host gateway (`host.docker.internal`)
/// when the controller runs on this node. A provider running on the node
/// itself, outside any container, may not resolve that name; it reaches the
/// same controller on loopback.
fn reachable_from_this_process(base_url: &str) -> String {
    let base_url = base_url.trim_end_matches('/').to_string();
    let Ok(mut url) = reqwest::Url::parse(&base_url) else {
        return base_url;
    };
    if url.host_str() != Some("host.docker.internal") {
        return base_url;
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let resolves = std::net::ToSocketAddrs::to_socket_addrs(&("host.docker.internal", port))
        .map(|mut addresses| addresses.next().is_some())
        .unwrap_or(false);
    if resolves || url.set_host(Some("127.0.0.1")).is_err() {
        return base_url;
    }
    url.as_str().trim_end_matches('/').to_string()
}

impl SpaceDirectory for ControllerSpaceDirectory {
    fn gone(&self, project_ids: &[Uuid]) -> Vec<Uuid> {
        let Ok(client) = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
        else {
            return Vec::new();
        };
        project_ids
            .iter()
            .copied()
            .filter(|project_id| {
                let response = client
                    .get(format!("{}/projects/{project_id}", self.base_url))
                    .bearer_auth(&self.token)
                    .send();
                match response {
                    Ok(response) => {
                        let status = response.status().as_u16();
                        if status == 404 || status == 410 {
                            return true;
                        }
                        response.status().is_success()
                            && response
                                .json::<serde_json::Value>()
                                .ok()
                                .and_then(|body| {
                                    body.get("status")
                                        .and_then(|status| status.as_str())
                                        .map(|status| status.eq_ignore_ascii_case("deleted"))
                                })
                                .unwrap_or(false)
                    }
                    Err(error) => {
                        warn!(%project_id, %error, "could not ask the controller whether a space still exists");
                        false
                    }
                }
            })
            .collect()
    }
}

/// What a reclaim removed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct ReclaimedAddressSpace {
    /// Compose projects of spaces that are gone.
    pub(crate) projects: Vec<String>,
    /// Runtime networks, the removed projects' among them.
    pub(crate) networks: Vec<String>,
}

/// The project id of a runtime compose project name: exactly
/// `<prefix><32 hex>-<8 hex>`.
pub(crate) fn runtime_compose_project(prefix: &str, name: &str) -> Option<Uuid> {
    let rest = name.strip_prefix(prefix)?;
    let (simple, runtime) = rest.split_once('-')?;
    let hex = |value: &str, len: usize| {
        value.len() == len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    if !hex(simple, 32) || !hex(runtime, 8) {
        return None;
    }
    Uuid::try_parse(simple).ok()
}

/// The compose project of a runtime network name: exactly
/// `<runtime compose project>_default`.
fn runtime_network_project<'a>(prefix: &str, name: &'a str) -> Option<&'a str> {
    let project = name.strip_suffix("_default")?;
    runtime_compose_project(prefix, project).map(|_| project)
}

fn stdout_lines(output: &Output) -> Vec<String> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn run_listing(cli: &dyn DockerCli, args: &[&str]) -> anyhow::Result<Vec<String>> {
    let output = cli.docker(args)?;
    anyhow::ensure!(
        output.status.success(),
        "docker {} failed: {}",
        args.first().copied().unwrap_or_default(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(stdout_lines(&output))
}

/// Remove the runtimes of gone spaces and the runtime networks nothing uses
/// (see the module docs). `starting` is the compose project being started,
/// which is never touched. A removal that fails is logged and skipped.
pub(crate) fn reclaim_runtime_address_space(
    cli: &dyn DockerCli,
    prefix: &str,
    starting: &str,
    spaces: &dyn SpaceDirectory,
) -> anyhow::Result<ReclaimedAddressSpace> {
    let mut reclaimed = ReclaimedAddressSpace::default();

    // Runtime compose projects on the node, with their containers.
    let mut projects: BTreeMap<String, (Uuid, Vec<String>)> = BTreeMap::new();
    for line in run_listing(
        cli,
        &[
            "ps",
            "-a",
            "--filter",
            "label=com.docker.compose.project",
            "--format",
            "{{.ID}}\t{{.Label \"com.docker.compose.project\"}}",
        ],
    )? {
        let Some((id, project)) = line.split_once('\t') else {
            continue;
        };
        let (id, project) = (id.trim(), project.trim());
        if id.is_empty() || project == starting {
            continue;
        }
        if let Some(project_id) = runtime_compose_project(prefix, project) {
            projects
                .entry(project.to_string())
                .or_insert_with(|| (project_id, Vec::new()))
                .1
                .push(id.to_string());
        }
    }

    let mut space_ids: Vec<Uuid> = projects.values().map(|(id, _)| *id).collect();
    space_ids.sort();
    space_ids.dedup();
    let gone = if space_ids.is_empty() {
        Vec::new()
    } else {
        spaces.gone(&space_ids)
    };
    for (project, (project_id, containers)) in &projects {
        if !gone.contains(project_id) {
            continue;
        }
        let mut args = vec!["rm", "-f"];
        args.extend(containers.iter().map(String::as_str));
        match cli.docker(&args) {
            Ok(output) if output.status.success() => {
                info!(%project_id, %project, "removed the runtime of a space that no longer exists");
                reclaimed.projects.push(project.clone());
            }
            Ok(output) => warn!(
                %project,
                error = %String::from_utf8_lossy(&output.stderr).trim(),
                "could not remove the runtime of a space that no longer exists"
            ),
            Err(error) => {
                warn!(%project, %error, "could not remove the runtime of a space that no longer exists")
            }
        }
    }

    // Runtime networks no container is attached to, the removed projects'
    // among them.
    for network in run_listing(
        cli,
        &[
            "network",
            "ls",
            "--filter",
            &format!("name={prefix}"),
            "--format",
            "{{.Name}}",
        ],
    )? {
        let Some(project) = runtime_network_project(prefix, &network) else {
            continue;
        };
        if project == starting {
            continue;
        }
        let attached = match cli.docker(&[
            "network",
            "inspect",
            "--format",
            "{{len .Containers}}",
            &network,
        ]) {
            Ok(output) if output.status.success() => stdout_lines(&output)
                .first()
                .and_then(|count| count.parse::<usize>().ok()),
            _ => None,
        };
        if attached != Some(0) {
            continue;
        }
        match cli.docker(&["network", "rm", &network]) {
            Ok(output) if output.status.success() => reclaimed.networks.push(network),
            Ok(output) => warn!(
                %network,
                error = %String::from_utf8_lossy(&output.stderr).trim(),
                "could not remove an unused runtime network"
            ),
            Err(error) => warn!(%network, %error, "could not remove an unused runtime network"),
        }
    }

    Ok(reclaimed)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;
    use std::sync::Mutex;

    /// A Docker that answers from a fixed node and records what it was asked.
    #[derive(Default)]
    pub(crate) struct FakeDocker {
        /// `(container id, compose project, network)`.
        pub(crate) containers: Mutex<Vec<(String, String, String)>>,
        pub(crate) networks: Mutex<Vec<String>>,
        pub(crate) calls: Mutex<Vec<Vec<String>>>,
    }

    fn output(code: i32, stdout: String) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.into_bytes(),
            stderr: Vec::new(),
        }
    }

    impl DockerCli for FakeDocker {
        fn docker(&self, args: &[&str]) -> std::io::Result<Output> {
            self.calls
                .lock()
                .unwrap()
                .push(args.iter().map(|arg| arg.to_string()).collect());
            let mut containers = self.containers.lock().unwrap();
            let mut networks = self.networks.lock().unwrap();
            Ok(match args {
                ["ps", "-a", ..] => output(
                    0,
                    containers
                        .iter()
                        .map(|(id, project, _)| format!("{id}\t{project}\n"))
                        .collect(),
                ),
                ["rm", "-f", ids @ ..] => {
                    containers.retain(|(id, _, _)| !ids.contains(&id.as_str()));
                    output(0, String::new())
                }
                ["network", "ls", "--filter", filter, ..] => {
                    let name = filter.trim_start_matches("name=");
                    output(
                        0,
                        networks
                            .iter()
                            .filter(|network| network.contains(name))
                            .map(|network| format!("{network}\n"))
                            .collect(),
                    )
                }
                ["network", "inspect", "--format", _, network] => output(
                    0,
                    format!(
                        "{}\n",
                        containers
                            .iter()
                            .filter(|(_, _, attached)| attached == network)
                            .count()
                    ),
                ),
                ["network", "rm", network] => {
                    if containers
                        .iter()
                        .any(|(_, _, attached)| attached == network)
                    {
                        output(1, String::new())
                    } else {
                        networks.retain(|existing| existing != network);
                        output(0, String::new())
                    }
                }
                _ => output(1, String::new()),
            })
        }
    }

    struct Gone(Vec<Uuid>);

    impl SpaceDirectory for Gone {
        fn gone(&self, project_ids: &[Uuid]) -> Vec<Uuid> {
            project_ids
                .iter()
                .filter(|id| self.0.contains(id))
                .copied()
                .collect()
        }
    }

    pub(crate) fn runtime_project(prefix: &str, project: Uuid) -> String {
        format!(
            "{prefix}{}-{}",
            project.simple(),
            &Uuid::new_v4().simple().to_string()[..8]
        )
    }

    #[test]
    fn only_runtime_shaped_names_are_runtime_projects() {
        let project = Uuid::new_v4();
        let name = runtime_project("instafy-runtime-", project);
        assert_eq!(
            runtime_compose_project("instafy-runtime-", &name),
            Some(project)
        );
        for other in [
            "instafy-runtime",
            "instafy-runtime-proxy",
            "neighbour-origin",
            &format!("instafy-runtime-{}", project.simple()),
            &format!("instafy-runtime-{}-abc", project.simple()),
            &format!("instafy-runtime-{}-abcdefgh", project.simple()),
            &format!("other-{}-abcdef01", project.simple()),
        ] {
            assert_eq!(
                runtime_compose_project("instafy-runtime-", other),
                None,
                "{other}"
            );
        }
        assert_eq!(
            runtime_network_project("instafy-runtime-", &format!("{name}_default")),
            Some(name.as_str())
        );
        assert_eq!(
            runtime_network_project("instafy-runtime-", "instafy-runtime_default"),
            None
        );
    }

    #[test]
    fn exhaustion_is_read_from_dockers_answer() {
        assert!(is_address_pool_exhaustion(
            "failed to create network x_default: Error response from daemon: all predefined address pools have been fully subnetted"
        ));
        assert!(!is_address_pool_exhaustion("port is already allocated"));
    }

    /// The runtimes of deleted spaces and unused runtime networks go; a live
    /// space's runtime, the runtime being started and every other project's
    /// containers and networks stay.
    #[test]
    fn reclaim_frees_only_what_no_space_needs() {
        let prefix = "instafy-runtime-";
        let (deleted, live) = (Uuid::new_v4(), Uuid::new_v4());
        let deleted_project = runtime_project(prefix, deleted);
        let live_project = runtime_project(prefix, live);
        let starting = runtime_project(prefix, live);
        let leftover = runtime_project(prefix, Uuid::new_v4());
        let net = |project: &str| format!("{project}_default");
        let docker = FakeDocker::default();
        *docker.containers.lock().unwrap() = vec![
            ("c1".into(), deleted_project.clone(), net(&deleted_project)),
            ("c2".into(), deleted_project.clone(), net(&deleted_project)),
            ("c3".into(), live_project.clone(), net(&live_project)),
            (
                "c4".into(),
                "instafy-runtime".into(),
                "instafy-runtime_default".into(),
            ),
            (
                "c5".into(),
                "neighbour-origin".into(),
                "neighbour-origin_default".into(),
            ),
        ];
        *docker.networks.lock().unwrap() = vec![
            net(&deleted_project),
            net(&live_project),
            net(&leftover),
            net(&starting),
            "instafy-runtime_default".into(),
            "instafy-runtime-unrelated".into(),
            "neighbour-origin_default".into(),
        ];

        let reclaimed =
            reclaim_runtime_address_space(&docker, prefix, &starting, &Gone(vec![deleted]))
                .expect("reclaim");

        assert_eq!(reclaimed.projects, vec![deleted_project.clone()]);
        let mut removed = reclaimed.networks.clone();
        removed.sort();
        let mut expected = vec![net(&deleted_project), net(&leftover)];
        expected.sort();
        assert_eq!(removed, expected);
        let containers: Vec<String> = docker
            .containers
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _, _)| id.clone())
            .collect();
        assert_eq!(containers, vec!["c3", "c4", "c5"]);
        let networks = docker.networks.lock().unwrap().clone();
        assert_eq!(
            networks,
            vec![
                net(&live_project),
                net(&starting),
                "instafy-runtime_default".to_string(),
                "instafy-runtime-unrelated".to_string(),
                "neighbour-origin_default".to_string(),
            ]
        );
    }

    /// Without a directory no runtime is removed, only unused networks.
    #[test]
    fn without_a_directory_only_unused_networks_go() {
        let prefix = "instafy-runtime-";
        let project = runtime_project(prefix, Uuid::new_v4());
        let leftover = runtime_project(prefix, Uuid::new_v4());
        let docker = FakeDocker::default();
        *docker.containers.lock().unwrap() =
            vec![("c1".into(), project.clone(), format!("{project}_default"))];
        *docker.networks.lock().unwrap() =
            vec![format!("{project}_default"), format!("{leftover}_default")];

        let reclaimed =
            reclaim_runtime_address_space(&docker, prefix, "none", &NoSpaceDirectory).unwrap();

        assert!(reclaimed.projects.is_empty());
        assert_eq!(reclaimed.networks, vec![format!("{leftover}_default")]);
        assert_eq!(docker.containers.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_runtime_controller_url_on_the_host_gateway_is_reached_on_loopback_when_unresolved() {
        let rewritten = reachable_from_this_process("http://host.docker.internal:8788/");
        // Either this machine resolves the gateway name, or it is loopback.
        assert!(
            rewritten == "http://host.docker.internal:8788" || rewritten == "http://127.0.0.1:8788",
            "{rewritten}"
        );
        assert_eq!(
            reachable_from_this_process("https://controller.example.com/"),
            "https://controller.example.com"
        );
    }
}
