import { ControllerApiError } from "../../../services/runtimeController/core";
import { sitePreviewShownState, type ControllerSitePreview, type SitePreviewWakeResult } from "../../../services/runtimeController/previews";

/**
 * Open on a stopped site that `instafy preview open` knows how to start: ask
 * the controller to wake it (no Octo turn, no credits, no chat message), then
 * follow the preview until the site answers. Nothing here knows what the site is.
 */
export const WAKE_POLL_MS = 2_000;
/** A runtime cold start plus the site's own start; past this the card says so and offers the button again. */
export const WAKE_TIMEOUT_MS = 150_000;

export class PreviewWakeError extends Error {
  /** The preview is gone or this person may no longer see it: waking again will not help. */
  readonly gone: boolean;
  constructor(message: string, gone = false) {
    super(message);
    this.name = "PreviewWakeError";
    this.gone = gone;
  }
}

const GONE_STATUSES = new Set([403, 404, 410]);

/** The controller refuses a read-only member who would start a stopped runtime (it costs the space credits). */
export const START_NEEDS_BUILDER = "start_needs_builder";
/** What a member who may not start the machine reads, before pressing anything and after a refusal alike. */
export const START_NEEDS_BUILDER_TEXT = "Only people who can edit this space can start it. Ask one of them to open it.";
/** The space runs on someone's own computer, which is offline: nothing in Studio can start it. */
export const RUNTIME_OFFLINE = "runtime_offline";

/** One short line for the card: what went wrong, never a stack or a URL. */
export function wakeErrorText(cause: unknown): string {
  if (cause instanceof PreviewWakeError) return cause.message;
  if (cause instanceof ControllerApiError) {
    if (cause.code === START_NEEDS_BUILDER) return START_NEEDS_BUILDER_TEXT;
    if (cause.code === RUNTIME_OFFLINE) return "The computer this space runs on is offline.";
    if (GONE_STATUSES.has(cause.status)) return "This preview is gone.";
    if (cause.status === 429) return "Asked too often. Try again in a minute.";
    if (cause.status === 409) return "This preview can't be started from here.";
  }
  return "Couldn't start it.";
}

function abortError(): Error {
  const error = new Error("The wake was cancelled.");
  error.name = "AbortError";
  return error;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolves once the site answers (with the record that said so, or null when
 * the controller answered `live` straight away). Throws `PreviewWakeError`
 * when the wake failed, the preview is gone or it took too long, and an
 * AbortError when `signal` aborts.
 */
export async function wakeUntilLive(deps: {
  wake: (signal?: AbortSignal) => Promise<SitePreviewWakeResult>;
  get: (signal?: AbortSignal) => Promise<ControllerSitePreview>;
  onPreview?: (preview: ControllerSitePreview) => void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<ControllerSitePreview | null> {
  const { signal } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const started = now();
  let result: SitePreviewWakeResult;
  try {
    result = await deps.wake(signal);
  } catch (cause) {
    if (signal?.aborted) throw abortError();
    throw new PreviewWakeError(
      wakeErrorText(cause),
      cause instanceof ControllerApiError && GONE_STATUSES.has(cause.status) && cause.code !== START_NEEDS_BUILDER,
    );
  }
  if (result.state === "live") return null;
  for (;;) {
    await sleep(deps.intervalMs ?? WAKE_POLL_MS, signal);
    if (signal?.aborted) throw abortError();
    let preview: ControllerSitePreview | null = null;
    try {
      preview = await deps.get(signal);
    } catch (cause) {
      if (signal?.aborted) throw abortError();
      if (cause instanceof ControllerApiError && GONE_STATUSES.has(cause.status)) throw new PreviewWakeError(wakeErrorText(cause), true);
      // A passing network or server error: keep following until the deadline.
    }
    if (preview) {
      deps.onPreview?.(preview);
      if (preview.wake?.state === "failed") throw new PreviewWakeError(preview.wake.error ? `Couldn't start: ${preview.wake.error}` : "Couldn't start it.");
      if (preview.wake?.state !== "waking" && sitePreviewShownState(preview) === "live") return preview;
    }
    if (now() - started >= (deps.timeoutMs ?? WAKE_TIMEOUT_MS)) throw new PreviewWakeError("It's taking too long to start.");
  }
}
