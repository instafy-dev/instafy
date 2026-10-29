import { useLayoutEffect, useRef } from "react";

/**
 * Switches to the Browser view once for each request to show it (a press,
 * the person's own open), as soon as the browser is open. Studio opening the
 * browser by itself for a card makes no request, so the person stays in Chat,
 * also when the browser opens after an earlier request was shown.
 */
export function useShowBrowserOnRequest(open: boolean, requestToken: number, show: () => void): void {
  const shownToken = useRef(0);
  useLayoutEffect(() => {
    if (!open || requestToken <= shownToken.current) return;
    shownToken.current = requestToken;
    show();
  }, [open, requestToken, show]);
}
