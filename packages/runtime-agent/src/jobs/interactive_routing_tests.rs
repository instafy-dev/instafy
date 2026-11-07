//! Pages people tap through: the router sends them to the interactive-artifacts hub, which picks
//! the builder from the installed skills (a skill pack's own skill when one fits), and the hub, the
//! router and an installed pack's skill all load whole within the project memory budget.

use super::tests::{test_job_processor, test_lease_job};
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

/// A page asked for in plain words ("a small page I can share", "as a page", "on a page") is a page to build. The turn
/// that builds it runs without the workspace memory snapshot, so it learns which skills apply from the hints alone:
/// they named the browser skill (whose `page` is a page in the browser) and no page builder, and the turn built the
/// page inside a map site, served without Studio's theme. The hub is hinted now, and picks a starter. A page in the
/// browser, or a request with no page in it, is not the hub's. An unedited copy of the hub from before is upgraded;
/// an edited one is kept.
#[test]
fn a_page_asked_for_in_plain_words_points_the_building_turn_at_the_hub() {
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let hinted = |prompt: &str| {
        format_skill_hints(tmp.path(), prompt, DIRECT_WRITE_SKILL_HINTS_LEAD)
            .map(|hints| hints.skills)
            .unwrap_or_default()
    };
    for prompt in [
        "Put the hours and the metro route on a small page I can share.",
        "Show the opening hours and how to get there as a page.",
        "put the packing list for the weekend on a page",
        "a simple page with the menu and the opening times",
        "turn these notes into a page",
        "a one page summary of the three offers",
        "make a shareable page with the meeting times",
    ] {
        let hints = hinted(prompt);
        assert!(hints.iter().any(|id| id == HUB), "{prompt}: {hints:?}");
    }
    let contexts = build_top_level_context_nodes(tmp.path());
    for prompt in [
        "Open the pricing page on stripe.com in your browser",
        "Open github.com in your browser and sign me in",
        "rename userId to accountId",
    ] {
        assert!(
            !routed(&contexts, prompt).iter().any(|id| id == HUB),
            "{prompt}: {:?}",
            routed(&contexts, prompt)
        );
    }

    let hub =
        include_str!("../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md");
    let previous = include_str!("legacy/interactive-artifacts-v6.md");
    assert!(!previous.contains("small page"));
    let path = tmp.path().join(learn::INTERACTIVE_ARTIFACTS_RELATIVE_PATH);
    fs::write(&path, previous).unwrap();
    learn::ensure_project_memory_scaffold(tmp.path());
    assert_eq!(fs::read_to_string(&path).unwrap(), hub);
    let edited = format!("{previous}\nLocal page preference.\n");
    fs::write(&path, &edited).unwrap();
    learn::ensure_project_memory_scaffold(tmp.path());
    assert_eq!(fs::read_to_string(&path).unwrap(), edited);
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

/// `instafy preview open` takes the folder it runs in for the card's site: where opening the card
/// starts it again, and the folder whose changes take a new picture for the card. Told to run it
/// "from the site's folder", a comparison's turn ran it from the space's folder with the site's
/// path in the serve command (`instafy bind serve sites/<slug>`), so the card's site was the whole
/// space and another chat's build took a new picture of it. The card step's command goes into the
/// site's folder itself and serves `.`, as the map skill's does. An unedited earlier copy of the
/// hub is upgraded; an edited one is kept.
#[test]
fn a_pages_card_starts_inside_the_sites_own_folder() {
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let hub =
        include_str!("../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md");
    let previous = include_str!("legacy/interactive-artifacts-v7.md");
    let step = r#"1. One command, run inside the site's folder, starts it so it outlives your turn and posts
        its card: `(cd sites/<slug> && instafy preview open --title '<short title>' --serve-cmd
        "<serve command>" --start --json)`, with `{port}` where the serve command takes its port. The
        serve command is the builder skill's; a bound or plain site's is `instafy bind serve . --port
        {port} --preview`."#;
    assert!(flat(hub).contains(&flat(step)), "{hub}");
    assert!(!hub.contains("from the site's folder"), "{hub}");
    assert!(flat(previous).contains("1. One command, from the site's folder, starts it"));
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

/// A blank page's turn chained `instafy bind check … && instafy preview open …`, as the hub said
/// ("Check before the card"). The check could not read the page's words in its app.js and failed,
/// so the card's command never ran and the page had no card. The card comes first, in the hub and
/// in the research team's last step, and a failing check never holds it back. Unedited earlier
/// copies of both are upgraded; edited ones are kept.
#[test]
fn a_pages_card_comes_before_its_check() {
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let hub =
        include_str!("../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md");
    let team = include_str!("../../assets/instafy/.agents/skills/instafy-research-team/SKILL.md");
    assert!(
        flat(hub).contains(
            "Post the card first (step 3), then check with the builder skill's own check, else `instafy bind check <dir> --expect \"<item>,<item>\"`"
        ),
        "{hub}"
    );
    assert!(
        flat(team).contains(
            "Serve, open the preview card and check it (hub step 3). Then reconcile with `Expect:`"
        ),
        "{team}"
    );
    for skill in [hub, team] {
        assert!(
            flat(skill).contains("A failing check never holds the card back."),
            "{skill}"
        );
        assert!(!skill.contains("before the card"), "{skill}");
        assert!(
            skill.len() <= PROJECT_MEMORY_MAX_FILE_BYTES,
            "{} bytes",
            skill.len()
        );
    }

    let tmp = tempdir().unwrap();
    let root = tmp.path();
    learn::ensure_project_memory_scaffold(root);
    for (relative, previous, current) in [
        (
            learn::INTERACTIVE_ARTIFACTS_RELATIVE_PATH,
            include_str!("legacy/interactive-artifacts-v8.md"),
            hub,
        ),
        (
            learn::RESEARCH_TEAM_RELATIVE_PATH,
            include_str!("legacy/research-team-v3.md"),
            team,
        ),
    ] {
        assert!(previous.contains("before the card"), "{relative}");
        let path = root.join(relative);
        fs::write(&path, previous).unwrap();
        learn::ensure_project_memory_scaffold(root);
        assert_eq!(fs::read_to_string(&path).unwrap(), current, "{relative}");
        let edited = format!("{previous}\nLocal page preference.\n");
        fs::write(&path, &edited).unwrap();
        learn::ensure_project_memory_scaffold(root);
        assert_eq!(fs::read_to_string(&path).unwrap(), edited, "{relative}");
    }
}

/// A comparison looked right on a laptop and cramped on a phone, and the hub said only
/// "Phone-first". It says what that means for a page Octo writes itself (the starters already do
/// it): never wider than the screen, one column when narrow. An unedited earlier copy of the hub is
/// upgraded; an edited one is kept.
#[test]
fn a_page_is_never_wider_than_a_phone_and_one_column_when_narrow() {
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let hub =
        include_str!("../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md");
    let previous = include_str!("legacy/interactive-artifacts-v9.md");
    let line = "Phone-first (never wider than the screen, one column when narrow)";
    assert!(flat(hub).contains(line), "{hub}");
    assert!(!flat(previous).contains("never wider than the screen"));
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

/// A hand-back's own words are always the controller's one line, which names no page. Research
/// that ends in a page goes to the browser first, so the hand-back is often its chat's first
/// building turn: its skills were picked from that line, the browser skill and no page builder,
/// and it wrote the page by hand, posted no card and replied with the page's path. Its skills come
/// from the request it carries on: on a new thread its snapshot loads the hub, and on a restored
/// one its hints name it. Without the person's words, what the browser turn was asked; any other
/// turn, and a record the controller did not check, from its own words.
#[test]
fn a_hand_back_picks_its_skills_from_the_request_it_carries_on() {
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let processor = test_job_processor(tmp.path());
    let project_id = Uuid::new_v4();
    let hand_back = "Continue building with what the browser turn found.";
    let person = "Compare the three latest laptops of one maker: CPU, battery, weight and price, with two independent reviews each, as a comparison page.";
    let restored = json!({"defaultThreadId": "existing-thread", "historyReplayRequired": false});
    let prompt = |record: JsonValue, thread: Option<&JsonValue>| {
        let mut job = test_lease_job(
            Some("feature"),
            json!({ "prompt_text": hand_back, "metadata": { "browserHandBack": record } }),
        );
        job.project_id = Some(project_id);
        processor
            .build_prompt_with_text(
                &project_id,
                &job,
                tmp.path(),
                hand_back,
                true,
                thread,
                &[],
                None,
                None,
            )
            .expect("prompt should build")
    };
    let selected_tree = |prompt: &str| {
        prompt
            .split_once("## Persistent context tree (selected)\n")
            .and_then(|(_, rest)| rest.split("\n## ").next())
            .expect("the selected tree")
            .to_string()
    };
    let hub_heading = format!("## Context: {HUB} (");
    let record = |request: JsonValue, person_request: JsonValue| {
        json!({
            "verified": true,
            "reply": "Read 3 pages.",
            "findings": [],
            "request": request,
            "personRequest": person_request,
        })
    };

    // A message the routing step sent straight to the browser: the person's own words.
    let routed = record(json!(person), json!(person));
    let (first, ..) = prompt(routed.clone(), None);
    assert!(selected_tree(&first).contains(HUB), "{first}");
    assert!(first.contains(&hub_heading), "{first}");
    let (later, _, metrics) = prompt(routed, Some(&restored));
    assert!(later.contains("Skills that match this request"), "{later}");
    assert!(
        metrics["restoredSkillHints"]
            .as_array()
            .is_some_and(|hinted| hinted.iter().any(|id| id == HUB)),
        "{metrics}"
    );

    // A card's own task, when no person's words came with it.
    let card = record(
        json!("Read each laptop's own page, then put them side by side in a comparison table."),
        JsonValue::Null,
    );
    let (first, ..) = prompt(card, None);
    assert!(selected_tree(&first).contains(HUB), "{first}");

    // A record the controller did not check: the turn's own words, which name no page.
    let mut unchecked = record(json!(person), json!(person));
    unchecked["verified"] = json!(false);
    let (first, ..) = prompt(unchecked, None);
    assert!(!selected_tree(&first).contains(HUB), "{first}");
    assert!(!first.contains(&hub_heading), "{first}");
}

/// The prompt a turn with this job metadata gets for `request`, on a new thread or, with
/// `provider_state`, a restored one.
fn prompt_for(
    workspace: &Path,
    metadata: JsonValue,
    provider_state: Option<&JsonValue>,
    request: &str,
) -> String {
    let processor = test_job_processor(workspace);
    let project_id = Uuid::new_v4();
    let mut job = test_lease_job(Some("feature"), json!({ "metadata": metadata }));
    job.project_id = Some(project_id);
    let (prompt, ..) = processor
        .build_prompt_with_text(
            &project_id,
            &job,
            workspace,
            request,
            true,
            provider_state,
            &[],
            None,
            None,
        )
        .expect("prompt should build");
    prompt
}

/// The prompt a direct workspace-change turn gets for `request`, which loads no workspace memory.
fn direct_write_prompt(workspace: &Path, request: &str) -> String {
    let prompt = prompt_for(
        workspace,
        json!({ "runtimeExpectations": { "workspaceFileChanges": true } }),
        None,
        request,
    );
    assert!(
        prompt.contains("Direct workspace-change response contract"),
        "{prompt}"
    );
    prompt
}

/// In a new chat, "Make a simple comparison page of … from what you already know, without browsing."
/// found another chat's researched comparison in `sites/`, read it, deleted its data and wrote its
/// own there, and that chat's page and card showed the new one. The turn, which loads no workspace
/// memory, was hinted only the browser skill: "comparison" was no keyword of the hub (it folds apart
/// from "compare"), so it never read that a follow-up changes its own chat's site. The hub is hinted
/// now, and the hub and every direct workspace-change turn say whose page a request changes: the one
/// this chat made, another chat's only when the person names it, else a new folder. An unedited hub
/// from before is upgraded.
#[test]
fn a_comparison_asked_in_a_new_chat_is_the_hubs_and_leaves_another_chats_site_as_it_is() {
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let request = "Make a simple comparison page of the Framework Laptop 13 and 16 from what you already know, without browsing.";
    let hinted = || {
        format_skill_hints(tmp.path(), request, DIRECT_WRITE_SKILL_HINTS_LEAD)
            .map(|hints| hints.skills)
            .unwrap_or_default()
    };
    assert!(hinted().iter().any(|id| id == HUB), "{:?}", hinted());
    let rule = "A follow-up changes the site this chat made; a site another chat made changes only when the person names it, else start a new folder.";
    let hub =
        include_str!("../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md");
    assert!(
        flat(hub).contains(&format!("One site per request. {rule}")),
        "{hub}"
    );
    let prompt = direct_write_prompt(tmp.path(), request);
    assert!(
        prompt.contains(".agents/skills/instafy-interactive-artifacts/SKILL.md"),
        "{prompt}"
    );
    let invariants = prompt
        .split_once("Direct workspace-change invariants:\n")
        .map(|(_, rest)| rest)
        .expect("the invariants");
    assert!(invariants.contains(PAGE_OF_ITS_OWN_CHAT_RULE), "{prompt}");
    // also for a request no skill matches
    assert!(
        direct_write_prompt(
            tmp.path(),
            "Create notes/hello.txt with exactly: hello world"
        )
        .contains(PAGE_OF_ITS_OWN_CHAT_RULE)
    );

    // The hub from before: no keyword of this request, and "follow-ups change the same site".
    let path = tmp.path().join(learn::INTERACTIVE_ARTIFACTS_RELATIVE_PATH);
    let previous = include_str!("legacy/interactive-artifacts-v12.md");
    assert!(previous.contains("follow-ups change the same site"));
    fs::write(&path, previous).unwrap();
    assert!(!hinted().iter().any(|id| id == HUB), "{:?}", hinted());
    learn::ensure_project_memory_scaffold(tmp.path());
    assert_eq!(fs::read_to_string(&path).unwrap(), hub);
}

/// Whose page a turn changes reached only the turns that answer in plain text. A chat with a
/// goal answers a change in JSON, and so does a turn the routing step expected no change for
/// (the map that was built anyway), on a new thread or a restored one: none read it unless a
/// keyword hinted the hub. Every turn that may write files reads it now. It speaks of a page made
/// for the person (a map, a comparison, a page to share), so a change to the person's own app
/// from a new chat ("Make the buttons rounder.") still changes that app, and never a site in
/// general. A turn that may not write, and a browser turn, are not told it.
#[test]
fn every_turn_that_may_write_reads_whose_page_it_changes_and_never_whose_app() {
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let rounder = direct_write_prompt(tmp.path(), "Make the buttons rounder.");
    assert!(rounder.contains(PAGE_OF_ITS_OWN_CHAT_RULE), "{rounder}");
    assert!(
        !rounder.contains("a site another chat made changes only when the person names it"),
        "{rounder}"
    );
    assert!(
        PAGE_OF_ITS_OWN_CHAT_RULE.contains(
            "a page made for the person in another chat (a map, a comparison, a page to share) changes only when the person names it, else start a new folder."
        )
    );
    let goal = json!({ "objective": "Keep the comparison page current", "status": "active" });
    let none = json!({ "agentRoutingPreflight": { "workspaceFileChangeRequirement": "none" } });
    let restored = json!({ "threadId": "thread-1", "historyReplayRequired": false });
    for (lane, metadata, provider_state, section) in [
        (
            "a change in a chat with a goal",
            json!({ "runtimeExpectations": { "workspaceFileChanges": true }, "goal": goal }),
            None,
            "\nPlease follow these constraints:\n",
        ),
        (
            "a turn the routing step expected no change for",
            none.clone(),
            None,
            "\nPlease follow these constraints:\n",
        ),
        (
            "the same on a restored thread",
            none,
            Some(&restored),
            "\nCurrent Studio runtime invariants:\n",
        ),
    ] {
        let prompt = prompt_for(
            tmp.path(),
            metadata,
            provider_state,
            "Make a simple comparison of the two laptops.",
        );
        let section = prompt
            .split_once(section)
            .map(|(_, rest)| rest)
            .unwrap_or_else(|| panic!("{lane}: {prompt}"));
        assert!(
            section.contains(PAGE_OF_ITS_OWN_CHAT_RULE),
            "{lane}: {prompt}"
        );
    }
    for (lane, metadata, provider_state) in [
        (
            "a read-only turn",
            json!({ "writeScope": "read_only" }),
            None,
        ),
        (
            "a read-only turn on a restored thread",
            json!({ "writeScope": "read_only" }),
            Some(&restored),
        ),
        (
            "a browser turn",
            json!({ "browserTransport": "shared" }),
            None,
        ),
    ] {
        let prompt = prompt_for(
            tmp.path(),
            metadata,
            provider_state,
            "Compare the two laptops.",
        );
        assert!(
            !prompt.contains(PAGE_OF_ITS_OWN_CHAT_RULE),
            "{lane}: {prompt}"
        );
    }
}

/// The page to share in a chat that had found the hours ("Put the hours and the metro route on a
/// small page I can share.") was written by hand and served by a static file server, with no links,
/// no reload and no starter: after the hub, its turn read the previews skill, whose "With no
/// toolchain, prefer one `index.html` … served by a static file server" won. The previews skill now
/// sends a page made for the person to the hub, and keeps the static file server for other sites.
/// That its prompt names the hub, and no static file server, held before too ("small page" is a
/// keyword of the hub): it is kept as a guard. An unedited previews skill from before is upgraded.
#[test]
fn a_page_to_share_is_built_the_hubs_way_not_served_by_hand() {
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let prompt = direct_write_prompt(
        tmp.path(),
        "Put the hours and the metro route on a small page I can share.",
    );
    assert!(
        prompt.contains(".agents/skills/instafy-interactive-artifacts/SKILL.md"),
        "{prompt}"
    );
    assert!(!prompt.contains("http.server"), "{prompt}");
    let previews = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/assets/instafy/.agents/skills/instafy-frontend-previews/SKILL.md"
    ));
    let building = flat(
        previews
            .split_once("## Building a site to show\n")
            .and_then(|(_, rest)| rest.split("\n## ").next())
            .expect("Building a site to show"),
    );
    let page = "- A page made for the person (a map, a comparison, a page to share) is built per `instafy-interactive-artifacts`. Any other site with no toolchain: one `index.html`";
    assert!(building.contains(page), "{building}");
    assert!(
        !building.contains("With no toolchain, prefer one `index.html`"),
        "{building}"
    );
    assert_eq!(
        building.matches("static file server").count(),
        1,
        "{building}"
    );
    assert!(
        previews.len() <= PROJECT_MEMORY_MAX_FILE_BYTES,
        "{} bytes",
        previews.len()
    );

    let path = tmp.path().join(learn::FRONTEND_PREVIEWS_RELATIVE_PATH);
    let previous = include_str!("legacy/frontend-previews-v16.md");
    assert!(previous.contains("With no toolchain, prefer one `index.html`"));
    fs::write(&path, previous).unwrap();
    learn::ensure_project_memory_scaffold(tmp.path());
    assert_eq!(fs::read_to_string(&path).unwrap(), previews);
}

/// A comparison asked for "from what you already know, without browsing" claimed "checked 1 Mar 2025
/// on frame.work" on every row: the hub said "never from memory" and had no form for a person who
/// asks for exactly that. Such a page says so (`"from": "memory"`), and its values cite no page. On
/// pages of options, the lede also named the wrong laptop for a missing review, an item whose own
/// page nobody opened read "Not found yet", and a tip from no page sat in the style of the hours'
/// source line: the lede names the reply's missing items, such an item says it wasn't checked, and
/// a tip is plain text. An unedited hub from before is upgraded.
#[test]
fn a_page_from_what_octo_knows_says_so_and_its_rows_say_what_was_not_checked() {
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let hub = flat(include_str!(
        "../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md"
    ));
    let previous = flat(include_str!("legacy/interactive-artifacts-v12.md"));
    for needle in [
        "Options asked for from what you already know, with nothing looked up: the compare starter with `\"from\": \"memory\"`, each value only its `\"v\"`, from your own knowledge, never from the space's other pages.",
        "the starter reads each value \"<value>, not checked\" and adds \"From what Octo knows; nothing checked.\" to the lede.",
        "never from memory unless asked (above)",
        "An item whose own page wasn't opened is \"not checked (its own page wasn't opened)\" in the reply, and each of its unknown values has `\"note\": \"its own page wasn't opened\"`.",
        "The lede names the same missing items as the reply.",
        "A tip no page gave is plain text, never styled like a source line.",
    ] {
        assert!(hub.contains(needle), "{needle}");
        assert!(!previous.contains(needle), "new in this version: {needle}");
    }
}
