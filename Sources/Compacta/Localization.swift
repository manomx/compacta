import Foundation

// Interface languages. Strings live in Resources/Localization/<code>.lproj:
// - Localizable.strings: the app's own text, by stable key.
// - ServiceMessages.strings: text that the background service reports (notes,
//   errors, activity, limit labels). The service speaks canonical Spanish; the
//   key is that exact Spanish text and the app translates it for display.
// This file depends on Foundation only so it can be checked without AppKit.

enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
  case english = "en"
  case spanish = "es"
  case simplifiedChinese = "zh-Hans"
  var id: String { rawValue }
  var code: String { rawValue }
  /// Each language is offered in its own name, so it can be found in any interface language.
  var nativeName: String {
    switch self {
    case .english: "English"
    case .spanish: "Español"
    case .simplifiedChinese: "简体中文"
    }
  }
  var locale: Locale { Locale(identifier: self == .simplifiedChinese ? "zh-Hans" : rawValue) }

  /// Maps the first macOS preferred language to a supported interface language.
  /// es* → es; zh-Hans, zh-CN, zh-SG and plain zh → zh-Hans; everything else,
  /// including Traditional Chinese, → en.
  static func detect(preferredLanguages: [String]) -> AppLanguage {
    guard let first = preferredLanguages.first else { return .english }
    let parts = first.replacingOccurrences(of: "_", with: "-").lowercased()
      .split(separator: "-").map(String.init)
    guard let base = parts.first else { return .english }
    switch base {
    case "es": return .spanish
    case "zh":
      let rest = Set(parts.dropFirst())
      if rest.contains("hant") { return .english }
      if rest.contains("hans") { return .simplifiedChinese }
      if !rest.isDisjoint(with: ["tw", "hk", "mo"]) { return .english }
      return .simplifiedChinese
    default: return .english
    }
  }
}

/// Stored choice: follow the system language, or a fixed language.
enum LanguagePreference: Equatable, Sendable {
  case system
  case fixed(AppLanguage)
  static let defaultsKey = "CompactaInterfaceLanguage"
  init(stored: String?) {
    if let stored, let language = AppLanguage(rawValue: stored) {
      self = .fixed(language)
    } else {
      self = .system
    }
  }
  var stored: String? {
    if case .fixed(let language) = self { return language.rawValue }
    return nil
  }
  func resolve(preferredLanguages: [String]) -> AppLanguage {
    if case .fixed(let language) = self { return language }
    return AppLanguage.detect(preferredLanguages: preferredLanguages)
  }
}

/// Thread-safe string tables for the current interface language.
final class Strings: @unchecked Sendable {
  static let shared = Strings()
  private let lock = NSLock()
  private var language: AppLanguage = .english
  private var tables: [String: [String: String]] = [:]
  private var directories: [URL]

  init(directories: [URL]? = nil) {
    if let directories {
      self.directories = directories
    } else {
      var list: [URL] = []
      if let custom = ProcessInfo.processInfo.environment["COMPACTA_LOCALIZATION_DIR"] {
        list.append(URL(fileURLWithPath: custom))
      }
      if let resources = Bundle.main.resourceURL { list.append(resources) }
      list.append(
        URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
          .appendingPathComponent("Resources/Localization"))
      self.directories = list
    }
  }

  var current: AppLanguage {
    lock.lock()
    defer { lock.unlock() }
    return language
  }
  var locale: Locale { current.locale }

  func use(_ value: AppLanguage) {
    lock.lock()
    language = value
    lock.unlock()
  }

  func table(_ name: String, _ language: AppLanguage) -> [String: String] {
    let id = language.rawValue + "/" + name
    lock.lock()
    defer { lock.unlock() }
    if let cached = tables[id] { return cached }
    var result: [String: String] = [:]
    for directory in directories {
      let url = directory.appendingPathComponent("\(language.rawValue).lproj/\(name).strings")
      if let data = try? Data(contentsOf: url),
        let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
          as? [String: String]
      {
        result = plist
        break
      }
    }
    tables[id] = result
    return result
  }

  /// App text by key. Falls back to English, then to the key itself.
  func text(_ key: String) -> String {
    let language = current
    if let value = table("Localizable", language)[key] { return value }
    if language != .english, let value = table("Localizable", .english)[key] { return value }
    return key
  }

  /// Text reported by the service in canonical Spanish, shown in the interface language.
  /// Activity details and limit labels join parts with " · " and errors join lines
  /// with newlines, so each part is translated on its own. Unknown text, such as
  /// a provider's own error message, is shown as received.
  func service(_ raw: String) -> String {
    let language = current
    if language == .spanish || raw.isEmpty { return raw }
    let messages = table("ServiceMessages", language)
    return raw.components(separatedBy: "\n").map { line in
      if let whole = messages[line] { return whole }
      return line.components(separatedBy: " · ").map { serviceSegment($0, messages) }
        .joined(separator: " · ")
    }.joined(separator: "\n")
  }

  private func serviceSegment(_ segment: String, _ messages: [String: String]) -> String {
    if let value = messages[segment] { return value }
    // Messages with values. Each pattern has a template in ServiceMessages.strings
    // whose key starts with "pattern." and uses %1$@, %2$@… for the captured values.
    for (key, pattern) in Strings.servicePatterns {
      guard let template = messages[key],
        let captures = Strings.match(pattern, segment)
      else { continue }
      let values = captures.map { messages[$0] ?? $0 }
      return format(template, values)
    }
    return segment
  }

  static let servicePatterns: [(String, String)] = [
    ("pattern.valueRange", "^(.+): usa un valor entre (-?\\d+) y (-?\\d+)\\.$"),
    ("pattern.httpStatus", "^El proveedor respondió HTTP (\\d+)\\.$"),
    ("pattern.selectProvider", "^Selecciona un proveedor existente para (.+)$"),
    ("pattern.hours", "^(\\d+) horas$"),
    ("pattern.completedResponses", "^respuestas completas: (\\d+)$"),
    ("pattern.pendingItems", "^(\\d+) elementos por incorporar$"),
    ("pattern.item", "^elemento (.+)$"),
    ("pattern.messages", "^(\\d+) mensajes$"),
  ]

  static func match(_ pattern: String, _ text: String) -> [String]? {
    guard let regex = try? NSRegularExpression(pattern: pattern),
      let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
    else { return nil }
    return (1..<m.numberOfRanges).compactMap { i in
      Range(m.range(at: i), in: text).map { String(text[$0]) }
    }
  }
}

/// Replaces %@ (in order) and %1$@, %2$@… (by position) with values; %% is a percent sign.
func format(_ template: String, _ values: [String]) -> String {
  var out = ""
  var next = 0
  var i = template.startIndex
  while i < template.endIndex {
    let c = template[i]
    guard c == "%", template.index(after: i) < template.endIndex else {
      out.append(c)
      i = template.index(after: i)
      continue
    }
    var j = template.index(after: i)
    if template[j] == "%" {
      out.append("%")
      i = template.index(after: j)
      continue
    }
    if template[j] == "@" {
      out += next < values.count ? values[next] : ""
      next += 1
      i = template.index(after: j)
      continue
    }
    var digits = ""
    while j < template.endIndex, template[j].isNumber {
      digits.append(template[j])
      j = template.index(after: j)
    }
    if !digits.isEmpty, j < template.endIndex, template[j] == "$",
      template.index(after: j) < template.endIndex,
      template[template.index(after: j)] == "@", let n = Int(digits)
    {
      out += n >= 1 && n <= values.count ? values[n - 1] : ""
      i = template.index(j, offsetBy: 2)
      continue
    }
    out.append(c)
    i = template.index(after: i)
  }
  return out
}

/// Localized app text. Values replace %@ or %1$@ placeholders in order.
func L(_ key: String, _ values: Any...) -> String {
  let template = Strings.shared.text(key)
  return values.isEmpty && !template.contains("%%")
    ? template : format(template, values.map { "\($0)" })
}

/// Text from the service, shown in the interface language.
func LS(_ raw: String) -> String { Strings.shared.service(raw) }
