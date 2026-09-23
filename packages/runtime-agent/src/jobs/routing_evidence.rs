//! Execution evidence for routing requirements. Classification never grants a
//! tool permission, and a command receipt is not proof that its answer is correct.
use super::{JobMessage, RoutingPreObservation, split_routing_pre_observation_command};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RoutingEvidenceRequirements {
    pub(super) context_retrieval: bool,
    pub(super) command_observation: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RoutingEvidenceProgress {
    pub(super) context_retrieval: bool,
    pub(super) command_observation: bool,
}

impl RoutingEvidenceRequirements {
    pub(super) fn requires_any(self) -> bool {
        self.context_retrieval || self.command_observation
    }

    pub(super) fn fulfilled(self, progress: RoutingEvidenceProgress) -> bool {
        (!self.context_retrieval || progress.context_retrieval)
            && (!self.command_observation || progress.command_observation)
    }
}

impl RoutingEvidenceProgress {
    pub(super) fn merge(self, other: Self) -> Self {
        Self {
            context_retrieval: self.context_retrieval || other.context_retrieval,
            command_observation: self.command_observation || other.command_observation,
        }
    }
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RoutingEvidenceReceipts {
    successful_direct_lookups: u32,
    successful_chain_lookups: u32,
    accepted_sequential_lookups: u32,
    successful_observations: u32,
    rejected_commands: u32,
    unsupported_shape_commands: u32,
    unsupported_leaf_commands: u32,
    no_proven_read_commands: u32,
    invalid_receipts: u32,
    failed_or_incomplete_commands: u32,
    successful_pre_observations: u32,
    rejection_reasons: RoutingEvidenceRejectionReasons,
}

/// A single fixed reason is assigned by the recognizer to each rejected receipt.
/// These are diagnostic categories, never retained shell text or AST node names.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutingEvidenceRejectionReasons {
    shell_wrapper: u32,
    shell_syntax: u32,
    redirection: u32,
    dynamic_syntax: u32,
    control_flow: u32,
    command_bound: u32,
    literal_arguments: u32,
    leaf_program: u32,
    leaf_arguments: u32,
    compound_read: u32,
    no_proven_read: u32,
}

impl RoutingEvidenceRejectionReasons {
    fn merge(mut self, other: Self) -> Self {
        macro_rules! add {
            ($($field:ident),+ $(,)?) => {$({
                self.$field = self.$field.saturating_add(other.$field);
            })+};
        }
        add!(
            shell_wrapper,
            shell_syntax,
            redirection,
            dynamic_syntax,
            control_flow,
            command_bound,
            literal_arguments,
            leaf_program,
            leaf_arguments,
            compound_read,
            no_proven_read
        );
        self
    }
}

impl RoutingEvidenceReceipts {
    /// Merge separately recognized attempts: execution item IDs are only unique
    /// within one attempt, so concatenating raw messages can lose earlier proof.
    pub(super) fn merge(mut self, other: Self) -> Self {
        macro_rules! add {
            ($($field:ident),+ $(,)?) => {$({
                self.$field = self.$field.saturating_add(other.$field);
            })+};
        }
        add!(
            successful_direct_lookups,
            successful_chain_lookups,
            accepted_sequential_lookups,
            successful_observations,
            rejected_commands,
            unsupported_shape_commands,
            unsupported_leaf_commands,
            no_proven_read_commands,
            invalid_receipts,
            failed_or_incomplete_commands,
            successful_pre_observations
        );
        self.rejection_reasons = self.rejection_reasons.merge(other.rejection_reasons);
        self
    }
}

pub(super) fn routing_evidence_progress(
    pre_observation: Option<&RoutingPreObservation>,
    messages: &[JobMessage],
) -> RoutingEvidenceProgress {
    routing_evidence_with_receipts(pre_observation, messages).0
}

/// The same recognizer supplies both evidence and content-free diagnostics.
/// Prefer the final lifecycle receipt per item ID; begin events are not failures
/// once a completed receipt for that execution is present.
pub(super) fn routing_evidence_with_receipts(
    pre_observation: Option<&RoutingPreObservation>,
    messages: &[JobMessage],
) -> (RoutingEvidenceProgress, RoutingEvidenceReceipts) {
    let mut progress = RoutingEvidenceProgress::default();
    let mut receipts = RoutingEvidenceReceipts::default();
    if let Some(observation) = pre_observation
        && !observation.timed_out
        && observation.exit_code == Some(0)
    {
        progress.command_observation = true;
        receipts.successful_pre_observations = 1;
    }
    let is_command = |message: &JobMessage| {
        message
            .message_type
            .as_deref()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("command_execution"))
            // Production also emits this host observation as a progress message.
            // Its authoritative result above must be counted only once.
            && !(pre_observation.is_some()
                && message.metadata.as_ref().is_some_and(|metadata| {
                    metadata["source"] == "routing_pre_observation"
                }))
    };
    fn item_id(message: &JobMessage) -> Option<&str> {
        message
            .metadata
            .as_ref()
            .and_then(|v| v["itemId"].as_str())
            .filter(|id| !id.is_empty())
    }
    let mut latest = std::collections::HashMap::new();
    for (index, message) in messages
        .iter()
        .enumerate()
        .filter(|(_, message)| is_command(message))
    {
        if let Some(id) = item_id(message) {
            latest.insert(id, index);
        }
    }
    for (index, message) in messages
        .iter()
        .enumerate()
        .filter(|(_, message)| is_command(message))
    {
        if item_id(message).is_some_and(|id| latest.get(id) != Some(&index)) {
            continue;
        }
        let Some(metadata) = message.metadata.as_ref() else {
            receipts.invalid_receipts = receipts.invalid_receipts.saturating_add(1);
            continue;
        };
        if metadata["status"] != "completed"
            || metadata["exitCode"].as_i64() != Some(0)
            || metadata["timedOut"] == true
        {
            receipts.failed_or_incomplete_commands =
                receipts.failed_or_incomplete_commands.saturating_add(1);
            continue;
        }
        // Malformed present argv never falls back to a plausible display string.
        let argv = match metadata.get("commandArgv") {
            Some(value) => value
                .as_array()
                .filter(|values| values.len() <= 128)
                .and_then(|values| {
                    values
                        .iter()
                        .map(serde_json::Value::as_str)
                        .collect::<Option<Vec<_>>>()
                })
                .map(|args| args.into_iter().map(str::to_owned).collect::<Vec<_>>()),
            None => metadata["command"]
                .as_str()
                .and_then(split_routing_pre_observation_command),
        };
        let Some(argv) = argv else {
            receipts.invalid_receipts = receipts.invalid_receipts.saturating_add(1);
            continue;
        };
        let args = argv.iter().map(String::as_str).collect::<Vec<_>>();
        if !bounded_command_argv(&args) {
            receipts.invalid_receipts = receipts.invalid_receipts.saturating_add(1);
            continue;
        }
        let (observed, proof) = match classify_command(&args) {
            Ok(classified) => classified,
            Err(reason) => {
                receipts.rejected_commands = receipts.rejected_commands.saturating_add(1);
                reason.record(&mut receipts);
                continue;
            }
        };
        if observed.context_retrieval {
            let count = match proof {
                CommandProof::Single => &mut receipts.successful_direct_lookups,
                CommandProof::AndChain => &mut receipts.successful_chain_lookups,
                CommandProof::SequentialSuffix => &mut receipts.accepted_sequential_lookups,
            };
            *count = count.saturating_add(1);
        }
        if observed.command_observation {
            receipts.successful_observations = receipts.successful_observations.saturating_add(1);
        }
        progress = progress.merge(observed);
    }
    (progress, receipts)
}

/// Recognize executed lookup shapes, never stdout or a model's claim about an
/// execution. Legacy strings retain their conservative single-command parser.
#[cfg(test)]
fn is_context_recovery_cli_lookup_command(command: &str) -> bool {
    let Some(tokens) = split_routing_pre_observation_command(command) else {
        return false;
    };
    classify_command(&tokens.iter().map(String::as_str).collect::<Vec<_>>())
        .is_ok_and(|(progress, _)| progress.context_retrieval)
}

fn program_name(program: &str) -> Option<&str> {
    if !std::path::Path::new(program).is_absolute() && program.contains(['/', '\\']) {
        return None;
    }
    std::path::Path::new(program).file_name()?.to_str()
}
fn shell_program(program: &str) -> bool {
    matches!(
        program_name(program),
        Some(
            "sh" | "bash"
                | "zsh"
                | "fish"
                | "pwsh"
                | "powershell"
                | "cmd"
                | "env"
                | "sudo"
                | "eval"
                | "exec"
        )
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RejectedCommand {
    ShellWrapper,
    ShellSyntax,
    Redirection,
    DynamicSyntax,
    ControlFlow,
    CommandBound,
    LiteralArguments,
    LeafProgram,
    LeafArguments,
    CompoundRead,
    NoProvenRead,
}

impl RejectedCommand {
    fn record(self, receipts: &mut RoutingEvidenceReceipts) {
        let coarse = match self {
            Self::ShellWrapper
            | Self::ShellSyntax
            | Self::Redirection
            | Self::DynamicSyntax
            | Self::ControlFlow
            | Self::CommandBound
            | Self::LiteralArguments => &mut receipts.unsupported_shape_commands,
            Self::LeafProgram | Self::LeafArguments | Self::CompoundRead => {
                &mut receipts.unsupported_leaf_commands
            }
            Self::NoProvenRead => &mut receipts.no_proven_read_commands,
        };
        *coarse = coarse.saturating_add(1);
        let reasons = &mut receipts.rejection_reasons;
        let detail = match self {
            Self::ShellWrapper => &mut reasons.shell_wrapper,
            Self::ShellSyntax => &mut reasons.shell_syntax,
            Self::Redirection => &mut reasons.redirection,
            Self::DynamicSyntax => &mut reasons.dynamic_syntax,
            Self::ControlFlow => &mut reasons.control_flow,
            Self::CommandBound => &mut reasons.command_bound,
            Self::LiteralArguments => &mut reasons.literal_arguments,
            Self::LeafProgram => &mut reasons.leaf_program,
            Self::LeafArguments => &mut reasons.leaf_arguments,
            Self::CompoundRead => &mut reasons.compound_read,
            Self::NoProvenRead => &mut reasons.no_proven_read,
        };
        *detail = detail.saturating_add(1);
    }
}

fn rejected_shell_node(kind: &str) -> RejectedCommand {
    match kind {
        "redirected_statement"
        | "file_redirect"
        | "file_descriptor"
        | "heredoc_redirect"
        | "herestring_redirect"
        | "heredoc_body"
        | "heredoc_start"
        | "heredoc_end"
        | "<"
        | ">"
        | ">>"
        | "<<"
        | "<<<"
        | "<&"
        | ">&"
        | "&>"
        | "&>>"
        | ">|" => RejectedCommand::Redirection,
        "variable_assignment"
        | "variable_assignments"
        | "declaration_command"
        | "expansion"
        | "simple_expansion"
        | "command_substitution"
        | "process_substitution"
        | "arithmetic_expansion"
        | "brace_expression"
        | "ansi_c_string"
        | "string_expansion" => RejectedCommand::DynamicSyntax,
        _ => RejectedCommand::ControlFlow,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandProof {
    Single,
    AndChain,
    SequentialSuffix,
}

struct LiteralCommands {
    commands: Vec<Vec<String>>,
    final_segment_start: usize,
}

/// Exit zero proves every leaf in the final flat AND segment succeeded. A
/// semicolon/newline starts a new segment and discards any success claim about
/// earlier leaves. The entire script still has to be structurally and leaf-safe;
/// auto-approval safety is not, by itself, execution evidence.
fn literal_commands(argv: &[&str]) -> Result<LiteralCommands, RejectedCommand> {
    if !bounded_command_argv(argv) {
        return Err(RejectedCommand::CommandBound);
    }
    if !shell_program(argv[0]) {
        return Ok(LiteralCommands {
            commands: vec![argv.iter().map(|s| (*s).to_owned()).collect()],
            final_segment_start: 0,
        });
    }
    if argv.len() != 3
        || !matches!(program_name(argv[0]), Some("sh" | "bash" | "zsh"))
        || !matches!(argv[1], "-c" | "-lc")
    {
        return Err(RejectedCommand::ShellWrapper);
    }
    let script = argv[2];
    if script.contains('<')
        && let Some(command) = literal_stdin_read(script)
    {
        return Ok(LiteralCommands {
            commands: vec![command],
            final_segment_start: 0,
        });
    }
    let tree =
        codex_shell_command::bash::try_parse_shell(script).ok_or(RejectedCommand::ShellSyntax)?;
    if tree.root_node().has_error() {
        return Err(RejectedCommand::ShellSyntax);
    }
    let mut stack = vec![tree.root_node()];
    let mut commands = 0usize;
    let mut command_sources = Vec::new();
    let mut comments = Vec::new();
    while let Some(node) = stack.pop() {
        if node.is_named()
            && !matches!(
                node.kind(),
                "program"
                    | "comment"
                    | "list"
                    | "command"
                    | "command_name"
                    | "word"
                    | "string"
                    | "string_content"
                    | "raw_string"
                    | "number"
                    | "concatenation"
            )
        {
            return Err(rejected_shell_node(node.kind()));
        }
        if !node.is_named()
            && !matches!(node.kind(), "&&" | ";" | "\"" | "'")
            && !node.kind().trim().is_empty()
        {
            return Err(rejected_shell_node(node.kind()));
        }
        match node.kind() {
            "comment" => comments.push(node.byte_range()),
            "command" => {
                commands += 1;
                command_sources.push((
                    node.start_byte(),
                    node.end_byte(),
                    script
                        .get(node.byte_range())
                        .ok_or(RejectedCommand::LiteralArguments)?,
                ));
            }
            "||" | "|" | "&" => return Err(RejectedCommand::ControlFlow),
            _ => {}
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    if commands == 0 || commands > 8 {
        return Err(RejectedCommand::CommandBound);
    }
    command_sources.sort_by_key(|(position, _, _)| *position);
    comments.sort_by_key(|range| range.start);
    let mut final_segment_start = 0;
    for (index, pair) in command_sources.windows(2).enumerate() {
        // Only AST comment spans are ignored. A '#' within a quoted argument
        // stays part of its literal leaf; the newline ending a comment remains
        // available to distinguish sequential commands from an AND segment.
        let mut between = String::new();
        let mut cursor = pair[0].1;
        for comment in comments
            .iter()
            .filter(|range| range.start >= pair[0].1 && range.end <= pair[1].0)
        {
            between.push_str(
                script
                    .get(cursor..comment.start)
                    .ok_or(RejectedCommand::LiteralArguments)?,
            );
            between.push(' ');
            cursor = comment.end;
        }
        between.push_str(
            script
                .get(cursor..pair[1].0)
                .ok_or(RejectedCommand::LiteralArguments)?,
        );
        match between.trim() {
            "&&" => {}
            ";" => final_segment_start = index + 1,
            "" if between.contains('\n') => final_segment_start = index + 1,
            _ => return Err(RejectedCommand::ControlFlow),
        }
    }
    let parsed = codex_shell_command::bash::try_parse_word_only_commands_sequence(&tree, script)
        .or_else(|| {
            // The shared parser rejects quoted executable paths. The AST above
            // has already verified every operator/construct; this conservative
            // fallback sees only individual literal leaf text, never a script.
            command_sources
                .iter()
                .map(|(_, _, leaf)| split_routing_pre_observation_command(leaf))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or(RejectedCommand::LiteralArguments)?;
    if parsed.len() != commands
        || parsed
            .iter()
            .any(|command| command.is_empty() || shell_program(&command[0]))
    {
        return Err(RejectedCommand::LiteralArguments);
    }
    Ok(LiteralCommands {
        commands: parsed,
        final_segment_start,
    })
}

/// Recognize only one stdin-consuming read with one literal input file. The
/// completed host execution remains the proof; this parser neither opens the
/// path nor changes the execution sandbox or project permissions. It deliberately
/// excludes heredocs (which could just print supplied text), output/FD redirects,
/// compound scripts, file operands and interpreters.
fn literal_stdin_read(script: &str) -> Option<Vec<String>> {
    let tree = codex_shell_command::bash::try_parse_shell(script)?;
    let root = tree.root_node();
    if root.has_error() || root.named_child_count() != 1 {
        return None;
    }
    let mut stack = vec![root];
    let mut commands = 0usize;
    let mut redirects = Vec::new();
    while let Some(node) = stack.pop() {
        if node.is_named() {
            if !matches!(
                node.kind(),
                "program"
                    | "command"
                    | "command_name"
                    | "word"
                    | "string"
                    | "string_content"
                    | "raw_string"
                    | "number"
                    | "redirected_statement"
                    | "file_redirect"
            ) {
                return None;
            }
        } else if !matches!(node.kind(), "<" | "\"" | "'") && !node.kind().trim().is_empty() {
            return None;
        }
        match node.kind() {
            "command" => commands += 1,
            "file_redirect" => redirects.push(node),
            _ => {}
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    if commands != 1 || redirects.len() != 1 {
        return None;
    }
    let redirect = redirects[0];
    // Exactly '< literal': no explicit descriptor, second destination or IO
    // duplication. The tree walk above has excluded expansions within quotes.
    if redirect.child_by_field_name("descriptor").is_some()
        || redirect.named_child_count() != 1
        || redirect.child(0)?.kind() != "<"
    {
        return None;
    }
    let destination = redirect.child_by_field_name("destination")?;
    if !matches!(destination.kind(), "word" | "string" | "raw_string") {
        return None;
    }
    let path_words = split_routing_pre_observation_command(script.get(destination.byte_range())?)?;
    let [path] = path_words.as_slice() else {
        return None;
    };
    // Conservatively reject shell expansion/escape characters even when quoted.
    // Read scope remains enforced by the tool; absolute paths are not authority.
    if path.is_empty() || path.contains(['*', '?', '[', ']', '{', '}', '~', '\\']) {
        return None;
    }
    let leaf = format!(
        "{} {}",
        script.get(..redirect.start_byte())?,
        script.get(redirect.end_byte()..)?
    );
    let words = split_routing_pre_observation_command(&leaf)?;
    let args = words.iter().map(String::as_str).collect::<Vec<_>>();
    let consumes_stdin = match program_name(args.first()?) {
        Some("cat") => args.len() == 1,
        Some("wc") => args[1..].iter().all(|arg| {
            arg.starts_with('-')
                && arg.len() > 1
                && arg[1..]
                    .chars()
                    .all(|flag| matches!(flag, 'c' | 'm' | 'l' | 'w'))
        }),
        _ => false,
    };
    (consumes_stdin && bounded_command_argv(&args) && readonly_observation(&args)).then_some(words)
}

fn classify_command(
    argv: &[&str],
) -> Result<(RoutingEvidenceProgress, CommandProof), RejectedCommand> {
    let LiteralCommands {
        commands,
        final_segment_start,
    } = literal_commands(argv)?;
    let mut progress = RoutingEvidenceProgress::default();
    for (index, command) in commands.iter().enumerate() {
        let args = command.iter().map(String::as_str).collect::<Vec<_>>();
        let Some(program) = args.first().and_then(|program| program_name(program)) else {
            return Err(RejectedCommand::LeafProgram);
        };
        if !bounded_command_argv(&args) || shell_program(args[0]) {
            return Err(RejectedCommand::LeafArguments);
        }
        if neutral_leaf(&args) {
            continue;
        }
        if args
            .iter()
            .any(|arg| matches!(*arg, "--help" | "-h" | "--version" | "-V"))
        {
            return Err(RejectedCommand::LeafArguments);
        }
        if lookup_leaf(&args) {
            if index >= final_segment_start {
                progress.context_retrieval = true;
            }
        } else {
            // A direct successful interpreter command remains generic execution
            // evidence for compatibility; it does not attest its semantic effect.
            // Compound proofs require every non-lookup/non-neutral leaf to be a
            // known read-only observation, including ignored earlier segments.
            if rejected_observation(program, &args) {
                return Err(RejectedCommand::LeafArguments);
            }
            if commands.len() > 1 && !readonly_observation(&args) {
                return Err(RejectedCommand::CompoundRead);
            }
            if index >= final_segment_start {
                progress.command_observation = true;
            }
        }
    }
    if progress == RoutingEvidenceProgress::default() {
        return Err(RejectedCommand::NoProvenRead);
    }
    let proof = if final_segment_start > 0 {
        CommandProof::SequentialSuffix
    } else if commands.len() > 1 {
        CommandProof::AndChain
    } else {
        CommandProof::Single
    };
    Ok((progress, proof))
}

/// Literal output and a literal directory change can accompany required reads,
/// but never discharge a requirement themselves. Keep printf's accepted format
/// grammar deliberately small: neither options nor assignment-capable formats
/// (including width/position variants of %n) are admitted.
fn neutral_leaf(argv: &[&str]) -> bool {
    match program_name(argv[0]) {
        Some("echo") => true,
        Some("true" | ":") => argv.len() == 1,
        Some("cd") => match &argv[1..] {
            [path] | ["--", path] => !path.is_empty() && !path.starts_with('-'),
            _ => false,
        },
        Some("printf") => {
            // The shared word parser retains literal spelling for unquoted
            // words. Reject expansion characters even when quoted, so a glob,
            // brace or tilde cannot select a different runtime format/option.
            let Some(format) = argv.get(1).filter(|format| {
                !format.starts_with('-') && !format.contains(['*', '?', '[', ']', '{', '}', '~'])
            }) else {
                return false;
            };
            let mut chars = format.chars();
            while let Some(c) = chars.next() {
                match c {
                    '%' if !matches!(chars.next(), Some('%' | 's')) => return false,
                    '\\' if !matches!(chars.next(), Some('\\' | 'n' | 'r' | 't')) => return false,
                    _ => {}
                }
            }
            true
        }
        _ => false,
    }
}

fn lookup_leaf(argv: &[&str]) -> bool {
    if program_name(argv[0]) != Some("instafy") || argv.iter().any(|arg| arg.contains(['\n', '\r']))
    {
        return false;
    }
    let normalized = argv.join(" ").to_ascii_lowercase();
    if [".codex-runtime", ".codex/sessions", "runtime log"]
        .iter()
        .any(|trace| normalized.contains(trace))
    {
        return false;
    }
    matches!(
        &argv[1..],
        ["conversation", "list", ..] | ["agents", "context", "list", ..]
    ) || matches!(&argv[1..],["conversation","search"|"show",query,..] if !query.is_empty() && !query.starts_with('-'))
}

fn rejected_observation(program: &str, argv: &[&str]) -> bool {
    if matches!(
        program,
        "echo"
            | "printf"
            | "true"
            | "false"
            | ":"
            | "sleep"
            | "expr"
            | "seq"
            | "cd"
            | "rm"
            | "rmdir"
            | "mkdir"
            | "touch"
            | "mv"
            | "cp"
            | "install"
            | "chmod"
            | "chown"
            | "ln"
            | "tee"
            | "truncate"
    ) {
        return true;
    }
    if matches!(program, "git" | "find" | "rg" | "sed" | "base64") {
        return !known_safe(argv);
    }
    if program == "instafy" {
        return !readonly_observation(argv);
    }
    false
}
fn known_safe(argv: &[&str]) -> bool {
    codex_shell_command::is_safe_command::is_known_safe_command(
        &argv.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(),
    )
}
fn readonly_observation(argv: &[&str]) -> bool {
    let Some(program) = program_name(argv[0]) else {
        return false;
    };
    if program == "instafy" {
        return match &argv[1..] {
            ["git", args @ ..] => known_safe(
                &std::iter::once("git")
                    .chain(args.iter().copied())
                    .collect::<Vec<_>>(),
            ),
            ["agents", "status", id] | ["agents", "status", id, "--json"] => {
                uuid::Uuid::parse_str(id).is_ok()
            }
            _ => false,
        };
    }
    matches!(
        program,
        "cat"
            | "head"
            | "tail"
            | "ls"
            | "pwd"
            | "stat"
            | "find"
            | "rg"
            | "grep"
            | "wc"
            | "nl"
            | "sed"
            | "git"
            | "uname"
            | "whoami"
            | "id"
    ) && known_safe(argv)
}

fn bounded_command_argv(argv: &[&str]) -> bool {
    !argv.is_empty()
        && !argv[0].is_empty()
        && argv.len() <= 128
        && argv.iter().map(|arg| arg.len()).sum::<usize>() <= 16_384
        && !argv.iter().any(|arg| arg.contains('\0'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn command(text: &str, status: &str, exit_code: Option<i32>) -> JobMessage {
        JobMessage {
            content: text.into(),
            message_type: Some("command_execution".into()),
            metadata: Some(json!({"command":text,"status":status,"exitCode":exit_code})),
        }
    }

    #[test]
    fn authoritative_pre_observation_is_not_counted_again_as_a_progress_message() {
        let observation = RoutingPreObservation {
            command: "ls".to_string(),
            exit_code: Some(0),
            timed_out: false,
            output: "notes.txt".to_string(),
        };
        let messages = vec![super::super::routing_pre_observation_message(&observation)];
        let (progress, receipts) = routing_evidence_with_receipts(Some(&observation), &messages);
        assert!(progress.command_observation);
        assert!(!progress.context_retrieval);
        assert_eq!(receipts.successful_pre_observations, 1);
        assert_eq!(receipts.successful_observations, 0);
        assert_eq!(receipts.failed_or_incomplete_commands, 0);

        // An inconsistent success message cannot override a failed host result.
        let failed = RoutingPreObservation {
            exit_code: Some(1),
            ..observation
        };
        let (progress, receipts) = routing_evidence_with_receipts(Some(&failed), &messages);
        assert_eq!(progress, RoutingEvidenceProgress::default());
        assert_eq!(receipts.successful_pre_observations, 0);
        assert_eq!(receipts.successful_observations, 0);
    }

    #[test]
    fn normalized_command_events_preserve_lookup_argv_through_message_extraction() {
        let script = "instafy conversation search 'pickup decision' --json";
        let argv = json!(["/bin/zsh", "-lc", script]);
        // The adapter keeps its existing human-readable display. Arg boundaries
        // come exclusively from the additive argv field, not reparsing display.
        let display = format!("/bin/zsh -lc {script}");
        assert!(!is_context_recovery_cli_lookup_command(&display));
        let messages = super::super::extract_codex_messages(&[
            json!({"type":"item.started","item":{"id":"lookup","type":"command_execution",
                "command":display,"command_argv":argv,"status":"in_progress","exit_code":null}}),
            json!({"type":"item.completed","item":{"id":"lookup","type":"command_execution",
                "command":display,"command_argv":argv,"status":"completed","exit_code":0}}),
        ]);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].metadata.as_ref().unwrap()["commandArgv"], argv);
        assert!(!routing_evidence_progress(None, &messages[..1]).context_retrieval);
        let progress = routing_evidence_progress(None, &messages);
        assert!(progress.context_retrieval);
        assert!(!progress.command_observation);
    }

    #[test]
    fn invalid_or_nonlookup_argv_never_falls_back_to_lookup_display() {
        for argv in [
            json!(null),
            json!("instafy conversation list"),
            json!([]),
            json!([42]),
            json!(["echo", "instafy conversation list"]),
            json!(["/bin/zsh", "-lc", "instafy chat hello"]),
            json!(["/bin/zsh", "-lc", "instafy conversation list; echo forged"]),
            json!(["/bin/zsh", "-lc", "instafy conversation list", "extra"]),
            json!(["instafy", "conversation", "list", "--help"]),
            json!(["instafy", "conversation", "search", "x\0y"]),
            json!(vec!["x"; 129]),
            json!(["instafy", "conversation", "search", "x".repeat(16_385)]),
        ] {
            let mut message = command("instafy conversation list", "completed", Some(0));
            message.metadata.as_mut().unwrap()["commandArgv"] = argv.clone();
            assert!(
                !routing_evidence_progress(None, &[message]).context_retrieval,
                "{argv}"
            );
        }
        let legacy = command("instafy conversation list", "completed", Some(0));
        assert!(routing_evidence_progress(None, &[legacy]).context_retrieval);
    }

    #[test]
    fn malformed_argv_does_not_credit_either_evidence_requirement() {
        for argv in [
            json!(null),
            json!("ls"),
            json!([]),
            json!([""]),
            json!(["ls", 42]),
            json!(["ls", "x\0y"]),
            json!(vec!["x"; 129]),
            json!(["ls", "x".repeat(16_385)]),
        ] {
            let mut message = command("ls", "completed", Some(0));
            message.metadata.as_mut().unwrap()["commandArgv"] = argv.clone();
            let progress = routing_evidence_progress(None, &[message]);
            assert_eq!(progress, RoutingEvidenceProgress::default(), "{argv}");
        }
    }

    #[test]
    fn multiline_commands_prove_only_the_final_segment() {
        let script = "printf 'first observation'\ninstafy conversation list";
        let mut message = command(script, "completed", Some(0));
        message.metadata.as_mut().unwrap()["commandArgv"] = json!(["/bin/zsh", "-lc", script]);
        let (progress, receipts) = routing_evidence_with_receipts(None, &[message]);
        assert_eq!(
            progress,
            RoutingEvidenceProgress {
                context_retrieval: true,
                command_observation: false,
            }
        );
        assert_eq!(receipts.accepted_sequential_lookups, 1);
        assert_eq!(receipts.successful_chain_lookups, 0);
    }

    #[test]
    fn lookup_requires_a_successful_read_receipt() {
        let lookup = "instafy conversation search \"missing decision\" --include-threads --json";
        assert!(
            routing_evidence_progress(None, &[command(lookup, "completed", Some(0))])
                .context_retrieval
        );
        for text in [
            "echo 'instafy conversation search missing'",
            "instafy chat --conversation a hello",
            "instafy agents context upsert --context fake",
            "instafy conversation delete a",
            "instafy conversation search --help",
            "instafy conversation show --json",
            "rg missing .codex/sessions && instafy conversation list",
        ] {
            assert!(
                !routing_evidence_progress(None, &[command(text, "completed", Some(0))])
                    .context_retrieval,
                "{text}"
            );
        }
        for (status, code) in [
            ("running", None),
            ("failed", Some(1)),
            ("completed", Some(1)),
            ("completed", None),
        ] {
            assert!(
                !routing_evidence_progress(None, &[command(lookup, status, code)])
                    .context_retrieval
            );
        }
        assert!(is_context_recovery_cli_lookup_command(
            "/bin/zsh -lc 'instafy agents context list --json --query decision'"
        ));
    }

    #[test]
    fn retrieval_and_observation_have_independent_evidence() {
        let required = RoutingEvidenceRequirements {
            context_retrieval: true,
            command_observation: true,
        };
        let lookup = routing_evidence_progress(
            None,
            &[command(
                "instafy conversation search decision --json",
                "completed",
                Some(0),
            )],
        );
        let observation = RoutingPreObservation {
            command: "git status --short".into(),
            exit_code: Some(0),
            timed_out: false,
            output: String::new(),
        };
        let workspace = routing_evidence_progress(Some(&observation), &[]);
        assert!(!required.fulfilled(lookup));
        assert!(!required.fulfilled(workspace));
        assert!(required.fulfilled(lookup.merge(workspace)));
        assert!(!lookup.command_observation);
        assert!(!workspace.context_retrieval);
        let failed = RoutingPreObservation {
            exit_code: Some(1),
            ..observation
        };
        assert!(!required.fulfilled(lookup.merge(routing_evidence_progress(Some(&failed), &[]))));
        assert!(required.fulfilled(lookup.merge(routing_evidence_progress(
            None,
            &[command("ls -la", "completed", Some(0))]
        ))));
    }

    #[test]
    fn absolute_cli_paths_require_the_exact_program_and_read_subcommand() {
        for text in [
            "/usr/local/bin/instafy conversation search decision --json",
            "/opt/instafy/bin/instafy agents context list --json",
            "'/opt/Instafy App/bin/instafy' conversation list --json",
            "/bin/zsh -lc '/opt/instafy/bin/instafy conversation show record --json'",
        ] {
            assert!(
                routing_evidence_progress(None, &[command(text, "completed", Some(0))])
                    .context_retrieval,
                "{text}"
            );
        }
        for text in [
            "/tmp/not-instafy conversation list --json",
            "/tmp/instafy-helper conversation list --json",
            "echo /usr/local/bin/instafy conversation list --json",
            "/usr/local/bin/instafy chat --conversation record hello",
            "/usr/local/bin/instafy agents context upsert --context fake",
        ] {
            assert!(
                !routing_evidence_progress(None, &[command(text, "completed", Some(0))])
                    .context_retrieval,
                "{text}"
            );
        }
    }

    #[test]
    fn combined_observations_do_not_hide_an_earlier_failure() {
        let observations = [Some(1), Some(0)].map(|exit_code| RoutingPreObservation {
            command: "git status".into(),
            exit_code,
            timed_out: false,
            output: String::new(),
        });
        let combined = super::super::combine_routing_pre_observations(observations.into()).unwrap();
        assert_eq!(combined.exit_code, Some(1));
        assert!(!routing_evidence_progress(Some(&combined), &[]).command_observation);
        assert!(
            super::super::format_routing_pre_observation_evidence_section(&combined)
                .contains("failed or timed out")
        );
        assert!(
            !super::super::format_routing_pre_observation_latest_request_section(&combined)
                .contains("This satisfies")
        );
    }
    fn argv_message(argv: serde_json::Value, status: &str, exit_code: i32) -> Vec<JobMessage> {
        super::super::extract_codex_messages(&[
            json!({"type":"item.started","item":{"id":"receipt","type":"command_execution","command":"private display omitted",
                "command_argv":argv,"status":"in_progress","exit_code":null}}),
            json!({"type":"item.completed","item":{"id":"receipt","type":"command_execution","command":"private display omitted",
                "command_argv":argv,"status":status,"exit_code":exit_code}}),
        ])
    }

    #[test]
    fn successful_literal_and_lookups_credit_retrieval_without_workspace_substitution() {
        for script in [
            "instafy conversation show first --json && instafy conversation show second --json",
            "instafy conversation search 'first decision' --json && instafy agents context list --json",
            "'/opt/Instafy Runtime/bin/instafy' conversation show first --json && '/opt/Instafy Runtime/bin/instafy' conversation show second --json",
        ] {
            let messages = argv_message(json!(["/bin/zsh", "-lc", script]), "completed", 0);
            let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
            assert!(progress.context_retrieval, "{script}");
            assert!(!progress.command_observation, "{script}");
            let receipts = serde_json::to_value(receipts).unwrap();
            assert_eq!(receipts["successfulChainLookups"], 1);
            assert_eq!(receipts["successfulDirectLookups"], 0);
            assert_eq!(receipts["successfulObservations"], 0);
            assert_eq!(receipts["failedOrIncompleteCommands"], 0);
            assert!(!receipts.to_string().contains("first decision"));
        }
        let messages = argv_message(
            json!([
                "/bin/sh",
                "-c",
                "instafy conversation show record --json && cat probe.txt"
            ]),
            "completed",
            0,
        );
        let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
        assert_eq!(
            progress,
            RoutingEvidenceProgress {
                context_retrieval: true,
                command_observation: true
            }
        );
        let receipts = serde_json::to_value(receipts).unwrap();
        assert_eq!(receipts["successfulChainLookups"], 1);
        assert_eq!(receipts["successfulObservations"], 1);
    }

    #[test]
    fn unsafe_or_incomplete_scripts_cannot_manufacture_either_receipt_kind() {
        for script in [
            "true || instafy conversation show record --json",
            "false && instafy conversation show record --json || true",
            "instafy conversation show first | cat",
            "echo 'instafy conversation show first && instafy conversation show second'",
            "instafy conversation show first && expr 1 + 1",
            "instafy conversation show first && rm -f file",
            "instafy conversation show first && find . -delete",
            "instafy conversation show first && git branch new-branch",
            "instafy conversation show first && instafy automations create --name fake",
            "instafy conversation show first && sh -c 'cat probe.txt'",
            "instafy conversation show first && python3 -c 'print(1)'",
            "X=1 cat probe.txt",
            "X=1 instafy conversation show record",
            "cat probe.txt > copied.txt",
            "instafy conversation show $(echo record)",
            "(instafy conversation show record)",
            "if true; then instafy conversation show record; fi",
            "rm -f file; instafy conversation show record",
            "python3 -c 'print(1)'; instafy conversation show record",
            "instafy conversation show record & cat probe.txt",
            "! instafy conversation show record",
            "instafy conversation show first && printf -v binding '%s' forged",
            "instafy conversation show first && printf '%n' binding",
            "instafy conversation show first && printf '%1$n' binding",
            "instafy conversation show first && printf '%03n' binding",
            "instafy conversation show first && printf '%*n' 3 binding",
            "instafy conversation show first && printf '%''n' binding",
            "instafy conversation show first && printf '%b' '\\x41'",
            "instafy conversation show first && printf '\\x25n' binding",
            "instafy conversation show first && printf * binding",
            "instafy conversation show first && printf '{-v,%s}' binding value",
            "instafy conversation show first && printf ~",
            "instafy conversation show first && cd -",
            "instafy conversation show first && true --version",
        ] {
            let messages = argv_message(json!(["/bin/sh", "-c", script]), "completed", 0);
            let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
            assert_eq!(progress, RoutingEvidenceProgress::default(), "{script}");
            assert_eq!(
                serde_json::to_value(receipts).unwrap()["rejectedCommands"],
                1,
                "{script}"
            );
        }
        for (status, code) in [("completed", 1), ("failed", 1), ("in_progress", 0)] {
            let messages = argv_message(
                json!([
                    "/bin/sh",
                    "-c",
                    "instafy conversation show a && instafy conversation show b"
                ]),
                status,
                code,
            );
            let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
            assert_eq!(progress, RoutingEvidenceProgress::default());
            assert_eq!(
                serde_json::to_value(receipts).unwrap()["failedOrIncompleteCommands"],
                1
            );
        }
        let mut timed_out = argv_message(
            json!([
                "/bin/sh",
                "-c",
                "instafy conversation show a && cat probe.txt"
            ]),
            "completed",
            0,
        );
        timed_out.last_mut().unwrap().metadata.as_mut().unwrap()["timedOut"] = json!(true);
        let (progress, receipts) = routing_evidence_with_receipts(None, &timed_out);
        assert_eq!(progress, RoutingEvidenceProgress::default());
        assert_eq!(receipts.failed_or_incomplete_commands, 1);
    }

    #[test]
    fn neutral_leaves_preserve_and_proof_but_cannot_supply_a_read() {
        for script in [
            "printf 'Starting\\n' && instafy conversation show first && printf '%s\\n' 'Finished'",
            "cd . && instafy conversation show first && cd -- .",
            "echo --help && instafy conversation show first && echo 'current filesystem'",
            "true && instafy conversation show first && :",
            "instafy conversation show first && printf '%s' '%n'",
            "instafy conversation show first && printf '100%% complete'",
        ] {
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(json!(["/bin/sh", "-c", script]), "completed", 0),
            );
            assert_eq!(
                progress,
                RoutingEvidenceProgress {
                    context_retrieval: true,
                    command_observation: false,
                },
                "{script}"
            );
            assert_eq!(receipts.successful_chain_lookups, 1, "{script}");
            assert_eq!(receipts.successful_observations, 0, "{script}");
        }
        for script in [
            "printf '%s\\n' literal && echo observed && cd . && true && :",
            "instafy conversation show first; printf '%s' finished",
            "instafy conversation show first\ntrue",
            "cat probe.txt; cd .",
        ] {
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(json!(["/bin/sh", "-c", script]), "completed", 0),
            );
            assert_eq!(progress, RoutingEvidenceProgress::default(), "{script}");
            assert_eq!(receipts.no_proven_read_commands, 1, "{script}");
            assert_eq!(receipts.unsupported_shape_commands, 0, "{script}");
            assert_eq!(receipts.unsupported_leaf_commands, 0, "{script}");
        }
    }

    #[test]
    fn sequential_separators_and_inert_comments_preserve_only_final_and_proof() {
        for (script, lookup, observation) in [
            (
                "instafy conversation show first; instafy conversation show second;\n",
                true,
                false,
            ),
            (
                "instafy conversation show first\ninstafy conversation show second",
                true,
                false,
            ),
            (
                "# before\ninstafy conversation show first; # ignored earlier read\ncat probe.txt # after",
                false,
                true,
            ),
            (
                "cat probe.txt\n# ignored earlier read\ninstafy conversation show second",
                true,
                false,
            ),
            (
                "instafy conversation show first && cat a; instafy conversation show second && printf '%s' 'done # literal'",
                true,
                false,
            ),
            (
                "instafy conversation show first; # separator\ninstafy conversation show second && # next read\ncat probe.txt",
                true,
                true,
            ),
        ] {
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(json!(["/bin/sh", "-c", script]), "completed", 0),
            );
            assert_eq!(
                progress,
                RoutingEvidenceProgress {
                    context_retrieval: lookup,
                    command_observation: observation,
                },
                "{script}"
            );
            assert_eq!(
                receipts.accepted_sequential_lookups,
                u32::from(lookup),
                "{script}"
            );
            assert_eq!(receipts.successful_chain_lookups, 0, "{script}");
        }
        for script in [
            "# before\ninstafy conversation show record # after\n",
            "instafy conversation show '# quoted identifier'; # after\n",
        ] {
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(json!(["/bin/sh", "-c", script]), "completed", 0),
            );
            assert!(progress.context_retrieval, "{script}");
            assert!(!progress.command_observation, "{script}");
            assert_eq!(receipts.successful_direct_lookups, 1, "{script}");
        }
    }

    #[test]
    fn rejected_receipt_reasons_are_exclusive_content_free_counts() {
        let mut messages = Vec::new();
        for script in [
            "instafy conversation show secret-record || cat secret-file",
            "instafy conversation show secret-record && rm -f secret-file",
            "instafy conversation show secret-record; printf '%s' secret-output",
        ] {
            // No shared lifecycle ID: these are three separate executions.
            let mut message = command("private display omitted", "completed", Some(0));
            message.metadata.as_mut().unwrap()["commandArgv"] = json!(["/bin/sh", "-c", script]);
            messages.push(message);
        }
        let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
        assert_eq!(progress, RoutingEvidenceProgress::default());
        assert_eq!(receipts.rejected_commands, 3);
        assert_eq!(receipts.unsupported_shape_commands, 1);
        assert_eq!(receipts.unsupported_leaf_commands, 1);
        assert_eq!(receipts.no_proven_read_commands, 1);
        let serialized = serde_json::to_string(&receipts).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("private"));
    }

    #[test]
    fn exact_single_command_interpreter_observations_remain_compatible() {
        for argv in [
            json!([
                "python3",
                "-c",
                "from pathlib import Path; print(Path('probe.txt').read_text())"
            ]),
            json!([
                "node",
                "-e",
                "console.log(require('fs').readFileSync('probe.txt','utf8'))"
            ]),
            json!([
                "/bin/sh",
                "-c",
                "python3 -c 'print(open(\"probe.txt\").read())'"
            ]),
            json!(["cat", "probe.txt"]),
        ] {
            let (progress, receipts) =
                routing_evidence_with_receipts(None, &argv_message(argv, "completed", 0));
            assert_eq!(
                progress,
                RoutingEvidenceProgress {
                    context_retrieval: false,
                    command_observation: true
                }
            );
            assert_eq!(
                serde_json::to_value(receipts).unwrap()["successfulObservations"],
                1
            );
        }
        for argv in [
            json!([
                "/opt/Instafy Runtime/bin/instafy",
                "conversation",
                "show",
                "record",
                "--json"
            ]),
            json!([
                "/bin/sh",
                "-c",
                "'/opt/Instafy Runtime/bin/instafy' conversation show record --json"
            ]),
        ] {
            let (progress, receipts) =
                routing_evidence_with_receipts(None, &argv_message(argv, "completed", 0));
            assert_eq!(
                progress,
                RoutingEvidenceProgress {
                    context_retrieval: true,
                    command_observation: false
                }
            );
            assert_eq!(
                serde_json::to_value(receipts).unwrap()["successfulDirectLookups"],
                1
            );
        }
        for argv in [
            json!(["echo", "instafy conversation show record"]),
            json!(["instafy", "conversation", "delete", "record"]),
            json!(["find", ".", "-delete"]),
            json!(["sed", "-i", "s/a/b/", "probe.txt"]),
        ] {
            assert_eq!(
                routing_evidence_progress(None, &argv_message(argv, "completed", 0)),
                RoutingEvidenceProgress::default()
            );
        }
    }

    #[test]
    fn receipt_diagnostics_are_bounded_fixed_counts_and_invalid_argv_fails_closed() {
        let messages = argv_message(json!(["cat", 42]), "completed", 0);
        let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
        assert_eq!(progress, RoutingEvidenceProgress::default());
        let json = serde_json::to_value(receipts).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 12);
        assert_eq!(json["invalidReceipts"], 1);
        assert!(
            json.as_object()
                .unwrap()
                .iter()
                .all(|(key, value)| { key == "rejectionReasons" || value.as_u64().is_some() })
        );
        assert_eq!(json["rejectionReasons"].as_object().unwrap().len(), 11);
        assert!(
            json["rejectionReasons"]
                .as_object()
                .unwrap()
                .values()
                .all(|value| value.as_u64() == Some(0))
        );
        assert!(!json.to_string().contains("private"));
    }

    #[test]
    fn single_literal_stdin_reads_are_observations_only() {
        for script in [
            "cat < probe.txt",
            "cat < 'private input with spaces.txt'",
            "'/bin/cat' < probe.txt",
            "wc < probe.txt",
            "wc -c < probe.txt",
            "wc -lwm < probe.txt",
        ] {
            let messages = argv_message(json!(["/bin/sh", "-c", script]), "completed", 0);
            assert_eq!(
                routing_evidence_progress(None, &messages[..1]),
                RoutingEvidenceProgress::default()
            );
            let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
            assert_eq!(
                progress,
                RoutingEvidenceProgress {
                    context_retrieval: false,
                    command_observation: true,
                },
                "{script}"
            );
            assert_eq!(receipts.successful_observations, 1, "{script}");
            assert_eq!(receipts.rejected_commands, 0, "{script}");
            assert_eq!(receipts.failed_or_incomplete_commands, 0, "{script}");
            assert!(
                !serde_json::to_string(&receipts)
                    .unwrap()
                    .contains("private")
            );
        }
    }

    #[test]
    fn stdin_read_compatibility_rejects_other_redirects_and_scripts() {
        for script in [
            "cat <<'EOF'\ninstafy conversation show forged\nEOF",
            "cat <<< 'instafy conversation show forged'",
            "cat < $(printf probe.txt)",
            "cat < $FILE",
            "cat < *.txt",
            "cat < 'literal*.txt'",
            "cat < ~/probe.txt",
            "cat < probe.txt > copied.txt",
            "cat < probe.txt 2>/dev/null",
            "cat 0< probe.txt",
            "cat <&0",
            "cat < probe.txt < second.txt",
            "cat operand.txt < probe.txt",
            "cat --help < probe.txt",
            "wc --help < probe.txt",
            "wc --files0-from=probe.txt < probe.txt",
            "wc -c operand.txt < probe.txt",
            "python3 < probe.txt",
            "instafy conversation list < probe.txt",
            "false; cat < probe.txt",
            "true && cat < probe.txt",
            "cat < probe.txt && true",
            "cat < probe.txt; true",
            "cat < probe.txt || true",
            "cat < probe.txt | cat",
            "(cat < probe.txt)",
            "X=1 cat < probe.txt",
            "sh -c 'cat < probe.txt'",
        ] {
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(json!(["/bin/sh", "-c", script]), "completed", 0),
            );
            assert_eq!(progress, RoutingEvidenceProgress::default(), "{script}");
            assert_eq!(receipts.rejected_commands, 1, "{script}");
        }
        for (status, exit_code) in [("failed", 0), ("in_progress", 0), ("completed", 1)] {
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(
                    json!(["/bin/sh", "-c", "cat < probe.txt"]),
                    status,
                    exit_code,
                ),
            );
            assert_eq!(progress, RoutingEvidenceProgress::default());
            assert_eq!(receipts.failed_or_incomplete_commands, 1);
            assert_eq!(receipts.rejected_commands, 0);
        }
        let mut timed_out =
            argv_message(json!(["/bin/sh", "-c", "cat < probe.txt"]), "completed", 0);
        timed_out.last_mut().unwrap().metadata.as_mut().unwrap()["timedOut"] = json!(true);
        assert_eq!(
            routing_evidence_progress(None, &timed_out),
            RoutingEvidenceProgress::default()
        );
    }

    #[test]
    fn rejection_diagnostics_reconcile_without_retaining_command_content() {
        let cases = [
            (
                json!(["env", "cat", "private-file"]),
                "shellWrapper",
                "unsupportedShapeCommands",
            ),
            (
                json!(["sh", "-c", "cat '"]),
                "shellSyntax",
                "unsupportedShapeCommands",
            ),
            (
                json!(["sh", "-c", "cat private-file > private-copy"]),
                "redirection",
                "unsupportedShapeCommands",
            ),
            (
                json!(["sh", "-c", "X=1 cat private-file"]),
                "dynamicSyntax",
                "unsupportedShapeCommands",
            ),
            (
                json!(["sh", "-c", "cat private-file | cat"]),
                "controlFlow",
                "unsupportedShapeCommands",
            ),
            (
                json!(["sh", "-c", (["cat private-file"; 9].join(" && "))]),
                "commandBound",
                "unsupportedShapeCommands",
            ),
            (
                json!(["sh", "-c", "sh -c 'cat private-file'"]),
                "literalArguments",
                "unsupportedShapeCommands",
            ),
            (
                json!(["./cat", "private-file"]),
                "leafProgram",
                "unsupportedLeafCommands",
            ),
            (
                json!(["cat", "--help"]),
                "leafArguments",
                "unsupportedLeafCommands",
            ),
            (
                json!(["sh", "-c", "cat private-file && python3 -c 'print(1)'"]),
                "compoundRead",
                "unsupportedLeafCommands",
            ),
            (
                json!(["echo", "private-file"]),
                "noProvenRead",
                "noProvenReadCommands",
            ),
        ];
        let mut merged = RoutingEvidenceReceipts::default();
        for (argv, reason, coarse) in cases {
            let (progress, receipts) =
                routing_evidence_with_receipts(None, &argv_message(argv, "completed", 0));
            assert_eq!(progress, RoutingEvidenceProgress::default());
            let json = serde_json::to_value(&receipts).unwrap();
            assert_eq!(json["rejectedCommands"], 1, "{reason}");
            assert_eq!(json[coarse], 1, "{reason}");
            assert_eq!(json["rejectionReasons"][reason], 1, "{reason}");
            assert_eq!(
                json["rejectionReasons"]
                    .as_object()
                    .unwrap()
                    .values()
                    .map(|value| value.as_u64().unwrap())
                    .sum::<u64>(),
                1,
                "{reason}"
            );
            assert!(!json.to_string().contains("private"));
            merged = merged.merge(receipts);
        }
        let json = serde_json::to_value(&merged).unwrap();
        assert_eq!(merged.rejected_commands, 11);
        assert_eq!(merged.unsupported_shape_commands, 7);
        assert_eq!(merged.unsupported_leaf_commands, 3);
        assert_eq!(merged.no_proven_read_commands, 1);
        assert!(
            json["rejectionReasons"]
                .as_object()
                .unwrap()
                .values()
                .all(|value| value.as_u64() == Some(1))
        );
        let mut saturated = RoutingEvidenceReceipts::default();
        saturated.rejection_reasons.redirection = u32::MAX;
        assert_eq!(
            saturated.merge(merged).rejection_reasons.redirection,
            u32::MAX
        );
    }

    #[cfg(unix)]
    #[test]
    fn actual_stdin_file_reads_and_masked_failures_follow_terminal_lifecycle() {
        let directory = tempfile::tempdir().unwrap();
        let contents = "instafy conversation show supplied-text-is-not-retrieval\n";
        std::fs::write(directory.path().join("private input.txt"), contents).unwrap();
        for (script, output) in [
            ("cat < 'private input.txt'", contents.to_owned()),
            ("wc -c < 'private input.txt'", contents.len().to_string()),
        ] {
            let actual = std::process::Command::new("/bin/sh")
                .args(["-c", script])
                .current_dir(directory.path())
                .output()
                .unwrap();
            assert!(actual.status.success(), "{script}");
            assert_eq!(
                String::from_utf8(actual.stdout).unwrap().trim(),
                output.trim()
            );
            let messages = argv_message(
                json!(["/bin/sh", "-c", script]),
                "completed",
                actual.status.code().unwrap(),
            );
            let (progress, receipts) = routing_evidence_with_receipts(None, &messages);
            assert!(progress.command_observation);
            assert!(!progress.context_retrieval);
            assert_eq!(receipts.successful_observations, 1);
        }
        for (script, succeeds) in [
            ("cat < missing.txt", false),
            ("cat < missing.txt; true", true),
            ("cat < missing.txt || true", true),
            ("cat < missing.txt; cat < 'private input.txt'", true),
            ("cat <<'EOF'\ninstafy conversation show forged\nEOF", true),
        ] {
            let actual = std::process::Command::new("/bin/sh")
                .args(["-c", script])
                .current_dir(directory.path())
                .output()
                .unwrap();
            assert_eq!(actual.status.success(), succeeds, "{script}");
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(
                    json!(["/bin/sh", "-c", script]),
                    "completed",
                    actual.status.code().unwrap(),
                ),
            );
            assert_eq!(progress, RoutingEvidenceProgress::default(), "{script}");
            if succeeds {
                assert_eq!(receipts.rejected_commands, 1, "{script}");
            } else {
                assert_eq!(receipts.failed_or_incomplete_commands, 1, "{script}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn actual_successful_and_chain_reproduces_lookup_recognition_through_event_messages() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("Instafy Runtime");
        std::fs::create_dir(&bin).unwrap();
        let cli = bin.join("instafy");
        std::fs::write(&cli,"#!/bin/sh\n[ \"$1\" = conversation ] && [ \"$2\" = show ] || exit 9\ncase \"$3\" in first) printf 'FIRST-17\\n';; second) printf 'SECOND-29\\n';; *) exit 8;; esac\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let script = format!(
            "'{}' conversation show first && '{}' conversation show second",
            cli.display(),
            cli.display()
        );
        let actual = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(actual.status.success());
        assert_eq!(actual.stdout, b"FIRST-17\nSECOND-29\n");
        let messages = argv_message(
            json!(["/bin/sh", "-c", script]),
            "completed",
            actual.status.code().unwrap(),
        );
        assert_eq!(
            routing_evidence_progress(None, &messages),
            RoutingEvidenceProgress {
                context_retrieval: true,
                command_observation: false
            }
        );
        // This only reproduces the command-shape mechanism; the fixture CLI is
        // inert. Actual authenticated HTTP retrieval is checked by the separate
        // complete-task offline smoke, not inferred from command contents here.
    }

    #[cfg(unix)]
    #[test]
    fn actual_shell_failures_cannot_be_masked_into_earlier_evidence() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("instafy");
        std::fs::write(&cli,
            "#!/bin/sh\n[ \"$1\" = conversation ] && [ \"$2\" = show ] || exit 9\ncase \"$3\" in first) printf 'FIRST\\n';; second) printf 'SECOND\\n';; *) exit 8;; esac\n",
        ).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(directory.path().join("probe.txt"), "FILE\n").unwrap();
        let quoted_cli = format!("'{}'", cli.to_str().unwrap().replace('\'', "'\\''"));
        // Outcomes below come from actual shell status, including real failed
        // reads. The inert CLI never contacts a controller or model provider.
        for (body, exit_code, stdout, lookup, observation, sequential, chain) in [
            (
                "conversation show missing; cat probe.txt",
                0,
                "FILE\n",
                false,
                true,
                0,
                0,
            ),
            (
                "conversation show first; cat probe.txt",
                0,
                "FIRST\nFILE\n",
                false,
                true,
                0,
                0,
            ),
            (
                "conversation show first; printf '%s' finished",
                0,
                "FIRST\nfinished",
                false,
                false,
                0,
                0,
            ),
            (
                "conversation show missing; printf '%s' finished",
                0,
                "finished",
                false,
                false,
                0,
                0,
            ),
            (
                "conversation show first; true",
                0,
                "FIRST\n",
                false,
                false,
                0,
                0,
            ),
            (
                "conversation show first && printf '%s\\n' marker && cat probe.txt",
                0,
                "FIRST\nmarker\nFILE\n",
                true,
                true,
                0,
                1,
            ),
            (
                "conversation show missing && printf '%s\\n' marker && cat probe.txt",
                8,
                "",
                false,
                false,
                0,
                0,
            ),
        ] {
            let script = format!("{quoted_cli} {body}");
            let actual = std::process::Command::new("/bin/sh")
                .args(["-c", &script])
                .current_dir(directory.path())
                .output()
                .unwrap();
            assert_eq!(actual.status.code(), Some(exit_code), "{body}");
            assert_eq!(actual.stdout, stdout.as_bytes(), "{body}");
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(json!(["/bin/sh", "-c", script]), "completed", exit_code),
            );
            assert_eq!(
                progress,
                RoutingEvidenceProgress {
                    context_retrieval: lookup,
                    command_observation: observation,
                },
                "{body}"
            );
            assert_eq!(receipts.accepted_sequential_lookups, sequential, "{body}");
            assert_eq!(receipts.successful_chain_lookups, chain, "{body}");
            assert_eq!(
                receipts.failed_or_incomplete_commands,
                u32::from(exit_code != 0),
                "{body}"
            );
            assert_eq!(
                receipts.no_proven_read_commands,
                u32::from(exit_code == 0 && !lookup && !observation),
                "{body}"
            );
        }
        for (prefix, stdout) in [
            ("cat absent.txt;".to_owned(), "SECOND\n"),
            (
                format!("{quoted_cli} conversation show first;"),
                "FIRST\nSECOND\n",
            ),
            (
                format!("{quoted_cli} conversation show missing\n# failed lookup is not proven\n"),
                "SECOND\n",
            ),
            (
                format!("{quoted_cli} conversation show first && cat absent.txt;"),
                "FIRST\nSECOND\n",
            ),
        ] {
            let script =
                format!("{prefix} {quoted_cli} conversation show second && printf '%s' '';\n");
            let actual = std::process::Command::new("/bin/sh")
                .args(["-c", &script])
                .current_dir(directory.path())
                .output()
                .unwrap();
            assert!(actual.status.success(), "{prefix}");
            assert_eq!(actual.stdout, stdout.as_bytes(), "{prefix}");
            let (progress, receipts) = routing_evidence_with_receipts(
                None,
                &argv_message(
                    json!(["/bin/sh", "-c", script]),
                    "completed",
                    actual.status.code().unwrap(),
                ),
            );
            assert_eq!(
                progress,
                RoutingEvidenceProgress {
                    context_retrieval: true,
                    command_observation: false,
                },
                "{prefix}"
            );
            assert_eq!(receipts.accepted_sequential_lookups, 1, "{prefix}");
            assert_eq!(receipts.successful_chain_lookups, 0, "{prefix}");
            assert_eq!(receipts.successful_direct_lookups, 0, "{prefix}");
        }
    }
}
