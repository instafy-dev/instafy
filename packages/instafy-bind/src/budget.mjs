// Per-site Octo budget: at most N agent dispatches (first turns and repair turns) per rolling hour.
// Persisted in <site>/.bind/agent-budget.json so a restart does not reset it.
import fs from "node:fs";
import path from "node:path";
import { bindDir } from "./tokens.mjs";

export const DEFAULT_AGENT_BUDGET_PER_HOUR = 20;
const WINDOW_MS = 60 * 60 * 1000;

export class AgentBudget {
  /** @param {{dir: string, perHour?: number, now?: () => number}} options */
  constructor({ dir, perHour = DEFAULT_AGENT_BUDGET_PER_HOUR, now = () => Date.now() }) {
    this.file = dir ? path.join(bindDir(dir), "agent-budget.json") : null;
    this.perHour = perHour;
    this.now = now;
    this.stamps = [];
    if (this.file) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (Array.isArray(saved.dispatches)) this.stamps = saved.dispatches.filter((t) => Number.isFinite(t));
      } catch {
        // no budget file yet
      }
    }
  }

  prune() {
    const cutoff = this.now() - WINDOW_MS;
    this.stamps = this.stamps.filter((t) => t > cutoff);
  }

  remaining() {
    this.prune();
    return Math.max(0, this.perHour - this.stamps.length);
  }

  /** Seconds until one more dispatch fits, 0 when one fits now. */
  retryAfterS() {
    this.prune();
    if (this.stamps.length < this.perHour) return 0;
    const oldest = Math.min(...this.stamps);
    return Math.max(1, Math.ceil((oldest + WINDOW_MS - this.now()) / 1000));
  }

  /** Record one dispatch. Returns false (and records nothing) when the budget is spent. */
  take() {
    if (this.remaining() <= 0) return false;
    this.stamps.push(this.now());
    if (this.file) {
      try {
        fs.writeFileSync(this.file, `${JSON.stringify({ per_hour: this.perHour, dispatches: this.stamps })}\n`, { mode: 0o600 });
      } catch {
        // the in-memory budget still applies
      }
    }
    return true;
  }
}
