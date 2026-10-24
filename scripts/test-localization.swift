import Foundation

// Checks language detection, the stored preference, string tables, placeholders,
// and translation of service messages. Compiled with Sources/Compacta/Localization.swift.
@main enum LocalizationCheck {
  static var failures = 0
  static func expect<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
    if actual != expected {
      failures += 1
      print("FAIL \(label): expected \(expected), got \(actual)")
    }
  }
  static func main() {
    // System language detection. Anything unsupported or empty starts in English.
    let cases: [([String], AppLanguage)] = [
      (["es-MX", "en-US"], .spanish), (["es"], .spanish), (["es_419"], .spanish),
      (["en-US"], .english), (["en-GB", "es-ES"], .english), (["en"], .english),
      (["zh-Hans-CN"], .simplifiedChinese), (["zh-Hans"], .simplifiedChinese),
      (["zh-CN"], .simplifiedChinese), (["zh_CN"], .simplifiedChinese),
      (["zh-SG"], .simplifiedChinese), (["zh"], .simplifiedChinese),
      (["zh-Hant-TW"], .english), (["zh-TW"], .english), (["zh-HK"], .english),
      (["fr-FR", "es-ES"], .english), (["ja-JP"], .english), (["de"], .english),
      ([], .english), ([""], .english), (["-"], .english),
    ]
    for (list, language) in cases {
      expect(AppLanguage.detect(preferredLanguages: list), language, "detect \(list)")
    }
    // Stored preference.
    expect(LanguagePreference(stored: nil), .system, "no stored value follows the system")
    expect(LanguagePreference(stored: "fr"), .system, "unknown stored value follows the system")
    expect(LanguagePreference(stored: "zh-Hans"), .fixed(.simplifiedChinese), "stored zh-Hans")
    expect(LanguagePreference.fixed(.spanish).stored, "es", "stored es")
    expect(
      LanguagePreference.fixed(.spanish).resolve(preferredLanguages: ["en-US"]), .spanish,
      "fixed choice wins over the system")
    expect(
      LanguagePreference.system.resolve(preferredLanguages: ["it-IT"]), .english,
      "system fallback")

    // Placeholder formatting.
    expect(format("%@ %%", ["85"]), "85 %", "percent")
    expect(format("%2$@/%1$@ %3$@", ["21", "10", "15"]), "10/21 15", "positional")
    expect(format("%@ de %@", ["a", "b"]), "a de b", "sequential")

    // String tables load from Resources/Localization.
    let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
      .appendingPathComponent("Resources/Localization")
    let strings = Strings(directories: [root])
    let english = strings.table("Localizable", .english)
    if english.count < 100 {
      failures += 1
      print("FAIL English table did not load from \(root.path)")
    }
    for language in AppLanguage.allCases {
      let table = strings.table("Localizable", language)
      expect(Set(table.keys), Set(english.keys), "\(language.code) has the same keys as English")
      expect(
        strings.table("InfoPlist", language)["NSAppleEventsUsageDescription"] != nil, true,
        "\(language.code) InfoPlist.strings")
    }
    strings.use(.english)
    expect(strings.text("page.settings"), "Settings", "English text")
    expect(strings.text("missing.key"), "missing.key", "missing key shows the key")
    strings.use(.spanish)
    expect(strings.text("page.settings"), "Ajustes", "Spanish text")
    expect(strings.service("Semana"), "Semana", "Spanish service text unchanged")
    strings.use(.simplifiedChinese)
    expect(strings.text("page.settings"), "设置", "Chinese text")
    expect(strings.service("Semana · Opus"), "每周 · Opus", "Chinese limit label")
    strings.use(.english)
    expect(strings.service("Semana · Opus"), "Week · Opus", "English limit label")
    expect(strings.service("5 horas"), "5 hours", "fixed label")
    expect(strings.service("3 horas"), "3 hours", "hours pattern")
    expect(
      strings.service("Retención: usa un valor entre 1 y 365."),
      "Retention: use a value between 1 and 365.", "range pattern with translated field")
    expect(
      strings.service("El proveedor respondió HTTP 503."),
      "The provider responded with HTTP 503.", "HTTP pattern")
    expect(
      strings.service("abc123 · respuesta terminada · resumen inicial"),
      "abc123 · response completed · initial summary", "activity detail parts")
    expect(
      strings.service("La URL del proveedor no es válida.\nTarifa inválida."),
      "The provider URL is not valid.\nInvalid price.", "multi-line errors")
    expect(strings.service("ECONNREFUSED 127.0.0.1"), "ECONNREFUSED 127.0.0.1", "unknown text")
    expect(strings.service("Mi cuenta de Codex"), "My Codex account", "default provider name")

    if failures > 0 {
      print("\(failures) localization check(s) failed")
      exit(1)
    }
    print("Localization checks passed: \(cases.count) detection cases, \(english.count) keys × \(AppLanguage.allCases.count) languages.")
  }
}
