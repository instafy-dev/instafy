// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiFaceIdentity } from "../../utils/aiFace";
import { AiFace } from "../AiFace";
import { OCTO_COIN_MARK_CLASS } from "../OctoCoin";
import {
  classTokens,
  expectAiTile,
  expectAvatarCoinLightEdge,
  expectCanonicalOctoCoin,
  expectHatchlingTile,
} from "./octoCoinExpectations";

const PIA_ID = "3f6c1f0e-8a1b-4c55-9d1e-2b7a6c9e4f10";
const IDENTITIES = {
  octo: { handle: "octo", avatarSeed: "octo" },
  stamped: { handle: "reading_list", avatarSeed: "hatchling:3" },
  // A helper stamped before the controller gave faces: the hash of its handle (pia is 2).
  legacy: { handle: "pia", avatarSeed: "pia" },
  textOnly: { handle: "ben", textOnly: true },
  // A saved agent whose picture is its seed: behind it, the hash of its id (4).
  picture: { handle: "pia", agentId: PIA_ID, avatarSeed: "https://images.example/pia.png" },
} satisfies Record<string, AiFaceIdentity>;

describe("AiFace", () => {
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

  const face = () => container.querySelector('[data-testid="face"]');

  it("draws Octo as its coin, the only face that takes motion", async () => {
    await act(async () =>
      root.render(<AiFace identity={IDENTITIES.octo} className="h-8 w-8" motion="thinking" scrollReactive testId="face" />));
    const mark = expectCanonicalOctoCoin(face());
    expect(classTokens(face())).toEqual(expect.arrayContaining(["flex", "h-8", "w-8"]));
    expect(mark.getAttribute("data-octo-motion")).toBe("thinking");
    expect(mark.getAttribute("data-octo-scroll-reactive")).toBe("true");
  });

  it.each([
    ["a stamped helper", IDENTITIES.stamped, "3"],
    ["a helper from before stamps", IDENTITIES.legacy, "2"],
    ["an AI known only from text", IDENTITIES.textOnly, "unknown"],
  ] as const)("puts %s on Octo's tile as a still hatchling at 75%%", async (_who, identity, hatchling) => {
    await act(async () =>
      root.render(<AiFace identity={identity} className="h-8 w-8" motion="thinking" scrollReactive testId="face" />));
    const tile = face();
    expectHatchlingTile(tile);
    expect(classTokens(tile)).toEqual(expect.arrayContaining(["flex", "h-8", "w-8"]));
    const drawing = tile?.querySelector(':scope > svg[data-ai-face="hatchling"]');
    expect(drawing?.getAttribute("data-hatchling")).toBe(hatchling);
    expect(classTokens(drawing)).toEqual(OCTO_COIN_MARK_CLASS.split(" "));
    // Only Octo moves.
    expect(tile?.querySelectorAll("animate, animateTransform")).toHaveLength(0);
    expect(tile?.querySelector("[data-octo-motion]")).toBeNull();
  });

  it("clips a picture to the same tile, and shows the face behind it when it fails to load", async () => {
    await act(async () => root.render(<AiFace identity={IDENTITIES.picture} className="h-12 w-12" testId="face" />));
    const img = face()?.querySelector(":scope > img");
    expect(img?.getAttribute("src")).toBe("https://images.example/pia.png");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("onerror")).toBeNull();
    expectHatchlingTile(face());
    expect(classTokens(face())).toEqual(expect.arrayContaining(["h-12", "w-12"]));
    expect(face()?.querySelector("svg")).toBeNull();

    // Never a broken image: the fallback is the hatchling its id hashes to.
    await act(async () => { img!.dispatchEvent(new Event("error")); });
    expect(face()?.querySelector("img")).toBeNull();
    expectHatchlingTile(face());
    expect(face()?.querySelector(':scope > svg[data-ai-face="hatchling"]')?.getAttribute("data-hatchling")).toBe("4");

    // A new picture is tried again.
    await act(async () =>
      root.render(<AiFace identity={{ ...IDENTITIES.picture, avatarUrl: "https://images.example/pia-2.png" }} testId="face" />));
    expect(face()?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/pia-2.png");
  });

  it("falls back to Octo's coin when Octo's own picture fails", async () => {
    await act(async () =>
      root.render(<AiFace identity={{ handle: "octo", avatarSeed: "/octo.png" }} motion="thinking" testId="face" />));
    expect(face()?.hasAttribute("data-octo-coin")).toBe(false);
    await act(async () => { face()!.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(expectCanonicalOctoCoin(face()).getAttribute("data-octo-motion")).toBe("thinking");
  });

  it("encodes a picture's address at the rendering boundary, and draws the fallback for one it cannot load", async () => {
    await act(async () => root.render(<AiFace identity={{ handle: "pia", avatarUrl: "https://images.example/my pia.png" }} testId="face" />));
    expect(face()?.querySelector("img")?.getAttribute("src")).toBe("https://images.example/my%20pia.png");
    await act(async () => root.render(<AiFace identity={{ handle: "pia", avatarUrl: "https://images.example/\ud800.png" }} testId="face" />));
    expect(face()?.querySelector("img")).toBeNull();
    expect(face()?.querySelector("svg")?.getAttribute("data-hatchling")).toBe("2");
  });

  it("draws a face it is given, such as an upload preview or a picker's choice", async () => {
    await act(async () =>
      root.render(<AiFace face={{ kind: "picture", src: "blob:https://app.example/preview", fallback: { kind: "unknown" } }} testId="face" />));
    expect(face()?.querySelector("img")?.getAttribute("src")).toBe("blob:https://app.example/preview");
    await act(async () => root.render(<AiFace face={{ kind: "hatchling", n: 8, reason: "stamp" }} inline testId="face" />));
    expect(face()?.querySelector("svg")?.getAttribute("data-hatchling")).toBe("8");
    expect(classTokens(face())).toContain("inline-flex");
    expect(classTokens(face())).not.toContain("flex");
  });

  it.each([
    ["octo", IDENTITIES.octo],
    ["picture", IDENTITIES.picture],
    ["hatchling", IDENTITIES.stamped],
    ["unknown", IDENTITIES.textOnly],
  ] as const)("is the tile itself for %s, so a stack's ring lands on it", async (_kind, identity) => {
    // The roster's and typing row's slot: the separator ring on each face.
    await act(async () =>
      root.render(<span className="rounded-[30%] *:ring-1 *:ring-white"><AiFace identity={identity} className="h-6 w-6" /></span>));
    const tile = container.firstElementChild!.firstElementChild;
    expect(container.firstElementChild!.childElementCount).toBe(1);
    expectAiTile(tile);
    expectAvatarCoinLightEdge(tile);
    expect(classTokens(tile)).toEqual(expect.arrayContaining(["h-6", "w-6"]));
  });

  it.each([
    ["2xs chat face and the roster", "h-6 w-6"],
    ["xs chat face and a small agent avatar", "h-7 w-7"],
    ["sm chat face", "h-8 w-8"],
    ["md agent avatar", "h-9 w-9"],
    ["lg chat face", "h-12 w-12"],
    ["lg agent avatar", "h-16 w-16"],
    ["branch stack slot", "h-full w-full"],
  ])("takes its size from the caller: %s", async (_where, size) => {
    for (const identity of [IDENTITIES.octo, IDENTITIES.stamped]) {
      await act(async () => root.render(<AiFace identity={identity} className={size} testId="face" />));
      expect(classTokens(face())).toEqual(expect.arrayContaining(size.split(" ")));
    }
  });

  it("is decorative beside a printed name, and an image named for its AI where it stands alone", async () => {
    for (const identity of [IDENTITIES.octo, IDENTITIES.stamped, IDENTITIES.picture]) {
      await act(async () => root.render(<AiFace identity={identity} testId="face" />));
      expect(face()?.getAttribute("aria-hidden")).toBe("true");
      expect(face()?.hasAttribute("role")).toBe(false);
      expect(face()?.hasAttribute("aria-label")).toBe(false);

      await act(async () => root.render(<AiFace identity={identity} label=" @pia " testId="face" />));
      expect(face()?.hasAttribute("aria-hidden")).toBe(false);
      expect(face()?.getAttribute("role")).toBe("img");
      expect(face()?.getAttribute("aria-label")).toBe("@pia, AI");
    }
  });

  it("carries the caller's data attributes on the tile", async () => {
    for (const identity of [IDENTITIES.octo, IDENTITIES.stamped, IDENTITIES.picture]) {
      await act(async () => root.render(<AiFace identity={identity} data-landing-agent="" testId="face" />));
      expect(face()?.hasAttribute("data-landing-agent")).toBe(true);
    }
  });
});
