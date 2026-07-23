import { useCallback, useEffect, useState } from "react";

export const TOUCH_MODE_OVERRIDE_STORAGE_KEY = "instafy.touchModeOverride";
const TOUCH_MODE_OVERRIDE_EVENT = "instafy:touch-mode-override";

export type TouchModeOverride = boolean | null;

export function detectTouchLikeInput(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const noHover = window.matchMedia?.("(hover: none)")?.matches ?? false;
  const touchPoints = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  return coarsePointer || (touchPoints && noHover);
}

function parseTouchModeOverride(value: string | null): TouchModeOverride {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "touch", "on", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "mouse", "off", "no"].includes(normalized)) {
    return false;
  }
  return null;
}

export function readTouchModeUrlOverride(): TouchModeOverride {
  if (typeof window === "undefined") {
    return null;
  }
  return parseTouchModeOverride(new URLSearchParams(window.location.search).get("touchMode"));
}

export function readStoredTouchModeOverride(): TouchModeOverride {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return parseTouchModeOverride(window.localStorage.getItem(TOUCH_MODE_OVERRIDE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function setStoredTouchModeOverride(value: TouchModeOverride) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (value === null) {
      window.localStorage.removeItem(TOUCH_MODE_OVERRIDE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(TOUCH_MODE_OVERRIDE_STORAGE_KEY, value ? "1" : "0");
    }
  } catch {
    // Ignore unavailable localStorage in locked-down browsers.
  }
  window.dispatchEvent(new CustomEvent(TOUCH_MODE_OVERRIDE_EVENT));
}

export function resolveTouchLikeInput(): boolean {
  return readTouchModeUrlOverride() ?? readStoredTouchModeOverride() ?? detectTouchLikeInput();
}

type TouchModeDebugState = {
  effectiveTouchLikeInput: boolean;
  hardwareTouchLikeInput: boolean;
  storedOverride: TouchModeOverride;
  urlOverride: TouchModeOverride;
};

function readTouchModeDebugState(): TouchModeDebugState {
  const hardwareTouchLikeInput = detectTouchLikeInput();
  const urlOverride = readTouchModeUrlOverride();
  const storedOverride = readStoredTouchModeOverride();
  return {
    effectiveTouchLikeInput: urlOverride ?? storedOverride ?? hardwareTouchLikeInput,
    hardwareTouchLikeInput,
    storedOverride,
    urlOverride,
  };
}

export function useTouchModeDebugState() {
  const [state, setState] = useState<TouchModeDebugState>(readTouchModeDebugState);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");
    const noHoverQuery = window.matchMedia("(hover: none)");
    const updateTouchModeState = () => setState(readTouchModeDebugState());

    updateTouchModeState();
    window.addEventListener("storage", updateTouchModeState);
    window.addEventListener("popstate", updateTouchModeState);
    window.addEventListener(TOUCH_MODE_OVERRIDE_EVENT, updateTouchModeState);

    if (
      typeof coarsePointerQuery.addEventListener === "function" &&
      typeof noHoverQuery.addEventListener === "function"
    ) {
      coarsePointerQuery.addEventListener("change", updateTouchModeState);
      noHoverQuery.addEventListener("change", updateTouchModeState);
      return () => {
        window.removeEventListener("storage", updateTouchModeState);
        window.removeEventListener("popstate", updateTouchModeState);
        window.removeEventListener(TOUCH_MODE_OVERRIDE_EVENT, updateTouchModeState);
        coarsePointerQuery.removeEventListener("change", updateTouchModeState);
        noHoverQuery.removeEventListener("change", updateTouchModeState);
      };
    }

    coarsePointerQuery.addListener(updateTouchModeState);
    noHoverQuery.addListener(updateTouchModeState);
    return () => {
      window.removeEventListener("storage", updateTouchModeState);
      window.removeEventListener("popstate", updateTouchModeState);
      window.removeEventListener(TOUCH_MODE_OVERRIDE_EVENT, updateTouchModeState);
      coarsePointerQuery.removeListener(updateTouchModeState);
      noHoverQuery.removeListener(updateTouchModeState);
    };
  }, []);

  const setStoredOverride = useCallback((value: TouchModeOverride) => {
    setStoredTouchModeOverride(value);
  }, []);

  return {
    ...state,
    setStoredOverride,
  };
}

export function useTouchLikeInput(): boolean {
  return useTouchModeDebugState().effectiveTouchLikeInput;
}
