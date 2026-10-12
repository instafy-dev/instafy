// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OCTO_COIN_CLASS, OCTO_COIN_MARK_CLASS, OctoCoin } from "../OctoCoin";
import { classTokens, expectCanonicalOctoCoin } from "./octoCoinExpectations";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../styles/tailwind.css"), "utf8");

describe("OctoCoin", () => {
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

  it("is a white coin with the shared coin shadow in light and the reverse coin in dark, in one ink", async () => {
    await act(async () => root.render(<OctoCoin className="h-8 w-8" testId="coin" />));
    const coin = container.querySelector('[data-testid="coin"]');
    expectCanonicalOctoCoin(coin);
    expect(classTokens(coin)).toEqual(expect.arrayContaining(["flex", "rounded-full", "h-8", "w-8"]));
    // The coin is not positioned and has no ::after, so in an overlapping
    // stack tree order decides which face covers which.
    expect(OCTO_COIN_CLASS.split(" ")).toEqual(expect.arrayContaining(["overflow-hidden", "rounded-full"]));
    expect(OCTO_COIN_CLASS.split(" ").filter((token) => /^(relative|absolute|after:)/.test(token))).toEqual([]);
    // The mark fills 75% of the coin.
    expect(OCTO_COIN_MARK_CLASS.split(" ")).toEqual(expect.arrayContaining(["h-3/4", "w-3/4"]));
    expect(coin?.querySelector("svg")?.getAttribute("aria-label")).toBe("Octo");
  });

  it("keeps its tokens: #262626 coin and a 22% white ring in dark", () => {
    expect(css).toMatch(/--color-octo-coin-dark:\s*#262626;/);
    expect(css).toMatch(/--color-octo-coin-ring-dark:\s*rgb\(255 255 255 \/ 0\.22\);/);
  });

  it("takes its light edge from the one avatar coin shadow, which is empty in dark", () => {
    // shadow-avatar-coin reads --avatar-coin-shadow: a faint all-round
    // hairline and a soft short drop in light, nothing in dark.
    expect(css).toMatch(/--shadow-avatar-coin:\s*var\(--avatar-coin-shadow\);/);
    const light = css.match(/:root\s*\{[^}]*--avatar-coin-shadow:\s*([^;]+);/)?.[1].replace(/\s+/g, " ");
    expect(light).toBe(
      "0 0 0 1px rgb(15 23 42 / 0.06), 0 1px 2px rgb(15 23 42 / 0.12), 0 2px 6px -1px rgb(15 23 42 / 0.1)",
    );
    expect(css).toMatch(/\.dark\s*\{[^}]*--avatar-coin-shadow:\s*0 0 #0000;/);
  });

  it("passes motion and scroll reaction to the mark and stays one ink while thinking", async () => {
    await act(async () => root.render(<OctoCoin inline motion="thinking" scrollReactive title="Octo is thinking" />));
    const coin = container.querySelector("[data-octo-coin]");
    const mark = expectCanonicalOctoCoin(coin);
    expect(classTokens(coin)).toContain("inline-flex");
    expect(classTokens(coin)).not.toContain("flex");
    expect(mark.getAttribute("data-octo-motion")).toBe("thinking");
    expect(mark.getAttribute("data-octo-scroll-reactive")).toBe("true");
    expect(mark.getAttribute("aria-label")).toBe("Octo is thinking");
  });

  it("carries the caller's data attributes on the coin itself", async () => {
    await act(async () => root.render(<OctoCoin data-landing-octo-pop="" />));
    expect(container.querySelector("[data-octo-coin]")?.hasAttribute("data-landing-octo-pop")).toBe(true);
  });
});
