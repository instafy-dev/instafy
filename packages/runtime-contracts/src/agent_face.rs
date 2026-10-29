//! The face of every AI without a picture of its own (docs/Brand.md, "Octo's
//! hatchlings"): one of Octo's eight hatchlings, the hollow hatchling for an AI
//! known only from text, or Octo's own tile. People never reach this module;
//! they stay round, with a photo or initials.
//!
//! [`resolve_agent_face`] is the one resolver. Studio draws every AI face with
//! its copy (`packages/frontend/src/utils/aiFace.ts`), and the controller reads
//! it to know which faces a chat already shows. `agent_face_fixtures.json` pins
//! both, so a rule changed on one side and not the other fails both suites.
//!
//! [`allocate_faces`] is the controller's half. When it dispatches an AI without
//! a profile, it stamps the face that AI keeps in the chat (`hatchling:<n>` in
//! `metadata.agent.avatarSeed`), and every later run, message and Home row of
//! that AI carries the stamp. Nothing here reads a database or a clock: the
//! caller passes in what it read.

use std::collections::HashMap;

/// How many hatchlings there are: 1 hooray, 2 drift, 3 kick, 4 twirl, 5 wave,
/// 6 catch, 7 rest and 8 swim. Frozen: stamps live on in stored rows, so a face
/// is never renumbered and no ninth is added under [`HATCHLING_SEED_PREFIX`].
/// Faces drawn later take a new seed prefix.
pub const HATCHLING_FACES: u8 = 8;

/// The modulus that maps a legacy seed's hash to a hatchling
/// ([`legacy_hatchling`]). Frozen with [`HATCHLING_FACES`], which it equals:
/// changing it would move the face of every saved agent whose seed is its id
/// and of every row stamped before the controller stamped faces.
pub const HATCHLING_HASH_MODULUS: u32 = 8;

/// The prefix of a stamp, `hatchling:<n>` ([`parse_hatchling_seed`]).
pub const HATCHLING_SEED_PREFIX: &str = "hatchling:";

/// Octo's handle and its alias, as Studio's core assistant provider registers
/// them (`coreAssistantProvider.ts`). The controller names Octo `octo`.
const OCTO_HANDLES: [&str; 2] = ["octo", "ai"];

const FNV_OFFSET_BASIS: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

/// One of the eight hatchlings, numbered from 1 to [`HATCHLING_FACES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hatchling(u8);

impl Hatchling {
    /// Hatchling `number`, or `None` outside 1 to [`HATCHLING_FACES`].
    pub fn new(number: u8) -> Option<Self> {
        (1..=HATCHLING_FACES)
            .contains(&number)
            .then_some(Self(number))
    }

    /// The face's number, from 1 to [`HATCHLING_FACES`].
    pub fn number(self) -> u8 {
        self.0
    }

    /// Every hatchling, 1 first.
    pub fn all() -> impl DoubleEndedIterator<Item = Self> {
        (1..=HATCHLING_FACES).map(Self)
    }

    fn index(self) -> usize {
        usize::from(self.0 - 1)
    }
}

/// The hatchling a stamp names. A stamp is exactly `hatchling:<n>` with `n`
/// from 1 to 8, so a stored stamp means one face everywhere: no leading zero,
/// sign, space, other digit or case variant (`hatchling:03`, `hatchling: 3`,
/// ` hatchling:3`, `Hatchling:3`). The bare `hatchling` is not a stamp, and the
/// hollow face has none. A seed that is not a stamp is a legacy seed
/// ([`legacy_hatchling`]).
pub fn parse_hatchling_seed(seed: &str) -> Option<Hatchling> {
    match seed.strip_prefix(HATCHLING_SEED_PREFIX)?.as_bytes() {
        [digit @ b'1'..=b'9'] => Hatchling::new(digit - b'0'),
        _ => None,
    }
}

/// The stamp for `face`, `hatchling:<n>`: what the controller writes into
/// `metadata.agent.avatarSeed`, and what Studio saves as a saved agent's chosen
/// face.
pub fn hatchling_seed(face: Hatchling) -> String {
    format!("{HATCHLING_SEED_PREFIX}{}", face.0)
}

/// Whether a seed is a picture: after trimming, a path (`/`), a `data:image/`
/// URI or an `http://` or `https://` URL, the scheme in any case. This is
/// Studio's `normalizeCustomAgentAvatarSrc`, so `data:text/…`, `javascript:`
/// and other schemes are not pictures; they are legacy seeds.
pub fn is_picture_seed(seed: &str) -> bool {
    picture_src(seed).is_some()
}

/// Whether a handle names Octo: `octo` or its alias `ai`, trimmed, without a
/// leading `@` and in any case. Studio decides this with
/// `normalizeAgentAvatarHandle` and then the assistant registry's own
/// `normalizeAgentHandle`; each strips one `@`, so `@@octo` names Octo too.
pub fn is_octo_handle(handle: &str) -> bool {
    let handle = normalize_face_seed(&normalize_face_seed(handle));
    OCTO_HANDLES.contains(&handle.as_str())
}

/// A seed or handle as the legacy hash reads it: trimmed, one leading `@`
/// stripped and the rest trimmed again, then lowercased. This is Studio's
/// `normalizeAgentAvatarHandle`, so `@Ben`, ` ben ` and `BEN` wear one face.
///
/// Both steps do what JavaScript does. Trimming removes what
/// `String.prototype.trim` removes, so a byte-order mark (U+FEFF) goes and NEL
/// (U+0085) stays, the other way round from `str::trim`. Lowercasing is
/// Unicode's full default mapping in both languages, final sigma included
/// (`ΟΔΥΣΣΕΥΣ` becomes `οδυσσευς`, `İ` two code points). A character whose case
/// mapping is newer than an engine's Unicode tables can still lowercase
/// differently there; handles and agent ids are ASCII.
pub fn normalize_face_seed(seed: &str) -> String {
    let trimmed = js_trim(seed);
    trimmed
        .strip_prefix('@')
        .map_or(trimmed, js_trim)
        .to_lowercase()
}

/// FNV-1a (32-bit) over a string's UTF-16 code units: the units JavaScript's
/// `charCodeAt` reads, so this and Studio's `hashStringToNumber` agree on every
/// string. `ä` is one unit and `🐙` two surrogates; a port over UTF-8 bytes
/// agrees only on ASCII.
pub fn fnv1a32_utf16(text: &str) -> u32 {
    text.encode_utf16().fold(FNV_OFFSET_BASIS, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(FNV_PRIME)
    })
}

/// The hatchling a legacy seed wears: 1 + the FNV-1a of the normalized seed
/// ([`normalize_face_seed`], [`fnv1a32_utf16`]) mod
/// [`HATCHLING_HASH_MODULUS`]. The same seed wears the same face on every
/// surface and reload. `None` when the seed normalizes to nothing.
pub fn legacy_hatchling(seed: &str) -> Option<Hatchling> {
    let normalized = normalize_face_seed(seed);
    if normalized.is_empty() {
        return None;
    }
    let number = 1 + fnv1a32_utf16(&normalized) % HATCHLING_HASH_MODULUS;
    u8::try_from(number).ok().and_then(Hatchling::new)
}

/// What a client or the controller knows of an AI when it needs that AI's
/// face. A row the controller stamped carries `metadata.agent` as
/// `{handle, id, avatarSeed}`; a saved agent's profile carries its `id`,
/// `handle` and `avatarSeed`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentFaceIdentity<'a> {
    /// The AI's handle, with or without its `@`.
    pub handle: Option<&'a str>,
    /// `avatarSeed`: a picture, a stamp or a legacy seed.
    pub avatar_seed: Option<&'a str>,
    /// A picture kept apart from the seed. Anything but a picture is ignored.
    pub avatar_url: Option<&'a str>,
    /// A saved agent's id. Hashed when there is no usable seed, as the
    /// controller stamps such an agent: its seed, else its id, else its handle.
    pub agent_id: Option<&'a str>,
    /// The AI is known only from text (a typed `@handle`, a mention, a thread
    /// owner with no stamp yet), and the viewer has no saved agent by that
    /// handle or id: the caller looks there first. Such an AI wears the hollow
    /// face unless its handle names Octo. An identity read from a row is never
    /// text-only.
    pub text_only: bool,
}

/// A face drawn without a picture: what [`AgentFace::Picture`] falls back to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawnFace {
    Octo,
    Hatchling(Hatchling),
    Unknown,
}

/// The face an AI wears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFace<'a> {
    /// Octo's own tile (`OctoCoin`): faceless, and the only face that moves.
    Octo,
    /// An uploaded picture, trimmed, clipped to the tile. `fallback` is the
    /// face the identity wears with no picture at all, drawn when the picture
    /// fails to load.
    Picture { src: &'a str, fallback: DrawnFace },
    /// One of Octo's hatchlings.
    Hatchling(Hatchling),
    /// The hollow hatchling of an AI known only from text. It is never stamped
    /// and has no number.
    Unknown,
}

impl AgentFace<'_> {
    /// The hatchling this face is, if it is one. A picture wears none, even
    /// when a hatchling is drawn behind it.
    pub fn hatchling(&self) -> Option<Hatchling> {
        match self {
            Self::Hatchling(face) => Some(*face),
            _ => None,
        }
    }
}

impl From<DrawnFace> for AgentFace<'_> {
    fn from(face: DrawnFace) -> Self {
        match face {
            DrawnFace::Octo => Self::Octo,
            DrawnFace::Hatchling(face) => Self::Hatchling(face),
            DrawnFace::Unknown => Self::Unknown,
        }
    }
}

/// The face an identity wears. The first rule that matches wins:
///
/// 1. Picture: `avatar_url` if it is a picture, else `avatar_seed` if it is one
///    ([`is_picture_seed`]). Behind it is the face these rules give without
///    any picture.
/// 2. Stamp: an `avatar_seed` that is a stamp ([`parse_hatchling_seed`]).
/// 3. Octo: a handle that names Octo, its alias included ([`is_octo_handle`]).
///    This covers legacy and unattributed rows.
/// 4. Legacy seed, for an identity read from a row: the [`legacy_hatchling`] of
///    the seed, else of the agent id, else of the handle, the first of them
///    that normalizes to something.
/// 5. Text only: an identity known only from text wears [`AgentFace::Unknown`]
///    instead of rule 4, because the only thing it has to hash is a handle
///    someone typed.
///
/// An identity with nothing to hash wears [`AgentFace::Unknown`] as well.
pub fn resolve_agent_face<'a>(identity: &AgentFaceIdentity<'a>) -> AgentFace<'a> {
    let picture = identity
        .avatar_url
        .and_then(picture_src)
        .or_else(|| identity.avatar_seed.and_then(picture_src));
    let drawn = drawn_face(identity);
    match picture {
        Some(src) => AgentFace::Picture {
            src,
            fallback: drawn,
        },
        None => drawn.into(),
    }
}

/// Rules 2 to 5 of [`resolve_agent_face`]: the face with every picture set
/// aside.
fn drawn_face(identity: &AgentFaceIdentity<'_>) -> DrawnFace {
    let seed = identity.avatar_seed.filter(|seed| !is_picture_seed(seed));
    if let Some(face) = seed.and_then(parse_hatchling_seed) {
        return DrawnFace::Hatchling(face);
    }
    if identity.handle.is_some_and(is_octo_handle) {
        return DrawnFace::Octo;
    }
    if identity.text_only {
        return DrawnFace::Unknown;
    }
    legacy_seed(identity)
        .and_then(legacy_hatchling)
        .map_or(DrawnFace::Unknown, DrawnFace::Hatchling)
}

/// The value rule 4 hashes: the first of the seed (unless it is a picture), the
/// agent id and the handle that normalizes to something.
fn legacy_seed<'a>(identity: &AgentFaceIdentity<'a>) -> Option<&'a str> {
    let seed = identity.avatar_seed.filter(|seed| !is_picture_seed(seed));
    [seed, identity.agent_id, identity.handle]
        .into_iter()
        .flatten()
        .find(|value| !normalize_face_seed(value).is_empty())
}

/// The face a new saved agent starts with: the hatchling that the fewest of
/// its owner's picture-less agents wear, the highest number on a tie. An
/// owner's agents count down from 8 while a chat's helpers count up from 1
/// ([`allocate_faces`]), so the two rarely meet. `owner_faces` are the
/// hatchlings the owner's agents wear ([`AgentFace::hatchling`]).
pub fn default_agent_face(owner_faces: impl IntoIterator<Item = Hatchling>) -> Hatchling {
    let mut wearers = [0_usize; HATCHLING_FACES as usize];
    for face in owner_faces {
        wearers[face.index()] += 1;
    }
    Hatchling::all()
        .rev()
        .min_by_key(|face| wearers[face.index()])
        .unwrap_or(Hatchling(HATCHLING_FACES))
}

/// One lane of a dispatch, for [`allocate_faces`]. Lanes come in plan order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaceLane<'a> {
    /// A lane whose seed was settled before allocation and is kept as it is: a
    /// rerun that copied its predecessor job's seed verbatim (rule step a), a
    /// saved agent with its own face or picture, or Octo. The hatchling it
    /// wears, if any, is held for every other lane.
    Fixed(AgentFaceIdentity<'a>),
    /// An AI without a profile, by its handle: a plan lane, an `@handle`
    /// follow-up from a lead or a person, a CLI `@handle`, an invented lead. It
    /// is a persona of the root conversation, and steps b and c give it a face.
    Persona(&'a str),
}

/// An AI seen in the root conversation's subtree, for [`allocate_faces`]: one
/// job, among the newest 200 or an open one. Jobs of Octo, of pictures and of
/// identities with nothing to hash wear no hatchling and change nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentSighting<'a, T> {
    /// The AI as the job stamped it (`payload.metadata.agent`).
    pub identity: AgentFaceIdentity<'a>,
    /// When the job was last active: the greatest of its `created_at`,
    /// `completed_at` and `updated_at`. A long plan that has just finished then
    /// counts as just used, not as used when it started.
    pub last_used: T,
    /// Whether the AI holds its face right now: the job is queued or leased, it
    /// is the lead's pending continuation, or it asked a question that is
    /// pending or answered.
    pub open: bool,
}

/// Who holds a face, so a returning persona can tell itself from others.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Holder {
    /// A persona of the root conversation, by its normalized handle.
    Persona(String),
    /// A saved agent, or an AI without a handle.
    Other,
}

impl Holder {
    fn of(identity: &AgentFaceIdentity<'_>) -> Self {
        let handle = identity.handle.map(normalize_face_seed).unwrap_or_default();
        if has_agent_id(identity) || handle.is_empty() {
            Self::Other
        } else {
            Self::Persona(handle)
        }
    }
}

fn has_agent_id(identity: &AgentFaceIdentity<'_>) -> bool {
    identity.agent_id.is_some_and(|id| !js_trim(id).is_empty())
}

/// The face each lane of one dispatch wears, in lane order: `None` for a
/// [`FaceLane::Fixed`] lane, which keeps its own seed, and for every
/// [`FaceLane::Persona`] lane the hatchling to stamp ([`hatchling_seed`]). A
/// persona lane always gets one. The same lanes and sightings, in any order,
/// give the same faces.
///
/// `sightings` are every AI seen in the root conversation's subtree, so a
/// thread shares its parent's faces. The controller reads them in one
/// statement under the root's face lock, so a question registered in the
/// middle of the read cannot be missed. From them:
/// - a face's last use is the latest `last_used` of a sighting that wears it;
/// - an open sighting holds its face, for the persona of its handle when it has
///   no agent id and for its saved agent when it has one;
/// - a sighting with an agent id is a picture-less saved agent (pictures and
///   Octo wear no hatchling), and its face is worn.
///
/// Persona lanes then take faces in two passes.
/// - b. A persona seen before keeps the face of its newest sighting without an
///   agent id, a legacy handle seed included, unless another AI holds that face
///   right now: an open sighting of another persona or of a saved agent, a
///   fixed lane, or an earlier lane of this dispatch. A persona never yields
///   to itself, so two open lanes of one persona share its face. A saved agent
///   that is not open does not move a returning persona.
/// - c. The other lanes, in plan order, take the free faces, least recently
///   used first: faces nobody wore come first, and ties go to the lower number.
///   A face is free when nothing holds it and no saved agent wears it. With
///   more lanes than free faces F, the lanes repeat this dispatch's own faces
///   in order: the lane i + F after them wears lane i's face. With no face
///   free, they go round all eight, least recently used first.
///
/// Lanes are unique by handle within a dispatch; a handle that repeats shares
/// the face of its first lane.
pub fn allocate_faces<T: Ord>(
    lanes: &[FaceLane<'_>],
    sightings: &[AgentSighting<'_, T>],
) -> Vec<Option<Hatchling>> {
    let mut last_used: [Option<&T>; HATCHLING_FACES as usize] = [None; HATCHLING_FACES as usize];
    let mut saved = [false; HATCHLING_FACES as usize];
    // Faces held right now, by open sightings and then by this dispatch's lanes.
    let mut held: Vec<(Hatchling, Holder)> = Vec::new();
    // Each persona's newest face, by handle; a tie goes to the lower number.
    let mut persona_faces: HashMap<String, (&T, Hatchling)> = HashMap::new();
    for sighting in sightings {
        let Some(face) = resolve_agent_face(&sighting.identity).hatchling() else {
            continue;
        };
        let used = &sighting.last_used;
        let slot = &mut last_used[face.index()];
        if slot.is_none_or(|known| used > known) {
            *slot = Some(used);
        }
        if has_agent_id(&sighting.identity) {
            saved[face.index()] = true;
        }
        let holder = Holder::of(&sighting.identity);
        if let Holder::Persona(handle) = &holder {
            let newest = persona_faces.entry(handle.clone()).or_insert((used, face));
            if used > newest.0 || (used == newest.0 && face < newest.1) {
                *newest = (used, face);
            }
        }
        if sighting.open {
            held.push((face, holder));
        }
    }

    for lane in lanes {
        if let FaceLane::Fixed(identity) = lane {
            if let Some(face) = resolve_agent_face(identity).hatchling() {
                held.push((face, Holder::of(identity)));
            }
        }
    }

    let mut faces = vec![None; lanes.len()];
    // This dispatch's persona faces, by handle.
    let mut assigned: HashMap<String, Hatchling> = HashMap::new();
    // b. Returning personas keep their face unless someone else holds it.
    for (lane, slot) in lanes.iter().zip(faces.iter_mut()) {
        let FaceLane::Persona(handle) = lane else {
            continue;
        };
        let handle = normalize_face_seed(handle);
        if let Some(face) = assigned.get(&handle) {
            *slot = Some(*face);
            continue;
        }
        let Some(&(_, face)) = persona_faces.get(&handle) else {
            continue;
        };
        let holder = Holder::Persona(handle.clone());
        if held.iter().any(|(worn, by)| *worn == face && *by != holder) {
            continue;
        }
        *slot = Some(face);
        held.push((face, holder));
        assigned.insert(handle, face);
    }

    // c. Everyone else takes free faces, least recently used first.
    let mut by_last_use: Vec<Hatchling> = Hatchling::all().collect();
    by_last_use.sort_by_key(|face| last_used[face.index()]);
    let free: Vec<Hatchling> = by_last_use
        .iter()
        .copied()
        .filter(|face| !saved[face.index()] && !held.iter().any(|(worn, _)| worn == face))
        .collect();
    let candidates = if free.is_empty() { by_last_use } else { free };
    let mut next = 0;
    for (lane, slot) in lanes.iter().zip(faces.iter_mut()) {
        let FaceLane::Persona(handle) = lane else {
            continue;
        };
        if slot.is_some() {
            continue;
        }
        let face = *assigned
            .entry(normalize_face_seed(handle))
            .or_insert_with(|| {
                let face = candidates[next % candidates.len()];
                next += 1;
                face
            });
        *slot = Some(face);
    }
    faces
}

/// The picture a value names, trimmed, as Studio's
/// `normalizeCustomAgentAvatarSrc` returns it.
fn picture_src(value: &str) -> Option<&str> {
    let value = js_trim(value);
    let web = |scheme: &str| {
        value
            .get(..scheme.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
    };
    (value.starts_with('/')
        || value.starts_with("data:image/")
        || web("http://")
        || web("https://"))
    .then_some(value)
}

/// What JavaScript's `String.prototype.trim` removes besides the spaces from
/// U+2000 to U+200A: its other WhiteSpace (tab, vertical tab, form feed, U+FEFF
/// and the other space separators) and its line terminators. Unlike
/// `char::is_whitespace`, U+FEFF is in and NEL (U+0085) is out.
const JS_WHITESPACE: [char; 14] = [
    '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2028}', '\u{2029}',
    '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
];

fn is_js_whitespace(character: char) -> bool {
    ('\u{2000}'..='\u{200a}').contains(&character) || JS_WHITESPACE.contains(&character)
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("agent_face_fixtures.json")).expect("fixtures")
    }

    fn list<'a>(fixtures: &'a Value, key: &str) -> &'a [Value] {
        let items = fixtures[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixtures list {key}"));
        assert!(!items.is_empty(), "{key}");
        items
    }

    fn strings<'a>(fixtures: &'a Value, key: &str) -> Vec<&'a str> {
        list(fixtures, key)
            .iter()
            .map(|item| item.as_str().expect("string"))
            .collect()
    }

    fn text<'a>(value: &'a Value, key: &str) -> &'a str {
        value[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} in {value}"))
    }

    fn hatchling(value: &Value) -> Hatchling {
        value
            .as_u64()
            .and_then(|number| u8::try_from(number).ok())
            .and_then(Hatchling::new)
            .unwrap_or_else(|| panic!("{value} is not a hatchling"))
    }

    /// An object's keys must all be known, so a misspelt fixture field fails
    /// instead of reading as null.
    fn only_keys(value: &Value, known: &[&str]) {
        let object = value
            .as_object()
            .unwrap_or_else(|| panic!("{value} is an object"));
        for key in object.keys() {
            assert!(
                known.contains(&key.as_str()),
                "unknown key {key} in {value}"
            );
        }
    }

    fn identity(value: &Value) -> AgentFaceIdentity<'_> {
        only_keys(
            value,
            &["handle", "avatarSeed", "avatarUrl", "agentId", "textOnly"],
        );
        AgentFaceIdentity {
            handle: value["handle"].as_str(),
            avatar_seed: value["avatarSeed"].as_str(),
            avatar_url: value["avatarUrl"].as_str(),
            agent_id: value["agentId"].as_str(),
            text_only: value["textOnly"].as_bool().unwrap_or(false),
        }
    }

    fn drawn(value: &Value) -> DrawnFace {
        match text(value, "kind") {
            "octo" | "unknown" => only_keys(value, &["kind"]),
            _ => only_keys(value, &["kind", "n"]),
        }
        match text(value, "kind") {
            "octo" => DrawnFace::Octo,
            "hatchling" => DrawnFace::Hatchling(hatchling(&value["n"])),
            "unknown" => DrawnFace::Unknown,
            other => panic!("{other} is not a face drawn without a picture"),
        }
    }

    fn expected_face(value: &Value) -> AgentFace<'_> {
        if text(value, "kind") != "picture" {
            return drawn(value).into();
        }
        only_keys(value, &["kind", "src", "fallback"]);
        AgentFace::Picture {
            src: text(value, "src"),
            fallback: drawn(&value["fallback"]),
        }
    }

    #[test]
    fn the_face_count_and_the_hash_modulus_are_frozen_at_eight() {
        // Stamps and legacy faces live on in stored rows. A later set of faces
        // takes a new seed prefix; changing the modulus would move every face
        // hashed from a seed.
        assert_eq!(HATCHLING_FACES, 8);
        assert_eq!(HATCHLING_HASH_MODULUS, 8);
        let fixtures = fixtures();
        assert_eq!(fixtures["hatchlingFaces"], HATCHLING_FACES);
        assert_eq!(fixtures["hashModulus"], HATCHLING_HASH_MODULUS);
        let numbers: Vec<u8> = Hatchling::all().map(Hatchling::number).collect();
        assert_eq!(numbers, (1..=8).collect::<Vec<u8>>());
        assert_eq!(Hatchling::new(0), None);
        assert_eq!(Hatchling::new(9), None);
    }

    #[test]
    fn stamps_parse_strictly() {
        let fixtures = fixtures();
        let stamps = list(&fixtures, "stamps");
        assert_eq!(stamps.len(), usize::from(HATCHLING_FACES));
        for case in stamps {
            let seed = text(case, "seed");
            let face = hatchling(&case["n"]);
            assert_eq!(parse_hatchling_seed(seed), Some(face), "{seed:?}");
            assert_eq!(hatchling_seed(face), seed);
        }
        for seed in strings(&fixtures, "notStamps") {
            assert_eq!(parse_hatchling_seed(seed), None, "{seed:?} is not a stamp");
        }
    }

    #[test]
    fn pictures_are_what_studio_draws_as_pictures() {
        let fixtures = fixtures();
        for case in list(&fixtures, "pictures") {
            let value = text(case, "value");
            assert!(is_picture_seed(value), "{value:?} is a picture");
            assert_eq!(picture_src(value), Some(text(case, "src")), "{value:?}");
        }
        for value in strings(&fixtures, "notPictures") {
            assert!(!is_picture_seed(value), "{value:?} is not a picture");
        }
    }

    #[test]
    fn octo_is_named_by_its_handle_or_its_alias() {
        let fixtures = fixtures();
        for handle in strings(&fixtures, "octoHandles") {
            assert!(is_octo_handle(handle), "{handle:?} names Octo");
        }
        for handle in strings(&fixtures, "notOctoHandles") {
            assert!(!is_octo_handle(handle), "{handle:?} does not name Octo");
        }
    }

    #[test]
    fn seeds_normalize_as_javascript_trims_and_lowercases_them() {
        let fixtures = fixtures();
        for case in list(&fixtures, "normalize") {
            let input = text(case, "input");
            assert_eq!(
                normalize_face_seed(input),
                text(case, "normalized"),
                "{input:?}"
            );
        }
        // Where Rust's own trim differs from JavaScript's, Studio's wins.
        assert_eq!("\u{feff}ben".trim(), "\u{feff}ben");
        assert_eq!(normalize_face_seed("\u{feff}ben"), "ben");
        assert_eq!("ben\u{85}".trim(), "ben");
        assert_eq!(normalize_face_seed("ben\u{85}"), "ben\u{85}");
    }

    #[test]
    fn the_hash_reads_utf16_code_units() {
        let fixtures = fixtures();
        for case in list(&fixtures, "hashes") {
            let input = text(case, "input");
            assert_eq!(
                Some(u64::from(fnv1a32_utf16(input))),
                case["fnv1a32"].as_u64(),
                "{input:?}"
            );
        }
        // A port over UTF-8 bytes agrees on ASCII and nowhere else.
        let utf8 = |text: &str| {
            text.bytes().fold(FNV_OFFSET_BASIS, |hash, byte| {
                (hash ^ u32::from(byte)).wrapping_mul(FNV_PRIME)
            })
        };
        assert_eq!(utf8("reading_list"), fnv1a32_utf16("reading_list"));
        for text in ["läser", "🐙"] {
            assert_ne!(utf8(text), fnv1a32_utf16(text), "{text}");
        }
    }

    #[test]
    fn faces_resolve_as_the_fixtures_say() {
        let fixtures = fixtures();
        let mut kinds = Vec::new();
        for case in list(&fixtures, "resolve") {
            only_keys(case, &["why", "identity", "face", "hashed"]);
            let why = text(case, "why");
            let identity = identity(&case["identity"]);
            let expected = expected_face(&case["face"]);
            assert_eq!(resolve_agent_face(&identity), expected, "{why}");
            kinds.push(text(&case["face"], "kind"));

            // A hatchling is either the stamp the seed names or the hash the
            // fixture shows.
            let worn = match expected {
                AgentFace::Hatchling(face)
                | AgentFace::Picture {
                    fallback: DrawnFace::Hatchling(face),
                    ..
                } => Some(face),
                _ => None,
            };
            match case.get("hashed") {
                Some(hashed) => {
                    only_keys(hashed, &["input", "fnv1a32"]);
                    let input = text(hashed, "input");
                    let hash = hashed["fnv1a32"].as_u64().expect("fnv1a32");
                    assert_eq!(
                        legacy_seed(&identity).map(normalize_face_seed).as_deref(),
                        Some(input),
                        "{why}"
                    );
                    assert_eq!(u64::from(fnv1a32_utf16(input)), hash, "{why}");
                    let number = 1 + hash % u64::from(HATCHLING_HASH_MODULUS);
                    assert_eq!(
                        worn.map(|face| u64::from(face.number())),
                        Some(number),
                        "{why}"
                    );
                }
                None => {
                    if let Some(face) = worn {
                        let seed = identity.avatar_seed.and_then(parse_hatchling_seed);
                        assert_eq!(
                            seed,
                            Some(face),
                            "{why}: a hatchling without a hash is a stamp"
                        );
                    }
                }
            }
        }
        for kind in ["picture", "hatchling", "octo", "unknown"] {
            assert!(kinds.contains(&kind), "no case wears {kind}");
        }
    }

    #[test]
    fn a_new_agent_takes_the_face_its_owner_uses_least_counting_down() {
        let fixtures = fixtures();
        for case in list(&fixtures, "agentDefaults") {
            let owner_faces: Vec<Hatchling> = case["ownerFaces"]
                .as_array()
                .expect("ownerFaces")
                .iter()
                .map(hatchling)
                .collect();
            assert_eq!(
                default_agent_face(owner_faces.iter().copied()),
                hatchling(&case["face"]),
                "{owner_faces:?}"
            );
        }
        // Helpers count up from 1, so an empty chat and an owner's first agent
        // start at opposite ends.
        assert_eq!(default_agent_face([]).number(), 8);
        assert_eq!(
            allocate_faces::<u32>(&[FaceLane::Persona("ben")], &[]),
            [face(1)]
        );
    }

    const STAMPS: [&str; 8] = [
        "hatchling:1",
        "hatchling:2",
        "hatchling:3",
        "hatchling:4",
        "hatchling:5",
        "hatchling:6",
        "hatchling:7",
        "hatchling:8",
    ];
    const NAMES: [&str; 8] = ["ana", "bo", "cy", "di", "ed", "fay", "gus", "hal"];
    const PIA_ID: &str = "3f6c1f0e-8a1b-4c55-9d1e-2b7a6c9e4f10";

    fn face(number: u8) -> Option<Hatchling> {
        Some(Hatchling::new(number).expect("a hatchling"))
    }

    fn stamp(number: u8) -> &'static str {
        STAMPS[usize::from(number - 1)]
    }

    /// A persona of its own for each face.
    fn name(number: u8) -> &'static str {
        NAMES[usize::from(number - 1)]
    }

    fn row<'a>(handle: &'a str, seed: &'a str) -> AgentFaceIdentity<'a> {
        AgentFaceIdentity {
            handle: Some(handle),
            avatar_seed: Some(seed),
            ..AgentFaceIdentity::default()
        }
    }

    fn agent<'a>(id: &'a str, handle: &'a str, seed: &'a str) -> AgentFaceIdentity<'a> {
        AgentFaceIdentity {
            agent_id: Some(id),
            ..row(handle, seed)
        }
    }

    /// A persona's job wearing hatchling `number`.
    fn seen(handle: &str, number: u8, last_used: u32, open: bool) -> AgentSighting<'_, u32> {
        AgentSighting {
            identity: row(handle, stamp(number)),
            last_used,
            open,
        }
    }

    fn numbers(faces: &[Option<Hatchling>]) -> Vec<Option<u8>> {
        faces
            .iter()
            .map(|face| face.map(Hatchling::number))
            .collect()
    }

    fn personas<'a>(handles: &[&'a str]) -> Vec<FaceLane<'a>> {
        handles.iter().copied().map(FaceLane::Persona).collect()
    }

    #[test]
    fn fresh_lanes_count_up_from_one_in_plan_order() {
        let faces = allocate_faces::<u32>(&personas(&["reviewer", "writer", "tester"]), &[]);
        assert_eq!(numbers(&faces), [Some(1), Some(2), Some(3)]);
        // Plan order, not handle order, decides.
        let faces = allocate_faces::<u32>(&personas(&["tester", "reviewer"]), &[]);
        assert_eq!(faces, [face(1), face(2)]);
        assert!(allocate_faces::<u32>(&[], &[]).is_empty());
    }

    #[test]
    fn free_faces_go_least_recently_used_first() {
        // Faces nobody wore come before faces closed plans wore.
        let sightings = [
            seen("a", 1, 40, false),
            seen("b", 2, 30, false),
            seen("c", 3, 20, false),
            seen("d", 4, 10, false),
        ];
        let faces = allocate_faces(&personas(&["x", "y"]), &sightings);
        assert_eq!(faces, [face(5), face(6)]);

        // With every face worn once, the oldest come back first.
        let sightings: Vec<_> = (1..=8)
            .map(|number| seen(name(number), number, 90 - u32::from(number) * 10, false))
            .collect();
        let faces = allocate_faces(&personas(&["x", "y", "z"]), &sightings);
        assert_eq!(faces, [face(8), face(7), face(6)]);

        // A tie goes to the lower number.
        let mut sightings: Vec<_> = (1..=8)
            .map(|number| seen(name(number), number, 10, false))
            .collect();
        sightings[4].last_used = 1;
        sightings[2].last_used = 1;
        let faces = allocate_faces(&personas(&["x", "y", "z"]), &sightings);
        assert_eq!(faces, [face(3), face(5), face(1)]);
    }

    #[test]
    fn a_long_plan_counts_as_used_when_it_last_ran() {
        // Plan A started first but finished last: its faces count from its
        // completion (last_used is the greatest of created, completed and
        // updated), so the next plan does not land on them under A's results.
        let sightings = [
            seen("a1", 1, 100, false),
            seen("a2", 2, 100, false),
            seen("b1", 3, 50, false),
            seen("b2", 4, 51, false),
            seen("c1", 5, 52, false),
            seen("c2", 6, 53, false),
            seen("d1", 7, 54, false),
            seen("d2", 8, 55, false),
        ];
        let faces = allocate_faces(&personas(&["e1", "e2"]), &sightings);
        assert_eq!(faces, [face(3), face(4)]);
    }

    #[test]
    fn a_faces_last_use_is_its_newest_sighting() {
        // Face 1 was worn long ago and again lately, face 2 in between: after
        // the faces nobody wore, 2 comes back before 1.
        let sightings = [
            seen("a", 1, 1, false),
            seen("b", 1, 100, false),
            seen("c", 2, 50, false),
        ];
        let faces = allocate_faces(&personas(&["s", "t", "u", "v", "w", "x", "y"]), &sightings);
        assert_eq!(numbers(&faces), [3, 4, 5, 6, 7, 8, 2].map(Some));
    }

    #[test]
    fn a_saved_agent_is_never_the_persona_of_its_handle() {
        // Someone's saved agent named pia is not the persona pia: its rows give
        // the persona no face, and its own face stays worn.
        let pia = AgentSighting {
            identity: agent(PIA_ID, "pia", stamp(5)),
            last_used: 3,
            open: false,
        };
        assert_eq!(allocate_faces(&personas(&["pia"]), &[pia]), [face(1)]);

        // At work, it holds that face against the persona of the same handle.
        let sightings = [
            seen("pia", 5, 1, false),
            AgentSighting { open: true, ..pia },
        ];
        assert_eq!(allocate_faces(&personas(&["pia"]), &sightings), [face(1)]);
    }

    #[test]
    fn faces_worn_right_now_are_skipped() {
        let sightings = [seen("sam", 1, 5, true), seen("kim", 2, 6, true)];
        let faces = allocate_faces(&personas(&["x", "y"]), &sightings);
        assert_eq!(faces, [face(3), face(4)]);

        // A picture-less saved agent seen in the chat keeps its face even when
        // it is not at work; a closed persona's face is only used.
        let sightings = [
            seen("sam", 1, 5, true),
            seen("kim", 2, 6, true),
            AgentSighting {
                identity: agent(PIA_ID, "pia", stamp(4)),
                last_used: 1,
                open: false,
            },
            seen("old", 3, 2, false),
        ];
        let faces = allocate_faces(&personas(&["x", "y", "z", "w"]), &sightings);
        assert_eq!(faces, [face(5), face(6), face(7), face(8)]);
        let faces = allocate_faces(&personas(&["x", "y", "z", "w", "v"]), &sightings);
        assert_eq!(faces[4], face(3));

        // A saved agent whose seed is its id wears that id's hash face.
        let pia = legacy_hatchling(PIA_ID);
        let sightings = [AgentSighting {
            identity: agent(PIA_ID, "pia", PIA_ID),
            last_used: 1,
            open: false,
        }];
        let faces = allocate_faces(&personas(&["a", "b", "c", "d", "e", "f", "g"]), &sightings);
        assert!(!faces.contains(&pia), "{faces:?} avoid {pia:?}");
    }

    #[test]
    fn a_returning_persona_keeps_its_face() {
        let sightings = [seen("ben", 6, 5, false), seen("sam", 1, 9, false)];
        let faces = allocate_faces(&personas(&["ben", "new"]), &sightings);
        assert_eq!(faces, [face(6), face(2)]);

        // Its newest sighting decides.
        let sightings = [seen("ben", 6, 5, false), seen("ben", 4, 9, false)];
        assert_eq!(allocate_faces(&personas(&["ben"]), &sightings), [face(4)]);

        // The handle is compared as the hash compares it.
        let sightings = [seen("Ben", 6, 5, false)];
        assert_eq!(allocate_faces(&personas(&["@ben"]), &sightings), [face(6)]);
    }

    #[test]
    fn a_persona_stamped_with_its_handle_keeps_that_hash_face() {
        // Rows from before the controller stamped faces carry the handle as
        // the seed; the persona goes on wearing the face Studio drew for them.
        let ben = legacy_hatchling("ben").expect("ben hashes");
        let sightings = [AgentSighting {
            identity: row("ben", "ben"),
            last_used: 5,
            open: false,
        }];
        assert_eq!(allocate_faces(&personas(&["ben"]), &sightings), [Some(ben)]);
    }

    #[test]
    fn a_returning_persona_yields_only_to_another_ai_at_work() {
        // Another persona holds the face right now.
        let sightings = [seen("ben", 6, 5, false), seen("sam", 6, 9, true)];
        assert_eq!(allocate_faces(&personas(&["ben"]), &sightings), [face(1)]);

        // So does a saved agent at work.
        let pia_at_work = AgentSighting {
            identity: agent(PIA_ID, "pia", stamp(6)),
            last_used: 9,
            open: true,
        };
        let sightings = [seen("ben", 6, 5, false), pia_at_work];
        assert_eq!(allocate_faces(&personas(&["ben"]), &sightings), [face(1)]);

        // A saved agent that is not at work does not move it, but fresh lanes
        // still keep off that face.
        let pia_done = AgentSighting {
            open: false,
            ..pia_at_work
        };
        let sightings = [seen("ben", 6, 5, false), pia_done];
        let faces = allocate_faces(
            &personas(&["ben", "a", "b", "c", "d", "e", "f"]),
            &sightings,
        );
        assert_eq!(numbers(&faces), [6, 1, 2, 3, 4, 5, 7].map(Some));

        // A persona never yields to itself: two open lanes share its face.
        let sightings = [seen("ben", 6, 5, true)];
        assert_eq!(allocate_faces(&personas(&["ben"]), &sightings), [face(6)]);
    }

    #[test]
    fn fixed_lanes_keep_their_seed_and_hold_their_face() {
        // A lane named like a saved agent runs as it and wears its face.
        let lanes = [
            FaceLane::Persona("a"),
            FaceLane::Fixed(agent(PIA_ID, "pia", stamp(1))),
            FaceLane::Persona("b"),
        ];
        let faces = allocate_faces::<u32>(&lanes, &[]);
        assert_eq!(faces, [face(2), None, face(3)]);

        // A rerun copied its predecessor's stamp, or its legacy handle seed.
        let lanes = [
            FaceLane::Fixed(row("ben", stamp(2))),
            FaceLane::Persona("new"),
        ];
        assert_eq!(allocate_faces::<u32>(&lanes, &[]), [None, face(1)]);
        let ben = legacy_hatchling("ben");
        let lanes = [
            FaceLane::Fixed(row("ben", "ben")),
            FaceLane::Persona("x"),
            FaceLane::Persona("y"),
            FaceLane::Persona("z"),
        ];
        let faces = allocate_faces::<u32>(&lanes, &[]);
        assert_eq!(faces[0], None);
        assert!(!faces.contains(&ben), "{faces:?} avoid {ben:?}");

        // A returning persona yields to a fixed lane.
        let lanes = [
            FaceLane::Fixed(agent(PIA_ID, "pia", stamp(6))),
            FaceLane::Persona("ben"),
        ];
        let sightings = [seen("ben", 6, 5, false)];
        assert_eq!(allocate_faces(&lanes, &sightings), [None, face(1)]);

        // Octo and pictures hold no hatchling.
        let lanes = [
            FaceLane::Fixed(row("octo", "octo")),
            FaceLane::Fixed(agent(PIA_ID, "pia", "https://example.com/pia.png")),
            FaceLane::Persona("a"),
        ];
        assert_eq!(allocate_faces::<u32>(&lanes, &[]), [None, None, face(1)]);
    }

    #[test]
    fn octo_and_pictures_at_work_hold_no_face() {
        let sightings = [
            AgentSighting {
                identity: row("octo", "octo"),
                last_used: 9,
                open: true,
            },
            AgentSighting {
                identity: agent(PIA_ID, "pia", "/avatars/pia.png"),
                last_used: 9,
                open: true,
            },
            AgentSighting {
                identity: row("ai", "ai"),
                last_used: 9,
                open: true,
            },
        ];
        let faces = allocate_faces(&personas(&["a", "b"]), &sightings);
        assert_eq!(faces, [face(1), face(2)]);
    }

    #[test]
    fn returning_personas_take_their_faces_before_fresh_lanes() {
        // `new` comes first in the plan, but face 1 is ben's.
        let sightings = [seen("ben", 1, 5, false)];
        let faces = allocate_faces(&personas(&["new", "ben"]), &sightings);
        assert_eq!(faces, [face(2), face(1)]);

        // Two returning personas who last wore one face: the first in plan
        // order keeps it.
        let sightings = [seen("ben", 3, 5, false), seen("sam", 3, 9, false)];
        let faces = allocate_faces(&personas(&["sam", "ben"]), &sightings);
        assert_eq!(faces, [face(3), face(1)]);
        let faces = allocate_faces(&personas(&["ben", "sam"]), &sightings);
        assert_eq!(faces, [face(3), face(1)]);
    }

    #[test]
    fn a_handle_repeated_in_one_dispatch_shares_its_face() {
        let faces = allocate_faces::<u32>(&personas(&["ben", "ben", "sam"]), &[]);
        assert_eq!(faces, [face(1), face(1), face(2)]);
        let sightings = [seen("ben", 5, 1, false)];
        let faces = allocate_faces(&personas(&["ben", "sam", "ben"]), &sightings);
        assert_eq!(faces, [face(5), face(1), face(5)]);
    }

    #[test]
    fn more_lanes_than_free_faces_repeat_this_dispatchs_faces_in_order() {
        let sightings: Vec<_> = (1..=5)
            .map(|number| seen(name(number), number, 10, true))
            .collect();
        let faces = allocate_faces(&personas(&["a", "b", "c", "d", "e", "f", "g"]), &sightings);
        assert_eq!(numbers(&faces), [6, 7, 8, 6, 7, 8, 6].map(Some));

        // The repeats follow the free faces' own order: lane i + F wears lane
        // i's face.
        let mut sightings = sightings;
        sightings.push(seen("old6", 6, 1, false));
        sightings.push(seen("old7", 7, 2, false));
        let faces = allocate_faces(&personas(&["a", "b", "c", "d", "e"]), &sightings);
        assert_eq!(numbers(&faces), [8, 6, 7, 8, 6].map(Some));
        for (index, lane_face) in faces.iter().enumerate().skip(3) {
            assert_eq!(*lane_face, faces[index - 3]);
        }
    }

    #[test]
    fn with_no_face_free_the_lanes_go_round_all_eight() {
        // Every face is held; the least recently used comes back first.
        let sightings: Vec<_> = (1..=8)
            .map(|number| seen(name(number), number, u32::from(9 - number), true))
            .collect();
        assert_eq!(allocate_faces(&personas(&["x"]), &sightings), [face(8)]);
        let faces = allocate_faces(
            &personas(&["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]),
            &sightings,
        );
        assert_eq!(numbers(&faces), [8, 7, 6, 5, 4, 3, 2, 1, 8, 7].map(Some));

        // Saved agents seen in the chat wearing every face: the same.
        let ids: Vec<String> = (1..=8).map(|number| format!("agent-{number}")).collect();
        let sightings: Vec<_> = (1..=8_u8)
            .map(|number| AgentSighting {
                identity: agent(&ids[usize::from(number - 1)], "saved", stamp(number)),
                last_used: u32::from(number),
                open: false,
            })
            .collect();
        assert_eq!(
            allocate_faces(&personas(&["x", "y"]), &sightings),
            [face(1), face(2)]
        );
    }

    /// A small deterministic generator, so the property tests need no crate.
    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, bound: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) % bound
        }
    }

    #[test]
    fn every_persona_lane_gets_a_face_whatever_the_chat_holds() {
        const HANDLES: [&str; 6] = ["ben", "sam", "kim", "pia", "octo", "ai"];
        const SEEDS: [&str; 7] = [
            "hatchling:2",
            "hatchling:7",
            "ben",
            "octo",
            "https://example.com/x.png",
            "hatchling:9",
            "",
        ];
        let mut random = Lcg(7);
        for _ in 0..500 {
            let sightings: Vec<AgentSighting<'_, u64>> = (0..random.below(14))
                .map(|_| {
                    let handle = HANDLES[random.below(6) as usize];
                    let seed = SEEDS[random.below(7) as usize];
                    let mut identity = row(handle, seed);
                    if random.below(3) == 0 {
                        identity.agent_id = Some(PIA_ID);
                    }
                    AgentSighting {
                        identity,
                        last_used: random.below(5),
                        open: random.below(2) == 0,
                    }
                })
                .collect();
            let lanes: Vec<FaceLane<'_>> = (0..random.below(12))
                .map(|_| {
                    let handle = HANDLES[random.below(6) as usize];
                    if random.below(4) == 0 {
                        FaceLane::Fixed(row(handle, SEEDS[random.below(7) as usize]))
                    } else {
                        FaceLane::Persona(handle)
                    }
                })
                .collect();
            let faces = allocate_faces(&lanes, &sightings);
            assert_eq!(faces.len(), lanes.len());
            for (lane, lane_face) in lanes.iter().zip(&faces) {
                match lane {
                    FaceLane::Fixed(_) => assert_eq!(*lane_face, None),
                    FaceLane::Persona(_) => assert!(lane_face.is_some(), "{lanes:?} {sightings:?}"),
                }
            }
            // The order of the sightings changes nothing.
            let mut reversed = sightings.clone();
            reversed.reverse();
            assert_eq!(allocate_faces(&lanes, &reversed), faces);
            reversed.rotate_left(sightings.len() / 2);
            assert_eq!(allocate_faces(&lanes, &reversed), faces);
        }
    }

    #[test]
    fn ais_at_work_at_once_never_share_a_face_while_eight_or_fewer_are() {
        const HANDLES: [&str; 8] = ["a", "b", "c", "d", "e", "f", "g", "h"];
        let mut random = Lcg(11);
        for _ in 0..500 {
            // Some personas already at work, each with its own face, and some
            // closed history, then a plan of new lanes that fits in eight.
            let mut numbers: Vec<u8> = (1..=8).collect();
            for index in (1..numbers.len()).rev() {
                numbers.swap(index, random.below(index as u64 + 1) as usize);
            }
            let open = random.below(8) as usize;
            let mut sightings: Vec<AgentSighting<'_, u64>> = numbers[..open]
                .iter()
                .enumerate()
                .map(|(index, number)| AgentSighting {
                    identity: row(HANDLES[index], stamp(*number)),
                    last_used: random.below(100),
                    open: true,
                })
                .collect();
            for number in 1..=8 {
                if random.below(2) == 0 {
                    sightings.push(AgentSighting {
                        identity: row("gone", stamp(number)),
                        last_used: random.below(100),
                        open: false,
                    });
                }
            }
            let lanes: Vec<FaceLane<'_>> = HANDLES[open..]
                .iter()
                .take(1 + random.below((8 - open) as u64) as usize)
                .copied()
                .map(FaceLane::Persona)
                .collect();
            let faces = allocate_faces(&lanes, &sightings);
            let mut worn: Vec<Option<Hatchling>> =
                numbers[..open].iter().map(|number| face(*number)).collect();
            for lane_face in faces {
                assert!(
                    !worn.contains(&lane_face),
                    "{lane_face:?} is already worn: {worn:?}"
                );
                worn.push(lane_face);
            }
        }
    }
}
