import Combine
import Foundation

/// Interface language chosen in Settings. Changes apply immediately to Compacta's
/// own windows, menus and status item. Panels drawn by macOS itself (save dialog,
/// About panel) follow the new language after Compacta restarts.
@MainActor final class LanguageSettings: ObservableObject {
  static let shared = LanguageSettings()
  @Published private(set) var preference: LanguagePreference
  @Published private(set) var language: AppLanguage
  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let preference = LanguagePreference(
      stored: defaults.string(forKey: LanguagePreference.defaultsKey))
    self.preference = preference
    // A fixed choice writes AppleLanguages to this app's domain; with "system" that
    // key is absent, so Locale.preferredLanguages is the user's macOS list.
    // An empty or unsupported list resolves to English.
    language = preference.resolve(preferredLanguages: Self.systemLanguages())
    Strings.shared.use(language)
  }

  func select(_ value: LanguagePreference) {
    preference = value
    if let stored = value.stored {
      defaults.set(stored, forKey: LanguagePreference.defaultsKey)
      defaults.set([stored], forKey: "AppleLanguages")
    } else {
      defaults.removeObject(forKey: LanguagePreference.defaultsKey)
      defaults.removeObject(forKey: "AppleLanguages")
    }
    let resolved = value.resolve(preferredLanguages: Self.systemLanguages())
    Strings.shared.use(resolved)
    language = resolved
  }

  /// The macOS language list, ignoring this app's own AppleLanguages override.
  static func systemLanguages() -> [String] {
    CFPreferencesCopyValue(
      "AppleLanguages" as CFString, kCFPreferencesAnyApplication, kCFPreferencesCurrentUser,
      kCFPreferencesAnyHost) as? [String] ?? Locale.preferredLanguages
  }
}
