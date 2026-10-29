// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "../AgentAvatar";
import {
  classTokens,
  expectAiTile,
  expectCanonicalOctoCoin,
  expectHatchling,
} from "./octoCoinExpectations";


describe("AgentAvatar", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    ["sm", "h-7"],
    ["md", "h-9"],
    ["lg", "h-16"],
  ] as const)(
    "draws built-in Octo as its coin, reversed in dark, at %s",
    async (size, height) => {
      // docs/Brand.md: the Octo agent avatar is the same coin everywhere (the
      // profile modal and AI settings once drew a different dark circle).
      await act(async () =>
        root.render(<AgentAvatar agent={{ handle: "octo", avatarSeed: "octo" }} size={size} />));
      const face = container.firstElementChild;
      expectCanonicalOctoCoin(face);
      expect(classTokens(face)).toEqual(expect.arrayContaining(["inline-flex", height]));
    },
  );

  it.each([
    ["the hash of its seed", { handle: "reviewer", displayName: "Reviewer", avatarSeed: "reviewer" }, "3"],
    ["the face it was given", { handle: "reviewer", displayName: "Reviewer", avatarSeed: "hatchling:6" }, "6"],
    // As the controller stamps its rows: the seed, else the id.
    ["the hash of its id when it has no seed", { id: "reviewer-id", handle: "reviewer", displayName: "Reviewer" }, "1"],
  ])("draws another agent as one of Octo's hatchlings on Octo's tile: %s", async (_why, agent, hatchling) => {
    // docs/Brand.md, "Octo's hatchlings": no gradient and no initial, and the
    // tile is Octo's own (light shadow and hairline, only the hairline in dark).
    await act(async () => root.render(<AgentAvatar agent={agent} />));
    const face = container.firstElementChild;
    expect(expectHatchling(face)).toBe(hatchling);
    expect(classTokens(face)).toEqual(expect.arrayContaining(["inline-flex", "h-9", "w-9"]));
    expect(face?.getAttribute("aria-hidden")).toBe("true");
  });

  it("clips an uploaded picture to the AI tile, under its hairline", async () => {
    await act(async () =>
      root.render(<AgentAvatar agent={{ handle: "pia", displayName: "Pia" }} imageSrc="https://images.example/pia.png" size="lg" />));
    const face = container.firstElementChild as HTMLElement | null;
    expect(face?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/pia.png");
    expect(face?.style.backgroundImage).toBe("");
    expect(expectAiTile(face)).toEqual(expect.arrayContaining(["overflow-hidden", "h-16", "w-16"]));
  });

  it("shows the agent's own face behind a picture that fails, or that the editor took away", async () => {
    // A saved picture's agent falls back by its id, as its rows do: agent-pia
    // is 6, where its handle would be 2.
    const agent = { id: "agent-pia", handle: "pia", displayName: "Pia", avatarSeed: "https://images.example/pia.png" };
    await act(async () => root.render(<AgentAvatar agent={agent} imageSrc="blob:https://app.example/preview" />));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:https://app.example/preview");
    await act(async () => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(expectHatchling(container.firstElementChild)).toBe("6");

    await act(async () => root.render(<AgentAvatar agent={agent} imageSrc={null} />));
    expect(container.querySelector("img")).toBeNull();
    expect(expectHatchling(container.firstElementChild)).toBe("6");

    // Octo's editor shows Octo's tile until a picture is chosen.
    await act(async () => root.render(<AgentAvatar agent={{ handle: "octo", avatarSeed: "octo" }} imageSrc={null} size="lg" />));
    expectCanonicalOctoCoin(container.firstElementChild);
  });
});
