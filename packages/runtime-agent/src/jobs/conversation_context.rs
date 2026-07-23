use std::env;

use serde_json::{Value as JsonValue, json};

const DEFAULT_STATELESS_HISTORY_TARGET_TOKENS: usize = 6_000;
const DEFAULT_STATELESS_RECENT_TURNS: usize = 8;
const DEFAULT_STATELESS_SUMMARIZED_TURNS: usize = 12;
const DEFAULT_SUMMARY_SNIPPET_CHARS: usize = 220;

#[derive(Debug, Clone)]
pub struct ConversationTurn {
    pub role: String,
    pub content: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PromptConversationContext {
    pub section_label: &'static str,
    pub section_text: String,
    pub metrics: JsonValue,
}

pub fn parse_conversation_history(value: Option<&JsonValue>) -> Vec<ConversationTurn> {
    let Some(JsonValue::Array(entries)) = value else {
        return Vec::new();
    };

    let mut turns = Vec::new();
    for entry in entries {
        let Some(map) = entry.as_object() else {
            continue;
        };
        let role = map
            .get("role")
            .and_then(JsonValue::as_str)
            .unwrap_or("assistant")
            .to_string();
        let content = map
            .get("content")
            .and_then(JsonValue::as_str)
            .map(|value| value.to_string())
            .unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        let created_at = map
            .get("createdAt")
            .and_then(JsonValue::as_str)
            .map(|value| value.to_string());
        turns.push(ConversationTurn {
            role,
            content,
            created_at,
        });
    }

    turns
}

pub fn format_conversation_history(turns: &[ConversationTurn]) -> String {
    if turns.is_empty() {
        return "(no previous conversation history)".to_string();
    }

    let mut formatted = String::new();
    for turn in turns {
        let speaker = format_role_label(&turn.role);
        let content = turn.content.trim();
        if let Some(timestamp) = &turn.created_at {
            formatted.push_str(speaker);
            formatted.push_str(" [");
            formatted.push_str(timestamp);
            formatted.push_str("]: ");
            formatted.push_str(content);
            formatted.push('\n');
        } else {
            formatted.push_str(speaker);
            formatted.push_str(": ");
            formatted.push_str(content);
            formatted.push('\n');
        }
    }

    formatted.trim().to_string()
}

pub fn build_prompt_conversation_context(
    history_value: Option<&JsonValue>,
    provider_state: Option<&JsonValue>,
) -> PromptConversationContext {
    let turns = parse_conversation_history(history_value);
    let history_replay_required =
        provider_state_bool(provider_state, "historyReplayRequired").unwrap_or(false);
    let stateful_thread_restored =
        provider_thread_available(provider_state) && !history_replay_required;
    let model_context_window = resolve_effective_model_context_window();

    if stateful_thread_restored {
        let section_text = "The provider thread was restored successfully, so the full prior conversation is already present in the model state. Focus on the latest user request below and reuse the existing thread context instead of asking the user to repeat themselves.".to_string();
        return PromptConversationContext {
            section_label: "Conversation state",
            metrics: json!({
                "mode": "provider_thread_restored",
                "historyReplayRequired": false,
                "statefulThreadRestored": true,
                "totalTurns": turns.len(),
                "includedTurns": 0,
                "summarizedTurns": 0,
                "omittedTurns": turns.len(),
                "estimatedHistoryTokens": estimate_token_count(&section_text),
                "historyTargetTokens": 0,
                "modelContextWindow": model_context_window,
            }),
            section_text,
        };
    }

    let full_history = format_conversation_history(&turns);
    let full_history_tokens = estimate_token_count(&full_history);
    let history_target_tokens = resolve_env_usize(
        "INSTAFY_STATELESS_HISTORY_TARGET_TOKENS",
        DEFAULT_STATELESS_HISTORY_TARGET_TOKENS,
    );

    if turns.is_empty() || full_history_tokens <= history_target_tokens {
        return PromptConversationContext {
            section_label: "Recent conversation turns",
            metrics: json!({
                "mode": "stateless_full",
                "historyReplayRequired": history_replay_required,
                "statefulThreadRestored": false,
                "totalTurns": turns.len(),
                "includedTurns": turns.len(),
                "summarizedTurns": 0,
                "omittedTurns": 0,
                "estimatedHistoryTokens": full_history_tokens,
                "historyTargetTokens": history_target_tokens,
                "modelContextWindow": model_context_window,
            }),
            section_text: full_history,
        };
    }

    build_compacted_context(
        &turns,
        history_replay_required,
        history_target_tokens,
        model_context_window,
    )
}

pub fn enrich_prompt_context_metrics(metrics: &mut JsonValue, prompt: &str) {
    let Some(map) = metrics.as_object_mut() else {
        return;
    };
    let estimated_prompt_tokens = estimate_token_count(prompt);
    map.insert(
        "estimatedPromptTokens".to_string(),
        JsonValue::from(estimated_prompt_tokens as u64),
    );
    if let Some(model_context_window) = map.get("modelContextWindow").and_then(JsonValue::as_u64)
        && model_context_window > 0
    {
        let percent = ((estimated_prompt_tokens as f64 / model_context_window as f64) * 1000.0)
            .round()
            / 10.0;
        map.insert("estimatedPromptUsagePercent".to_string(), json!(percent));
    }
}

pub fn estimate_prompt_token_count(value: &str) -> usize {
    estimate_token_count(value)
}

fn build_compacted_context(
    turns: &[ConversationTurn],
    history_replay_required: bool,
    history_target_tokens: usize,
    model_context_window: Option<usize>,
) -> PromptConversationContext {
    let recent_turn_limit = resolve_env_usize(
        "INSTAFY_STATELESS_HISTORY_RECENT_TURNS",
        DEFAULT_STATELESS_RECENT_TURNS,
    );
    let summarized_turn_limit = resolve_env_usize(
        "INSTAFY_STATELESS_HISTORY_SUMMARIZED_TURNS",
        DEFAULT_STATELESS_SUMMARIZED_TURNS,
    );
    let snippet_chars = resolve_env_usize(
        "INSTAFY_STATELESS_HISTORY_SUMMARY_CHARS",
        DEFAULT_SUMMARY_SNIPPET_CHARS,
    );

    let recent_token_budget = history_target_tokens.saturating_mul(2) / 3;
    let mut recent_turns_reversed: Vec<&ConversationTurn> = Vec::new();
    let mut recent_tokens = 0usize;

    for turn in turns.iter().rev() {
        let formatted = format_single_turn(turn);
        let tokens = estimate_token_count(&formatted);
        let would_exceed_budget =
            !recent_turns_reversed.is_empty() && recent_tokens + tokens > recent_token_budget;
        if recent_turns_reversed.len() >= recent_turn_limit || would_exceed_budget {
            break;
        }
        recent_tokens += tokens;
        recent_turns_reversed.push(turn);
    }

    if recent_turns_reversed.is_empty() && !turns.is_empty() {
        recent_turns_reversed.push(turns.last().expect("last turn exists"));
    }

    recent_turns_reversed.reverse();
    let recent_count = recent_turns_reversed.len();
    let older_turns = &turns[..turns.len().saturating_sub(recent_count)];

    let summary_candidates = if older_turns.len() > summarized_turn_limit {
        &older_turns[older_turns.len() - summarized_turn_limit..]
    } else {
        older_turns
    };

    let mut summary_lines: Vec<String> = Vec::new();
    let mut summary_tokens = 0usize;
    let summary_budget = history_target_tokens.saturating_sub(recent_tokens);

    for turn in summary_candidates {
        let line = format_summary_turn(turn, snippet_chars);
        let line_tokens = estimate_token_count(&line);
        if !summary_lines.is_empty() && summary_tokens + line_tokens > summary_budget {
            break;
        }
        summary_tokens += line_tokens;
        summary_lines.push(line);
    }

    let summarized_turns = summary_lines.len();
    let omitted_turns = turns
        .len()
        .saturating_sub(recent_count)
        .saturating_sub(summarized_turns);

    let mut section_text = String::new();
    if !summary_lines.is_empty() {
        section_text.push_str("Condensed earlier turns:\n");
        for line in &summary_lines {
            section_text.push_str(line);
            section_text.push('\n');
        }
        if omitted_turns > 0 {
            section_text.push_str("- ");
            section_text.push_str(&format!(
                "{omitted_turns} earlier turn(s) omitted to stay within the prompt budget."
            ));
            section_text.push('\n');
        }
        section_text.push('\n');
    }

    section_text.push_str("Recent turns:\n");
    section_text.push_str(&format_conversation_history(
        &recent_turns_reversed
            .into_iter()
            .cloned()
            .collect::<Vec<_>>(),
    ));

    PromptConversationContext {
        section_label: "Compacted conversation context",
        metrics: json!({
            "mode": "stateless_compacted",
            "historyReplayRequired": history_replay_required,
            "statefulThreadRestored": false,
            "totalTurns": turns.len(),
            "includedTurns": recent_count,
            "summarizedTurns": summarized_turns,
            "omittedTurns": omitted_turns,
            "estimatedHistoryTokens": estimate_token_count(&section_text),
            "historyTargetTokens": history_target_tokens,
            "modelContextWindow": model_context_window,
        }),
        section_text,
    }
}

fn provider_thread_available(state: Option<&JsonValue>) -> bool {
    [
        "defaultThreadId",
        "browserThreadId",
        "threadId",
        "defaultRolloutPath",
        "browserRolloutPath",
        "rolloutPath",
    ]
    .iter()
    .any(|key| provider_state_string(state, key).is_some())
}

fn provider_state_string(state: Option<&JsonValue>, key: &str) -> Option<String> {
    state
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get(key))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn provider_state_bool(state: Option<&JsonValue>, key: &str) -> Option<bool> {
    state
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get(key))
        .and_then(JsonValue::as_bool)
}

fn resolve_effective_model_context_window() -> Option<usize> {
    let raw_context_window = env::var("INSTAFY_AI_MODEL_CONTEXT_WINDOW")
        .ok()
        .or_else(|| env::var("CODEX_MODEL_CONTEXT_WINDOW").ok())
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)?;
    let percent = env::var("INSTAFY_AI_MODEL_CONTEXT_WINDOW_PERCENT")
        .ok()
        .or_else(|| env::var("CODEX_MODEL_CONTEXT_WINDOW_PERCENT").ok())
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(100);
    Some(
        raw_context_window
            .saturating_mul(percent)
            .saturating_div(100),
    )
}

fn resolve_env_usize(key: &str, default_value: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_value)
}

fn estimate_token_count(value: &str) -> usize {
    let char_count = value.chars().count();
    if char_count == 0 {
        0
    } else {
        (char_count + 3) / 4
    }
}

fn compact_content(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let truncated = normalized
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    format!("{}…", truncated.trim_end())
}

fn format_role_label(role: &str) -> &'static str {
    if role.eq_ignore_ascii_case("user") {
        "User"
    } else {
        "Assistant"
    }
}

fn format_single_turn(turn: &ConversationTurn) -> String {
    let speaker = format_role_label(&turn.role);
    let content = turn.content.trim();
    if let Some(timestamp) = &turn.created_at {
        format!("{speaker} [{timestamp}]: {content}")
    } else {
        format!("{speaker}: {content}")
    }
}

fn format_summary_turn(turn: &ConversationTurn, snippet_chars: usize) -> String {
    let speaker = format_role_label(&turn.role);
    let compacted = compact_content(&turn.content, snippet_chars);
    format!("- {speaker}: {compacted}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_provider_thread_note_when_history_replay_is_not_required() {
        let history = json!([
            { "role": "user", "content": "First" },
            { "role": "assistant", "content": "Second" }
        ]);
        let provider_state = json!({
            "threadId": "thread-1",
            "historyReplayRequired": false
        });

        let result = build_prompt_conversation_context(Some(&history), Some(&provider_state));

        assert_eq!(result.section_label, "Conversation state");
        assert_eq!(result.metrics["mode"], json!("provider_thread_restored"));
        assert_eq!(result.metrics["statefulThreadRestored"], json!(true));
        assert!(
            result
                .section_text
                .contains("full prior conversation is already present")
        );
    }

    #[test]
    fn compacts_stateless_history_when_it_exceeds_budget() {
        let history = JsonValue::Array(
            (0..20)
                .map(|index| {
                    json!({
                        "role": if index % 2 == 0 { "user" } else { "assistant" },
                        "content": format!("Turn {index} {}", "x".repeat(2_000)),
                        "createdAt": format!("2026-03-21T12:{index:02}:00Z"),
                    })
                })
                .collect(),
        );

        let result = build_prompt_conversation_context(Some(&history), None);

        assert_eq!(result.metrics["mode"], json!("stateless_compacted"));
        assert!(result.section_text.contains("Condensed earlier turns:"));
        assert!(result.section_text.contains("Recent turns:"));
        assert!(result.metrics["omittedTurns"].as_u64().unwrap_or(0) > 0);
    }

    #[test]
    fn enriches_prompt_metrics_with_estimated_prompt_usage() {
        let mut metrics = json!({
            "mode": "stateless_full",
            "modelContextWindow": 1000
        });

        enrich_prompt_context_metrics(&mut metrics, &"x".repeat(800));

        assert_eq!(metrics["estimatedPromptTokens"], json!(200));
        assert_eq!(metrics["estimatedPromptUsagePercent"], json!(20.0));
    }
}
