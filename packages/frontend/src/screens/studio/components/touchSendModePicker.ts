export const TOUCH_SEND_MODE_HOLD_DELAY_MS = 400;
export const TOUCH_SEND_MODE_PRESS_SLOP_PX = 10;

const DEFAULT_TARGET_SIZE_PX = 48;
const DEFAULT_TARGET_GAP_PX = 8;
const DEFAULT_ANCHOR_GAP_PX = 12;
const DEFAULT_VIEWPORT_PADDING_PX = 8;

export type TouchSendModePrimary = "send" | "steer";
export type TouchSendMode = TouchSendModePrimary | "queue" | "stash";

export type TouchSendModePoint = {
  x: number;
  y: number;
};

export type TouchSendModeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type TouchSendModeTarget = {
  mode: TouchSendMode;
  rect: TouchSendModeRect;
  enabled: boolean;
};

export type TouchSendModePickerLayout = {
  bounds: TouchSendModeRect;
  targets: TouchSendModeTarget[];
  targetSize: number;
  gap: number;
};

export type CreateTouchSendModePickerLayoutOptions = {
  anchor: TouchSendModeRect;
  viewport: TouchSendModeRect;
  primaryMode: TouchSendModePrimary;
  disabledModes?: readonly TouchSendMode[];
  targetSize?: number;
  targetGap?: number;
  anchorGap?: number;
  viewportPadding?: number;
};

export type TouchSendModePickerState =
  | { phase: "idle" }
  | {
      phase: "pressing";
      pointerId: number;
      origin: TouchSendModePoint;
    }
  | {
      phase: "open";
      pointerId: number;
      highlightedMode: TouchSendMode | null;
    }
  | {
      phase: "cancelled";
      pointerId: number;
    };

export type TouchSendModePickerOutcome =
  | { type: "none" }
  | { type: "tap" }
  | { type: "cancel" }
  | { type: "commit"; mode: TouchSendMode };

export type TouchSendModePickerTransition = {
  state: TouchSendModePickerState;
  outcome: TouchSendModePickerOutcome;
};

export const IDLE_TOUCH_SEND_MODE_PICKER_STATE: TouchSendModePickerState = {
  phase: "idle",
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) {
    return minimum;
  }
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizedRect(rect: TouchSendModeRect): TouchSendModeRect {
  return {
    left: Math.min(rect.left, rect.right),
    top: Math.min(rect.top, rect.bottom),
    right: Math.max(rect.left, rect.right),
    bottom: Math.max(rect.top, rect.bottom),
  };
}

/**
 * Builds a physical-coordinate rail above the trigger. The primary action is
 * nearest the trigger, followed by Queue and then Stash toward the left. The
 * physical ordering deliberately does not depend on document direction.
 */
export function createTouchSendModePickerLayout({
  anchor: anchorInput,
  viewport: viewportInput,
  primaryMode,
  disabledModes = [],
  targetSize: requestedTargetSize = DEFAULT_TARGET_SIZE_PX,
  targetGap: requestedTargetGap = DEFAULT_TARGET_GAP_PX,
  anchorGap: requestedAnchorGap = DEFAULT_ANCHOR_GAP_PX,
  viewportPadding: requestedViewportPadding = DEFAULT_VIEWPORT_PADDING_PX,
}: CreateTouchSendModePickerLayoutOptions): TouchSendModePickerLayout {
  const anchor = normalizedRect(anchorInput);
  const viewport = normalizedRect(viewportInput);
  const viewportWidth = viewport.right - viewport.left;
  const viewportHeight = viewport.bottom - viewport.top;
  const viewportPadding = Math.min(
    Math.max(0, requestedViewportPadding),
    viewportWidth / 2,
    viewportHeight / 2,
  );
  const innerLeft = viewport.left + viewportPadding;
  const innerTop = viewport.top + viewportPadding;
  const innerRight = viewport.right - viewportPadding;
  const innerBottom = viewport.bottom - viewportPadding;
  const innerWidth = Math.max(0, innerRight - innerLeft);
  const innerHeight = Math.max(0, innerBottom - innerTop);

  // Three targets normally retain the requested 48 px size. On an unusually
  // narrow visual viewport, shrink the complete rail rather than overflowing
  // an edge; callers can use targetSize to decide whether to render a fallback.
  const requestedGap = Math.max(0, requestedTargetGap);
  const gap = Math.min(requestedGap, innerWidth / 8);
  const maxTargetSizeByWidth = Math.max(0, (innerWidth - gap * 2) / 3);
  const targetSize = Math.min(
    Math.max(0, requestedTargetSize),
    innerHeight,
    maxTargetSizeByWidth,
  );
  const railWidth = targetSize * 3 + gap * 2;
  const anchorGap = Math.max(0, requestedAnchorGap);
  const desiredLeft = anchor.right - railWidth;
  const left = clamp(desiredLeft, innerLeft, innerRight - railWidth);
  const desiredTop = anchor.top - anchorGap - targetSize;
  const top = clamp(desiredTop, innerTop, innerBottom - targetSize);
  const bottom = top + targetSize;
  const disabled = new Set(disabledModes);

  const targetForSlot = (mode: TouchSendMode, slotFromLeft: number): TouchSendModeTarget => {
    const targetLeft = left + slotFromLeft * (targetSize + gap);
    return {
      mode,
      enabled: !disabled.has(mode),
      rect: {
        left: targetLeft,
        top,
        right: targetLeft + targetSize,
        bottom,
      },
    };
  };

  return {
    bounds: {
      left,
      top,
      right: left + railWidth,
      bottom,
    },
    // Semantic order is primary, Queue, Stash; their physical slots run from
    // right to left so the primary action requires the shortest thumb travel.
    targets: [
      targetForSlot(primaryMode, 2),
      targetForSlot("queue", 1),
      targetForSlot("stash", 0),
    ],
    targetSize,
    gap,
  };
}

export function hitTestTouchSendModePicker(
  layout: TouchSendModePickerLayout,
  point: TouchSendModePoint,
): TouchSendMode | null {
  for (const target of layout.targets) {
    if (
      target.enabled &&
      target.rect.right > target.rect.left &&
      target.rect.bottom > target.rect.top &&
      point.x >= target.rect.left &&
      point.x <= target.rect.right &&
      point.y >= target.rect.top &&
      point.y <= target.rect.bottom
    ) {
      return target.mode;
    }
  }
  return null;
}

export function startTouchSendModePicker(
  state: TouchSendModePickerState,
  pointerId: number,
  origin: TouchSendModePoint,
): TouchSendModePickerState {
  if (state.phase !== "idle") {
    return state;
  }
  return {
    phase: "pressing",
    pointerId,
    origin: { ...origin },
  };
}

/** Opens the picker after the hold delay, intentionally without a selection. */
export function openTouchSendModePicker(
  state: TouchSendModePickerState,
  pointerId: number,
): TouchSendModePickerState {
  if (state.phase !== "pressing" || state.pointerId !== pointerId) {
    return state;
  }
  return {
    phase: "open",
    pointerId,
    highlightedMode: null,
  };
}

export function moveTouchSendModePicker(
  state: TouchSendModePickerState,
  pointerId: number,
  point: TouchSendModePoint,
  layout: TouchSendModePickerLayout,
  pressSlop = TOUCH_SEND_MODE_PRESS_SLOP_PX,
): TouchSendModePickerState {
  if (state.phase === "idle" || state.pointerId !== pointerId) {
    return state;
  }
  if (state.phase === "cancelled") {
    return state;
  }
  if (state.phase === "pressing") {
    const deltaX = point.x - state.origin.x;
    const deltaY = point.y - state.origin.y;
    if (deltaX * deltaX + deltaY * deltaY > Math.max(0, pressSlop) ** 2) {
      return { phase: "cancelled", pointerId };
    }
    return state;
  }
  return {
    ...state,
    highlightedMode: hitTestTouchSendModePicker(layout, point),
  };
}

/**
 * Finishing an unarmed press reports `tap`, allowing the existing button press
 * path to run unchanged. Once open, only an enabled highlighted target commits.
 */
export function finishTouchSendModePicker(
  state: TouchSendModePickerState,
  pointerId: number,
  layout?: TouchSendModePickerLayout,
): TouchSendModePickerTransition {
  if (state.phase === "idle" || state.pointerId !== pointerId) {
    return { state, outcome: { type: "none" } };
  }
  if (state.phase === "pressing") {
    return {
      state: IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      outcome: { type: "tap" },
    };
  }
  if (state.phase === "cancelled" || state.highlightedMode === null || !layout) {
    return {
      state: IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      outcome: { type: "cancel" },
    };
  }

  const currentTarget = layout.targets.find(
    (target) => target.mode === state.highlightedMode,
  );
  if (!currentTarget?.enabled) {
    return {
      state: IDLE_TOUCH_SEND_MODE_PICKER_STATE,
      outcome: { type: "cancel" },
    };
  }
  return {
    state: IDLE_TOUCH_SEND_MODE_PICKER_STATE,
    outcome: { type: "commit", mode: state.highlightedMode },
  };
}

export function cancelTouchSendModePicker(
  state: TouchSendModePickerState,
  pointerId: number,
): TouchSendModePickerTransition {
  if (state.phase === "idle" || state.pointerId !== pointerId) {
    return { state, outcome: { type: "none" } };
  }
  return {
    state: IDLE_TOUCH_SEND_MODE_PICKER_STATE,
    outcome: { type: "cancel" },
  };
}
