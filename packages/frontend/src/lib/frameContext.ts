type FrameWindow = {
  parent?: unknown;
  origin?: string;
  location?: { origin?: string };
};

function defaultFrame(): FrameWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as FrameWindow);
}

/**
 * True when some ancestor of this frame is a document on the same origin: an
 * Instafy page loaded inside Instafy, such as a site preview that navigated
 * itself to the app. Such a frame shares the page's storage and session, and
 * no sign-in ever completes inside a frame. The whole chain is walked, since
 * the top can be on another origin (an extension that embeds Studio) while a
 * parent in between is Instafy. A cross-origin ancestor cannot be read; it is
 * skipped rather than counted.
 */
export function hasSameOriginAncestor(frame: FrameWindow | undefined = defaultFrame()): boolean {
  if (!frame) {
    return false;
  }
  let ownOrigin: string | undefined;
  try {
    ownOrigin = frame.origin;
  } catch {
    return false;
  }
  // An opaque origin ("null") shares nothing with its ancestors.
  if (!ownOrigin || ownOrigin === "null") {
    return false;
  }
  let current: FrameWindow = frame;
  for (let depth = 0; depth < 32; depth += 1) {
    let parent: FrameWindow | undefined;
    try {
      parent = current.parent as FrameWindow | undefined;
    } catch {
      return false;
    }
    if (!parent || parent === current) {
      return false;
    }
    try {
      if (parent.location?.origin === ownOrigin) {
        return true;
      }
    } catch {
      // Another origin: keep walking up.
    }
    current = parent;
  }
  return false;
}
