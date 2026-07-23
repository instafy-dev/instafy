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

export const PNG_ASSET_CONTRACTS = [
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
  ["packages/frontend/public/og-image.png", 1200, 630, true],
  ...androidDensities.flatMap(([density, launcher, foreground]) => {
    const directory = `packages/frontend/android/app/src/main/res/mipmap-${density}`;
    return [
      [`${directory}/ic_launcher.png`, launcher, launcher, false],
      [`${directory}/ic_launcher_round.png`, launcher, launcher, true],
      [`${directory}/ic_launcher_foreground.png`, foreground, foreground, true],
    ];
  }),
  ...splashSizes.map(([relativePath, width, height]) => [relativePath, width, height, false]),
  ...["splash-2732x2732-2.png", "splash-2732x2732-1.png", "splash-2732x2732.png"].map(
    (filename) => [
      `packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset/${filename}`,
      2732,
      2732,
      false,
    ],
  ),
];

export function createRasterColorSamples(brandNavy, brandWhite) {
  return [
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
  ];
}

export function createOpticalIconTargets(brandNavy, brandWhite) {
  const reverseColors = { ink: brandWhite, background: brandNavy };
  return [
    {
      relativePath: "packages/desktop-app/assets/icon.png",
      viewport: { x: 0, y: 0, width: 1024, height: 1024 },
      expectedInk: { width: 666, height: 704, tolerance: 4 },
      ...reverseColors,
    },
    {
      relativePath: "packages/frontend/public/icon-512.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      ...reverseColors,
    },
    {
      relativePath: "packages/frontend/public/icon-maskable-512.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      safeInsetRatio: 0.1,
      ...reverseColors,
    },
    {
      relativePath: "packages/frontend/public/apple-touch-icon.png",
      viewport: { x: 0, y: 0, width: 180, height: 180 },
      expectedInk: { width: 118, height: 123, tolerance: 2 },
      ...reverseColors,
    },
    {
      relativePath: "packages/frontend/store/google-play/en-US/images/icon.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      ...reverseColors,
    },
    {
      relativePath: "packages/frontend/store/google-play-developer-profile-icon.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      ...reverseColors,
    },
    {
      relativePath: "packages/frontend/store/github-app-badge-logo.png",
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      expectedInk: { width: 334, height: 353, tolerance: 2 },
      artworkLabel: "transparent reverse white Octo",
      ...reverseColors,
    },
    {
      relativePath: "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
      viewport: { x: 0, y: 0, width: 192, height: 192 },
      expectedInk: { width: 126, height: 133, tolerance: 2 },
      ...reverseColors,
    },
    {
      relativePath:
        "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png",
      viewport: { x: 0, y: 0, width: 192, height: 192 },
      expectedInk: { width: 126, height: 133, tolerance: 2 },
      ...reverseColors,
    },
    {
      relativePath:
        "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
      viewport: { x: 0, y: 0, width: 1024, height: 1024 },
      expectedInk: { width: 666, height: 704, tolerance: 4 },
      ...reverseColors,
    },
    {
      relativePath:
        "packages/frontend/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png",
      // Android displays the centered 72dp portion of the 108dp adaptive layer.
      viewport: { x: 72, y: 72, width: 288, height: 288 },
      expectedInk: { width: 188, height: 198, tolerance: 2 },
      ...reverseColors,
    },
  ];
}

export function createSplashTargets(brandNavy, brandWhite) {
  return [
    {
      relativePath: "packages/frontend/android/app/src/main/res/drawable/splash.png",
      viewport: { x: 0, y: 0, width: 480, height: 320 },
      expectedInk: { width: 62, height: 66, tolerance: 2 },
      artworkLabel: "positive navy Octo",
      ink: brandNavy,
      background: brandWhite,
    },
    {
      relativePath:
        "packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png",
      viewport: { x: 0, y: 0, width: 2732, height: 2732 },
      expectedInk: { width: 320, height: 339, tolerance: 4 },
      artworkLabel: "positive navy Octo",
      ink: brandNavy,
      background: brandWhite,
    },
  ];
}

export function createThemeTokenContracts(colors) {
  return [
    ["brand-ink", colors?.ink],
    ["brand-paper", colors?.paper],
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
        "/icon-192.png",
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

export const STALE_ASSET_PATHS = [
  "packages/frontend/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml",
  "packages/frontend/android/app/src/main/res/drawable/ic_launcher_background.xml",
  "packages/frontend/src/assets/side-octo.png",
];
