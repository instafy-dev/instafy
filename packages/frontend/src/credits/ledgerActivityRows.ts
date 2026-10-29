import type { CreditLedgerEntry } from "./creditService";

/** One row of the Credits panel's activity log. */
export type LedgerActivityRow = {
  key: string;
  /** Plain words: the chat an Instafy AI turn was in, or what the entry was. */
  label: string;
  delta: number;
  createdAt: string;
};

/**
 * The ledger rows one Instafy AI turn writes, each with the turn's
 * `promptId`: the reserve at the send, the adjustment to its real tokens, and
 * the refund of a turn that cost nothing (docs/Credits-Billing.md).
 */
const TURN_REASONS = new Set(["managed_ai_prompt", "managed_ai_adjustment", "managed_ai_refund"]);

/** What a turn reads as when the controller names no chat the viewer can open. */
export const UNNAMED_CHAT_LABEL = "A chat";

function isTurnEntry(entry: CreditLedgerEntry): boolean {
  return TURN_REASONS.has(entry.reason.trim());
}

function turnIdOf(entry: CreditLedgerEntry): string | null {
  if (!isTurnEntry(entry)) return null;
  const promptId = entry.metadata?.["promptId"];
  return typeof promptId === "string" && promptId.trim() ? promptId.trim() : null;
}

function timeOf(createdAt: string): number {
  const time = Date.parse(createdAt);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * The activity log's rows, newest first. Each Instafy AI turn is one row: its
 * reserve, adjustment and refund added up, named by its chat, at the time it
 * was sent. A turn that cost nothing in the end (refunded in full) is left
 * out, since it did not change the balance. A turn's row that names no turn
 * stays a row of its own, as "A chat"; every other entry is a row of its own,
 * named by `labelFor`.
 */
export function ledgerActivityRows(
  entries: readonly CreditLedgerEntry[],
  labelFor: (reason: string) => string,
): LedgerActivityRow[] {
  const rows: LedgerActivityRow[] = [];
  const turns = new Map<string, LedgerActivityRow>();
  entries.forEach((entry, index) => {
    const turnId = turnIdOf(entry);
    const chatName = entry.chatName?.trim() || null;
    if (!turnId) {
      rows.push({
        key: `${entry.createdAt}-${entry.reason}-${index}`,
        label: isTurnEntry(entry) ? chatName ?? UNNAMED_CHAT_LABEL : labelFor(entry.reason),
        delta: entry.delta,
        createdAt: entry.createdAt,
      });
      return;
    }
    const turn = turns.get(turnId);
    if (!turn) {
      const row = {
        key: `turn-${turnId}`,
        label: chatName ?? UNNAMED_CHAT_LABEL,
        delta: entry.delta,
        createdAt: entry.createdAt,
      };
      turns.set(turnId, row);
      rows.push(row);
      return;
    }
    turn.delta += entry.delta;
    if (timeOf(entry.createdAt) < timeOf(turn.createdAt)) turn.createdAt = entry.createdAt;
    if (chatName && turn.label === UNNAMED_CHAT_LABEL) turn.label = chatName;
  });
  const turnRows = new Set(turns.values());
  return rows
    .filter((row) => !(turnRows.has(row) && row.delta === 0))
    .map((row, order) => ({ row, order }))
    .sort((a, b) => timeOf(b.row.createdAt) - timeOf(a.row.createdAt) || a.order - b.order)
    .map(({ row }) => row);
}
