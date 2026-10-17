//! Translate provider usage without inventing observations. Missing counters are
//! not zero, and malformed provider values remain malformed for downstream validation.
//! This module does not price requests or authorize credit deductions.

use serde_json::{Map, Value};

/// Codex rejects a completion whose optional `usage` object is present but
/// cannot deserialize. Keep such provider observations as diagnostic metadata
/// instead of inventing missing counters or failing an otherwise valid answer.
pub(crate) fn apply_chat_to_responses_usage(raw: &Value, response: &mut Value) {
    let Some(projected) = chat_to_responses_usage(raw) else {
        return;
    };
    if projected.is_null() || representable_responses_usage(&projected) {
        response["usage"] = projected;
    } else {
        response["usage_metadata"] = serde_json::json!({
            "metadata": {
                "instafy_provider_usage": {
                    "format": "chat_completions",
                    "usage": raw["usage"],
                }
            }
        });
    }
}

fn representable_responses_usage(usage: &Value) -> bool {
    let counter = |value: &Value| value.as_i64().is_some_and(|value| value >= 0);
    let required = |key: &str| usage.get(key).is_some_and(counter);
    if !["input_tokens", "output_tokens", "total_tokens"]
        .into_iter()
        .all(required)
    {
        return false;
    }
    for (details_key, required_key, optional_key) in [
        (
            "input_tokens_details",
            "cached_tokens",
            Some("cache_write_tokens"),
        ),
        ("output_tokens_details", "reasoning_tokens", None),
    ] {
        match usage.get(details_key) {
            None | Some(Value::Null) => {}
            Some(details) if details.is_object() => {
                if !details.get(required_key).is_some_and(counter)
                    || optional_key
                        .and_then(|key| details.get(key))
                        .is_some_and(|value| !counter(value))
                {
                    return false;
                }
            }
            Some(_) => return false,
        }
    }
    true
}

pub(crate) fn chat_to_responses_usage(raw: &Value) -> Option<Value> {
    project_usage(
        raw,
        &[
            ("prompt_tokens", "input_tokens"),
            ("completion_tokens", "output_tokens"),
            ("total_tokens", "total_tokens"),
            ("prompt_tokens_details", "input_tokens_details"),
            ("completion_tokens_details", "output_tokens_details"),
        ],
    )
}

pub(crate) fn responses_to_chat_usage(raw: &Value) -> Option<Value> {
    if raw.get("usage").is_none()
        && let Some(original) = raw.pointer("/usage_metadata/metadata/instafy_provider_usage")
        && original.get("format").and_then(Value::as_str) == Some("chat_completions")
    {
        return original.get("usage").cloned();
    }
    project_usage(
        raw,
        &[
            ("input_tokens", "prompt_tokens"),
            ("output_tokens", "completion_tokens"),
            ("total_tokens", "total_tokens"),
            ("input_tokens_details", "prompt_tokens_details"),
            ("output_tokens_details", "completion_tokens_details"),
        ],
    )
}

fn project_usage(raw: &Value, fields: &[(&str, &str)]) -> Option<Value> {
    let usage = raw.get("usage")?;
    let Some(source) = usage.as_object() else {
        return Some(usage.clone());
    };
    let mut translated = Map::new();
    for &(from, to) in fields {
        if let Some(value) = source.get(from) {
            translated.insert(to.to_string(), value.clone());
        }
    }
    Some(Value::Object(translated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[test]
    fn usage_absence_and_null_remain_distinct_in_both_directions() {
        for project in [chat_to_responses_usage, responses_to_chat_usage] {
            assert_eq!(project(&json!({})), None);
            assert_eq!(project(&json!({"usage": null})), Some(Value::Null));
            assert_eq!(project(&json!({"usage": {}})), Some(json!({})));
            for invalid in [json!(false), json!("unknown"), json!([]), json!(0)] {
                assert_eq!(project(&json!({"usage": invalid})), Some(invalid));
            }
        }
    }

    #[test]
    fn responses_usage_retains_cache_reads_writes_and_output_details() {
        let usage = json!({
            "input_tokens": 100,
            "input_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 20, "audio_tokens": 3},
            "output_tokens": 12,
            "output_tokens_details": {"reasoning_tokens": 7, "accepted_prediction_tokens": 2},
            "total_tokens": 112
        });
        let translated = responses_to_chat_usage(&json!({"usage": usage})).unwrap();
        assert_eq!(
            translated,
            json!({
                "prompt_tokens": 100,
                "prompt_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 20, "audio_tokens": 3},
                "completion_tokens": 12,
                "completion_tokens_details": {"reasoning_tokens": 7, "accepted_prediction_tokens": 2},
                "total_tokens": 112
            })
        );
        assert_eq!(
            chat_to_responses_usage(&json!({"usage": translated})),
            Some(usage)
        );
    }

    #[test]
    fn absent_details_and_totals_are_not_fabricated() {
        assert_eq!(
            chat_to_responses_usage(&json!({"usage": {
                "prompt_tokens": 3, "completion_tokens": 4
            }})),
            Some(json!({"input_tokens": 3, "output_tokens": 4}))
        );
        assert_eq!(
            responses_to_chat_usage(&json!({"usage": {
                "input_tokens_details": {"cached_tokens": 0}
            }})),
            Some(json!({"prompt_tokens_details": {"cached_tokens": 0}}))
        );
    }

    #[test]
    fn reported_zero_is_preserved_without_defaulting_unknown_fields() {
        let usage = json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 0}
        });
        let translated = chat_to_responses_usage(&json!({"usage": usage})).unwrap();
        assert_eq!(
            translated["input_tokens_details"]["cache_write_tokens"],
            json!(0)
        );
        assert_eq!(
            responses_to_chat_usage(&json!({"usage": translated})),
            Some(usage)
        );
    }

    #[test]
    fn malformed_usage_values_are_not_coerced_into_valid_observations() {
        for malformed in [
            json!(null),
            json!(-1),
            json!(1.5),
            json!("20"),
            json!(false),
            json!([]),
        ] {
            let usage = json!({
                "input_tokens": malformed,
                "input_tokens_details": {"cached_tokens": malformed, "cache_write_tokens": malformed},
                "output_tokens": malformed,
                "output_tokens_details": {"reasoning_tokens": malformed},
                "total_tokens": malformed
            });
            let translated = responses_to_chat_usage(&json!({"usage": usage})).unwrap();
            assert_eq!(
                chat_to_responses_usage(&json!({"usage": translated})),
                Some(usage)
            );
        }
    }

    #[test]
    fn malformed_detail_containers_are_preserved() {
        for details in [json!(null), json!(false), json!("unknown"), json!([])] {
            let translated = chat_to_responses_usage(&json!({"usage": {
                "prompt_tokens_details": details, "completion_tokens_details": details
            }}))
            .unwrap();
            assert_eq!(translated["input_tokens_details"], details);
            assert_eq!(translated["output_tokens_details"], details);
        }
    }

    // Mirrors the strict usage subset in pinned Codex's ResponseCompleted
    // decoder. A successful answer must remain decodable when provider usage
    // is partial; the raw observation is retained outside this typed object.
    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Completed {
        id: String,
        usage: Option<CompletedUsage>,
        usage_metadata: Option<Value>,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct CompletedUsage {
        input_tokens: i64,
        input_tokens_details: Option<InputDetails>,
        output_tokens: i64,
        output_tokens_details: Option<OutputDetails>,
        total_tokens: i64,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct InputDetails {
        cached_tokens: i64,
        #[serde(default)]
        cache_write_tokens: i64,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct OutputDetails {
        reasoning_tokens: i64,
    }

    #[test]
    fn partial_and_malformed_provider_usage_cannot_break_completed_answers() {
        let complete = json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15});
        for usage in [
            json!({"prompt_tokens": 10, "completion_tokens": 5}),
            json!({}),
            json!(false),
            json!("unknown"),
            json!({"prompt_tokens": -1, "completion_tokens": 5, "total_tokens": 15}),
            json!({"prompt_tokens": 1.5, "completion_tokens": 5, "total_tokens": 15}),
            json!({"prompt_tokens": 10, "completion_tokens": "5", "total_tokens": 15}),
            json!({"prompt_tokens": u64::MAX, "completion_tokens": 5, "total_tokens": 15}),
            {
                let mut value = complete.clone();
                value["prompt_tokens_details"] = json!({"cache_write_tokens": 3});
                value
            },
            {
                let mut value = complete.clone();
                value["prompt_tokens_details"] =
                    json!({"cached_tokens": 3, "cache_write_tokens": null});
                value
            },
            {
                let mut value = complete.clone();
                value["completion_tokens_details"] = json!({"audio_tokens": 2});
                value
            },
            {
                let mut value = complete.clone();
                value["completion_tokens_details"] = json!([]);
                value
            },
        ] {
            let mut response = json!({"id": "completed-answer", "output": [{"type": "message"}]});
            apply_chat_to_responses_usage(&json!({"usage": usage}), &mut response);
            let decoded: Completed = serde_json::from_value(response.clone()).unwrap();
            assert_eq!(decoded.id, "completed-answer");
            assert!(decoded.usage.is_none());
            assert_eq!(response["output"], json!([{"type": "message"}]));
            assert_eq!(
                decoded.usage_metadata.unwrap()["metadata"]["instafy_provider_usage"],
                json!({
                    "format": "chat_completions", "usage": usage
                })
            );
        }
    }

    #[test]
    fn compatible_usage_keeps_numeric_cache_counts_and_presence() {
        for details in [
            None,
            Some(Value::Null),
            Some(json!({"cached_tokens": 0})),
            Some(json!({"cached_tokens": 4, "cache_write_tokens": 2})),
        ] {
            let mut usage =
                json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15});
            if let Some(details) = details {
                usage["prompt_tokens_details"] = details;
            }
            let mut response = json!({"id": "completed-answer"});
            apply_chat_to_responses_usage(&json!({"usage": usage}), &mut response);
            let decoded: Completed = serde_json::from_value(response.clone()).unwrap();
            assert_eq!(decoded.usage.unwrap().input_tokens, 10);
            assert!(decoded.usage_metadata.is_none());
            assert_eq!(
                response["usage"],
                chat_to_responses_usage(&json!({"usage": usage})).unwrap()
            );
        }
        let mut absent = json!({"id": "completed-answer"});
        apply_chat_to_responses_usage(&json!({}), &mut absent);
        assert!(absent.get("usage").is_none());
        assert!(
            serde_json::from_value::<Completed>(absent)
                .unwrap()
                .usage
                .is_none()
        );
        let mut null = json!({"id": "completed-answer"});
        apply_chat_to_responses_usage(&json!({"usage": null}), &mut null);
        assert_eq!(null.get("usage"), Some(&Value::Null));
        assert!(
            serde_json::from_value::<Completed>(null)
                .unwrap()
                .usage
                .is_none()
        );
    }

    #[test]
    fn diagnostic_chat_usage_roundtrips_without_overriding_typed_observations() {
        for original in [
            json!({"prompt_tokens": 10}),
            json!(false),
            json!([]),
            json!("unknown"),
        ] {
            let mut response = json!({"id": "completed-answer"});
            apply_chat_to_responses_usage(&json!({"usage": original}), &mut response);
            assert_eq!(responses_to_chat_usage(&response), Some(original));
            response["usage"] = Value::Null;
            assert_eq!(responses_to_chat_usage(&response), Some(Value::Null));
            response["usage"] = json!({"input_tokens": 0});
            assert_eq!(
                responses_to_chat_usage(&response),
                Some(json!({"prompt_tokens": 0}))
            );
        }
        assert_eq!(
            responses_to_chat_usage(&json!({"usage_metadata": {"metadata": {
                "instafy_provider_usage": {"format": "unknown", "usage": {"prompt_tokens": 10}}
            }}})),
            None
        );
        assert_eq!(
            responses_to_chat_usage(&json!({"usage_metadata": {"metadata": {
                "instafy_provider_usage": {"format": "chat_completions"}
            }}})),
            None
        );
    }
}
