import octoMarkGeometry from "../assets/octo-mark.geometry.json";
import type {
  OctoScrollArmDeformation,
  OctoScrollPoint,
} from "./octoScrollPhysics";

export const OCTO_MOTION_PHASES = [
  "open",
  "catch",
  "drive",
  "contract",
  "release",
  "recover",
] as const;

export type OctoMotionPhase = (typeof OCTO_MOTION_PHASES)[number];

type Point = {
  x: number;
  y: number;
};

type ArmSpec = {
  root: Point;
  outwardDirection: -1 | 1;
  spreadAmplitude: number;
  cupAmplitude: number;
  lagAmplitude: number;
  downAmplitude: number;
};

type ProjectedArmSpec = ArmSpec & {
  axis: Point;
  motionLength: number;
};

type ProjectedArmGeometry = {
  canonicalPoints: readonly Point[];
  distalIndex: number;
  spec: ProjectedArmSpec;
};

type Pose = {
  spread: number;
  down: number;
  cup: number;
  tipLag: number;
};

const ARM_SPECS: readonly ArmSpec[] = [
  {
    root: { x: 21, y: 25.5 },
    outwardDirection: -1,
    spreadAmplitude: 4.5,
    cupAmplitude: 3,
    lagAmplitude: 2.2,
    downAmplitude: 2.8,
  },
  {
    root: { x: 27, y: 26 },
    outwardDirection: -1,
    spreadAmplitude: 3.6,
    cupAmplitude: 2.5,
    lagAmplitude: 1.8,
    downAmplitude: 3.2,
  },
  {
    root: { x: 35.5, y: 25.5 },
    outwardDirection: 1,
    spreadAmplitude: 3.6,
    cupAmplitude: 2.5,
    lagAmplitude: 1.8,
    downAmplitude: 3.2,
  },
  {
    root: { x: 39, y: 22 },
    outwardDirection: 1,
    spreadAmplitude: 4.5,
    cupAmplitude: 3,
    lagAmplitude: 2.2,
    downAmplitude: 2.8,
  },
];

const POSES: Record<OctoMotionPhase, Pose> = {
  // Refill the mantle while the arms begin opening with very little drag.
  open: { spread: 0.35, down: -0.05, cup: -0.1, tipLag: 0 },
  // Fan the full arm outward to present a broad paddle to the water.
  catch: { spread: 0.92, down: 0, cup: -0.4, tipLag: 0.08 },
  // Start the arm middles down and inward while the distal tips still lag outside.
  drive: { spread: 0.35, down: 0.45, cup: 0.7, tipLag: 0.72 },
  // Pull the tips decisively down and inward for the visible power stroke.
  contract: { spread: -1, down: 1, cup: 0.25, tipLag: -0.05 },
  // Keep the tucked trailing silhouette as the whole mark coasts upward.
  release: { spread: -0.55, down: 0.72, cup: 0, tipLag: 0 },
  // Return through a shallow open curve instead of reversing the contraction.
  recover: { spread: 0.05, down: 0.15, cup: -0.12, tipLag: 0 },
};

const NUMBER_TOKEN = /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const PATH_NUMBER_TOKEN = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function formatCoordinate(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function warpPoint(point: Point, spec: ProjectedArmSpec, pose: Pose): Point {
  const fromRoot = {
    x: point.x - spec.root.x,
    y: point.y - spec.root.y,
  };
  const projectedProgress =
    (fromRoot.x * spec.axis.x + fromRoot.y * spec.axis.y) / spec.motionLength;
  const progress = clamp((projectedProgress - 0.12) / 0.88, 0, 1);
  if (progress === 0) {
    return point;
  }

  const attachmentFade = smoothstep(clamp(progress / 0.24, 0, 1));
  const tipWeight = progress * progress;
  const midWeight = attachmentFade * Math.sin(Math.PI * progress);
  const lagWeight = progress ** 4;
  const lateralOffset =
    spec.outwardDirection *
    (spec.spreadAmplitude * pose.spread * tipWeight -
      spec.cupAmplitude * pose.cup * midWeight +
      spec.lagAmplitude * pose.tipLag * lagWeight);
  const downOffset = spec.downAmplitude * pose.down * tipWeight;

  return {
    x: point.x + lateralOffset,
    y: point.y + downOffset,
  };
}

function warpPath(
  path: string,
  warp: (point: Point) => Point,
  preserveAttachmentEndpoints = false,
): string {
  const commands = path.match(/[A-Za-z]/g) ?? [];
  if (commands.some((command) => !["M", "C", "Z"].includes(command.toUpperCase()))) {
    throw new Error("Octo motion currently supports canonical M/C/Z paths only");
  }

  const tokens = path.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  if (!tokens) {
    throw new Error("Octo path contains no SVG tokens");
  }

  const pointCount = tokens.filter((token) => NUMBER_TOKEN.test(token)).length / 2;
  let pointIndex = 0;
  const morphed: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!NUMBER_TOKEN.test(token)) {
      morphed.push(token);
      continue;
    }

    const nextToken = tokens[index + 1];
    if (!nextToken || !NUMBER_TOKEN.test(nextToken)) {
      throw new Error("Octo path coordinates must be x/y pairs");
    }

    const canonicalPoint = { x: Number(token), y: Number(nextToken) };
    const point =
      preserveAttachmentEndpoints &&
      (pointIndex === 0 || pointIndex === pointCount - 1)
        ? canonicalPoint
        : warp(canonicalPoint);
    morphed.push(formatCoordinate(point.x), formatCoordinate(point.y));
    pointIndex += 1;
    index += 1;
  }

  return morphed.join(" ");
}

function morphPath(path: string, spec: ProjectedArmSpec, pose: Pose): string {
  return warpPath(path, (point) => warpPoint(point, spec, pose));
}

function getPathPoints(path: string): Point[] {
  const numbers = (path.match(PATH_NUMBER_TOKEN) ?? []).map(Number);
  if (numbers.length % 2 !== 0) {
    throw new Error("Octo path coordinates must be x/y pairs");
  }

  const points: Point[] = [];
  for (let index = 0; index < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

function normalizePoint(point: Point): Point {
  const length = Math.hypot(point.x, point.y);
  if (length === 0) {
    throw new Error("Octo direction cannot have zero length");
  }
  return { x: point.x / length, y: point.y / length };
}

function rotatePoint(point: Point, angle: number): Point {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  };
}

function getFollowingNodePosition({
  canonicalNode,
  canonicalPoints,
  distalIndex,
  morphedPoints,
}: {
  canonicalNode: Point;
  canonicalPoints: readonly Point[];
  distalIndex: number;
  morphedPoints: readonly Point[];
}): Point {
  const shoulderOffset = 6;
  const canonicalAnchor = canonicalPoints[distalIndex];
  const morphedAnchor = morphedPoints[distalIndex];
  const canonicalBefore = canonicalPoints[distalIndex - shoulderOffset];
  const canonicalAfter = canonicalPoints[distalIndex + shoulderOffset];
  const morphedBefore = morphedPoints[distalIndex - shoulderOffset];
  const morphedAfter = morphedPoints[distalIndex + shoulderOffset];
  if (
    !canonicalAnchor ||
    !morphedAnchor ||
    !canonicalBefore ||
    !canonicalAfter ||
    !morphedBefore ||
    !morphedAfter
  ) {
    throw new Error("Octo distal geometry is incomplete");
  }

  const outwardHint = {
    x: canonicalNode.x - canonicalAnchor.x,
    y: canonicalNode.y - canonicalAnchor.y,
  };
  const nodeDistance = Math.hypot(outwardHint.x, outwardHint.y);
  const canonicalProbe = {
    x: (canonicalBefore.x + canonicalAfter.x) / 2,
    y: (canonicalBefore.y + canonicalAfter.y) / 2,
  };
  const morphedProbe = {
    x: (morphedBefore.x + morphedAfter.x) / 2,
    y: (morphedBefore.y + morphedAfter.y) / 2,
  };
  const canonicalTipDirection = normalizePoint({
    x: canonicalAnchor.x - canonicalProbe.x,
    y: canonicalAnchor.y - canonicalProbe.y,
  });
  const canonicalNodeDirection = normalizePoint(outwardHint);
  const correctionAngle = Math.atan2(
    canonicalTipDirection.x * canonicalNodeDirection.y -
      canonicalTipDirection.y * canonicalNodeDirection.x,
    canonicalTipDirection.x * canonicalNodeDirection.x +
      canonicalTipDirection.y * canonicalNodeDirection.y,
  );
  const tipDirection = normalizePoint({
    x: morphedAnchor.x - morphedProbe.x,
    y: morphedAnchor.y - morphedProbe.y,
  });
  const targetDirection = rotatePoint(tipDirection, correctionAngle);
  const directionDelta = Math.atan2(
    canonicalNodeDirection.x * targetDirection.y -
      canonicalNodeDirection.y * targetDirection.x,
    canonicalNodeDirection.x * targetDirection.x +
      canonicalNodeDirection.y * targetDirection.y,
  );
  const maximumDirectionDelta = (Math.PI * 12) / 180;
  const direction = rotatePoint(
    canonicalNodeDirection,
    clamp(directionDelta, -maximumDirectionDelta, maximumDirectionDelta),
  );

  return {
    x: morphedAnchor.x + direction.x * nodeDistance,
    y: morphedAnchor.y + direction.y * nodeDistance,
  };
}

export type OctoArmMotionGeometry = {
  paths: Record<OctoMotionPhase, string>;
  nodes: Record<OctoMotionPhase, Point>;
};

let cachedProjectedArmGeometry: readonly ProjectedArmGeometry[] | null = null;
let cachedMotionGeometry: readonly OctoArmMotionGeometry[] | null = null;

function getProjectedArmGeometry(): readonly ProjectedArmGeometry[] {
  if (cachedProjectedArmGeometry) {
    return cachedProjectedArmGeometry;
  }

  cachedProjectedArmGeometry = ARM_SPECS.map((armSpec, index) => {
    const canonicalPath = octoMarkGeometry.paths[index + 1];
    const canonicalNode = octoMarkGeometry.circles[index];
    if (!canonicalPath || !canonicalNode) {
      throw new Error(`Missing canonical geometry for Octo arm ${index + 1}`);
    }

    const axisVector = {
      x: canonicalNode.cx - armSpec.root.x,
      y: canonicalNode.cy - armSpec.root.y,
    };
    const nodeDistance = Math.hypot(axisVector.x, axisVector.y);
    const axis = {
      x: axisVector.x / nodeDistance,
      y: axisVector.y / nodeDistance,
    };
    const canonicalPoints = getPathPoints(canonicalPath);
    const distalIndex = canonicalPoints.reduce((closestIndex, point, pointIndex) => {
      const closest = canonicalPoints[closestIndex];
      const closestDistance = Math.hypot(
        closest.x - canonicalNode.cx,
        closest.y - canonicalNode.cy,
      );
      const pointDistance = Math.hypot(
        point.x - canonicalNode.cx,
        point.y - canonicalNode.cy,
      );
      return pointDistance < closestDistance ? pointIndex : closestIndex;
    }, 0);
    const distalAnchor = canonicalPoints[distalIndex];
    const motionLength =
      (distalAnchor.x - armSpec.root.x) * axis.x +
      (distalAnchor.y - armSpec.root.y) * axis.y;

    return {
      canonicalPoints,
      distalIndex,
      spec: {
        ...armSpec,
        axis,
        motionLength,
      },
    };
  });

  return cachedProjectedArmGeometry;
}

export function getOctoArmMotionGeometry(): readonly OctoArmMotionGeometry[] {
  if (cachedMotionGeometry) {
    return cachedMotionGeometry;
  }

  cachedMotionGeometry = getProjectedArmGeometry().map((projected, index) => {
    const canonicalPath = octoMarkGeometry.paths[index + 1];
    const canonicalNode = octoMarkGeometry.circles[index];
    if (!canonicalPath || !canonicalNode) {
      throw new Error(`Missing canonical geometry for Octo arm ${index + 1}`);
    }

    const paths = Object.fromEntries(
      OCTO_MOTION_PHASES.map((phase) => [
        phase,
        morphPath(canonicalPath, projected.spec, POSES[phase]),
      ]),
    ) as Record<OctoMotionPhase, string>;
    const nodeEntries: Array<[OctoMotionPhase, Point]> = [];
    for (const phase of OCTO_MOTION_PHASES) {
      const node = getFollowingNodePosition({
        canonicalNode: { x: canonicalNode.cx, y: canonicalNode.cy },
        canonicalPoints: projected.canonicalPoints,
        distalIndex: projected.distalIndex,
        morphedPoints: getPathPoints(paths[phase]),
      });
      nodeEntries.push([phase, node]);
    }
    const nodes = Object.fromEntries(nodeEntries) as Record<OctoMotionPhase, Point>;

    return { nodes, paths };
  });
  return cachedMotionGeometry;
}

function interpolatePoint(from: OctoScrollPoint, to: OctoScrollPoint, amount: number): Point {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  };
}

function resolveScrollOffset(
  progress: number,
  deformation: OctoScrollArmDeformation,
): Point {
  if (progress <= 0.28) {
    return interpolatePoint(
      deformation.root,
      deformation.proximal,
      smoothstep(progress / 0.28),
    );
  }
  if (progress <= 0.62) {
    return interpolatePoint(
      deformation.proximal,
      deformation.middle,
      smoothstep((progress - 0.28) / 0.34),
    );
  }
  return interpolatePoint(
    deformation.middle,
    deformation.tip,
    smoothstep((progress - 0.62) / 0.38),
  );
}

function isNeutralScrollDeformation(deformation: OctoScrollArmDeformation): boolean {
  return [
    deformation.root,
    deformation.proximal,
    deformation.middle,
    deformation.tip,
  ].every((point) => point.x === 0 && point.y === 0);
}

/**
 * Bends one canonical or thinking-frame tentacle through the shared scroll
 * envelope. The attachment remains exact while the middle and tip trail with
 * progressively more displacement.
 */
export function applyOctoScrollDeformationToPath(
  path: string,
  armIndex: number,
  deformation: OctoScrollArmDeformation,
): string {
  if (isNeutralScrollDeformation(deformation)) {
    return path;
  }
  const projected = getProjectedArmGeometry()[armIndex];
  if (!projected) {
    throw new Error(`Missing canonical geometry for Octo arm ${armIndex + 1}`);
  }

  return warpPath(path, (point) => {
    const fromRoot = {
      x: point.x - projected.spec.root.x,
      y: point.y - projected.spec.root.y,
    };
    const projectedProgress =
      (fromRoot.x * projected.spec.axis.x + fromRoot.y * projected.spec.axis.y) /
      projected.spec.motionLength;
    const progress = clamp((projectedProgress - 0.12) / 0.88, 0, 1);
    if (progress === 0) {
      return point;
    }
    const offset = resolveScrollOffset(progress, deformation);
    return {
      x: point.x + offset.x,
      y: point.y + offset.y,
    };
  }, true);
}

/** Keeps a detached terminal node coupled to the same distal trail as its arm. */
export function applyOctoScrollDeformationToNode(
  node: Point,
  deformation: OctoScrollArmDeformation,
): Point {
  return {
    x: node.x + deformation.tip.x,
    y: node.y + deformation.tip.y,
  };
}

export function formatOctoMotionCoordinate(value: number): string {
  return formatCoordinate(value);
}
