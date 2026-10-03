//! What a node holds for its hosted runtimes: the runtime containers it runs
//! (or keeps stopped) and the workspace checkouts on its disk. A drain reads
//! it before the node is retired, because a deleted node takes every
//! container and checkout with it, including work that exists nowhere else.
//!
//! Read-only, and like checkout eviction it reads refs and the clean-stop
//! marker from the files git keeps them in, without running git. Every list
//! is bounded; a census cut at a bound says so (`truncated`), and a drain
//! must not treat it as complete.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use uuid::Uuid;

use super::checkout_eviction::{pending_local_recovery, stopped_cleanly, PendingRecovery};

/// At most this many runtime containers are listed.
pub(crate) const MAX_CENSUS_CONTAINERS: usize = 1_000;
/// At most this many checkouts are listed.
pub(crate) const MAX_CENSUS_CHECKOUTS: usize = 5_000;
/// At most this many unpushed ref names are listed per checkout.
const MAX_REF_NAMES: usize = 50;
const LOCAL_RECOVERY_PREFIX: &str = "refs/instafy/local-recovery/";

/// The node's runtimes and checkouts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCensus {
    /// This allocator can list its node. `false` means the lists below say
    /// nothing about the node (not that it is empty).
    pub supported: bool,
    /// One entry per runtime (compose project), running or stopped.
    pub containers: Vec<CensusContainer>,
    pub checkouts: Vec<CensusCheckout>,
    /// A list reached its bound: the census is incomplete.
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

/// One workspace checkout on the node's disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CensusCheckout {
    pub project_id: Uuid,
    /// A runtime container of the project exists here, running or stopped.
    pub runtime_present: bool,
    /// The runtime that last used it stopped cleanly (its shutdown flush
    /// kept everything and wrote the clean-stop marker).
    pub stopped_cleanly: bool,
    /// Local recovery refs no push has confirmed yet.
    pub unpushed_refs: usize,
    /// Their names (under `refs/instafy/local-recovery/`), at most 50.
    pub unpushed_ref_names: Vec<String>,
    /// Why its refs could not be read with certainty, if they could not.
    pub unreadable: Option<String>,
    /// The directory holds nothing: no runtime ever used it.
    pub empty: bool,
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

/// The checkouts under `repo_base` (directories named by a project id).
/// Returns them and whether the listing reached its bound.
pub(crate) fn census_checkouts(
    repo_base: &Path,
    present: &HashSet<Uuid>,
) -> (Vec<CensusCheckout>, bool) {
    let Ok(entries) = fs::read_dir(repo_base) else {
        return (Vec::new(), false);
    };
    let mut checkouts = Vec::new();
    for entry in entries.flatten() {
        let Some(project_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| Uuid::parse_str(name).ok())
        else {
            continue;
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        if checkouts.len() >= MAX_CENSUS_CHECKOUTS {
            return (checkouts, true);
        }
        let path = entry.path();
        let empty = fs::read_dir(&path).is_ok_and(|mut inner| inner.next().is_none());
        let (unpushed, unreadable) = if empty {
            (Vec::new(), None)
        } else {
            match pending_local_recovery(&path) {
                PendingRecovery::None => (Vec::new(), None),
                PendingRecovery::Refs(refs) => (refs, None),
                PendingRecovery::Unknown(why) => (Vec::new(), Some(why)),
            }
        };
        checkouts.push(CensusCheckout {
            project_id,
            runtime_present: present.contains(&project_id),
            stopped_cleanly: stopped_cleanly(&path),
            unpushed_refs: unpushed.len(),
            unpushed_ref_names: unpushed
                .iter()
                .take(MAX_REF_NAMES)
                .map(|reference| {
                    reference
                        .strip_prefix(LOCAL_RECOVERY_PREFIX)
                        .unwrap_or(reference)
                        .to_string()
                })
                .collect(),
            unreadable,
            empty,
        });
    }
    checkouts.sort_by_key(|checkout| checkout.project_id);
    (checkouts, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allocator::checkout_eviction::CLEAN_STOP_MARKER;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("runtime-census-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn canonical_checkout(base: &Path, project_id: Uuid, clean: bool) -> PathBuf {
        let root = base.join(project_id.to_string());
        let git_dir = root.join(".instafy/.git");
        fs::create_dir_all(git_dir.join("refs/heads")).unwrap();
        fs::write(
            git_dir.join("config"),
            "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://git.example/p.git\n",
        )
        .unwrap();
        fs::write(root.join("README.md"), b"hello\n").unwrap();
        if clean {
            fs::write(root.join(CLEAN_STOP_MARKER), b"stopped\n").unwrap();
        }
        root
    }

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
                ContainerFacts {
                    compose_project: name.clone(),
                    running: false,
                    env: vec!["PATH=/usr/bin".to_string()],
                },
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
    fn checkouts_report_unpushed_refs_clean_stops_and_what_cannot_be_read() {
        let base = TempDir::new();
        let clean = Uuid::new_v4();
        canonical_checkout(&base.0, clean, true);
        let unpushed = Uuid::new_v4();
        let root = canonical_checkout(&base.0, unpushed, true);
        fs::create_dir_all(root.join(".instafy/.git/refs/instafy/local-recovery")).unwrap();
        fs::write(
            root.join(".instafy/.git/refs/instafy/local-recovery/20261003T101010Z-unsaved-abc"),
            "0123456789012345678901234567890123456789\n",
        )
        .unwrap();
        let crashed = Uuid::new_v4();
        canonical_checkout(&base.0, crashed, false);
        let no_git = Uuid::new_v4();
        fs::create_dir_all(base.0.join(no_git.to_string())).unwrap();
        fs::write(base.0.join(no_git.to_string()).join("notes.md"), b"x\n").unwrap();
        let empty = Uuid::new_v4();
        fs::create_dir_all(base.0.join(empty.to_string())).unwrap();
        fs::create_dir_all(base.0.join(".instafy-checkout-stamps")).unwrap();

        let (checkouts, truncated) = census_checkouts(&base.0, &HashSet::from([crashed]));
        assert!(!truncated);
        let by_id: BTreeMap<Uuid, CensusCheckout> = checkouts
            .into_iter()
            .map(|checkout| (checkout.project_id, checkout))
            .collect();
        assert_eq!(by_id.len(), 5, "{by_id:?}");
        let entry = &by_id[&clean];
        assert!(entry.stopped_cleanly && entry.unpushed_refs == 0 && entry.unreadable.is_none());
        assert!(!entry.runtime_present && !entry.empty);
        let entry = &by_id[&unpushed];
        assert_eq!(entry.unpushed_refs, 1);
        assert_eq!(
            entry.unpushed_ref_names,
            vec!["20261003T101010Z-unsaved-abc".to_string()]
        );
        let entry = &by_id[&crashed];
        assert!(!entry.stopped_cleanly && entry.runtime_present);
        let entry = &by_id[&no_git];
        assert!(entry.unreadable.is_some(), "{entry:?}");
        let entry = &by_id[&empty];
        assert!(entry.empty && entry.unreadable.is_none() && entry.unpushed_refs == 0);
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
