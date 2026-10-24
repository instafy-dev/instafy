import type { SharedBrowserHostSnapshot } from "../../../services/runtimeController/browserSession";
import { SHARED_BROWSER_HOST_COPY } from "./sharedBrowserHostAttach";

/**
 * Why the browser view stopped, stored with each error it shows:
 *
 * - `off`: nothing runs there now (the machine or its browser stopped, or the
 *   browser started again). A press opens it.
 * - `failed`: it tried and did not open.
 * - `machine`: the space's machine did not start.
 * - `blocked`: it cannot open from here (policy off, a viewer, poisoned); the
 *   reason is its own sentence.
 * - `notice`: any other plain sentence of its own (sessions, setup).
 */
export type HostedBrowserErrorKind = "off" | "failed" | "machine" | "blocked" | "notice";

export type HostedBrowserFailure = {
  kind: HostedBrowserErrorKind;
  /** The raw reason, shown only with runtime debug on (or the sentence for `blocked` and `notice`). */
  reason: string;
};

/** What the browser view shows, as ChatPanel and the card need it. */
export type HostedBrowserViewKind = "off" | "opening" | "live" | "failed" | "blocked";

export type HostedBrowserViewState = {
  kind: HostedBrowserViewKind;
  /** The one sentence on screen; null while live. */
  sentence: string | null;
  /** The label of the card's one button, or null. */
  action: string | null;
};

export const HOSTED_BROWSER_VIEW_ACTION = {
  open: "Open browser",
  tryAgain: "Try again",
} as const;

export const HOSTED_BROWSER_SETUP_COPY =
  "Browsing hasn't been set up for this workspace. Ask your administrator to connect a browser runtime.";

const PROVIDER_NOT_CONFIGURED = /provider\s+['"][^'"]+['"]\s+is not configured/i;

/**
 * The one state the browser view shows, from its status, the failure it
 * stored with its error, and whether it has a connection. It is live only
 * with a connection: a view that dropped it while it looks the browser up
 * again is opening.
 *
 * | status / failure                 | kind     | sentence                         | action       |
 * |----------------------------------|----------|----------------------------------|--------------|
 * | connected, with a connection     | live     | none                             | none         |
 * | idle, selecting, connecting      | opening  | "Opening Instafy's browser…"     | none         |
 * | error `off`                      | off      | "Instafy's browser is off."      | Open browser |
 * | error `failed`                   | failed   | "... did not open. Try again."   | Try again    |
 * | error `machine`                  | failed   | "This space's machine did not…"  | Try again    |
 * | error `blocked`                  | blocked  | its own                          | none         |
 * | error `notice`                   | failed   | its own                          | Try again    |
 */
export function hostedBrowserViewState(input: {
  status: "idle" | "selecting" | "connecting" | "connected" | "error";
  failure: HostedBrowserFailure | null;
  hasConnection: boolean;
}): HostedBrowserViewState {
  const { failure } = input;
  if (input.status === "error" || failure) {
    switch (failure?.kind ?? "failed") {
      case "off":
        return { kind: "off", sentence: SHARED_BROWSER_HOST_COPY.off, action: HOSTED_BROWSER_VIEW_ACTION.open };
      case "machine":
        return { kind: "failed", sentence: SHARED_BROWSER_HOST_COPY.machineDidNotStart, action: HOSTED_BROWSER_VIEW_ACTION.tryAgain };
      case "blocked":
        return { kind: "blocked", sentence: failure?.reason || SHARED_BROWSER_HOST_COPY.didNotOpen, action: null };
      case "notice":
        return { kind: "failed", sentence: failure?.reason || SHARED_BROWSER_HOST_COPY.didNotOpen, action: HOSTED_BROWSER_VIEW_ACTION.tryAgain };
      default:
        return {
          kind: "failed",
          sentence: PROVIDER_NOT_CONFIGURED.test(failure?.reason ?? "")
            ? HOSTED_BROWSER_SETUP_COPY
            : SHARED_BROWSER_HOST_COPY.didNotOpen,
          action: HOSTED_BROWSER_VIEW_ACTION.tryAgain,
        };
    }
  }
  if (input.status === "connected" && input.hasConnection) {
    return { kind: "live", sentence: null, action: null };
  }
  return { kind: "opening", sentence: SHARED_BROWSER_HOST_COPY.opening, action: null };
}

/**
 * While the browser view is off: whether this reading shows that an agent or
 * another viewer has Instafy's browser running, so the view attaches without
 * a press (hands-free). Each run of the browser (its `generation`) is
 * attached to once, so a view that goes off again does not keep trying.
 */
export function hostedBrowserStartedByOther(
  snapshot: SharedBrowserHostSnapshot | null,
  attachedGeneration: string | null | undefined,
): boolean {
  if (!snapshot || (snapshot.state !== "ready" && snapshot.state !== "starting")) return false;
  if (!snapshot.agentRunActive && !snapshot.othersPresent && !snapshot.controlledByOther) return false;
  return attachedGeneration === undefined || snapshot.generation !== attachedGeneration;
}

/**
 * Whether the view attaches without a press while it is off. Only a reading
 * asked for since the view went off counts (`fetchedAtMs` at or after
 * `offSinceMs`): an older one may show a run of the browser that has ended,
 * or one from before the machine restarted, and attaching on it would start
 * an idle browser nobody asked for.
 */
export function hostedBrowserAttachWhileOff(input: {
  off: boolean;
  snapshot: SharedBrowserHostSnapshot | null;
  fetchedAtMs: number | null;
  offSinceMs: number | null;
  attachedGeneration: string | null | undefined;
}): boolean {
  const { off, snapshot, fetchedAtMs, offSinceMs, attachedGeneration } = input;
  if (!off || offSinceMs === null || fetchedAtMs === null || fetchedAtMs < offSinceMs) return false;
  return hostedBrowserStartedByOther(snapshot, attachedGeneration);
}

/**
 * Whether the composer reads the browser's pages: while its view is closed
 * (null, which keeps its own rules), opening or live. Nothing reads the pages
 * of a browser that is off, did not open or cannot open.
 */
export function hostedBrowserPagesActive(kind: HostedBrowserViewKind | null): boolean {
  return kind === null || kind === "opening" || kind === "live";
}
