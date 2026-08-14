import CryptoKit
import Darwin
import Foundation
import Security

private let helperVersion = "1.0.0"
private let protocolVersion = 1
private let schemaVersion = 2
private let service = "com.mintvault.scanner.identity"
private let account = "station-identity-v2"
private let accessGroupContract = "$(AppIdentifierPrefix)com.mintvault.scanner"
private let secureEnclaveTag = "com.mintvault.scanner.identity.se-p256-wrap-v2"
private let wrappingAlgorithm = "SE-P256-ECDH-HKDF-SHA256-AES-256-GCM"
private let maximumInputBytes = 64 * 1024

private struct HelperRequest: Codable {
  let command: String
  let testService: String?
  let expectedFingerprint: String?
  let privateKeyRaw: String?
  let publicKeyPem: String?
  let installationId: String?
  let stationCode: String?
  let stationStatus: String?
  let requestNonce: Int64?
  let credentialEpoch: Int64?
  let requestEpoch: Int64?
  let requestSequence: Int64?
  let semanticOperationId: String?
  let method: String?
  let path: String?
  let timestamp: Int64?
  let contentSha256: String?
  let proofChallenge: String?
  let challengeId: String?
  let challenge: String?
}

private struct IdentityEnvelope: Codable {
  let schemaVersion: Int
  let namespace: String
  let keychainService: String
  let keychainAccount: String
  let accessGroupContract: String
  let keychainAccessGroup: String?
  let keychainAccessibility: String
  let keychainSynchronizable: Bool
  let secureEnclaveApplicationTag: String
  let wrappingAlgorithm: String
  let publicKeyRaw: String
  let developmentSecureEnclaveKeyRepresentation: String?
  let ephemeralPublicKey: String
  let wrappedPrivateKey: String
  let installationId: String
  var stationCode: String?
  var stationStatus: String?
  var requestNonce: Int64
  var credentialEpoch: Int64
  var requestEpoch: Int64
  var requestSequence: Int64
  let createdAt: String
}

private struct IdentityError: Error {
  let code: String
  let message: String
}

private struct IdentityNamespace {
  let service: String
  let account: String
  let accessGroup: String?
  let secureEnclaveApplicationTag: String
}

private struct SigningContext {
  let identifier: String
  let teamIdentifier: String
}

private func signingContext(_ code: SecCode) throws -> SigningContext {
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
    throw IdentityError(code: "RELEASE_TRUST_REQUIRED", message: "Static code-signing identity is unavailable")
  }
  var information: CFDictionary?
  let status = SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
  guard status == errSecSuccess, let values = information as? [String: Any] else {
    throw IdentityError(code: "RELEASE_TRUST_REQUIRED", message: "Code-signing identity is unavailable")
  }
  return SigningContext(
    identifier: values[kSecCodeInfoIdentifier as String] as? String ?? "",
    teamIdentifier: values[kSecCodeInfoTeamIdentifier as String] as? String ?? ""
  )
}

private func selfSigningContext() throws -> SigningContext {
  var code: SecCode?
  guard SecCodeCopySelf([], &code) == errSecSuccess, let code else {
    throw IdentityError(code: "RELEASE_TRUST_REQUIRED", message: "Identity helper signing context is unavailable")
  }
  return try signingContext(code)
}

private func requireMintVaultParent(teamIdentifier: String) throws {
  let parentPid = getppid()
  guard parentPid > 1 else {
    throw IdentityError(code: "UNAUTHENTICATED_CALLER", message: "Identity helper requires the signed MintVault Scanner parent")
  }
  let attributes = [kSecGuestAttributePid as String: NSNumber(value: parentPid)] as CFDictionary
  var parent: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &parent) == errSecSuccess, let parent else {
    throw IdentityError(code: "UNAUTHENTICATED_CALLER", message: "Identity helper caller cannot be authenticated")
  }
  let parentContext = try signingContext(parent)
  guard parentContext.identifier == "com.mintvault.scanner", parentContext.teamIdentifier == teamIdentifier else {
    throw IdentityError(code: "UNAUTHENTICATED_CALLER", message: "Identity helper caller is not MintVault Scanner")
  }
  let requirementText = "anchor apple generic and identifier \"com.mintvault.scanner\" and certificate leaf[subject.OU] = \"\(teamIdentifier)\""
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
        let requirement, SecCodeCheckValidity(parent, [], requirement) == errSecSuccess else {
    throw IdentityError(code: "UNAUTHENTICATED_CALLER", message: "Identity helper caller failed its designated requirement")
  }
}

private extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  init?(base64URL: String) {
    var value = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    value += String(repeating: "=", count: (4 - value.count % 4) % 4)
    self.init(base64Encoded: value)
  }
}

private func response(_ values: [String: Any], exitCode: Int32 = 0) -> Never {
  var body = values
  body["helperVersion"] = helperVersion
  body["protocolVersion"] = protocolVersion
  let data = try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
  exit(exitCode)
}

private func fail(_ error: IdentityError) -> Never {
  response(["ok": false, "error": ["code": error.code, "message": error.message]], exitCode: 1)
}

private func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func spkiData(publicRaw: Data) -> Data {
  Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + publicRaw
}

private func publicPem(publicRaw: Data) -> String {
  let encoded = spkiData(publicRaw: publicRaw).base64EncodedString()
  let lines = stride(from: 0, to: encoded.count, by: 64).map { offset -> String in
    let start = encoded.index(encoded.startIndex, offsetBy: offset)
    let end = encoded.index(start, offsetBy: min(64, encoded.count - offset))
    return String(encoded[start..<end])
  }
  return "-----BEGIN PUBLIC KEY-----\n\(lines.joined(separator: "\n"))\n-----END PUBLIC KEY-----\n"
}

private func publicRaw(fromPem pem: String) throws -> Data {
  let body = pem.replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
    .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "")
    .components(separatedBy: .whitespacesAndNewlines).joined()
  guard let der = Data(base64Encoded: body), der.count == 44,
        der.prefix(12) == Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) else {
    throw IdentityError(code: "INVALID_PUBLIC_KEY", message: "Ed25519 public key is invalid")
  }
  return der.suffix(32)
}

private func namespace(for request: HelperRequest, signing: SigningContext) throws -> IdentityNamespace {
  guard signing.identifier == "com.mintvault.scanner.identity-helper" else {
    throw IdentityError(code: "RELEASE_TRUST_REQUIRED", message: "Identity helper signing identifier is invalid")
  }
  if let candidate = request.testService {
    guard signing.teamIdentifier.isEmpty else {
      throw IdentityError(code: "INVALID_NAMESPACE", message: "Release-signed helpers cannot access test identity namespaces")
    }
    guard candidate.range(of: #"^com\.mintvault\.scanner\.identity\.test\.[A-Za-z0-9-]{8,80}$"#, options: .regularExpression) != nil else {
      throw IdentityError(code: "INVALID_NAMESPACE", message: "Test Keychain namespace is invalid")
    }
    return IdentityNamespace(
      service: candidate,
      account: "station-identity-v2-test",
      accessGroup: nil,
      secureEnclaveApplicationTag: "\(secureEnclaveTag).\(candidate.suffix(80))"
    )
  }
  guard signing.identifier == "com.mintvault.scanner.identity-helper",
        signing.teamIdentifier.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil else {
    throw IdentityError(code: "RELEASE_TRUST_REQUIRED", message: "Production station identity requires the release-signed helper")
  }
  try requireMintVaultParent(teamIdentifier: signing.teamIdentifier)
  return IdentityNamespace(
    service: service,
    account: account,
    accessGroup: "\(signing.teamIdentifier).com.mintvault.scanner",
    secureEnclaveApplicationTag: secureEnclaveTag
  )
}

private func keychainQuery(_ namespace: IdentityNamespace) -> [String: Any] {
  var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: namespace.service,
    kSecAttrAccount as String: namespace.account,
    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
  ]
  if let accessGroup = namespace.accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
  return query
}

private func broadKeychainQuery(_ namespace: IdentityNamespace) -> [String: Any] {
  var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: namespace.service,
    kSecAttrAccount as String: namespace.account,
    kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
  ]
  if let accessGroup = namespace.accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
  return query
}

private func rejectAlternateIdentityItem(_ namespace: IdentityNamespace) throws {
  var query = broadKeychainQuery(namespace)
  query[kSecReturnAttributes as String] = kCFBooleanTrue
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { return }
  if status == errSecSuccess {
    throw IdentityError(code: "NAMESPACE_MISMATCH", message: "Station identity Keychain attributes do not match the device-only contract")
  }
  throw IdentityError(code: "KEYCHAIN_LOCKED", message: "Station identity namespace could not be inspected safely")
}

private func readEnvelope(_ namespace: IdentityNamespace) throws -> IdentityEnvelope? {
  var query = keychainQuery(namespace)
  query[kSecReturnData as String] = kCFBooleanTrue
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound {
    try rejectAlternateIdentityItem(namespace)
    return nil
  }
  guard status == errSecSuccess, let data = result as? Data else {
    throw IdentityError(code: "KEYCHAIN_LOCKED", message: "Device-only station identity is unavailable")
  }
  do {
    let envelope = try JSONDecoder().decode(IdentityEnvelope.self, from: data)
    guard envelope.schemaVersion == schemaVersion,
          envelope.namespace == "mintvault-station-identity-v2",
          envelope.keychainService == namespace.service,
          envelope.keychainAccount == namespace.account,
          envelope.accessGroupContract == accessGroupContract,
          envelope.keychainAccessGroup == namespace.accessGroup,
          envelope.keychainAccessibility == "AfterFirstUnlockThisDeviceOnly",
          envelope.keychainSynchronizable == false,
          envelope.secureEnclaveApplicationTag == namespace.secureEnclaveApplicationTag,
          (namespace.accessGroup == nil) == (envelope.developmentSecureEnclaveKeyRepresentation != nil),
          envelope.wrappingAlgorithm == wrappingAlgorithm else {
      throw IdentityError(code: "NAMESPACE_MISMATCH", message: "Station identity schema or namespace drifted")
    }
    return envelope
  } catch let error as IdentityError {
    throw error
  } catch {
    throw IdentityError(code: "CORRUPT", message: "Station identity record is corrupt")
  }
}

private func writeEnvelope(_ envelope: IdentityEnvelope, namespace: IdentityNamespace, createOnly: Bool) throws {
  let data = try JSONEncoder().encode(envelope)
  let values: [String: Any] = [kSecValueData as String: data]
  if createOnly {
    var add = keychainQuery(namespace)
    add[kSecAttrLabel as String] = namespace.secureEnclaveApplicationTag
    add.merge(values) { _, next in next }
    let status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecDuplicateItem { throw IdentityError(code: "IDENTITY_EXISTS", message: "Station identity already exists") }
    if status == errSecMissingEntitlement { throw IdentityError(code: "NAMESPACE_MISMATCH", message: "Identity helper lacks the frozen Keychain access-group entitlement") }
    guard status == errSecSuccess else { throw IdentityError(code: "KEYCHAIN_WRITE_FAILED", message: "Device-only station identity could not be stored") }
  } else {
    let status = SecItemUpdate(keychainQuery(namespace) as CFDictionary, values as CFDictionary)
    if status == errSecMissingEntitlement { throw IdentityError(code: "NAMESPACE_MISMATCH", message: "Identity helper lacks the frozen Keychain access-group entitlement") }
    guard status == errSecSuccess else { throw IdentityError(code: "KEYCHAIN_WRITE_FAILED", message: "Device-only station identity could not be updated") }
  }
}

private func secureEnclaveKeyQuery(_ namespace: IdentityNamespace) -> [String: Any] {
  var query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrApplicationTag as String: Data(namespace.secureEnclaveApplicationTag.utf8),
  ]
  if let accessGroup = namespace.accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
  return query
}

private func readSecureEnclaveKey(_ namespace: IdentityNamespace) throws -> SecKey? {
  var query = secureEnclaveKeyQuery(namespace)
  query[kSecReturnRef as String] = kCFBooleanTrue
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { return nil }
  if status == errSecMissingEntitlement { throw IdentityError(code: "NAMESPACE_MISMATCH", message: "Identity helper lacks the frozen Keychain access-group entitlement") }
  guard status == errSecSuccess, let key = result else {
    throw IdentityError(code: "KEYCHAIN_LOCKED", message: "Secure Enclave wrapping key is unavailable")
  }
  return (key as! SecKey)
}

private func createSecureEnclaveKey(_ namespace: IdentityNamespace) throws -> SecKey {
  guard SecureEnclave.isAvailable else { throw IdentityError(code: "SECURE_ENCLAVE_UNAVAILABLE", message: "Secure Enclave is required") }
  guard try readSecureEnclaveKey(namespace) == nil else {
    throw IdentityError(code: "NAMESPACE_MISMATCH", message: "An orphaned Secure Enclave station key already exists")
  }
  var cfError: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(
    nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, [.privateKeyUsage], &cfError
  ) else { throw IdentityError(code: "SECURE_ENCLAVE_UNAVAILABLE", message: "Secure Enclave access control could not be created") }
  var privateAttributes: [String: Any] = [
    kSecAttrIsPermanent as String: kCFBooleanTrue as Any,
    kSecAttrApplicationTag as String: Data(namespace.secureEnclaveApplicationTag.utf8),
    kSecAttrAccessControl as String: access,
  ]
  if let accessGroup = namespace.accessGroup { privateAttributes[kSecAttrAccessGroup as String] = accessGroup }
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: privateAttributes,
  ]
  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &cfError) else {
    let code = (cfError?.takeRetainedValue() as Error?)?._code
    if code == Int(errSecMissingEntitlement) { throw IdentityError(code: "NAMESPACE_MISMATCH", message: "Identity helper lacks the frozen Keychain access-group entitlement") }
    throw IdentityError(code: "SECURE_ENCLAVE_UNAVAILABLE", message: "Secure Enclave wrapping key could not be created")
  }
  return key
}

private func deleteSecureEnclaveKey(_ namespace: IdentityNamespace) throws {
  let status = SecItemDelete(secureEnclaveKeyQuery(namespace) as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else {
    throw IdentityError(code: "KEYCHAIN_WRITE_FAILED", message: "Secure Enclave station key could not be retired")
  }
}

private func wrappingKey(_ secureEnclaveKey: SecKey, ephemeralPublic: Data, publicRaw: Data) throws -> SymmetricKey {
  var error: Unmanaged<CFError>?
  let peerAttributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
    kSecAttrKeySizeInBits as String: 256,
  ]
  guard let peer = SecKeyCreateWithData(ephemeralPublic as CFData, peerAttributes as CFDictionary, &error),
        SecKeyIsAlgorithmSupported(secureEnclaveKey, .keyExchange, .ecdhKeyExchangeStandard),
        let shared = SecKeyCopyKeyExchangeResult(
          secureEnclaveKey, .ecdhKeyExchangeStandard, peer,
          [SecKeyKeyExchangeParameter.requestedSize: 32] as CFDictionary, &error
        ) as Data? else {
    throw IdentityError(code: "IDENTITY_RECOVERY_REQUIRED", message: "Secure Enclave key agreement failed")
  }
  return HKDF<SHA256>.deriveKey(
    inputKeyMaterial: SymmetricKey(data: shared),
    salt: Data("mintvault-station-identity-v2".utf8),
    info: spkiData(publicRaw: publicRaw),
    outputByteCount: 32
  )
}

private func developmentWrappingKey(
  _ secureEnclaveKey: SecureEnclave.P256.KeyAgreement.PrivateKey,
  ephemeralPublic: Data,
  publicRaw: Data
) throws -> SymmetricKey {
  let peer = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralPublic)
  let shared = try secureEnclaveKey.sharedSecretFromKeyAgreement(with: peer)
  return shared.hkdfDerivedSymmetricKey(
    using: SHA256.self,
    salt: Data("mintvault-station-identity-v2".utf8),
    sharedInfo: spkiData(publicRaw: publicRaw),
    outputByteCount: 32
  )
}

private func makeEnvelope(privateKey: Curve25519.Signing.PrivateKey, installationId: String, namespace: IdentityNamespace) throws -> IdentityEnvelope {
  let ephemeral = P256.KeyAgreement.PrivateKey()
  let publicRaw = privateKey.publicKey.rawRepresentation
  let developmentRepresentation: String?
  let key: SymmetricKey
  if namespace.accessGroup == nil {
    guard SecureEnclave.isAvailable else { throw IdentityError(code: "SECURE_ENCLAVE_UNAVAILABLE", message: "Secure Enclave is required") }
    var cfError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, [.privateKeyUsage], &cfError
    ) else { throw IdentityError(code: "SECURE_ENCLAVE_UNAVAILABLE", message: "Secure Enclave access control could not be created") }
    let secure = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    developmentRepresentation = secure.dataRepresentation.base64URL
    key = try developmentWrappingKey(
      secure, ephemeralPublic: ephemeral.publicKey.x963Representation, publicRaw: publicRaw
    )
  } else {
    developmentRepresentation = nil
    key = try wrappingKey(
      createSecureEnclaveKey(namespace),
      ephemeralPublic: ephemeral.publicKey.x963Representation,
      publicRaw: publicRaw
    )
  }
  let sealed = try AES.GCM.seal(privateKey.rawRepresentation, using: key, authenticating: spkiData(publicRaw: publicRaw))
  guard let combined = sealed.combined else { throw IdentityError(code: "WRAP_FAILED", message: "Ed25519 key wrapping failed") }
  return IdentityEnvelope(
    schemaVersion: schemaVersion,
    namespace: "mintvault-station-identity-v2",
    keychainService: namespace.service,
    keychainAccount: namespace.account,
    accessGroupContract: accessGroupContract,
    keychainAccessGroup: namespace.accessGroup,
    keychainAccessibility: "AfterFirstUnlockThisDeviceOnly",
    keychainSynchronizable: false,
    secureEnclaveApplicationTag: namespace.secureEnclaveApplicationTag,
    wrappingAlgorithm: wrappingAlgorithm,
    publicKeyRaw: publicRaw.base64URL,
    developmentSecureEnclaveKeyRepresentation: developmentRepresentation,
    ephemeralPublicKey: ephemeral.publicKey.x963Representation.base64URL,
    wrappedPrivateKey: combined.base64URL,
    installationId: installationId,
    stationCode: nil,
    stationStatus: nil,
    requestNonce: 0,
    credentialEpoch: 1,
    requestEpoch: 1,
    requestSequence: 0,
    createdAt: ISO8601DateFormatter().string(from: Date())
  )
}

private func privateKey(_ envelope: IdentityEnvelope, namespace: IdentityNamespace) throws -> Curve25519.Signing.PrivateKey {
  guard let ephemeral = Data(base64URL: envelope.ephemeralPublicKey),
        let wrapped = Data(base64URL: envelope.wrappedPrivateKey),
        let publicRaw = Data(base64URL: envelope.publicKeyRaw) else {
    throw IdentityError(code: "CORRUPT", message: "Station identity encoding is corrupt")
  }
  do {
    let key: SymmetricKey
    if namespace.accessGroup == nil {
      guard let encoded = envelope.developmentSecureEnclaveKeyRepresentation,
            let representation = Data(base64URL: encoded) else {
        throw IdentityError(code: "CORRUPT", message: "Development Secure Enclave representation is missing")
      }
      let secure = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: representation)
      key = try developmentWrappingKey(secure, ephemeralPublic: ephemeral, publicRaw: publicRaw)
    } else {
      guard envelope.developmentSecureEnclaveKeyRepresentation == nil,
            let secure = try readSecureEnclaveKey(namespace) else {
        throw IdentityError(code: "IDENTITY_RECOVERY_REQUIRED", message: "Secure Enclave station key is missing")
      }
      key = try wrappingKey(secure, ephemeralPublic: ephemeral, publicRaw: publicRaw)
    }
    let sealed = try AES.GCM.SealedBox(combined: wrapped)
    let raw = try AES.GCM.open(sealed, using: key, authenticating: spkiData(publicRaw: publicRaw))
    let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
    guard signing.publicKey.rawRepresentation == publicRaw else {
      throw IdentityError(code: "CORRUPT", message: "Wrapped station key does not match its public identity")
    }
    return signing
  } catch let error as IdentityError {
    throw error
  } catch {
    throw IdentityError(code: "IDENTITY_RECOVERY_REQUIRED", message: "Secure Enclave could not unlock this station identity")
  }
}

private func publicIdentity(_ envelope: IdentityEnvelope, state: String = "READY_V2") throws -> [String: Any] {
  guard let raw = Data(base64URL: envelope.publicKeyRaw) else { throw IdentityError(code: "CORRUPT", message: "Public identity is corrupt") }
  return [
    "ok": true,
    "state": state,
    "schemaVersion": envelope.schemaVersion,
    "publicKeyPem": publicPem(publicRaw: raw),
    "publicKeyFingerprint": sha256Hex(spkiData(publicRaw: raw)),
    "installationId": envelope.installationId,
    "stationCode": envelope.stationCode ?? NSNull(),
    "stationStatus": envelope.stationStatus ?? NSNull(),
    "requestNonce": envelope.requestNonce,
    "credentialEpoch": envelope.credentialEpoch,
    "requestEpoch": envelope.requestEpoch,
    "requestSequence": envelope.requestSequence,
    "secureEnclaveBound": true,
    "keychainAccessibility": "AfterFirstUnlockThisDeviceOnly",
    "keychainSynchronizable": false,
  ]
}

private func requireEnvelope(_ namespace: IdentityNamespace) throws -> IdentityEnvelope {
  guard let envelope = try readEnvelope(namespace) else {
    throw IdentityError(code: "IDENTITY_RECOVERY_REQUIRED", message: "Station identity is absent; explicit enrolment or migration is required")
  }
  _ = try privateKey(envelope, namespace: namespace)
  return envelope
}

private func validStationCode(_ value: String) -> Bool {
  value.range(of: #"^MV-STN-[A-Z2-7]{10,24}$"#, options: .regularExpression) != nil
}

@main
private enum IdentityHelper {
  static func main() {
    do {
      let input = FileHandle.standardInput.readDataToEndOfFile()
      guard !input.isEmpty, input.count <= maximumInputBytes else {
        throw IdentityError(code: "INVALID_REQUEST", message: "Identity helper request is missing or too large")
      }
      let request = try JSONDecoder().decode(HelperRequest.self, from: input)
      let signing = try selfSigningContext()
      let keychain = try namespace(for: request, signing: signing)

      switch request.command {
      case "status":
        guard let envelope = try readEnvelope(keychain) else { response(["ok": true, "state": "ABSENT_NEW", "schemaVersion": schemaVersion]) }
        _ = try privateKey(envelope, namespace: keychain)
        response(try publicIdentity(envelope))

      case "create":
        guard try readEnvelope(keychain) == nil else { throw IdentityError(code: "IDENTITY_EXISTS", message: "Station identity already exists") }
        let envelope = try makeEnvelope(
          privateKey: Curve25519.Signing.PrivateKey(),
          installationId: UUID().uuidString.lowercased(),
          namespace: keychain
        )
        do { try writeEnvelope(envelope, namespace: keychain, createOnly: true) }
        catch { try? deleteSecureEnclaveKey(keychain); throw error }
        _ = try privateKey(envelope, namespace: keychain)
        response(try publicIdentity(envelope))

      case "migrate-v1":
        guard let encoded = request.privateKeyRaw, let raw = Data(base64URL: encoded), raw.count == 32,
              let legacyPem = request.publicKeyPem, let installationId = request.installationId,
              UUID(uuidString: installationId) != nil else {
          throw IdentityError(code: "INVALID_MIGRATION", message: "Legacy identity migration payload is invalid")
        }
        let legacyPublic = try publicRaw(fromPem: legacyPem)
        let imported = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        guard imported.publicKey.rawRepresentation == legacyPublic else {
          throw IdentityError(code: "IDENTITY_MISMATCH", message: "Legacy private and public keys do not match")
        }
        var envelope: IdentityEnvelope
        if let existing = try readEnvelope(keychain) {
          guard Data(base64URL: existing.publicKeyRaw) == legacyPublic else {
            throw IdentityError(code: "IDENTITY_MISMATCH", message: "Legacy and v2 identities do not match")
          }
          envelope = existing
        } else {
          envelope = try makeEnvelope(privateKey: imported, installationId: installationId, namespace: keychain)
          envelope.stationCode = request.stationCode
          envelope.stationStatus = request.stationStatus
          envelope.requestNonce = max(0, request.requestNonce ?? 0)
          envelope.requestSequence = envelope.requestNonce
          do { try writeEnvelope(envelope, namespace: keychain, createOnly: true) }
          catch { try? deleteSecureEnclaveKey(keychain); throw error }
        }
        let proof = request.proofChallenge ?? ""
        guard !proof.isEmpty, proof.utf8.count <= 256 else { throw IdentityError(code: "INVALID_MIGRATION", message: "Migration proof challenge is invalid") }
        let signature = try privateKey(envelope, namespace: keychain).signature(for: Data("mintvault-identity-proof-v1\n\(proof)".utf8))
        var values = try publicIdentity(envelope)
        values["proofSignature"] = signature.base64URL
        response(values)

      case "bind-station":
        var envelope = try requireEnvelope(keychain)
        guard let code = request.stationCode?.uppercased(), validStationCode(code),
              request.expectedFingerprint == (try publicIdentity(envelope)["publicKeyFingerprint"] as? String) else {
          throw IdentityError(code: "IDENTITY_MISMATCH", message: "Station enrolment does not match this device identity")
        }
        if let existing = envelope.stationCode, existing != code {
          throw IdentityError(code: "IDENTITY_MISMATCH", message: "Identity is already bound to another station")
        }
        envelope.stationCode = code
        envelope.stationStatus = request.stationStatus ?? "PENDING"
        try writeEnvelope(envelope, namespace: keychain, createOnly: false)
        response(try publicIdentity(envelope))

      case "set-status":
        var envelope = try requireEnvelope(keychain)
        guard let status = request.stationStatus, ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED", "REJECTED"].contains(status) else {
          throw IdentityError(code: "INVALID_STATUS", message: "Station status is invalid")
        }
        envelope.stationStatus = status
        try writeEnvelope(envelope, namespace: keychain, createOnly: false)
        response(try publicIdentity(envelope))

      case "sign-request-v1":
        var envelope = try requireEnvelope(keychain)
        guard let stationCode = envelope.stationCode, let method = request.method?.uppercased(),
              let path = request.path, path.hasPrefix("/api/"), path.utf8.count <= 2048,
              let timestamp = request.timestamp, timestamp > 0,
              let digest = request.contentSha256, digest.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method), envelope.requestNonce < Int64.max else {
          throw IdentityError(code: "INVALID_SIGNING_REQUEST", message: "Station signing request is invalid")
        }
        envelope.requestNonce += 1
        let canonical = ["mintvault-station-request-v1", stationCode, method, path, String(timestamp), String(envelope.requestNonce), digest].joined(separator: "\n")
        let signature = try privateKey(envelope, namespace: keychain).signature(for: Data(canonical.utf8))
        try writeEnvelope(envelope, namespace: keychain, createOnly: false)
        response([
          "ok": true,
          "stationCode": stationCode,
          "timestamp": timestamp,
          "nonce": envelope.requestNonce,
          "contentSha256": digest,
          "signature": signature.base64URL,
        ])

      case "sign-resync-challenge":
        let envelope = try requireEnvelope(keychain)
        guard let stationCode = envelope.stationCode, let challengeId = request.challengeId,
              let challenge = request.challenge, challengeId.utf8.count <= 160,
              challenge.utf8.count >= 32, challenge.utf8.count <= 512 else {
          throw IdentityError(code: "INVALID_CHALLENGE", message: "Replay-resync challenge is invalid")
        }
        let canonical = ["mintvault-station-resync-v1", stationCode, challengeId, challenge].joined(separator: "\n")
        let signature = try privateKey(envelope, namespace: keychain).signature(for: Data(canonical.utf8))
        response(["ok": true, "stationCode": stationCode, "challengeId": challengeId, "signature": signature.base64URL])

      case "apply-replay-state":
        var envelope = try requireEnvelope(keychain)
        guard let credentialEpoch = request.credentialEpoch, credentialEpoch >= envelope.credentialEpoch,
              let requestEpoch = request.requestEpoch, requestEpoch > envelope.requestEpoch,
              let sequence = request.requestSequence, sequence >= 0 else {
          throw IdentityError(code: "INVALID_REPLAY_STATE", message: "Replay recovery must install a strictly newer request epoch")
        }
        envelope.credentialEpoch = credentialEpoch
        envelope.requestEpoch = requestEpoch
        envelope.requestSequence = sequence
        try writeEnvelope(envelope, namespace: keychain, createOnly: false)
        response(try publicIdentity(envelope))

      case "sign-request-v2":
        var envelope = try requireEnvelope(keychain)
        guard let stationCode = envelope.stationCode, let method = request.method?.uppercased(),
              let path = request.path, path.hasPrefix("/api/"), path.utf8.count <= 2048,
              let timestamp = request.timestamp, timestamp > 0,
              let digest = request.contentSha256, digest.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              let operationId = request.semanticOperationId,
              operationId.range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#, options: [.regularExpression, .caseInsensitive]) != nil,
              ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method), envelope.requestSequence < Int64.max else {
          throw IdentityError(code: "INVALID_SIGNING_REQUEST", message: "Station v2 signing request is invalid")
        }
        envelope.requestSequence += 1
        let canonical = [
          "mintvault-station-request-v2", stationCode,
          String(envelope.credentialEpoch), String(envelope.requestEpoch), String(envelope.requestSequence),
          method, path, String(timestamp), digest, operationId.lowercased(),
        ].joined(separator: "\n")
        let signature = try privateKey(envelope, namespace: keychain).signature(for: Data(canonical.utf8))
        try writeEnvelope(envelope, namespace: keychain, createOnly: false)
        response([
          "ok": true, "stationCode": stationCode,
          "credentialEpoch": envelope.credentialEpoch, "requestEpoch": envelope.requestEpoch,
          "sequence": envelope.requestSequence, "timestamp": timestamp,
          "contentSha256": digest, "semanticOperationId": operationId.lowercased(),
          "signature": signature.base64URL,
        ])

      case "retire":
        guard let envelope = try readEnvelope(keychain),
              request.expectedFingerprint == (try publicIdentity(envelope)["publicKeyFingerprint"] as? String) else {
          throw IdentityError(code: "IDENTITY_MISMATCH", message: "Identity retirement fingerprint does not match")
        }
        try deleteSecureEnclaveKey(keychain)
        let status = SecItemDelete(keychainQuery(keychain) as CFDictionary)
        guard status == errSecSuccess else { throw IdentityError(code: "KEYCHAIN_WRITE_FAILED", message: "Station identity could not be retired") }
        response(["ok": true, "state": "ABSENT_NEW", "retiredFingerprint": request.expectedFingerprint!])

      default:
        throw IdentityError(code: "INVALID_COMMAND", message: "Identity helper command is not allowed")
      }
    } catch let error as IdentityError {
      fail(error)
    } catch {
      fail(IdentityError(code: "IDENTITY_HELPER_FAILED", message: "Identity helper operation failed"))
    }
  }
}
