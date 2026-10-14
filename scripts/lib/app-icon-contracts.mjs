const androidDensities = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
];

const splashSizes = [
  ["packages/frontend/android/app/src/main/res/drawable/splash.png", 480, 320],
  ["packages/frontend/android/app/src/main/res/drawable-land-mdpi/splash.png", 480, 320],
  ["packages/frontend/android/app/src/main/res/drawable-land-hdpi/splash.png", 800, 480],
  ["packages/frontend/android/app/src/main/res/drawable-land-xhdpi/splash.png", 1280, 720],
  ["packages/frontend/android/app/src/main/res/drawable-land-xxhdpi/splash.png", 1600, 960],
  ["packages/frontend/android/app/src/main/res/drawable-land-xxxhdpi/splash.png", 1920, 1280],
  ["packages/frontend/android/app/src/main/res/drawable-port-mdpi/splash.png", 320, 480],
  ["packages/frontend/android/app/src/main/res/drawable-port-hdpi/splash.png", 480, 800],
  ["packages/frontend/android/app/src/main/res/drawable-port-xhdpi/splash.png", 720, 1280],
  ["packages/frontend/android/app/src/main/res/drawable-port-xxhdpi/splash.png", 960, 1600],
  ["packages/frontend/android/app/src/main/res/drawable-port-xxxhdpi/splash.png", 1280, 1920],
];

/**
 * The night twin of an Android splash directory (generate-app-icons.swift
 * nightDirectory). Android ranks the orientation qualifier above night mode,
 * so each land/port density gets its own night directory
 * (drawable-land-night-hdpi); a lone drawable-night would lose to
 * drawable-land-hdpi on a dark landscape device.
 */
export function androidNightDirectory(directory) {
  const orientation = /^drawable-(land|port)-(.+)$/.exec(directory);
  return orientation ? `drawable-${orientation[1]}-night-${orientation[2]}` : `${directory}-night`;
}

/** The reverse (dark mode) splash set: the same sizes under the night qualifier. */
const nightSplashSizes = splashSizes.map(([relativePath, width, height]) => {
  const directory = relativePath.split("/").at(-2);
  return [
    relativePath.replace(`/${directory}/`, `/${androidNightDirectory(directory)}/`),
    width,
    height,
  ];
});

const IOS_SPLASH_DIRECTORY = "packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset";
/** The launch screen's Splash image set: [scale, file suffix], light and dark. */
const iosSplashSlots = [
  ["1x", "-2"],
  ["2x", "-1"],
  ["3x", ""],
];
const iosSplashFilenames = iosSplashSlots.map(([, suffix]) => `splash-2732x2732${suffix}.png`);
const iosDarkSplashFilenames = iosSplashSlots.map(
  ([, suffix]) => `splash-dark-2732x2732${suffix}.png`,
);
const DARK_APPEARANCE = [{ appearance: "luminosity", value: "dark" }];
const TINTED_APPEARANCE = [{ appearance: "luminosity", value: "tinted" }];

/** The Splash image set's Contents.json images: each scale, light then dark. */
export const IOS_SPLASH_IMAGES = iosSplashSlots.flatMap(([scale], index) => [
  { filename: iosSplashFilenames[index], idiom: "universal", scale },
  {
    appearances: DARK_APPEARANCE,
    filename: iosDarkSplashFilenames[index],
    idiom: "universal",
    scale,
  },
]);
export const IOS_DARK_SPLASH_PATH = `${IOS_SPLASH_DIRECTORY}/splash-dark-2732x2732.png`;
export const ANDROID_DARK_SPLASH_PATH =
  "packages/frontend/android/app/src/main/res/drawable-night/splash.png";

// The share of the splash canvas's short side that the 64-unit drawing fills
// (generate-app-icons.swift renderSplash).
const ANDROID_SPLASH_FRACTION = 0.3;
const IOS_SPLASH_FRACTION = 0.18;

const IOS_APP_ICON_DIRECTORY =
  "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset";
/** The iOS 20 pt@2x (40 px) slot: the one AppIcon size under the crew threshold. */
export const IOS_NOTIFICATION_ICON_PATH = `${IOS_APP_ICON_DIRECTORY}/AppIcon-20@2x.png`;
/** iOS 18+ Dark appearance: the crew mark on a transparent ground. */
export const IOS_DARK_ICON_PATH = `${IOS_APP_ICON_DIRECTORY}/AppIcon-Dark-512@2x.png`;
export const IOS_DARK_NOTIFICATION_ICON_PATH = `${IOS_APP_ICON_DIRECTORY}/AppIcon-Dark-20@2x.png`;
/** iOS 18+ Tinted appearance: one ink, white on black, fully opaque greyscale. */
export const IOS_TINTED_ICON_PATH = `${IOS_APP_ICON_DIRECTORY}/AppIcon-Tinted-512@2x.png`;
export const IOS_TINTED_NOTIFICATION_ICON_PATH = `${IOS_APP_ICON_DIRECTORY}/AppIcon-Tinted-20@2x.png`;

/**
 * The iOS AppIcon catalog: the single-size 1024 px crew icon that Xcode
 * derives every size from, plus an explicit one-ink 20 pt@2x slot so the
 * 40 px notification icon is not a downscaled crew tile; each in the default
 * (any), Dark and Tinted appearances of iOS 18 and later.
 */
export const IOS_APP_ICON_IMAGES = [
  ["AppIcon-20@2x.png", "20x20", "2x", null],
  ["AppIcon-Dark-20@2x.png", "20x20", "2x", DARK_APPEARANCE],
  ["AppIcon-Tinted-20@2x.png", "20x20", "2x", TINTED_APPEARANCE],
  ["AppIcon-512@2x.png", "1024x1024", null, null],
  ["AppIcon-Dark-512@2x.png", "1024x1024", null, DARK_APPEARANCE],
  ["AppIcon-Tinted-512@2x.png", "1024x1024", null, TINTED_APPEARANCE],
].map(([filename, size, scale, appearances]) => ({
  ...(appearances ? { appearances } : {}),
  filename,
  idiom: "universal",
  platform: "ios",
  ...(scale ? { scale } : {}),
  size,
}));

export const PNG_ASSET_CONTRACTS = [
  ["packages/frontend/public/icon-32.png", 32, 32, false],
  ["packages/frontend/public/icon-192.png", 192, 192, false],
  ["packages/frontend/public/icon-512.png", 512, 512, false],
  ["packages/frontend/public/icon.png", 1024, 1024, false],
  ["packages/frontend/public/apple-touch-icon.png", 180, 180, false],
  ["packages/frontend/public/icon-maskable-192.png", 192, 192, false],
  ["packages/frontend/public/icon-maskable-512.png", 512, 512, false],
  ["packages/frontend/store/google-play/en-US/images/icon.png", 512, 512, true, 6],
  ["packages/frontend/store/google-play-developer-profile-icon.png", 512, 512, true, 6],
  ["packages/frontend/store/github-app-badge-logo.png", 512, 512, true, 6],
  ["packages/desktop-app/assets/icon.png", 1024, 1024, true],
  [
    "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
    1024,
    1024,
    false,
  ],
  [IOS_NOTIFICATION_ICON_PATH, 40, 40, false],
  // Dark keeps its alpha (the system background shows through); Tinted is
  // opaque and RGB (color type 2), never a grey color space.
  [IOS_DARK_ICON_PATH, 1024, 1024, true, 6],
  [IOS_DARK_NOTIFICATION_ICON_PATH, 40, 40, true, 6],
  [IOS_TINTED_ICON_PATH, 1024, 1024, false, 2],
  [IOS_TINTED_NOTIFICATION_ICON_PATH, 40, 40, false, 2],
  // The social card is opaque RGB: some unfurlers composite a transparent
  // card on black. scripts/generate-og-image.mjs writes it.
  ["packages/frontend/public/og-image.png", 1200, 630, false, 2],
  ...androidDensities.flatMap(([density, launcher, foreground]) => {
    const directory = `packages/frontend/android/app/src/main/res/mipmap-${density}`;
    return [
      [`${directory}/ic_launcher.png`, launcher, launcher, false],
      [`${directory}/ic_launcher_round.png`, launcher, launcher, true],
      [`${directory}/ic_launcher_foreground.png`, foreground, foreground, true],
      [`${directory}/ic_launcher_monochrome.png`, foreground, foreground, true],
    ];
  }),
  ...[...splashSizes, ...nightSplashSizes].map(([relativePath, width, height]) => [
    relativePath,
    width,
    height,
    false,
    2,
  ]),
  ...[...iosSplashFilenames, ...iosDarkSplashFilenames].map((filename) => [
    `${IOS_SPLASH_DIRECTORY}/${filename}`,
    2732,
    2732,
    false,
    2,
  ]),
];

export function createRasterColorSamples(brandNavy, brandWhite, canvasDark) {
  return [
    ["packages/frontend/public/icon-32.png", 0, 0, [...brandNavy, 255]],
    ["packages/frontend/public/icon-512.png", 0, 0, [...brandNavy, 255]],
    ["packages/frontend/public/icon-maskable-512.png", 0, 0, [...brandNavy, 255]],
    ["packages/frontend/public/apple-touch-icon.png", 0, 0, [...brandNavy, 255]],
    ["packages/frontend/store/google-play/en-US/images/icon.png", 0, 0, [...brandNavy, 255]],
    ["packages/frontend/store/google-play-developer-profile-icon.png", 0, 0, [...brandNavy, 255]],
    ["packages/frontend/store/github-app-badge-logo.png", 0, 0, [0, 0, 0, 0]],
    ["packages/frontend/store/github-app-badge-logo.png", 256, 200, [...brandWhite, 255]],
    ["packages/desktop-app/assets/icon.png", 512, 24, [...brandNavy, 255]],
    [
      "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
      0,
      0,
      [...brandNavy, 255],
    ],
    [IOS_NOTIFICATION_ICON_PATH, 0, 0, [...brandNavy, 255]],
    [
      "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
      0,
      0,
      [...brandNavy, 255],
    ],
    [
      "packages/frontend/android/app/src/main/res/drawable/splash.png",
      0,
      0,
      [...brandWhite, 255],
    ],
    [
      "packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png",
      0,
      0,
      [...brandWhite, 255],
    ],
    // The reverse splash is opaque dark canvas edge to edge, every corner.
    ...[...nightSplashSizes, [IOS_DARK_SPLASH_PATH, 2732, 2732]].flatMap(
      ([relativePath, width, height]) =>
        [
          [0, 0],
          [width - 1, 0],
          [0, height - 1],
          [width - 1, height - 1],
        ].map(([x, y]) => [relativePath, x, y, [...canvasDark, 255]]),
    ),
    // iOS Dark: a transparent ground; iOS Tinted: an opaque black ground.
    [IOS_DARK_ICON_PATH, 0, 0, [0, 0, 0, 0]],
    [IOS_DARK_ICON_PATH, 512, 40, [0, 0, 0, 0]],
    [IOS_DARK_NOTIFICATION_ICON_PATH, 0, 0, [0, 0, 0, 0]],
    [IOS_TINTED_ICON_PATH, 0, 0, [0, 0, 0, 255]],
    [IOS_TINTED_ICON_PATH, 512, 40, [0, 0, 0, 255]],
    [IOS_TINTED_NOTIFICATION_ICON_PATH, 0, 0, [0, 0, 0, 255]],
  ];
}

/**
 * Every crew asset and where its 64-unit drawing sits, so the checker can find
 * each node's center. Crew assets draw the main cut at the shared distribution
 * scale; a placement is the square the 64-unit drawing fills. Tiles take the
 * dark set (on brand ink); the native splash takes the light set (on paper).
 * Maskable tiles draw the mark at `maskableScale` instead, so their square is
 * the tile shrunk by maskableScale / distributionScale about its center.
 */
export function createCrewNodeTargets(
  { crewLight, crewDark },
  { distributionScale, maskableScale },
) {
  const square = (relativePath, side) => ({
    relativePath,
    placement: { x: 0, y: 0, side },
    nodeColors: crewDark,
  });
  const maskable = (relativePath, side) => {
    const drawn = (side * maskableScale) / distributionScale;
    return {
      relativePath,
      placement: { x: (side - drawn) / 2, y: (side - drawn) / 2, side: drawn },
      nodeColors: crewDark,
    };
  };
  const splash = (relativePath, width, height, fraction, nodeColors = crewLight) => {
    const side = Math.min(width, height) * fraction;
    return {
      relativePath,
      placement: { x: (width - side) / 2, y: (height - side) / 2, side },
      nodeColors,
    };
  };
  return [
    square("packages/frontend/public/icon-192.png", 192),
    square("packages/frontend/public/icon-512.png", 512),
    square("packages/frontend/public/icon.png", 1024),
    square("packages/frontend/public/apple-touch-icon.png", 180),
    maskable("packages/frontend/public/icon-maskable-192.png", 192),
    maskable("packages/frontend/public/icon-maskable-512.png", 512),
    square("packages/frontend/store/google-play/en-US/images/icon.png", 512),
    square("packages/frontend/store/google-play-developer-profile-icon.png", 512),
    square("packages/desktop-app/assets/icon.png", 1024),
    square(
      "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
      1024,
    ),
    // iOS Dark keeps the crew tile's mark (white body, dark set) on alpha.
    square(IOS_DARK_ICON_PATH, 1024),
    ...androidDensities.flatMap(([density, launcher, foreground]) => {
      const directory = `packages/frontend/android/app/src/main/res/mipmap-${density}`;
      // Android shows the centered 72dp of the 108dp adaptive layer.
      const viewport = (foreground * 72) / 108;
      const inset = (foreground - viewport) / 2;
      return [
        square(`${directory}/ic_launcher.png`, launcher),
        square(`${directory}/ic_launcher_round.png`, launcher),
        {
          relativePath: `${directory}/ic_launcher_foreground.png`,
          placement: { x: inset, y: inset, side: viewport },
          nodeColors: crewDark,
        },
      ];
    }),
    ...splashSizes.map(([relativePath, width, height]) =>
      splash(relativePath, width, height, ANDROID_SPLASH_FRACTION),
    ),
    ...iosSplashFilenames.map((filename) =>
      splash(`${IOS_SPLASH_DIRECTORY}/${filename}`, 2732, 2732, IOS_SPLASH_FRACTION),
    ),
    // The reverse splash: the white body takes the dark crew set.
    ...nightSplashSizes.map(([relativePath, width, height]) =>
      splash(relativePath, width, height, ANDROID_SPLASH_FRACTION, crewDark),
    ),
    ...iosDarkSplashFilenames.map((filename) =>
      splash(`${IOS_SPLASH_DIRECTORY}/${filename}`, 2732, 2732, IOS_SPLASH_FRACTION, crewDark),
    ),
  ];
}

/**
 * Assets that must stay one ink (body and nodes in the same color), and why.
 * Transparent assets are judged over the surface they are shown on.
 */
export function createOneInkTargets({ navy, white, canvasDark }) {
  const androidMonochrome = androidDensities.map(([density]) => ({
    relativePath: `packages/frontend/android/app/src/main/res/mipmap-${density}/ic_launcher_monochrome.png`,
    ink: white,
    background: navy,
    reason: "one ink: the Android themed icon is a mask the OS recolors",
    matchesAlphaOf: `packages/frontend/android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`,
  }));
  return [
    {
      relativePath: "packages/frontend/public/icon-32.png",
      ink: white,
      background: navy,
      reason: "one ink: a favicon tile is under the crew threshold",
    },
    {
      relativePath: "packages/frontend/store/github-app-badge-logo.png",
      ink: white,
      background: navy,
      reason: "one ink: GitHub shows the badge down to 20 px",
    },
    {
      relativePath: IOS_NOTIFICATION_ICON_PATH,
      ink: white,
      background: navy,
      reason: "one ink: the 40 px iOS slot is under the crew threshold",
    },
    {
      relativePath: IOS_DARK_NOTIFICATION_ICON_PATH,
      ink: white,
      background: canvasDark,
      transparentGround: true,
      reason: "one ink: the 40 px iOS Dark slot is under the crew threshold",
    },
    ...[IOS_TINTED_ICON_PATH, IOS_TINTED_NOTIFICATION_ICON_PATH].map((relativePath) => ({
      relativePath,
      ink: white,
      background: [0, 0, 0],
      greyscale: true,
      reason: "one ink: the iOS Tinted icon is a greyscale image the system tints",
    })),
    ...androidMonochrome,
  ];
}

/**
 * The mark's ink box at the 0.85 distribution scale: 667.6 x 705.3 px on a
 * 1024 px tile (the main cut's ink box is 49.09 x 51.86 units).
 */
const DISTRIBUTION_INK = { width: 667.6 / 1024, height: 705.3 / 1024 };
/**
 * The same mark drawn full-bleed: its height spans 56 of 64 units (a 4-unit
 * margin, FULL_BLEED_MARGIN) and its width keeps the mark's own proportions.
 */
const FULL_BLEED_INK = {
  width: (56 / 64) * (DISTRIBUTION_INK.width / DISTRIBUTION_INK.height),
  height: 56 / 64,
};

/**
 * The ink box of the mark on a square tile of `side` device px, at the
 * distribution scale ("distribution") or full-bleed ("full-bleed").
 */
export function expectedTileInk(side, fit) {
  const tolerance = Math.max(1, Math.round(side / 256));
  const ink = fit === "full-bleed" ? FULL_BLEED_INK : DISTRIBUTION_INK;
  return { width: ink.width * side, height: ink.height * side, tolerance };
}

/**
 * favicon.ico is a monochrome context: every entry is one ink and draws the
 * main cut. The 16 and 32 entries serve a 16 CSS px tab at 1x and 2x, so they
 * draw it full-bleed (56 of 64 units tall); the 48 entry keeps the
 * distribution scale.
 */
export const FAVICON_ENTRY_CONTRACTS = [
  { size: 16, fit: "full-bleed", expectedInk: { ...expectedTileInk(16, "full-bleed"), tolerance: 1 } },
  { size: 32, fit: "full-bleed", expectedInk: { ...expectedTileInk(32, "full-bleed"), tolerance: 1 } },
  { size: 48, fit: "distribution", expectedInk: { width: 32, height: 33, tolerance: 2 } },
];

/**
 * The desktop icons. electron-builder uses icon.icns for macOS and icon.ico
 * for Windows as they are, and derives the Linux sizes from icon.png. Every
 * representation draws the main cut at its own size: under the crew threshold
 * it is one ink, and the 16 pt macOS slots and the 16/24 px Windows entries
 * draw it full-bleed. Windows gets classic DIB entries under 256 px and one
 * PNG-compressed 256 px entry.
 */
export const DESKTOP_ICON_PNG_PATH = "packages/desktop-app/assets/icon.png";
export const DESKTOP_ICNS_PATH = "packages/desktop-app/assets/icon.icns";
export const DESKTOP_ICO_PATH = "packages/desktop-app/assets/icon.ico";
export const DESKTOP_BUILD_ICONS = {
  mac: "assets/icon.icns",
  win: "assets/icon.ico",
  linux: "assets/icon.png",
};
/**
 * Apple's macOS icon grid (generate-app-icons.swift macGridBody): an 824 px
 * body in a 1024 px canvas, the margin rounded to whole pixels half away from
 * zero, as Apple's own icons are cut: 16 -> 12, 32 -> 26, 64 -> 52,
 * 128 -> 102, 256 -> 206, 512 -> 412, 1024 -> 824.
 */
export function macGridBody(side) {
  const inset = Math.round((side * 100) / 1024);
  return { inset, body: side - 2 * inset };
}

/**
 * Every icon.icns representation sits on the macOS grid (`grid: true`): the
 * rounded brand-ink body with transparent margins. Crew and fit are judged on
 * the body's device px, so the 32 pt slot (a 26 px body) stays one ink; the
 * 16 pt slots draw the mark full-bleed into their 12 and 26 px bodies.
 */
export const DESKTOP_ICNS_CONTRACTS = [
  { type: "ic04", side: 16, fit: "full-bleed", crew: false },
  { type: "ic11", side: 32, fit: "full-bleed", crew: false },
  { type: "ic05", side: 32, fit: "distribution", crew: false },
  { type: "ic12", side: 64, fit: "distribution", crew: true },
  { type: "ic07", side: 128, fit: "distribution", crew: true },
  { type: "ic13", side: 256, fit: "distribution", crew: true },
  { type: "ic08", side: 256, fit: "distribution", crew: true },
  { type: "ic14", side: 512, fit: "distribution", crew: true },
  { type: "ic09", side: 512, fit: "distribution", crew: true },
  { type: "ic10", side: 1024, fit: "distribution", crew: true },
].map((contract) => ({ ...contract, grid: true }));
export const DESKTOP_ICO_CONTRACTS = [
  { side: 16, fit: "full-bleed", crew: false, format: "bmp" },
  { side: 24, fit: "full-bleed", crew: false, format: "bmp" },
  { side: 32, fit: "distribution", crew: false, format: "bmp" },
  { side: 48, fit: "distribution", crew: true, format: "bmp" },
  { side: 64, fit: "distribution", crew: true, format: "bmp" },
  { side: 128, fit: "distribution", crew: true, format: "bmp" },
  { side: 256, fit: "distribution", crew: true, format: "png" },
];

/** The PNG favicon fallback matches favicon.ico's 32 px full-bleed entry. */
export const PNG_FAVICON_TARGET = {
  relativePath: "packages/frontend/public/icon-32.png",
  viewport: { x: 0, y: 0, width: 32, height: 32 },
  expectedInk: { ...expectedTileInk(32, "full-bleed"), tolerance: 1 },
  artworkLabel: "one-ink full-bleed Octo",
};

/** W3C maskable icons keep their content inside a centered circle of 40% radius. */
const MASKABLE_SAFE_CIRCLE = { radiusRatio: 0.4, zone: "the W3C maskable safe zone" };
/** Android adaptive layers keep their content inside a 66dp circle of the 108dp layer. */
const ADAPTIVE_SAFE_CIRCLE = {
  radiusRatio: 33 / 108,
  zone: "the Android adaptive-icon safe zone (66dp of 108dp)",
};

/**
 * Icons whose ink box is measured. Targets in the same `opticalGroup` must
 * share their ink ratios with the group's first target; maskable tiles draw
 * the mark at maskableScale and form their own group.
 */
export function createOpticalIconTargets({ navy, white, crewDark, canvasDark }) {
  const crewTile = { ink: white, nodeColors: crewDark, background: navy };
  const oneInkReverse = { ink: white, nodeColors: null, background: navy };
  const maskableTile = {
    ...crewTile,
    opticalGroup: "maskable",
    safeInsetRatio: 0.1,
    safeCircle: MASKABLE_SAFE_CIRCLE,
  };
  return [
    {
      relativePath: "packages/desktop-app/assets/icon.png",
      viewport: { x: 0, y: 0, width: 1024, height: 1024 },
      expectedInk: { width: 666, height: 704, tolerance: 4 },
      ...crewTile,
    },
    {
      relativePath: "packages/frontend/public/icon-512.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      ...crewTile,
    },
    {
      relativePath: "packages/frontend/public/icon-maskable-512.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 306, height: 323, tolerance: 2 },
      ...maskableTile,
    },
    {
      relativePath: "packages/frontend/public/icon-maskable-192.png",
      viewport: { x: 0, y: 0, width: 192, height: 192 },
      expectedInk: { width: 114, height: 120, tolerance: 2 },
      ...maskableTile,
    },
    {
      relativePath: "packages/frontend/public/apple-touch-icon.png",
      viewport: { x: 0, y: 0, width: 180, height: 180 },
      expectedInk: { width: 118, height: 123, tolerance: 2 },
      ...crewTile,
    },
    {
      relativePath: "packages/frontend/store/google-play/en-US/images/icon.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      ...crewTile,
    },
    {
      relativePath: "packages/frontend/store/google-play-developer-profile-icon.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      ...crewTile,
    },
    {
      relativePath: "packages/frontend/store/github-app-badge-logo.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      artworkLabel: "transparent reverse white Octo",
      ...oneInkReverse,
    },
    {
      relativePath: "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
      viewport: { x: 0, y: 0, width: 192, height: 192 },
      expectedInk: { width: 126, height: 133, tolerance: 2 },
      ...crewTile,
    },
    {
      relativePath:
        "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png",
      viewport: { x: 0, y: 0, width: 192, height: 192 },
      expectedInk: { width: 126, height: 133, tolerance: 2 },
      ...crewTile,
    },
    {
      relativePath:
        "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
      viewport: { x: 0, y: 0, width: 1024, height: 1024 },
      expectedInk: { width: 666, height: 704, tolerance: 4 },
      ...crewTile,
    },
    // The iOS Dark and Tinted appearances place the mark exactly as the
    // default icon does (same optical group). Dark is judged over the dark
    // canvas, a stand-in for the system's dark background behind its alpha.
    {
      relativePath: IOS_DARK_ICON_PATH,
      viewport: { x: 0, y: 0, width: 1024, height: 1024 },
      expectedInk: { width: 666, height: 704, tolerance: 4 },
      artworkLabel: "crew Octo on a transparent ground",
      ...crewTile,
      background: canvasDark,
    },
    {
      relativePath: IOS_TINTED_ICON_PATH,
      viewport: { x: 0, y: 0, width: 1024, height: 1024 },
      expectedInk: { width: 666, height: 704, tolerance: 4 },
      artworkLabel: "one-ink white Octo on black",
      ink: white,
      nodeColors: null,
      background: [0, 0, 0],
    },
    {
      relativePath:
        "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png",
      // Android displays the centered 72dp portion of the 108dp adaptive layer.
      viewport: { x: 72, y: 72, width: 288, height: 288 },
      expectedInk: { width: 188, height: 198, tolerance: 2 },
      safeCircle: ADAPTIVE_SAFE_CIRCLE,
      ...crewTile,
    },
    {
      relativePath:
        "packages/frontend/android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png",
      viewport: { x: 18, y: 18, width: 72, height: 72 },
      expectedInk: { width: 47, height: 50, tolerance: 2 },
      safeCircle: ADAPTIVE_SAFE_CIRCLE,
      // A 72 px viewport rounds too coarsely for the 1% ratio match; its own
      // group checks only its ink box, centering and safe zone.
      opticalGroup: "adaptive-mdpi",
      ...crewTile,
    },
    {
      relativePath:
        "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_monochrome.png",
      viewport: { x: 72, y: 72, width: 288, height: 288 },
      expectedInk: { width: 188, height: 198, tolerance: 2 },
      artworkLabel: "one-ink themed-icon Octo",
      ...oneInkReverse,
    },
  ];
}

export function createSplashTargets({ navy, white, crewLight, crewDark, canvasDark }) {
  const crewPositive = {
    artworkLabel: "positive crew Octo",
    ink: navy,
    nodeColors: crewLight,
    background: white,
  };
  const crewReverse = {
    artworkLabel: "reverse crew Octo",
    ink: white,
    nodeColors: crewDark,
    background: canvasDark,
  };
  return [
    {
      relativePath: "packages/frontend/android/app/src/main/res/drawable/splash.png",
      viewport: { x: 0, y: 0, width: 480, height: 320 },
      expectedInk: { width: 62, height: 66, tolerance: 2 },
      ...crewPositive,
    },
    {
      relativePath:
        "packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png",
      viewport: { x: 0, y: 0, width: 2732, height: 2732 },
      expectedInk: { width: 320, height: 339, tolerance: 4 },
      ...crewPositive,
    },
    // The reverse splash matches its positive twin's size and placement.
    {
      relativePath: ANDROID_DARK_SPLASH_PATH,
      viewport: { x: 0, y: 0, width: 480, height: 320 },
      expectedInk: { width: 62, height: 66, tolerance: 2 },
      ...crewReverse,
    },
    {
      relativePath: IOS_DARK_SPLASH_PATH,
      viewport: { x: 0, y: 0, width: 2732, height: 2732 },
      expectedInk: { width: 320, height: 339, tolerance: 4 },
      ...crewReverse,
    },
    {
      relativePath: "packages/frontend/android/app/src/main/res/drawable-port-night-xxxhdpi/splash.png",
      viewport: { x: 0, y: 0, width: 1280, height: 1920 },
      expectedInk: { width: 250, height: 264, tolerance: 3 },
      ...crewReverse,
    },
    {
      relativePath: "packages/frontend/android/app/src/main/res/drawable-land-night-xxxhdpi/splash.png",
      viewport: { x: 0, y: 0, width: 1920, height: 1280 },
      expectedInk: { width: 250, height: 264, tolerance: 3 },
      ...crewReverse,
    },
  ];
}

/**
 * The crew colors in src/styles/tailwind.css: the light set on :root, and on
 * .dark only the slots whose dark value differs (green and violet lift).
 */
export function createCrewTokenContracts(crew) {
  return [
    ...(crew?.light ?? []).map((value, index) => [":root", `--crew-${index + 1}`, value]),
    ...(crew?.dark ?? []).flatMap((value, index) =>
      value === crew.light[index] ? [] : [[".dark", `--crew-${index + 1}`, value]],
    ),
  ];
}

export function createThemeTokenContracts(colors) {
  return [
    ["brand-ink", colors?.ink],
    ["brand-paper", colors?.paper],
    ["studio-dark-canvas", colors?.canvasDark],
    ["brand-blue", colors?.interaction],
    ["brand-blue-dark", colors?.interactionDark],
    ["brand-sand", colors?.sand],
    ["brand-sand-dark", colors?.sandDark],
  ];
}

export function createRevisionedAssetContracts({ frontendIndex, manifest, serviceWorker }) {
  return [
    [
      "packages/frontend/index.html",
      frontendIndex,
      [
        "/manifest.webmanifest",
        "/apple-touch-icon.png",
        "/icon.svg",
        "/favicon.ico",
        "/icon-32.png",
      ],
    ],
    [
      "packages/frontend/public/manifest.webmanifest",
      manifest,
      [
        "/icon-192.png",
        "/icon-512.png",
        "/icon.png",
        "/icon-maskable-192.png",
        "/icon-maskable-512.png",
      ],
    ],
    [
      "packages/frontend/public/sw.js",
      serviceWorker,
      [
        "/manifest.webmanifest",
        "/favicon.ico",
        "/icon.svg",
        "/icon-32.png",
        "/apple-touch-icon.png",
        "/icon-192.png",
        "/icon-512.png",
        "/icon-maskable-192.png",
        "/icon-maskable-512.png",
        "/icon.png",
      ],
    ],
  ];
}

/**
 * The only files a page may offer as rel="icon": the adaptive full-bleed SVG
 * and the one-ink favicon tiles. A crew tile (icon-192 and up) would be downscaled
 * into a 16 px tab, where its nodes become specks.
 */
export const FAVICON_LINK_PATHS = ["/icon.svg", "/favicon.ico", "/icon-32.png"];

export const GOOGLE_PLAY_ICON_PATHS = [
  "packages/frontend/store/google-play/en-US/images/icon.png",
  "packages/frontend/store/google-play-developer-profile-icon.png",
];

export const GITHUB_BADGE_ICON_PATHS = [
  "packages/frontend/store/github-app-badge-logo.png",
];

export const ADAPTIVE_ICON_PATHS = [
  "packages/frontend/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
  "packages/frontend/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml",
];

/**
 * Android's generated launch ground (generate-app-icons.swift): brand paper,
 * and the dark canvas under the night qualifier.
 */
export const ANDROID_SPLASH_BACKGROUND_PATHS = {
  light: "packages/frontend/android/app/src/main/res/values/splash_background.xml",
  dark: "packages/frontend/android/app/src/main/res/values-night/splash_background.xml",
};

/**
 * The Android launch theme (AppTheme.NoActionBarLaunch) in values and its
 * reverse twin in values-night: the splash drawable, the generated ground on
 * the Android 12+ system splash and both system bars, and the bar icon tone
 * (dark icons on paper, light icons on the dark canvas).
 */
export const ANDROID_LAUNCH_THEME_CONTRACTS = [
  ["packages/frontend/android/app/src/main/res/values/styles.xml", "true"],
  ["packages/frontend/android/app/src/main/res/values-night/styles.xml", "false"],
].map(([relativePath, lightBars]) => ({
  relativePath,
  items: [
    '<item name="android:background">@drawable/splash</item>',
    '<item name="windowSplashScreenBackground">@color/splash_background</item>',
    '<item name="android:statusBarColor">@color/splash_background</item>',
    '<item name="android:navigationBarColor">@color/splash_background</item>',
    `<item name="android:windowLightStatusBar">${lightBars}</item>`,
    `<item name="android:windowLightNavigationBar" tools:targetApi="27">${lightBars}</item>`,
  ],
}));

export const STALE_ASSET_PATHS = [
  "packages/frontend/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml",
  "packages/frontend/android/app/src/main/res/drawable/ic_launcher_background.xml",
  "packages/frontend/src/assets/side-octo.png",
  // The retired small cut, a redraw that drifted from the logo: one logo is
  // drawn at every size.
  "packages/frontend/src/assets/octo-mark-small.geometry.json",
];
