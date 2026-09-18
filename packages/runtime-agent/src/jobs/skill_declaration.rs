//! The card's words, read from the skill's own declaration.
//!
//! A `SKILL.md` already says what each value is, where the user gets it and
//! whether it is sensitive, in a `## Secrets and settings` table. The model was
//! asked to copy those words into the `request_secret` action and it does not
//! reliably do so, so the card fell to "Connect Notion / Add the value in the
//! card on this message." for a value the pack had described in full. This
//! module reads the declaration directly, so the card's words no longer depend
//! on a model remembering. It is the floor, never the ceiling: what the model
//! sends still wins wherever it survives the sanitizer.
//!
//! Everything here produces a *candidate*, raw. Nothing in this file is safe to
//! render. The caller passes every candidate through
//! `card_text::sanitize_card_text`, exactly as it passes the model's own
//! strings, because a pack is untrusted content and reading it ourselves rather
//! than being told it changes nothing about that.
//!
//! Two rules keep it honest, and both are about refusing rather than repairing:
//!
//! 1. Only the *first* sentence of a cell is ever a candidate. Falling through
//!    to a later clean sentence sounds generous and is how Notion's "what it is"
//!    cell yields its terminology footnote, which passes every gate and is wrong
//!    on a card. Where sentence one cannot be recovered, the field is absent and
//!    the card uses its own wording.
//! 2. A trailing clause carrying markup, a link or a bare host is cut at the
//!    comma before it, and the cut happens *before* the sanitizer sees the
//!    string, never after. The sanitizer rejects such a string whole, on
//!    purpose; a derivation that stripped backticks to slip past it would be
//!    weakening the exact protection the gate exists for.

use std::fs;
use std::path::Path;

use super::card_text;

/// Where the skills lane installs what it imports.
const SKILLS_ROOT: &str = ".agents/skills";
/// A declaration is prose. Anything larger is not one, and reading it at card
/// time would be a stall the person watches.
const MAX_SKILL_FILE_BYTES: u64 = 512 * 1024;
/// The scan that runs when no slug reached us. A workspace with more skills
/// than this is not one where guessing the asker is safe.
const MAX_SKILLS_SCANNED: usize = 64;
/// A cell is one table cell of prose. A longer one is a pack doing something
/// other than describing a value.
const MAX_CELL_CHARS: usize = 4000;

/// The `## Secrets and settings` row for one variable, as candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredSecret {
    /// The folder under `.agents/skills` the row was read from. Provenance, and
    /// half of the connector resolution key.
    pub skill_slug: String,
    pub value_label: Option<String>,
    pub description: Option<String>,
    pub where_to_get: Option<String>,
    /// `None` where the cell says something this rule does not understand. The
    /// caller's default decides then, not a guess made here.
    pub sensitive: Option<bool>,
}

/// The declaration for one variable, or nothing.
///
/// With a slug, exactly that skill is read: the model named the asker and we do
/// not second-guess it. Without one (an older runtime, or a model that omitted
/// the field), every installed skill is scanned and the row must be declared by
/// exactly one of them. Two skills declaring the same variable is an ambiguity
/// no rule here can resolve, so it is an absence.
pub fn declared_secret(
    workspace_dir: &Path,
    secret_name: &str,
    skill_slug: Option<&str>,
) -> Option<DeclaredSecret> {
    if !card_text::validate_secret_name(secret_name) {
        return None;
    }
    if let Some(slug) = skill_slug {
        let slug = card_text::sanitize_skill_slug(slug)?;
        return read_declaration(workspace_dir, &slug, secret_name);
    }

    let mut entries: Vec<String> = fs::read_dir(workspace_dir.join(SKILLS_ROOT))
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(card_text::sanitize_skill_slug)
        })
        .collect();
    entries.sort();
    entries.dedup();
    if entries.len() > MAX_SKILLS_SCANNED {
        return None;
    }

    let mut found: Option<DeclaredSecret> = None;
    for slug in entries {
        let Some(declared) = read_declaration(workspace_dir, &slug, secret_name) else {
            continue;
        };
        if found.is_some() {
            // Two skills claim the variable. Neither is the asker for certain.
            return None;
        }
        found = Some(declared);
    }
    found
}

fn read_declaration(workspace_dir: &Path, slug: &str, secret_name: &str) -> Option<DeclaredSecret> {
    // The slug came through `sanitize_skill_slug`, so it is one lowercase folder
    // name with no separator in it and cannot walk out of the skills root.
    let path = workspace_dir.join(SKILLS_ROOT).join(slug).join("SKILL.md");
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SKILL_FILE_BYTES {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let row = secrets_row(&text, secret_name)?;
    Some(derive(slug, &row))
}

/// One matched row's four cells, already trimmed. A column the table did not
/// carry is `None`, which is an absence and never an empty string.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct SecretsRow {
    sensitive: Option<String>,
    what_it_is: Option<String>,
    where_to_get: Option<String>,
}

fn derive(slug: &str, row: &SecretsRow) -> DeclaredSecret {
    let description = row.what_it_is.as_deref().and_then(first_usable_sentence);
    // The label is a reduction of the description's own sentence, never a
    // second reading of the cell: the two halves of the card should not be able
    // to disagree about what the value is.
    let value_label = description.as_deref().and_then(reduce_to_label);
    let where_to_get = row
        .where_to_get
        .as_deref()
        .and_then(first_usable_sentence)
        // A sentence that will not fit is refused, not cut: the 160-char cap
        // lands immediately before "Technischer Benutzer" in the FreeFinance
        // row and would take with it the one noun the sentence existed to
        // deliver. The sanitizer refuses an over-length one too, so this is
        // belt and braces rather than the only guard, and it keeps the
        // derivation honest about its own output before it reaches that gate.
        .filter(|sentence| sentence.chars().count() <= card_text::MAX_WHERE_TO_GET_CHARS);
    DeclaredSecret {
        skill_slug: slug.to_string(),
        value_label,
        description,
        where_to_get,
        sensitive: row.sensitive.as_deref().and_then(parse_sensitive),
    }
}

/// "Yes" and "No, optional" are the two vocabularies the packs use today. A
/// third is not guessed at: an unread cell is `None`, and the caller keeps its
/// own default, which hides the value.
fn parse_sensitive(cell: &str) -> Option<bool> {
    let word: String = cell
        .trim()
        .chars()
        .take_while(|ch| ch.is_ascii_alphabetic())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    match word.as_str() {
        "yes" | "true" | "sensitive" => Some(true),
        "no" | "false" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/// Which column a header cell is. Matched on the header's own words, not on
/// position: a pack that reorders its columns still reads correctly, and a pack
/// that writes "Where to get it" still matches. A table that does not carry a
/// name column, or carries two of anything, is not understood and is skipped
/// whole, because deriving a where-to-get out of a "what it is" column would
/// render confident nonsense.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Column {
    Name,
    Sensitive,
    WhatItIs,
    WhereToGet,
}

fn classify_header(cell: &str) -> Option<Column> {
    let normalized: String = cell
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    match normalized.as_str() {
        "name" | "variable" | "variable name" | "environment variable" | "env var" => {
            Some(Column::Name)
        }
        "sensitive" | "secret" => Some(Column::Sensitive),
        "what it is" | "what this is" | "what the value is" | "description" => {
            Some(Column::WhatItIs)
        }
        other if other.starts_with("where") => Some(Column::WhereToGet),
        _ => None,
    }
}

/// The cells of one Markdown table row, or nothing when the line is not one.
/// `\|` is the only escape GitHub honours inside a cell, and the FreeFinance
/// table uses it, so it is the only one honoured here.
fn split_row(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') {
        return None;
    }
    let mut cells: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = trimmed.chars();
    chars.next();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some('|') => current.push('|'),
                Some(next) => {
                    current.push('\\');
                    current.push(next);
                }
                None => current.push('\\'),
            },
            '|' => {
                cells.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        cells.push(current.trim().to_string());
    }
    Some(cells)
}

fn is_delimiter_row(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let cell = cell.trim();
            cell.chars().any(|ch| ch == '-') && cell.chars().all(|ch| matches!(ch, '-' | ':' | ' '))
        })
}

/// The variable name a Name cell holds. The backticks come off because the cell
/// is Markdown, and then the name must be one we would accept as a destination:
/// a Name cell that is prose is not a declaration of a variable.
fn cell_variable_name(cell: &str) -> Option<String> {
    let name = cell.trim().trim_matches('`').trim().to_string();
    card_text::validate_secret_name(&name).then_some(name)
}

/// The row for `secret_name` in the first table whose header we understand.
fn secrets_row(markdown: &str, secret_name: &str) -> Option<SecretsRow> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut index = 0usize;
    while index + 1 < lines.len() {
        let Some(header_cells) = split_row(lines[index]) else {
            index += 1;
            continue;
        };
        let Some(delimiter_cells) = split_row(lines[index + 1]) else {
            index += 1;
            continue;
        };
        if !is_delimiter_row(&delimiter_cells) || delimiter_cells.len() != header_cells.len() {
            index += 1;
            continue;
        }
        let Some(columns) = map_columns(&header_cells) else {
            index += 1;
            continue;
        };
        if let Some(row) = scan_rows(&lines, index + 2, &columns, secret_name) {
            return Some(row);
        }
        index += 2;
    }
    None
}

/// Header cells to columns, or nothing when the table is not a secrets table.
/// A repeated column makes the whole table unreadable rather than picking one,
/// because the wrong pick is a where-to-get made out of a format note.
fn map_columns(header_cells: &[String]) -> Option<Vec<Option<Column>>> {
    let columns: Vec<Option<Column>> = header_cells
        .iter()
        .map(|cell| classify_header(cell))
        .collect();
    let count = |wanted: Column| {
        columns
            .iter()
            .filter(|column| **column == Some(wanted))
            .count()
    };
    if count(Column::Name) != 1 {
        return None;
    }
    for column in [Column::Sensitive, Column::WhatItIs, Column::WhereToGet] {
        if count(column) > 1 {
            return None;
        }
    }
    if count(Column::WhatItIs) + count(Column::WhereToGet) + count(Column::Sensitive) == 0 {
        return None;
    }
    Some(columns)
}

fn scan_rows(
    lines: &[&str],
    start: usize,
    columns: &[Option<Column>],
    secret_name: &str,
) -> Option<SecretsRow> {
    for line in lines.iter().skip(start) {
        let Some(cells) = split_row(line) else {
            // The table ended.
            return None;
        };
        // A row whose cell count differs from the header is a row we cannot
        // column with confidence, so it is skipped rather than guessed at.
        if cells.len() != columns.len() {
            continue;
        }
        // One oversized cell drops its own row, not the table: the row we want
        // may still be below it.
        if cells
            .iter()
            .any(|cell| cell.chars().count() > MAX_CELL_CHARS)
        {
            continue;
        }
        let mut row = SecretsRow::default();
        let mut matched = false;
        for (cell, column) in cells.iter().zip(columns.iter()) {
            match column {
                Some(Column::Name) => {
                    matched = cell_variable_name(cell)
                        .is_some_and(|name| name.eq_ignore_ascii_case(secret_name));
                }
                Some(Column::Sensitive) => row.sensitive = Some(cell.clone()),
                Some(Column::WhatItIs) => row.what_it_is = Some(cell.clone()),
                Some(Column::WhereToGet) => row.where_to_get = Some(cell.clone()),
                None => {}
            }
        }
        if matched {
            return Some(row);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/// Tokens that end in a full stop without ending a sentence. A token already
/// carrying a full stop ("e.g", "i.e", "app.notion.com") and a bare initial are
/// caught by shape; these are the rest.
const ABBREVIATIONS: &[&str] = &[
    "etc", "vs", "cf", "no", "approx", "fig", "al", "mr", "mrs", "ms", "dr", "st", "inc", "ltd",
    "co", "vol", "est", "min", "max",
];

/// The first sentence of a cell, split conservatively.
///
/// Every ambiguity resolves towards *not* splitting, because a bad split ships
/// a confident half-sentence and the card has a fallback for an absence. A
/// terminator counts only when it is outside a code span, is followed by the
/// end of the cell or by whitespace and something that opens a sentence, and is
/// not the end of an abbreviation or an initial. A cell with no terminator at
/// all is one sentence.
fn first_sentence(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut in_code = false;
    for (index, ch) in text.char_indices() {
        if ch == '`' {
            in_code = !in_code;
            continue;
        }
        if in_code || !matches!(ch, '.' | '!' | '?') {
            continue;
        }
        let after = index + ch.len_utf8();
        if after >= bytes.len() {
            return text;
        }
        let rest = &text[after..];
        let Some(next) = rest.chars().next() else {
            return text;
        };
        if !next.is_whitespace() {
            // A decimal point, or a dot inside a host, is not a full stop.
            continue;
        }
        let Some(opener) = rest.trim_start().chars().next() else {
            return text;
        };
        // A sentence opens with a capital, a digit, a code span or a quote.
        // Anything else and the terminator was part of the same sentence.
        if !(opener.is_uppercase()
            || opener.is_numeric()
            || matches!(opener, '`' | '"' | '\'' | '(' | '[' | '\u{201C}'))
        {
            continue;
        }
        if ch == '.' && ends_abbreviation(&text[..index]) {
            continue;
        }
        return &text[..after];
    }
    text
}

fn ends_abbreviation(head: &str) -> bool {
    let token = head
        .rsplit(|ch: char| ch.is_whitespace())
        .next()
        .unwrap_or_default();
    if token.is_empty() {
        return false;
    }
    // "e.g", "i.e", "U.S": the token is already carrying full stops.
    if token.contains('.') {
        return true;
    }
    // A single letter is an initial, not a sentence.
    if token.chars().count() == 1 && token.chars().all(char::is_alphabetic) {
        return true;
    }
    let lowered: String = token
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    ABBREVIATIONS.contains(&lowered.as_str())
}

/// The first sentence of a cell with any trailing clause that carries markup, a
/// link or a bare host cut off at the separator before it.
///
/// Notion's cell opens "The Installation access token of an internal
/// connection, starting with `ntn_`." The sanitizer refuses that string whole,
/// correctly: it carries a code span. Cutting at the comma recovers the
/// sentence the field wants, and the cut runs here, on the raw text, so what
/// the sanitizer finally judges is a string the pack itself wrote rather than
/// one we laundered.
fn first_usable_sentence(cell: &str) -> Option<String> {
    let sentence = first_sentence(cell.trim()).trim();
    if sentence.is_empty() {
        return None;
    }
    let mut clauses = split_clauses(sentence);
    while clauses
        .last()
        .is_some_and(|clause| card_text::carries_markup_or_link(clause))
    {
        clauses.pop();
    }
    if clauses.is_empty() {
        return None;
    }
    let mut kept = clauses.join("");
    let trimmed = kept.trim_end();
    kept.truncate(trimmed.len());
    let kept = kept
        .trim_end_matches([',', ';', ':'])
        .trim_end()
        .to_string();
    if kept.is_empty() {
        return None;
    }
    // The terminator came off with the cut clause more often than not, and a
    // card sentence ends in a full stop.
    if kept.ends_with(['.', '!', '?']) {
        Some(kept)
    } else {
        Some(format!("{kept}."))
    }
}

/// A sentence split at its top-level commas and semicolons, each piece keeping
/// its own separator so the kept pieces rejoin exactly as the pack wrote them.
fn split_clauses(sentence: &str) -> Vec<String> {
    let mut clauses: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_code = false;
    for ch in sentence.chars() {
        if ch == '`' {
            in_code = !in_code;
        }
        current.push(ch);
        if !in_code && matches!(ch, ',' | ';') {
            clauses.push(std::mem::take(&mut current));
        }
    }
    if !current.trim().is_empty() {
        clauses.push(current);
    }
    clauses
}

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------

/// Where a noun phrase stops and its qualification starts. "The Installation
/// access token of an internal connection." is a sentence; "Installation access
/// token" is a heading.
const LABEL_CUTS: &[&str] = &[
    " of ",
    " used in ",
    " used to ",
    " used for ",
    " used by ",
    " for ",
    " that ",
    " which ",
    " starting with ",
    " to use",
];

/// A heading reduced out of a sentence.
///
/// This is the weakest rule in the file and it knows it: it is a small
/// guess-machine that will meet packs nobody here wrote. It fails closed, to an
/// absence the card already handles as "Connect Notion", and it never repairs
/// capitalisation, because the provider's own capitalisation is the thing the
/// field is supposed to carry.
fn reduce_to_label(sentence: &str) -> Option<String> {
    let mut text = sentence
        .trim()
        .trim_end_matches(['.', '!', '?'])
        .trim()
        .to_string();
    for article in ["the ", "a ", "an "] {
        // `get` rather than an index: a cell whose opening characters are
        // multi-byte (any non-ASCII language, and packs are written in many)
        // would otherwise be sliced through the middle of a character and
        // panic the runtime. A non-boundary simply means this is not the
        // article we were looking for.
        let Some(head) = text.get(..article.len()) else {
            continue;
        };
        if head.eq_ignore_ascii_case(article) {
            text = text[article.len()..].trim_start().to_string();
            break;
        }
    }
    // ASCII lowercasing keeps every byte offset, so an index found here is an
    // index into the original.
    let folded: String = text.chars().map(|ch| ch.to_ascii_lowercase()).collect();
    let mut cut = text.len();
    for needle in LABEL_CUTS {
        if let Some(index) = folded.find(needle) {
            cut = cut.min(index);
        }
    }
    if let Some(index) = folded.find([',', ';', ':']) {
        cut = cut.min(index);
    }
    let label = text[..cut].trim().to_string();
    // A floor, because the cut can leave a word standing on its own: "The
    // address of the FreeFinance tenant to use." reduces to "address", which is
    // a heading that says nothing. Silence is the better answer there.
    let words = label.split_whitespace().count();
    if words < 2 || label.chars().count() < 6 {
        return None;
    }
    Some(label)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_label_whose_opening_characters_are_multi_byte_does_not_panic() {
        // Packs are written in many languages. Stripping a leading article by
        // byte count used to slice through a character here and bring the
        // runtime down; the only requirement is that it returns something or
        // nothing without panicking.
        for sentence in [
            "Der Technische Benutzer der Mandanten.",
            "Ünique access key for the workspace.",
            "aaaÜmlaut key.",
            "私のトークンです。",
            "a Ünique key.",
            "the Übersicht token.",
            "é",
            "",
        ] {
            let _ = reduce_to_label(sentence);
        }
    }

    use super::*;
    use std::fs;

    const NOTION_TABLE: &str = concat!(
        "## Secrets and settings\n\n",
        "| Name | Sensitive | What it is | Where the user gets it |\n",
        "| --- | --- | --- | --- |\n",
        "| `NOTION_API_KEY` | Yes | The Installation access token of an internal connection, ",
        "starting with `ntn_`. Notion now says connection where it used to say integration, and ",
        "Installation access token where it used to say internal integration secret; it is the ",
        "same value. | In the Notion developer portal, under Build, choose Internal connections, ",
        "then Create a new connection, name it and pick the workspace. The portal is at ",
        "`app.notion.com/developers/connections`. |\n",
    );

    fn row(markdown: &str, name: &str) -> SecretsRow {
        secrets_row(markdown, name).expect("row")
    }

    #[test]
    fn derives_the_notion_row_the_model_would_not_write() {
        let derived = derive("notion", &row(NOTION_TABLE, "NOTION_API_KEY"));
        assert_eq!(
            derived.description.as_deref(),
            Some("The Installation access token of an internal connection.")
        );
        assert_eq!(
            derived.value_label.as_deref(),
            Some("Installation access token")
        );
        assert_eq!(
            derived.where_to_get.as_deref(),
            Some(
                "In the Notion developer portal, under Build, choose Internal connections, then Create a new connection, name it and pick the workspace."
            )
        );
        assert_eq!(derived.sensitive, Some(true));
    }

    #[test]
    fn derived_strings_survive_the_sanitizer_they_are_judged_by() {
        // Derivation is worthless if what it produces is refused, so the two
        // are pinned together here rather than measured separately.
        let derived = derive("notion", &row(NOTION_TABLE, "NOTION_API_KEY"));
        let owner = Some("Notion");
        assert!(
            card_text::sanitize_card_text(
                derived.value_label.as_deref().unwrap(),
                card_text::CardTextField::ValueLabel,
                owner,
                Some("notion"),
            )
            .is_some()
        );
        assert!(
            card_text::sanitize_card_text(
                derived.description.as_deref().unwrap(),
                card_text::CardTextField::Description,
                owner,
                Some("notion"),
            )
            .is_some()
        );
        assert!(
            card_text::sanitize_card_text(
                derived.where_to_get.as_deref().unwrap(),
                card_text::CardTextField::WhereToGet,
                owner,
                Some("notion"),
            )
            .is_some()
        );
    }

    #[test]
    fn only_the_first_sentence_is_a_candidate() {
        // The second sentence of Notion's cell is a terminology footnote. It
        // passes every gate and is wrong on a card, so a cell whose first
        // sentence cannot be recovered yields nothing at all.
        let table = concat!(
            "| Name | What it is |\n",
            "| --- | --- |\n",
            "| `X_TOKEN` | `Only a code span here`. A perfectly clean later sentence. |\n",
        );
        let derived = derive("x", &row(table, "X_TOKEN"));
        assert_eq!(derived.description, None);
        assert_eq!(derived.value_label, None);
    }

    #[test]
    fn a_trailing_dirty_clause_is_cut_rather_than_costing_the_sentence() {
        assert_eq!(
            first_usable_sentence("The technical user's id, like `21334_21715633`.").as_deref(),
            Some("The technical user's id.")
        );
        assert_eq!(
            first_usable_sentence("See `app.notion.com/developers` for this.").as_deref(),
            None
        );
    }

    #[test]
    fn sentence_splitting_refuses_the_ambiguous_cases() {
        // A dot inside a code span, a decimal, an abbreviation and a missing
        // terminator each keep the sentence whole rather than half.
        assert_eq!(
            first_sentence("Set `demo.example.at` here. Next."),
            "Set `demo.example.at` here."
        );
        assert_eq!(
            first_sentence("A ratio of 1.5 applies here"),
            "A ratio of 1.5 applies here"
        );
        assert_eq!(
            first_sentence("Tokens, e.g. the client id, are shown once. Next."),
            "Tokens, e.g. the client id, are shown once."
        );
        assert_eq!(
            first_sentence("No terminator at all"),
            "No terminator at all"
        );
        assert_eq!(
            first_sentence("Ends the cell without a following sentence."),
            "Ends the cell without a following sentence."
        );
    }

    #[test]
    fn where_to_get_is_refused_rather_than_truncated() {
        let long = "x".repeat(card_text::MAX_WHERE_TO_GET_CHARS + 1);
        let table =
            format!("| Name | Where the user gets it |\n| --- | --- |\n| `X_TOKEN` | {long} |\n");
        let derived = derive("x", &row(&table, "X_TOKEN"));
        assert_eq!(derived.where_to_get, None);
    }

    #[test]
    fn columns_are_matched_by_header_not_by_position() {
        let table = concat!(
            "| Where to get it | Name | What it is |\n",
            "| --- | --- | --- |\n",
            "| Shown on the account page. | `X_TOKEN` | The account token. |\n",
        );
        let derived = derive("x", &row(table, "X_TOKEN"));
        assert_eq!(derived.description.as_deref(), Some("The account token."));
        assert_eq!(
            derived.where_to_get.as_deref(),
            Some("Shown on the account page.")
        );
    }

    #[test]
    fn an_unreadable_table_is_an_absence_and_never_a_mis_columning() {
        // No name column, a duplicated column, and a row whose cell count does
        // not match the header: each is a whole-table or whole-row refusal.
        assert!(secrets_row("| A | B |\n| --- | --- |\n| `X_TOKEN` | y |\n", "X_TOKEN").is_none());
        assert!(
            secrets_row(
                "| Name | What it is | What it is |\n| --- | --- | --- |\n| `X_TOKEN` | a | b |\n",
                "X_TOKEN",
            )
            .is_none()
        );
        assert!(
            secrets_row(
                "| Name | What it is |\n| --- | --- |\n| `X_TOKEN` | a | b |\n",
                "X_TOKEN",
            )
            .is_none()
        );
        assert!(secrets_row("no table here at all", "X_TOKEN").is_none());
    }

    #[test]
    fn an_escaped_pipe_stays_inside_its_cell() {
        let table = concat!(
            "| Name | What it is |\n",
            "| --- | --- |\n",
            "| `X_TOKEN` | The account token, true\\|false aside. |\n",
        );
        let derived = derive("x", &row(table, "X_TOKEN"));
        assert_eq!(
            derived.description.as_deref(),
            Some("The account token, true|false aside.")
        );
    }

    #[test]
    fn sensitive_reads_both_vocabularies_and_refuses_a_third() {
        assert_eq!(parse_sensitive("Yes"), Some(true));
        assert_eq!(parse_sensitive("No, optional"), Some(false));
        assert_eq!(parse_sensitive("Depends"), None);
        assert_eq!(parse_sensitive(""), None);
    }

    #[test]
    fn a_label_that_reduces_to_one_word_is_an_absence() {
        assert_eq!(
            reduce_to_label("The address of the FreeFinance tenant to use."),
            None
        );
        assert_eq!(
            reduce_to_label("The numeric Mandant id used in API paths.").as_deref(),
            Some("numeric Mandant id")
        );
        assert_eq!(
            reduce_to_label("The technical user's secret.").as_deref(),
            Some("technical user's secret")
        );
    }

    fn workspace_with(slug: &str, markdown: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = dir.path().join(SKILLS_ROOT).join(slug);
        fs::create_dir_all(&skill).expect("create skill dir");
        fs::write(skill.join("SKILL.md"), markdown).expect("write SKILL.md");
        dir
    }

    #[test]
    fn the_asking_skill_is_found_without_a_slug() {
        let dir = workspace_with("notion", NOTION_TABLE);
        let declared = declared_secret(dir.path(), "NOTION_API_KEY", None).expect("declared");
        assert_eq!(declared.skill_slug, "notion");
        assert!(declared.value_label.is_some());
        assert!(declared_secret(dir.path(), "OTHER_TOKEN", None).is_none());
    }

    #[test]
    fn two_skills_claiming_one_variable_resolve_to_nothing() {
        let dir = workspace_with("notion", NOTION_TABLE);
        let other = dir.path().join(SKILLS_ROOT).join("impostor");
        fs::create_dir_all(&other).expect("create dir");
        fs::write(other.join("SKILL.md"), NOTION_TABLE).expect("write");
        assert!(declared_secret(dir.path(), "NOTION_API_KEY", None).is_none());
    }

    #[test]
    fn a_named_slug_reads_only_that_skill() {
        let dir = workspace_with("notion", NOTION_TABLE);
        assert!(declared_secret(dir.path(), "NOTION_API_KEY", Some("notion")).is_some());
        assert!(declared_secret(dir.path(), "NOTION_API_KEY", Some("absent")).is_none());
        // A slug that is not a folder name cannot be made into one.
        assert!(declared_secret(dir.path(), "NOTION_API_KEY", Some("../../etc")).is_none());
    }
}
