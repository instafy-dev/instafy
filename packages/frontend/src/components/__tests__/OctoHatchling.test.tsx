// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import octoHatchlingsGeometry from "../../assets/octo-hatchlings.geometry.json";
import { HATCHLINGS } from "../../utils/aiFace";
import { OctoHatchling } from "../OctoHatchling";

const FACES = [...HATCHLINGS, "unknown"] as const;

describe("OctoHatchling", () => {
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

  it("draws eight numbered faces and the hollow one, each its own drawing", async () => {
    const drawings = new Set<string>();
    for (const face of FACES) {
      await act(async () => root.render(<OctoHatchling face={face} className="h-3/4 w-3/4" />));
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("data-ai-face")).toBe("hatchling");
      expect(svg?.getAttribute("data-hatchling")).toBe(String(face));
      expect(svg?.getAttribute("viewBox")).toBe("0 0 64 64");
      expect(svg?.getAttribute("class")).toBe("h-3/4 w-3/4");
      const geometry = octoHatchlingsGeometry.faces[face];
      expect(Array.from(container.querySelectorAll("path"), (path) => path.getAttribute("d"))).toEqual(
        geometry.paths.map((path) => path.d),
      );
      expect(
        Array.from(container.querySelectorAll("circle"), (circle) => ["cx", "cy", "r"].map((name) => Number(circle.getAttribute(name)))),
      ).toEqual(geometry.circles.map((circle) => [circle.cx, circle.cy, circle.r]));
      drawings.add(svg!.innerHTML);
    }
    expect(drawings.size).toBe(FACES.length);
  });

  it.each(FACES)("draws face %s in one ink, its dome one even-odd path, with no hooks of Octo's", async (face) => {
    await act(async () => root.render(<OctoHatchling face={face} />));
    const svg = container.querySelector("svg")!;
    // Decorative: the face or the name beside it carries the accessible name.
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("role")).toBe(false);
    // One group in currentColor, and no other colour anywhere.
    const groups = svg.querySelectorAll("g");
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute("fill")).toBe("currentColor");
    expect(svg.querySelectorAll("[stroke], [style], [id], [class]")).toHaveLength(0);
    expect(["style", "id", "class"].filter((name) => svg.hasAttribute(name))).toEqual([]);
    expect(Array.from(svg.querySelectorAll("*"), (element) => element.getAttribute("fill")).filter(Boolean)).toEqual([
      "currentColor",
    ]);
    // The dome is the only even-odd path: the eyes (or the hollow face's
    // inner dome) are holes in it, so the tile shows through.
    const evenOdd = svg.querySelectorAll('path[fill-rule="evenodd"]');
    expect(evenOdd).toHaveLength(1);
    expect(svg.querySelectorAll("path:not([fill-rule])")).toHaveLength(4);
    expect(evenOdd[0].getAttribute("d")?.match(/M/g)).toHaveLength(face === "unknown" ? 2 : 3);
    // One dot of its own, never four; the hollow face has none, only its eyes.
    expect(svg.querySelectorAll("circle")).toHaveLength(face === "unknown" ? 2 : 1);
    // Never Octo: no data-octo-* hooks, no .octo-mark, no motion.
    expect(svg.classList.contains("octo-mark")).toBe(false);
    expect(Array.from(svg.attributes, (attribute) => attribute.name).filter((name) => name.startsWith("data-octo"))).toEqual([]);
    expect(svg.querySelectorAll("animate, animateTransform")).toHaveLength(0);
  });
});
