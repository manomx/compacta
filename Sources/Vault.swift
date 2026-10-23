import Foundation
import Security

let args = CommandLine.arguments
guard args.count == 3 else { exit(64) }
let action = args[1]
let account = args[2]
guard account.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else {
  exit(64)
}
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "io.compacta.credentials", kSecAttrAccount as String: account,
]
switch action {
case "read":
  var q = query
  q[kSecReturnData as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(q as CFDictionary, &result)
  guard status == errSecSuccess, let data = result as? Data else { exit(1) }
  FileHandle.standardOutput.write(data)
case "write":
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty && data.count < 20000 else { exit(64) }
  let attrs: [String: Any] = [kSecValueData as String: data]
  var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
  if status == errSecItemNotFound {
    var q = query
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    status = SecItemAdd(q as CFDictionary, nil)
  }
  exit(status == errSecSuccess ? 0 : 1)
case "delete":
  let s = SecItemDelete(query as CFDictionary)
  exit(s == errSecSuccess || s == errSecItemNotFound ? 0 : 1)
default: exit(64)
}
