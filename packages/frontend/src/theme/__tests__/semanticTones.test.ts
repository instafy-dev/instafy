import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { STUDIO_MENU_ARIA_ROW_CLASS, STUDIO_MENU_NATIVE_ROW_CLASS } from "../../components/aria/studioMenuStyles";
import { Badge } from "../../components/Badge";
import { iconButtonStyles } from "../../components/Button";
import { EntityRow } from "../../components/EntityRow";
import { TextLink } from "../../components/TextLink";
import { StatusPill } from "../../screens/studio/components/StatusPill";
import { SEMANTIC_TONE_CLASSES, type SemanticTone } from "../semanticTones";

// Every semantic tone must read in both themes, measured from the theme tokens
// themselves: WCAG 1.4.3 asks 4.5:1 of text and 1.4.11 asks 3:1 of a meaningful
// icon. Each pair is checked on the tone's own surface and bare, over the white
// panel and the slate-50 rail in light, and over the dark canvas, rail, panel
// and floating greys in dark.

type Mode = "light" | "dark";
type Oklch = { l: number; c: number; h: number };
type Rgb = [number, number, number];
type Paint = { rgb: Rgb; alpha: number };

const here = dirname(fileURLToPath(import.meta.url));
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const appCss = withoutComments(readFileSync(resolve(here, "../../styles/tailwind.css"), "utf8"));
const paletteCss = withoutComments(readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8"));

function colorDeclarations(css: string): Map<string, string> {
  return new Map([...css.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

function appBlocks(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...appCss.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]).join("\n");
}

// Tailwind's palette (rose, emerald), the app's @theme over it, and in dark
// the .dark overrides that re-point the primary and secondary ramps.
const TOKENS: Record<Mode, Map<string, string>> = (() => {
  const light = new Map([...colorDeclarations(paletteCss), ...colorDeclarations(appBlocks("@theme"))]);
  return { light, dark: new Map([...light, ...colorDeclarations(appBlocks(".dark"))]) };
})();

const toLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const toGamma = (value: number) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);

function hexToOklch(hex: string): Oklch {
  const [r, g, b] = [1, 3, 5].map((offset) => toLinear(parseInt(hex.slice(offset, offset + 2), 16) / 255));
  const [l, m, s] = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, c: Math.hypot(a, bAxis), h: (Math.atan2(bAxis, a) * 180) / Math.PI };
}

// Clipped to sRGB, as a wide-gamut token is painted on an sRGB screen.
function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const [lc, mc, sc] = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((value) => value ** 3);
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ].map((value) => Math.min(1, Math.max(0, toGamma(value)))) as Rgb;
}

function resolveColor(mode: Mode, value: string): Oklch {
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference) {
    const next = TOKENS[mode].get(reference[1]);
    if (!next) throw new Error(`${reference[1]} is not defined`);
    return resolveColor(mode, next);
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return hexToOklch(value);
  const oklch = /^oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (oklch) return { l: Number(oklch[1]) / (oklch[2] ? 100 : 1), c: Number(oklch[3]), h: Number(oklch[4]) };
  // White and black have no hue, so the mix keeps the base hue while its
  // lightness and chroma move toward the achromatic end.
  const mix = /^color-mix\(in oklch, (.+), (white|black) ([\d.]+)%\)$/.exec(value);
  if (mix) {
    const base = resolveColor(mode, mix[1]);
    const weight = Number(mix[3]) / 100;
    return { l: base.l * (1 - weight) + (mix[2] === "white" ? weight : 0), c: base.c * (1 - weight), h: base.h };
  }
  throw new Error(`Unsupported colour value: ${value}`);
}

const token = (mode: Mode, name: string) => oklchToRgb(resolveColor(mode, `var(--color-${name})`));

function paint(mode: Mode, classes: string, utility: "text" | "bg"): Paint {
  const prefix = mode === "dark" ? "dark:" : "";
  const pattern = new RegExp(`^${prefix}${utility}-([a-z]+-\\d+)(?:/(\\d+))?$`);
  const match = classes.split(" ").map((name) => pattern.exec(name)).find(Boolean);
  if (!match) throw new Error(`No ${prefix}${utility}- colour in "${classes}"`);
  return { rgb: token(mode, match[1]), alpha: match[2] ? Number(match[2]) / 100 : 1 };
}

const over = (top: Paint, below: Rgb) => top.rgb.map((value, index) => top.alpha * value + (1 - top.alpha) * below[index]) as Rgb;
const luminance = ([r, g, b]: Rgb) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const BACKDROPS: Record<Mode, Record<string, Rgb>> = {
  light: { "white panel": [1, 1, 1], "slate-50 rail": token("light", "slate-50") },
  dark: Object.fromEntries(
    ["canvas", "rail", "panel", "floating"].map((name) => [`dark ${name}`, token("dark", `studio-dark-${name}`)]),
  ),
};

// A row under the pointer, a machine's row and its status chip among them:
// slate-100 in light, and in dark the control hover, white at 9%, over the
// ground below it (the list rows' rail hover is fainter).
function hoveredRow(mode: Mode, below: Rgb): Rgb {
  if (mode === "light") return token("light", "slate-100");
  const value = TOKENS.dark.get("--color-studio-dark-control-hover") ?? "";
  const rgba = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value);
  if (!rgba) throw new Error(`Unsupported hover colour: ${value}`);
  const fill: Paint = { rgb: [rgba[1], rgba[2], rgba[3]].map((channel) => Number(channel) / 255) as Rgb, alpha: Number(rgba[4]) };
  return over(fill, below);
}

describe("semantic tone contrast", () => {
  it("measures the theme the way the round-one audit did", () => {
    const rail = BACKDROPS.light["slate-50 rail"];
    expect(contrast(token("light", "slate-400"), rail)).toBeCloseTo(2.06, 1);
    expect(contrast(token("light", "slate-600"), rail)).toBeCloseTo(4.65, 1);
    const warningSurface = over(paint("light", SEMANTIC_TONE_CLASSES.warning.surface, "bg"), rail);
    expect(contrast(token("light", "secondary-700"), warningSurface)).toBeCloseTo(3.99, 1);
  });

  it("reproduces the hovered-row figures behind dark danger text", () => {
    // A danger chip on a hovered row: rose-400 read 4.25:1 over the panel and
    // 3.81:1 over the floating grey, where rose-300 reads 6.33 and 5.66:1.
    const surface = paint("dark", SEMANTIC_TONE_CLASSES.danger.surface, "bg");
    for (const [name, before, after] of [["panel", 4.25, 6.33], ["floating", 3.81, 5.66]] as const) {
      const chip = over(surface, hoveredRow("dark", BACKDROPS.dark[`dark ${name}`]));
      expect(contrast(token("dark", "rose-400"), chip)).toBeCloseTo(before, 1);
      expect(contrast(token("dark", "rose-300"), chip)).toBeCloseTo(after, 1);
    }
  });

  it.each(["light", "dark"] as const)("reads in %s: text at 4.5:1 and the icon at 3:1, on the tone's surface and bare, at rest and hovered", (mode) => {
    const short: string[] = [];
    for (const tone of Object.keys(SEMANTIC_TONE_CLASSES) as SemanticTone[]) {
      const classes = SEMANTIC_TONE_CLASSES[tone];
      const surface = paint(mode, classes.surface, "bg");
      for (const [backdropName, backdrop] of Object.entries(BACKDROPS[mode])) {
        const row = hoveredRow(mode, backdrop);
        for (const [ground, background] of [
          ["on its surface", over(surface, backdrop)],
          ["bare", backdrop],
          ["on its surface on a hovered row", over(surface, row)],
          ["bare on a hovered row", row],
        ] as const) {
          for (const [part, minimum] of [["text", 4.5], ["icon", 3]] as const) {
            const ratio = contrast(paint(mode, classes[part], "text").rgb, background);
            if (ratio < minimum) short.push(`${tone} ${part} ${ground} over the ${backdropName}: ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
    expect(short).toEqual([]);
  });
});

// Colour pairs outside the tones above, each read from the code that draws it:
// every Badge tone (a machine's status chip among them), every StatusPill tone,
// the quiet danger Button, the danger TextLink, the danger row in Settings
// navigation, and sand text in chat and on the landing page. Each is also
// measured on a selected or hovered row: slate-100 in light, and in dark the
// active grey and the control hover over each ground.

type State =
  | "rest"
  | "hover"
  | "data-[pressed]"
  | "data-[hovered]"
  | "data-[focused]"
  | "not-disabled:hover"
  | "not-disabled:active";

const GROUNDS: Record<Mode, Record<string, Rgb>> = {
  light: { ...BACKDROPS.light, "slate-100 row": token("light", "slate-100") },
  dark: {
    ...BACKDROPS.dark,
    "dark active row": token("dark", "studio-dark-active"),
    ...Object.fromEntries(Object.entries(BACKDROPS.dark).map(([name, ground]) => [`hovered row on the ${name}`, hoveredRow("dark", ground)])),
  },
};

// The colour one utility paints in a mode and state, or null for none. A state
// without a class of its own keeps the rest colour.
function layer(mode: Mode, classes: string, utility: "text" | "bg", state: State): Paint | null {
  const theme = mode === "dark" ? "dark:" : "";
  const pattern = new RegExp(`^${utility}-([a-z]+-\\d+)(?:/(\\d+)|/\\[([\\d.]+)\\])?$`);
  for (const prefix of state === "rest" ? [theme] : [`${theme}${state}:`, theme]) {
    for (const name of classes.split(/\s+/)) {
      // A leading ! (important) paints the same colour.
      const match = name.startsWith(prefix) ? pattern.exec(name.slice(prefix.length).replace(/^!/, "")) : null;
      if (match) return { rgb: token(mode, match[1]), alpha: match[2] ? Number(match[2]) / 100 : Number(match[3] ?? 1) };
    }
  }
  // A light class with no dark one still paints in dark, from the dark tokens:
  // every pair measured here names its dark colour, so stop rather than guess.
  if (mode === "dark" && layer("light", classes, utility, state)) throw new Error(`No dark ${utility} colour in "${classes}"`);
  return null;
}

function textRatio(mode: Mode, classes: string, state: State, backdrop: Rgb): number {
  const fill = layer(mode, classes, "bg", state);
  const ground = fill ? over(fill, backdrop) : backdrop;
  const text = layer(mode, classes, "text", state);
  if (!text) throw new Error(`No ${mode} text colour in "${classes}"`);
  return contrast(over(text, ground), ground);
}

const classAttribute = (element: ReactElement) => /class="([^"]*)"/.exec(renderToStaticMarkup(element))?.[1] ?? "";

// Mentions, a reply's Updated badge and unsaved state, the camera request chip,
// the warning beside a speaker, and the landing page's Updated badge.
const SAND_TEXT_FILES = [
  "screens/studio/components/assistantMentionUI.tsx",
  "screens/studio/components/chat-input/AgentMentionNode.tsx",
  "screens/studio/components/ChatFileChangeList.tsx",
  "screens/studio/components/ChatActivityEntries.tsx",
  "screens/studio/components/AssistantSpeakerIdentityPill.tsx",
  "screens/landing/landingStudioChrome.ts",
];

// The danger row in Settings navigation, desktop list and compact menu alike.
const SETTINGS_NAV_FILE = "screens/studio/components/SettingsShell.tsx";
// Danger rows whose colour must be important to paint over a row's own grey:
// Settings navigation and the workspace tab menu's Delete.
const DANGER_ROW_FILES = [SETTINGS_NAV_FILE, "workspace/WorkspaceTabs.tsx"];

// Every string in the file that names a light text colour of the hue (sand
// unless another is given), important or not.
function textClassStrings(file: string, hue = "secondary"): string[] {
  const path = resolve(here, "../..", file);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && new RegExp(`(?:^|\\s)!?text-${hue}-\\d`).test(node.text)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const COMPONENT_PAIRS: { name: string; classes: string; states: State[] }[] = [
  ...(["neutral", "info", "success", "warning", "danger"] as const).map((tone) => ({
    name: `${tone} Badge`,
    classes: classAttribute(createElement(Badge, { tone })),
    states: ["rest"] as State[],
  })),
  ...(["neutral", "warning", "danger", "primary"] as const).map((tone) => ({
    name: `${tone} StatusPill`,
    classes: classAttribute(createElement(StatusPill, { tone, children: "Goal" })),
    states: ["rest"] as State[],
  })),
  ...(["ghost", "text"] as const).map((variant) => ({
    name: `quiet danger ${variant} Button`,
    classes: iconButtonStyles({ variant, tone: "danger" }),
    states: ["rest", "hover", "data-[pressed]"] as State[],
  })),
  {
    name: "danger TextLink",
    classes: classAttribute(createElement(MemoryRouter, null, createElement(TextLink, { to: "/", tone: "danger", children: "Remove" }))),
    states: ["rest", "hover"],
  },
  ...SAND_TEXT_FILES.flatMap((file) =>
    textClassStrings(file).map((classes) => ({ name: `sand text in ${file}`, classes, states: ["rest", "hover"] as State[] })),
  ),
  ...DANGER_ROW_FILES.flatMap((file) =>
    textClassStrings(file, "rose").map((classes) => ({
      name: `danger row in ${file}`,
      classes,
      states: ["rest", "hover"] as State[],
    })),
  ),
];

describe("component colour contrast", () => {
  it("reads each pair from its source", () => {
    for (const file of SAND_TEXT_FILES) expect(textClassStrings(file), file).not.toEqual([]);
    for (const file of DANGER_ROW_FILES) expect(textClassStrings(file, "rose"), file).not.toEqual([]);
    for (const { name, classes } of COMPONENT_PAIRS) expect(classes, name).not.toBe("");
  });

  it("marks each danger row's colour important, or a row's own grey paints over it", () => {
    // Button's text-slate-700 and the menu row's text-slate-600 come later in
    // the stylesheet than text-rose-700, so a plain class never shows.
    for (const classes of DANGER_ROW_FILES.flatMap((file) => textClassStrings(file, "rose"))) {
      expect(classes.split(" ").filter((name) => /^(?:dark:)?!?text-rose-/.test(name)), classes)
        .toEqual(expect.arrayContaining([expect.stringMatching(/^!text-rose-/), expect.stringMatching(/^dark:!text-rose-/)]));
      expect(classes.split(" ").filter((name) => /^(?:dark:)?text-rose-/.test(name)), classes).toEqual([]);
    }
  });

  it("reproduces the audit's figures behind each change", () => {
    const light = (text: string, ground: Rgb) => contrast(token("light", text), ground);
    const row = token("light", "slate-100");
    // Neutral Badge and StatusPill text on their slate-100 fill.
    expect(light("slate-600", row)).toBeCloseTo(4.39, 1);
    expect(light("slate-700", row)).toBeCloseTo(7.02, 1);
    // Danger Button, TextLink, Settings row and speaker status text on white,
    // slate-50 and slate-100.
    const grounds: [Rgb, number, number][] = [[[1, 1, 1], 4.51, 6.06], [token("light", "slate-50"), 4.32, 5.8], [row, 4.07, 5.47]];
    for (const [ground, before, after] of grounds) {
      expect(light("rose-600", ground)).toBeCloseTo(before, 1);
      expect(light("rose-700", ground)).toBeCloseTo(after, 1);
    }
    // Sand text on the sand fill.
    expect(light("secondary-700", token("light", "secondary-50"))).toBeCloseTo(3.99, 1);
    expect(light("secondary-800", token("light", "secondary-50"))).toBeCloseTo(6.82, 1);
  });

  it.each(["light", "dark"] as const)("reads in %s: text at 4.5:1 at rest and in each state, on every ground", (mode) => {
    const short: string[] = [];
    for (const { name, classes, states } of COMPONENT_PAIRS) {
      for (const state of states) {
        for (const [groundName, backdrop] of Object.entries(GROUNDS[mode])) {
          const ratio = textRatio(mode, classes, state, backdrop);
          if (ratio < 4.5) short.push(`${name} ${state} over the ${groundName}: ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(short).toEqual([]);
  });
});

describe("rows that sit on the slate-100 fill", () => {
  // A menu row at rest sits on its menu's own surface, and only a hovered,
  // focused or pressed row on the slate-100 fill, where the rest grey would
  // read 4.39:1. In dark the fill is the control hover, a CSS variable, so
  // the row's text is measured over the hovered-row grounds instead.
  it.each(["light", "dark"] as const)("menu rows keep 4.5:1 in %s at rest and while hovered, focused or pressed", (mode) => {
    const rows: Array<[name: string, classes: string, states: State[]]> = [
      ["menu row", STUDIO_MENU_ARIA_ROW_CLASS, ["rest", "data-[hovered]", "data-[focused]", "data-[pressed]"]],
      ["native menu row", STUDIO_MENU_NATIVE_ROW_CLASS, ["rest", "not-disabled:hover", "not-disabled:active"]],
    ];
    const hoveredGrounds = Object.entries(GROUNDS.dark).filter(([name]) => name.startsWith("hovered row"));
    const short: string[] = [];
    for (const [name, classes, states] of rows) {
      for (const state of states) {
        const grounds = mode === "dark" && state !== "rest" ? hoveredGrounds : Object.entries(BACKDROPS[mode]);
        for (const [groundName, backdrop] of grounds) {
          const ratio =
            mode === "light"
              ? textRatio(mode, classes, state, backdrop)
              : (() => {
                  const text = layer(mode, classes, "text", state);
                  if (!text) throw new Error(`No dark text colour in "${classes}"`);
                  return contrast(over(text, backdrop), backdrop);
                })();
          if (ratio < 4.5) short.push(`${name} ${state} over the ${groundName}: ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(short).toEqual([]);
  });

  it("gives a selected row's subtitle a darker grey than muted, which reads 4.39:1 on the fill", () => {
    const subtitleClasses = (selected: boolean) =>
      /<span class="([^"]*)">Shared team<\/span>/.exec(
        renderToStaticMarkup(createElement(EntityRow, { title: "Launch", subtitle: "Shared team", selected })),
      )?.[1] ?? "";
    expect(subtitleClasses(false)).toContain("text-slate-600");
    expect(subtitleClasses(true)).toContain("text-slate-700");
    expect(subtitleClasses(true)).not.toContain("text-slate-600");
    const row = token("light", "slate-100");
    expect(contrast(token("light", "slate-700"), row)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("light", "slate-600"), row)).toBeLessThan(4.5);
  });
});
