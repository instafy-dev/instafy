#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAppIconChecker,
  findIconLinks,
  formatSvgNumber,
} from "./lib/app-icon-checker.mjs";
import {
  ADAPTIVE_ICON_PATHS,
  ANDROID_LAUNCH_THEME_CONTRACTS,
  ANDROID_SPLASH_BACKGROUND_PATHS,
  DESKTOP_BUILD_ICONS,
  DESKTOP_ICNS_CONTRACTS,
  DESKTOP_ICNS_PATH,
  DESKTOP_ICO_CONTRACTS,
  DESKTOP_ICO_PATH,
  FAVICON_ENTRY_CONTRACTS,
  FAVICON_LINK_PATHS,
  GITHUB_BADGE_ICON_PATHS,
  GOOGLE_PLAY_ICON_PATHS,
  IOS_APP_ICON_IMAGES,
  IOS_DARK_ICON_PATH,
  IOS_DARK_NOTIFICATION_ICON_PATH,
  IOS_NOTIFICATION_ICON_PATH,
  IOS_SPLASH_IMAGES,
  IOS_TINTED_NOTIFICATION_ICON_PATH,
  PNG_ASSET_CONTRACTS,
  PNG_FAVICON_TARGET,
  STALE_ASSET_PATHS,
  createCrewNodeTargets,
  createCrewTokenContracts,
  createOneInkTargets,
  createOpticalIconTargets,
  createRasterColorSamples,
  createRevisionedAssetContracts,
  createSplashTargets,
  createThemeTokenContracts,
  expectedTileInk,
  macGridBody,
} from "./lib/app-icon-contracts.mjs";
import { decodeIcnsEntries } from "./lib/icon-containers.mjs";
import {
  countNonGreyscalePixels,
  countOffInkVisiblePixels,
  countVisiblePixelsOutside,
  measureInkBounds,
  pixelAt,
} from "./lib/png-ink-bounds.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const {
  assertAssetRevision,
  assertCanonicalGeometry,
  assertCenteredArtwork,
  assertInkInsideCircle,
  assertMatchingAlpha,
  assertMatchingOpticalRatios,
  assertNodeColors,
  assertOpticalBounds,
  assertPalette,
  assertPixelColor,
  assertNodesInked,
  assertMatchesFullBleedReference,
  assertFullBleedTransform,
  checkFavicon,
  expectContains,
  expectNotContains,
  parseHexColor,
  readIconContainer,
  readIcoEntries,
  readImage,
  readInkBounds,
  readPng,
  readText,
  resolve,
} = createAppIconChecker({ repoRoot, failures });
const brandConfigPath = "scripts/app-icon-brand.json";
const brandConfig = JSON.parse(readText(brandConfigPath) || "{}");
const ICON_CACHE_REVISION = String(brandConfig.cacheRevision ?? "");
const BRAND_NAVY = parseHexColor(brandConfig.colors?.ink, `${brandConfigPath} colors.ink`);
const BRAND_WHITE = parseHexColor(brandConfig.colors?.paper, `${brandConfigPath} colors.paper`);
const CANVAS_DARK = parseHexColor(
  brandConfig.colors?.canvasDark,
  `${brandConfigPath} colors.canvasDark`,
);
const CREW_TILE_MIN_PX = brandConfig.crewTileMinPx;
const crewSets = {};
for (const theme of ["light", "dark"]) {
  const values = brandConfig.colors?.crew?.[theme];
  if (!Array.isArray(values) || values.length !== 4) {
    failures.push(
      `${brandConfigPath} colors.crew.${theme} must list the four crew colors, left to right.`,
    );
  }
  crewSets[theme] = (Array.isArray(values) ? values : []).map((value, index) =>
    parseHexColor(value, `${brandConfigPath} colors.crew.${theme}[${index}]`),
  );
}
const palette = {
  navy: BRAND_NAVY,
  white: BRAND_WHITE,
  canvasDark: CANVAS_DARK,
  crewLight: crewSets.light,
  crewDark: crewSets.dark,
};

if (!/^\d+$/.test(ICON_CACHE_REVISION) || Number(ICON_CACHE_REVISION) < 1) {
  failures.push(`${brandConfigPath} cacheRevision must be a positive integer.`);
}
if (
  typeof brandConfig.distributionScale !== "number" ||
  brandConfig.distributionScale <= 0 ||
  brandConfig.distributionScale > 1
) {
  failures.push(`${brandConfigPath} distributionScale must be in (0, 1].`);
}
if (
  typeof brandConfig.maskableScale !== "number" ||
  brandConfig.maskableScale <= 0 ||
  !(brandConfig.maskableScale < brandConfig.distributionScale)
) {
  failures.push(`${brandConfigPath} maskableScale must be positive and below distributionScale.`);
}
if (!Number.isInteger(CREW_TILE_MIN_PX) || CREW_TILE_MIN_PX < 1) {
  failures.push(`${brandConfigPath} crewTileMinPx must be a positive integer (device px).`);
}

const geometryPath = "packages/frontend/src/assets/octo-mark.geometry.json";
const geometry = JSON.parse(readText(geometryPath) || "{}");
if (geometry.viewBox !== "0 0 64 64" || geometry.transform !== "translate(-1.3 -1.7)") {
  failures.push(`${geometryPath} must retain the established Octopus Merge coordinate system.`);
}
if (geometry.paths?.length !== 5 || geometry.circles?.length !== 4) {
  failures.push(`${geometryPath} must contain the five canonical paths and four detached nodes.`);
}

/**
 * A full-bleed one-ink raster (32 device px or less): every node reads as a
 * dot, and the drawing is the main cut itself, matched pixel for pixel
 * against its reference raster.
 */
function checkFullBleedRaster(target) {
  assertNodesInked(target);
  assertMatchesFullBleedReference(target);
}

const pngs = PNG_ASSET_CONTRACTS;

for (const [relativePath, expectedWidth, expectedHeight, expectedAlpha, expectedColorType] of pngs) {
  const metadata = readPng(relativePath);
  if (!metadata) continue;
  if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    failures.push(
      `${relativePath} must be ${expectedWidth}x${expectedHeight}; found ${metadata.width}x${metadata.height}.`,
    );
  }
  if (metadata.hasAlpha !== expectedAlpha) {
    failures.push(
      `${relativePath} must ${expectedAlpha ? "retain" : "not contain"} an alpha channel.`,
    );
  }
  if (expectedColorType != null && metadata.colorType !== expectedColorType) {
    failures.push(`${relativePath} must use PNG color type ${expectedColorType}; found ${metadata.colorType}.`);
  }
}

const rasterColorSamples = createRasterColorSamples(BRAND_NAVY, BRAND_WHITE, CANVAS_DARK);

for (const [relativePath, x, y, expected] of rasterColorSamples) {
  assertPixelColor(relativePath, x, y, expected);
}

// Crew nodes sit at the mark's left, right and bottom extremes, so every
// bounds read counts the body ink and the node colors together.
const inksOf = (target) => [target.ink, ...(target.nodeColors ?? [])];

const opticalIconTargets = createOpticalIconTargets(palette);

const opticalBounds = opticalIconTargets.map((target) => ({
  ...target,
  bounds: readInkBounds(target.relativePath, {
    inks: inksOf(target),
    background: target.background,
  }),
}));
for (const target of opticalBounds) {
  assertOpticalBounds(target);
  assertCenteredArtwork(target);
  if (target.safeCircle) {
    let image;
    try {
      image = readImage(target.relativePath);
    } catch {
      continue; // readInkBounds above already reported the unreadable file.
    }
    assertInkInsideCircle({
      label: target.relativePath,
      image,
      background: target.background,
      radius: target.safeCircle.radiusRatio * image.width,
      zone: target.safeCircle.zone,
    });
  }
}
// Each optical group shares its first target's ink ratios: the tiles at the
// distribution scale, and the maskable tiles at maskableScale.
const opticalReferences = new Map();
for (const target of opticalBounds) {
  const group = target.opticalGroup ?? "tile";
  if (!opticalReferences.has(group)) {
    opticalReferences.set(group, target);
    continue;
  }
  assertMatchingOpticalRatios(opticalReferences.get(group), target);
}

const splashTargets = createSplashTargets(palette);

for (const target of splashTargets) {
  const inspected = {
    ...target,
    bounds: readInkBounds(target.relativePath, {
      inks: inksOf(target),
      background: target.background,
    }),
  };
  assertOpticalBounds(inspected);
  assertCenteredArtwork(inspected);
}

// Crew assets: each node, left to right, carries its crew slot color, and the
// tile is large enough for crew (crewTileMinPx device px).
for (const target of createCrewNodeTargets(palette, {
  distributionScale: brandConfig.distributionScale,
  maskableScale: brandConfig.maskableScale,
})) {
  assertNodeColors({
    ...target,
    geometry,
    distributionScale: brandConfig.distributionScale,
    minimumSide: CREW_TILE_MIN_PX,
  });
}

// A crew asset holds only its background, the body ink and the four node
// colors (and their antialiased blends): no stray hue, no wrong crew set.
for (const target of [...opticalIconTargets, ...splashTargets]) {
  if (!target.nodeColors) continue;
  let image;
  try {
    image = readImage(target.relativePath);
  } catch {
    continue; // readInkBounds above already reported the unreadable file.
  }
  assertPalette({
    label: target.relativePath,
    image,
    inks: inksOf(target),
    background: target.background,
    reason: "the body ink plus its crew nodes",
  });
}

// One-ink assets: favicon tiles, the GitHub badge and the Android themed layer.
for (const target of createOneInkTargets(palette)) {
  let image;
  try {
    image = readImage(target.relativePath);
  } catch (error) {
    failures.push(
      `Unable to read ${target.relativePath}: ${error instanceof Error ? error.message : error}`,
    );
    continue;
  }
  assertPalette({
    label: target.relativePath,
    image,
    inks: [target.ink],
    background: target.background,
    reason: target.reason,
  });
  if (target.greyscale) {
    const colored = countNonGreyscalePixels(image);
    if (colored > 0) {
      failures.push(
        `${target.relativePath} must be greyscale (the system tints it by luminance); found ${colored} colored pixels.`,
      );
    }
  }
  if (target.transparentGround) {
    assertTransparentGround(target.relativePath, image, [target.ink]);
  }
  if (target.matchesAlphaOf) {
    assertMatchingAlpha(
      target.relativePath,
      target.matchesAlphaOf,
      `${target.relativePath} must share the silhouette (alpha mask) of ${target.matchesAlphaOf}.`,
    );
  }
}

/**
 * The iOS Dark icon paints only the mark: transparent corners and ground, and
 * every visible pixel is the white body or a crew color, so the system's own
 * dark background shows through.
 */
function assertTransparentGround(label, image, inks) {
  const offInk = countOffInkVisiblePixels(image, { inks });
  if (offInk > 0) {
    failures.push(
      `${label} must paint only the mark on a transparent ground; found ${offInk} visible pixels of another color.`,
    );
  }
  const corners = [
    [0, 0],
    [image.width - 1, 0],
    [0, image.height - 1],
    [image.width - 1, image.height - 1],
  ];
  if (corners.some(([x, y]) => pixelAt(image, x, y)[3] !== 0)) {
    failures.push(`${label} must keep a fully transparent ground (its corners are not).`);
  }
}

{
  let image;
  try {
    image = readImage(IOS_DARK_ICON_PATH);
  } catch {
    image = null; // The PNG contracts above report a missing file.
  }
  if (image) assertTransparentGround(IOS_DARK_ICON_PATH, image, [BRAND_WHITE, ...palette.crewDark]);
}

const pngFavicon = {
  ...PNG_FAVICON_TARGET,
  bounds: readInkBounds(PNG_FAVICON_TARGET.relativePath, {
    ink: BRAND_WHITE,
    background: BRAND_NAVY,
  }),
};
assertOpticalBounds(pngFavicon);
assertCenteredArtwork(pngFavicon);
{
  let image;
  try {
    image = readImage(PNG_FAVICON_TARGET.relativePath);
  } catch {
    image = null; // readInkBounds above already reported the unreadable file.
  }
  checkFullBleedRaster({
    label: PNG_FAVICON_TARGET.relativePath,
    image,
    placement: { x: 0, y: 0, side: 32 },
    geometry,
    ink: BRAND_WHITE,
    background: BRAND_NAVY,
  });
}

for (const relativePath of GOOGLE_PLAY_ICON_PATHS) {
  const absolutePath = resolve(relativePath);
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).size > 1024 * 1024) {
    failures.push(`${relativePath} must stay below Google Play's 1 MiB limit.`);
  }
}

for (const relativePath of GITHUB_BADGE_ICON_PATHS) {
  const absolutePath = resolve(relativePath);
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).size >= 1024 * 1024) {
    failures.push(`${relativePath} must stay below GitHub's 1 MiB badge upload limit.`);
  }
}

const canonicalSvg = readText("packages/frontend/public/icon.svg");
expectContains(
  canonicalSvg,
  `.octo-ink { fill: ${brandConfig.colors?.ink}; }`,
  "The light favicon must use brand ink.",
);
expectContains(
  canonicalSvg,
  `@media (prefers-color-scheme: dark) { .octo-ink { fill: ${brandConfig.colors?.paper}; } }`,
  "The favicon must reverse to brand paper on dark browser chrome.",
);

// icon.svg is drawn at 16 CSS px: the main cut (one logo at every size), one
// ink, full-bleed in a single group.
assertCanonicalGeometry(canonicalSvg, geometry, "packages/frontend/public/icon.svg");
assertFullBleedTransform(canonicalSvg, geometry, "packages/frontend/public/icon.svg");
expectNotContains(
  canonicalSvg,
  "<rect",
  "The adaptive favicon draws the nodes as the logo's circles, never as pixel squares.",
);
expectNotContains(
  canonicalSvg,
  "M15 22.5 C15 12 22 5 32 5",
  "The retired stroked favicon approximation must not replace the canonical Octo geometry.",
);

const avatarSvgPath = "packages/frontend/src/assets/octo-avatar.svg";
const avatarSvg = readText(avatarSvgPath);
expectContains(
  avatarSvg,
  `<circle cx="32" cy="32" r="32" fill="${brandConfig.colors?.paper}"/>`,
  "The in-product Octo avatar must retain its white circular background.",
);
expectContains(
  avatarSvg,
  `fill="${brandConfig.colors?.ink}"`,
  "The in-product Octo avatar must use the positive brand-ink lockup.",
);
expectContains(
  avatarSvg,
  `transform="translate(${formatSvgNumber(32 * (1 - brandConfig.distributionScale))} ${formatSvgNumber(
    32 * (1 - brandConfig.distributionScale),
  )}) scale(${formatSvgNumber(brandConfig.distributionScale)})"`,
  "The Octo avatar must keep the shared 15% optical padding of the main cut.",
);
// Octo's coin is one participant and the favicon is a monochrome context:
// neither SVG may carry a crew color.
const crewHexes = [
  ...(brandConfig.colors?.crew?.light ?? []),
  ...(brandConfig.colors?.crew?.dark ?? []),
];
for (const [svgPath, svg] of [
  [avatarSvgPath, avatarSvg],
  ["packages/frontend/public/icon.svg", canonicalSvg],
]) {
  for (const hex of crewHexes) {
    expectNotContains(
      svg.toLowerCase(),
      hex.toLowerCase(),
      `${svgPath} must stay one ink; found crew color ${hex}.`,
    );
  }
}
assertCanonicalGeometry(avatarSvg, geometry, avatarSvgPath);

const octoMarkComponent = readText("packages/frontend/src/components/OctoMark.tsx");
expectContains(
  octoMarkComponent,
  'import octoMarkGeometry from "../assets/octo-mark.geometry.json";',
  "The OctoMark component must render the shared geometry source.",
);

const themeStyles = readText("packages/frontend/src/styles/tailwind.css");
for (const [token, value] of createThemeTokenContracts(brandConfig.colors)) {
  expectContains(
    themeStyles,
    `--color-${token}: ${value};`,
    `The ${token} theme token must remain aligned with the brand contract.`,
  );
}
expectNotContains(
  themeStyles,
  "#0f1a2a",
  "Do not restore the retired near-duplicate midnight color; use brand ink.",
);
const themeBlocks = new Map();
for (const match of themeStyles.matchAll(/(?:^|\n)(:root|\.dark) \{([^}]*)\}/g)) {
  themeBlocks.set(match[1], `${themeBlocks.get(match[1]) ?? ""}${match[2]}`);
}
for (const [selector, token, value] of createCrewTokenContracts(brandConfig.colors?.crew)) {
  expectContains(
    themeBlocks.get(selector) ?? "",
    `${token}: ${value};`,
    `tailwind.css ${selector} ${token} must equal the icon crew color ${value} (${brandConfigPath}).`,
  );
}

// Inside the window navy is only ink: the browser and PWA chrome take the
// page's own surface. The manifest cannot vary by color scheme, so it holds
// the light (default) launch pair; the page's per-scheme meta takes over.
const manifest = readText("packages/frontend/public/manifest.webmanifest");
expectContains(
  manifest,
  `"theme_color": "${brandConfig.colors?.paper}"`,
  "The PWA theme color must be brand paper, the launch surface it frames.",
);
expectContains(
  manifest,
  `"background_color": "${brandConfig.colors?.paper}"`,
  "The PWA launch background must use brand paper.",
);
expectContains(manifest, '"purpose": "maskable"', "The PWA manifest must expose maskable icons.");

const frontendIndex = readText("packages/frontend/index.html");
const themeColorMetas = [...frontendIndex.matchAll(/<meta\b[^>]*\bname="theme-color"[^>]*>/gi)].map(
  ([tag]) => tag,
);
const expectedThemeColorMetas = [
  `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${brandConfig.colors?.paper}" />`,
  `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${brandConfig.colors?.canvasDark}" />`,
];
if (themeColorMetas.join("\n") !== expectedThemeColorMetas.join("\n")) {
  failures.push(
    `packages/frontend/index.html must declare exactly one theme-color per color scheme: brand paper in light and the dark canvas in dark; found ${
      themeColorMetas.join(" ") || "none"
    }.`,
  );
}
expectContains(
  frontendIndex,
  `var themeColor = resolvedTheme === "dark" ? "${brandConfig.colors?.canvasDark}" : "${brandConfig.colors?.paper}";`,
  "index.html must apply the stored app theme to every theme-color tag before first paint.",
);
const themeProviderPath = "packages/frontend/src/theme/ThemeProvider.tsx";
const browserThemeColor = /const BROWSER_THEME_COLOR = \{\s*light: "([^"]+)",\s*dark: "([^"]+)",?\s*\}/.exec(
  readText(themeProviderPath),
);
if (
  browserThemeColor?.[1] !== brandConfig.colors?.paper ||
  browserThemeColor?.[2] !== brandConfig.colors?.canvasDark
) {
  failures.push(
    `${themeProviderPath} BROWSER_THEME_COLOR must sync theme-color to brand paper (light) and the dark canvas (dark).`,
  );
}
for (const [label, content] of [
  ["packages/frontend/index.html", themeColorMetas.join("\n")],
  ["packages/frontend/public/manifest.webmanifest", manifest],
]) {
  expectNotContains(
    content.toLowerCase(),
    `"${brandConfig.colors?.ink}"`,
    `${label} must not paint browser or PWA chrome brand ink; inside the window navy is only ink.`,
  );
}
// Any rel token "icon" (rel="icon", "shortcut icon", "alternate icon", in any
// attribute order) lets a browser pick the file for the tab.
for (const { href } of findIconLinks(frontendIndex)) {
  if (!FAVICON_LINK_PATHS.includes(href)) {
    failures.push(
      `packages/frontend/index.html offers ${href || "a link without href"} as a favicon; use one of ${FAVICON_LINK_PATHS.join(
        ", ",
      )}.`,
    );
  }
}
expectContains(
  frontendIndex,
  '<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png?v=',
  "The PNG favicon fallback must be the one-ink 32px full-bleed tile.",
);

const serviceWorker = readText("packages/frontend/public/sw.js");
expectContains(
  serviceWorker,
  `const CACHE_VERSION = "v${ICON_CACHE_REVISION}";`,
  "The service worker cache must advance with the current brand asset revision.",
);

for (const [relativePath, content, assetPaths] of createRevisionedAssetContracts({
  frontendIndex,
  manifest,
  serviceWorker,
})) {
  assertAssetRevision(relativePath, content, assetPaths, ICON_CACHE_REVISION);
}

const faviconPath = "packages/frontend/public/favicon.ico";
checkFavicon(faviconPath, FAVICON_ENTRY_CONTRACTS.map(({ size }) => size));
const faviconEntries = readIcoEntries(faviconPath);
for (const contract of FAVICON_ENTRY_CONTRACTS) {
  const entry = faviconEntries.find(({ size }) => size === contract.size);
  if (!entry) continue;
  const label = `${faviconPath} ${contract.size}px entry`;
  assertPalette({
    label,
    image: entry.image,
    inks: [BRAND_WHITE],
    background: BRAND_NAVY,
    reason: "one ink (favicon.ico is a monochrome context)",
  });
  // Full-bleed, the mark fills 56 of 64 units; at the distribution scale it
  // is markedly smaller, so the ink box tells the two fits apart.
  const target = {
    relativePath: label,
    viewport: { x: 0, y: 0, width: contract.size, height: contract.size },
    expectedInk: contract.expectedInk,
    artworkLabel: `one-ink ${contract.fit} Octo`,
    bounds: measureInkBounds(entry.image, { ink: BRAND_WHITE, background: BRAND_NAVY }),
  };
  assertOpticalBounds(target);
  assertCenteredArtwork(target);
  if (contract.fit === "full-bleed") {
    checkFullBleedRaster({
      label,
      image: entry.image,
      placement: { x: 0, y: 0, side: contract.size },
      geometry,
      ink: BRAND_WHITE,
      background: BRAND_NAVY,
    });
  }
}

// Desktop: electron-builder takes icon.icns (macOS) and icon.ico (Windows) as
// they are, so their small representations are what users see at 16-32 px.
const desktopPackage = JSON.parse(readText("packages/desktop-app/package.json") || "{}");
for (const [platform, expectedIcon] of Object.entries(DESKTOP_BUILD_ICONS)) {
  const icon = desktopPackage.build?.[platform]?.icon;
  if (icon !== expectedIcon) {
    failures.push(
      `packages/desktop-app/package.json build.${platform}.icon must use ${expectedIcon}; found ${icon}.`,
    );
  }
}

/**
 * One desktop representation: size, treatment, fit, nodes and the rounded
 * tile. A `grid` representation (macOS) draws the tile as the body of the
 * macOS icon grid, so every rule applies to that body and its margins must be
 * fully transparent.
 */
function checkDesktopRepresentation(label, image, { side, fit, crew, grid = false }) {
  if (image.width !== side || image.height !== side) {
    failures.push(`${label} must be ${side}x${side}; found ${image.width}x${image.height}.`);
    return;
  }
  const { inset, body } = grid ? macGridBody(side) : { inset: 0, body: side };
  if (grid) {
    const outside = countVisiblePixelsOutside(image, {
      x0: inset,
      y0: inset,
      x1: inset + body,
      y1: inset + body,
    });
    if (outside > 0) {
      failures.push(
        `${label} must keep the macOS grid's ${inset}px margins transparent around its ${body}px body; found ${outside} visible pixels.`,
      );
    }
    // The body fills its box: opaque at the middle of each edge. (Its color
    // is the palette check's job; in a 12 px body the full-bleed mark's dome
    // reaches into the top edge pixel.)
    const middle = Math.floor(side / 2);
    for (const [x, y] of [
      [middle, inset],
      [middle, inset + body - 1],
      [inset, middle],
      [inset + body - 1, middle],
    ]) {
      const actual = pixelAt(image, x, y);
      if (actual[3] !== 255) {
        failures.push(
          `${label} must fill its ${body}px grid body to the edges; found rgba(${actual.join(",")}) at ${x},${y}.`,
        );
        break;
      }
    }
  }
  const expectsCrew = fit === "distribution" && body >= CREW_TILE_MIN_PX;
  if (crew !== expectsCrew) {
    failures.push(
      `${label}: the contract must give crew to distribution-scale representations of at least ${CREW_TILE_MIN_PX} device px only.`,
    );
  }
  if (fit === "full-bleed" && side > 32) {
    failures.push(`${label}: only representations of 32 device px or less draw the mark full-bleed.`);
  }
  const inks = crew ? [BRAND_WHITE, ...palette.crewDark] : [BRAND_WHITE];
  assertPalette({
    label,
    image,
    inks,
    background: BRAND_NAVY,
    reason: crew
      ? "the white body plus the dark crew nodes"
      : `one ink (under the ${CREW_TILE_MIN_PX} device px crew threshold)`,
  });
  const viewport = { x: inset, y: inset, width: body, height: body };
  const bounds = measureInkBounds(image, { inks, background: BRAND_NAVY });
  const target = {
    relativePath: label,
    viewport,
    expectedInk: expectedTileInk(body, fit),
    artworkLabel: `${crew ? "crew" : "one-ink"} ${fit} Octo`,
    bounds,
  };
  assertOpticalBounds(target);
  assertCenteredArtwork(target);
  if (crew) {
    assertNodeColors({
      relativePath: label,
      image,
      placement: { x: inset, y: inset, side: body },
      geometry,
      distributionScale: brandConfig.distributionScale,
      nodeColors: palette.crewDark,
      minimumSide: CREW_TILE_MIN_PX,
    });
  }
  if (fit === "full-bleed") {
    checkFullBleedRaster({
      label,
      image,
      placement: { x: inset, y: inset, side: body },
      geometry,
      ink: BRAND_WHITE,
      background: BRAND_NAVY,
    });
  }
  // The desktop tile is a rounded rect: its corners stay transparent (on the
  // grid, the body's own corner pixel is mostly outside its rounded corner).
  if (pixelAt(image, inset, inset)[3] >= (grid ? 128 : 1)) {
    failures.push(`${label} must keep the rounded tile's transparent corners.`);
  }
}

const icnsEntries = readIconContainer(DESKTOP_ICNS_PATH, decodeIcnsEntries);
const icnsTypes = icnsEntries.map(({ type }) => type).sort();
const expectedIcnsTypes = DESKTOP_ICNS_CONTRACTS.map(({ type }) => type).sort();
if (icnsEntries.length > 0 && icnsTypes.join(",") !== expectedIcnsTypes.join(",")) {
  failures.push(
    `${DESKTOP_ICNS_PATH} must contain exactly ${expectedIcnsTypes.join("/")}; found ${icnsTypes.join("/")}.`,
  );
}
for (const contract of DESKTOP_ICNS_CONTRACTS) {
  const entry = icnsEntries.find(({ type }) => type === contract.type);
  if (!entry) continue;
  const label = `${DESKTOP_ICNS_PATH} ${contract.type} (${contract.side}px)`;
  checkDesktopRepresentation(label, entry.image, contract);
}

const icoEntries = readIcoEntries(DESKTOP_ICO_PATH);
const icoSides = icoEntries.map(({ size }) => size);
const expectedIcoSides = DESKTOP_ICO_CONTRACTS.map(({ side }) => side);
if (icoEntries.length > 0 && icoSides.join(",") !== expectedIcoSides.join(",")) {
  failures.push(
    `${DESKTOP_ICO_PATH} must contain ${expectedIcoSides.join("/")}px entries; found ${icoSides.join("/")}.`,
  );
}
for (const contract of DESKTOP_ICO_CONTRACTS) {
  const entry = icoEntries.find(({ size }) => size === contract.side);
  if (!entry) continue;
  const label = `${DESKTOP_ICO_PATH} ${contract.side}px entry`;
  if (entry.format !== contract.format || entry.bitCount !== 32) {
    failures.push(
      `${label} must be a 32-bit ${contract.format === "png" ? "PNG" : "DIB (BMP)"} entry; classic DIB entries under 256 px keep NSIS and rcedit compatible.`,
    );
  }
  checkDesktopRepresentation(label, entry.image, contract);
}

const iosAppIconContentsPath =
  "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json";
let iosAppIconImages = null;
try {
  iosAppIconImages = JSON.parse(readText(iosAppIconContentsPath) || "{}").images;
} catch (error) {
  failures.push(`${iosAppIconContentsPath} is not valid JSON: ${error}`);
}
if (iosAppIconImages && canonicalJson(iosAppIconImages) !== canonicalJson(IOS_APP_ICON_IMAGES)) {
  failures.push(
    `${iosAppIconContentsPath} must list exactly the generated 1024px crew icon and the one-ink 20pt@2x slot, each in the any, Dark and Tinted appearances.`,
  );
}
const iosSplashContentsPath =
  "packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json";
let iosSplashImages = null;
try {
  iosSplashImages = JSON.parse(readText(iosSplashContentsPath) || "{}").images;
} catch (error) {
  failures.push(`${iosSplashContentsPath} is not valid JSON: ${error}`);
}
if (iosSplashImages && canonicalJson(iosSplashImages) !== canonicalJson(IOS_SPLASH_IMAGES)) {
  failures.push(
    `${iosSplashContentsPath} must list the positive splash and its reverse (dark appearance) twin at 1x, 2x and 3x.`,
  );
}
// The 40 px slot in every appearance: iOS masks it like every other size, so
// it keeps the distribution scale, one ink, centered like the default slot.
for (const [relativePath, background] of [
  [IOS_NOTIFICATION_ICON_PATH, BRAND_NAVY],
  [IOS_DARK_NOTIFICATION_ICON_PATH, CANVAS_DARK],
  [IOS_TINTED_NOTIFICATION_ICON_PATH, [0, 0, 0]],
]) {
  let image;
  try {
    image = readImage(relativePath);
  } catch {
    continue; // The PNG contracts above report a missing file.
  }
  const target = {
    relativePath,
    viewport: { x: 0, y: 0, width: 40, height: 40 },
    expectedInk: expectedTileInk(40, "distribution"),
    artworkLabel: "one-ink Octo",
    bounds: measureInkBounds(image, { ink: BRAND_WHITE, background }),
  };
  assertOpticalBounds(target);
  assertCenteredArtwork(target);
}
const iosProject = readText("packages/frontend/ios/App/App.xcodeproj/project.pbxproj");
expectContains(
  iosProject,
  "ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;",
  "The iOS project must compile the AppIcon asset catalog.",
);

const androidManifest = readText("packages/frontend/android/app/src/main/AndroidManifest.xml");
expectContains(
  androidManifest,
  'android:icon="@mipmap/ic_launcher"',
  "The Android manifest must consume the generated launcher icon.",
);
expectContains(
  androidManifest,
  'android:roundIcon="@mipmap/ic_launcher_round"',
  "The Android manifest must consume the generated round launcher icon.",
);

for (const relativePath of ADAPTIVE_ICON_PATHS) {
  const adaptiveIcon = readText(relativePath);
  expectContains(
    adaptiveIcon,
    '<foreground android:drawable="@mipmap/ic_launcher_foreground"/>',
    `${relativePath} must use the generated crew foreground layer.`,
  );
  expectContains(
    adaptiveIcon,
    '<monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>',
    `${relativePath} must expose the one-ink Android 13 themed-icon layer, never the crew foreground.`,
  );
}

const androidLauncherBackground = readText(
  "packages/frontend/android/app/src/main/res/values/ic_launcher_background.xml",
);
expectContains(
  androidLauncherBackground,
  `<color name="ic_launcher_background">${brandConfig.colors?.ink?.toUpperCase()}</color>`,
  "Android adaptive icons must use the brand-navy reverse tile.",
);

// The reverse splash's launch window: the generated ground, and the launch
// theme that paints it under the system splash and both system bars.
for (const [theme, relativePath] of Object.entries(ANDROID_SPLASH_BACKGROUND_PATHS)) {
  const hex = theme === "dark" ? brandConfig.colors?.canvasDark : brandConfig.colors?.paper;
  expectContains(
    readText(relativePath),
    `<color name="splash_background">${hex?.toUpperCase()}</color>`,
    `${relativePath} must hold the ${theme} launch ground ${hex}.`,
  );
}
for (const { relativePath, items } of ANDROID_LAUNCH_THEME_CONTRACTS) {
  const launchTheme =
    /<style name="AppTheme\.NoActionBarLaunch" parent="Theme\.SplashScreen">([\s\S]*?)<\/style>/.exec(
      readText(relativePath),
    )?.[1] ?? "";
  for (const item of items) {
    expectContains(
      launchTheme,
      item,
      `${relativePath} AppTheme.NoActionBarLaunch must contain ${item}.`,
    );
  }
}

for (const stalePath of STALE_ASSET_PATHS) {
  if (fs.existsSync(resolve(stalePath))) {
    failures.push(`${stalePath} is retired artwork and must not be restored.`);
  }
}

/** JSON with object keys sorted, so key order never decides a comparison. */
function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

if (failures.length > 0) {
  console.error("[check-app-icons] failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[check-app-icons] ok (${pngs.length} PNG assets)`);
