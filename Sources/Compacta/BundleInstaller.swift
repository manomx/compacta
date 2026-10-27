import Foundation

enum BundleInstallError: LocalizedError {
  case incomplete
  var errorDescription: String? { L("error.incompleteBundle") }
}

enum BundleInstaller {
  static func validate(_ bundle: URL, using fm: FileManager) throws {
    let info = bundle.appendingPathComponent("Contents/Info.plist")
    guard let data = try? Data(contentsOf: info),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any],
      plist["CFBundleIdentifier"] as? String == "io.compacta.app",
      plist["CFBundleExecutable"] as? String == "Compacta"
    else { throw BundleInstallError.incomplete }
    for path in [
      "Contents/MacOS/Compacta", "Contents/Helpers/compacta-engine",
      "Contents/Helpers/compacta-vault",
    ] {
      guard fm.isExecutableFile(atPath: bundle.appendingPathComponent(path).path)
      else { throw BundleInstallError.incomplete }
    }
  }

  static func install(from source: URL, into applications: URL, using fm: FileManager = .default)
    throws -> URL
  {
    let target = applications.appendingPathComponent("Compacta.app")
    if source.resolvingSymlinksInPath() == target.resolvingSymlinksInPath() { return target }
    try validate(source, using: fm)
    try fm.createDirectory(at: applications, withIntermediateDirectories: true)
    let id = UUID().uuidString
    let staging = applications.appendingPathComponent(".Compacta-install-\(id)")
    let backup = applications.appendingPathComponent(".Compacta-backup-\(id)")
    defer { try? fm.removeItem(at: staging) }
    // Finish copying and checking before moving the working installation.
    try fm.copyItem(at: source, to: staging)
    try validate(staging, using: fm)
    let hadPrevious = fm.fileExists(atPath: target.path)
    if hadPrevious { try fm.moveItem(at: target, to: backup) }
    do {
      try fm.moveItem(at: staging, to: target)
    } catch {
      if hadPrevious { try fm.moveItem(at: backup, to: target) }
      throw error
    }
    if hadPrevious { try? fm.removeItem(at: backup) }
    return target
  }
}
