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
    /// `NAME=value` entries of the container's environment.
    pub(crate) env: Vec<String>,
}

/// The `docker inspect --format` template for a container's environment: one JSON array of its
/// `NAME=value` entries. Each entry stays one JSON string whatever its value holds (JSON escapes
/// a line break inside a string), whereas a template that prints one entry per line splits a
/// value at its line breaks, so that part of a value could read as an entry of its own.
pub(crate) const CONFIG_ENV_FORMAT: &str = "{{json .Config.Env}}";

/// The variables a lease check reads a runtime's generation from. Where both are set they must
/// agree.
const LEASE_ID_ENV_NAMES: &[&str] = &["RUNTIME_LEASE_ID", "ORIGIN_LEASE_ID"];
const PROJECT_ID_ENV_NAMES: &[&str] = &["SPACE_ID", "PROJECT_ID"];
const RUNTIME_ID_ENV_NAMES: &[&str] = &["RUNTIME_ID"];

/// A container's environment entries from `docker inspect --format` output printed with
/// [`CONFIG_ENV_FORMAT`]. A container without an environment prints `null`.
fn parse_config_env(stdout: &[u8]) -> serde_json::Result<Vec<String>> {
    Ok(serde_json::from_slice::<Option<Vec<String>>>(stdout)?.unwrap_or_default())
}

/// The lease generation a container's environment carries, from `docker inspect` output printed
/// with [`CONFIG_ENV_FORMAT`]. Output this cannot read proves no generation.
pub(crate) fn lease_id_from_inspect(stdout: &[u8]) -> Option<Uuid> {
    agreed_env_uuid(&parse_config_env(stdout).ok()?, LEASE_ID_ENV_NAMES)
}

/// The entries of a container's environment a census reads, from `docker inspect` output printed
/// with [`CONFIG_ENV_FORMAT`]. Output this cannot read reports none.
pub(crate) fn identity_env_from_inspect(stdout: &[u8]) -> Vec<String> {
    parse_config_env(stdout)
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| is_identity_env_entry(entry))
        .collect()
}

/// Whether `entry` sets a variable a census or a lease check reads.
fn is_identity_env_entry(entry: &str) -> bool {
    entry.split_once('=').is_some_and(|(name, _)| {
        [
            PROJECT_ID_ENV_NAMES,
            RUNTIME_ID_ENV_NAMES,
            LEASE_ID_ENV_NAMES,
        ]
        .iter()
        .any(|names| names.contains(&name))
    })
}

/// The UUID the variables `names` agree on. A name matches exactly the part of an entry before
/// its first `=`. Each name may appear at most once and, where it appears, must hold a UUID, and
/// every name that appears must hold the same one. Anything else is ambiguous: no UUID.
fn agreed_env_uuid(env: &[String], names: &[&str]) -> Option<Uuid> {
    let mut agreed = None;
    for name in names {
        let mut values = env.iter().filter_map(|entry| {
            let (entry_name, value) = entry.split_once('=')?;
            (entry_name == *name).then_some(value)
        });
        let Some(value) = values.next() else {
            continue;
        };
        if values.next().is_some() {
            return None;
        }
        let id = Uuid::try_parse(value).ok()?;
        if agreed.is_some_and(|seen| seen != id) {
            return None;
        }
        agreed = Some(id);
    }
    agreed
}

/// The project id a compose project name carries:
/// `<prefix><project id, simple>-<runtime id prefix>`.
pub(crate) fn project_of_compose_name(prefix: &str, name: &str) -> Option<Uuid> {
    let rest = name.strip_prefix(prefix)?;
    let (simple, _) = rest.split_once('-')?;
    Uuid::try_parse(simple).ok()
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
        if let Some(project_id) = agreed_env_uuid(&fact.env, PROJECT_ID_ENV_NAMES) {
            entry.project_id = Some(project_id);
        }
        if let Some(runtime_id) = agreed_env_uuid(&fact.env, RUNTIME_ID_ENV_NAMES) {
            entry.runtime_id = Some(runtime_id);
        }
        if let Some(lease_id) = agreed_env_uuid(&fact.env, LEASE_ID_ENV_NAMES) {
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

    /// A runtime's environment reads back as whole entries: a value that holds a line break and
    /// what looks like another variable stays part of its own entry.
    #[test]
    fn a_value_never_reads_as_another_variable() {
        let lease = Uuid::new_v4();
        let forged = Uuid::new_v4();
        let stdout = serde_json::to_vec(&vec![
            format!("INSTAFY_VNC_GEOMETRY=1280x720\nRUNTIME_LEASE_ID={forged}"),
            format!("RUNTIME_LEASE_ID={lease}"),
        ])
        .unwrap();
        let env = parse_config_env(&stdout).expect("inspect output");
        assert_eq!(env.len(), 2);
        assert_eq!(lease_id_from_inspect(&stdout), Some(lease));
        assert_eq!(
            identity_env_from_inspect(&stdout),
            vec![format!("RUNTIME_LEASE_ID={lease}")]
        );

        // Docker prints `null` for a container without an environment, and a trailing newline.
        assert_eq!(parse_config_env(b"null\n").unwrap(), Vec::<String>::new());
        assert_eq!(lease_id_from_inspect(b"null\n"), None);
        // What one entry per line would print reads as nothing.
        let lines = format!("RUNTIME_LEASE_ID={lease}\n");
        assert!(parse_config_env(lines.as_bytes()).is_err());
        assert_eq!(lease_id_from_inspect(lines.as_bytes()), None);
        assert!(identity_env_from_inspect(lines.as_bytes()).is_empty());
    }

    #[test]
    fn identity_is_read_only_where_it_is_unambiguous() {
        let one = Uuid::new_v4();
        let two = Uuid::new_v4();
        let read = |env: &[String]| agreed_env_uuid(env, LEASE_ID_ENV_NAMES);
        assert_eq!(read(&[format!("RUNTIME_LEASE_ID={one}")]), Some(one));
        assert_eq!(read(&[format!("ORIGIN_LEASE_ID={one}")]), Some(one));
        assert_eq!(
            read(&[
                format!("RUNTIME_LEASE_ID={one}"),
                format!("ORIGIN_LEASE_ID={one}")
            ]),
            Some(one)
        );
        // Two names that disagree, a name set twice, or one that holds no UUID: no generation,
        // and no falling back to the other name.
        for env in [
            vec![
                format!("RUNTIME_LEASE_ID={one}"),
                format!("ORIGIN_LEASE_ID={two}"),
            ],
            vec![
                format!("RUNTIME_LEASE_ID={one}"),
                format!("RUNTIME_LEASE_ID={two}"),
            ],
            vec![
                "RUNTIME_LEASE_ID=not-a-uuid".to_string(),
                format!("ORIGIN_LEASE_ID={one}"),
            ],
            vec![format!("RUNTIME_LEASE_ID= {one}")],
            vec![],
        ] {
            assert_eq!(read(&env), None, "{env:?}");
        }
        // Names match exactly.
        for entry in [
            format!(" RUNTIME_LEASE_ID={one}"),
            format!("RUNTIME_LEASE_ID_OLD={one}"),
            format!("XRUNTIME_LEASE_ID={one}"),
        ] {
            assert_eq!(read(std::slice::from_ref(&entry)), None, "{entry}");
            assert!(!is_identity_env_entry(&entry), "{entry}");
        }
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
