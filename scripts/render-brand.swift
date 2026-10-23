import AppKit

// Rebuild the social image and raster app mark without external design tools.
let root = URL(
  fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "docs/assets")
func color(_ n: UInt32, _ a: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((n >> 16) & 255) / 255, green: CGFloat((n >> 8) & 255) / 255,
    blue: CGFloat(n & 255) / 255, alpha: a)
}
func text(
  _ value: String, _ x: CGFloat, _ top: CGFloat, _ size: CGFloat, _ weight: NSFont.Weight,
  _ ink: UInt32, _ height: CGFloat
) {
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color(ink),
    .kern: size > 40 ? -2 : 0,
  ]
  (value as NSString).draw(at: NSPoint(x: x, y: height - top - size * 1.2), withAttributes: attrs)
}
func mark(_ rect: NSRect) {
  let tile = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.24, yRadius: rect.width * 0.24)
  let gradient = NSGradient(
    colors: [color(0xFFB067), color(0xF76B15), color(0xC9470A)], atLocations: [0, 0.48, 1],
    colorSpace: .sRGB)!
  gradient.draw(in: tile, relativeCenterPosition: NSPoint(x: -0.4, y: 0.7))
  let c = NSPoint(x: rect.midX, y: rect.midY)
  let k = rect.width / 38
  for (r, alpha) in [(9.3, 0.55), (5.9, 0.85)] as [(CGFloat, CGFloat)] {
    let p = NSBezierPath()
    p.appendArc(withCenter: c, radius: r * k, startAngle: 45, endAngle: 315, clockwise: false)
    p.lineWidth = 2.1 * k
    p.lineCapStyle = .round
    color(0xFFFFFF, alpha).setStroke()
    p.stroke()
  }
  color(0xFFFFFF).setFill()
  NSBezierPath(ovalIn: NSRect(x: c.x - 2.6 * k, y: c.y - 2.6 * k, width: 5.2 * k, height: 5.2 * k))
    .fill()
}
func render(_ width: Int, _ height: Int, _ name: String, _ draw: (CGFloat, CGFloat) -> Void) throws
{
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0,
    bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw(CGFloat(width), CGFloat(height))
  NSGraphicsContext.restoreGraphicsState()
  try rep.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent(name))
}
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
try render(512, 512, "compacta-logo.png") { w, h in
  mark(NSRect(x: 48, y: 48, width: w - 96, height: h - 96))
}
try render(1280, 640, "social-preview.png") { w, h in
  color(0xFAF7F4).setFill()
  NSRect(x: 0, y: 0, width: w, height: h).fill()
  color(0xF76B15, 0.045).setFill()
  NSBezierPath(ovalIn: NSRect(x: 850, y: 280, width: 660, height: 660)).fill()
  mark(NSRect(x: 80, y: h - 178, width: 100, height: 100))
  text("Compacta", 208, 78, 64, .bold, 0x241E1A, h)
  text("Prepare context.", 80, 220, 70, .bold, 0x241E1A, h)
  text("Keep building.", 80, 303, 70, .bold, 0x241E1A, h)
  text("Background summaries for long coding conversations.", 83, 416, 23, .regular, 0x786E66, h)
  text("macOS · Apple Silicon · Open source", 83, 535, 18, .regular, 0x786E66, h)
  text("github.com/manomx/compacta", 932, 535, 18, .regular, 0xB4440D, h)
}
print("Rendered social-preview.png (1280 × 640) and compacta-logo.png (512 × 512)")
