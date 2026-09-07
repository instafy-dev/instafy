import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatMessage } from "../types";

const OVERSCAN_PX = 1_000;
const MIN_DEFERRED_TRANSCRIPT_ROWS = 100;
type Measurement = { width: number; height: number; viewportWidth: number; layoutKey: string };
// Geometry only. Immutable message keys disappear with their history-cache data;
// this must never become a strong map retaining another copy of chat history.
const measurements = new WeakMap<ChatMessage, Measurement>();

function hideUntilFound(node: HTMLSpanElement | null) {
  // React's current HTML types only expose boolean `hidden`.
  node?.setAttribute("hidden", "until-found");
}

type RowObserver = {
  observe: (node: HTMLElement, update: (visible: boolean) => void, measure: () => void) => () => void;
  measureAll: () => void;
  disconnect: () => void;
};

function createRowObserver(enabled: boolean): RowObserver {
  const rows = new Map<Element, { update: (visible: boolean) => void; measure: () => void }>();
  let intersection: IntersectionObserver | null = null;
  let resize: ResizeObserver | null = null;
  let observingWindowResize = false;
  let measurementFrame: number | null = null;
  const measureRows = () => {
    if (measurementFrame !== null) cancelAnimationFrame(measurementFrame);
    measurementFrame = null;
    for (const row of rows.values()) row.measure();
  };
  const scheduleMeasurement = () => {
    if (measurementFrame === null) measurementFrame = requestAnimationFrame(measureRows);
  };
  const handleWindowResize = () => {
    measureRows();
    scheduleMeasurement();
  };
  return {
    measureAll: measureRows,
    observe(node, update, measure) {
      const root = node.closest('[data-testid="chat-message-scroll"]');
      if (!observingWindowResize) {
        window.addEventListener("resize", handleWindowResize);
        observingWindowResize = true;
      }
      if (enabled && root && !intersection) {
        intersection = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            // Keep an offscreen action/menu trigger mounted while it owns focus.
            const visible = entry.isIntersecting || entry.target.contains(document.activeElement);
            rows.get(entry.target)?.update(visible);
          }
        }, { root, rootMargin: `${OVERSCAN_PX}px 0px` });
      }
      if (!resize && typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver((entries) => {
          const viewport = root?.getBoundingClientRect();
          for (const entry of entries) {
            const row = rows.get(entry.target);
            row?.measure();
            // A width change can require one eager remeasurement even when
            // IntersectionObserver's visibility threshold did not change.
            if (enabled && viewport && !(entry.target as HTMLElement).dataset.chatRowDeferred) {
              const rect = entry.target.getBoundingClientRect();
              row?.update(rect.bottom >= viewport.top - OVERSCAN_PX && rect.top <= viewport.bottom + OVERSCAN_PX ||
                entry.target.contains(document.activeElement));
            }
          }
        });
      }
      rows.set(node, { update, measure });
      scheduleMeasurement();
      if (intersection) intersection.observe(node);
      else update(true);
      resize?.observe(node);
      return () => {
        rows.delete(node);
        intersection?.unobserve(node);
        resize?.unobserve(node);
      };
    },
    disconnect() {
      intersection?.disconnect();
      resize?.disconnect();
      intersection = null;
      resize = null;
      rows.clear();
      if (measurementFrame !== null) cancelAnimationFrame(measurementFrame);
      measurementFrame = null;
      window.removeEventListener("resize", handleWindowResize);
      observingWindowResize = false;
    },
  };
}

const DeferredRowsContext = createContext<{ observer: RowObserver; enabled: boolean } | null>(null);

export function DeferredChatRows({ children, messageCount }: {
  children: ReactNode;
  messageCount: number;
}) {
  const [readAll, setReadAll] = useState(false);
  // Browser Find must remain able to discover a deferred message. Browsers
  // without beforematch keep the full renderer. See hidden-until-found:
  // https://developer.chrome.com/docs/css-ui/hidden-until-found
  const enabled = !readAll && messageCount > MIN_DEFERRED_TRANSCRIPT_ROWS &&
    typeof IntersectionObserver !== "undefined" &&
    typeof document !== "undefined" && "onbeforematch" in document.documentElement;
  const observer = useMemo(() => createRowObserver(enabled), [enabled]);
  const value = useMemo(() => ({ observer, enabled }), [observer, enabled]);
  // Child refs write hidden-until-found attributes during commit. Reading row
  // geometry in each child's layout effect interleaves writes and reads and
  // forces a layout for every shell. Measure once after all children commit.
  useLayoutEffect(() => observer.measureAll());
  useLayoutEffect(() => () => observer.disconnect(), [observer]);

  useEffect(() => {
    if (!enabled) return;
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    const handleFind = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") setReadAll(true);
    };
    const handleSelection = () => {
      const selection = document.getSelection();
      const node = selection?.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      if (selection && !selection.isCollapsed && element?.closest('[data-chat-scroll-message-id]')) {
        setReadAll(true);
      }
    };
    const handleBeforeMatch = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-chat-row-deferred="true"]')) return;
      // Let the browser scroll to the searchable shell before replacing its
      // text with the rich message. Keyboard Find expands before searching.
      revealTimer = setTimeout(() => setReadAll(true), 0);
    };
    document.addEventListener("keydown", handleFind);
    document.addEventListener("selectionchange", handleSelection);
    document.addEventListener("beforematch", handleBeforeMatch, true);
    return () => {
      document.removeEventListener("keydown", handleFind);
      document.removeEventListener("selectionchange", handleSelection);
      document.removeEventListener("beforematch", handleBeforeMatch, true);
      if (revealTimer !== null) clearTimeout(revealTimer);
    };
  }, [enabled]);

  return (
    <DeferredRowsContext.Provider value={value}>
      {enabled ? (
        <button type="button" className="sr-only focus:not-sr-only" onClick={() => setReadAll(true)}>
          Read all loaded messages
        </button>
      ) : null}
      {children}
    </DeferredRowsContext.Provider>
  );
}

export function DeferredChatMessageRow({ message, layoutKey, eager, eligible, children }: {
  message: ChatMessage;
  layoutKey: string;
  eager: boolean;
  eligible: boolean;
  children: ReactNode;
}) {
  const context = useContext(DeferredRowsContext);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const cached = measurements.get(message);
  const validMeasurement = cached?.layoutKey === layoutKey && cached.viewportWidth === window.innerWidth
    ? cached : null;
  const [visible, setVisible] = useState(() => eager || !validMeasurement);
  const deferred = Boolean(context?.enabled && eligible && !visible && validMeasurement);
  const measure = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (node.dataset.chatRowDeferred === "true") {
      const previous = measurements.get(message);
      if (previous?.width !== rect.width || previous.viewportWidth !== window.innerWidth) setVisible(true);
      return;
    }
    if (rect.height > 0 && rect.width > 0) {
      measurements.set(message, {
        width: rect.width, height: rect.height, viewportWidth: window.innerWidth, layoutKey,
      });
    }
  }, [layoutKey, message]);
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    if (!context) { measure(); return; }
    return context.observer.observe(node, setVisible, measure);
  }, [context, measure]);

  return (
    <div
      ref={nodeRef}
      className="relative w-full"
      data-testid="chat-message-row"
      data-chat-scroll-message-id={message.id}
      data-chat-row-deferred={deferred ? "true" : undefined}
      style={deferred ? { height: validMeasurement?.height } : undefined}
      role={deferred ? "article" : undefined}
      aria-label={deferred ? `${message.role === "user" ? "User" : "Assistant"}: ${message.content}` : undefined}
    >
      {deferred ? <span ref={hideUntilFound} className="block">{message.content}</span> : children}
    </div>
  );
}
