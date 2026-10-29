#!/usr/bin/env swift

import AppKit
import Foundation
import ImageIO
import QuartzCore
import UniformTypeIdentifiers

// Keep octo-mark.geometry.json as the single source for Octo's curves and nodes:
// one logo at every size. Marks shown at 24 CSS px or points and below (the
// favicons and the smallest desktop representations) draw the same geometry
// full-bleed rather than at the distribution scale; see MarkFit.
// This script derives the browser SVG, in-product avatar, and every native raster
// while preserving each platform's alpha channel, safe zone, and background.
//
// Color treatment (docs/Brand.md): the body is always one ink. On a tile of at
// least crewTileMinPx device pixels the four detached nodes take the dark crew
// set (slots 1-4, left to right by cx); on paper (native splash) they take the
// light set. Smaller tiles (favicons, the 16/24/32 px desktop representations,
// the iOS 20 pt@2x slot), the GitHub badge, Octo's avatar and the Android themed
// (monochrome) layer stay one ink.
//
// Appearances: the reverse native splash (dark mode) puts the white body and
// the dark crew set on the dark canvas (colors.canvasDark); the iOS Dark app
// icon is the same crew mark on a transparent ground, and the iOS Tinted app
// icon is one ink, white on black, for the system to tint. The macOS .icns sits
// on Apple's icon grid (an 824 px body in a 1024 px canvas); the Windows .ico
// and the Linux icon.png stay full-bleed.

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

struct AppIconCrewColors: Decodable {
  let light: [String]
  let dark: [String]
}

struct AppIconBrandColors: Decodable {
  let ink: String
  let paper: String
  /// The dark product canvas: the reverse native splash and its system bars.
  let canvasDark: String
  let crew: AppIconCrewColors
}

struct AppIconBrandConfig: Decodable {
  let cacheRevision: Int
  let distributionScale: Double
  let maskableScale: Double
  let crewTileMinPx: Int
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
      brandConfig.distributionScale <= 1,
      brandConfig.maskableScale > 0,
      brandConfig.maskableScale < brandConfig.distributionScale,
      brandConfig.crewTileMinPx > 0 else {
  fputs(
    "App icon brand config must contain a positive revision, a scale in (0, 1], a smaller maskableScale and a positive crewTileMinPx.\n",
    stderr
  )
  exit(1)
}
guard brandConfig.colors.crew.light.count == 4,
      brandConfig.colors.crew.dark.count == 4 else {
  fputs("App icon brand config must list four light and four dark crew colors.\n", stderr)
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
let canvasDarkHex = brandConfig.colors.canvasDark.lowercased()
let canvasDark = try color(from: canvasDarkHex)
/// The iOS Tinted icon's ground: the system maps luminance to the person's
/// tint, so black is the darkest tint and the white mark the brightest.
let tintedGround = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
let crewLightHexes = brandConfig.colors.crew.light.map { $0.lowercased() }
let crewDarkHexes = brandConfig.colors.crew.dark.map { $0.lowercased() }
for hex in crewLightHexes + crewDarkHexes { _ = try color(from: hex) }

/// Each circle's crew slot (0-3), ranked by cx so slot 1 is always the
/// leftmost node whatever order the geometry lists the circles in. This
/// matches OctoMark's NODE_CREW_SLOTS.
func crewSlots(of geometry: OctoGeometry) -> [Int] {
  let order = geometry.circles.indices.sorted {
    geometry.circles[$0].cx < geometry.circles[$1].cx
  }
  var slots = Array(repeating: 0, count: geometry.circles.count)
  for (rank, index) in order.enumerated() { slots[index] = rank }
  return slots
}

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

/// The mark's ink box in its own path coordinates (before the geometry's
/// transform): the tight bounds of the body paths' curves, not their control
/// points, together with the four nodes, which are its left, right and bottom
/// extremes. The paths use absolute M, L, C and Z commands only.
func inkBox(of geometry: OctoGeometry) throws -> CGRect {
  let token = try NSRegularExpression(
    pattern: "[A-Za-z]|-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?"
  )
  var box = CGRect.null
  for pathData in geometry.paths {
    let tokens = token
      .matches(in: pathData, range: NSRange(pathData.startIndex..., in: pathData))
      .map { String(pathData[Range($0.range, in: pathData)!]) }
    let path = CGMutablePath()
    var index = 0
    func point() throws -> CGPoint {
      guard index + 1 < tokens.count,
            let x = Double(tokens[index]),
            let y = Double(tokens[index + 1]) else {
        throw NSError(
          domain: "InstafyIconGenerator",
          code: 12,
          userInfo: [NSLocalizedDescriptionKey: "Malformed Octo path data: \(pathData)"]
        )
      }
      index += 2
      return CGPoint(x: x, y: y)
    }
    var command = ""
    while index < tokens.count {
      if Double(tokens[index]) == nil {
        command = tokens[index]
        index += 1
      }
      switch command {
      case "M": path.move(to: try point()); command = "L"
      case "L": path.addLine(to: try point())
      case "C":
        let control1 = try point()
        let control2 = try point()
        path.addCurve(to: try point(), control1: control1, control2: control2)
      case "Z", "z": path.closeSubpath(); command = ""
      default:
        throw NSError(
          domain: "InstafyIconGenerator",
          code: 13,
          userInfo: [NSLocalizedDescriptionKey: "Unsupported Octo path command \(command)"]
        )
      }
    }
    box = box.union(path.boundingBoxOfPath)
  }
  for circle in geometry.circles {
    box = box.union(
      CGRect(x: circle.cx - circle.r, y: circle.cy - circle.r, width: 2 * circle.r, height: 2 * circle.r)
    )
  }
  return box
}

/// The full-bleed fit: the ink box scaled so its longer side (the height)
/// spans the 64-unit canvas less a 4-unit margin, and centered. Centering the
/// box absorbs the geometry's own translate, so one transform places the
/// paths directly.
let fullBleedMargin = 4.0
let markInkBox = try inkBox(of: geometry)
let fullBleedScale = (canvasSide - 2 * fullBleedMargin) / Double(max(markInkBox.width, markInkBox.height))
let fullBleedOffsetX = canvasSide / 2 - fullBleedScale * Double(markInkBox.midX)
let fullBleedOffsetY = canvasSide / 2 - fullBleedScale * Double(markInkBox.midY)

enum MarkFit {
  /// The shared distribution scale: the mark's optical padding on every tile,
  /// launcher, store and splash asset.
  case distribution
  /// Full-bleed and always one ink: only for a mark shown at 24 CSS px (or
  /// points) or less, drawn in 32 device px or less: the adaptive favicon, a
  /// 16 CSS px tab at 1x and 2x, a 16 pt macOS slot, a 16 or 24 px Windows
  /// entry.
  case fullBleed
}

/// Every AI face is a rounded square whose corners round off at 30% of its
/// size (docs/Brand.md, "One rule for faces"; AI_TILE_SHAPE_CLASS in
/// packages/frontend/src/components/OctoCoin.tsx), Octo's avatar included.
let aiTileCornerRatio = 0.3

/// Draw the mark as a 64-unit SVG at `fit`. `nodeColors` (crew slots 1-4)
/// fills the nodes; without it every piece takes the one ink.
/// `backgroundColor` puts the mark on the AI tile in that color.
func makeOctoSvg(
  ariaLabel: String,
  fit: MarkFit = .distribution,
  backgroundColor: String? = nil,
  inkColor: String = brandNavyHex,
  darkModeInkColor: String? = nil,
  nodeColors: [String]? = nil
) -> String {
  var lines = [
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"\(geometry.viewBox)\" width=\"64\" height=\"64\" role=\"img\" aria-label=\"\(xmlEscaped(ariaLabel))\">",
  ]
  if let darkModeInkColor {
    lines += [
      "  <style>",
      "    .octo-ink { fill: \(inkColor); }",
      "    @media (prefers-color-scheme: dark) { .octo-ink { fill: \(darkModeInkColor); } }",
      "  </style>",
    ]
  }
  if let backgroundColor {
    let side = svgNumber(canvasSide)
    let corner = svgNumber(canvasSide * aiTileCornerRatio)
    lines.append(
      "  <rect width=\"\(side)\" height=\"\(side)\" rx=\"\(corner)\" fill=\"\(backgroundColor)\"/>"
    )
  }
  var indent = "  "
  let distributed = fit == .distribution
  if distributed {
    lines.append(
      "  <g transform=\"translate(\(svgNumber(distributionOffset)) \(svgNumber(distributionOffset))) scale(\(svgNumber(distributionScale)))\">"
    )
    indent = "    "
  }
  let inkAttribute = darkModeInkColor == nil
    ? "fill=\"\(inkColor)\""
    : "class=\"octo-ink\""
  let transformAttribute: String
  switch fit {
  case .distribution:
    transformAttribute = geometry.transform.isEmpty
      ? ""
      : " transform=\"\(xmlEscaped(geometry.transform))\""
  case .fullBleed:
    transformAttribute =
      " transform=\"translate(\(svgNumber(fullBleedOffsetX)) \(svgNumber(fullBleedOffsetY))) scale(\(svgNumber(fullBleedScale)))\""
  }
  lines.append("\(indent)<g \(inkAttribute)\(transformAttribute)>")
  for path in geometry.paths {
    lines.append("\(indent)  <path d=\"\(xmlEscaped(path))\"/>")
  }
  let slots = crewSlots(of: geometry)
  for (index, circle) in geometry.circles.enumerated() {
    let fill = nodeColors.map { " fill=\"\($0[slots[index]])\"" } ?? ""
    lines.append(
      "\(indent)  <circle cx=\"\(svgNumber(circle.cx))\" cy=\"\(svgNumber(circle.cy))\" r=\"\(svgNumber(circle.r))\"\(fill)/>"
    )
  }
  lines.append("\(indent)</g>")
  if distributed { lines.append("  </g>") }
  lines.append("</svg>")
  return lines.joined(separator: "\n") + "\n"
}

// The adaptive favicon is drawn at 16 CSS px, so it takes the mark full-bleed
// and one ink (navy, white under a dark color scheme).
let sourceURL = url("packages/frontend/public/icon.svg")
let avatarURL = url("packages/frontend/src/assets/octo-avatar.svg")
try makeOctoSvg(
  ariaLabel: "Instafy",
  fit: .fullBleed,
  darkModeInkColor: brandWhiteHex
)
  .write(to: sourceURL, atomically: true, encoding: .utf8)
// Octo's tile is one participant, so its avatar stays one ink.
try makeOctoSvg(
  ariaLabel: "Octo",
  backgroundColor: brandWhiteHex
)
  .write(to: avatarURL, atomically: true, encoding: .utf8)
print("wrote packages/frontend/public/icon.svg")
print("wrote packages/frontend/src/assets/octo-avatar.svg")

func rasterSource(_ svg: String) -> NSImage {
  guard let data = svg.data(using: .utf8), let image = NSImage(data: data) else {
    fputs("Unable to load a generated raster source.\n", stderr)
    exit(1)
  }
  return image
}

// One ink, reverse: the GitHub badge, small tiles and the monochrome layer.
let whiteOcto = rasterSource(
  makeOctoSvg(ariaLabel: "Instafy reverse raster source", inkColor: brandWhiteHex)
)
// One ink, positive: the splash fallback below the crew threshold.
let navyOcto = rasterSource(makeOctoSvg(ariaLabel: "Instafy raster source"))
// Crew, reverse: white body and the dark crew set on the brand-ink tile.
let crewTileOcto = rasterSource(
  makeOctoSvg(
    ariaLabel: "Instafy crew tile raster source",
    inkColor: brandWhiteHex,
    nodeColors: crewDarkHexes
  )
)
// Crew, positive: navy body and the light crew set on brand paper.
let crewPaperOcto = rasterSource(
  makeOctoSvg(ariaLabel: "Instafy crew raster source", nodeColors: crewLightHexes)
)
// One ink, reverse and full-bleed: tiles shown at 24 CSS px or less.
let fullBleedWhiteOcto = rasterSource(
  makeOctoSvg(
    ariaLabel: "Instafy full-bleed raster source",
    fit: .fullBleed,
    inkColor: brandWhiteHex
  )
)

/// Crew nodes on a tile need room to read as color: a tile of at least
/// crewTileMinPx device pixels (the drawn mark is then about 40 px). Below it
/// the tile keeps the one-ink mark.
func tileOcto(side: CGFloat) -> NSImage {
  side >= CGFloat(brandConfig.crewTileMinPx) ? crewTileOcto : whiteOcto
}

/// The mark on a brand-ink tile of `devicePx` pixels. Full-bleed is one ink.
/// At the distribution scale the mark takes crew nodes from crewTileMinPx
/// device px up; `crew: false` keeps a monochrome context (favicon.ico) one
/// ink at any size.
func drawTileMark(in canvas: NSRect, devicePx: Int, fit: MarkFit, crew: Bool = true) {
  switch fit {
  case .fullBleed:
    precondition(devicePx <= 32, "the full-bleed mark is only drawn at 32 device px or less")
    drawOcto(fullBleedWhiteOcto, in: canvas)
  case .distribution:
    drawOcto(crew ? tileOcto(side: CGFloat(devicePx)) : whiteOcto, in: canvas)
  }
}

func paperOcto(side: CGFloat) -> NSImage {
  side >= CGFloat(brandConfig.crewTileMinPx) ? crewPaperOcto : navyOcto
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
  let image = try renderImage(width: width, height: height, opaque: opaque, draw: draw)
  try writePNG(image, to: outputURL, logOutput: logOutput)
}

/// Draw into an sRGB, 8-bit RGBA bitmap (premultiplied alpha, or opaque on
/// white) and return the image.
func renderImage(
  width: Int,
  height: Int,
  opaque: Bool,
  draw: (NSRect) -> Void
) throws -> CGImage {
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
      userInfo: [NSLocalizedDescriptionKey: "Unable to make a \(width)x\(height) image"]
    )
  }
  return image
}

func writePNG(_ image: CGImage, to outputURL: URL, logOutput: Bool = true) throws {
  try fileManager.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
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
    drawOcto(tileOcto(side: canvas.width), in: canvas)
  }
}

func renderStoreSquare(_ relativePath: String, size: Int) throws {
  // Google Play requires a 32-bit PNG. Keep an explicit alpha channel even
  // though the reverse tile's visual background is intentionally opaque.
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    brandNavy.setFill()
    canvas.fill()
    drawOcto(tileOcto(side: canvas.width), in: canvas)
  }
}

/// A maskable PWA tile: the crew tile with the mark drawn at maskableScale
/// rather than the distribution scale, so all of its ink, the outer nodes
/// included, stays inside the W3C maskable safe zone (a centered circle whose
/// radius is 40% of the icon).
func renderMaskableSquare(_ relativePath: String, size: Int) throws {
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: true) { canvas in
    brandNavy.setFill()
    canvas.fill()
    let side = canvas.width * CGFloat(brandConfig.maskableScale / brandConfig.distributionScale)
    drawOcto(
      tileOcto(side: canvas.width),
      in: NSRect(
        x: (canvas.width - side) / 2,
        y: (canvas.height - side) / 2,
        width: side,
        height: side
      )
    )
  }
}

/// A one-ink square tile on brand ink for a monochrome context (favicons) or a
/// tile under the crew threshold (the iOS 20 pt@2x slot).
func oneInkSquareTile(size: Int, fit: MarkFit, opaque: Bool) throws -> CGImage {
  try renderImage(width: size, height: size, opaque: opaque) { canvas in
    brandNavy.setFill()
    canvas.fill()
    drawTileMark(in: canvas, devicePx: size, fit: fit, crew: false)
  }
}

/// The desktop tile: brand ink in a rounded rect with transparent corners.
func desktopTile(size: Int, fit: MarkFit) throws -> CGImage {
  try renderImage(width: size, height: size, opaque: false) { canvas in
    brandNavy.setFill()
    NSBezierPath(
      roundedRect: canvas,
      xRadius: canvas.width * 0.22,
      yRadius: canvas.height * 0.22
    ).fill()
    drawTileMark(in: canvas, devicePx: size, fit: fit)
  }
}

/// Apple's macOS icon grid: a 1024 px canvas holds an 824 px body with 100 px
/// transparent margins, so the Dock and Finder draw the tile at the same size
/// as every other app. Each slot rounds the margin to whole pixels, half away
/// from zero, as Apple's own icons do (16 -> 12, 32 -> 26, 64 -> 52,
/// 128 -> 102, 256 -> 206, 512 -> 412, 1024 -> 824), so the body's straight
/// edges stay on the pixel grid.
func macGridBody(side: Int) -> (inset: Int, body: Int) {
  let inset = Int((Double(side) * 100 / 1024).rounded())
  return (inset, side - 2 * inset)
}

/// The macOS body's continuous corner: Apple's 185.4 px radius on 824 px.
let macCornerRatio = 185.4 / 824.0

/// The macOS desktop tile: the brand-ink body on the icon grid with Apple's
/// continuous corners and transparent margins. Crew follows the body's own
/// device px, so the 16 pt slots (12 and 26 px bodies) keep the one-ink
/// full-bleed mark and the 32 pt slot (a 26 px body) stays one ink.
func macDesktopTile(size: Int, fit: MarkFit) throws -> CGImage {
  let (inset, body) = macGridBody(side: size)
  return try renderImage(width: size, height: size, opaque: false) { _ in
    guard let context = NSGraphicsContext.current?.cgContext else { return }
    let layer = CALayer()
    layer.frame = CGRect(x: 0, y: 0, width: body, height: body)
    layer.backgroundColor = brandNavy.cgColor
    layer.cornerRadius = CGFloat(body) * macCornerRatio
    layer.cornerCurve = .continuous
    layer.masksToBounds = true
    context.saveGState()
    context.translateBy(x: CGFloat(inset), y: CGFloat(inset))
    layer.render(in: context)
    context.restoreGState()
    drawTileMark(
      in: NSRect(x: inset, y: inset, width: body, height: body),
      devicePx: body,
      fit: fit
    )
  }
}

func pngData(_ image: CGImage) throws -> Data {
  let data = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(
    data as CFMutableData,
    UTType.png.identifier as CFString,
    1,
    nil
  ) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 7,
      userInfo: [NSLocalizedDescriptionKey: "Unable to create an in-memory PNG destination"]
    )
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 8,
      userInfo: [NSLocalizedDescriptionKey: "Unable to encode a \(image.width)px PNG"]
    )
  }
  return data as Data
}

/// A classic ICO image entry: a 32-bit BGRA DIB (bottom-up, straight alpha)
/// followed by its 1-bit AND mask, as Windows, rcedit and NSIS expect for
/// entries under 256 px.
func dibData(_ image: CGImage) throws -> Data {
  let width = image.width
  let height = image.height
  guard image.bitsPerPixel == 32,
        let source = image.dataProvider?.data as Data? else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 9,
      userInfo: [NSLocalizedDescriptionKey: "Unable to read \(width)px pixels for a DIB entry"]
    )
  }
  let sourceStride = image.bytesPerRow
  let maskStride = ((width + 31) / 32) * 4
  var dib = Data()
  appendUInt32LE(40, to: &dib)
  appendUInt32LE(UInt32(width), to: &dib)
  appendUInt32LE(UInt32(height * 2), to: &dib)
  appendUInt16LE(1, to: &dib)
  appendUInt16LE(32, to: &dib)
  appendUInt32LE(0, to: &dib)
  appendUInt32LE(UInt32(width * height * 4 + maskStride * height), to: &dib)
  for _ in 0..<4 { appendUInt32LE(0, to: &dib) }
  var mask = Data(count: maskStride * height)
  for row in 0..<height {
    let y = height - 1 - row
    for x in 0..<width {
      // The bitmap context is RGBA with premultiplied alpha.
      let offset = y * sourceStride + x * 4
      let alpha = Int(source[offset + 3])
      let straight = { (channel: UInt8) -> UInt8 in
        alpha == 0 ? 0 : UInt8(min(255, (Int(channel) * 255 + alpha / 2) / alpha))
      }
      dib.append(contentsOf: [
        straight(source[offset + 2]),
        straight(source[offset + 1]),
        straight(source[offset]),
        UInt8(alpha),
      ])
      if alpha == 0 { mask[row * maskStride + x / 8] |= UInt8(0x80 >> (x % 8)) }
    }
  }
  dib.append(mask)
  return dib
}

func makeIco(_ entries: [(size: Int, payload: Data)]) -> Data {
  var ico = Data()
  appendUInt16LE(0, to: &ico)
  appendUInt16LE(1, to: &ico)
  appendUInt16LE(UInt16(entries.count), to: &ico)
  var offset = 6 + entries.count * 16
  for entry in entries {
    // A 256 px entry is written as 0 in the one-byte width and height fields.
    ico.append(UInt8(entry.size % 256))
    ico.append(UInt8(entry.size % 256))
    ico.append(0)
    ico.append(0)
    appendUInt16LE(1, to: &ico)
    appendUInt16LE(32, to: &ico)
    appendUInt32LE(UInt32(entry.payload.count), to: &ico)
    appendUInt32LE(UInt32(offset), to: &ico)
    offset += entry.payload.count
  }
  for entry in entries { ico.append(entry.payload) }
  return ico
}

func renderGitHubBadgeLogo(_ relativePath: String, size: Int) throws {
  // GitHub supplies the circular badge background separately. Keep only the
  // reverse Octo in this file so the same upload works in GitHub App and OAuth
  // App settings without introducing a square tile or double background.
  // GitHub shows the badge down to 20 px, so it stays one ink.
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    drawOcto(whiteOcto, in: canvas)
  }
}

// The desktop icon set. Each representation is drawn at its own size rather
// than downscaled from the 1024 px tile, so the ones under crewTileMinPx device
// px stay one ink and the 16 pt and 16/24 px ones draw the mark full-bleed.
// icon.icns (macOS) sits on the macOS icon grid; icon.ico (Windows) and
// icon.png (1024, the Linux icon and the reference raster) stay full-bleed.
let desktopIconPNGPath = "packages/desktop-app/assets/icon.png"
let desktopIcnsPath = "packages/desktop-app/assets/icon.icns"
let desktopIcoPath = "packages/desktop-app/assets/icon.ico"
// macOS iconset slots: the file name, its pixel side and its fit. Both 16 pt
// slots (16 px, and 32 px at 2x) draw the mark full-bleed; 32 pt at 1x keeps
// the distribution scale.
let desktopIcnsSlots: [(name: String, devicePx: Int, fit: MarkFit)] = [
  ("icon_16x16", 16, .fullBleed),
  ("icon_16x16@2x", 32, .fullBleed),
  ("icon_32x32", 32, .distribution),
  ("icon_32x32@2x", 64, .distribution),
  ("icon_128x128", 128, .distribution),
  ("icon_128x128@2x", 256, .distribution),
  ("icon_256x256", 256, .distribution),
  ("icon_256x256@2x", 512, .distribution),
  ("icon_512x512", 512, .distribution),
  ("icon_512x512@2x", 1024, .distribution),
]
// Windows picks an ICO entry by device pixels, so a 32 px entry can be shown at
// 32 px on a 1x display: only the 16 and 24 px entries draw the mark full-bleed.
let desktopIcoEntries: [(size: Int, fit: MarkFit)] = [
  (16, .fullBleed), (24, .fullBleed), (32, .distribution), (48, .distribution),
  (64, .distribution), (128, .distribution), (256, .distribution),
]

func renderDesktopIcons() throws {
  try writePNG(try desktopTile(size: 1024, fit: .distribution), to: url(desktopIconPNGPath))

  let temporaryDirectory = fileManager.temporaryDirectory
    .appendingPathComponent("instafy-desktop-icon-\(UUID().uuidString)", isDirectory: true)
  let iconset = temporaryDirectory.appendingPathComponent("icon.iconset", isDirectory: true)
  try fileManager.createDirectory(at: iconset, withIntermediateDirectories: true)
  defer { try? fileManager.removeItem(at: temporaryDirectory) }
  for slot in desktopIcnsSlots {
    try writePNG(
      try macDesktopTile(size: slot.devicePx, fit: slot.fit),
      to: iconset.appendingPathComponent("\(slot.name).png"),
      logOutput: false
    )
  }
  let iconutil = Process()
  iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
  iconutil.arguments = ["-c", "icns", iconset.path, "-o", url(desktopIcnsPath).path]
  try iconutil.run()
  iconutil.waitUntilExit()
  guard iconutil.terminationStatus == 0 else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 10,
      userInfo: [NSLocalizedDescriptionKey: "iconutil failed to build \(desktopIcnsPath)"]
    )
  }
  print("wrote \(desktopIcnsPath)")

  // Classic layout: DIB entries under 256 px and one PNG-compressed 256 px entry.
  let icoEntries = try desktopIcoEntries.map { entry -> (size: Int, payload: Data) in
    let image = try desktopTile(size: entry.size, fit: entry.fit)
    return (entry.size, entry.size >= 256 ? try pngData(image) : try dibData(image))
  }
  try makeIco(icoEntries).write(to: url(desktopIcoPath), options: .atomic)
  print("wrote \(desktopIcoPath)")
}

func renderFavicon() throws {
  // favicon.ico is a monochrome context: one ink in every entry. The 16 and 32
  // entries serve a 16 CSS px tab at 1x and 2x, so they draw the mark
  // full-bleed; the 48 entry keeps the distribution scale.
  let entries = try [(16, MarkFit.fullBleed), (32, .fullBleed), (48, .distribution)].map { size, fit in
    (size: size, payload: try pngData(try oneInkSquareTile(size: size, fit: fit, opaque: false)))
  }
  try makeIco(entries).write(to: url("packages/frontend/public/favicon.ico"), options: .atomic)
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
    drawOcto(tileOcto(side: canvas.width), in: canvas)
    NSGraphicsContext.restoreGraphicsState()
  }
}

enum AdaptiveLayer {
  case foreground
  case monochrome
}

func renderAdaptiveLayer(_ relativePath: String, size: Int, layer: AdaptiveLayer) throws {
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
    // The themed (monochrome) layer is an alpha mask the OS recolors, so it
    // never carries crew colors; it shares the foreground's silhouette.
    switch layer {
    case .foreground:
      drawOcto(tileOcto(side: viewportSide), in: viewportRect)
    case .monochrome:
      drawOcto(whiteOcto, in: viewportRect)
    }
  }
}

enum SplashAppearance {
  /// Positive: the brand-ink body and the light crew set on brand paper.
  case light
  /// Reverse: the white body and the dark crew set on the dark canvas.
  case dark
}

func renderSplash(
  _ relativePath: String,
  width: Int,
  height: Int,
  logoCanvasFraction: CGFloat,
  appearance: SplashAppearance = .light
) throws {
  try renderPNG(at: url(relativePath), width: width, height: height, opaque: true) { canvas in
    let side = min(canvas.width, canvas.height) * logoCanvasFraction
    let logoRect = NSRect(
      x: (canvas.width - side) / 2,
      y: (canvas.height - side) / 2,
      width: side,
      height: side
    )
    switch appearance {
    case .light:
      drawOcto(paperOcto(side: side), in: logoRect)
    case .dark:
      canvasDark.setFill()
      canvas.fill()
      drawOcto(tileOcto(side: side), in: logoRect)
    }
  }
}

/// iOS 18+ Dark app icon: the crew tile's mark (white body, dark crew set from
/// crewTileMinPx up, one ink below) on a transparent ground, so the system's
/// own dark background shows through it.
func renderIosDarkIcon(_ relativePath: String, size: Int) throws {
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: false) { canvas in
    drawOcto(tileOcto(side: canvas.width), in: canvas)
  }
}

/// iOS 18+ Tinted app icon: a fully opaque greyscale image, the one-ink mark
/// in white on black. The system maps its luminance to the person's tint. It
/// is written as RGB, never a grey color space (App Store Connect has shown a
/// grey-space tinted icon on the product page).
func renderIosTintedIcon(_ relativePath: String, size: Int) throws {
  try renderPNG(at: url(relativePath), width: size, height: size, opaque: true) { canvas in
    tintedGround.setFill()
    canvas.fill()
    drawOcto(whiteOcto, in: canvas)
  }
}

/// Write an asset catalog Contents.json the way Xcode does (two-space indent,
/// `"key" : value`, keys sorted), so opening the catalog in Xcode leaves it as
/// generated.
func writeAssetCatalogContents(_ relativePath: String, images: [[String: Any]]) throws {
  let contents: [String: Any] = [
    "images": images,
    "info": ["author": "xcode", "version": 1],
  ]
  let data = try JSONSerialization.data(
    withJSONObject: contents,
    options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
  )
  guard let json = String(data: data, encoding: .utf8) else {
    throw NSError(
      domain: "InstafyIconGenerator",
      code: 11,
      userInfo: [NSLocalizedDescriptionKey: "Unable to encode \(relativePath)"]
    )
  }
  try (json + "\n").write(to: url(relativePath), atomically: true, encoding: .utf8)
  print("wrote \(relativePath)")
}

/// The asset catalog entry that marks an image for the dark appearance, and
/// for the iOS 18+ tinted app icon appearance.
let darkAppearance: [[String: String]] = [["appearance": "luminosity", "value": "dark"]]
let tintedAppearance: [[String: String]] = [["appearance": "luminosity", "value": "tinted"]]

// Browser fallbacks and installed/distribution tiles use the reverse lockup.
// The adaptive SVG above remains transparent and switches ink for dark chrome.
try renderReverseSquare("packages/frontend/public/icon-192.png", size: 192, opaque: true)
try renderReverseSquare("packages/frontend/public/icon-512.png", size: 512, opaque: true)
try renderReverseSquare("packages/frontend/public/icon.png", size: 1024, opaque: true)
try renderFavicon()
// The PNG favicon fallback for browsers that skip icon.svg: the same one-ink
// full-bleed tile as favicon.ico's 32 px entry, never a downscaled crew tile.
try writePNG(
  try oneInkSquareTile(size: 32, fit: .fullBleed, opaque: true),
  to: url("packages/frontend/public/icon-32.png")
)
try renderReverseSquare("packages/frontend/public/apple-touch-icon.png", size: 180, opaque: true)
try renderMaskableSquare("packages/frontend/public/icon-maskable-192.png", size: 192)
try renderMaskableSquare("packages/frontend/public/icon-maskable-512.png", size: 512)
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
try renderDesktopIcons()

// Apple receives the App Store icon from this opaque asset in the native build.
// Xcode derives every other size from it except the one slot under the crew
// threshold: 20 pt@2x (40 px, notifications), which gets its own one-ink tile.
// iOS masks it like every other size, so it keeps the distribution scale; a
// full-bleed mark would crowd the corner mask.
try renderReverseSquare(
  "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
  size: 1024,
  opaque: true
)
let iosAppIconDirectory = "packages/frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset"
try writePNG(
  try oneInkSquareTile(size: 40, fit: .distribution, opaque: true),
  to: url("\(iosAppIconDirectory)/AppIcon-20@2x.png")
)
// iOS 18+ appearances for both slots. Dark keeps the crew mark at 1024 px
// and the one ink at 40 px; Tinted is one ink at every size.
try renderIosDarkIcon("\(iosAppIconDirectory)/AppIcon-Dark-512@2x.png", size: 1024)
try renderIosDarkIcon("\(iosAppIconDirectory)/AppIcon-Dark-20@2x.png", size: 40)
try renderIosTintedIcon("\(iosAppIconDirectory)/AppIcon-Tinted-512@2x.png", size: 1024)
try renderIosTintedIcon("\(iosAppIconDirectory)/AppIcon-Tinted-20@2x.png", size: 40)
func iosAppIconImage(_ filename: String, size: Int, scale: String?, appearances: [[String: String]]?) -> [String: Any] {
  var image: [String: Any] = [
    "filename": filename,
    "idiom": "universal",
    "platform": "ios",
    "size": "\(size)x\(size)",
  ]
  if let scale { image["scale"] = scale }
  if let appearances { image["appearances"] = appearances }
  return image
}
try writeAssetCatalogContents(
  "\(iosAppIconDirectory)/Contents.json",
  images: [
    iosAppIconImage("AppIcon-20@2x.png", size: 20, scale: "2x", appearances: nil),
    iosAppIconImage("AppIcon-Dark-20@2x.png", size: 20, scale: "2x", appearances: darkAppearance),
    iosAppIconImage("AppIcon-Tinted-20@2x.png", size: 20, scale: "2x", appearances: tintedAppearance),
    iosAppIconImage("AppIcon-512@2x.png", size: 1024, scale: nil, appearances: nil),
    iosAppIconImage("AppIcon-Dark-512@2x.png", size: 1024, scale: nil, appearances: darkAppearance),
    iosAppIconImage("AppIcon-Tinted-512@2x.png", size: 1024, scale: nil, appearances: tintedAppearance),
  ]
)

// The launch screen's Splash image: positive on paper, and the reverse splash
// on the dark canvas for the dark appearance. All six images are 2732 px.
let iosSplashDirectory = "packages/frontend/ios/App/App/Assets.xcassets/Splash.imageset"
var iosSplashImages: [[String: Any]] = []
for (scale, suffix) in [("1x", "-2"), ("2x", "-1"), ("3x", "")] {
  for appearance in [SplashAppearance.light, .dark] {
    let filename = appearance == .light
      ? "splash-2732x2732\(suffix).png"
      : "splash-dark-2732x2732\(suffix).png"
    try renderSplash(
      "\(iosSplashDirectory)/\(filename)",
      width: 2732,
      height: 2732,
      logoCanvasFraction: 0.18,
      appearance: appearance
    )
    var image: [String: Any] = ["filename": filename, "idiom": "universal", "scale": scale]
    if appearance == .dark { image["appearances"] = darkAppearance }
    iosSplashImages.append(image)
  }
}
try writeAssetCatalogContents("\(iosSplashDirectory)/Contents.json", images: iosSplashImages)

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

// The launch window's ground: brand paper, and the dark canvas under the night
// qualifier. styles.xml (values and values-night) paints the Android 12+ system
// splash and the status and navigation bars with it.
for (directory, hex) in [("values", brandWhiteHex), ("values-night", canvasDarkHex)] {
  let relativePath = "packages/frontend/android/app/src/main/res/\(directory)/splash_background.xml"
  try fileManager.createDirectory(
    at: url(relativePath).deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
  try """
  <?xml version="1.0" encoding="utf-8"?>
  <resources>
      <color name="splash_background">\(hex.uppercased())</color>
  </resources>

  """.write(to: url(relativePath), atomically: true, encoding: .utf8)
  print("wrote \(relativePath)")
}

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
  try renderAdaptiveLayer(
    "\(directory)/ic_launcher_foreground.png",
    size: density.foreground,
    layer: .foreground
  )
  try renderAdaptiveLayer(
    "\(directory)/ic_launcher_monochrome.png",
    size: density.foreground,
    layer: .monochrome
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

/// The night twin of a splash directory. Android ranks the orientation
/// qualifier above night mode, so every land/port density needs its own night
/// directory (drawable-land-night-hdpi); a lone drawable-night would lose to
/// drawable-land-hdpi on a dark landscape device.
func nightDirectory(_ directory: String) -> String {
  for orientation in ["land", "port"] where directory.hasPrefix("drawable-\(orientation)-") {
    return directory.replacingOccurrences(
      of: "drawable-\(orientation)-",
      with: "drawable-\(orientation)-night-"
    )
  }
  return "\(directory)-night"
}

for splash in androidSplashes {
  for appearance in [SplashAppearance.light, .dark] {
    let directory = appearance == .light ? splash.directory : nightDirectory(splash.directory)
    try renderSplash(
      "packages/frontend/android/app/src/main/res/\(directory)/splash.png",
      width: splash.width,
      height: splash.height,
      logoCanvasFraction: 0.30,
      appearance: appearance
    )
  }
}
