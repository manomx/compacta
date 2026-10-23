import AppKit

// Ícono de Compacta: squircle naranja con degradado radial y la "C condensada" en blanco.
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let iconset = root.appendingPathComponent("Compacta.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
func color(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: a)
}
for size in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let n = CGFloat(size * scale)
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(n), pixelsHigh: Int(n), bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = n * 0.098  // margen estándar de íconos macOS
    let tile = NSRect(x: inset, y: inset, width: n - inset * 2, height: n - inset * 2)
    let radius = tile.width * 0.225
    let shape = NSBezierPath(roundedRect: tile, xRadius: radius, yRadius: radius)
    // Sombra suave del mosaico
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = color(0x7a2a05, 0.35)
    shadow.shadowBlurRadius = n * 0.03
    shadow.shadowOffset = NSSize(width: 0, height: -n * 0.012)
    shadow.set()
    color(0xf76b15).setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    // Degradado radial
    NSGraphicsContext.saveGraphicsState()
    shape.addClip()
    let g = NSGradient(
      colors: [color(0xffb067), color(0xf76b15), color(0xc9470a)], atLocations: [0, 0.5, 1],
      colorSpace: .sRGB)!
    g.draw(in: shape, relativeCenterPosition: NSPoint(x: -0.4, y: 0.7))
    // Brillo superior
    let gloss = NSGradient(colors: [color(0xffffff, 0.22), color(0xffffff, 0)])!
    gloss.draw(
      in: NSRect(x: tile.minX, y: tile.midY, width: tile.width, height: tile.height / 2), angle: -90
    )
    NSGraphicsContext.restoreGraphicsState()
    // Marca
    let k = tile.width * 0.68 / 24
    let c = NSPoint(x: tile.midX, y: tile.midY)
    NSGraphicsContext.saveGraphicsState()
    let ms = NSShadow()
    ms.shadowColor = color(0x781e00, 0.3)
    ms.shadowBlurRadius = n * 0.02
    ms.shadowOffset = NSSize(width: 0, height: -n * 0.01)
    ms.set()
    let w = max(1.2, 2.3 * k)
    for (r, a) in [(9.3, 0.55), (5.9, 0.85)] as [(CGFloat, CGFloat)] {
      let p = NSBezierPath()
      p.appendArc(withCenter: c, radius: r * k, startAngle: 45, endAngle: 315, clockwise: false)
      p.lineWidth = w
      p.lineCapStyle = .round
      NSColor.white.withAlphaComponent(a).setStroke()
      p.stroke()
    }
    NSColor.white.setFill()
    NSBezierPath(
      ovalIn: NSRect(x: c.x - 2.7 * k, y: c.y - 2.7 * k, width: 5.4 * k, height: 5.4 * k)
    ).fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(
      to: iconset.appendingPathComponent("icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"))
  }
}
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", root.appendingPathComponent("Compacta.icns").path]
try p.run()
p.waitUntilExit()
if p.terminationStatus != 0 { exit(1) }
try FileManager.default.removeItem(at: iconset)
