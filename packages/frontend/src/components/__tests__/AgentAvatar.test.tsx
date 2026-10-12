// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "../AgentAvatar";
import { classTokens, expectAvatarCoinLightEdge, expectCanonicalOctoCoin } from "./octoCoinExpectations";


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

  it("leaves other agents on their generated face", async () => {
    await act(async () =>
      root.render(<AgentAvatar agent={{ handle: "reviewer", displayName: "Reviewer", avatarSeed: "reviewer" }} />));
    const face = container.firstElementChild as HTMLElement | null;
    expect(face?.querySelector(".octo-mark")).toBeNull();
    expect(face?.textContent).toBe("R");
    expect(face?.style.backgroundImage).toContain("linear-gradient");
    expect(classTokens(face)).not.toContain("bg-white");
    // The same light edge as Octo's coin; no edge in dark, as before.
    const tokens = expectAvatarCoinLightEdge(face);
    expect(tokens.filter((token) => token.startsWith("dark:"))).toEqual([]);
  });
});
