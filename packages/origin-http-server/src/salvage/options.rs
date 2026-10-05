//! The salvage subcommand's flags and the settings it reads from the
//! gateway's environment.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use git_service::policy::{SALVAGE_GATEWAY_REF_ROOT, SALVAGE_REF_NAME_MAX_LEN};
use uuid::Uuid;

use crate::config::DEFAULT_GATEWAY_AUTHOR_EMAIL;
use crate::workspace_git::GitIdentity;

pub(crate) const USAGE: &str = "\
usage: origin-http-server salvage [--apply] [--remove] [--root <dir>] [--node <name>]
                                  [--project <id>]... [--ack <entry>]...

Keeps the work in the stateful gateway's parked working copies (<root>/.legacy/).
Without --apply nothing is pushed, exported or written under <root>/.salvage/:
each entry is classified and reported as one JSON line on stdout.

  --apply           push salvage refs, export chat images, and write the bundles,
                    private archives and report.jsonl under <root>/.salvage/
  --remove          also remove each entry whose work is on canonical (or that
                    was clean); only with --apply does anything get removed.
                    An entry with paths left out, a chat image a rerun may
                    still export, or a filtered history needs --ack
  --ack <entry>     remove this entry even without a canonical record
                    (repeatable; the entry's folder name under .legacy/)
  --root <dir>      the gateway's workspace root (default: ORIGIN_WORKSPACE_ROOT)
  --node <name>     this gateway's name in salvage refs (default: INSTAFY_NODE_NAME,
                    else the host name); lower-cased
  --project <id>    only the entries of this space (repeatable)

Environment: ORIGIN_GIT_REMOTE_BASE_URL (required), ORIGIN_CONTROLLER_URL,
ORIGIN_INTERNAL_TOKEN, ORIGIN_GIT_AUTHOR_NAME, ORIGIN_GIT_AUTHOR_EMAIL.

Exit status: 0 when every entry was handled, 1 when an entry failed, was not
removed, or has a chat image a rerun may still export, 2 for a usage or
configuration error.";

/// The flags as given.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Flags {
    pub help: bool,
    pub apply: bool,
    pub remove: bool,
    pub root: Option<PathBuf>,
    pub node: Option<String>,
    pub projects: Vec<Uuid>,
    pub acks: Vec<String>,
}

/// Parse the arguments after `salvage`.
pub(crate) fn parse_flags(args: &[String]) -> Result<Flags> {
    let mut flags = Flags::default();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = |flag: &str| -> Result<String> {
            match inline.clone() {
                Some(value) => Ok(value),
                None => rest
                    .next()
                    .cloned()
                    .with_context(|| format!("{flag} needs a value")),
            }
        };
        match name {
            "-h" | "--help" => flags.help = true,
            "--apply" => flags.apply = true,
            "--remove" => flags.remove = true,
            "--root" => flags.root = Some(PathBuf::from(value("--root")?)),
            "--node" => flags.node = Some(value("--node")?),
            "--project" => {
                let raw = value("--project")?;
                let id = Uuid::parse_str(raw.trim())
                    .with_context(|| format!("--project {raw:?} is not a space id"))?;
                flags.projects.push(id);
            }
            "--ack" => {
                let entry = value("--ack")?;
                if entry.trim().is_empty() || entry.contains('/') {
                    bail!("--ack takes an entry name under .legacy/, not {entry:?}");
                }
                flags.acks.push(entry.trim().to_string());
            }
            other => bail!("unknown argument {other:?}"),
        }
        if matches!(name, "-h" | "--help" | "--apply" | "--remove") && inline.is_some() {
            bail!("{name} takes no value");
        }
    }
    Ok(flags)
}

/// Everything one run needs, resolved from the flags and the environment.
#[derive(Clone, Debug)]
pub(crate) struct Settings {
    /// The workspace root, canonical.
    pub root: PathBuf,
    /// This gateway's name in salvage refs: lower case, checked.
    pub node: String,
    pub apply: bool,
    pub remove: bool,
    pub projects: Vec<Uuid>,
    pub acks: Vec<String>,
    /// `ORIGIN_GIT_REMOTE_BASE_URL` without a trailing `/`; a space's
    /// canonical repository is `<base>/<id>.git`.
    pub remote_base: String,
    /// The gateway's own identity, which salvage commits are made under.
    pub identity: GitIdentity,
}

impl Settings {
    pub(crate) fn from_flags(flags: &Flags, env: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let root = flags
            .root
            .clone()
            .or_else(|| env("ORIGIN_WORKSPACE_ROOT").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."));
        let root = root
            .canonicalize()
            .with_context(|| format!("workspace root {root:?} is not readable"))?;
        let node = match flags.node.clone().or_else(|| env("INSTAFY_NODE_NAME")) {
            Some(node) => node,
            None => host_name()
                .context("this host has no readable name: pass --node or set INSTAFY_NODE_NAME")?,
        };
        let node = node_name(&node)?;
        let remote_base = env("ORIGIN_GIT_REMOTE_BASE_URL")
            .map(|base| base.trim().trim_end_matches('/').to_string())
            .filter(|base| !base.is_empty())
            .context("ORIGIN_GIT_REMOTE_BASE_URL must name the canonical repositories")?;
        let identity = GitIdentity::new(
            env("ORIGIN_GIT_AUTHOR_NAME").unwrap_or_else(|| "instafy-origin".to_string()),
            env("ORIGIN_GIT_AUTHOR_EMAIL")
                .unwrap_or_else(|| DEFAULT_GATEWAY_AUTHOR_EMAIL.to_string()),
        );
        Ok(Self {
            root,
            node,
            apply: flags.apply,
            remove: flags.remove,
            projects: flags.projects.clone(),
            acks: flags.acks.clone(),
            remote_base,
            identity,
        })
    }

    /// The canonical repository of a space.
    pub(crate) fn remote_url(&self, project: &Uuid) -> String {
        format!("{}/{}.git", self.remote_base, project.as_hyphenated())
    }

    pub(crate) fn legacy_dir(&self) -> PathBuf {
        self.root.join(crate::hosted::LEGACY_DIR)
    }

    pub(crate) fn salvage_dir(&self) -> PathBuf {
        self.root.join(SALVAGE_DIR)
    }
}

/// Where the salvage keeps bundles, private archives and its report, under
/// the workspace root. Not a space id, so no gateway image reads it.
pub(crate) const SALVAGE_DIR: &str = ".salvage";

/// Room a salvage ref name leaves for the node: `<node>-<8 hex>`.
const MAX_NODE_LEN: usize = SALVAGE_REF_NAME_MAX_LEN - 9;

/// `raw` as a salvage ref's node name: lower-cased, then `[0-9a-z]` followed
/// by `[0-9a-z._-]`, no `..`, and short enough that `<node>-<8 hex>` fits the
/// shard's salvage name rule.
pub(crate) fn node_name(raw: &str) -> Result<String> {
    let node = raw.trim().to_ascii_lowercase();
    let starts_well = node
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase());
    let rest_ok = node.bytes().all(|byte| {
        byte.is_ascii_digit() || byte.is_ascii_lowercase() || matches!(byte, b'.' | b'_' | b'-')
    });
    if !starts_well || !rest_ok || node.contains("..") || node.len() > MAX_NODE_LEN {
        bail!(
            "node name {raw:?} must start with a letter or digit, hold only letters, digits, \
             '.', '_' and '-', and be at most {MAX_NODE_LEN} characters: pass --node"
        );
    }
    // The name a salvage ref gets must pass the shard's rule.
    let probe = format!("{SALVAGE_GATEWAY_REF_ROOT}/{node}-0123abcd");
    if !git_service::policy::is_salvage_ref_name(&probe) {
        bail!("node name {raw:?} does not make a valid salvage ref name: pass --node");
    }
    Ok(node)
}

/// The host's name, as the kernel reports it.
fn host_name() -> Option<String> {
    for file in ["/proc/sys/kernel/hostname", "/etc/hostname"] {
        if let Ok(text) = std::fs::read_to_string(Path::new(file)) {
            let name = text.trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    std::env::var("HOSTNAME")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn flags_are_parsed_and_unknown_ones_refused() {
        let id = "0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60";
        let flags = parse_flags(&args(&[
            "--apply",
            "--remove",
            "--root",
            "/srv/root",
            "--node=Gateway-1",
            "--project",
            id,
            "--ack",
            &format!("{id}-20261001T000000Z"),
            "--ack",
            id,
        ]))
        .unwrap();
        assert_eq!(
            flags,
            Flags {
                help: false,
                apply: true,
                remove: true,
                root: Some(PathBuf::from("/srv/root")),
                node: Some("Gateway-1".to_string()),
                projects: vec![Uuid::parse_str(id).unwrap()],
                acks: vec![format!("{id}-20261001T000000Z"), id.to_string()],
            }
        );
        assert_eq!(parse_flags(&[]).unwrap(), Flags::default());
        for bad in [
            &["--force"][..],
            &["--node"],
            &["--project", "nope"],
            &["--ack", "a/b"],
            &["--ack", " "],
            &["--apply=yes"],
            &["salvage"],
        ] {
            assert!(parse_flags(&args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn node_names_are_lower_case_and_fit_the_shard_rule() {
        assert_eq!(node_name("Gateway-1").unwrap(), "gateway-1");
        assert_eq!(
            node_name(" ip-10-0-1-2.EU-west-1.compute.internal ").unwrap(),
            "ip-10-0-1-2.eu-west-1.compute.internal"
        );
        assert_eq!(node_name("a_b").unwrap(), "a_b");
        let longest = "n".repeat(MAX_NODE_LEN);
        assert_eq!(node_name(&longest).unwrap(), longest);
        for bad in [
            "",
            "-gateway",
            ".gateway",
            "gate way",
            "gate/way",
            "gate..way",
            "gåte",
            &"n".repeat(MAX_NODE_LEN + 1),
        ] {
            assert!(node_name(bad).is_err(), "{bad:?}");
        }
        // Every accepted node makes a name the shard accepts.
        let reference = format!("{SALVAGE_GATEWAY_REF_ROOT}/{longest}-0123abcd");
        assert!(git_service::policy::is_salvage_ref_name(&reference));
    }

    #[test]
    fn settings_come_from_flags_then_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let root_text = root.to_string_lossy().to_string();
        let env = |name: &str| -> Option<String> {
            match name {
                "ORIGIN_WORKSPACE_ROOT" => Some(root_text.clone()),
                "INSTAFY_NODE_NAME" => Some("Node-A".to_string()),
                "ORIGIN_GIT_REMOTE_BASE_URL" => Some("https://edge.example/git/".to_string()),
                _ => None,
            }
        };
        let settings = Settings::from_flags(&Flags::default(), &env).unwrap();
        assert_eq!(settings.root, root);
        assert_eq!(settings.node, "node-a");
        assert!(!settings.apply);
        assert_eq!(
            settings.remote_url(&Uuid::nil()),
            "https://edge.example/git/00000000-0000-0000-0000-000000000000.git"
        );
        assert_eq!(settings.identity.email, DEFAULT_GATEWAY_AUTHOR_EMAIL);

        let flags = Flags {
            node: Some("other".to_string()),
            ..Flags::default()
        };
        assert_eq!(Settings::from_flags(&flags, &env).unwrap().node, "other");

        let no_base = |name: &str| -> Option<String> {
            (name != "ORIGIN_GIT_REMOTE_BASE_URL")
                .then(|| env(name))
                .flatten()
        };
        let error = Settings::from_flags(&Flags::default(), &no_base)
            .unwrap_err()
            .to_string();
        assert!(error.contains("ORIGIN_GIT_REMOTE_BASE_URL"), "{error}");
    }
}
