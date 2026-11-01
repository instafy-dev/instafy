//! Pages people tap through: the router sends them to the interactive-artifacts hub, which picks
//! the builder from the installed skills (a skill pack's own skill when one fits), and the hub, the
//! router and an installed pack's skill all load whole within the project memory budget.

use super::*;
use tempfile::tempdir;

const HUB: &str = "instafy-interactive-artifacts";
const RESEARCH_TEAM: &str = "instafy-research-team";
const LOCATION: &str = "instafy-location-sharing";

fn routed(contexts: &[ContextNode], prompt: &str) -> Vec<String> {
    select_recursive_context_nodes(contexts, prompt)
        .into_iter()
        .filter(|node| node.score > 0)
        .map(|node| node.id)
        .collect()
}

/// A skill pack's per-space SKILL.md as large as a space gets one (just under the 12,000-byte
/// limit), routed for maps.
fn install_pack_skill(workspace: &Path) -> String {
    let mut skill = String::from(
        "---\nname: demo-maps\ndescription: Build interactive map sites with this pack's commands.\n\
         context_parent: instafy-skill-router\nrouting_keywords: map, maps, walk, route\n---\n\n\
         > Installed by Instafy with the runtime.\n\n# Demo maps\n\n",
    );
    while skill.len() < 11_800 {
        skill.push_str("- A rule of the map pack that the builder needs to read in full.\n");
    }
    skill.push_str("END-OF-PACK-SKILL\n");
    let path = workspace.join(".agents/skills/demo-maps/SKILL.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, &skill).unwrap();
    skill
}

#[test]
fn pages_to_tap_through_route_to_the_hub() {
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let contexts = build_top_level_context_nodes(tmp.path());
    for prompt in [
        "make an interactive comparison table of these three laptops",
        "build me a dashboard to track my habits",
        "a quiz about the solar system my kids can tap through",
        "give me a top 10 ranking of budget headphones as a page",
        "a packing checklist for the weekend",
        // Shopping asks.
        "compare these 3 robot vacuums and show me where to buy them cheapest",
        "which espresso machine should I buy for under 500 euros",
        "compare the iPhone 16 and Pixel 9 for me",
    ] {
        assert!(
            routed(&contexts, prompt).iter().any(|id| id == HUB),
            "{prompt}: {:?}",
            routed(&contexts, prompt)
        );
    }
    let trip = routed(
        &contexts,
        "plan a two weeks road trip itinerary with 6 stops",
    );
    assert!(trip.iter().any(|id| id == RESEARCH_TEAM), "{trip:?}");
    for prompt in ["rename userId to accountId", "fix the failing unit test"] {
        assert!(
            !routed(&contexts, prompt).iter().any(|id| id == HUB),
            "{prompt}: {:?}",
            routed(&contexts, prompt)
        );
    }
}

#[test]
fn location_sharing_is_for_the_users_own_position_only() {
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let contexts = build_top_level_context_nodes(tmp.path());
    for prompt in [
        "find good coffee near me",
        "what is open around me right now",
    ] {
        assert!(
            routed(&contexts, prompt).iter().any(|id| id == LOCATION),
            "{prompt}: {:?}",
            routed(&contexts, prompt)
        );
    }
    for prompt in [
        "the closest bakery to the old harbour",
        "hotels within walking distance of the central station",
    ] {
        assert!(
            !routed(&contexts, prompt).iter().any(|id| id == LOCATION),
            "{prompt}: {:?}",
            routed(&contexts, prompt)
        );
    }
}

/// The turn that builds a map gets the hub and the pack's skill whole, ahead of the always-included
/// contexts, within the 50,000-byte snapshot. (The router is always included but loads after the
/// skills a prompt matched, so a turn like this one goes without it: the index line and the two
/// matched skills carry what the turn needs.)
#[test]
fn hub_and_an_installed_pack_skill_load_whole_within_the_budget() {
    let tmp = tempdir().expect("tmp");
    let root = tmp.path();
    learn::ensure_project_memory_scaffold(root);
    let pack = install_pack_skill(root);
    let contexts = build_top_level_context_nodes(root);
    let prompt = "make an interactive map of the best viewpoints for a sunset walk";
    let picked = routed(&contexts, prompt);
    assert!(picked.iter().any(|id| id == "demo-maps"), "{picked:?}");
    assert!(picked.iter().any(|id| id == HUB), "{picked:?}");

    let snapshot = format_project_memory_snapshot(root, prompt).expect("snapshot");

    assert!(snapshot.text.len() <= PROJECT_MEMORY_MAX_TOTAL_BYTES + 4_096);
    let hub = fs::read_to_string(root.join(learn::INTERACTIVE_ARTIFACTS_RELATIVE_PATH)).unwrap();
    for (name, text) in [("hub", hub), ("pack", pack)] {
        assert!(
            text.len() <= PROJECT_MEMORY_MAX_FILE_BYTES,
            "{name}: {} bytes",
            text.len()
        );
        assert!(
            snapshot.text.contains(text.trim_end()),
            "{name} is loaded whole"
        );
    }
    assert!(
        snapshot
            .text
            .contains("- instafy-interactive-artifacts: Use when the answer should be a page"),
        "the hub is in the index"
    );
}

#[test]
fn research_execution_policy_upgrades_unedited_skills_but_keeps_local_edits() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    learn::ensure_project_memory_scaffold(root);
    let current =
        include_str!("../../assets/instafy/.agents/skills/instafy-research-team/SKILL.md");
    let researcher = include_str!(
        "../../assets/instafy/.agents/skills/instafy-research-team/references/researcher.md"
    );
    for (relative, previous, expected) in [
        (
            learn::RESEARCH_TEAM_RELATIVE_PATH,
            include_str!("legacy/research-team-v1.md"),
            current,
        ),
        (
            learn::RESEARCH_TEAM_RESEARCHER_RELATIVE_PATH,
            include_str!("legacy/research-team-researcher-v2.md"),
            researcher,
        ),
    ] {
        let path = root.join(relative);
        fs::write(&path, previous).unwrap();
        learn::ensure_project_memory_scaffold(root);
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
        let customized = format!("{previous}\nLocal research preference.\n");
        fs::write(&path, &customized).unwrap();
        learn::ensure_project_memory_scaffold(root);
        assert_eq!(fs::read_to_string(path).unwrap(), customized);
    }
    assert!(current.len() <= PROJECT_MEMORY_MAX_FILE_BYTES);
}

/// A page written by hand follows light and dark as the starters' `theme.css` does (a visit page written by hand set
/// `color-scheme: light` and stayed light in a dark Studio, and so did its card's picture): the device's mode, and
/// Studio's theme, which the bind client puts on `<html data-theme>` and which wins over the device's (a framed
/// page's `prefers-color-scheme` can follow the device instead of Studio). An unedited earlier copy of the hub is
/// upgraded; an edited one is kept.
#[test]
fn a_page_written_by_hand_follows_light_and_dark() {
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let hub =
        include_str!("../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md");
    let previous = include_str!("legacy/interactive-artifacts-v4.md");
    let rule = r#"a page you write sets its dark colours, with `color-scheme: dark`, under
        `:root:not([data-theme="light"])` inside `@media (prefers-color-scheme: dark)` and under
        `:root[data-theme="dark"]` (Studio's theme, which `instafy bind serve` puts on `<html>`). Never
        `color-scheme: light` alone;"#;
    assert!(flat(hub).contains(&flat(rule)), "{hub}");
    assert!(!previous.contains("prefers-color-scheme"));
    assert!(
        hub.len() <= PROJECT_MEMORY_MAX_FILE_BYTES,
        "{} bytes",
        hub.len()
    );

    let tmp = tempdir().unwrap();
    let root = tmp.path();
    learn::ensure_project_memory_scaffold(root);
    let path = root.join(learn::INTERACTIVE_ARTIFACTS_RELATIVE_PATH);
    fs::write(&path, previous).unwrap();
    learn::ensure_project_memory_scaffold(root);
    assert_eq!(fs::read_to_string(&path).unwrap(), hub);
    let edited = format!("{previous}\nLocal page preference.\n");
    fs::write(&path, &edited).unwrap();
    learn::ensure_project_memory_scaffold(root);
    assert_eq!(fs::read_to_string(&path).unwrap(), edited);
}
