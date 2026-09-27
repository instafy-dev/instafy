// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "../AgentAvatar";

function classTokens(element: Element | null | undefined): string[] {
  return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

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

  it.each(["sm", "md", "lg"] as const)(
    "keeps built-in Octo a brand-ink mark on a white coin in both themes at %s",
    async (size) => {
      // docs/Brand.md: the Octo agent avatar is the same white coin in light and
      // dark mode. The profile modal and AI settings used to swap it for a dark
      // circle with a light glyph. jsdom cannot resolve dark: variants, so the
      // coin is read from the classes.
      await act(async () =>
        root.render(<AgentAvatar agent={{ handle: "octo", avatarSeed: "octo" }} size={size} />));
      const face = container.firstElementChild;
      const tokens = classTokens(face);
      expect(tokens).toContain("bg-white");
      expect(tokens).toContain("text-brand-ink");
      expect(tokens.filter((token) => token.startsWith("dark:bg-") || token.startsWith("dark:text-")))
        .toEqual([]);
      const mark = face?.querySelector(".octo-mark");
      expect(mark).not.toBeNull();
      expect(classTokens(mark).filter((token) => token.startsWith("dark:"))).toEqual([]);
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
  });
});
