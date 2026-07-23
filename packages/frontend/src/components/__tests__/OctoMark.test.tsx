// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import octoMarkGeometry from "../../assets/octo-mark.geometry.json";
import { OctoMark } from "../OctoMark";
import { OCTO_MOTION_PHASES } from "../octoMarkMotionGeometry";

describe("OctoMark", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the canonical geometry in the exact idle pose by default", async () => {
    await act(async () => {
      root.render(<OctoMark title="Instafy" />);
    });

    const mark = container.querySelector("svg");
    expect(mark?.getAttribute("data-octo-motion")).toBe("idle");
    expect(mark?.getAttribute("aria-label")).toBe("Instafy");
    expect(
      Array.from(container.querySelectorAll("path"), (path) => path.getAttribute("d")),
    ).toEqual(octoMarkGeometry.paths);
    expect(container.querySelectorAll('[data-octo-part="body"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-octo-part="tentacle"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-octo-part="node"]')).toHaveLength(4);
  });

  it("opts into thinking motion without changing the underlying paths", async () => {
    await act(async () => {
      root.render(<OctoMark motion="thinking" />);
    });

    expect(container.querySelector("svg")?.getAttribute("data-octo-motion")).toBe("thinking");
    expect(container.querySelector("svg")?.getAttribute("data-octo-animated")).toBe("true");
    expect(container.querySelectorAll('animate[data-octo-animation="tentacle"]')).toHaveLength(
      4,
    );
    expect(
      container.querySelectorAll('animateTransform[data-octo-animation="node"]'),
    ).toHaveLength(4);
    for (let arm = 1; arm <= 4; arm += 1) {
      const tentacle = container.querySelector(
        `[data-octo-part="tentacle"][data-octo-arm="${arm}"]`,
      );
      const node = container.querySelector(
        `[data-octo-part="node"][data-octo-arm="${arm}"]`,
      );
      expect(tentacle).not.toBeNull();
      expect(node).not.toBeNull();

      const pathAnimation = tentacle?.querySelector("animate");
      const nodeAnimation = node?.querySelector("animateTransform");
      const pathFrames = pathAnimation?.getAttribute("values")?.split(";") ?? [];
      const nodeFrames = nodeAnimation?.getAttribute("values")?.split(";") ?? [];
      expect(pathFrames).toHaveLength(OCTO_MOTION_PHASES.length + 2);
      expect(pathFrames[0]).toBe(octoMarkGeometry.paths[arm]);
      expect(pathFrames.at(-1)).toBe(octoMarkGeometry.paths[arm]);
      expect(nodeFrames).toHaveLength(OCTO_MOTION_PHASES.length + 2);
      expect(nodeFrames[0]).toBe("0 0");
      expect(nodeFrames.at(-1)).toBe("0 0");
      expect(nodeAnimation?.getAttribute("begin")).toBe(
        pathAnimation?.getAttribute("begin"),
      );
    }

    await act(async () => {
      root.render(<OctoMark motion="idle" />);
    });
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
    expect(
      Array.from(container.querySelectorAll("path"), (path) => path.getAttribute("d")),
    ).toEqual(octoMarkGeometry.paths);
  });
});
