import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import octoMarkGeometry from "../assets/octo-mark.geometry.json";
import {
  OCTO_MOTION_PHASES,
  applyOctoScrollDeformationToPath,
  formatOctoMotionCoordinate,
  getOctoArmMotionGeometry,
} from "./octoMarkMotionGeometry";
import { useOctoScrollMotionSnapshot } from "./OctoScrollMotionScope";

export {
  OctoScrollMotionScope,
  useOctoScrollMotionSnapshot,
} from "./OctoScrollMotionScope";

export type OctoMarkMotion = "idle" | "thinking";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MOTION_DURATION = "3s";
const MOTION_KEY_TIMES = "0;0.18;0.34;0.46;0.57;0.72;0.88;1";
const MOTION_KEY_SPLINES = [
  "0.33 0.3 0.67 0.7",
  "0.33 0.3 0.67 0.7",
  "0.33 0.3 0.67 0.7",
  "0.33 0.3 0.67 0.7",
  "0.33 0.3 0.67 0.7",
  "0.33 0.3 0.67 0.7",
  "0.33 0.3 0.67 0.7",
].join(";");
const ARM_BEGIN_TIMES = ["0s", "0s", "0s", "0s"] as const;
const SWIMMER_TRANSLATE_VALUES = [
  "0 0",
  "0 0.05",
  "0 0.1",
  "0 0",
  "0 -0.65",
  "0 -0.45",
  "0 -0.1",
  "0 0",
].join(";");
const MANTLE_TRANSLATE_VALUES = [
  "0 0",
  "0 0",
  "0 0",
  "0 -0.15",
  "0 -0.35",
  "0 -0.2",
  "0 0",
  "0 0",
].join(";");
const MANTLE_SCALE_VALUES = [
  "1 1",
  "1.015 0.98",
  "1.08 0.84",
  "1.04 0.91",
  "0.97 1.06",
  "0.985 1.03",
  "1.005 0.99",
  "1 1",
].join(";");

function readPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }

  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

function readFalse(): boolean {
  return false;
}

export function usePrefersReducedMotion(enabled = true): boolean {
  return useSyncExternalStore(
    enabled ? subscribeToReducedMotion : subscribeToNothing,
    enabled ? readPrefersReducedMotion : readFalse,
    readFalse,
  );
}

function getTentacleMotionValues(index: number): string {
  const geometry = getOctoArmMotionGeometry()[index];
  const canonicalPath = octoMarkGeometry.paths[index + 1];
  return [
    canonicalPath,
    ...OCTO_MOTION_PHASES.map((phase) => geometry.paths[phase]),
    canonicalPath,
  ].join(";");
}

function getNodeMotionValues(index: number): string {
  const geometry = getOctoArmMotionGeometry()[index];
  const canonicalNode = octoMarkGeometry.circles[index];
  const translations = OCTO_MOTION_PHASES.map((phase) => {
    const node = geometry.nodes[phase];
    const x = formatOctoMotionCoordinate(node.x - canonicalNode.cx);
    const y = formatOctoMotionCoordinate(node.y - canonicalNode.cy);
    return `${x} ${y}`;
  });
  return ["0 0", ...translations, "0 0"].join(";");
}

type OctoMotionValues = {
  nodes: string[];
  tentacles: string[];
};

let cachedMotionValues: OctoMotionValues | null = null;

function getOctoMotionValues(): OctoMotionValues {
  if (cachedMotionValues) {
    return cachedMotionValues;
  }

  const values = {
    tentacles: octoMarkGeometry.paths
      .slice(1)
      .map((_, index) => getTentacleMotionValues(index)),
    nodes: octoMarkGeometry.circles.map((_, index) => getNodeMotionValues(index)),
  };
  cachedMotionValues = values;
  return values;
}

/** The canonical Instafy Octo mark, rendered in the caller's current color. */
export function OctoMark({
  className,
  motion = "idle",
  scrollReactive = false,
  title,
}: {
  className?: string;
  motion?: OctoMarkMotion;
  scrollReactive?: boolean;
  title?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion(
    motion === "thinking" || scrollReactive,
  );
  const scrollMotion = useOctoScrollMotionSnapshot(
    scrollReactive && !prefersReducedMotion,
  );
  const scrollActive =
    scrollReactive && !prefersReducedMotion && scrollMotion.deformation.active;
  const shouldThink = motion === "thinking" && !prefersReducedMotion;
  // Direct manipulation wins over autonomous limb motion. This keeps the scroll
  // response light enough for phones and resumes thinking from its neutral pose.
  const shouldAnimateThinkingLimbs = shouldThink && !scrollActive;
  const shouldAnimate = shouldThink || scrollActive;
  const motionValues = shouldAnimateThinkingLimbs ? getOctoMotionValues() : null;
  const scrollMantle = scrollMotion.deformation.mantle;
  const scrollMantleTranslate = `translate(0 ${formatOctoMotionCoordinate(
    scrollMantle.translateY,
  )})`;
  const scrollMantleScale = `scale(${formatOctoMotionCoordinate(
    scrollMantle.scaleX,
  )} ${formatOctoMotionCoordinate(scrollMantle.scaleY)})`;
  const tentaclePaths = octoMarkGeometry.paths.slice(1).map((path, armIndex) =>
    scrollActive
      ? applyOctoScrollDeformationToPath(
          path,
          armIndex,
          scrollMotion.deformation.arms[armIndex],
        )
      : path,
  );

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!shouldAnimateThinkingLimbs || typeof svg?.setCurrentTime !== "function") {
      return;
    }

    svg.setCurrentTime(0);
  }, [shouldAnimateThinkingLimbs]);

  return (
    <svg
      ref={svgRef}
      viewBox={octoMarkGeometry.viewBox}
      className={["octo-mark", className].filter(Boolean).join(" ")}
      data-octo-motion={motion}
      data-octo-animated={shouldAnimate ? "true" : "false"}
      data-octo-limb-driver={
        scrollActive ? "scroll" : shouldAnimateThinkingLimbs ? "thinking" : "idle"
      }
      data-octo-scroll-phase={scrollReactive ? scrollMotion.phase : undefined}
      data-octo-scroll-reactive={scrollReactive ? "true" : "false"}
      data-octo-scroll-tip-y={
        scrollReactive
          ? formatOctoMotionCoordinate(scrollMotion.deformation.arms[0].tip.y)
          : undefined
      }
      data-octo-scroll-mantle-scale-y={
        scrollReactive
          ? formatOctoMotionCoordinate(scrollMantle.scaleY)
          : undefined
      }
      data-octo-scroll-mantle-scale-x={
        scrollReactive
          ? formatOctoMotionCoordinate(scrollMantle.scaleX)
          : undefined
      }
      data-octo-scroll-mantle-translate-y={
        scrollReactive
          ? formatOctoMotionCoordinate(scrollMantle.translateY)
          : undefined
      }
      role="img"
      aria-label={title ?? "Instafy"}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="currentColor" transform={octoMarkGeometry.transform}>
        <g data-octo-part="swimmer">
          {shouldThink ? (
            <animateTransform
              attributeName="transform"
              type="translate"
              values={SWIMMER_TRANSLATE_VALUES}
              keyTimes={MOTION_KEY_TIMES}
              keySplines={MOTION_KEY_SPLINES}
              calcMode="spline"
              dur={MOTION_DURATION}
              repeatCount="indefinite"
              data-octo-animation="swimmer"
            />
          ) : null}
          <g transform="translate(32 29.5)" data-octo-part="mantle">
            <g>
              {shouldThink ? (
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values={MANTLE_TRANSLATE_VALUES}
                  keyTimes={MOTION_KEY_TIMES}
                  keySplines={MOTION_KEY_SPLINES}
                  calcMode="spline"
                  dur={MOTION_DURATION}
                  repeatCount="indefinite"
                  data-octo-animation="mantle-translate"
                />
              ) : null}
              <g
                transform={scrollMantleTranslate}
                data-octo-part="mantle-scroll-translate"
              >
                <g>
                  {shouldThink ? (
                    <animateTransform
                      attributeName="transform"
                      type="scale"
                      values={MANTLE_SCALE_VALUES}
                      keyTimes={MOTION_KEY_TIMES}
                      keySplines={MOTION_KEY_SPLINES}
                      calcMode="spline"
                      dur={MOTION_DURATION}
                      repeatCount="indefinite"
                      data-octo-animation="mantle-scale"
                    />
                  ) : null}
                  <g
                    transform={scrollMantleScale}
                    data-octo-part="mantle-scroll-scale"
                  >
                    <path
                      d={octoMarkGeometry.paths[0]}
                      transform="translate(-32 -29.5)"
                      data-octo-part="body"
                    />
                  </g>
                </g>
              </g>
            </g>
          </g>
          {tentaclePaths.map((path, armIndex) => (
            <path
              key={`tentacle-${armIndex + 1}`}
              d={path}
              data-octo-part="tentacle"
              data-octo-arm={armIndex + 1}
            >
              {motionValues ? (
                <animate
                  attributeName="d"
                  values={motionValues.tentacles[armIndex]}
                  keyTimes={MOTION_KEY_TIMES}
                  keySplines={MOTION_KEY_SPLINES}
                  calcMode="spline"
                  dur={MOTION_DURATION}
                  begin={ARM_BEGIN_TIMES[armIndex]}
                  repeatCount="indefinite"
                  data-octo-animation="tentacle"
                />
              ) : null}
            </path>
          ))}
          {octoMarkGeometry.circles.map((circle, index) => (
            <circle
              key={`node-${index + 1}`}
              cx={circle.cx}
              cy={circle.cy}
              r={circle.r}
              transform={
                !motionValues && scrollActive
                  ? `translate(${formatOctoMotionCoordinate(
                      scrollMotion.deformation.arms[index].tip.x,
                    )} ${formatOctoMotionCoordinate(
                      scrollMotion.deformation.arms[index].tip.y,
                    )})`
                  : undefined
              }
              data-octo-part="node"
              data-octo-arm={index + 1}
            >
              {motionValues ? (
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values={motionValues.nodes[index]}
                  keyTimes={MOTION_KEY_TIMES}
                  keySplines={MOTION_KEY_SPLINES}
                  calcMode="spline"
                  dur={MOTION_DURATION}
                  begin={ARM_BEGIN_TIMES[index]}
                  repeatCount="indefinite"
                  data-octo-animation="node"
                />
              ) : null}
            </circle>
          ))}
        </g>
      </g>
    </svg>
  );
}
