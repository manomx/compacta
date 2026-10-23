import AppKit
import SwiftUI

@MainActor final class AppModel: ObservableObject {
  @Published var snapshot: Snapshot?
  @Published var draft: Settings?
  @Published var page: Page = .overview
  @Published var working = false
  @Published var error: String?
  @Published var notice: String?
  @Published var connected = false
  @Published var period = 1
  var runtime: Runtime?
  var timer: Timer?
  var refreshing = false
  let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
    "Library/Application Support/Compacta")
  var dirty: Bool { draft != snapshot?.config }
  var statusTitle: String {
    guard connected else { return "Sin conexión" }
    guard let s = snapshot else { return "Iniciando" }
    if s.config.paused { return "En pausa" }
    if s.budgetReached { return "Límite de costo" }
    if s.codex.activeJobs + s.claude.activeJobs > 0 { return "Preparando" }
    if !s.integration.codex.active && !s.integration.claude.active { return "Sin activar" }
    return "Activo"
  }
  var jobs: Int { (snapshot?.codex.activeJobs ?? 0) + (snapshot?.claude.activeJobs ?? 0) }
  init() { Task { await connect() } }
  func connect() async {
    working = true
    defer { working = false }
    do {
      try Bootstrap.ensureService(root: root)
      for _ in 0..<60 {
        if let data = try? Data(contentsOf: root.appendingPathComponent("runtime.json")),
          let r = try? JSONDecoder().decode(Runtime.self, from: data)
        {
          runtime = r
          do {
            let s: Snapshot = try await get("/api/status")
            snapshot = s
            draft = s.config
            connected = true
            startTimer()
            return
          } catch {}
        }
        try await Task.sleep(for: .milliseconds(250))
      }
      throw AppError.message("El servicio no respondió. Abre Diagnóstico para revisar el inicio.")
    } catch {
      self.error = error.localizedDescription
      connected = false
    }
  }
  func startTimer() {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in await self?.refresh() }
    }
  }
  func refresh() async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    do {
      let wasDirty = dirty
      let s: Snapshot = try await get("/api/status?days=\(period)")
      snapshot = s
      if !wasDirty { draft = s.config }
      connected = true
    } catch { connected = false }
  }
  func get<T: Decodable>(_ path: String) async throws -> T { try await request(path, body: nil) }
  func post<T: Decodable>(_ path: String, _ value: Any) async throws -> T {
    let data = try JSONSerialization.data(withJSONObject: value)
    return try await request(path, body: data)
  }
  func request<T: Decodable>(_ path: String, body: Data?) async throws -> T {
    guard let runtime, let url = URL(string: "http://127.0.0.1:\(runtime.port)\(path)") else {
      throw AppError.message("Compacta está iniciando.")
    }
    var req = URLRequest(url: url)
    req.httpMethod = body == nil ? "GET" : "POST"
    req.httpBody = body
    req.setValue("Bearer \(runtime.adminToken)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.timeoutInterval = 100
    let (data, response) = try await URLSession.shared.data(for: req)
    guard let h = response as? HTTPURLResponse, (200..<300).contains(h.statusCode) else {
      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw AppError.message(
        obj?["error"] as? String ?? "El servicio no pudo completar la operación.")
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
  func save() async {
    guard let draft else { return }
    working = true
    defer { working = false }
    do {
      let data = try JSONEncoder().encode(draft)
      let s: Snapshot = try await request("/api/settings", body: data)
      snapshot = s
      self.draft = s.config
      try Bootstrap.setLogin(enabled: draft.launchAtLogin)
      showNotice("Ajustes guardados")
    } catch { self.error = error.localizedDescription }
  }
  func setPaused(_ value: Bool) async {
    working = true
    defer { working = false }
    do {
      let s: Snapshot = try await post("/api/pause", ["paused": value])
      snapshot = s
      draft = s.config
      showNotice(value ? "Preparación en pausa" : "Preparación reanudada")
    } catch { self.error = error.localizedDescription }
  }
  struct Activation: Decodable {
    var ok: Bool
    var errors: [String]
    var snapshot: Snapshot?
  }
  func activate(codex: Bool, claude: Bool) async {
    working = true
    defer { working = false }
    do {
      let r: Activation = try await post("/api/integrations", ["codex": codex, "claude": claude])
      if let s = r.snapshot {
        snapshot = s
        draft = s.config
      }
      if !r.ok { throw AppError.message(r.errors.joined(separator: "\n")) }
      try Bootstrap.setLogin(enabled: draft?.launchAtLogin ?? true)
      showNotice("Integraciones actualizadas")
    } catch { self.error = error.localizedDescription }
  }
  func refreshQuotas() async {
    working = true
    defer { working = false }
    do {
      let _: QuotaResult = try await post("/api/quotas/refresh", [:])
      await refresh()
      showNotice("Límites actualizados")
    } catch { self.error = error.localizedDescription }
  }
  struct QuotaResult: Decodable { var quotas: [String: Quota] }
  struct OK: Decodable { var ok: Bool }
  struct Probe: Decodable {
    var ok: Bool
    var milliseconds: Int
    var model: String
    var message: String
  }
  func testProvider(_ id: String) async -> String {
    do {
      let p: Probe = try await post("/api/provider/test", ["id": id])
      return "\(p.message) \(p.milliseconds) ms · \(p.model)"
    } catch { return error.localizedDescription }
  }
  func saveProvider(_ p: Provider, key: String) async throws {
    guard var settings = draft else { return }
    if let i = settings.providers.firstIndex(where: { $0.id == p.id }) {
      settings.providers[i] = p
    } else {
      settings.providers.append(p)
    }
    let s: Snapshot = try await request("/api/settings", body: JSONEncoder().encode(settings))
    snapshot = s
    draft = s.config
    if !key.isEmpty { let _: OK = try await post("/api/credentials", ["id": p.id, "key": key]) }
    showNotice("Proveedor guardado")
  }
  func removeProvider(_ id: String) async {
    guard var settings = draft else { return }
    if settings.codex.providerID == id || settings.claude.providerID == id {
      error = "Este proveedor está seleccionado para compactar. Elige otro antes de quitarlo."
      return
    }
    settings.providers.removeAll { $0.id == id }
    draft = settings
    await save()
  }
  struct ModelList: Decodable {
    struct Item: Decodable, Identifiable {
      var id: String
      var name: String
    }
    var models: [Item]
  }
  func models(_ id: String) async throws -> [ModelList.Item] {
    let r: ModelList = try await post("/api/provider/models", ["id": id])
    return r.models
  }
  func exportUsage() async {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "Compacta-consumo.json"
    panel.allowedContentTypes = [.json]
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      guard let runtime else { return }
      var r = URLRequest(url: URL(string: "http://127.0.0.1:\(runtime.port)/api/usage/export")!)
      r.setValue("Bearer \(runtime.adminToken)", forHTTPHeaderField: "Authorization")
      let (data, response) = try await URLSession.shared.data(for: r)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw AppError.message("No se pudo exportar.")
      }
      try data.write(to: url, options: .atomic)
      showNotice("Registro exportado sin conversaciones ni claves")
    } catch { self.error = error.localizedDescription }
  }
  func showNotice(_ value: String) {
    notice = value
    Task {
      try? await Task.sleep(for: .seconds(4))
      if notice == value { notice = nil }
    }
  }
  func openLogs() { NSWorkspace.shared.open(root.appendingPathComponent("service.log")) }
  func openClient(_ id: String) {
    if id == "codex" {
      for path in ["/Applications/ChatGPT.app", "/Applications/Codex.app"] {
        if FileManager.default.fileExists(atPath: path) {
          NSWorkspace.shared.open(URL(fileURLWithPath: path))
          return
        }
      }
    }
    let command = id == "claude" ? "claude" : "codex login"
    let script = "tell application \"Terminal\"\nactivate\ndo script \"\(command)\"\nend tell"
    var error: NSDictionary?
    NSAppleScript(source: script)?.executeAndReturnError(&error)
    if error != nil { self.error = "Abre Terminal y ejecuta \(command) para iniciar sesión." }
  }
}
enum AppError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    if case .message(let s) = self { return s }
    return nil
  }
}

enum Bootstrap {
  static let fm = FileManager.default
  static func process(_ exe: String, _ args: [String]) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
      throw AppError.message("No se pudo registrar el servicio de Compacta.")
    }
  }
  static func ensureService(root: URL) throws {
    try fm.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if let data = try? Data(contentsOf: root.appendingPathComponent("runtime.json")),
      let runtime = try? JSONDecoder().decode(Runtime.self, from: data),
      kill(Int32(runtime.pid), 0) == 0
    {
      return
    }
    let helpers = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers")
    let engine = helpers.appendingPathComponent("compacta-engine").path
    let vault = helpers.appendingPathComponent("compacta-vault").path
    guard fm.isExecutableFile(atPath: engine) else {
      throw AppError.message(
        "El paquete está incompleto: falta el motor. Vuelve a instalar Compacta.")
    }
    let agents = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
    try fm.createDirectory(at: agents, withIntermediateDirectories: true)
    let plist = agents.appendingPathComponent("io.compacta.service.v2.plist")
    let spec: [String: Any] = [
      "Label": "io.compacta.service.v2",
      "ProgramArguments": [engine, "--root", root.path, "--vault", vault], "RunAtLoad": true,
      "KeepAlive": true, "ThrottleInterval": 3, "ProcessType": "Background",
      "StandardOutPath": root.appendingPathComponent("service.log").path,
      "StandardErrorPath": root.appendingPathComponent("service.log").path,
    ]
    try PropertyListSerialization.data(fromPropertyList: spec, format: .xml, options: 0).write(
      to: plist, options: .atomic)
    try? process("/bin/launchctl", ["bootout", "gui/\(getuid())/io.compacta.service.v2"])
    try process("/bin/launchctl", ["bootstrap", "gui/\(getuid())", plist.path])
  }
  static func setLogin(enabled: Bool) throws {
    let agents = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
    try fm.createDirectory(at: agents, withIntermediateDirectories: true)
    let path = agents.appendingPathComponent("io.compacta.app.plist")
    if !enabled {
      try? fm.removeItem(at: path)
      return
    }
    let spec: [String: Any] = [
      "Label": "io.compacta.app",
      "ProgramArguments": ["/usr/bin/open", "-g", Bundle.main.bundleURL.path], "RunAtLoad": true,
    ]
    try PropertyListSerialization.data(fromPropertyList: spec, format: .xml, options: 0).write(
      to: path, options: .atomic)
  }
  static func installIfNeeded() -> Bool {
    if ProcessInfo.processInfo.environment["COMPACTA_DEVELOPMENT"] == "1" { return false }
    let source = Bundle.main.bundleURL
    guard source.pathExtension == "app" else { return false }
    let applications = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
    let target = applications.appendingPathComponent("Compacta.app")
    if source.standardizedFileURL == target.standardizedFileURL { return false }
    do {
      let installed = try BundleInstaller.install(from: source, into: applications)
      NSWorkspace.shared.open(installed)
      return true
    } catch {
      NSAlert(error: error).runModal()
      return false
    }
  }
}
