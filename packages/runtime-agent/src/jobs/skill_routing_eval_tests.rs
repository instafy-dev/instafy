//! Language eval for the lexical router: a dashboard, a list and a map asked for in English,
//! Swedish, Japanese and Spanish, plus unrelated asks in the same languages, routed through the
//! real router in a new space with three fixture builder skills added.
//!
//! The fixtures declare their own keywords in those languages, as any skill or pack would; the
//! router knows no topic. They hang under their own always-included root, so the eval measures
//! the tokenizer and the weights, not which builders a space ships, while every shipped skill
//! still counts toward document frequency.

use super::*;
use tempfile::tempdir;

const ROOT: &str = "fixture-builders";
const DASHBOARDS: &str = "fixture-dashboards";
const LISTS: &str = "fixture-lists";
const MAPS: &str = "fixture-maps";

const FIXTURES: &[(&str, &str)] = &[
    (
        ROOT,
        "---\nname: fixture-builders\ndescription: Picks a page builder.\ncontext_kind: meta\nalways_include: true\nmax_children: 3\n---\n\n# Builders\n",
    ),
    (
        DASHBOARDS,
        "---\nname: fixture-dashboards\ndescription: Build a dashboard page of numbers that update, with charts and weekly totals.\ncontext_kind: workflow\ncontext_parent: fixture-builders\nrouting_keywords: dashboard, chart, instrumentpanel, tablero, panel de control, ダッシュボード, グラフ\n---\n\n# Dashboards\n\nPut the headline number first and one chart under it.\n",
    ),
    (
        LISTS,
        "---\nname: fixture-lists\ndescription: Build a checklist or to-do list page that people tick off together.\ncontext_kind: workflow\ncontext_parent: fixture-builders\nrouting_keywords: checklist, to-do list, packing list, checklista, att göra-lista, lista de tareas, チェックリスト, やることリスト\n---\n\n# Lists\n\nOne item per row, a tick box on each.\n",
    ),
    (
        MAPS,
        "---\nname: fixture-maps\ndescription: Build a map page with pins and areas.\ncontext_kind: workflow\ncontext_parent: fixture-builders\nrouting_keywords: map, pins, karta, mapa, 地図, マップ\n---\n\n# Maps\n\nOne pin per place, a list beside the map.\n",
    ),
];

/// (prompt, expected fixture; None = a negative that must route no fixture).
const CASES: &[(&str, Option<&str>)] = &[
    // English
    ("build a dashboard of our weekly signups", Some(DASHBOARDS)),
    ("make a packing list for our camping weekend", Some(LISTS)),
    ("show our three offices on a map", Some(MAPS)),
    (
        "rename the variable userId to accountId across the repo",
        None,
    ),
    ("list the files changed in the last commit", None),
    // Swedish
    (
        "bygg en instrumentpanel över veckans registreringar",
        Some(DASHBOARDS),
    ),
    ("gör en checklista inför flytten", Some(LISTS)),
    ("visa kaféerna i Malmö på en karta", Some(MAPS)),
    ("fixa felet i byggskriptet så att testerna går igenom", None),
    ("lista filerna som ändrades i senaste committen", None),
    // Japanese: no spaces between words.
    (
        "チームの週間登録数のダッシュボードを作って",
        Some(DASHBOARDS),
    ),
    ("引っ越しのやることリストを作って", Some(LISTS)),
    ("東京のカフェを地図で見せて", Some(MAPS)),
    ("ビルドが失敗する原因を調べて", None),
    ("このリポジトリのファイルを一覧にして", None),
    // Spanish
    (
        "crea un tablero con las ventas semanales del equipo",
        Some(DASHBOARDS),
    ),
    ("hazme una lista de tareas para la mudanza", Some(LISTS)),
    ("muéstrame en un mapa los cafés de Madrid", Some(MAPS)),
    (
        "arregla el error de compilación en el archivo de configuración",
        None,
    ),
    ("lista los archivos que cambiaron en el último commit", None),
];

fn space_with_fixtures() -> tempfile::TempDir {
    let tmp = tempdir().expect("tmp");
    learn::ensure_project_memory_scaffold(tmp.path());
    let skills = tmp.path().join(learn::SKILLS_ROOT_RELATIVE_PATH);
    for (id, text) in FIXTURES {
        let dir = skills.join(id);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        std::fs::write(dir.join("SKILL.md"), text).expect("fixture");
    }
    tmp
}

fn routed_fixtures(contexts: &[ContextNode], prompt: &str) -> Vec<(String, usize)> {
    let mut routed: Vec<(String, usize)> = select_recursive_context_nodes(contexts, prompt)
        .into_iter()
        .filter(|node| node.parent.as_deref() == Some(ROOT) && node.score > 0)
        .map(|node| (node.id, node.score))
        .collect();
    routed.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    routed
}

#[test]
fn asks_in_four_languages_route_to_the_skill_whose_keywords_they_use() {
    let tmp = space_with_fixtures();
    let contexts = build_top_level_context_nodes(tmp.path());
    assert!(
        contexts
            .iter()
            .filter(|context| FIXTURES.iter().any(|(id, _)| *id == context.id))
            .count()
            == FIXTURES.len(),
        "fixtures are installed"
    );

    let mut misses = Vec::new();
    for (prompt, expected) in CASES {
        let routed = routed_fixtures(&contexts, prompt);
        let passed = match expected {
            // The expected skill alone: a word of one builder must not pull in another.
            Some(skill) => routed.len() == 1 && routed[0].0 == *skill,
            None => routed.is_empty(),
        };
        if !passed {
            misses.push(format!(
                "expect {:<20} routed {routed:?}  {prompt}",
                expected.unwrap_or("(none)")
            ));
        }
    }
    assert!(misses.is_empty(), "routing misses:\n{}", misses.join("\n"));
}

#[test]
fn a_keyword_in_another_language_is_not_needed_for_an_english_ask() {
    // Removing a skill's non-English keywords changes nothing for English asks, and its
    // non-English asks then route nowhere: the languages a skill serves are its own keywords.
    let tmp = space_with_fixtures();
    let maps = tmp
        .path()
        .join(learn::SKILLS_ROOT_RELATIVE_PATH)
        .join(MAPS)
        .join("SKILL.md");
    let text = std::fs::read_to_string(&maps).expect("maps");
    std::fs::write(
        &maps,
        text.replace("map, pins, karta, mapa, 地図, マップ", "map, pins"),
    )
    .expect("rewrite");
    let contexts = build_top_level_context_nodes(tmp.path());
    assert_eq!(
        routed_fixtures(&contexts, "show our three offices on a map"),
        vec![(MAPS.to_string(), 4)]
    );
    for prompt in [
        "visa kaféerna i Malmö på en karta",
        "東京のカフェを地図で見せて",
        "muéstrame en un mapa los cafés de Madrid",
    ] {
        assert!(routed_fixtures(&contexts, prompt).is_empty(), "{prompt}");
    }
}
