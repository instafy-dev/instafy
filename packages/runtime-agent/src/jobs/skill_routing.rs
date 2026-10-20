//! Lexical skill routing: Unicode words, light folding, and per-source weights.
//!
//! A skill's routing evidence comes from three places that deserve different trust:
//! declared `routing_keywords` (the author's own list), the name and description (the
//! one-line summary every index shows), and a window of the body prose. Keywords decide;
//! prose only breaks ties. Multi-word keywords match only as whole phrases, so
//! `near me` does not fire on "a cafe near the station".
//!
//! Words are Unicode: letters and digits of any script, with Latin diacritics folded
//! ("café" meets "cafe"). Scripts written without spaces (Chinese, Japanese, Korean) are cut
//! into overlapping two-character pieces, so a keyword such as `地図` or `ダッシュボード`
//! matches inside a sentence. The router knows no topic: what a skill is for, in any
//! language, is the skill's own `routing_keywords`.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// Bytes of SKILL.md body (after the frontmatter) that count as routing prose.
pub(super) const BODY_WINDOW_BYTES: usize = 4096;
/// SKILL.md files are read up to this size for routing; larger files keep their head.
pub(super) const MAX_ROUTING_FILE_BYTES: usize = 64 * 1024;

const KEYWORD_WEIGHT: usize = 4;
const PHRASE_WEIGHT: usize = 4;
const MAX_MATCHED_TOKENS: usize = 12;

/// Function words with no routing signal in any source: English, the language skills are
/// written in, and Swedish and Spanish, whose short words meet English prose once folded
/// ("men", "var", "min"; "los" is how "lose" folds). A language whose words cannot meet an
/// English stem (Japanese, Chinese, Korean) needs no list; its grammar is kept out of skill prose
/// by `is_body_stop_word` instead. Plus the product name that every built-in skill carries.
///
/// The lists apply to every source after folding, so they also stop a few English content words:
/// "lose", "loses" and "losing" (as "los"), "favour" and "favor", "algo", "sin", "cons", "nose",
/// "lite". Those words never route a skill; `stop_words_also_stop_these_english_words` lists them.
#[rustfmt::skip]
const GENERIC_STOP_WORDS: &[&str] = &[
    // English
    "the", "and", "for", "are", "but", "not", "you", "your", "yours", "all", "any", "can",
    "had", "has", "have", "her", "his", "him", "she", "they", "them", "their", "theirs",
    "was", "were", "been", "being", "one", "our", "ours", "out", "how", "its", "may", "now",
    "who", "whom", "did", "does", "doing", "get", "got", "let", "put", "say", "too", "use",
    "this", "that", "these", "those", "with", "from", "into", "onto", "will", "would",
    "should", "could", "shall", "might", "must", "there", "here", "what", "when", "where",
    "which", "while", "why", "about", "than", "then", "some", "such", "very", "just",
    "also", "only", "other", "more", "most", "much", "each", "both", "over", "under",
    "after", "before", "because", "between", "please", "want", "need", "like", "make",
    "help", "show", "give", "tell", "able", "via", "per", "yes", "okay", "ok", "thanks",
    "thank", "hey", "hello", "hi", "something", "anything", "everything", "thing", "things",
    "way", "lot", "lots", "really", "maybe", "good", "best", "new", "own", "same", "even",
    "still", "yet", "again", "ever", "never", "always", "often", "sure", "well", "back",
    "down", "off", "upon", "within", "without", "across", "along", "around", "through",
    "during", "until", "since", "whether", "either", "neither", "every", "into", "these",
    "those", "myself", "yourself", "ourselves", "themselves", "i'm", "i've", "it's",
    "let's", "don't",
    // Swedish
    "och", "att", "det", "som", "för", "med", "den", "har", "inte", "ett", "var", "ska",
    "skulle", "vill", "kan", "kunna", "till", "från", "här", "där", "mitt", "min", "mina",
    "din", "ditt", "dina", "vår", "vårt", "våra", "oss", "dem", "hur", "vad", "vilken",
    "vilket", "vilka", "eller", "men", "också", "bara", "jag", "du", "han", "hon", "de",
    "vi", "ni", "dig", "mig", "sig", "sin", "sitt", "sina", "när", "nu", "då", "om", "av",
    "på", "är", "blir", "bli", "varit", "hade", "detta", "dessa", "denna", "något", "några",
    "lite", "mycket", "alla", "allt", "efter", "innan", "under", "över", "utan", "mot",
    "hos", "åt", "the",
    // Spanish
    "los", "las", "del", "con", "una", "uno", "unos", "unas", "para", "por", "que", "como",
    "más", "pero", "sus", "mis", "tus", "este", "esta", "estos", "estas", "ese", "esa", "eso",
    "hay", "son", "está", "están", "ser", "muy", "sin", "sobre", "entre", "cuando", "donde",
    "cual", "quien", "también", "porque", "mucho", "poco", "algo", "nos", "les", "ella",
    "ellos", "usted", "quiero", "necesito", "puedes", "favor",
    // Product name: present in every built-in skill's name and prose.
    "instafy",
];

/// Prose that SKILL.md bodies use for procedure rather than topic. These words made a long
/// builder skill win cron, CSS and invoice requests through its instructions ("every night",
/// "set", "fix", "write", "hours", "where"). Descriptions use the same procedural voice ("Before
/// writing anything, read …"), so the list applies to them too; a word still counts when a skill
/// declares it as a keyword or uses it in its name. Failure words stay: they route diagnostics.
#[rustfmt::skip]
const BODY_STOP_WORDS: &[&str] = &[
    "night", "nights", "set", "fix", "write", "hours", "hour", "first", "step", "steps",
    "run", "runs", "read", "file", "files", "used", "user", "users", "request", "requests",
    "skill", "skills", "command", "commands", "reply", "answer", "check", "open", "add",
    "time", "turn", "turns", "agent", "agents", "octo", "work", "keep", "start", "stop",
    "done", "follow", "following", "example", "examples", "note", "notes", "rule", "rules",
    "always", "never", "instead", "already", "next", "last", "once", "twice", "line",
    "lines", "text", "word", "words", "name", "names", "value", "values", "see", "look",
    "know", "ask", "asks", "said", "says", "call", "calls", "return", "returns", "true",
    "false", "null", "json", "type", "kind", "mode", "default", "option", "options", "flag",
    "flags", "path", "paths", "output", "input", "result", "results", "case", "cases",
];

/// Scripts written without spaces between words: CJK ideographs, kana, Hangul.
fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F | 0x20000..=0x2FA1F)
}

/// A Latin letter with diacritics as its plain ASCII letter ("é" as "e", "ö" as "o"); any other
/// character as it is.
fn fold_latin_diacritic(ch: char) -> char {
    if ch.is_ascii() {
        return ch;
    }
    let mut parts = ch.nfd();
    match parts.next() {
        Some(base) if base.is_ascii_alphabetic() && parts.all(is_combining_mark) => base,
        _ => ch,
    }
}

fn push_cjk_run(words: &mut Vec<String>, run: &mut Vec<char>) {
    match run.len() {
        0 => {}
        1 => words.push(run[0].to_string()),
        _ => words.extend(run.windows(2).map(|pair| pair.iter().collect::<String>())),
    }
    run.clear();
}

fn push_word(words: &mut Vec<String>, word: &mut String) {
    if !word.is_empty() {
        words.push(std::mem::take(word));
    }
}

/// Lowercased words in order. Unicode-aware: "jämför" stays one word (folded to "jamfor"),
/// never ASCII fragments. A run of CJK characters becomes its overlapping two-character
/// pieces ("台北の地図" gives 台北, 北の, の地, 地図); a lone CJK character stays one word.
/// The text is NFKC-normalized first, so decomposed kana and Hangul, fullwidth Latin ("ｍａｐ")
/// and half-width kana meet their usual forms, and it is lowercased as a whole, so a final
/// Greek sigma stays final ("ΧΆΡΤΗΣ" is "χάρτης").
pub(super) fn routing_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut cjk_run: Vec<char> = Vec::new();
    let text = input.nfkc().collect::<String>().to_lowercase();
    for ch in text.chars() {
        if ch.is_alphanumeric() && is_cjk(ch) {
            push_word(&mut words, &mut word);
            cjk_run.push(ch);
        } else if is_combining_mark(ch) {
            // Already-decomposed text: a mark on a CJK character (a kana voicing mark) is part
            // of it; one on a Latin letter is dropped like a folded diacritic; elsewhere
            // (Devanagari vowel signs) it is part of the word.
            if !cjk_run.is_empty() {
                cjk_run.push(ch);
            } else if !word.is_empty() && !word.ends_with(|last: char| last.is_ascii_alphabetic()) {
                word.push(ch);
            }
        } else if ch.is_alphanumeric() {
            push_cjk_run(&mut words, &mut cjk_run);
            word.push(fold_latin_diacritic(ch));
        } else {
            push_word(&mut words, &mut word);
            push_cjk_run(&mut words, &mut cjk_run);
        }
    }
    push_word(&mut words, &mut word);
    push_cjk_run(&mut words, &mut cjk_run);
    words
}

fn undouble_final_consonant(word: &mut String) {
    let bytes = word.as_bytes();
    let len = bytes.len();
    if len >= 3 {
        let last = bytes[len - 1];
        if last == bytes[len - 2] && !b"aeiouylsfz".contains(&last) {
            word.pop();
        }
    }
}

/// Folds spelling variants and simple inflections so a prompt and a skill meet on one form:
/// colour/color, visualise/visualize, charts/chart, tracking/track, cities/city,
/// compare/comparing. Only ASCII words are folded (Latin words are ASCII once their diacritics
/// are folded); other scripts are kept as written. The same function runs on both sides, so an
/// imperfect stem still matches itself.
pub(super) fn fold_routing_word(word: &str) -> String {
    let mut w = word.to_string();
    if !w.is_ascii() || w.chars().any(|ch| ch.is_ascii_digit()) {
        return w;
    }
    // British -our- (neighbour, colour, favourite).
    if w.len() >= 6 {
        if let Some(index) = w[1..].find("our") {
            let start = index + 1;
            w.replace_range(start..start + 3, "or");
        }
    }
    // -ise/-isation spellings.
    if w.len() >= 7 {
        for (from, to) in [
            ("isation", "ization"),
            ("ising", "izing"),
            ("ised", "ized"),
            ("ises", "izes"),
            ("ise", "ize"),
        ] {
            if w.ends_with(from) {
                w.truncate(w.len() - from.len());
                w.push_str(to);
                break;
            }
        }
    }
    // Plurals and -ing.
    let len = w.len();
    if len >= 5 && w.ends_with("ies") {
        w.truncate(len - 3);
        w.push('y');
    } else if len >= 6 && w.ends_with("ing") {
        w.truncate(len - 3);
        undouble_final_consonant(&mut w);
    } else if len >= 5
        && (w.ends_with("ches") || w.ends_with("shes") || w.ends_with("xes") || w.ends_with("sses"))
    {
        w.truncate(len - 2);
    } else if len >= 4
        && w.ends_with('s')
        && !w.ends_with("ss")
        && !w.ends_with("us")
        && !w.ends_with("is")
    {
        w.pop();
    }
    // A final silent e (route/routing, compare/comparing, cafe/cafes).
    if w.len() >= 4 && w.ends_with('e') && !w.ends_with("ee") {
        w.pop();
    }
    w
}

/// A stop list as the words `routing_words` yields ("för" as "for"), each also folded, so
/// inflections are stopped too ("writes" and "writing" like "write", "nights" like "night").
fn stop_set(list: &[&str]) -> HashSet<String> {
    let mut set = HashSet::new();
    for entry in list {
        for word in routing_words(entry) {
            set.insert(fold_routing_word(&word));
            set.insert(word);
        }
    }
    set
}

static GENERIC_STOP_SET: Lazy<HashSet<String>> = Lazy::new(|| stop_set(GENERIC_STOP_WORDS));
static BODY_STOP_SET: Lazy<HashSet<String>> = Lazy::new(|| stop_set(BODY_STOP_WORDS));

fn is_generic_stop_word(word: &str) -> bool {
    GENERIC_STOP_SET.contains(word) || GENERIC_STOP_SET.contains(&fold_routing_word(word))
}

fn is_hiragana(ch: char) -> bool {
    matches!(ch as u32, 0x3041..=0x309F)
}

/// Prose stop words: the procedural list, and any CJK piece with hiragana in it. Japanese grammar
/// is written in hiragana (くだ, ださ, さい from ください; して, する), so in a skill's prose such a
/// piece says nothing about its topic and would meet every polite Japanese ask. Content words are
/// kanji and katakana pieces (地図, デプ). A declared keyword in hiragana still counts.
fn is_body_stop_word(word: &str) -> bool {
    BODY_STOP_SET.contains(word)
        || BODY_STOP_SET.contains(&fold_routing_word(word))
        || (word.chars().all(is_cjk) && word.chars().any(is_hiragana))
}

fn long_enough(word: &str) -> bool {
    let count = word.chars().count();
    count >= 3 || (count == 2 && word.chars().all(is_cjk))
}

/// One CJK character ("表", "图"): too short for prose, but a keyword when a skill declares it.
fn is_cjk_character(word: &str) -> bool {
    let mut chars = word.chars();
    matches!((chars.next(), chars.next()), (Some(ch), None) if is_cjk(ch))
}

fn routing_tokens_with(input: &str, extra_stop: fn(&str) -> bool) -> HashSet<String> {
    routing_words(input)
        .into_iter()
        .filter(|word| long_enough(word) && !is_generic_stop_word(word) && !extra_stop(word))
        .map(|word| fold_routing_word(&word))
        .filter(|token| long_enough(token))
        .collect()
}

/// Content tokens of `input`: Unicode words of 3+ characters (CJK two-character pieces), minus
/// function words, folded.
pub(super) fn tokenize_for_routing(input: &str) -> HashSet<String> {
    routing_tokens_with(input, |_| false)
}

/// Every word of `input`, folded and in order, for phrase matching ("near me" keeps "me", and a
/// CJK keyword longer than two characters is the phrase of its pieces).
pub(super) fn routing_phrase_words(input: &str) -> Vec<String> {
    routing_words(input)
        .iter()
        .map(|word| fold_routing_word(word))
        .collect()
}

/// Splits `---` frontmatter from the body. Without frontmatter the whole text is body.
pub(super) fn split_front_matter(raw: &str) -> (&str, &str) {
    let mut offset = 0usize;
    let mut lines = raw.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return ("", raw);
    };
    if first.trim() != "---" {
        return ("", raw);
    }
    offset += first.len();
    for line in lines {
        offset += line.len();
        if line.trim() == "---" {
            return (&raw[..offset], &raw[offset..]);
        }
    }
    // Unterminated frontmatter: treat it all as frontmatter, no body.
    (raw, "")
}

/// The first `BODY_WINDOW_BYTES` of a body, cut on a character boundary.
pub(super) fn body_window(body: &str) -> &str {
    let body = body.trim_start();
    if body.len() <= BODY_WINDOW_BYTES {
        return body;
    }
    let mut end = BODY_WINDOW_BYTES;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    &body[..end]
}

/// A multi-word keyword: its folded words in order, and the keyword as written for reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RoutingPhrase {
    pub(super) words: Vec<String>,
    pub(super) label: String,
}

/// One skill's routing evidence, by source.
#[derive(Debug, Clone, Default)]
pub(super) struct SkillRoutingProfile {
    /// Single-word `routing_keywords`, folded.
    pub(super) keywords: HashSet<String>,
    /// Multi-word `routing_keywords` (and CJK ones longer than two characters); matched only
    /// as a whole.
    pub(super) phrases: Vec<RoutingPhrase>,
    /// Tokens of the id, name and description.
    pub(super) summary: HashSet<String>,
    /// Tokens of the body window not already in the sets above.
    pub(super) body: HashSet<String>,
}

impl SkillRoutingProfile {
    pub(super) fn build(
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        routing_keywords: &[String],
        body: &str,
    ) -> Self {
        let mut keywords = HashSet::new();
        let mut phrases = Vec::new();
        for entry in routing_keywords {
            let words = routing_words(entry);
            match words.len() {
                0 => {}
                1 => {
                    let word = &words[0];
                    if is_cjk_character(word) {
                        keywords.insert(word.clone());
                    } else if long_enough(word) && !is_generic_stop_word(word) {
                        let token = fold_routing_word(word);
                        if long_enough(&token) {
                            keywords.insert(token);
                        }
                    }
                }
                _ => {
                    let folded: Vec<String> =
                        words.iter().map(|word| fold_routing_word(word)).collect();
                    if !phrases
                        .iter()
                        .any(|phrase: &RoutingPhrase| phrase.words == folded)
                    {
                        phrases.push(RoutingPhrase {
                            words: folded,
                            label: entry.trim().to_lowercase(),
                        });
                    }
                }
            }
        }

        let mut summary_text = String::from(id);
        if let Some(name) = name {
            summary_text.push('\n');
            summary_text.push_str(name);
        }
        let mut summary = tokenize_for_routing(&summary_text);
        if let Some(description) = description {
            summary.extend(routing_tokens_with(description, is_body_stop_word));
        }
        summary.retain(|token| !keywords.contains(token));

        let mut body_tokens = routing_tokens_with(body, is_body_stop_word);
        body_tokens.retain(|token| !keywords.contains(token) && !summary.contains(token));

        Self {
            keywords,
            phrases,
            summary,
            body: body_tokens,
        }
    }

    /// Every single token, for document frequency.
    pub(super) fn tokens(&self) -> impl Iterator<Item = &String> {
        self.keywords
            .iter()
            .chain(self.summary.iter())
            .chain(self.body.iter())
    }

    pub(super) fn is_empty(&self) -> bool {
        self.keywords.is_empty()
            && self.phrases.is_empty()
            && self.summary.is_empty()
            && self.body.is_empty()
    }
}

/// A prompt prepared once for scoring against every skill.
#[derive(Debug, Clone, Default)]
pub(super) struct PromptRoutingTerms {
    pub(super) tokens: HashSet<String>,
    pub(super) words: Vec<String>,
}

impl PromptRoutingTerms {
    pub(super) fn new(prompt_text: &str) -> Self {
        let words = routing_phrase_words(prompt_text);
        let mut tokens = tokenize_for_routing(prompt_text);
        // Every CJK character on its own as well: it can only meet a one-character keyword a
        // skill declared (prose never yields one), so "表を作って" meets 表.
        for word in &words {
            if word.chars().all(is_cjk) {
                tokens.extend(word.chars().map(String::from));
            }
        }
        Self { tokens, words }
    }

    fn contains_phrase(&self, phrase: &[String]) -> bool {
        !phrase.is_empty()
            && self.words.len() >= phrase.len()
            && self
                .words
                .windows(phrase.len())
                .any(|window| window == phrase)
    }
}

pub(super) fn routing_doc_freq<'a>(
    profiles: impl IntoIterator<Item = &'a SkillRoutingProfile>,
) -> HashMap<String, usize> {
    let mut doc_freq: HashMap<String, usize> = HashMap::new();
    for profile in profiles {
        for token in profile.tokens() {
            *doc_freq.entry(token.clone()).or_default() += 1;
        }
    }
    doc_freq
}

fn summary_weight(doc_freq: usize) -> usize {
    match doc_freq {
        0..=2 => 2,
        3 => 1,
        _ => 0,
    }
}

/// A skill that declares `routing_keywords` has said what it is for: its prose only breaks ties.
/// A skill without keywords (most learned blocks, older imports) is routed by its prose, so a
/// word only it uses still counts 3 (below a declared keyword's 4).
fn body_weight(doc_freq: usize, declares_keywords: bool) -> usize {
    match (doc_freq, declares_keywords) {
        (0..=1, false) => 3,
        (0..=2, _) => 1,
        _ => 0,
    }
}

/// Lexical score of one skill for a prompt, with the tokens and phrases that matched.
/// A declared keyword or phrase weighs 4 whatever other skills declare; a name/description
/// token 2 (1 when three skills share it); a body token 1, and only when at most two skills
/// use it (3 when the skill declares no keywords and no other skill uses the word).
pub(super) fn score_routing_profile(
    prompt: &PromptRoutingTerms,
    doc_freq: &HashMap<String, usize>,
    profile: &SkillRoutingProfile,
) -> (usize, Vec<String>) {
    let declares_keywords = !profile.keywords.is_empty() || !profile.phrases.is_empty();
    let mut weighted: Vec<(usize, String)> = Vec::new();
    let mut topical_hit = false;
    for token in &prompt.tokens {
        let df = doc_freq.get(token).copied().unwrap_or(1);
        let weight = if profile.keywords.contains(token) {
            topical_hit = true;
            KEYWORD_WEIGHT
        } else if profile.summary.contains(token) {
            let weight = summary_weight(df);
            topical_hit |= weight > 0;
            weight
        } else if profile.body.contains(token) {
            body_weight(df, declares_keywords)
        } else {
            continue;
        };
        if weight > 0 {
            weighted.push((weight, token.clone()));
        }
    }
    topical_hit |= profile
        .phrases
        .iter()
        .any(|phrase| prompt.contains_phrase(&phrase.words));
    if declares_keywords && !topical_hit {
        // Keywords decide: prose alone ("test with --dry-run") never routes a skill that has
        // said what it is for.
        return (0, Vec::new());
    }
    weighted.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    weighted.truncate(MAX_MATCHED_TOKENS);

    let mut score: usize = weighted.iter().map(|(weight, _)| *weight).sum();
    let mut matched: Vec<String> = weighted.into_iter().map(|(_, token)| token).collect();
    for phrase in &profile.phrases {
        if prompt.contains_phrase(&phrase.words) {
            score = score.saturating_add(PHRASE_WEIGHT);
            matched.push(phrase.label.clone());
        }
    }
    (score, matched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keywords(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn tokenizer_keeps_non_ascii_words_whole() {
        let tokens = tokenize_for_routing("jämför de här tre bilarna, vilket gym ligger närmast?");
        assert!(tokens.contains("jamfor"), "{tokens:?}");
        assert!(tokens.contains("bilarna"));
        assert!(tokens.contains("narmast"));
        assert!(tokens.contains("gym"));
        assert!(!tokens.contains("rmast"), "no ASCII fragments");
        assert!(
            !tokens.contains("vilket"),
            "Swedish function words are stop words"
        );
        assert!(!tokens.contains("har"), "`här` is stopped once folded");
    }

    #[test]
    fn latin_diacritics_fold_on_both_sides() {
        assert_eq!(
            routing_words("Café CRÈME naïve"),
            ["cafe", "creme", "naive"]
        );
        // Already-decomposed input folds the same way.
        assert_eq!(routing_words("cafe\u{301}"), ["cafe"]);
        assert_eq!(
            tokenize_for_routing("gráficos de las ventas"),
            tokenize_for_routing("graficos de las ventas")
        );
        // Letters without an ASCII base, and other scripts, are kept as written.
        assert_eq!(routing_words("straße карта"), ["straße", "карта"]);
        assert_eq!(routing_words("हिन्दी"), ["हिन्दी"]);
    }

    #[test]
    fn cjk_runs_become_overlapping_pairs() {
        assert_eq!(
            routing_words("台北の地図を作って"),
            [
                "台北", "北の", "の地", "地図", "図を", "を作", "作っ", "って"
            ]
        );
        // Script changes and punctuation end a run; a lone character stays one word.
        assert_eq!(
            routing_words("Excelの表、地図。"),
            ["excel", "の表", "地図"]
        );
        assert_eq!(routing_words("表"), ["表"]);
        assert!(
            tokenize_for_routing("表").is_empty(),
            "one character is too short"
        );
        // Hangul is cut the same way.
        assert_eq!(routing_words("지도"), ["지도"]);
    }

    #[test]
    fn folding_meets_spelling_and_inflection_variants() {
        for (a, b) in [
            ("neighbourhoods", "neighborhood"),
            ("colours", "color"),
            ("visualise", "visualize"),
            ("visualising", "visualize"),
            ("charts", "chart"),
            ("tracking", "track"),
            ("cities", "city"),
            ("routes", "routing"),
            ("comparing", "compare"),
            ("cafés", "cafe"),
            ("running", "run"),
            ("shopping", "shop"),
            ("batches", "batch"),
            ("mapas", "mapa"),
            ("listas", "lista"),
        ] {
            let a = fold_routing_word(&routing_words(a)[0]);
            let b = fold_routing_word(&routing_words(b)[0]);
            assert_eq!(a, b);
        }
        assert_eq!(fold_routing_word("status"), "status");
        assert_eq!(fold_routing_word("address"), "address");
        assert_eq!(fold_routing_word("地図"), "地図");
    }

    #[test]
    fn body_window_starts_after_the_frontmatter() {
        let raw = "---\nname: x\nrouting_keywords: a, b\n---\n\n# Body\nhello";
        let (front, body) = split_front_matter(raw);
        assert!(front.contains("routing_keywords"));
        assert_eq!(body_window(body), "# Body\nhello");
        let (front, body) = split_front_matter("Name: y\nDescription: z\n");
        assert!(front.is_empty());
        assert!(body.contains("Description"));
    }

    #[test]
    fn prose_alone_does_not_route_a_skill_with_keywords() {
        let builder = SkillRoutingProfile::build(
            "page-builder",
            None,
            Some("Build live pages whose buttons run checks."),
            &keywords(&["price"]),
            "Test it with --dry-run. The handler writes records.",
        );
        let learned = SkillRoutingProfile::build(
            "release-notes",
            None,
            None,
            &[],
            "Draft the changelog from merged pull requests.",
        );
        let doc_freq = routing_doc_freq([&builder, &learned]);
        let unit_test = PromptRoutingTerms::new("add a unit test for the date parser");
        assert_eq!(score_routing_profile(&unit_test, &doc_freq, &builder).0, 0);
        let price_test = PromptRoutingTerms::new("test the price checks");
        assert!(score_routing_profile(&price_test, &doc_freq, &builder).0 > 4);
        // Without keywords, prose is what routes a skill.
        let changelog = PromptRoutingTerms::new("write the changelog");
        assert_eq!(score_routing_profile(&changelog, &doc_freq, &learned).0, 3);
        // Inflected stop words are stopped too.
        assert!(!builder.body.contains(&fold_routing_word("writes")));
    }

    #[test]
    fn keywords_outweigh_prose_and_phrases_match_whole() {
        let charts = SkillRoutingProfile::build(
            "chart-builder",
            Some("chart-builder"),
            Some("Build chart pages."),
            &keywords(&["chart", "side by side"]),
            "Run this every night and fix where the hours are set.",
        );
        let location = SkillRoutingProfile::build(
            "location-sharing",
            None,
            Some("Ask for the user's position."),
            &keywords(&["near me"]),
            "",
        );
        let doc_freq = routing_doc_freq([&charts, &location]);

        let prompt = PromptRoutingTerms::new("charts of sales near the office, side by side");
        let (chart_score, matched) = score_routing_profile(&prompt, &doc_freq, &charts);
        assert_eq!(chart_score, 8, "{matched:?}");
        let (location_score, _) = score_routing_profile(&prompt, &doc_freq, &location);
        assert_eq!(location_score, 0, "`near me` must not fire on `near`");

        let near_me = PromptRoutingTerms::new("which cafe is open near me?");
        assert_eq!(score_routing_profile(&near_me, &doc_freq, &location).0, 4);

        let cron =
            PromptRoutingTerms::new("set up a cron job that backs up the database every night");
        assert_eq!(score_routing_profile(&cron, &doc_freq, &charts).0, 0);
    }

    #[test]
    fn function_words_do_not_meet_english_stems() {
        // A learned block without keywords is routed by its prose; Spanish "los" is how
        // "lose" folds, Swedish "men" and "min" are English words.
        let learned = SkillRoutingProfile::build(
            "conflict-notes",
            None,
            None,
            &[],
            "Never lose work. Men and women; wait one min.",
        );
        let doc_freq = routing_doc_freq([&learned]);
        for prompt in [
            "lista los archivos del último commit",
            "men vad är min uppgift",
        ] {
            let terms = PromptRoutingTerms::new(prompt);
            assert_eq!(
                score_routing_profile(&terms, &doc_freq, &learned).0,
                0,
                "{prompt}"
            );
        }
    }

    #[test]
    fn japanese_grammar_in_prose_meets_no_ask() {
        // A learned block written in Japanese has no keywords and is routed by its prose: the
        // hiragana pieces of "してください" must not meet every other polite Japanese ask.
        let learned = SkillRoutingProfile::build(
            "deploy-notes",
            None,
            None,
            &[],
            "デプロイする前にテストを実行してください。失敗したらログを確認する。",
        );
        let doc_freq = routing_doc_freq([&learned]);
        let score = |prompt: &str| {
            score_routing_profile(&PromptRoutingTerms::new(prompt), &doc_freq, &learned).0
        };
        assert_eq!(score("東京のカフェを地図で見せてください"), 0);
        assert_eq!(score("レシピを作ってください"), 0);
        // Its own topic still routes it: デプロイ is katakana, テスト too.
        assert!(score("デプロイの前にテストを走らせたい") > 0);
        // A keyword in hiragana is still a keyword.
        let sushi =
            SkillRoutingProfile::build("sushi", None, None, &keywords(&["すし"]), "すしの店");
        let doc_freq = routing_doc_freq([&sushi]);
        let terms = PromptRoutingTerms::new("近くのすしを教えて");
        assert_eq!(score_routing_profile(&terms, &doc_freq, &sushi).0, 4);
    }

    #[test]
    fn decomposed_fullwidth_and_cased_text_meet_their_usual_forms() {
        let maps = SkillRoutingProfile::build(
            "map-builder",
            None,
            Some("Build map pages."),
            &keywords(&["map", "ガイド", "지도", "χάρτης"]),
            "",
        );
        let doc_freq = routing_doc_freq([&maps]);
        let score = |prompt: &str| {
            score_routing_profile(&PromptRoutingTerms::new(prompt), &doc_freq, &maps).0
        };
        // Decomposed kana (カ + voicing mark) and decomposed Hangul (Jamo).
        let nfd_kana: String = "ガイドを作って".nfd().collect();
        assert_eq!(score(&nfd_kana), 4);
        let nfd_hangul: String = "서울 지도를 보여줘".nfd().collect();
        assert_eq!(score(&nfd_hangul), 4);
        // Fullwidth Latin, and a capital Greek word ending in sigma.
        assert_eq!(score("ｍａｐ of cafés"), 4);
        assert_eq!(score("ΧΆΡΤΗΣ ΤΗΣ ΑΘΗΝΑΣ"), 4);
    }

    #[test]
    fn a_one_character_cjk_keyword_is_kept_and_meets_a_sentence() {
        let tables =
            SkillRoutingProfile::build("table-builder", None, None, &keywords(&["表", "图"]), "");
        assert!(tables.keywords.contains("表") && tables.keywords.contains("图"));
        let doc_freq = routing_doc_freq([&tables]);
        let terms = PromptRoutingTerms::new("売上の表を作って");
        assert_eq!(score_routing_profile(&terms, &doc_freq, &tables).0, 4);
        // Prose never yields one character, so a lone character meets nothing else.
        let prose = SkillRoutingProfile::build("notes", None, None, &[], "売上の表を作る手順");
        assert!(!prose.body.contains("表"));
    }

    #[test]
    fn stop_words_also_stop_these_english_words() {
        // The documented trade-off of folding Spanish and Swedish function words with English.
        for word in [
            "lose", "loses", "losing", "favour", "favor", "algo", "sin", "cons", "nose", "lite",
        ] {
            assert!(
                tokenize_for_routing(word).is_empty(),
                "{word} is expected to be stopped"
            );
        }
        for word in ["lost", "losses", "favorite"] {
            assert!(
                !tokenize_for_routing(word).is_empty(),
                "{word} still routes"
            );
        }
    }

    #[test]
    fn cjk_keywords_match_inside_a_sentence() {
        let maps = SkillRoutingProfile::build(
            "map-builder",
            None,
            Some("Build map pages."),
            &keywords(&["map", "地図", "マップ"]),
            "",
        );
        let dashboards = SkillRoutingProfile::build(
            "dashboard-builder",
            None,
            Some("Build dashboards."),
            &keywords(&["dashboard", "ダッシュボード"]),
            "",
        );
        assert!(
            maps.keywords.contains("地図"),
            "a two-character keyword is a word"
        );
        assert!(
            dashboards
                .phrases
                .iter()
                .any(|phrase| phrase.words == routing_words("ダッシュボード")
                    && phrase.label == "ダッシュボード"),
            "a longer one is the phrase of its pieces"
        );
        let doc_freq = routing_doc_freq([&maps, &dashboards]);
        let score = |prompt: &str, profile: &SkillRoutingProfile| {
            score_routing_profile(&PromptRoutingTerms::new(prompt), &doc_freq, profile).0
        };
        assert_eq!(score("東京のカフェを地図で見せて", &maps), 4);
        assert_eq!(score("東京のカフェをマップで見せて", &maps), 4);
        assert_eq!(score("東京のカフェを地図で見せて", &dashboards), 0);
        assert_eq!(score("週間登録数のダッシュボードを作って", &dashboards), 4);
        assert_eq!(score("週間登録数のダッシュボードを作って", &maps), 0);
        // Pieces of a keyword are not the keyword: ダッシュ alone is not ダッシュボード.
        assert_eq!(score("ダッシュで駅まで", &dashboards), 0);
    }
}
