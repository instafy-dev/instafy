import { describe, expect, it } from "vitest";

import octoMarkGeometry from "../../assets/octo-mark.geometry.json";
import {
  OCTO_MOTION_PHASES,
  applyOctoScrollDeformationToNode,
  applyOctoScrollDeformationToPath,
  getOctoArmMotionGeometry,
} from "../octoMarkMotionGeometry";
import {
  DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG,
  type OctoScrollArmDeformation,
} from "../octoScrollPhysics";

const octoArmMotionGeometry = getOctoArmMotionGeometry();

const NUMBER_TOKEN = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

function pathNumbers(path: string): number[] {
  return (path.match(NUMBER_TOKEN) ?? []).map(Number);
}

function pathPoints(path: string): Array<{ x: number; y: number }> {
  const numbers = pathNumbers(path);
  return Array.from({ length: numbers.length / 2 }, (_, index) => ({
    x: numbers[index * 2],
    y: numbers[index * 2 + 1],
  }));
}

function commandSignature(path: string): string {
  return (path.match(/[A-Za-z]/g) ?? []).join("");
}

describe("Octo thinking motion geometry", () => {
  it("keeps every morph frame compatible with its canonical M/C/Z path", () => {
    octoArmMotionGeometry.forEach((arm, index) => {
      const canonicalPath = octoMarkGeometry.paths[index + 1];
      const canonicalNumbers = pathNumbers(canonicalPath);

      for (const phase of OCTO_MOTION_PHASES) {
        const phasePath = arm.paths[phase];
        expect(commandSignature(phasePath)).toBe(commandSignature(canonicalPath));
        expect(pathNumbers(phasePath)).toHaveLength(canonicalNumbers.length);
        expect(pathNumbers(phasePath).slice(0, 2)).toEqual(canonicalNumbers.slice(0, 2));
        expect(pathNumbers(phasePath).slice(-2)).toEqual(canonicalNumbers.slice(-2));
      }
    });
  });

  it("swings every detached node through a visible terminal arc", () => {
    octoArmMotionGeometry.forEach((arm, index) => {
      const canonicalNode = octoMarkGeometry.circles[index];
      const canonicalPoints = pathPoints(octoMarkGeometry.paths[index + 1]);
      const distalIndex = canonicalPoints.reduce(
        (closestIndex, point, pointIndex) =>
          Math.hypot(point.x - canonicalNode.cx, point.y - canonicalNode.cy) <
          Math.hypot(
            canonicalPoints[closestIndex].x - canonicalNode.cx,
            canonicalPoints[closestIndex].y - canonicalNode.cy,
          )
            ? pointIndex
            : closestIndex,
        0,
      );
      const angles = OCTO_MOTION_PHASES.map((phase) => {
        const distalPoint = pathPoints(arm.paths[phase])[distalIndex];
        const node = arm.nodes[phase];
        return Math.atan2(node.y - distalPoint.y, node.x - distalPoint.x);
      });
      const horizontalPositions = OCTO_MOTION_PHASES.map((phase) => arm.nodes[phase].x);

      expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.14);
      expect(Math.max(...horizontalPositions) - Math.min(...horizontalPositions)).toBeGreaterThan(
        2,
      );
    });
  });

  it("uses distinct bend geometry across every propulsion phase", () => {
    for (const arm of octoArmMotionGeometry) {
      expect(new Set(OCTO_MOTION_PHASES.map((phase) => arm.paths[phase])).size).toBe(
        OCTO_MOTION_PHASES.length,
      );
    }
  });

  it("uses one outward catch followed by a downward inward contraction", () => {
    octoArmMotionGeometry.forEach((arm, index) => {
      const canonicalNode = octoMarkGeometry.circles[index];
      const outwardDirection = index < 2 ? -1 : 1;
      const catchOutwardTravel =
        (arm.nodes.catch.x - canonicalNode.cx) * outwardDirection;
      const contractionInwardTravel =
        (arm.nodes.contract.x - arm.nodes.catch.x) * -outwardDirection;
      const recoverDistance = Math.hypot(
        arm.nodes.recover.x - canonicalNode.cx,
        arm.nodes.recover.y - canonicalNode.cy,
      );
      const contractionDistance = Math.hypot(
        arm.nodes.contract.x - canonicalNode.cx,
        arm.nodes.contract.y - canonicalNode.cy,
      );

      expect(catchOutwardTravel).toBeGreaterThan(3);
      expect(contractionInwardTravel).toBeGreaterThan(6);
      expect(arm.nodes.contract.y - arm.nodes.catch.y).toBeGreaterThan(2);
      expect(recoverDistance).toBeLessThan(contractionDistance);
    });
  });

  it("keeps every detached node tied to its distal tentacle point", () => {
    octoArmMotionGeometry.forEach((arm, index) => {
      const canonicalNode = octoMarkGeometry.circles[index];
      const canonicalPoints = pathPoints(octoMarkGeometry.paths[index + 1]);
      const distalIndex = canonicalPoints.reduce(
        (closestIndex, point, pointIndex) =>
          Math.hypot(point.x - canonicalNode.cx, point.y - canonicalNode.cy) <
          Math.hypot(
            canonicalPoints[closestIndex].x - canonicalNode.cx,
            canonicalPoints[closestIndex].y - canonicalNode.cy,
          )
            ? pointIndex
            : closestIndex,
        0,
      );
      const canonicalGap = Math.hypot(
        canonicalPoints[distalIndex].x - canonicalNode.cx,
        canonicalPoints[distalIndex].y - canonicalNode.cy,
      );

      for (const phase of OCTO_MOTION_PHASES) {
        const distalPoint = pathPoints(arm.paths[phase])[distalIndex];
        const node = arm.nodes[phase];
        expect(Math.hypot(distalPoint.x - node.x, distalPoint.y - node.y)).toBeCloseTo(
          canonicalGap,
          2,
        );
      }
    });
  });
});

describe("Octo scroll motion geometry", () => {
  const deformation: OctoScrollArmDeformation = {
    root: { x: 0, y: 0 },
    proximal: { x: -0.1, y: 0.7 },
    middle: { x: -0.35, y: 2.4 },
    tip: { x: -0.65, y: 5 },
  };

  it("keeps both attachment coordinates exact while the distal arm trails", () => {
    octoMarkGeometry.paths.slice(1).forEach((canonicalPath, armIndex) => {
      const warpedPath = applyOctoScrollDeformationToPath(
        canonicalPath,
        armIndex,
        deformation,
      );
      const canonicalNumbers = pathNumbers(canonicalPath);
      const warpedNumbers = pathNumbers(warpedPath);

      expect(commandSignature(warpedPath)).toBe(commandSignature(canonicalPath));
      expect(warpedNumbers).toHaveLength(canonicalNumbers.length);
      expect(warpedNumbers.slice(0, 2)).toEqual(canonicalNumbers.slice(0, 2));
      expect(warpedNumbers.slice(-2)).toEqual(canonicalNumbers.slice(-2));

      const canonicalNode = octoMarkGeometry.circles[armIndex];
      const canonicalPoints = pathPoints(canonicalPath);
      const warpedPoints = pathPoints(warpedPath);
      const distalIndex = canonicalPoints.reduce(
        (closestIndex, point, pointIndex) =>
          Math.hypot(point.x - canonicalNode.cx, point.y - canonicalNode.cy) <
          Math.hypot(
            canonicalPoints[closestIndex].x - canonicalNode.cx,
            canonicalPoints[closestIndex].y - canonicalNode.cy,
          )
            ? pointIndex
            : closestIndex,
        0,
      );
      expect(warpedPoints[distalIndex].x - canonicalPoints[distalIndex].x).toBeCloseTo(
        deformation.tip.x,
        2,
      );
      expect(warpedPoints[distalIndex].y - canonicalPoints[distalIndex].y).toBeCloseTo(
        deformation.tip.y,
        2,
      );
    });
  });

  it("moves detached terminal nodes with the same distal envelope", () => {
    octoMarkGeometry.circles.forEach((node) => {
      expect(
        applyOctoScrollDeformationToNode({ x: node.cx, y: node.cy }, deformation),
      ).toEqual({
        x: node.cx + deformation.tip.x,
        y: node.cy + deformation.tip.y,
      });
    });
  });

  it("returns the canonical path byte-for-byte for a neutral envelope", () => {
    const neutral: OctoScrollArmDeformation = {
      root: { x: 0, y: 0 },
      proximal: { x: 0, y: 0 },
      middle: { x: 0, y: 0 },
      tip: { x: 0, y: 0 },
    };
    octoMarkGeometry.paths.slice(1).forEach((canonicalPath, armIndex) => {
      expect(
        applyOctoScrollDeformationToPath(canonicalPath, armIndex, neutral),
      ).toBe(canonicalPath);
    });
  });

  it("keeps the maximum scroll-driven pose inside the fixed viewBox", () => {
    const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] = octoMarkGeometry.viewBox
      .split(/\s+/)
      .map(Number);
    const [translateX, translateY] = pathNumbers(octoMarkGeometry.transform);
    const maximum = DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG.maxTipOffsetSvg;
    const lateralCouplings = [-0.085, -0.035, 0.035, 0.085] as const;
    const proximalWeights = [0.13, 0.15, 0.14, 0.12] as const;
    const middleWeights = [0.48, 0.53, 0.51, 0.46] as const;
    const swimmerYRange = { minimum: -0.65, maximum: 0.1 };

    for (const direction of [-1, 1] as const) {
      octoArmMotionGeometry.forEach((_, armIndex) => {
        const scalarOffset = direction * maximum;
        const tip = {
          x: scalarOffset * lateralCouplings[armIndex],
          y: scalarOffset,
        };
        const maximumDeformation: OctoScrollArmDeformation = {
          root: { x: 0, y: 0 },
          proximal: {
            x: tip.x * proximalWeights[armIndex],
            y: tip.y * proximalWeights[armIndex],
          },
          middle: {
            x: tip.x * middleWeights[armIndex],
            y: tip.y * middleWeights[armIndex],
          },
          tip,
        };

        const warpedPath = applyOctoScrollDeformationToPath(
          octoMarkGeometry.paths[armIndex + 1],
          armIndex,
          maximumDeformation,
        );
        for (const point of pathPoints(warpedPath)) {
          expect(point.x + translateX).toBeGreaterThanOrEqual(viewBoxX);
          expect(point.x + translateX).toBeLessThanOrEqual(viewBoxX + viewBoxWidth);
          expect(point.y + translateY + swimmerYRange.minimum).toBeGreaterThanOrEqual(
            viewBoxY,
          );
          expect(point.y + translateY + swimmerYRange.maximum).toBeLessThanOrEqual(
            viewBoxY + viewBoxHeight,
          );
        }

        const canonicalNode = octoMarkGeometry.circles[armIndex];
        const node = applyOctoScrollDeformationToNode(
          { x: canonicalNode.cx, y: canonicalNode.cy },
          maximumDeformation,
        );
        const radius = canonicalNode.r;
        expect(node.x + translateX - radius).toBeGreaterThanOrEqual(viewBoxX);
        expect(node.x + translateX + radius).toBeLessThanOrEqual(
          viewBoxX + viewBoxWidth,
        );
        expect(node.y + translateY + swimmerYRange.minimum - radius).toBeGreaterThanOrEqual(
          viewBoxY,
        );
        expect(node.y + translateY + swimmerYRange.maximum + radius).toBeLessThanOrEqual(
          viewBoxY + viewBoxHeight,
        );
      });
    }
  });
});
