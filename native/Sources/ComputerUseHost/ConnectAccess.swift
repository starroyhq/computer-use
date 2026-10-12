import Foundation
import Darwin
import HostCore

enum ConnectFailure: Error, Equatable {
    case unavailable, timeout, output, command
}

enum ConnectProfileState: String, Decodable {
    case missing, invalid, unverified, valid, unauthorized
}

/// Only the CLI's metadata is decoded here; the settings UI never opens credential files.
struct ConnectPreflight: Decodable {
    struct Paths: Decodable {
        let node: String
        let cli: String
        let host: String?
        let packageRoot: String?
    }
    struct Host: Decodable { let state: String }
    struct Profile: Decodable {
        let name: String
        let state: ConnectProfileState
    }
    let schemaVersion: Int
    let version: String
    let platform: String
    let paths: Paths
    let host: Host
    let profiles: [String]
    let profile: Profile
}

/// One selection feeds every access artifact. Refreshing the settings timer never starts a CLI task.
final class ConnectAccess {
    typealias Runner = ([String], @escaping (Result<Data, ConnectFailure>) -> Void) -> Void
    static let selectionKey = "connectSelectedProfile"
    private let defaults: UserDefaults
    private let runner: Runner
    private var loaded = false
    private(set) var selectedProfile: String
    private(set) var profiles = ["default"]
    private(set) var profileState: ConnectProfileState?
    private(set) var failure: ConnectFailure?
    private(set) var isBusy = false
    var onChange: (() -> Void)?

    init(paths: HostPaths, defaults: UserDefaults = .standard, runner: Runner? = nil) {
        self.defaults = defaults
        let saved = defaults.string(forKey: Self.selectionKey) ?? "default"
        selectedProfile = Self.validProfile(saved) ? saved : "default"
        self.runner = runner ?? { arguments, completion in
            ConnectCommand.run(paths: paths, arguments: arguments, completion: completion)
        }
    }

    static func validProfile(_ value: String) -> Bool {
        (1...64).contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    @discardableResult
    func selectProfile(_ profile: String) -> Bool {
        guard !isBusy, Self.validProfile(profile) else { return false }
        if profile != selectedProfile {
            selectedProfile = profile
            profileState = nil
            failure = nil
            defaults.set(profile, forKey: Self.selectionKey)
            onChange?()
        }
        return true
    }

    func loadIfNeeded() {
        guard !loaded else { return }
        reload()
    }

    func reload() {
        guard !isBusy else { return }
        loaded = true
        let profile = selectedProfile
        perform(["preflight", "--profile", profile]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let data):
                guard let report = try? JSONDecoder().decode(ConnectPreflight.self, from: data),
                      report.schemaVersion == 1, report.profile.name == profile,
                      report.profiles.allSatisfy(Self.validProfile) else {
                    self.profileState = nil
                    self.failure = .output
                    return
                }
                self.profiles = Array(Set(report.profiles + ["default", profile])).sorted()
                self.profileState = report.profile.state
            case .failure:
                self.profileState = nil
            }
        }
    }

    func installationPrompt(completion: @escaping (Result<String, ConnectFailure>) -> Void) {
        perform(["skill", "prompt", "--profile", selectedProfile]) { [weak self] result in
            let text = result.flatMap { data -> Result<String, ConnectFailure> in
                guard let text = String(data: data, encoding: .utf8), !text.contains("\0"),
                      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failure(.output) }
                return .success(text)
            }
            if case .failure(let failure) = text { self?.failure = failure }
            completion(text)
        }
    }

    private func perform(_ arguments: [String], completion: @escaping (Result<Data, ConnectFailure>) -> Void) {
        guard !isBusy else { return }
        isBusy = true
        failure = nil
        onChange?()
        runner(arguments) { [weak self] result in
            guard let self else { return }
            self.isBusy = false
            if case .failure(let failure) = result { self.failure = failure }
            completion(result)
            self.onChange?()
        }
    }

    static func pairCommand(paths: HostPaths, profile: String) -> String {
        [paths.node.path, paths.cliScript.path, "pair", "--profile", profile, "--name", "My Agent"]
            .map(shellLiteral).joined(separator: " ")
    }

    static func configuration(paths: HostPaths, profile: String) -> String? {
        let value: [String: Any] = ["mcpServers": ["computer-use": [
            "command": paths.node.path,
            "args": [paths.cliScript.path, "mcp", "stdio", "--profile", profile],
        ]]]
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func shellLiteral(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

/// Run metadata/prompt commands away from the main thread with bounded output and elapsed time.
/// stderr is discarded: CLI errors can contain private paths or other unreviewed content.
enum ConnectCommand {
    static func run(paths: HostPaths, arguments: [String], timeout: TimeInterval = 8, outputLimit: Int = 1_048_576,
                    completion: @escaping (Result<Data, ConnectFailure>) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let result = execute(paths: paths, arguments: arguments, timeout: timeout, outputLimit: outputLimit)
            DispatchQueue.main.async { completion(result) }
        }
    }

    private static func execute(paths: HostPaths, arguments: [String], timeout: TimeInterval, outputLimit: Int) -> Result<Data, ConnectFailure> {
        guard FileManager.default.isExecutableFile(atPath: paths.node.path),
              FileManager.default.isReadableFile(atPath: paths.cliScript.path) else { return .failure(.unavailable) }
        let process = Process()
        process.executableURL = paths.node
        process.arguments = [paths.cliScript.path] + arguments
        process.environment = paths.childEnvironment(from: ProcessInfo.processInfo.environment)
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        let readHandle = pipe.fileHandleForReading
        defer { try? readHandle.close() }
        let descriptor = readHandle.fileDescriptor
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else { return .failure(.unavailable) }
        do { try process.run() } catch { return .failure(.unavailable) }
        try? pipe.fileHandleForWriting.close()
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var output = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            if ProcessInfo.processInfo.systemUptime >= deadline {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                return .failure(.timeout)
            }
            let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
            if count > 0 {
                guard output.count + count <= outputLimit else {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    return .failure(.output)
                }
                output.append(contentsOf: buffer.prefix(count))
            } else if count == 0 && !process.isRunning {
                return process.terminationReason == .exit && process.terminationStatus == 0
                    ? .success(output) : .failure(.command)
            } else if count < 0 && errno != EAGAIN && errno != EINTR {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                return .failure(.output)
            } else {
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
    }
}
