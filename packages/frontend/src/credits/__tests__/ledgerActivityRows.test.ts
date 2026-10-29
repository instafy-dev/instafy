import { describe, expect, it } from "vitest";
import type { CreditLedgerEntry } from "../creditService";
import { ledgerActivityRows, UNNAMED_CHAT_LABEL } from "../ledgerActivityRows";

const label = (reason: string) => `label:${reason}`;
const entry = (
  reason: string, delta: number, createdAt: string, promptId?: string, chatName?: string,
): CreditLedgerEntry => ({
  reason, delta, createdAt, metadata: promptId ? { promptId } : null, ...(chatName ? { chatName } : {}),
});

describe("ledgerActivityRows", () => {
  it("adds up a turn's reserve, adjustment and refund into one row, at the time it was sent", () => {
    const rows = ledgerActivityRows([
      entry("managed_ai_adjustment", -13, "2026-10-29T09:52:53Z", "p1"),
      entry("hosted_runtime", -90, "2026-10-29T09:51:00Z"),
      entry("managed_ai_prompt", -1, "2026-10-29T09:49:47Z", "p1", "Plan 3 days in Lisbon"),
    ], label);
    expect(rows.map(({ label, delta, createdAt }) => ({ label, delta, createdAt }))).toEqual([
      { label: "label:hosted_runtime", delta: -90, createdAt: "2026-10-29T09:51:00Z" },
      { label: "Plan 3 days in Lisbon", delta: -14, createdAt: "2026-10-29T09:49:47Z" },
    ]);
  });

  it("leaves out a turn that cost nothing in the end, and names a turn without a chat plainly", () => {
    const rows = ledgerActivityRows([
      entry("managed_ai_refund", 1, "2026-10-29T10:08:17Z", "p2", "Compare vacuums"),
      entry("managed_ai_prompt", -1, "2026-10-29T10:07:52Z", "p2", "Compare vacuums"),
      entry("managed_ai_prompt", -1, "2026-10-29T10:01:00Z", "p3"),
      entry("managed_ai_prompt", -1, "2026-10-29T10:00:00Z"),
    ], label);
    expect(rows.map(({ label, delta }) => [label, delta])).toEqual([
      [UNNAMED_CHAT_LABEL, -1],
      [UNNAMED_CHAT_LABEL, -1],
    ]);
  });

  // The panel loads the newest 100 rows. A turn whose reserve is older than
  // the oldest of them arrives with only its later rows, which add up to the
  // wrong amount: a refunded turn would read "+1 credit", a 14-credit turn
  // "-13 credits".
  it("leaves out a turn whose reserve is older than the rows the panel loaded", () => {
    const withCost = (row: CreditLedgerEntry, reservedUnits: number): CreditLedgerEntry => ({
      ...row, metadata: { ...row.metadata, cost: { reservedUnits, chargedUnits: reservedUnits - row.delta } },
    });
    const rows = ledgerActivityRows([
      withCost(entry("managed_ai_adjustment", -4, "2026-10-29T10:21:00Z", "p1", "Hello page"), 1),
      entry("managed_ai_prompt", -1, "2026-10-29T10:20:00Z", "p1", "Hello page"),
      // The oldest rows loaded: each of these turns' reserves came before them.
      entry("managed_ai_refund", 1, "2026-10-29T10:09:00Z", "p2", "Compare vacuums"),
      withCost(entry("managed_ai_adjustment", -13, "2026-10-29T10:08:00Z", "p3", "Plan 3 days in Lisbon"), 1),
      // A turn that reserved nothing has no reserve row to wait for.
      withCost(entry("managed_ai_adjustment", -2, "2026-10-29T10:07:00Z", "p4", "Stop the preview"), 0),
    ], label);
    expect(rows.map(({ label, delta }) => [label, delta])).toEqual([
      ["Hello page", -5],
      ["Stop the preview", -2],
    ]);
  });

  it("keeps two turns of one chat apart", () => {
    const rows = ledgerActivityRows([
      entry("managed_ai_prompt", -1, "2026-10-29T10:20:00Z", "p5", "Hello page"),
      entry("managed_ai_prompt", -1, "2026-10-29T10:18:00Z", "p4", "Hello page"),
      entry("managed_ai_adjustment", -4, "2026-10-29T10:19:25Z", "p4", "Hello page"),
    ], label);
    expect(rows.map(({ label, delta, createdAt }) => [label, delta, createdAt])).toEqual([
      ["Hello page", -1, "2026-10-29T10:20:00Z"],
      ["Hello page", -5, "2026-10-29T10:18:00Z"],
    ]);
  });
});
