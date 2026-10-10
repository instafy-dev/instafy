//! What a node holds for its hosted runtimes: the runtime containers it runs
//! (or keeps stopped). A drain reads it before the node is retired, so that
//! no live runtime runs into the node's deletion. Workspace checkouts are no
//! part of it: canonical git holds their work, and a checkout on the node is
//! a cache the next start clones again.
//!
//! Read-only. The container list is bounded; a census cut at the bound says
//! so (`truncated`), and a drain must not treat it as complete.

use std::collections::BTreeMap;

use serde::Serialize;
use uuid::Uuid;

/// At most this many runtime containers are listed.
pub(crate) const MAX_CENSUS_CONTAINERS: usize = 1_000;

/// The node's runtimes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCensus {
    /// This allocator can list its node. `false` means the list below says
    /// nothing about the node (not that it is empty).
    pub supported: bool,
    /// One entry per runtime (compose project), running or stopped.
    pub containers: Vec<CensusContainer>,
    /// The container list reached its bound: the census is incomplete.
    pub truncated: bool,
}

/// One runtime on the node, as its containers describe it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CensusContainer {
    pub compose_project: String,
    pub project_id: Option<Uuid>,
    pub runtime_id: Option<Uuid>,
    /// The runtime lease generation the containers were started for.
    pub lease_id: Option<Uuid>,
    /// At least one of its containers is running.
    pub running: bool,
}

/// One container, as `docker ps` and `docker inspect` describe it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ContainerFacts {
    pub(crate) compose_project: String,
    pub(crate) running: bool,
    /// `KEY=value` lines of the container's environment.
    pub(crate) env: Vec<String>,
}

/// The project id a compose project name carries:
/// `<prefix><project id, simple>-<runtime id prefix>`.
pub(crate) fn project_of_compose_name(prefix: &str, name: &str) -> Option<Uuid> {
    let rest = name.strip_prefix(prefix)?;
    let (simple, _) = rest.split_once('-')?;
    Uuid::try_parse(simple).ok()
}

fn env_uuid(env: &[String], keys: &[&str]) -> Option<Uuid> {
    keys.iter().find_map(|key| {
        let prefix = format!("{key}=");
        env.iter()
            .find_map(|line| line.trim().strip_prefix(&prefix))
            .and_then(|value| Uuid::parse_str(value.trim()).ok())
    })
}

/// Group containers into one entry per compose project under `prefix`.
/// Identity comes from the runtime container's environment (`SPACE_ID`,
/// `RUNTIME_ID`, `RUNTIME_LEASE_ID`), with the project id from the name as a
/// fallback for sidecars.
pub(crate) fn group_containers(prefix: &str, facts: Vec<ContainerFacts>) -> Vec<CensusContainer> {
    let mut grouped: BTreeMap<String, CensusContainer> = BTreeMap::new();
    for fact in facts {
        if !fact.compose_project.starts_with(prefix) {
            continue;
        }
        let entry = grouped
            .entry(fact.compose_project.clone())
            .or_insert_with(|| CensusContainer {
                compose_project: fact.compose_project.clone(),
                project_id: project_of_compose_name(prefix, &fact.compose_project),
                runtime_id: None,
                lease_id: None,
                running: false,
            });
        entry.running |= fact.running;
        if let Some(project_id) = env_uuid(&fact.env, &["SPACE_ID", "PROJECT_ID"]) {
            entry.project_id = Some(project_id);
        }
        if let Some(runtime_id) = env_uuid(&fact.env, &["RUNTIME_ID"]) {
            entry.runtime_id = Some(runtime_id);
        }
        if let Some(lease_id) = env_uuid(&fact.env, &["RUNTIME_LEASE_ID", "ORIGIN_LEASE_ID"]) {
            entry.lease_id = Some(lease_id);
        }
    }
    grouped.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtimes_are_grouped_by_compose_project_with_their_generation() {
        let prefix = "instafy-runtime-";
        let project = Uuid::new_v4();
        let runtime = Uuid::new_v4();
        let lease = Uuid::new_v4();
        let name = format!("{prefix}{}-{}", project.simple(), &runtime.to_string()[..8]);
        let other_project = Uuid::new_v4();
        let stopped = format!("{prefix}{}-abcdef01", other_project.simple());
        let grouped = group_containers(
            prefix,
            vec![
                // The runtime runs; a sidecar listed after it has exited.
                ContainerFacts {
                    compose_project: name.clone(),
                    running: true,
                    env: vec![
                        format!("SPACE_ID={project}"),
                        format!("RUNTIME_ID={runtime}"),
                        format!("RUNTIME_LEASE_ID={lease}"),
                    ],
                },
                ContainerFacts {
                    compose_project: name.clone(),
                    running: false,
                    env: vec!["PATH=/usr/bin".to_string()],
                },
                ContainerFacts {
                    compose_project: stopped.clone(),
                    running: false,
                    env: Vec::new(),
                },
                ContainerFacts {
                    compose_project: "someone-else-1".to_string(),
                    running: true,
                    env: Vec::new(),
                },
            ],
        );
        let mut expected = vec![
            CensusContainer {
                compose_project: name,
                project_id: Some(project),
                runtime_id: Some(runtime),
                lease_id: Some(lease),
                running: true,
            },
            CensusContainer {
                compose_project: stopped,
                project_id: Some(other_project),
                runtime_id: None,
                lease_id: None,
                running: false,
            },
        ];
        expected.sort_by(|a, b| a.compose_project.cmp(&b.compose_project));
        assert_eq!(grouped, expected);
    }

    #[test]
    fn compose_names_carry_the_project() {
        let project = Uuid::new_v4();
        assert_eq!(
            project_of_compose_name("p-", &format!("p-{}-0123abcd", project.simple())),
            Some(project)
        );
        assert_eq!(project_of_compose_name("p-", "q-whatever-1"), None);
        assert_eq!(project_of_compose_name("p-", "p-notauuid-1"), None);
    }
}
