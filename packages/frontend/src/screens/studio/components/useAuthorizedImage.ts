import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachmentDownloadResult } from "../../../lib/chatAttachments";
import { loadKeptImage } from "../../../lib/chatAttachmentPreviews";

// Images further than this from the visible part of the transcript wait to
// download until the person scrolls toward them.
const IMAGE_PRELOAD_MARGIN_PX = 800;

/**
 * True once the element is on screen or close to it, and from then on. Without
 * IntersectionObserver every image counts as near.
 */
export function useNearViewport(): [(node: HTMLElement | null) => void, boolean] {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const observerRef = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setNear(true);
        }
      },
      {
        root: node.closest('[data-testid="chat-message-scroll"]'),
        rootMargin: `${IMAGE_PRELOAD_MARGIN_PX}px 0px`,
      },
    );
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, near];
}

export type AuthorizedImageState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; url: string }
  | { key: string; status: "unavailable" }
  | { key: string; status: "failed" };

/**
 * An image only this person's session may read (a chat attachment, a preview
 * card's picture): downloaded with their own credentials once `enabled`, kept
 * in memory under `key` within the chat's image budget, and shown from an
 * object URL that is revoked when the image goes away. Never a signed URL.
 * A read that is refused, or an image that is gone, is `unavailable`; a
 * download that could not get through is `failed`, and `retry` tries again.
 */
export function useAuthorizedImage(
  key: string,
  load: () => Promise<ChatAttachmentDownloadResult>,
  enabled: boolean,
): { state: AuthorizedImageState; retry: () => void } {
  const [state, setState] = useState<AuthorizedImageState>({ key, status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The newest loader; the key alone says which image it is. Updated before
  // the download effect below runs.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void loadKeptImage(key, () => loadRef.current()).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setState({ key, status: result.reason === "transient" ? "failed" : "unavailable" });
        return;
      }
      objectUrl = URL.createObjectURL(result.blob);
      setState({ key, status: "ready", url: objectUrl });
    });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [attempt, enabled, key]);

  const retry = useCallback(() => {
    setState({ key, status: "loading" });
    setAttempt((value) => value + 1);
  }, [key]);

  // A new key shows as loading until its own download settles.
  return {
    state: state.key === key ? state : { key, status: "loading" },
    retry,
  };
}
