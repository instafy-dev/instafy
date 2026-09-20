const MAX_SAMPLES = 120;
const MAX_BATCH = 20;
const SAMPLE_RATE = 0.25;
const seen = new WeakSet();

function validSample(sample) {
  return sample?.version === 1 &&
    ["studio_startup", "conversation_switch", "space_switch", "organization_switch"].includes(sample.operation) &&
    ["ready", "error", "timeout", "superseded", "hidden"].includes(sample.outcome) &&
    Number.isInteger(sample.durationMs) && sample.durationMs >= 0 && sample.durationMs <= 60_000 &&
    typeof sample.loadingShown === "boolean" &&
    ["0", "1-50", "51-200", "201-1000", "1001+"].includes(sample.messageCountBucket) &&
    ["narrow", "wide"].includes(sample.viewport);
}

/** Best-effort, uniformly sampled diagnostics; never delays navigation or retries. */
export function createPerformanceReporter({
  releaseId,
  fetchImpl = fetch,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let queue = [];
  let timer = null;
  let accepted = 0;
  let closed = false;
  let finishing = false;
  let inFlight = false;
  let controller = null;
  const enabled = typeof releaseId === "string" && /^[a-f0-9]{64}$/.test(releaseId);
  const schedule = () => {
    if (timer === null && queue.length && !closed) timer = setTimer(() => { timer = null; flush(); }, 5_000);
  };
  const flush = () => {
    if (!enabled || closed || inFlight || !queue.length) return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    const samples = queue.splice(0, MAX_BATCH);
    inFlight = true;
    controller = new AbortController();
    const requestController = controller;
    const deadline = setTimer(() => requestController.abort(), 3_000);
    Promise.resolve().then(() => fetchImpl("/__performance", {
      method: "POST",
      mode: "same-origin",
      credentials: "omit",
      referrer: "",
      referrerPolicy: "same-origin",
      cache: "no-store",
      redirect: "error",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, releaseId, samples }),
      signal: requestController.signal,
    })).catch(() => {}).finally(() => {
      clearTimer(deadline);
      inFlight = false;
      if (controller === requestController) controller = null;
      if (finishing) flush();
      else schedule();
    });
  };
  return {
    record(sample) {
      if (!enabled || closed || finishing || !sample || typeof sample !== "object" || seen.has(sample) || !validSample(sample)) return;
      seen.add(sample);
      if (accepted >= MAX_SAMPLES || random() >= SAMPLE_RATE) return;
      accepted += 1;
      // Explicit projection: future public API additions cannot leak into the sink.
      queue.push({ version: sample.version, operation: sample.operation, outcome: sample.outcome,
        durationMs: sample.durationMs, loadingShown: sample.loadingShown,
        messageCountBucket: sample.messageCountBucket, viewport: sample.viewport });
      if (queue.length > MAX_BATCH) queue.shift();
      if (queue.length >= MAX_BATCH) flush();
      else schedule();
    },
    flush,
    finish() {
      finishing = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      flush();
    },
    dispose() {
      closed = true;
      queue = [];
      if (timer !== null) clearTimer(timer);
      timer = null;
      controller?.abort();
    },
  };
}
