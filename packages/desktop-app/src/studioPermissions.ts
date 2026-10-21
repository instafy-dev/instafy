// Permission policy for the Studio window's session.
//
// Without a handler Electron grants every permission request, so any page
// framed inside Studio (an agent-built preview, a third-party script it loads)
// could read precise location with no prompt at all. Studio is the only thing
// that may call geolocation: it brokers location to sites itself and shows
// which site received it. So geolocation is allowed only for Studio's own top
// frame, after one native question that is remembered; every subframe and
// every other origin is denied.
//
// Frames inside a Studio window (agent-built previews, provider surfaces) get
// only what a page needs to work in a frame: fullscreen, writing to the
// clipboard and pointer lock. Everything else (notifications that would look
// like Instafy's, storage access, camera, sensors…) is denied to them. Studio's
// own top frame, and windows that are not Studio's, keep Electron's default
// (granted, except the deprecated synchronous clipboard read).
//
// This module is deliberately free of Electron imports so the decisions can be
// unit-tested; main.ts supplies the window lookup, storage and dialog.

export const STUDIO_LOCATION_PROMPT = {
  message: "Allow Instafy to use your location?",
  detail: "Sites you open can ask for it, and you'll see \u{1F4CD} when one does.",
  allowLabel: "Allow",
  denyLabel: "Don't Allow",
} as const;

export type StudioLocationDecision = "granted" | "denied";

export type StoredStudioLocationConsent = {
  decision: StudioLocationDecision;
  /** The Studio origin the answer was given for; another origin asks again. */
  origin: string;
  decidedAt: string;
};

export type StudioLocationPermissionState = StudioLocationDecision | "ask";

export type StudioPermissionFrame = {
  /**
   * True only when the requesting webContents is a registered Studio window;
   * null when Electron names none (a check from a worker of some frame).
   */
  isStudioContents: boolean | null;
  isMainFrame: boolean | undefined;
  requestingUrl: string | undefined;
};

const GEOLOCATION = "geolocation";
// Electron denies this one when no handler is installed; keep that default.
const DENIED_BY_ELECTRON_DEFAULT = new Set(["deprecated-sync-clipboard-read"]);
/** All a frame inside a Studio window may have (the preview iframe's `allow` is "fullscreen; clipboard-write"). */
export const STUDIO_SUBFRAME_PERMISSIONS: ReadonlySet<string> = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

export function originOf(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Studio's own top frame on Studio's origin, in a Studio window. Nothing else. */
export function isStudioTopFrame(frame: StudioPermissionFrame, studioOrigin: string): boolean {
  return (
    frame.isStudioContents === true &&
    frame.isMainFrame === true &&
    originOf(frame.requestingUrl) === studioOrigin
  );
}

/**
 * A frame inside a Studio window that is not Studio's own top frame. A check
 * that does not say which frame asked counts as one when it comes from another
 * origin.
 */
export function isStudioSubframe(frame: StudioPermissionFrame, studioOrigin: string): boolean {
  if (frame.isStudioContents === false) {
    return false;
  }
  if (frame.isStudioContents === null) {
    // No window named: only a check that says it comes from a subframe counts.
    return frame.isMainFrame === false;
  }
  if (frame.isMainFrame === false) {
    return true;
  }
  return frame.isMainFrame !== true && originOf(frame.requestingUrl) !== studioOrigin;
}

export function parseStoredStudioLocationConsent(value: unknown): StoredStudioLocationConsent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<StoredStudioLocationConsent>;
  if (candidate.decision !== "granted" && candidate.decision !== "denied") {
    return null;
  }
  if (typeof candidate.origin !== "string" || originOf(candidate.origin) !== candidate.origin) {
    return null;
  }
  return {
    decision: candidate.decision,
    origin: candidate.origin,
    decidedAt: typeof candidate.decidedAt === "string" ? candidate.decidedAt : "",
  };
}

export function studioLocationPermissionState(
  consent: StoredStudioLocationConsent | null,
  studioOrigin: string,
): StudioLocationPermissionState {
  if (!consent || consent.origin !== studioOrigin) {
    return "ask";
  }
  return consent.decision;
}

/** Synchronous check (navigator.permissions.query and pre-request checks). */
export function decideStudioPermissionCheck(
  permission: string,
  frame: StudioPermissionFrame,
  studioOrigin: string,
  consent: StoredStudioLocationConsent | null,
): boolean {
  if (permission === GEOLOCATION) {
    // An undecided state must read as "not granted" so the request path, and
    // with it the one-time question, still runs.
    return (
      isStudioTopFrame(frame, studioOrigin) &&
      studioLocationPermissionState(consent, studioOrigin) === "granted"
    );
  }
  if (isStudioSubframe(frame, studioOrigin)) {
    return STUDIO_SUBFRAME_PERMISSIONS.has(permission);
  }
  return !DENIED_BY_ELECTRON_DEFAULT.has(permission);
}

export type StudioPermissionRequestDecision = "grant" | "deny" | "ask";

export function decideStudioPermissionRequest(
  permission: string,
  frame: StudioPermissionFrame,
  studioOrigin: string,
  consent: StoredStudioLocationConsent | null,
): StudioPermissionRequestDecision {
  if (permission === GEOLOCATION) {
    if (!isStudioTopFrame(frame, studioOrigin)) {
      return "deny";
    }
    const state = studioLocationPermissionState(consent, studioOrigin);
    return state === "granted" ? "grant" : state === "denied" ? "deny" : "ask";
  }
  if (isStudioSubframe(frame, studioOrigin)) {
    return STUDIO_SUBFRAME_PERMISSIONS.has(permission) ? "grant" : "deny";
  }
  return DENIED_BY_ELECTRON_DEFAULT.has(permission) ? "deny" : "grant";
}

type PermissionDetailsLike = {
  isMainFrame?: boolean;
  requestingUrl?: string;
};

export type StudioPermissionHandlerDeps<Contents> = {
  getStudioOrigin(): string;
  isStudioContents(contents: Contents | null): boolean;
  readConsent(): StoredStudioLocationConsent | null;
  writeConsent(consent: StoredStudioLocationConsent | null): void;
  /** Shows the native question; resolves true for Allow. */
  askUser(contents: Contents): Promise<boolean>;
  now?(): Date;
  log?(event: string, payload: Record<string, unknown>): void;
};

export function createStudioPermissionHandlers<Contents>(deps: StudioPermissionHandlerDeps<Contents>) {
  // One question at a time: requests that arrive while it is open wait for
  // the same answer instead of stacking dialogs.
  let pendingQuestion: Promise<boolean> | null = null;

  const frameOf = (
    contents: Contents | null,
    details: PermissionDetailsLike | undefined,
    fallbackUrl?: string,
  ): StudioPermissionFrame => ({
    isStudioContents: contents == null ? null : deps.isStudioContents(contents),
    isMainFrame: details?.isMainFrame,
    requestingUrl: details?.requestingUrl || fallbackUrl,
  });

  const ask = (contents: Contents, studioOrigin: string): Promise<boolean> => {
    if (pendingQuestion) {
      return pendingQuestion;
    }
    const question = (async () => {
      try {
        const allowed = await deps.askUser(contents);
        deps.writeConsent({
          decision: allowed ? "granted" : "denied",
          origin: studioOrigin,
          decidedAt: (deps.now?.() ?? new Date()).toISOString(),
        });
        deps.log?.("studio location permission answered", { decision: allowed ? "granted" : "denied" });
        return allowed;
      } catch (error) {
        // No answer is not a "no": deny this request without remembering it.
        deps.log?.("studio location permission question failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        pendingQuestion = null;
      }
    })();
    pendingQuestion = question;
    return question;
  };

  const requestHandler = (
    contents: Contents,
    permission: string,
    callback: (granted: boolean) => void,
    details?: PermissionDetailsLike,
  ) => {
    const studioOrigin = deps.getStudioOrigin();
    const frame = frameOf(contents, details);
    const decision = decideStudioPermissionRequest(permission, frame, studioOrigin, deps.readConsent());
    if (permission !== GEOLOCATION && decision === "deny" && isStudioSubframe(frame, studioOrigin)) {
      deps.log?.("studio subframe permission denied", { permission });
    }
    if (permission === GEOLOCATION && decision === "deny") {
      deps.log?.("studio geolocation denied", {
        isMainFrame: frame.isMainFrame === true,
        studioContents: frame.isStudioContents,
        sameOrigin: originOf(frame.requestingUrl) === studioOrigin,
      });
    }
    if (decision !== "ask") {
      callback(decision === "grant");
      return;
    }
    void ask(contents, studioOrigin).then(callback, () => callback(false));
  };

  const checkHandler = (
    contents: Contents | null,
    permission: string,
    requestingOrigin: string,
    details?: PermissionDetailsLike,
  ): boolean =>
    decideStudioPermissionCheck(
      permission,
      frameOf(contents, details, requestingOrigin),
      deps.getStudioOrigin(),
      deps.readConsent(),
    );

  return {
    requestHandler,
    checkHandler,
    locationPermissionState(): StudioLocationPermissionState {
      return studioLocationPermissionState(deps.readConsent(), deps.getStudioOrigin());
    },
    /** Forget the answer; the next request from Studio asks again. */
    resetLocationPermission(): StudioLocationPermissionState {
      deps.writeConsent(null);
      return "ask";
    },
  };
}
