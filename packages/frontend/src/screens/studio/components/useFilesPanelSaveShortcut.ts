import { useEffect, type RefObject } from "react";

interface FilesPanelSaveShortcutOptions {
  editorContainerRef: RefObject<HTMLElement | null>;
  markdownPreviewContainerRef: RefObject<HTMLElement | null>;
  viewerStateRef: RefObject<{ mode: string }>;
  saveDraftHandlerRef: RefObject<(() => Promise<void>) | null>;
  saveVersionHandlerRef: RefObject<(() => Promise<void>) | null>;
}

function isVisibleFileSurface(element: HTMLElement | null): boolean {
  if (!element?.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']") || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
}

/** Retained editors must not save in response to shortcuts on a different surface. */
export function useFilesPanelSaveShortcut({
  editorContainerRef, markdownPreviewContainerRef, viewerStateRef, saveDraftHandlerRef, saveVersionHandlerRef,
}: FilesPanelSaveShortcutOptions) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key?.toLowerCase() !== "s" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (viewerStateRef.current.mode !== "text" || ![editorContainerRef.current, markdownPreviewContainerRef.current].some(isVisibleFileSurface)) return;
      const handler = event.shiftKey ? saveDraftHandlerRef.current : saveVersionHandlerRef.current;
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      void handler();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [editorContainerRef, markdownPreviewContainerRef, saveDraftHandlerRef, saveVersionHandlerRef, viewerStateRef]);
}
