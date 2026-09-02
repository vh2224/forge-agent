// ForgeIcon — generates Forge.icns from code.
//
// Committing a binary .icns would mean nobody can tweak the icon without a
// design tool, so the icon is drawn programmatically.
//
// A TARGET AND NO LONGER A LOOSE SCRIPT. It was `swift app/make-icon.swift`,
// which cannot import anything — so the mark had to be written out here, and a
// second copy of it lived in the app for the menu-bar item. Two copies of a
// shape drift, and drift in a LOGO is the kind of bug that ships. As a target
// it imports `ForgeKit.ForgeMark` and there is exactly one anvil in the repo.
//
// Run via app/build.sh, or by hand:
//   swift run --package-path app ForgeIcon app/Forge.icns

import AppKit
import Foundation
import ForgeKit

let outPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "Forge.icns"

/// macOS icons are supplied at these sizes; iconutil expects this exact naming.
let variants: [(name: String, px: Int)] = [
    ("icon_16x16",      16),  ("icon_16x16@2x",    32),
    ("icon_32x32",      32),  ("icon_32x32@2x",    64),
    ("icon_128x128",   128),  ("icon_128x128@2x", 256),
    ("icon_256x256",   256),  ("icon_256x256@2x", 512),
    ("icon_512x512",   512),  ("icon_512x512@2x",1024),
]

// The palette is the app's own (`Design.swift`): the icon in the Dock and the
// accent inside the window are the same orange, because an icon that disagrees
// with its app reads as someone else's icon.
let ember = NSColor(srgbRed: 1.00, green: 0.58, blue: 0.13, alpha: 1)
let hot   = NSColor(srgbRed: 1.00, green: 0.78, blue: 0.42, alpha: 1)
let deep  = NSColor(srgbRed: 0.85, green: 0.28, blue: 0.03, alpha: 1)

/// The mark, fitted into `rect` at `widthFraction` of it and centred on
/// `centerY`.
///
/// Fitted by measuring rather than by hand-placed coordinates. The first cut
/// mapped the unit square straight onto the plate and the anvil touched both
/// edges — an icon with no margin reads as bigger and cheaper than the ones
/// beside it in the Dock, and it left the coals with nowhere to show. Measuring
/// also means the OUTLINE can be retuned in `ForgeMark` without re-deriving
/// where it sits.
func anvilPath(in rect: CGRect,
               widthFraction: CGFloat = 0.66,
               centerY: CGFloat = 0.545) -> NSBezierPath {
    let xs = ForgeMark.anvil.map { CGFloat($0.x) }
    let ys = ForgeMark.anvil.map { CGFloat($0.y) }
    let minX = xs.min()!, maxX = xs.max()!
    let minY = ys.min()!, maxY = ys.max()!

    let scale = (rect.width * widthFraction) / (maxX - minX)
    let drawnH = (maxY - minY) * scale
    let originX = rect.midX - (maxX - minX) * scale / 2
    let originY = rect.minY + rect.height * centerY - drawnH / 2

    let p = NSBezierPath()
    for (i, pt) in ForgeMark.anvil.enumerated() {
        let point = NSPoint(x: originX + (CGFloat(pt.x) - minX) * scale,
                            y: originY + (CGFloat(pt.y) - minY) * scale)
        if i == 0 { p.move(to: point) } else { p.line(to: point) }
    }
    p.close()
    return p
}

func draw(size px: Int) -> Data? {
    let s = CGFloat(px)

    // Render straight into a bitmap rep. NSImage.lockFocus() + tiffRepresentation
    // fails at small sizes ("CGImageDestinationFinalize failed for public.tiff"),
    // and going through TIFF at all is pointless when the target is PNG.
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }
    rep.size = NSSize(width: s, height: s)

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let gctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.current = gctx
    let ctx = gctx.cgContext

    // ── The plate ────────────────────────────────────────────────────────────
    let inset  = s * CGFloat(ForgeMark.plateInset)
    let rect   = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = rect.width * CGFloat(ForgeMark.plateCornerRatio)
    let plate  = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

    NSGradient(colors: [
        NSColor(srgbRed: 0.115, green: 0.110, blue: 0.130, alpha: 1),
        NSColor(srgbRed: 0.043, green: 0.040, blue: 0.052, alpha: 1),
    ])?.draw(in: plate, angle: -90)

    // ── The coals ────────────────────────────────────────────────────────────
    // A radial bloom under the anvil. This is the whole reason the icon reads as
    // a FORGE rather than as a blacksmithing clip-art: without it the mark is an
    // object on a plate, with it the object is sitting in heat.
    ctx.saveGState()
    plate.addClip()
    let gc = CGPoint(x: rect.minX + CGFloat(ForgeMark.glowCenter.x) * rect.width,
                     y: rect.minY + CGFloat(ForgeMark.glowCenter.y) * rect.height)
    NSGradient(colors: [
        hot.withAlphaComponent(0.32),
        ember.withAlphaComponent(0.30),
        deep.withAlphaComponent(0.12),
        NSColor.clear,
    ])?.draw(fromCenter: gc, radius: 0,
             toCenter: gc, radius: rect.width * CGFloat(ForgeMark.glowRadius),
             options: [])
    ctx.restoreGState()

    // ── The anvil ────────────────────────────────────────────────────────────
    let anvil = anvilPath(in: rect)

    // Cast down and dark, not up and soft: the light source in this icon is the
    // coals, which are below the mark.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: s * 0.012),
                  blur: s * 0.05,
                  color: NSColor.black.withAlphaComponent(0.65).cgColor)
    NSColor.black.setFill()
    anvil.fill()
    ctx.restoreGState()

    // Metal at temperature: deep at the foot, hot at the face.
    NSGradient(colors: [deep, ember, hot])?.draw(in: anvil, angle: 90)

    // ── The rim ──────────────────────────────────────────────────────────────
    // Keeps the plate's edge legible against a dark Dock. Drawn last so neither
    // the bloom nor the mark can spill over it.
    NSColor(calibratedWhite: 1, alpha: 0.10).setStroke()
    plate.lineWidth = max(1, s * 0.006)
    plate.stroke()

    return rep.representation(using: .png, properties: [:])
}

let fm = FileManager.default
let tmp = NSTemporaryDirectory() + "forge-iconset-\(getpid()).iconset"
try? fm.removeItem(atPath: tmp)
try fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)

for v in variants {
    guard let data = draw(size: v.px) else {
        FileHandle.standardError.write("falhou ao desenhar \(v.name)\n".data(using: .utf8)!)
        exit(1)
    }
    try data.write(to: URL(fileURLWithPath: "\(tmp)/\(v.name).png"))
}

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", tmp, "-o", outPath]
try p.run()
p.waitUntilExit()
try? fm.removeItem(atPath: tmp)

if p.terminationStatus == 0 {
    print("✓ \(outPath)")
} else {
    FileHandle.standardError.write("iconutil falhou\n".data(using: .utf8)!)
    exit(1)
}
