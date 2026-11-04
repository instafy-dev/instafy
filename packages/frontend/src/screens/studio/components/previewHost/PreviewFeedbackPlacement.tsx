import { forwardRef, useCallback, useLayoutEffect, useRef, type HTMLAttributes } from "react";

/** Standalone callers keep their pane-relative placement; the coordinated lane owns it for its children. */
export const PreviewFeedbackPlacement = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  contained?: boolean;
  restoreFocus?: boolean;
}>(function PreviewFeedbackPlacement({ contained = false, restoreFocus = false, children, onFocusCapture, ...props }, ref) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const previousRef = useRef<HTMLElement | null>(null);
  const setRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  useLayoutEffect(() => {
    if (!restoreFocus) return;
    const node = nodeRef.current;
    previousRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const previous = previousRef.current;
      if (node?.contains(document.activeElement) && previous?.isConnected
        && previous !== document.body && previous !== document.documentElement) previous.focus({ preventScroll: true });
    };
  }, [restoreFocus]);
  return <div className={contained ? "min-w-0 w-full" : "pointer-events-none absolute inset-x-0 top-2 z-30 flex max-h-[calc(100%-1rem)] justify-center overflow-y-auto px-3"}>
    <div {...props} ref={setRef} className="pointer-events-auto min-w-0 w-full max-w-lg" onFocusCapture={event => {
      // Return to where the person entered from, not an unrelated control that
      // happened to have focus when this passive notice first appeared.
      if (restoreFocus && event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) {
        previousRef.current = event.relatedTarget;
      }
      onFocusCapture?.(event);
    }}>
      {children}
    </div>
  </div>;
});
