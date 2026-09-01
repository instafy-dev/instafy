import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ThreadSpine } from "./ThreadSpine";
import type { ChatSpeakerMarker } from "./chatSpeakerMarker";

export type ChatBubbleAlignment = "left" | "right";

const WORKFLOW_SPINE_CONTINUATION_OVERLAP_PX = 10;
const WORKFLOW_SPINE_DEFAULT_NOTCH_OFFSET_PX = 9;
const WORKFLOW_SPINE_CONTINUATION_NOTCH_OFFSET_PX = 19;
const WORKFLOW_SPINE_NOTCH_ANCHOR_SELECTOR = '[data-workflow-spine-notch-anchor="true"]';

export function ChatBubbleRow({
  align = "left",
  avatar = null,
  collapseAvatarOnNarrow = false,
  speakerIdentity = null,
  narrowSpeakerIdentity = null,
  speakerMarker = { kind: "boundary" },
  children,
  onContextMenu,
  workflowSpineActive = false,
  workflowSpineContinuesBefore = false,
  workflowSpineContinuesAfter = false,
  testId,
}: {
  align?: ChatBubbleAlignment;
  avatar?: ReactNode | null;
  collapseAvatarOnNarrow?: boolean;
  speakerIdentity?: ReactNode | null;
  narrowSpeakerIdentity?: ReactNode | null;
  speakerMarker?: ChatSpeakerMarker | null;
  children: ReactNode;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  workflowSpineActive?: boolean;
  workflowSpineContinuesBefore?: boolean;
  workflowSpineContinuesAfter?: boolean;
  testId?: string;
}) {
  const isLeftAligned = align === "left";
  const showWorkflowSpine = isLeftAligned && workflowSpineActive;
  const workflowSpineTopClass = workflowSpineContinuesBefore ? "top-[-0.625rem]" : "top-0";
  const workflowSpineBottomClass = workflowSpineContinuesAfter ? "bottom-[-0.625rem]" : "bottom-0";
  const defaultWorkflowSpineNotchOffsetPx = workflowSpineContinuesBefore
    ? WORKFLOW_SPINE_CONTINUATION_NOTCH_OFFSET_PX
    : WORKFLOW_SPINE_DEFAULT_NOTCH_OFFSET_PX;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [anchoredWorkflowSpineNotchOffsetPx, setAnchoredWorkflowSpineNotchOffsetPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!showWorkflowSpine) {
      setAnchoredWorkflowSpineNotchOffsetPx(null);
      return;
    }

    const row = rowRef.current;
    if (!row) {
      setAnchoredWorkflowSpineNotchOffsetPx(null);
      return;
    }

    let animationFrameId: number | null = null;
    const updateAnchoredOffset = () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const anchor = row.querySelector<HTMLElement>(WORKFLOW_SPINE_NOTCH_ANCHOR_SELECTOR);
        if (!anchor) {
          setAnchoredWorkflowSpineNotchOffsetPx(null);
          return;
        }

        const rowRect = row.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        if (rowRect.height <= 0 || anchorRect.height <= 0) {
          setAnchoredWorkflowSpineNotchOffsetPx(null);
          return;
        }

        const continuationOverlapPx = workflowSpineContinuesBefore
          ? WORKFLOW_SPINE_CONTINUATION_OVERLAP_PX
          : 0;
        const maximumOffsetPx = Math.max(
          defaultWorkflowSpineNotchOffsetPx,
          Math.round(rowRect.height + continuationOverlapPx - 12),
        );
        const nextOffsetPx = Math.min(
          maximumOffsetPx,
          Math.max(
            defaultWorkflowSpineNotchOffsetPx,
            Math.round(anchorRect.top - rowRect.top + continuationOverlapPx),
          ),
        );
        setAnchoredWorkflowSpineNotchOffsetPx((currentOffsetPx) =>
          currentOffsetPx === nextOffsetPx ? currentOffsetPx : nextOffsetPx,
        );
      });
    };

    updateAnchoredOffset();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => updateAnchoredOffset());
      resizeObserver.observe(row);
      const anchor = row.querySelector<HTMLElement>(WORKFLOW_SPINE_NOTCH_ANCHOR_SELECTOR);
      if (anchor) {
        resizeObserver.observe(anchor);
      }
    }
    window.addEventListener("resize", updateAnchoredOffset);

    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateAnchoredOffset);
    };
  }, [defaultWorkflowSpineNotchOffsetPx, showWorkflowSpine, workflowSpineContinuesBefore]);

  const workflowSpineNotchOffsetPx =
    anchoredWorkflowSpineNotchOffsetPx ?? defaultWorkflowSpineNotchOffsetPx;
  const assistantSpeakerMarker =
    speakerMarker?.kind === "assistant" ? speakerMarker : null;
  const humanSpeakerMarker =
    speakerMarker?.kind === "human" ? speakerMarker : null;
  return (
    <div
      ref={rowRef}
      className="relative w-full"
      onContextMenu={onContextMenu}
      data-testid={testId}
    >
      {showWorkflowSpine ? (
        <ThreadSpine
          testId="chat-workflow-spine"
          tone="primary"
          className={[
            "pointer-events-none absolute left-[11.5px] z-0 w-4",
            workflowSpineTopClass,
            workflowSpineBottomClass,
            collapseAvatarOnNarrow ? "hidden sm:block" : "",
          ].filter(Boolean).join(" ")}
          notches={[{ offsetPx: workflowSpineNotchOffsetPx, maskLine: true }]}
        />
      ) : null}
      <div className={`relative z-10 flex w-full min-w-0 gap-2 ${isLeftAligned ? "items-start" : "flex-row-reverse items-end"}`}>
        {avatar ? (
          <div className={`h-8 w-8 flex-none ${collapseAvatarOnNarrow ? "hidden sm:block" : ""}`}>
            {avatar}
          </div>
        ) : null}
        <div className={`min-w-0 max-w-full flex-1 ${isLeftAligned ? "" : "flex justify-end"}`}>
          {speakerMarker ? (
            <span
              aria-hidden="true"
              className="block h-0 w-0 overflow-hidden"
              data-chat-speaker-marker="true"
              data-chat-speaker-kind={speakerMarker.kind}
              data-agent-avatar-seed={assistantSpeakerMarker?.avatarSeed}
              data-agent-handle={assistantSpeakerMarker?.handle}
              data-human-avatar-seed={humanSpeakerMarker?.avatarSeed ?? undefined}
              data-human-label={humanSpeakerMarker?.label}
              data-testid={
                assistantSpeakerMarker
                  ? "chat-speaker-marker"
                  : humanSpeakerMarker
                    ? "chat-speaker-human-marker"
                    : "chat-speaker-boundary"
              }
            />
          ) : null}
          {speakerIdentity ? (
            <div
              className="mb-1.5 flex w-fit max-w-full data-[chat-speaker-covered=true]:invisible"
              data-chat-speaker-inline="true"
              data-testid="chat-speaker-inline"
            >
              {speakerIdentity}
            </div>
          ) : null}
          {narrowSpeakerIdentity ? (
            <div
              className="mb-1.5 flex w-fit max-w-full sm:hidden data-[chat-speaker-covered=true]:invisible"
              data-chat-speaker-inline="true"
              data-testid="chat-speaker-inline"
            >
              {narrowSpeakerIdentity}
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
