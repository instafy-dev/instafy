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
