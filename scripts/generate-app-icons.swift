#!/usr/bin/env swift

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Keep octo-mark.geometry.json as the single source for Octo's curves and nodes.
// This script derives the browser SVG, in-product avatar, and every native raster
// while preserving each platform's alpha channel, safe zone, and background.

let repoRoot = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
let fileManager = FileManager.default

func url(_ relativePath: String) -> URL {
  repoRoot.appendingPathComponent(relativePath)
}

struct OctoCircle: Decodable {
  let cx: Double
  let cy: Double
  let r: Double
}

struct OctoGeometry: Decodable {
  let viewBox: String
  let transform: String
  let paths: [String]
  let circles: [OctoCircle]
}

struct AppIconBrandColors: Decodable {
  let ink: String
  let paper: String
}

struct AppIconBrandConfig: Decodable {
  let cacheRevision: Int
  let distributionScale: Double
  let colors: AppIconBrandColors
}

let geometryURL = url("packages/frontend/src/assets/octo-mark.geometry.json")
let geometry = try JSONDecoder().decode(
  OctoGeometry.self,
  from: Data(contentsOf: geometryURL)
)
let brandConfigURL = url("scripts/app-icon-brand.json")
let brandConfig = try JSONDecoder().decode(
  AppIconBrandConfig.self,
  from: Data(contentsOf: brandConfigURL)
)
guard geometry.paths.count == 5, geometry.circles.count == 4 else {
  fputs("Canonical Octo geometry must contain five paths and four nodes.\n", stderr)
  exit(1)
}
guard brandConfig.cacheRevision > 0,
      brandConfig.distributionScale > 0,
      brandConfig.distributionScale <= 1 else {
  fputs("App icon brand config must contain a positive revision and scale in (0, 1].\n", stderr)
  exit(1)
}

func color(from hex: String) throws -> NSColor {
  let normalized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
  guard normalized.count == 7,
        normalized.first == "#",
        let rgb = UInt32(normalized.dropFirst(), radix: 16) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 6,
      userInfo: [NSLocalizedDescriptionKey: "Invalid six-digit sRGB color: \(hex)"]
    )
  }
  return NSColor(
    srgbRed: CGFloat((rgb >> 16) & 0xff) / 255,
    green: CGFloat((rgb >> 8) & 0xff) / 255,
    blue: CGFloat(rgb & 0xff) / 255,
    alpha: 1
  )
}

let distributionScale = brandConfig.distributionScale
let canvasSide = 64.0
let distributionOffset = (canvasSide * (1 - distributionScale)) / 2
let brandNavyHex = brandConfig.colors.ink.lowercased()
let brandWhiteHex = brandConfig.colors.paper.lowercased()
let brandNavy = try color(from: brandNavyHex)
let brandWhite = try color(from: brandWhiteHex)

func svgNumber(_ value: Double) -> String {
  var result = String(
    format: "%.4f",
    locale: Locale(identifier: "en_US_POSIX"),
    value
  )
  while result.last == "0" { result.removeLast() }
  if result.last == "." { result.removeLast() }
  return result
}

func xmlEscaped(_ value: String) -> String {
  value
    .replacingOccurrences(of: "&", with: "&amp;")
    .replacingOccurrences(of: "\"", with: "&quot;")
    .replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;")
}

func makeOctoSvg(
  ariaLabel: String,
  backgroundColor: String? = nil,
  inkColor: String = brandNavyHex,
  darkModeInkColor: String? = nil
) -> String {
  let paths = geometry.paths
    .map { "      <path d=\"\(xmlEscaped($0))\"/>" }
    .joined(separator: "\n")
  let circles = geometry.circles
    .map {
      "      <circle cx=\"\(svgNumber($0.cx))\" cy=\"\(svgNumber($0.cy))\" r=\"\(svgNumber($0.r))\"/>"
    }
    .joined(separator: "\n")
  let background = backgroundColor.map {
    "  <circle cx=\"32\" cy=\"32\" r=\"32\" fill=\"\($0)\"/>\n"
  } ?? ""
  let style = darkModeInkColor.map {
    """
      <style>
        .octo-ink { fill: \(inkColor); }
        @media (prefers-color-scheme: dark) { .octo-ink { fill: \($0); } }
      </style>

    """
  } ?? ""
  let inkAttribute = darkModeInkColor == nil
    ? "fill=\"\(inkColor)\""
    : "class=\"octo-ink\""
  return """
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="\(geometry.viewBox)" width="64" height="64" role="img" aria-label="\(xmlEscaped(ariaLabel))">
  \(style)\(background)  <g transform="translate(\(svgNumber(distributionOffset)) \(svgNumber(distributionOffset))) scale(\(svgNumber(distributionScale)))">
      <g \(inkAttribute) transform="\(xmlEscaped(geometry.transform))">
  \(paths)
  \(circles)
      </g>
    </g>
  </svg>

  """
}

let sourceURL = url("packages/frontend/public/icon.svg")
let avatarURL = url("packages/frontend/src/assets/octo-avatar.svg")
try makeOctoSvg(
  ariaLabel: "Instafy",
  darkModeInkColor: brandWhiteHex
)
  .write(to: sourceURL, atomically: true, encoding: .utf8)
try makeOctoSvg(
  ariaLabel: "Octo",
  backgroundColor: brandWhiteHex
)
  .write(to: avatarURL, atomically: true, encoding: .utf8)
print("wrote packages/frontend/public/icon.svg")
print("wrote packages/frontend/src/assets/octo-avatar.svg")

guard
  let navyOctoData = makeOctoSvg(ariaLabel: "Instafy raster source")
    .data(using: .utf8),
  let whiteOctoData = makeOctoSvg(
    ariaLabel: "Instafy reverse raster source",
    inkColor: brandWhiteHex
  ).data(using: .utf8),
  let navyOcto = NSImage(data: navyOctoData),
  let whiteOcto = NSImage(data: whiteOctoData)
else {
  fputs("Unable to load generated canonical raster sources.\n", stderr)
  exit(1)
}

func drawOcto(_ image: NSImage, in rect: NSRect) {
  NSGraphicsContext.current?.imageInterpolation = .high
  image.draw(
    in: rect,
    from: NSRect(origin: .zero, size: image.size),
    operation: .sourceOver,
    fraction: 1
  )
}

func renderPNG(
  at outputURL: URL,
  width: Int,
  height: Int,
  opaque: Bool,
  logOutput: Bool = true,
  draw: (NSRect) -> Void
) throws {
  try fileManager.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )

  guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Unable to create sRGB color space"]
    )
  }

  let alphaInfo: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
  let bitmapInfo = CGBitmapInfo(rawValue: alphaInfo.rawValue).union(.byteOrder32Big)
  guard let cgContext = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo.rawValue
  ) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 2,
      userInfo: [NSLocalizedDescriptionKey: "Unable to create \(width)x\(height) bitmap context"]
    )
  }

  let graphicsContext = NSGraphicsContext(cgContext: cgContext, flipped: false)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = graphicsContext
  let canvas = NSRect(x: 0, y: 0, width: width, height: height)
  if opaque {
    brandWhite.setFill()
    canvas.fill()
  } else {
    cgContext.clear(canvas)
  }
  draw(canvas)
  cgContext.flush()
  NSGraphicsContext.restoreGraphicsState()

  guard let image = cgContext.makeImage() else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 3,
      userInfo: [NSLocalizedDescriptionKey: "Unable to make image for \(outputURL.path)"]
    )
  }
  guard let destination = CGImageDestinationCreateWithURL(
    outputURL as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
  ) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 4,
      userInfo: [NSLocalizedDescriptionKey: "Unable to create PNG destination at \(outputURL.path)"]
    )
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 5,
      userInfo: [NSLocalizedDescriptionKey: "Unable to encode \(outputURL.path) as PNG"]
    )
  }
  if logOutput {
    print("wrote \(outputURL.path.replacingOccurrences(of: repoRoot.path + "/", with: ""))")
  }
}

func renderReverseSquare(_ relativePath: String, size: Int, opaque: Bool) throws {
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: opaque) { canvas in
    brandNavy.setFill()
    canvas.fill()
    drawOcto(whiteOcto, in: canvas)
  }
}

func renderStoreSquare(_ relativePath: String, size: Int) throws {
  // Google Play requires a 32-bit PNG. Keep an explicit alpha channel even
  // though the reverse tile's visual background is intentionally opaque.
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    brandNavy.setFill()
    canvas.fill()
    drawOcto(whiteOcto, in: canvas)
  }
}

func renderGitHubBadgeLogo(_ relativePath: String, size: Int) throws {
  // GitHub supplies the circular badge background separately. Keep only the
  // reverse Octo in this file so the same upload works in GitHub App and OAuth
  // App settings without introducing a square tile or double background.
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    drawOcto(whiteOcto, in: canvas)
  }
}

func renderDesktopIcon(_ relativePath: String, size: Int) throws {
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    brandNavy.setFill()
    NSBezierPath(
      roundedRect: canvas,
      xRadius: canvas.width * 0.22,
      yRadius: canvas.height * 0.22
    ).fill()
    drawOcto(whiteOcto, in: canvas)
  }
}

func renderFavicon() throws {
  let temporaryDirectory = fileManager.temporaryDirectory
    .appendingPathComponent("instafy-favicon-\(UUID().uuidString)", isDirectory: true)
  try fileManager.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
  defer { try? fileManager.removeItem(at: temporaryDirectory) }

  var images: [(size: Int, data: Data)] = []
  for size in [16, 32, 48] {
    let imageURL = temporaryDirectory.appendingPathComponent("icon-\(size).png")
    try renderPNG(
      at: imageURL,
      width: size,
      height: size,
      opaque: false,
      logOutput: false
    ) { canvas in
      brandNavy.setFill()
      canvas.fill()
      drawOcto(whiteOcto, in: canvas)
    }
    images.append((size, try Data(contentsOf: imageURL)))
  }

  var ico = Data()
  appendUInt16LE(0, to: &ico)
  appendUInt16LE(1, to: &ico)
  appendUInt16LE(UInt16(images.count), to: &ico)
  var offset = 6 + images.count * 16
  for image in images {
    ico.append(UInt8(image.size))
    ico.append(UInt8(image.size))
    ico.append(0)
    ico.append(0)
    appendUInt16LE(1, to: &ico)
    appendUInt16LE(32, to: &ico)
    appendUInt32LE(UInt32(image.data.count), to: &ico)
    appendUInt32LE(UInt32(offset), to: &ico)
    offset += image.data.count
  }
  for image in images { ico.append(image.data) }

  let outputURL = url("packages/frontend/public/favicon.ico")
  try ico.write(to: outputURL, options: .atomic)
  print("wrote packages/frontend/public/favicon.ico")
}

func appendUInt16LE(_ value: UInt16, to data: inout Data) {
  var littleEndian = value.littleEndian
  Swift.withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
}

func appendUInt32LE(_ value: UInt32, to data: inout Data) {
  var littleEndian = value.littleEndian
  Swift.withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
}

func renderRoundLauncher(_ relativePath: String, size: Int) throws {
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(ovalIn: canvas).addClip()
    brandNavy.setFill()
    canvas.fill()
    drawOcto(whiteOcto, in: canvas)
    NSGraphicsContext.restoreGraphicsState()
  }
}

func renderAdaptiveForeground(_ relativePath: String, size: Int) throws {
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    // Android crops the 108dp adaptive layer to a centered 72dp viewport.
    // Render the same already-padded tile into that viewport: the actual ink
    // remains inside the 66dp safe zone and matches the other platform icons.
    let viewportSide = CGFloat(size) * 72 / 108
    let viewportRect = NSRect(
      x: (canvas.width - viewportSide) / 2,
      y: (canvas.height - viewportSide) / 2,
      width: viewportSide,
      height: viewportSide
    )
    drawOcto(whiteOcto, in: viewportRect)
  }
}

func renderSplash(
  _ relativePath: String,
  width: Int,
  height: Int,
  logoCanvasFraction: CGFloat
) throws {
  try renderPNG(at: url(relativePath), width: width, height: height, opaque: true) { canvas in
    let side = min(canvas.width, canvas.height) * logoCanvasFraction
    let logoRect = NSRect(
      x: (canvas.width - side) / 2,
      y: (canvas.height - side) / 2,
      width: side,
      height: side
    )
    drawOcto(navyOcto, in: logoRect)
  }
}

// Browser fallbacks and installed/distribution tiles use the reverse lockup.
// The adaptive SVG above remains transparent and switches ink for dark chrome.
try renderReverseSquare("packages/frontend/public/icon-192.png", size: 192, opaque: true)
try renderReverseSquare("packages/frontend/public/icon-512.png", size: 512, opaque: true)
try renderReverseSquare("packages/frontend/public/icon.png", size: 1024, opaque: true)
try renderFavicon()
try renderReverseSquare("packages/frontend/public/apple-touch-icon.png", size: 180, opaque: true)
try renderReverseSquare("packages/frontend/public/icon-maskable-192.png", size: 192, opaque: true)
try renderReverseSquare("packages/frontend/public/icon-maskable-512.png", size: 512, opaque: true)
try renderStoreSquare(
  "packages/frontend/store/google-play/en-US/images/icon.png",
  size: 512
)
try renderStoreSquare(
  "packages/frontend/store/google-play-developer-profile-icon.png",
  size: 512
)
try renderGitHubBadgeLogo(
  "packages/frontend/store/github-app-badge-logo.png",
  size: 512
)
try renderDesktopIcon("packages/desktop-app/assets/icon.png", size: 1024)

// Apple receives the App Store icon from this opaque asset in the native build.
try renderReverseSquare(
  "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
  size: 1024,
  opaque: true
)

for filename in [
  "splash-2732x2732-2.png",
  "splash-2732x2732-1.png",
  "splash-2732x2732.png",
] {
  try renderSplash(
    "packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset/\(filename)",
    width: 2732,
    height: 2732,
    logoCanvasFraction: 0.18
  )
}

// Android launcher and adaptive layers for mdpi through xxxhdpi.
let androidBackgroundURL = url(
  "packages/frontend/android/app/src/main/res/values/ic_launcher_background.xml"
)
let androidBackground = """
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">\(brandNavyHex.uppercased())</color>
</resources>

"""
try androidBackground.write(
  to: androidBackgroundURL,
  atomically: true,
  encoding: .utf8
)
print("wrote packages/frontend/android/app/src/main/res/values/ic_launcher_background.xml")

let androidDensities: [(name: String, launcher: Int, foreground: Int)] = [
  ("mdpi", 48, 108),
  ("hdpi", 72, 162),
  ("xhdpi", 96, 216),
  ("xxhdpi", 144, 324),
  ("xxxhdpi", 192, 432),
]

for density in androidDensities {
  let directory = "packages/frontend/android/app/src/main/res/mipmap-\(density.name)"
  try renderReverseSquare("\(directory)/ic_launcher.png", size: density.launcher, opaque: true)
  try renderRoundLauncher("\(directory)/ic_launcher_round.png", size: density.launcher)
  try renderAdaptiveForeground(
    "\(directory)/ic_launcher_foreground.png",
    size: density.foreground
  )
}

let androidSplashes: [(directory: String, width: Int, height: Int)] = [
  ("drawable", 480, 320),
  ("drawable-land-mdpi", 480, 320),
  ("drawable-land-hdpi", 800, 480),
  ("drawable-land-xhdpi", 1280, 720),
  ("drawable-land-xxhdpi", 1600, 960),
  ("drawable-land-xxxhdpi", 1920, 1280),
  ("drawable-port-mdpi", 320, 480),
  ("drawable-port-hdpi", 480, 800),
  ("drawable-port-xhdpi", 720, 1280),
  ("drawable-port-xxhdpi", 960, 1600),
  ("drawable-port-xxxhdpi", 1280, 1920),
]

for splash in androidSplashes {
  try renderSplash(
    "packages/frontend/android/app/src/main/res/\(splash.directory)/splash.png",
    width: splash.width,
    height: splash.height,
    logoCanvasFraction: 0.30
  )
}
