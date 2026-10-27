import AppKit
import CoreText
import SwiftUI

// MARK: - Tipografía

enum Typeface {
  static func register() {
    let candidates = [
      Bundle.main.url(forResource: "PlusJakartaSans", withExtension: "ttf"),
      URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("Resources/Fonts/PlusJakartaSans.ttf"),
    ]
    for case let url? in candidates where FileManager.default.fileExists(atPath: url.path) {
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
      return
    }
  }
  static let available: Bool = {
    register()
    return NSFont(name: "PlusJakartaSans-Regular", size: 12) != nil
  }()
}

/// Plus Jakarta Sans con respaldo en SF Pro Rounded si la fuente no está disponible.
func jf(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
  guard Typeface.available else { return .system(size: size, weight: weight, design: .rounded) }
  let name: String
  switch weight {
  case .ultraLight, .thin, .light: name = "PlusJakartaSans-Regular_Light"
  case .medium: name = "PlusJakartaSans-Regular_Medium"
  case .semibold: name = "PlusJakartaSans-Regular_SemiBold"
  case .bold: name = "PlusJakartaSans-Regular_Bold"
  case .heavy, .black: name = "PlusJakartaSans-Regular_ExtraBold"
  default: name = "PlusJakartaSans-Regular"
  }
  return .custom(name, fixedSize: size)
}

// MARK: - Paleta

extension Color {
  static func dynamic(_ light: NSColor, _ dark: NSColor) -> Color {
    Color(
      nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
      })
  }
}
private func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

enum Neu {
  static let base = Color.dynamic(rgb(0xf0ebe6), rgb(0x2b2622))
  static let baseNS = NSColor(name: nil) {
    $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(0x2b2622) : rgb(0xf0ebe6)
  }
  static let hi = Color.dynamic(rgb(0xffffff, 0.95), rgb(0x4e443c, 0.55))
  static let lo = Color.dynamic(rgb(0xbea894, 0.62), rgb(0x0c0907, 0.78))
  static let text = Color.dynamic(rgb(0x3b3029), rgb(0xf2ece6))
  static let text2 = Color.dynamic(rgb(0x8c7c70), rgb(0xaa9b8f))
  static let text3 = Color.dynamic(rgb(0xb3a497), rgb(0x73675d))
  static let accent = Color.dynamic(rgb(0xf76b15), rgb(0xff8a3d))
  static let accent2 = Color.dynamic(rgb(0xffa24a), rgb(0xffb066))
  static let deep = Color.dynamic(rgb(0xd4530b), rgb(0xffa24a))
  static let warn = Color.dynamic(rgb(0xe5402b), rgb(0xff6a52))
  static let claude = Color.dynamic(rgb(0xd97757), rgb(0xe8987b))
  static let fill = LinearGradient(
    colors: [accent2, accent], startPoint: .leading, endPoint: .trailing)
  static let warnFill = LinearGradient(
    colors: [Color.dynamic(rgb(0xff7a45), rgb(0xff8a5c)), warn], startPoint: .leading,
    endPoint: .trailing)
  static let spring = Animation.spring(response: 0.5, dampingFraction: 0.78)
  static let softSpring = Animation.spring(response: 0.7, dampingFraction: 0.85)
}
let accent = Neu.accent

// MARK: - Relieve

extension View {
  /// Superficie en relieve (sale de la base).
  func neuRaised<S: Shape>(_ shape: S, depth: CGFloat = 7) -> some View {
    background(
      shape.fill(Neu.base)
        .shadow(color: Neu.lo, radius: depth, x: depth * 0.8, y: depth * 0.8)
        .shadow(color: Neu.hi, radius: depth, x: -depth * 0.8, y: -depth * 0.8))
  }
  func neuRaised(radius: CGFloat, depth: CGFloat = 7) -> some View {
    neuRaised(RoundedRectangle(cornerRadius: radius, style: .continuous), depth: depth)
  }
  /// Superficie hundida (pozo).
  func neuInset<S: Shape>(_ shape: S, depth: CGFloat = 4) -> some View {
    background(
      ZStack {
        shape.fill(Neu.base)
        shape.stroke(Neu.lo, lineWidth: depth * 1.6).blur(radius: depth)
          .offset(x: depth * 0.6, y: depth * 0.6).mask(shape)
        shape.stroke(Neu.hi, lineWidth: depth * 1.6).blur(radius: depth)
          .offset(x: -depth * 0.6, y: -depth * 0.6).mask(shape)
      })
  }
  func neuInset(radius: CGFloat, depth: CGFloat = 4) -> some View {
    neuInset(RoundedRectangle(cornerRadius: radius, style: .continuous), depth: depth)
  }
  /// Aparición escalonada con resorte.
  func reveal(_ index: Int) -> some View { modifier(Reveal(index: index)) }
}

struct Reveal: ViewModifier {
  var index: Int
  @State private var shown = false
  func body(content: Content) -> some View {
    content.opacity(shown ? 1 : 0).offset(y: shown ? 0 : 12)
      .onAppear {
        withAnimation(Neu.softSpring.delay(Double(index) * 0.06 + 0.05)) { shown = true }
      }
  }
}

// MARK: - Tarjeta

struct Panel<Content: View>: View {
  let title: String?
  let subtitle: String?
  let content: Content
  init(title: String? = nil, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
    self.title = title
    self.subtitle = subtitle
    self.content = content()
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let title {
        VStack(alignment: .leading, spacing: 4) {
          Text(title).font(jf(15, .bold)).foregroundStyle(Neu.text)
          if let subtitle {
            Text(subtitle).font(jf(12)).foregroundStyle(Neu.text2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      content
    }
    .padding(22).frame(maxWidth: .infinity, alignment: .leading)
    .neuRaised(radius: 26, depth: 8)
  }
}

struct SectionTitle<Trailing: View>: View {
  var title: String
  @ViewBuilder var trailing: Trailing
  var body: some View {
    HStack {
      Text(title).font(jf(19, .bold)).foregroundStyle(Neu.text)
      Spacer()
      trailing
    }.padding(.horizontal, 4)
  }
}
extension SectionTitle where Trailing == EmptyView {
  init(_ title: String) { self.init(title: title) { EmptyView() } }
}

// MARK: - Botones

struct NeuButtonStyle: ButtonStyle {
  var prominent = false
  var destructive = false
  var compact = false
  @Environment(\.isEnabled) var enabled
  func makeBody(configuration: Configuration) -> some View {
    let pressed = configuration.isPressed
    let shape = RoundedRectangle(cornerRadius: compact ? 11 : 13, style: .continuous)
    return configuration.label
      .font(jf(compact ? 12 : 13, .semibold))
      .padding(.horizontal, compact ? 12 : 16).frame(height: compact ? 30 : 38)
      .foregroundStyle(prominent ? Color.white : destructive ? Neu.warn : Neu.text)
      .background {
        if prominent {
          shape.fill(
            LinearGradient(
              colors: [Neu.accent2, Neu.accent], startPoint: .topLeading,
              endPoint: .bottomTrailing)
          )
          .shadow(color: Neu.accent.opacity(pressed ? 0.15 : 0.4), radius: pressed ? 3 : 9, y: 4)
          .shadow(color: Neu.hi, radius: 6, x: -4, y: -4)
        } else if pressed {
          Color.clear.neuInset(shape, depth: 3)
        } else {
          Color.clear.neuRaised(shape, depth: 4)
        }
      }
      .contentShape(shape)
      .scaleEffect(pressed ? 0.97 : 1)
      .opacity(enabled ? 1 : 0.45)
      .animation(.spring(response: 0.3, dampingFraction: 0.7), value: pressed)
  }
}
extension ButtonStyle where Self == NeuButtonStyle {
  static var neu: NeuButtonStyle { NeuButtonStyle() }
  static var neuProminent: NeuButtonStyle { NeuButtonStyle(prominent: true) }
  static var neuDestructive: NeuButtonStyle { NeuButtonStyle(destructive: true) }
  static var neuCompact: NeuButtonStyle { NeuButtonStyle(compact: true) }
}

/// Botón de texto con color de acento (enlaces, "Actualizar").
struct LinkButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(jf(12.5, .semibold)).foregroundStyle(Neu.accent)
      .padding(.horizontal, 12).frame(height: 32)
      .background {
        if configuration.isPressed {
          Color.clear.neuInset(radius: 12, depth: 3)
        } else {
          Color.clear.neuRaised(radius: 12, depth: 4)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: 12))
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
  }
}

// MARK: - Interruptor

struct NeuToggleStyle: ToggleStyle {
  @Environment(\.isEnabled) var enabled
  func makeBody(configuration: Configuration) -> some View {
    HStack {
      configuration.label
      Spacer(minLength: 12)
      ZStack(alignment: configuration.isOn ? .trailing : .leading) {
        Capsule().fill(Color.clear).frame(width: 54, height: 30).neuInset(Capsule(), depth: 3)
        Capsule().fill(Neu.fill).frame(width: 46, height: 22).padding(4)
          .opacity(configuration.isOn ? 1 : 0)
        Circle().fill(configuration.isOn ? Color.white : Neu.base).frame(width: 22, height: 22)
          .shadow(
            color: configuration.isOn
              ? Color(red: 0.47, green: 0.2, blue: 0.04).opacity(0.35) : Neu.lo,
            radius: 3, x: 2, y: 2
          )
          .shadow(color: Neu.hi.opacity(configuration.isOn ? 0 : 1), radius: 3, x: -2, y: -2)
          .padding(4)
      }
      .opacity(enabled ? 1 : 0.5)
      .onTapGesture { withAnimation(Neu.spring) { configuration.isOn.toggle() } }
      .accessibilityAddTraits(.isButton)
    }
  }
}
extension ToggleStyle where Self == NeuToggleStyle {
  static var neu: NeuToggleStyle { NeuToggleStyle() }
}

// MARK: - Control segmentado

struct NeuSegmented<T: Hashable>: View {
  @Binding var selection: T
  var options: [(T, String)]
  var stretch = false
  @Namespace private var ns
  var body: some View {
    HStack(spacing: 2) {
      ForEach(options.indices, id: \.self) { i in
        let (value, label) = options[i]
        let on = value == selection
        Button {
          withAnimation(Neu.spring) { selection = value }
        } label: {
          Text(label).font(jf(12.5, .semibold))
            .foregroundStyle(on ? Neu.accent : Neu.text3)
            .padding(.horizontal, 15).frame(height: 30)
            .frame(maxWidth: stretch ? .infinity : nil)
            .background {
              if on {
                RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Neu.base)
                  .shadow(color: Neu.lo, radius: 3, x: 2.5, y: 2.5)
                  .shadow(color: Neu.hi, radius: 3, x: -2.5, y: -2.5)
                  .matchedGeometryEffect(id: "thumb", in: ns)
              }
            }
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
      }
    }
    .padding(5).neuInset(radius: 15, depth: 3)
  }
}

// MARK: - Menú desplegable

struct NeuMenu<T: Hashable>: View {
  @Binding var selection: T
  var options: [(T, String)]
  var width: CGFloat? = nil
  var body: some View {
    Menu {
      ForEach(options.indices, id: \.self) { i in
        Button(options[i].1) { selection = options[i].0 }
      }
    } label: {
      HStack(spacing: 8) {
        Text(options.first(where: { $0.0 == selection })?.1 ?? L("menu.choose")).font(jf(12.5, .semibold))
          .foregroundStyle(Neu.text).lineLimit(1)
        Spacer(minLength: 4)
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
          .foregroundStyle(Neu.accent)
      }
      .padding(.horizontal, 14).frame(width: width, height: 34)
      .neuRaised(radius: 12, depth: 4)
      .contentShape(Rectangle())
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
  }
}

// MARK: - Campos

struct NeuFieldModifier: ViewModifier {
  var width: CGFloat?
  var mono = false
  func body(content: Content) -> some View {
    content.textFieldStyle(.plain).font(
      mono ? .system(size: 12, design: .monospaced) : jf(13, .medium)
    )
    .foregroundStyle(Neu.text)
    .padding(.horizontal, 12).frame(width: width, height: 34)
    .neuInset(radius: 11, depth: 3)
  }
}
extension View {
  func neuField(width: CGFloat? = nil, mono: Bool = false) -> some View {
    modifier(NeuFieldModifier(width: width, mono: mono))
  }
}

struct NeuStepper: View {
  var title: String
  @Binding var value: Int
  var range: ClosedRange<Int>
  var step = 1
  var body: some View {
    HStack {
      Text(title).font(jf(13)).foregroundStyle(Neu.text)
      Spacer()
      HStack(spacing: 6) {
        knob("minus") { value = max(range.lowerBound, value - step) }.disabled(
          value <= range.lowerBound)
        knob("plus") { value = min(range.upperBound, value + step) }.disabled(
          value >= range.upperBound)
      }.padding(4).neuInset(Capsule(), depth: 3)
    }
  }
  func knob(_ symbol: String, action: @escaping () -> Void) -> some View {
    Button {
      withAnimation(Neu.spring) { action() }
    } label: {
      Image(systemName: symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(Neu.accent)
        .frame(width: 26, height: 26)
    }.buttonStyle(KnobStyle())
  }
}
struct KnobStyle: ButtonStyle {
  @Environment(\.isEnabled) var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background {
        if configuration.isPressed {
          Color.clear.neuInset(Circle(), depth: 2)
        } else {
          Color.clear.neuRaised(Circle(), depth: 2.5)
        }
      }
      .opacity(enabled ? 1 : 0.35).contentShape(Circle())
  }
}

// MARK: - Deslizador

struct NeuSlider: View {
  @Binding var value: Double
  var range: ClosedRange<Double>
  var step: Double = 1
  @GestureState private var dragging = false
  var body: some View {
    GeometryReader { geo in
      let knob: CGFloat = 26
      let usable = geo.size.width - knob
      let t = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
      ZStack(alignment: .leading) {
        Capsule().fill(Color.clear).frame(height: 14).neuInset(Capsule(), depth: 3)
        Capsule().fill(Neu.fill).frame(width: max(8, usable * t + knob / 2), height: 8)
          .padding(.leading, 3).shadow(color: Neu.accent.opacity(0.35), radius: 4, y: 2)
        Circle().fill(Neu.base).frame(width: knob, height: knob)
          .overlay(Circle().fill(Neu.accent).frame(width: 7, height: 7))
          .shadow(color: Neu.lo, radius: 4, x: 3, y: 3).shadow(
            color: Neu.hi, radius: 4, x: -3, y: -3
          )
          .scaleEffect(dragging ? 1.12 : 1)
          .offset(x: usable * t)
          .animation(.spring(response: 0.3, dampingFraction: 0.7), value: dragging)
      }
      .frame(height: knob).frame(maxHeight: .infinity)
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .updating($dragging) { _, s, _ in s = true }
          .onChanged { g in
            let p = min(1, max(0, (g.location.x - knob / 2) / usable))
            let raw = range.lowerBound + p * (range.upperBound - range.lowerBound)
            value = (raw / step).rounded() * step
          })
    }.frame(height: 30)
  }
}

// MARK: - Progreso y medidores

struct NeuProgress: View {
  var value: Double  // 0...1
  var warning = false
  var height: CGFloat = 10
  @State private var shown = false
  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.clear).neuInset(Capsule(), depth: 2.5)
        Capsule().fill(warning ? Neu.warnFill : Neu.fill)
          .frame(width: max(height - 4, (geo.size.width - 4) * (shown ? min(1, max(0, value)) : 0)))
          .padding(2)
          .shadow(color: (warning ? Neu.warn : Neu.accent).opacity(0.3), radius: 3, y: 1.5)
      }
    }
    .frame(height: height)
    .onAppear {
      withAnimation(.spring(response: 1.2, dampingFraction: 0.85).delay(0.15)) { shown = true }
    }
    .animation(.spring(response: 1, dampingFraction: 0.85), value: value)
  }
}

struct NeuGauge: View {
  var percent: Double
  var warning = false
  var size: CGFloat = 96
  var caption = L("gauge.used")
  @State private var shown = false
  var body: some View {
    let ring = size - 20
    ZStack {
      Circle().fill(Color.clear).frame(width: size, height: size).neuRaised(Circle(), depth: 4)
      Circle().fill(Color.clear).frame(width: ring, height: ring).neuInset(Circle(), depth: 3)
      Circle().trim(from: 0, to: shown ? min(1, max(0, percent / 100)) : 0)
        .stroke(
          warning ? Neu.warn : Neu.accent,
          style: StrokeStyle(lineWidth: size * 0.075, lineCap: .round)
        )
        .rotationEffect(.degrees(-90)).frame(width: ring - size * 0.09, height: ring - size * 0.09)
        .shadow(color: (warning ? Neu.warn : Neu.accent).opacity(0.45), radius: 3)
      VStack(spacing: 0) {
        Text("\(Int(percent.rounded()))").font(jf(size * 0.2, .bold)).foregroundStyle(Neu.text)
          .contentTransition(.numericText(value: percent)).monospacedDigit()
        if !caption.isEmpty {
          Text(caption).font(jf(max(8, size * 0.1))).foregroundStyle(Neu.text2)
        }
      }
    }
    .onAppear {
      withAnimation(.spring(response: 1.5, dampingFraction: 0.85).delay(0.2)) { shown = true }
    }
    .animation(.spring(response: 1.2, dampingFraction: 0.85), value: percent)
  }
}

struct StatusLED: View {
  var on: Bool
  @State private var glow = false
  var body: some View {
    Circle().fill(Color.clear).frame(width: 14, height: 14).neuInset(Circle(), depth: 1.5)
      .overlay(
        Circle().fill(on ? Neu.accent : Neu.text3).frame(width: 6, height: 6)
          .shadow(color: on ? Neu.accent : .clear, radius: glow ? 2 : 5)
      )
      .onAppear {
        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { glow = true }
      }
  }
}

// MARK: - Marca: la C condensada

struct LogoMark: View {
  var size: CGFloat
  var color: Color = Neu.accent
  var live = false
  var paused = false
  @State private var drawn = false
  @State private var breathe = false
  var body: some View {
    let k = size / 24
    ZStack {
      arc(diameter: 18.6 * k, width: 2.1 * k, opacity: 0.5)
        .scaleEffect(breathe ? 0.88 : 1).rotationEffect(.degrees(breathe ? -8 : 0))
        .animation(breathing(0), value: breathe)
      arc(diameter: 11.8 * k, width: 2.1 * k, opacity: 0.82)
        .scaleEffect(breathe ? 0.9 : 1).rotationEffect(.degrees(breathe ? -5 : 0))
        .animation(breathing(0.12), value: breathe)
      Circle().fill(color).frame(width: 5.2 * k, height: 5.2 * k)
        .scaleEffect(drawn ? (breathe ? 1.22 : 1) : 0.01)
        .animation(breathing(0.24), value: breathe)
    }
    .frame(width: size, height: size)
    .onAppear {
      withAnimation(.spring(response: 1.1, dampingFraction: 0.8).delay(0.2)) { drawn = true }
      if live && !paused {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { breathe = true }
      }
    }
    .onChange(of: paused) { _, p in
      if p { breathe = false } else if live { breathe = true }
    }
  }
  func breathing(_ delay: Double) -> Animation? {
    guard live, !paused, breathe else { return .easeOut(duration: 0.6) }
    return .easeInOut(duration: 1.9).repeatForever(autoreverses: true).delay(delay)
  }
  func arc(diameter: CGFloat, width: CGFloat, opacity: Double) -> some View {
    Circle().trim(from: 0.125, to: drawn ? 0.875 : 0.125)
      .stroke(color.opacity(opacity), style: StrokeStyle(lineWidth: width, lineCap: .round))
      .frame(width: diameter, height: diameter)
  }
}

/// Mosaico naranja con la marca en blanco (barra lateral, menú).
struct LogoTile: View {
  var size: CGFloat
  var body: some View {
    RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
      .fill(
        RadialGradient(
          colors: [
            Color(red: 1, green: 0.69, blue: 0.4), Neu.accent,
            Color(red: 0.79, green: 0.28, blue: 0.04),
          ],
          center: UnitPoint(x: 0.3, y: 0.15), startRadius: 0, endRadius: size * 1.1)
      )
      .overlay(LogoMark(size: size * 0.62, color: .white))
      .frame(width: size, height: size)
      .shadow(color: Neu.accent.opacity(0.35), radius: 5, y: 3)
  }
}

/// Imagen plantilla de la marca para la barra de menús.
enum StatusIcon {
  static func image(size: CGFloat = 18, rotation: CGFloat = 0) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
      let k = rect.width / 24
      let c = NSPoint(x: rect.midX, y: rect.midY)
      func arc(_ r: CGFloat, alpha: CGFloat) {
        let p = NSBezierPath()
        p.appendArc(
          withCenter: c, radius: r * k, startAngle: 45 - rotation,
          endAngle: 315 - rotation, clockwise: false)
        p.lineWidth = 2.3 * k
        p.lineCapStyle = .round
        NSColor.black.withAlphaComponent(alpha).setStroke()
        p.stroke()
      }
      arc(9.3, alpha: 0.55)
      arc(5.9, alpha: 0.85)
      NSColor.black.setFill()
      NSBezierPath(
        ovalIn: NSRect(x: c.x - 2.7 * k, y: c.y - 2.7 * k, width: 5.4 * k, height: 5.4 * k)
      ).fill()
      return true
    }
    image.isTemplate = true
    return image
  }
}

// MARK: - Mini gráficas

struct Sparkline: View {
  var values: [Double]
  @State private var drawn = false
  var body: some View {
    GeometryReader { geo in
      let pts = points(in: geo.size)
      ZStack {
        path(pts, closed: true, size: geo.size)
          .fill(
            LinearGradient(
              colors: [Neu.accent.opacity(0.22), Neu.accent.opacity(0)], startPoint: .top,
              endPoint: .bottom)
          )
          .opacity(drawn ? 1 : 0)
        path(pts, closed: false, size: geo.size).trim(from: 0, to: drawn ? 1 : 0)
          .stroke(Neu.accent, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
          .shadow(color: Neu.accent.opacity(0.35), radius: 3, y: 2)
      }
    }
    .onAppear { withAnimation(.easeOut(duration: 1.5).delay(0.3)) { drawn = true } }
    .onChange(of: values) { _, _ in
      drawn = false
      withAnimation(.easeOut(duration: 1.2)) { drawn = true }
    }
  }
  func points(in size: CGSize) -> [CGPoint] {
    // Rellena con ceros las horas sin consumo para que la serie siempre se lea como tendencia.
    let v = Array(repeating: 0.0, count: max(0, 8 - values.count)) + values
    let maxV = max(v.max() ?? 1, 1)
    return v.enumerated().map { i, y in
      CGPoint(
        x: size.width * CGFloat(i) / CGFloat(v.count - 1),
        y: size.height - 3 - (size.height - 8) * CGFloat(y / maxV))
    }
  }
  func path(_ pts: [CGPoint], closed: Bool, size: CGSize) -> Path {
    Path { p in
      guard let first = pts.first else { return }
      p.move(to: first)
      for i in 1..<pts.count {
        let a = pts[i - 1]
        let b = pts[i]
        let mx = (a.x + b.x) / 2
        p.addCurve(to: b, control1: CGPoint(x: mx, y: a.y), control2: CGPoint(x: mx, y: b.y))
      }
      if closed {
        p.addLine(to: CGPoint(x: size.width, y: size.height))
        p.addLine(to: CGPoint(x: 0, y: size.height))
        p.closeSubpath()
      }
    }
  }
}

struct MiniBars: View {
  var values: [Double]
  @State private var grown = false
  var body: some View {
    let recent = Array(values.suffix(14))
    let v = Array(repeating: 0.0, count: max(0, 12 - recent.count)) + recent
    let maxV = max(v.max() ?? 1, 1)
    HStack(alignment: .bottom, spacing: 5) {
      ForEach(v.indices, id: \.self) { i in
        RoundedRectangle(cornerRadius: 3.5, style: .continuous)
          .fill(
            LinearGradient(colors: [Neu.accent2, Neu.accent], startPoint: .top, endPoint: .bottom)
          )
          .opacity(i == v.count - 1 ? 1 : 0.3)
          .frame(maxWidth: .infinity)
          .frame(height: max(3, CGFloat(v[i] / maxV) * 48 * (grown ? 1 : 0.04)))
          .animation(
            .spring(response: 0.8, dampingFraction: 0.75).delay(Double(i) * 0.03), value: grown)
      }
    }
    .frame(maxHeight: .infinity, alignment: .bottom)
    .onAppear { grown = true }
  }
}

/// Pozo para gráficas pequeñas dentro de una tarjeta.
struct ChartWell<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    content.padding(.horizontal, 10).padding(.vertical, 8).frame(height: 72)
      .neuInset(radius: 16, depth: 3)
  }
}

/// Icono de cliente sobre un botón en relieve.
struct ClientIcon: View {
  var client: String
  var size: CGFloat = 40
  var body: some View {
    Image(systemName: client == "claude" ? "asterisk" : client == "codex" ? "terminal" : "network")
      .font(.system(size: size * 0.42, weight: .bold))
      .foregroundStyle(client == "claude" ? Neu.claude : client == "codex" ? Neu.text : Neu.accent)
      .frame(width: size, height: size)
      .neuRaised(radius: size * 0.32, depth: 3.5)
  }
}

struct Chip: View {
  var text: String
  var color: Color = Neu.text2
  var body: some View {
    Text(text).font(jf(10.5, .bold)).foregroundStyle(color)
      .padding(.horizontal, 9).padding(.vertical, 4).neuInset(Capsule(), depth: 2)
  }
}
