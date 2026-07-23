import { useLayoutEffect, useRef, useState } from "react";
import type { SharedBrowserCollaborationParticipant } from "./sharedBrowserCollaboration";
import { remoteBrowserContentRect } from "./remoteBrowserSurfaceGeometry";

type PositionedParticipant = SharedBrowserCollaborationParticipant & {
  left: number;
  top: number;
};

export function SharedBrowserParticipantPointers({
  activePageId,
  containerRef,
  participants,
  selfParticipantId,
}: {
  activePageId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  participants: SharedBrowserCollaborationParticipant[];
  selfParticipantId: string | null;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [, setLayoutRevision] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const root = rootRef.current;
    if (!container || !root) {
      return;
    }
    const update = () => setLayoutRevision((current) => current + 1);
    const surface = container.querySelector<HTMLCanvasElement | HTMLVideoElement>("canvas, video");
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    resizeObserver?.observe(container);
    if (surface) {
      resizeObserver?.observe(surface);
    }
    const mutationObserver =
      typeof MutationObserver === "function" ? new MutationObserver(update) : null;
    mutationObserver?.observe(container, {
      attributes: true,
      attributeFilter: [
        "data-remote-content-width",
        "data-remote-content-height",
        "height",
        "width",
      ],
      childList: true,
      subtree: true,
    });
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true, capture: true });
    update();
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true } as EventListenerOptions);
    };
  }, [containerRef]);

  const root = rootRef.current;
  const surface =
    containerRef.current?.querySelector<HTMLCanvasElement | HTMLVideoElement>("canvas, video") ??
    null;
  const positioned: PositionedParticipant[] = [];
  if (root && surface && activePageId) {
    const rootRect = root.getBoundingClientRect();
    const surfaceRect = remoteBrowserContentRect(surface);
    if (surfaceRect) {
      for (const participant of participants) {
        if (
          participant.id === selfParticipantId ||
          participant.pageId !== activePageId ||
          !participant.cursor
        ) {
          continue;
        }
        positioned.push({
          ...participant,
          left: surfaceRect.left - rootRect.left + participant.cursor.x * surfaceRect.width,
          top: surfaceRect.top - rootRect.top + participant.cursor.y * surfaceRect.height,
        });
      }
    }
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
      data-testid="shared-browser-participant-pointers"
      ref={rootRef}
    >
      {positioned.map((participant) => (
        <div
          className="absolute transition-[left,top] duration-75 ease-linear"
          data-participant-id={participant.id}
          data-testid="shared-browser-participant-pointer"
          key={participant.id}
          style={{ left: participant.left, top: participant.top }}
        >
          <svg
            className="relative -translate-x-[3px] -translate-y-[2px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
            fill="none"
            height="20"
            viewBox="0 0 20 20"
            width="20"
          >
            <path
              d="M4 2.5 L4 15.5 L7.7 12.2 L10.1 17.4 L12.3 16.3 L9.9 11.2 L14.6 11.2 Z"
              fill={participant.color}
              stroke="#ffffff"
              strokeLinejoin="round"
              strokeWidth="1.2"
            />
          </svg>
          <span
            className="absolute left-3 top-3 max-w-32 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
            style={{ backgroundColor: participant.color }}
          >
            {participant.displayName}
          </span>
        </div>
      ))}
    </div>
  );
}
