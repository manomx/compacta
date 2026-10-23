import Foundation

struct Provider: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var kind: String
  var auth: String
  var baseURL: String
  var model: String
  var contextWindow: Int
  var inputPrice: Double?
  var outputPrice: Double?
  var cachePrice: Double?
  var cacheWritePrice: Double?
  var priceSource: String
  var priceDate: String
  var extraHeaders: [String: String]
  static var new: Provider {
    Provider(
      id: UUID().uuidString, name: "Nueva API", kind: "compatible", auth: "key",
      baseURL: "https://api.openai.com/v1", model: "", contextWindow: 200000, inputPrice: nil,
      outputPrice: nil, cachePrice: nil, cacheWritePrice: nil, priceSource: "Tarifa personalizada",
      priceDate: ISO8601DateFormatter().string(from: Date()), extraHeaders: [:])
  }
}
struct Policy: Codable, Equatable {
  var enabled: Bool
  var mode: String
  var thresholdPercent: Int
  var contextWindow: Int
  var providerID: String
  var model: String
  var effort: String
  var maxConcurrent: Int
  var cooldownSeconds: Int
  var minDeltaTokens: Int
  var keepRecent: Int
  var summaryTokens: Int
  var instructions: String
}
struct Settings: Codable, Equatable {
  var schema: Int
  var onboarded: Bool
  var paused: Bool
  var launchAtLogin: Bool
  var appearance: String
  var pollSeconds: Int
  var retentionDays: Int
  var dailyBudget: Double
  var codex: Policy
  var claude: Policy
  var providers: [Provider]
}
struct ClientIntegration: Codable {
  var detected: Bool
  var active: Bool
  var model: String
  var note: String
  var legacy: Bool?
}
struct Integrations: Codable {
  var codex: ClientIntegration
  var claude: ClientIntegration
}
struct SessionInfo: Codable, Identifiable {
  var key: String
  var ready: Bool
  var busy: Bool
  var lastError: String?
  var preparedAt: String?
  var lastInputTokens: Int?
  var model: String?
  var id: String { key }
}
struct EngineInfo: Codable {
  var activeJobs: Int
  var prepared: Int
  var fastCompactions: Int
  var sessions: [SessionInfo]
}
struct RateLimit: Codable, Identifiable {
  var label: String
  var usedPercent: Double
  var resetsAt: String?
  var id: String { label }
}
struct Quota: Codable {
  var client: String
  var available: Bool
  var fetchedAt: String?
  var plan: String
  var limits: [RateLimit]
  var error: String?
  var stale: Bool
}
struct ModelUsage: Codable, Identifiable {
  var client: String
  var kind: String
  var model: String
  var requests: Int
  var input: Int
  var output: Int
  var cost: Double
  var unpriced: Int
  var id: String { client + kind + model }
}
struct ChartPoint: Codable, Identifiable {
  var hour: String
  var input: Int
  var output: Int
  var cost: Double
  var id: String { hour }
}
struct Usage: Codable {
  var requests: Int
  var input: Int
  var output: Int
  var cached: Int
  var cacheWrite: Int
  var cost: Double
  var unpriced: Int
  var models: [ModelUsage]
  var chart: [ChartPoint]
}
struct Activity: Codable, Identifiable {
  var id: Int
  var at: String
  var client: String
  var title: String
  var detail: String
  var level: String
}
struct Snapshot: Codable {
  var version: String
  var config: Settings
  var integration: Integrations
  var codex: EngineInfo
  var claude: EngineInfo
  var quotas: [String: Quota]
  var usage: Usage
  var events: [Activity]
  var budgetReached: Bool
  var updatedAt: String
  var modelSuggestions: [String]
}
struct Runtime: Decodable {
  var port: Int
  var adminToken: String
  var pid: Int
}
enum Page: String, CaseIterable, Identifiable {
  case overview = "Resumen"
  case compaction = "Compactación"
  case providers = "Modelos y API"
  case activity = "Actividad"
  case settings = "Ajustes"
  var id: String { rawValue }
  var symbol: String {
    switch self {
    case .overview: "square.grid.2x2"
    case .compaction: "square.stack.3d.up"
    case .providers: "cpu"
    case .activity: "chart.bar.xaxis"
    case .settings: "slider.horizontal.3"
    }
  }
  var subtitle: String {
    switch self {
    case .overview: "Todo lo que necesitas saber, de un vistazo."
    case .compaction: "Elige cuándo preparar el contexto y qué conservar."
    case .providers: "Tus cuentas, tus modelos y tus propias API."
    case .activity: "Consumo medido y lo que está haciendo Compacta."
    case .settings: "Haz que Compacta trabaje a tu manera."
    }
  }
}
extension Int {
  var compact: String {
    if self >= 1_000_000 { return String(format: "%.2f M", Double(self) / 1_000_000) }
    if self >= 1000 { return String(format: "%.1f k", Double(self) / 1000) }
    return formatted()
  }
}
func currency(_ n: Double) -> String {
  n.formatted(.currency(code: "USD").precision(.fractionLength(n < 0.01 && n > 0 ? 4 : 2)))
}
func parsedDate(_ s: String) -> Date? {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}
func relativeReset(_ s: String?) -> String {
  guard let s, let d = parsedDate(s) else { return "Reinicio no informado" }
  return "Reinicia " + d.formatted(.relative(presentation: .named))
}
