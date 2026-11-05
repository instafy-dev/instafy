//! What each kind of turn reads before its first step, and what it no longer reads twice or at
//! all. A browser turn read about 68,000 characters before its first page (local tests, Oct 31 to
//! Nov 4), lines for commands it does not have among them, and lines that pulled different ways
//! ("read-only" and three statements of who builds, beside a request to make a page): the same
//! comparison message read eighteen, one, seven and one pages. A building turn read a memory file
//! that told it to load the memory its prompt already held, and ran that command first (ten
//! threads, 4,000 to 41,000 characters back).

use super::tests::{test_job_processor, test_lease_job};
use super::*;
use tempfile::tempdir;

const REQUEST: &str = "Compare the three latest laptops of one maker: processor, battery, weight and price, with two independent reviews each, as a comparison page.";

fn prompt(tmp: &Path, job: &LeaseJob) -> String {
    let processor = test_job_processor(tmp);
    let project_id = job.project_id.unwrap_or_else(Uuid::new_v4);
    processor
        .build_prompt_with_text(&project_id, job, tmp, REQUEST, true, None, &[], None, None)
        .expect("prompt should build")
        .0
}

fn job(metadata: JsonValue) -> LeaseJob {
    let mut job = test_lease_job(Some("feature"), json!({ "metadata": metadata }));
    job.project_id = Some(Uuid::new_v4());
    job
}

/// A routed build whose change the routing step left to inspection: a turn in the write lane with
/// the space's memory snapshot, as a hand-back is.
fn write_lane_job() -> LeaseJob {
    job_with_agent_routing_preflight(
        &job(json!({ "writeIntent": true })),
        &AgentRoutingPreflight {
            route: AgentRoutingPreflightRoute::Direct,
            reason: "A page from what the chat found.".to_string(),
            selected_skills: Vec::new(),
            confidence: 90,
            requires_context_lookup: false,
            requires_command_execution: false,
            workspace_file_change_requirement: WorkspaceFileChangeRequirement::Conditional,
            observation_commands: Vec::new(),
        },
    )
}

/// The space's `AGENTS.md` says how to run commands and how to reply. A browser turn has no
/// shell: it reads the replies guide of a copy Instafy ships, as it does on a restored thread, and
/// a building turn reads the file whole. A copy the space edited (a team's own rules added to it)
/// or one with no replies guide (a team's own) is carried whole: "Never open example.com in the
/// browser." is a rule for every turn.
#[test]
fn a_browser_turn_reads_only_the_replies_guide_of_agents_md() {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let agents = fs::read_to_string(tmp.path().join(learn::AGENTS_DOC_FILENAME)).unwrap();
    let replies = &agents[agents.find("## Replies").expect("replies")..];
    for transport in ["shared", "desktop-personal"] {
        let prompt = prompt(tmp.path(), &job(json!({ "browserTransport": transport })));
        let block = format!(
            "\n## AGENTS.md (AGENTS.md)\n```markdown\n{}\n```\n",
            replies.trim_end()
        );
        assert!(prompt.contains(&block), "{transport}\n{prompt}");
        for shell in ["## Responsiveness", "Treat “read-only”", "write_stdin"] {
            assert!(!prompt.contains(shell), "{transport}: {shell}");
        }
    }
    let building = prompt(tmp.path(), &job(json!({})));
    assert!(building.contains(&format!("```markdown\n{}\n```\n", agents.trim_end())));

    let own = "# Team notes\n\nAlways cite the city's own open data first.\n";
    fs::write(tmp.path().join(learn::AGENTS_DOC_FILENAME), own).unwrap();
    let browser = prompt(tmp.path(), &job(json!({ "browserTransport": "shared" })));
    assert!(browser.contains("Always cite the city's own open data first."));

    // An earlier copy Instafy shipped (a checkout the scaffold leaves as it is) is read the same
    // way as the current one; an edited one comes whole.
    let earlier = include_str!("legacy/agents-doc-v12.md");
    fs::write(tmp.path().join(learn::AGENTS_DOC_FILENAME), earlier).unwrap();
    let browser = prompt(tmp.path(), &job(json!({ "browserTransport": "shared" })));
    assert!(browser.contains("## Replies"));
    assert!(!browser.contains("## Responsiveness"), "{browser}");
    let edited = format!("{agents}\n## Site rules\n\n- Never open example.com in the browser.\n");
    fs::write(tmp.path().join(learn::AGENTS_DOC_FILENAME), &edited).unwrap();
    for transport in ["shared", "desktop-personal"] {
        let browser = prompt(tmp.path(), &job(json!({ "browserTransport": transport })));
        assert!(
            browser.contains(&format!("```markdown\n{}\n```\n", edited.trim_end())),
            "{transport}"
        );
    }
}

/// No turn's memory tells it to load memory again: no file Instafy ships into a space (`AGENTS.md`,
/// `INSTAFY.md`, the learning policy and every other skill) says to run `python AGENTS.py` first
/// (it prints the snapshot the prompt already holds) or holds a "start-of-task ritual". `/learn`
/// still runs it, as its own prompt says. Unedited earlier copies are upgraded and edited ones
/// kept, so a space whose files this runtime keeps (a Desktop folder) stops carrying the ritual:
/// `INSTAFY.md` and the learning policy were written only into a space that had none.
#[test]
fn no_memory_file_tells_a_turn_to_load_its_memory_again() {
    const GONE: [&str; 4] = [
        "python AGENTS.py",
        "Fast context load",
        "Start-of-task ritual",
        "first discover what skills/tools are available",
    ];
    fn bundled_markdown(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                bundled_markdown(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "md") {
                let text = fs::read_to_string(&path).unwrap();
                out.push((path, text));
            }
        }
    }
    let mut files = Vec::new();
    bundled_markdown(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/instafy"),
        &mut files,
    );
    assert!(files.len() > 20, "{}", files.len());
    for (path, text) in &files {
        for gone in GONE {
            assert!(!text.contains(gone), "{}: {gone}", path.display());
        }
    }
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let building = prompt(tmp.path(), &job(json!({})));
    assert!(!building.contains("Fast context load"));
    assert!(building.contains("For `/learn`, run `python AGENTS.py` if present"));

    for (file, previous, marker) in [
        (
            learn::AGENTS_DOC_FILENAME,
            include_str!("legacy/agents-doc-v12.md"),
            "## Fast context load (preferred)",
        ),
        (
            learn::INSTAFY_FILENAME,
            include_str!("legacy/instafy-doc-v2.md"),
            "Start-of-task ritual",
        ),
        (
            learn::INSTAFY_FILENAME,
            include_str!("legacy/instafy-doc-v1.md"),
            "Start-of-task ritual",
        ),
        (
            learn::LEARNING_POLICY_RELATIVE_PATH,
            include_str!("legacy/learning-policy-v1.md"),
            "## Start-of-task ritual",
        ),
    ] {
        assert!(previous.contains(marker), "{file}");
        let path = tmp.path().join(file);
        fs::write(&path, previous).unwrap();
        learn::ensure_project_memory_scaffold(tmp.path());
        let upgraded = fs::read_to_string(&path).unwrap();
        for gone in GONE {
            assert!(!upgraded.contains(gone), "{file}: {gone}");
        }
        // A space's own memory is kept as it is.
        let edited =
            previous.replace("<1–2 sentences>", "Our team's trip planner.") + "\nOur own note.\n";
        fs::write(&path, &edited).unwrap();
        learn::ensure_project_memory_scaffold(tmp.path());
        assert_eq!(fs::read_to_string(&path).unwrap(), edited, "{file}");
        fs::remove_file(&path).unwrap();
        learn::ensure_project_memory_scaffold(tmp.path());
    }
    // A building turn's snapshot of an upgraded space holds no ritual either.
    let building = prompt(tmp.path(), &job(json!({})));
    for gone in ["Start-of-task ritual", "prefer `python AGENTS.py`"] {
        assert!(!building.contains(gone), "{gone}");
    }
}

/// A turn in the write lane emits no team plan, as its contract says: its memory snapshot leaves
/// out the collaboration skill (team plans, worker scopes, advisory locks), whose delegation
/// choice it reads once, in its own section. A hand-back carried the skill cut at 12,000 bytes
/// and its delegation choice twice, beside "Do not emit `multi_agent_plan`". A turn that may plan
/// a team keeps the skill.
#[test]
fn a_write_lane_turn_reads_the_delegation_choice_once_and_no_team_planning() {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let write = prompt(tmp.path(), &write_lane_job());
    assert!(write.contains("\nProject memory snapshot (from workspace; already loaded):\n"));
    assert!(write.contains("Do not emit `multi_agent_plan`"), "{write}");
    assert!(!write.contains("## Context: instafy-agent-collaboration ("));
    assert!(!write.contains("## Advisory locks"));
    assert_eq!(write.matches("## Delegation choice").count(), 1, "{write}");
    assert!(write.contains(
        "Current delegation policy from `.agents/skills/instafy-agent-collaboration/SKILL.md`"
    ));

    let structured = prompt(tmp.path(), &job(json!({})));
    assert!(structured.contains("## Context: instafy-agent-collaboration ("));
    // Neither carries the routing step's own section of it.
    for prompt in [&write, &structured] {
        assert!(!prompt.contains("## Routing preflight"));
        assert!(!prompt.contains("### Pending worker replies"));
    }
}

/// The index of learned blocks says how to open them; a space with none loads no index, and no
/// skill it loads says to open one. A space with a block loads the index.
#[test]
fn an_empty_learned_index_is_not_loaded() {
    let tmp = tempdir().expect("temp dir");
    learn::ensure_project_memory_scaffold(tmp.path());
    let request = "Check the inventory dashboard for low stock.";
    let snapshot = format_project_memory_snapshot(tmp.path(), request).expect("snapshot");
    assert!(!snapshot.text.contains("## Context: instafy-learned ("));
    assert!(!snapshot.text.contains("- instafy-learned\n"));
    // Nor does any skill it carries tell the turn to open the index: the skill router, which
    // fits beside it now, said "Open `instafy-learned` first". Blocks that match a request load
    // by themselves ("Learned blocks (auto-loaded)").
    assert!(
        snapshot.text.contains("## Context: instafy-skill-router ("),
        "{}",
        snapshot.text
    );
    assert!(
        !snapshot.text.contains("Open `instafy-learned`"),
        "{}",
        snapshot.text
    );

    let block = tmp
        .path()
        .join(learn::LEARNED_BLOCKS_DIR_RELATIVE_PATH)
        .join("inventory-dashboard");
    fs::create_dir_all(&block).unwrap();
    fs::write(
        block.join("SKILL.md"),
        "---\nname: inventory-dashboard\ndescription: Where the inventory dashboard lists low stock.\nrouting_keywords: inventory, dashboard, low stock\n---\n\nLow stock is under Reports > Stock.\n",
    )
    .unwrap();
    let snapshot = format_project_memory_snapshot(tmp.path(), request).expect("snapshot");
    assert!(snapshot.text.contains("## Context: instafy-learned ("));
}
