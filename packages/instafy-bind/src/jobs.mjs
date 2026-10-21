// Job queue per site: 2 concurrent jobs, coalescing of identical (name, params) within 60 s,
// cooldown per (name, params.ref), a rate cap per intent, a cap on waiting jobs, timeouts, confirmation and cancel.
// Every state change is broadcast once per intent id, so each viewer whose click joined a job hears about it.
import { DEFAULT_AGENT_TIMEOUT_S, DEFAULT_SCRIPT_TIMEOUT_S, executorOf } from "./bound.mjs";
import { applyBatch, bumpVersion } from "./apply.mjs";
import { ERROR_CODES, clip, hostMessage, newJobId, stableStringify } from "./protocol.mjs";
import { randomToken, tokensEqual } from "./tokens.mjs";

export const MAX_CONCURRENT = 2;
export const COALESCE_MS = 60_000;
/** Jobs waiting (queued or needs_confirm) per site; more are refused with 429 "busy". */
export const MAX_WAITING = 20;
/** Accepted intents per intent name per minute, across all viewers. */
export const RATE_PER_MIN = 30;
/** Viewers that can share one coalesced job. */
export const MAX_IDS_PER_JOB = 10;
const KEEP_JOBS = 200;
const FINISHED = ["done", "error"];

export class JobManager {
  /**
   * @param {object} options
   * @param {{dir: string, bound: object, name?: string}} options.site
   * @param {{broadcast: (msg: object) => number}} options.hub
   * @param {(job: object, ctx: object) => Promise<{summary?: string}|void>} options.runExecutor
   * @param {(def: object, executor: string) => {http: number, body: object}|null} [options.admit] extra admission check (the Octo budget)
   */
  constructor({
    site, hub, runExecutor, admit = () => null, log = () => {}, maxConcurrent = MAX_CONCURRENT, coalesceMs = COALESCE_MS,
    maxWaiting = MAX_WAITING, ratePerMin = RATE_PER_MIN, confirmAll = false, now = () => Date.now(),
  }) {
    this.site = site;
    this.hub = hub;
    this.runExecutor = runExecutor;
    this.admit = admit;
    this.log = log;
    this.maxConcurrent = maxConcurrent;
    this.coalesceMs = coalesceMs;
    this.maxWaiting = maxWaiting;
    this.ratePerMin = ratePerMin;
    this.confirmAll = confirmAll;
    this.now = now;
    this.jobs = [];
    this.byIntentId = new Map();
    /** cooldown key -> {at, ms} */
    this.lastAccepted = new Map();
    /** intent name -> accepted timestamps in the last minute */
    this.recent = new Map();
    /** Slots in use. A slot is held until the executor itself settles (an Octo run is cancelled first). */
    this.running = 0;
  }

  /** One host message per intent id of the job. Returns the last event id. */
  broadcast(type, job, fields = {}, ids = job.ids) {
    let event = 0;
    for (const id of ids) {
      event = this.hub.broadcast(hostMessage(type, { id, ids: [...job.ids], job: job.id, name: job.name, ...(job.ref ? { ref: job.ref } : {}), ...fields }));
    }
    return event;
  }

  markVersion(job, state, ids = job.ids) {
    try {
      bumpVersion(this.site.dir, { jobs: Object.fromEntries(ids.map((id) => [id, state])) });
    } catch (error) {
      this.log("warn", `version.json: ${error.message}`);
    }
  }

  pruneLimits(now) {
    for (const [key, entry] of this.lastAccepted) if (now - entry.at >= entry.ms) this.lastAccepted.delete(key);
    for (const [name, stamps] of this.recent) {
      const fresh = stamps.filter((t) => now - t < 60_000);
      if (fresh.length) this.recent.set(name, fresh);
      else this.recent.delete(name);
    }
  }

  /** Accept a validated intent. Returns {http, body}. The body carries a cancel_key for the submitting viewer only. */
  submit(msg, def) {
    const existing = this.byIntentId.get(msg.id);
    if (existing) return { http: 409, body: { status: existing.state === "needs_confirm" ? "needs_confirm" : "queued", id: msg.id, job: existing.id } };

    const now = this.now();
    this.pruneLimits(now);
    const key = `${msg.name}\u0000${stableStringify(msg.params)}`;
    const twin = this.jobs.find((job) => job.key === key && ["needs_confirm", "queued", "running"].includes(job.state) && now - job.createdAt < this.coalesceMs);
    if (twin && twin.ids.length < MAX_IDS_PER_JOB) {
      const cancelKey = randomToken(18);
      twin.ids.push(msg.id);
      twin.cancelKeys.set(msg.id, cancelKey);
      this.byIntentId.set(msg.id, twin);
      const status = twin.state === "running" ? "running" : twin.state === "needs_confirm" ? "needs_confirm" : "queued";
      this.broadcast("ack", twin, { status, coalesced: true }, [msg.id]);
      return { http: 202, body: { status: status === "running" ? "queued" : status, id: msg.id, job: twin.id, coalesced: true, cancel_key: cancelKey } };
    }

    // Cooldown per (name, params.ref): params.ref is schema-checked; the envelope ref is a page hint and never a key.
    const ref = typeof msg.params.ref === "string" ? msg.params.ref : null;
    const cooldownKey = `${msg.name}\u0000${ref ?? ""}`;
    const cooldownMs = (def.cooldown_s ?? 0) * 1000;
    const last = this.lastAccepted.get(cooldownKey);
    if (cooldownMs > 0 && last && now - last.at < cooldownMs) {
      const retry = Math.ceil((cooldownMs - (now - last.at)) / 1000);
      return { http: 429, body: { status: "rejected", id: msg.id, reason: "cooldown", retry_after_s: retry } };
    }
    const stamps = this.recent.get(msg.name) || [];
    if (stamps.length >= this.ratePerMin) {
      const retry = Math.max(1, Math.ceil((stamps[0] + 60_000 - now) / 1000));
      return { http: 429, body: { status: "rejected", id: msg.id, reason: "rate", retry_after_s: retry } };
    }
    const waiting = this.jobs.filter((job) => job.state === "queued" || job.state === "needs_confirm").length;
    if (waiting >= this.maxWaiting) {
      return { http: 429, body: { status: "rejected", id: msg.id, reason: "busy", retry_after_s: 10 } };
    }
    const executor = executorOf(def);
    const refused = this.admit(def, executor);
    if (refused) return { http: refused.http, body: { status: "rejected", id: msg.id, ...refused.body } };

    if (cooldownMs > 0) this.lastAccepted.set(cooldownKey, { at: now, ms: cooldownMs });
    this.recent.set(msg.name, [...stamps, now]);

    const timeoutS = def.timeout_s ?? (executor === "agent" ? def.agent?.timeout_s ?? DEFAULT_AGENT_TIMEOUT_S : DEFAULT_SCRIPT_TIMEOUT_S);
    const cancelKey = randomToken(18);
    const job = {
      id: newJobId(now),
      name: msg.name,
      def,
      executor,
      intent: msg,
      ids: [msg.id],
      cancelKeys: new Map([[msg.id, cancelKey]]),
      key,
      ref: ref ?? msg.ref ?? null,
      state: def.confirm || this.confirmAll ? "needs_confirm" : "queued",
      createdAt: now,
      startedAt: null,
      endedAt: null,
      timeoutMs: timeoutS * 1000,
      records: 0,
      rejected: 0,
      summary: null,
      error: null,
      abort: new AbortController(),
    };
    this.jobs.push(job);
    if (this.jobs.length > KEEP_JOBS) {
      // Evict the oldest finished jobs only; waiting and running jobs always stay.
      let excess = this.jobs.length - KEEP_JOBS;
      this.jobs = this.jobs.filter((old) => {
        if (excess > 0 && FINISHED.includes(old.state)) {
          excess -= 1;
          for (const id of old.ids) this.byIntentId.delete(id);
          return false;
        }
        return true;
      });
    }
    this.byIntentId.set(msg.id, job);
    this.broadcast("ack", job, { status: job.state });
    this.log("info", `${job.id} ${msg.name} ${job.state}${job.ref ? ` ref=${job.ref}` : ""}`);
    if (job.state === "queued") queueMicrotask(() => this.pump());
    return { http: 202, body: { status: job.state, id: msg.id, job: job.id, cancel_key: cancelKey } };
  }

  /** Confirm or decline a job waiting in needs_confirm. Returns the job or null. */
  confirm(jobId, ok = true) {
    const job = this.jobs.find((j) => j.id === jobId && j.state === "needs_confirm");
    if (!job) return null;
    if (!ok) {
      this.finish(job, { code: "policy", message: "Declined by the site owner" });
      return job;
    }
    job.state = "queued";
    this.broadcast("ack", job, { status: "queued" });
    this.pump();
    return job;
  }

  pendingConfirmations() {
    return this.jobs.filter((job) => job.state === "needs_confirm");
  }

  /**
   * Cancel the caller's own intent. Needs the cancel_key the 202 returned to that viewer.
   * A job shared by several viewers only drops the caller's id; the job stops when no id is left.
   * Returns {job} | {denied: true} | null (nothing active).
   */
  cancel(intentId, cancelKey) {
    const job = this.byIntentId.get(intentId);
    if (!job || FINISHED.includes(job.state)) return null;
    if (!tokensEqual(String(cancelKey ?? ""), job.cancelKeys.get(intentId) ?? "")) return { denied: true };
    if (job.ids.length > 1) {
      job.ids = job.ids.filter((id) => id !== intentId);
      job.cancelKeys.delete(intentId);
      this.byIntentId.delete(intentId);
      this.hub.broadcast(hostMessage("error", { id: intentId, ids: [intentId], job: job.id, name: job.name, error: { code: "cancelled", message: "Cancelled" } }));
      this.markVersion(job, "error", [intentId]);
      return { job };
    }
    if (job.state === "running") job.abort.abort({ code: "cancelled", message: "Cancelled" });
    else this.finish(job, { code: "cancelled", message: "Cancelled" });
    return { job };
  }

  pump() {
    while (this.running < this.maxConcurrent) {
      const next = this.jobs.find((job) => job.state === "queued");
      if (!next) return;
      this.start(next);
    }
  }

  start(job) {
    job.state = "running";
    job.startedAt = this.now();
    this.running += 1;
    this.broadcast("ack", job, { status: "running" });
    this.markVersion(job, "running");
    const timer = setTimeout(() => job.abort.abort({ code: "timeout", message: `No result within ${Math.round(job.timeoutMs / 1000)} s` }), job.timeoutMs);
    timer.unref?.();
    const signal = job.abort.signal;
    const live = () => job.state === "running";
    const ctx = {
      signal,
      siteDir: this.site.dir,
      bound: this.site.bound,
      log: (level, text) => this.log(level, `${job.id} ${text}`),
      progress: (progress) => {
        if (!live()) return;
        const clean = {};
        if (Number.isInteger(progress.step) && progress.step >= 0) clean.step = progress.step;
        if (Number.isInteger(progress.of) && progress.of >= 1) clean.of = progress.of;
        if (progress.message) clean.message = clip(progress.message);
        if (progress.source) clean.source = clip(progress.source, 80);
        this.broadcast("progress", job, { progress: clean });
      },
      records: (records) => {
        if (!live()) return { accepted: 0, rejected: 0 };
        const result = applyBatch(this.site.dir, records, {
          name: job.name, def: job.def, intent: job.intent, job: job.id, ids: job.ids, bound: this.site.bound,
        });
        job.records += result.applied.length;
        job.rejected += result.rejected.length;
        if (result.rejected.length && !job.firstRejection) job.firstRejection = result.rejected[0].reason;
        for (const r of result.rejected) this.log("warn", `${job.id} rejected record #${r.index}: ${r.reason}`);
        if (result.trimmed) this.log("warn", `${job.id} ${result.file.rel} passed ${Math.round(result.file.limit / 1024)} KB; trimmed ${result.trimmed} old record(s)`);
        if (result.applied.length) {
          this.broadcast("results", job, { records: result.applied, files: { [result.file.rel]: result.file.v } });
        }
        return { accepted: result.applied.length, rejected: result.rejected.length, reasons: result.rejected };
      },
    };
    // The slot is released when the executor settles, not when the viewer is told: a cancelled Octo run
    // keeps its slot until the controller has been asked to stop it.
    const run = Promise.resolve().then(() => this.runExecutor(job, ctx));
    run.catch(() => {}).finally(() => {
      clearTimeout(timer);
      this.running -= 1;
      this.pump();
    });
    const aborted = new Promise((resolve) => signal.addEventListener("abort", () => resolve({ aborted: signal.reason }), { once: true }));
    Promise.race([run.then((value) => ({ value })), aborted])
      .then((outcome) => {
        if (outcome.aborted) this.finish(job, outcome.aborted);
        else this.finish(job, null, outcome.value?.summary);
      })
      .catch((error) => {
        if (signal.aborted) this.finish(job, signal.reason);
        else this.finish(job, { code: ERROR_CODES.includes(error.code) ? error.code : "internal", message: error.viewerMessage || error.message });
      });
  }

  finish(job, error, summary = null) {
    if (FINISHED.includes(job.state)) return;
    job.endedAt = this.now();
    // A handler whose every record was refused has told the viewer nothing: that is an error the page can show
    // ("could not read …"), not a silent "done".
    if (!error && job.records === 0 && job.rejected > 0) {
      error = { code: "invalid", message: `the handler's ${job.rejected === 1 ? "record was" : `${job.rejected} records were`} rejected: ${job.firstRejection || "invalid record"}` };
    }
    if (error) {
      job.state = "error";
      job.error = { code: ERROR_CODES.includes(error.code) ? error.code : "internal", message: clip(error.viewerMessage || error.message || error.code) };
      this.broadcast("error", job, { error: job.error, rejected: job.rejected });
      this.markVersion(job, "error");
      this.log("warn", `${job.id} ${job.name} error ${job.error.code}: ${error.message || job.error.message}`);
    } else {
      job.state = "done";
      job.summary = summary ? clip(summary, 200) : job.records ? `${job.records} result${job.records === 1 ? "" : "s"}` : "Nothing new found";
      this.broadcast("done", job, { summary: job.summary, count: job.records, rejected: job.rejected });
      this.markVersion(job, "done");
      this.log("info", `${job.id} ${job.name} done: ${job.summary}${job.rejected ? ` (${job.rejected} rejected)` : ""}`);
    }
    if (!job.abort.signal.aborted) job.abort.abort({ code: "internal", message: "finished" });
    this.pump();
  }

  /** Debug view: the last 50 jobs. */
  list() {
    return this.jobs.slice(-50).reverse().map((job) => ({
      job: job.id, name: job.name, executor: job.executor, ids: job.ids, ref: job.ref, state: job.state,
      created_at: new Date(job.createdAt).toISOString(),
      started_at: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      ended_at: job.endedAt ? new Date(job.endedAt).toISOString() : null,
      ms: job.endedAt && job.startedAt ? job.endedAt - job.startedAt : null,
      records: job.records, rejected: job.rejected, summary: job.summary, error: job.error,
    }));
  }

  close() {
    for (const job of this.jobs) {
      if (job.state === "running") job.abort.abort({ code: "cancelled", message: "Binder stopped" });
    }
  }
}
