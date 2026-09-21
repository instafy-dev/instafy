import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { InputField, Xmark } from "iconoir-react";

import { cdpScreencastModifiers } from "./cdpScreencastProtocol";
import { remoteBrowserKeyDownText, type RemoteBrowserVirtualInputMessage } from "./remoteBrowserInput";

const MOBILE_CONTROL_KEYS: Readonly<Record<string, string>> = {
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
};

const CONTROL_KEY_BEFORE_INPUT_TYPES: Readonly<Record<string, readonly string[]>> = {
  Backspace: ["deleteContentBackward"],
  Delete: ["deleteContentForward"],
  Enter: ["insertLineBreak", "insertParagraph"],
};

const MOBILE_CONTROL_KEY_CODES: Readonly<Record<string, number>> = {
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  Backspace: 8,
  Delete: 46,
  Enter: 13,
  Escape: 27,
  Tab: 9,
};

function virtualKeyMessages(
  key: string,
  code: string,
  modifiers = 0,
): [RemoteBrowserVirtualInputMessage, RemoteBrowserVirtualInputMessage] {
  const text = remoteBrowserKeyDownText(key, modifiers);
  const virtualKeyCode = MOBILE_CONTROL_KEY_CODES[key];
  const virtualKeyFields =
    virtualKeyCode === undefined
      ? {}
      : {
          nativeVirtualKeyCode: virtualKeyCode,
          windowsVirtualKeyCode: virtualKeyCode,
        };
  return [
    {
      type: "key",
      kind: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      text,
      modifiers,
      autoRepeat: false,
      ...virtualKeyFields,
    },
    {
      type: "key",
      kind: "keyUp",
      key,
      code,
      text: "",
      modifiers,
      autoRepeat: false,
      ...virtualKeyFields,
    },
  ];
}

export function RemoteBrowserMobileKeyboard({
  enabled,
  onMessage,
  onOccupiedHeightChange,
}: {
  enabled: boolean;
  onMessage: (message: RemoteBrowserVirtualInputMessage) => void;
  onOccupiedHeightChange?: (height: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const compositionCommitPendingRef = useRef(false);
  const compositionCommitTimerRef = useRef<number | null>(null);
  const suppressedBeforeInputTypesRef = useRef<Set<string>>(new Set());
  const suppressedBeforeInputTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
    }
  }, [enabled]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const parent = bar?.parentElement;
    if (!enabled || !open || !bar || !parent) {
      onOccupiedHeightChange?.(0);
      return;
    }
    const measure = () => {
      const bounds = bar.getBoundingClientRect();
      const parentBounds = parent.getBoundingClientRect();
      // Reserve the visible app input bar and its bottom gap, not the OS
      // keyboard inset (the expanded visual viewport already accounts for it).
      const visible = [bounds.width, bounds.height, parentBounds.height].every((size) => Number.isFinite(size) && size > 0);
      const occupied = parentBounds.bottom - bounds.top;
      onOccupiedHeightChange?.(visible && Number.isFinite(occupied)
        ? Math.max(0, Math.min(parentBounds.height, Math.ceil(occupied))) : 0);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(bar);
    observer?.observe(parent);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      onOccupiedHeightChange?.(0);
    };
  }, [enabled, onOccupiedHeightChange, open]);

  useEffect(() => {
    const input = inputRef.current;
    if (!open || !input) {
      return;
    }

    const sendText = (value: string | null | undefined) => {
      if (value) {
        onMessage({ type: "text", text: value });
      }
    };
    const sendKey = (key: string, code = key) => {
      const [down, up] = virtualKeyMessages(key, code);
      onMessage(down);
      onMessage(up);
    };
    const handleBeforeInput = (event: InputEvent) => {
      if (composingRef.current || event.isComposing) {
        return;
      }
      if (suppressedBeforeInputTypesRef.current.has(event.inputType)) {
        suppressedBeforeInputTypesRef.current.clear();
        if (suppressedBeforeInputTimerRef.current !== null) {
          window.clearTimeout(suppressedBeforeInputTimerRef.current);
          suppressedBeforeInputTimerRef.current = null;
        }
        event.preventDefault();
        return;
      }
      if (
        event.inputType === "insertText" ||
        event.inputType === "insertReplacementText"
      ) {
        if (event.data && event.cancelable) {
          event.preventDefault();
          sendText(event.data);
          input.value = "";
        }
        return;
      }
      if (event.inputType === "deleteContentBackward") {
        event.preventDefault();
        sendKey("Backspace");
        return;
      }
      if (event.inputType === "deleteContentForward") {
        event.preventDefault();
        sendKey("Delete");
        return;
      }
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        event.preventDefault();
        sendKey("Enter");
      }
    };
    const handleInput = () => {
      if (composingRef.current) {
        return;
      }
      if (compositionCommitPendingRef.current) {
        compositionCommitPendingRef.current = false;
        if (compositionCommitTimerRef.current !== null) {
          window.clearTimeout(compositionCommitTimerRef.current);
          compositionCommitTimerRef.current = null;
        }
        input.value = "";
        return;
      }
      const value = input.value;
      input.value = "";
      sendText(value);
    };
    const handleCompositionStart = () => {
      if (compositionCommitTimerRef.current !== null) {
        window.clearTimeout(compositionCommitTimerRef.current);
        compositionCommitTimerRef.current = null;
      }
      compositionCommitPendingRef.current = false;
      composingRef.current = true;
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
      composingRef.current = false;
      input.value = "";
      sendText(event.data);
      compositionCommitPendingRef.current = Boolean(event.data);
      if (event.data) {
        compositionCommitTimerRef.current = window.setTimeout(() => {
          compositionCommitPendingRef.current = false;
          compositionCommitTimerRef.current = null;
        }, 0);
      }
    };

    input.addEventListener("beforeinput", handleBeforeInput);
    input.addEventListener("input", handleInput);
    input.addEventListener("compositionstart", handleCompositionStart);
    input.addEventListener("compositionend", handleCompositionEnd);
    return () => {
      input.removeEventListener("beforeinput", handleBeforeInput);
      input.removeEventListener("input", handleInput);
      input.removeEventListener("compositionstart", handleCompositionStart);
      input.removeEventListener("compositionend", handleCompositionEnd);
      composingRef.current = false;
      compositionCommitPendingRef.current = false;
      if (compositionCommitTimerRef.current !== null) {
        window.clearTimeout(compositionCommitTimerRef.current);
        compositionCommitTimerRef.current = null;
      }
      suppressedBeforeInputTypesRef.current.clear();
      if (suppressedBeforeInputTimerRef.current !== null) {
        window.clearTimeout(suppressedBeforeInputTimerRef.current);
        suppressedBeforeInputTimerRef.current = null;
      }
    };
  }, [onMessage, open]);

  if (!enabled) {
    return null;
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.key === "Process") {
      return;
    }
    const code = MOBILE_CONTROL_KEYS[event.key];
    if (!code) {
      const text = remoteBrowserKeyDownText(event.key, cdpScreencastModifiers(event), event.getModifierState("AltGraph"));
      // Handle printable hardware keys in their own event. WebKit can omit
      // beforeinput during rapid key sequences; cancelling keydown also stops
      // its native insertion. Software keyboards and IMEs keep the input lane.
      if (text && event.cancelable) {
        event.preventDefault();
        onMessage({ type: "text", text });
      }
      return;
    }
    event.preventDefault();
    const pairedBeforeInputTypes = CONTROL_KEY_BEFORE_INPUT_TYPES[event.key];
    if (pairedBeforeInputTypes) {
      suppressedBeforeInputTypesRef.current = new Set(pairedBeforeInputTypes);
      if (suppressedBeforeInputTimerRef.current !== null) {
        window.clearTimeout(suppressedBeforeInputTimerRef.current);
      }
      // A paired beforeinput is delivered in the same browser task. Do not let
      // a hardware key suppress an unrelated software-keyboard action later.
      suppressedBeforeInputTimerRef.current = window.setTimeout(() => {
        suppressedBeforeInputTypesRef.current.clear();
        suppressedBeforeInputTimerRef.current = null;
      }, 0);
    }
    const [down, up] = virtualKeyMessages(
      event.key,
      event.code === "NumpadEnter" ? event.code : code,
      cdpScreencastModifiers(event),
    );
    onMessage(down);
    onMessage(up);
    if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) {
      return;
    }
    event.preventDefault();
    onMessage({ type: "text", text });
    event.currentTarget.value = "";
  };

  const handleOpen = () => {
    // iOS only presents its software keyboard when focus stays inside the
    // originating tap. Commit the input synchronously, then focus it before
    // returning from this click handler.
    flushSync(() => setOpen(true));
    inputRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={barRef}
      className="pointer-events-none absolute inset-x-2 z-30 hidden justify-end [@media(pointer:coarse)]:flex"
      data-browser-session-safe-zone="true"
      data-testid="shared-browser-mobile-keyboard"
      style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {open ? (
        <div className="pointer-events-auto flex w-full max-w-sm items-center gap-1 rounded-2xl border border-slate-300/80 bg-white/95 p-1.5 shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-950/95">
          <label className="sr-only" htmlFor="shared-browser-mobile-keyboard-input">
            Type into the focused page field
          </label>
          <input
            ref={inputRef}
            aria-label="Type into the focused page field"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-base text-slate-900 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            data-testid="shared-browser-mobile-keyboard-input"
            enterKeyHint="enter"
            id="shared-browser-mobile-keyboard-input"
            inputMode="text"
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type into page…"
            spellCheck={false}
            type="text"
          />
          <button
            aria-label="Close remote keyboard"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-slate-300 dark:hover:bg-slate-800"
            data-testid="shared-browser-mobile-keyboard-close"
            onClick={() => setOpen(false)}
            type="button"
          >
            <Xmark aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <button
          aria-label="Open remote keyboard"
          className="pointer-events-auto inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border border-slate-300/80 bg-white/95 px-3 text-xs font-semibold text-slate-700 shadow-lg backdrop-blur hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-950/95 dark:text-slate-200"
          data-testid="shared-browser-mobile-keyboard-open"
          onClick={handleOpen}
          type="button"
        >
          <InputField aria-hidden="true" className="h-4 w-4" />
          <span>Keyboard</span>
        </button>
      )}
    </div>
  );
}
