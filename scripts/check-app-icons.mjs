#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAppIconChecker, formatSvgNumber } from "./lib/app-icon-checker.mjs";
import {
  ADAPTIVE_ICON_PATHS,
  GITHUB_BADGE_ICON_PATHS,
  GOOGLE_PLAY_ICON_PATHS,
  PNG_ASSET_CONTRACTS,
  STALE_ASSET_PATHS,
  createOpticalIconTargets,
  createRasterColorSamples,
  createRevisionedAssetContracts,
  createSplashTargets,
  createThemeTokenContracts,
} from "./lib/app-icon-contracts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const {
  assertAssetRevision,
  assertCanonicalGeometry,
  assertCenteredArtwork,
  assertMatchingOpticalRatios,
  assertOpticalBounds,
  assertPixelColor,
  checkFavicon,
  expectContains,
  expectNotContains,
  parseHexColor,
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

const rasterColorSamples = createRasterColorSamples(BRAND_NAVY, BRAND_WHITE);

for (const [relativePath, x, y, expected] of rasterColorSamples) {
  assertPixelColor(relativePath, x, y, expected);
}

const opticalIconTargets = createOpticalIconTargets(BRAND_NAVY, BRAND_WHITE);

const opticalBounds = opticalIconTargets.map((target) => ({
  ...target,
  bounds: readInkBounds(target.relativePath, {
    ink: target.ink,
    background: target.background,
  }),
}));
for (const target of opticalBounds) {
  assertOpticalBounds(target);
  assertCenteredArtwork(target);
}
const opticalReference = opticalBounds[0];
for (const target of opticalBounds.slice(1)) {
  assertMatchingOpticalRatios(opticalReference, target);
}

const splashTargets = createSplashTargets(BRAND_NAVY, BRAND_WHITE);

for (const target of splashTargets) {
  const inspected = {
    ...target,
    bounds: readInkBounds(target.relativePath, {
      ink: target.ink,
      background: target.background,
    }),
  };
  assertOpticalBounds(inspected);
  assertCenteredArtwork(inspected);
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

const geometryPath = "packages/frontend/src/assets/octo-mark.geometry.json";
const geometry = JSON.parse(readText(geometryPath) || "{}");
if (geometry.viewBox !== "0 0 64 64" || geometry.transform !== "translate(-1.3 -1.7)") {
  failures.push(`${geometryPath} must retain the established Octopus Merge coordinate system.`);
}
if (geometry.paths?.length !== 5 || geometry.circles?.length !== 4) {
  failures.push(`${geometryPath} must contain the five canonical paths and four detached nodes.`);
}
expectContains(
  canonicalSvg,
  `transform="translate(${formatSvgNumber(32 * (1 - brandConfig.distributionScale))} ${formatSvgNumber(
    32 * (1 - brandConfig.distributionScale),
  )}) scale(${formatSvgNumber(brandConfig.distributionScale)})"`,
  "The distribution icon must keep the shared 15% optical padding.",
);
assertCanonicalGeometry(canonicalSvg, geometry, "packages/frontend/public/icon.svg");
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

const manifest = readText("packages/frontend/public/manifest.webmanifest");
expectContains(
  manifest,
  `"theme_color": "${brandConfig.colors?.ink}"`,
  "The PWA theme color must use Instafy navy.",
);
expectContains(
  manifest,
  `"background_color": "${brandConfig.colors?.paper}"`,
  "The PWA launch background must use brand paper.",
);
expectContains(manifest, '"purpose": "maskable"', "The PWA manifest must expose maskable icons.");

const frontendIndex = readText("packages/frontend/index.html");
expectContains(
  frontendIndex,
  `<meta name="theme-color" content="${brandConfig.colors?.ink}" />`,
  "The browser theme color must use Instafy navy.",
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

checkFavicon("packages/frontend/public/favicon.ico", [16, 32, 48]);

const desktopPackage = JSON.parse(readText("packages/desktop-app/package.json") || "{}");
for (const platform of ["mac", "linux", "win"]) {
  const icon = desktopPackage.build?.[platform]?.icon;
  if (icon !== "assets/icon.png") {
    failures.push(`packages/desktop-app/package.json build.${platform}.icon must use assets/icon.png.`);
  }
}

const iosAppIconContents = readText(
  "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json",
);
expectContains(
  iosAppIconContents,
  '"filename" : "AppIcon-512@2x.png"',
  "The iOS AppIcon catalog must consume the generated 1024px icon.",
);
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
    '<monochrome android:drawable="@mipmap/ic_launcher_foreground"/>',
    `${relativePath} must expose the Android 13 themed-icon layer.`,
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

for (const stalePath of STALE_ASSET_PATHS) {
  if (fs.existsSync(resolve(stalePath))) {
    failures.push(`${stalePath} is retired artwork and must not be restored.`);
  }
}

if (failures.length > 0) {
  console.error("[check-app-icons] failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[check-app-icons] ok (${pngs.length} PNG assets)`);
