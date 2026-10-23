import Foundation

final class FailingFileManager: FileManager, @unchecked Sendable {
  override func moveItem(at source: URL, to destination: URL) throws {
    if source.lastPathComponent.hasPrefix(".Compacta-install-") {
      throw CocoaError(.fileWriteNoPermission)
    }
    try super.moveItem(at: source, to: destination)
  }
}

@main enum InstallerCheck {
  static func check(_ condition: Bool, _ message: String = "") { precondition(condition, message) }
  static func main() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent(
      "compacta-installer-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let source = root.appendingPathComponent("Source.app")
    for path in ["Contents/MacOS", "Contents/Helpers"] {
      try fm.createDirectory(
        at: source.appendingPathComponent(path), withIntermediateDirectories: true)
    }
    for path in [
      "Contents/MacOS/Compacta", "Contents/Helpers/compacta-engine",
      "Contents/Helpers/compacta-vault",
    ] {
      let file = source.appendingPathComponent(path)
      try Data("fixture-v1".utf8).write(to: file)
      try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    }
    let info = ["CFBundleIdentifier": "io.compacta.app", "CFBundleExecutable": "Compacta"]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(
      to: source.appendingPathComponent("Contents/Info.plist"))
    let applications = root.appendingPathComponent("Applications")
    let target = try BundleInstaller.install(from: source, into: applications)
    let executable = target.appendingPathComponent("Contents/MacOS/Compacta")
    check(try String(contentsOf: executable, encoding: .utf8) == "fixture-v1")
    try Data("fixture-v2".utf8).write(to: source.appendingPathComponent("Contents/MacOS/Compacta"))
    do {
      _ = try BundleInstaller.install(from: source, into: applications, using: FailingFileManager())
      preconditionFailure("Replacement failure expected")
    } catch {}
    check(
      try String(contentsOf: executable, encoding: .utf8) == "fixture-v1",
      "Previous installation must survive")
    _ = try BundleInstaller.install(from: source, into: applications)
    check(try String(contentsOf: executable, encoding: .utf8) == "fixture-v2")
    try fm.removeItem(at: source.appendingPathComponent("Contents/Helpers/compacta-engine"))
    do {
      _ = try BundleInstaller.install(from: source, into: applications)
      preconditionFailure("Incomplete package must be rejected")
    } catch {}
    check(try String(contentsOf: executable, encoding: .utf8) == "fixture-v2")
    check(try fm.contentsOfDirectory(atPath: applications.path) == ["Compacta.app"])
    print(
      "Installer checks passed: first install, upgrade, rollback, incomplete package; no UI launched."
    )
  }
}
