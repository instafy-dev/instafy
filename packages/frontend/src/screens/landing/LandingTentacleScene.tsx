import { useEffect, useRef, useState } from "react";

// Presence cursors are pinned to fixed points in the tentacle artwork
// (public/landing-tentacles.jpg, rendered with cover semantics), so each one
// stays glued to its arm at any viewport size instead of drifting when the
// aspect ratio changes.
const IMAGE_WIDTH = 1536;
const IMAGE_HEIGHT = 1024;

// Cursor colors deliberately match the arms in the raster artwork, not the
// theme accent tokens: a cursor that sits on its tentacle must share its hue.
interface LandingPresenceCursor {
  id: string;
  label: string;
  color: string;
  imageX: number;
  imageY: number;
  floatDelay: string;
  hideBelowMd?: boolean;
}

const PRESENCE_CURSORS: LandingPresenceCursor[] = [
  { id: "ada", label: "Ada", color: "#e93d82", imageX: 1210, imageY: 300, floatDelay: "-1.2s" },
  { id: "purple-agent", label: "", color: "#7c4dd8", imageX: 260, imageY: 700, floatDelay: "-3.1s" },
  { id: "octo", label: "Octo · agent", color: "#f5960a", imageX: 285, imageY: 105, floatDelay: "-4.6s", hideBelowMd: true },
  { id: "kim", label: "Kim", color: "#8cb93b", imageX: 1300, imageY: 880, floatDelay: "-2.2s" },
];

// Approximate rendered cursor-plus-label footprint used to keep cursors fully
// inside the scene; anchors whose cursor would clip the edge are dropped
// instead of clamped. The horizontal margin scales with the label because the
// name pill extends right of the anchor point.
const CURSOR_MARGIN_Y = 60;
const CURSOR_LABEL_CHAR_PX = 7.5;
const CURSOR_MARGIN_BASE_X = 26;

function projectImagePoint(
  box: { width: number; height: number },
  imageX: number,
  imageY: number,
): { x: number; y: number } {
  const scale = Math.max(box.width / IMAGE_WIDTH, box.height / IMAGE_HEIGHT);
  return {
    x: imageX * scale + (box.width - IMAGE_WIDTH * scale) / 2,
    y: imageY * scale + (box.height - IMAGE_HEIGHT * scale) / 2,
  };
}

function isInsideScene(
  box: { width: number; height: number },
  x: number,
  y: number,
  label: string,
): boolean {
  const marginX = CURSOR_MARGIN_BASE_X + label.length * CURSOR_LABEL_CHAR_PX;
  return x >= 12 && x <= box.width - marginX && y >= 12 && y <= box.height - CURSOR_MARGIN_Y;
}

// The bare artwork layer, shared with quieter surfaces (login) that want the
// same scene without cursors or motion.
export function TentacleBackdrop({ className }: { className?: string }) {
  return (
    <div
      className={[
        "absolute inset-0 bg-[url('/landing-tentacles.jpg')] bg-cover bg-center [mask-image:linear-gradient(to_bottom,black_84%,transparent_100%)]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export function LandingTentacleScene({ purpleAgentLabel }: { purpleAgentLabel?: string }) {
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const node = sceneRef.current;
    if (!node) return;
    const update = () => setBox({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={sceneRef}
      aria-hidden="true"
      data-testid="landing-tentacle-scene"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden dark:hidden"
    >
      <TentacleBackdrop />

      {box
        ? PRESENCE_CURSORS.map((cursor) => {
            const label = cursor.id === "purple-agent" ? (purpleAgentLabel ?? "Agent") : cursor.label;
            const { x, y } = projectImagePoint(box, cursor.imageX, cursor.imageY);
            if (!isInsideScene(box, x, y, label)) return null;
            return (
              <span
                key={cursor.id}
                style={{ left: Math.round(x), top: Math.round(y), animationDelay: cursor.floatDelay }}
                className={[
                  "absolute flex-col items-start motion-safe:animate-[landing-float_6s_ease-in-out_infinite]",
                  cursor.hideBelowMd ? "hidden md:flex" : "flex",
                ].join(" ")}
              >
                <svg width="18" height="20" viewBox="0 0 18 20">
                  <path d="M2 1 L16 10 L9 11.5 L7 19 Z" fill={cursor.color} stroke="#ffffff" strokeWidth="1.5" />
                </svg>
                <span
                  style={{ backgroundColor: cursor.color }}
                  className="ml-3.5 mt-0.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold text-white shadow-md"
                >
                  {label}
                </span>
              </span>
            );
          })
        : null}
    </div>
  );
}
