//! Prices metered managed-AI requests and rounds them into billing units.
//!
//! Each request is priced exactly in nano-USD, and units are rounded up once
//! per job, on the job's running total. Rounding every request instead would
//! charge up to one extra unit per request: 40 calls of 0.3 units each cost
//! 12 units per job but 40 per request.

/// The pinned managed model's upstream context window, W. OpenAI refuses a
/// longer input with a 400, which is not billed, so W bounds the input of any
/// billed request. It matches Codex's catalog for `gpt-6-luna`; a request
/// reporting more input tokens than this means the bound is wrong.
pub(crate) const MANAGED_AI_MAX_INPUT_TOKENS: u64 = 272_000;

/// The default output ceiling, O, of one platform-lane request. OpenAI
/// enforces it on output, reasoning included.
pub(crate) const DEFAULT_MANAGED_AI_MAX_OUTPUT_TOKENS: u64 = 65_536;

const NANO_USD_PER_USD: u128 = 1_000_000_000;

/// Managed-AI list prices in USD micros per 1K tokens
/// (`MANAGED_AI_{INPUT,CACHED_INPUT,OUTPUT}_USD_MICROS_PER_1K`). One token at
/// `r` micros per 1K costs exactly `r` nano-USD, so every price is an integer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rates {
    pub(crate) input_usd_micros_per_1k: i64,
    pub(crate) cached_input_usd_micros_per_1k: i64,
    pub(crate) output_usd_micros_per_1k: i64,
}

/// The token counts one upstream response reported in its `usage`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RequestTokens {
    /// The whole prompt, cached prefix included.
    pub(crate) input_tokens: u64,
    /// The cached part of `input_tokens`.
    pub(crate) cached_input_tokens: u64,
    pub(crate) output_tokens: u64,
    /// Part of `output_tokens`. Kept for display and never billed again.
    pub(crate) reasoning_tokens: u64,
}

/// The exact price of one request in nano-USD: uncached input at the input
/// rate, the cached prefix once at the cached rate, and output (reasoning
/// included) at the output rate. The cached count is a subset of the input, so
/// one above it is clamped to it. A negative rate prices as zero, and the
/// result saturates at `i64::MAX`, the `cost_nano_usd` column's range.
pub(crate) fn cost_nano(rates: Rates, tokens: RequestTokens) -> i64 {
    let cached = tokens.cached_input_tokens.min(tokens.input_tokens);
    let uncached = tokens.input_tokens - cached;
    let price = |count: u64, usd_micros_per_1k: i64| -> i128 {
        i128::from(count) * i128::from(usd_micros_per_1k.max(0))
    };
    let total = price(uncached, rates.input_usd_micros_per_1k)
        .saturating_add(price(cached, rates.cached_input_usd_micros_per_1k))
        .saturating_add(price(tokens.output_tokens, rates.output_usd_micros_per_1k));
    total.clamp(0, i128::from(i64::MAX)) as i64
}

/// Units a job owes for its running total cost: `ceil(total * U / 10^9)`,
/// where U is `BILLING_UNITS_PER_USD`. A job with any positive cost owes at
/// least 1 unit and a job whose requests all cost nothing owes nothing.
/// Saturates at `i32::MAX`, the `units_due` column's range.
pub(crate) fn units_due(total_cost_nano_usd: i64, units_per_usd: i64) -> i32 {
    if total_cost_nano_usd <= 0 {
        return 0;
    }
    let scaled = total_cost_nano_usd as u128 * units_per_usd.max(0) as u128;
    let units = scaled.div_ceil(NANO_USD_PER_USD).max(1);
    units.min(i32::MAX as u128) as i32
}

/// The units the ledger must hold for a job. A declined ambient evaluation is
/// not charged its first `decline_waiver_units` while no answer is recorded;
/// once one is, it owes everything. `target` never decreases while
/// `units_due` grows and `answered` only turns true, so posting
/// `target - units_posted` never needs a refund.
pub(crate) fn target(units_due: i32, decline_waiver_units: i32, answered: bool) -> i32 {
    let units_due = units_due.max(0);
    if answered {
        return units_due;
    }
    units_due.saturating_sub(decline_waiver_units.max(0)).max(0)
}

/// The most one request can cost, C_max: W uncached input tokens and O output
/// tokens, rounded up to units.
pub(crate) fn c_max(
    rates: Rates,
    units_per_usd: i64,
    max_input_tokens: u64,
    max_output_tokens: u64,
) -> i32 {
    let largest = RequestTokens {
        input_tokens: max_input_tokens,
        output_tokens: max_output_tokens,
        ..RequestTokens::default()
    };
    units_due(cost_nano(rates, largest), units_per_usd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_defaults::{
        DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K,
        DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K, DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K,
    };

    /// `BILLING_UNITS_PER_USD`'s default: one unit is 1,000,000 nano-USD.
    const UNITS_PER_USD: i64 = 1_000;
    /// The waiver a declined ambient evaluation carries by default.
    const X: i32 = 2;

    fn luna() -> Rates {
        Rates {
            input_usd_micros_per_1k: DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K,
            cached_input_usd_micros_per_1k: DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K,
            output_usd_micros_per_1k: DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K,
        }
    }

    fn tokens(input: u64, cached: u64, output: u64) -> RequestTokens {
        RequestTokens {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_tokens: 0,
        }
    }

    #[test]
    fn uncached_cached_and_output_priced_at_their_own_rates() {
        assert_eq!(cost_nano(luna(), tokens(1_000, 0, 0)), 100_000);
        assert_eq!(cost_nano(luna(), tokens(1_000, 1_000, 0)), 10_000);
        assert_eq!(cost_nano(luna(), tokens(0, 0, 1_000)), 500_000);
        // 5,000 uncached, 45,000 cached and 1,000 output tokens.
        assert_eq!(
            cost_nano(luna(), tokens(50_000, 45_000, 1_000)),
            500_000 + 450_000 + 500_000
        );
        assert_eq!(units_due(1_450_000, UNITS_PER_USD), 2);
    }

    #[test]
    fn cached_clamped_to_input() {
        // A cached count above the input is the whole input at the cached
        // rate, never a negative uncached remainder.
        assert_eq!(cost_nano(luna(), tokens(100, 150, 0)), 100 * 10);
        assert_eq!(
            cost_nano(luna(), tokens(100, 150, 0)),
            cost_nano(luna(), tokens(100, 100, 0))
        );
    }

    #[test]
    fn reasoning_not_billed_twice() {
        let plain = tokens(2_000, 0, 1_000);
        let with_reasoning = RequestTokens {
            reasoning_tokens: 600,
            ..plain
        };
        assert_eq!(cost_nano(luna(), with_reasoning), cost_nano(luna(), plain));
        assert_eq!(cost_nano(luna(), with_reasoning), 200_000 + 500_000);
    }

    #[test]
    fn fixture_382_prices_2_912_280_nanos_3_units() {
        let cost = cost_nano(luna(), tokens(50_351, 24_548, 173));
        assert_eq!(cost, 2_580_300 + 245_480 + 86_500);
        assert_eq!(cost, 2_912_280);
        assert_eq!(units_due(cost, UNITS_PER_USD), 3);
    }

    #[test]
    fn per_job_ceil_running_total() {
        // 0.3, 0.6 and 1.1 units. The job's running ceiling posts 1, 0 and 1;
        // rounding each request would charge 1 + 1 + 2 = 4.
        let requests = [300_000_i64, 600_000, 1_100_000];
        let mut total = 0_i64;
        let mut posted = 0;
        let mut posts = Vec::new();
        for cost in requests {
            total = total.saturating_add(cost);
            let owed = target(units_due(total, UNITS_PER_USD), 0, false);
            posts.push(owed - posted);
            posted = owed;
        }
        assert_eq!(posts, [1, 0, 1]);
        assert_eq!(posted, 2);
        let per_request: i32 = requests
            .iter()
            .map(|cost| units_due(*cost, UNITS_PER_USD))
            .sum();
        assert_eq!(per_request, 4);

        // A direct-worker job of 40 calls with 2k input and 200 output each.
        let call = cost_nano(luna(), tokens(2_000, 0, 200));
        assert_eq!(call, 300_000);
        assert_eq!(units_due(call * 40, UNITS_PER_USD), 12);
        assert_eq!(units_due(call, UNITS_PER_USD) * 40, 40);
    }

    #[test]
    fn positive_cost_pays_at_least_one_unit() {
        assert_eq!(units_due(1, UNITS_PER_USD), 1);
        assert_eq!(cost_nano(luna(), tokens(1, 1, 0)), 10);
        assert_eq!(
            units_due(cost_nano(luna(), tokens(1, 1, 0)), UNITS_PER_USD),
            1
        );
        assert_eq!(units_due(1_000_000, UNITS_PER_USD), 1);
        assert_eq!(units_due(1_000_001, UNITS_PER_USD), 2);
        // Even a units-per-USD that rounds every cost to nothing charges 1.
        assert_eq!(units_due(1, 0), 1);
    }

    #[test]
    fn zero_cost_zero_units() {
        assert_eq!(cost_nano(luna(), RequestTokens::default()), 0);
        assert_eq!(units_due(0, UNITS_PER_USD), 0);
        let free = Rates {
            input_usd_micros_per_1k: 0,
            cached_input_usd_micros_per_1k: 0,
            output_usd_micros_per_1k: 0,
        };
        assert_eq!(cost_nano(free, tokens(50_000, 10_000, 5_000)), 0);
        assert_eq!(
            units_due(
                cost_nano(free, tokens(50_000, 10_000, 5_000)),
                UNITS_PER_USD
            ),
            0
        );
        assert_eq!(target(0, X, false), 0);
        assert_eq!(target(0, X, true), 0);
    }

    #[test]
    fn waiver_applies_until_answered() {
        // A decline costing 1.4 units owes 2 and is charged nothing.
        let small = units_due(1_400_000, UNITS_PER_USD);
        assert_eq!(small, 2);
        assert_eq!(target(small, X, false), 0);
        // A decline costing 5.2 units owes 6 and is charged 4.
        let large = units_due(5_200_000, UNITS_PER_USD);
        assert_eq!(large, 6);
        assert_eq!(target(large, X, false), 4);
        // An answered evaluation owes everything, and a job without a waiver
        // is never discounted.
        assert_eq!(target(small, X, true), 2);
        assert_eq!(target(large, X, true), 6);
        assert_eq!(target(large, 0, false), 6);
    }

    #[test]
    fn target_monotone_under_answer_flip() {
        // Settles only raise units_due and an answer only flips answered to
        // true, so whatever order they land in the posted target never falls.
        for waiver in 0..=4 {
            // An answer at 13 never lands inside the range: never answered.
            for answer_at in 0..=13 {
                let mut previous = 0;
                for due in 0..=12 {
                    let current = target(due, waiver, due >= answer_at);
                    assert!(
                        current >= previous,
                        "waiver {waiver}, answered at {answer_at}: {previous} then {current}"
                    );
                    assert!(current <= due);
                    previous = current;
                }
            }
        }
    }

    #[test]
    fn c_max_defaults_to_60() {
        // ceil((272,000 * 100 + 65,536 * 500) * 1000 / 10^9) = ceil(59.968).
        assert_eq!(
            cost_nano(
                luna(),
                tokens(
                    MANAGED_AI_MAX_INPUT_TOKENS,
                    0,
                    DEFAULT_MANAGED_AI_MAX_OUTPUT_TOKENS
                )
            ),
            59_968_000
        );
        assert_eq!(
            c_max(
                luna(),
                UNITS_PER_USD,
                MANAGED_AI_MAX_INPUT_TOKENS,
                DEFAULT_MANAGED_AI_MAX_OUTPUT_TOKENS
            ),
            60
        );
    }

    #[test]
    fn saturating_overflow() {
        let extreme = Rates {
            input_usd_micros_per_1k: i64::MAX,
            cached_input_usd_micros_per_1k: i64::MAX,
            output_usd_micros_per_1k: i64::MAX,
        };
        let most = tokens(u64::MAX, u64::MAX / 2, u64::MAX);
        assert_eq!(cost_nano(extreme, most), i64::MAX);
        assert_eq!(units_due(i64::MAX, i64::MAX), i32::MAX);
        assert_eq!(units_due(i64::MAX, UNITS_PER_USD), i32::MAX);
        assert_eq!(c_max(extreme, i64::MAX, u64::MAX, u64::MAX), i32::MAX);
        assert_eq!(target(i32::MAX, i32::MAX, false), 0);
        assert_eq!(target(i32::MAX, 0, false), i32::MAX);
        assert_eq!(target(i32::MAX, X, true), i32::MAX);
        // Out-of-range inputs never price below zero.
        let negative = Rates {
            input_usd_micros_per_1k: -100,
            cached_input_usd_micros_per_1k: i64::MIN,
            output_usd_micros_per_1k: -500,
        };
        assert_eq!(cost_nano(negative, tokens(10_000, 5_000, 1_000)), 0);
        assert_eq!(units_due(i64::MIN, UNITS_PER_USD), 0);
        assert_eq!(units_due(1_000_000, i64::MIN), 1);
        assert_eq!(target(-5, X, false), 0);
        assert_eq!(target(-5, X, true), 0);
        assert_eq!(target(5, i32::MIN, false), 5);
    }
}
