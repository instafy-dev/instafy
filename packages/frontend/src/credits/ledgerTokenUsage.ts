export type LedgerTokenUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** Tokens the row accounts for: input plus output. */
  totalTokens: number;
};

function parseCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Reads the token counts a managed-AI ledger row carries. `input_tokens` is the
 * whole prompt with its cached prefix included (`cached_input_tokens` is a
 * subset of it), so the cached count must not be added to the total again.
 */
export function parseLedgerTokenUsage(usage: Record<string, unknown> | null): LedgerTokenUsage {
  const inputTokens = parseCount(usage?.["input_tokens"]);
  const cachedInputTokens = parseCount(usage?.["cached_input_tokens"]);
  const outputTokens = parseCount(usage?.["output_tokens"]);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}
