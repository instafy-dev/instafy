import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useOptionalUserId } from "../../../../providers/AuthProvider";
import type { GuardPosition } from "./followMode";
import { buildHostLayoutMessage, currentStudioTheme, parseSiteMessage } from "./hostMessages";
import { usePreviewFollow } from "./usePreviewFollow";

export type SiteMessageEvent = Pick<MessageEvent, "data" | "origin" | "source">;

const NO_POSITIONS = (): GuardPosition[] => [];

/**
 * The host side of one preview pane's frame, for any site: the layout message
 * (sent on each load, when Studio's theme changes, and again when a site that
 * missed it first speaks), what the site says it supports, and follow mode.
 * SitePreviewPane owns the frame, the capability and the checks on where a
 * message came from; it hands every other message from its own frame here. A
 * site that never answers is just a page in a frame.
 */
export function useSiteHost({ frame, viewerUrl, frameKey, projectId, previewId, frameOnScreen, guardPositions = NO_POSITIONS, onError }: {
  frame: RefObject<HTMLIFrameElement | null>;
  /** The live capability address: messages go to its origin only. */
  viewerUrl: string | null;
  /** Changes when the pane reloads the frame. */
  frameKey: number;
  projectId: string;
  previewId: string;
  /** The frame is mounted, the session ready and the pane on screen. */
  frameOnScreen: boolean;
  /**
   * The person's positions this frame was given since it last loaded fresh:
   * follow mode never shares a view that holds one (docs/Follow-Mode.md).
   * Studio gives a frame none today; whatever gives it one passes them here.
   */
  guardPositions?: () => GuardPosition[];
  onError: (message: string) => void;
}) {
  const postToFrame = useCallback((message: unknown) => {
    const target = frame.current?.contentWindow;
    if (!target || !viewerUrl) return false;
    try { target.postMessage(message, new URL(viewerUrl).origin); return true; } catch { return false; }
  }, [frame, viewerUrl]);

  const [theme, setTheme] = useState(currentStudioTheme);
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => setTheme(currentStudioTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  const sendLayout = useCallback(() => { postToFrame(buildHostLayoutMessage({ theme })); }, [postToFrame, theme]);
  useEffect(() => { sendLayout(); }, [sendLayout]);

  /** What the site's `layout-ack` listed ("view", "tap"); cleared with each new document. */
  const [supports, setSupports] = useState<readonly string[]>([]);
  /** Counts the frame's documents: a site that navigates must be told again that it presents. */
  const [frameLoads, setFrameLoads] = useState(0);
  const heardFromSite = useRef(false);
  const onFrameLoad = useCallback(() => {
    heardFromSite.current = false;
    setSupports([]);
    setFrameLoads(count => count + 1);
    sendLayout();
  }, [sendLayout]);
  // A new capability or a reload is a new document: what the old one supported is gone.
  useEffect(() => () => { setSupports([]); }, [frameKey, viewerUrl]);

  const guardRef = useRef(guardPositions);
  guardRef.current = guardPositions;
  const selfId = useOptionalUserId();
  const follow = usePreviewFollow({
    projectId,
    previewId,
    frameOnScreen,
    postToFrame,
    supportsView: supports.includes("view"),
    supportsTap: supports.includes("tap"),
    documentKey: `${viewerUrl ?? ""}:${frameKey}:${frameLoads}`,
    recentPositions: () => guardRef.current(),
    frameElement: () => frame.current,
    selfId,
    onError,
  });
  const followSiteEvent = useRef(follow.handleSiteEvent);
  followSiteEvent.current = follow.handleSiteEvent;

  /** One message from this pane's frame at the viewer's origin (the pane checked both). True when it was read. */
  const handleSiteMessage = useCallback((event: SiteMessageEvent): boolean => {
    const parsed = parseSiteMessage(event.data);
    if (!parsed) return false;
    // A site whose bridge starts after the frame's load event missed the first layout message.
    if (!heardFromSite.current) { heardFromSite.current = true; sendLayout(); }
    // Within one document what a site supports only grows.
    if (parsed.type === "layout-ack") {
      setSupports(current => parsed.supports.every(name => current.includes(name)) ? current : [...new Set([...current, ...parsed.supports])]);
    }
    followSiteEvent.current(parsed);
    return true;
  }, [sendLayout]);

  return {
    onFrameLoad,
    handleSiteMessage,
    follow,
    supportsView: supports.includes("view"),
  };
}
