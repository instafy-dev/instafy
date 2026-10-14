// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import postcss from "postcss";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { THREAD_SPINE_ERASER_CLASS, ThreadSpine } from "../ThreadSpine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function declarations(css: string, selector: string, media?: string): Record<string, string> {
  const result: Record<string, string> = {};
  postcss.parse(css).walkRules((rule) => {
    const parent = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule) : null;
    if ((media ?? null) !== (parent?.name === "media" ? parent.params : null)) return;
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => {
      result[declaration.prop] = declaration.value;
    });
  });
  return result;
}

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("ThreadSpine notch eraser", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
  });

  it("paints the surface variable, never a fixed palette colour", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 16, bottom: 40, width: 16, height: 40, toJSON: () => ({}),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ThreadSpine tone="primary" notches={[{ maskLine: true }]} />));

    const eraser = host.querySelector('[data-testid="thread-spine"] path[data-thread-spine-eraser]');
    expect(eraser).not.toBeNull();
    expect(eraser!.getAttribute("class")).toBe(THREAD_SPINE_ERASER_CLASS);
    expect(THREAD_SPINE_ERASER_CLASS).toBe("stroke-[var(--thread-spine-surface)]");
    // A hard-coded stroke (the old `stroke-white dark:stroke-slate-950`) drew a
    // near-black strip beside every bend on the charcoal dark surfaces.
    expect(eraser!.getAttribute("class")).not.toMatch(/\b(?:dark:)?stroke-(?:white|black|slate|zinc|gray|neutral|stone)\b/);
    expect(eraser!.getAttribute("stroke")).toBeNull();
  });

  it("does not draw an eraser for notches that do not mask the line", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 16, bottom: 40, width: 16, height: 40, toJSON: () => ({}),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ThreadSpine notches={[{ offsetPx: 9 }]} />));
    expect(host.querySelectorAll("path")).toHaveLength(1);
    expect(host.querySelector("path[data-thread-spine-eraser]")).toBeNull();
  });
});

describe("--thread-spine-surface", () => {
  const tailwindCss = read("../../../../styles/tailwind.css");
  const rowCss = read("../DeferredChatMessageRow.css");

  it("resolves to the transcript's working surface in each theme", () => {
    // Studio's working surface (behind ChatPanel) and the landing demo's
    // workspace are white in light and the dark panel token in dark; the
    // browser spec (thread-spine-surface.spec.ts) proves the rendered pixels.
    expect(declarations(tailwindCss, ":root")["--thread-spine-surface"]).toBe("#ffffff");
    expect(declarations(tailwindCss, ".dark")["--thread-spine-surface"]).toBe("var(--color-studio-dark-panel)");
    expect(declarations(tailwindCss, ":root", "(forced-colors: active)")["--thread-spine-surface"]).toBe("Canvas");
  });

  it("follows the search-highlight tint, composited opaque over the surface", () => {
    const light = declarations(rowCss, '.chat-message-row[data-chat-message-target="true"]');
    const dark = declarations(rowCss, '.dark .chat-message-row[data-chat-message-target="true"]');
    expect(light["--message-target-background"]).toBe("color-mix(in srgb, var(--color-primary-100) 70%, transparent)");
    expect(light["--thread-spine-surface"]).toBe("color-mix(in srgb, var(--color-primary-100) 70%, #ffffff)");
    expect(dark["--message-target-background"]).toBe("color-mix(in srgb, var(--color-primary-500) 20%, transparent)");
    expect(dark["--thread-spine-surface"]).toBe(
      "color-mix(in srgb, var(--color-primary-500) 20%, var(--color-studio-dark-panel))",
    );
    expect(
      declarations(rowCss, '.chat-message-row[data-chat-message-target="true"]', "(forced-colors: active)")[
        "--thread-spine-surface"
      ],
    ).toBe("Canvas");
  });
});
