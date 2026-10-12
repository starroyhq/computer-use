import AppKit
import Darwin
import HostCore
import Security

enum HostLaunchMode: Equatable {
    case normal, background, ensureRunning

    static func parse(_ arguments: [String]) -> HostLaunchMode? {
        switch arguments {
        case []: return .normal
        case ["--background"]: return .background
        case ["--ensure-running"]: return .ensureRunning
        default: return nil
        }
    }
}

struct HostStartupResult: Encodable, Equatable {
    let ok: Bool
    var state: String?
    var code: String?
    var message: String?

    static let ready = HostStartupResult(ok: true, state: "ready")
    static func failure(_ code: String) -> HostStartupResult {
        let message: String
        switch code {
        case "paused": message = "Computer Use is paused. Resume it in the local app."
        case "stopped": message = "Computer Use was stopped. Restart services in the local app."
        case "failed": message = "Computer Use failed. Check the local app and restart services."
        case "permissions_required": message = "Open Computer Use and grant Accessibility and Screen Recording in System Settings."
        case "non_interactive": message = "Open Computer Use in the signed-in user's graphical session."
        case "timeout": message = "Computer Use did not become ready within 35 seconds. Check its status in the local app."
        default: message = "Computer Use could not be started. Open the installed app and check its status."
        }
        return HostStartupResult(ok: false, code: code, message: message)
    }

    static func launchFailure(_ stage: HostStartupStage, error: Error? = nil) -> HostStartupResult {
        var result = failure("launch_failed")
        // Use a fixed stage and numeric error only. NSError descriptions/userInfo may contain private paths.
        let detail: String
        switch error {
        case StartupFailure.unsafeState?: detail = "unsafe_state"
        case StartupFailure.invalidState?: detail = "invalid_state"
        case StartupFailure.io(let number)?: detail = "errno_\(number)"
        case StartupFailure.timedOut?: detail = "timeout"
        case nil: detail = "unavailable"
        default:
            let value = error! as NSError
            let domain = [NSCocoaErrorDomain, NSPOSIXErrorDomain, NSOSStatusErrorDomain, NSMachErrorDomain].contains(value.domain)
                ? value.domain : "other"
            detail = "\(domain)_\(value.code)"
        }
        result.message! += " [\(stage.rawValue):\(detail)]"
        return result
    }
}

enum HostStartupStage: String {
    case identity, package, initialState, gate, state, existingIdentity, socket, confirmedState, launch
}

enum HostStartup {
    static var isLoginItemLaunch: Bool {
        NSAppleEventManager.shared().currentAppleEvent?
            .paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    static func session() -> (id: UInt32, graphical: Bool)? {
        var identifier: SecuritySessionId = 0
        var attributes = SessionAttributeBits()
        guard SessionGetInfo(callerSecuritySession, &identifier, &attributes) == errSecSuccess else { return nil }
        return (identifier, attributes.contains(.sessionHasGraphicAccess))
    }

    /// A helper may launch only the .app containing its own executable, never PATH or another bundle with the same ID.
    static func validatePackage(app: URL, executable: String) throws -> HostPaths {
        let app = app.resolvingSymlinksInPath()
        guard app.pathExtension == "app", UpdateInstaller.bundleInfo(at: app)?.identifier == HostPaths.bundleID,
              app.appendingPathComponent("Contents/MacOS/ComputerUseHost").resolvingSymlinksInPath().path == executable,
              FileManager.default.isExecutableFile(atPath: executable) else {
            throw HostFailure.resourcesUnavailable
        }
        let paths = HostPaths(resources: app.appendingPathComponent("Contents/Resources"))
        try paths.validateResources()
        let data = try Data(contentsOf: paths.resources.appendingPathComponent("build-receipt.json"))
        guard let receipt = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              receipt["owner"] as? String == "computer-use-package-v1",
              FileManager.default.isReadableFile(atPath: paths.cliScript.path),
              FileManager.default.isExecutableFile(atPath: paths.cli.path) else { throw HostFailure.resourcesUnavailable }
        return paths
    }

    static func ensureRunning() -> HostStartupResult {
        let deadline = ProcessInfo.processInfo.systemUptime + 35
        guard let session = session(), session.graphical, getuid() != 0, getuid() == geteuid() else {
            return .failure("non_interactive")
        }
        var stage = HostStartupStage.identity
        do {
            guard let own = HostProcessIdentity.read() else { return .launchFailure(stage) }
            let app = Bundle.main.bundleURL.resolvingSymlinksInPath()
            stage = .package
            let paths = try validatePackage(app: app, executable: own.executable)
            let store = HostStartupStore(directory: paths.data)
            // Reading existing state is non-mutating, including a missing first-install directory.
            stage = .initialState
            let previous = try store.read()
            if let code = HostStartupPolicy.blockingCode(previous, live: previous.map { HostProcessIdentity.read(pid: $0.process.pid) == $0.process } ?? false) {
                return .failure(code)
            }
            stage = .gate
            let gate = try HostStartupGate(directory: paths.data, deadline: deadline)
            return try withExtendedLifetime(gate) {
                var launched = false
                var launchError: Error?
                while ProcessInfo.processInfo.systemUptime < deadline {
                    stage = .state
                    let state = try store.read()
                    let actual = state.flatMap { HostProcessIdentity.read(pid: $0.process.pid) }
                    let live = state != nil && actual == state?.process
                    if let code = HostStartupPolicy.blockingCode(state, live: live) { return .failure(code) }
                    if live, let state, !HostStartupPolicy.matches(state, process: actual, executable: own.executable, sessionID: session.id) {
                        return .launchFailure(.existingIdentity)
                    }
                    if live, let state, state.state == .ready {
                        stage = .socket
                        let connected = try HostStartupPolicy.socketAcceptsConnections(path: paths.runtimeSocket)
                        stage = .confirmedState
                        let after = try store.read()
                        if HostStartupPolicy.ready(before: state, after: after,
                                                   process: HostProcessIdentity.read(pid: state.process.pid),
                                                   executable: own.executable, sessionID: session.id, socketReady: connected) {
                            return .ready
                        }
                    }
                    if let launchError { return .launchFailure(.launch, error: launchError) }
                    stage = .launch
                    if !launched, !live, try !HostStartupGate.instanceExists(directory: paths.data) {
                        try preventOutputInheritance()
                        let configuration = NSWorkspace.OpenConfiguration()
                        configuration.activates = false
                        configuration.allowsRunningApplicationSubstitution = false
                        // A concurrent manual launch must not turn this request into a Reopen event that shows Settings.
                        // host.lock keeps one GUI owner; a losing --background instance exits without an alert.
                        configuration.createsNewApplicationInstance = true
                        configuration.arguments = ["--background"]
                        NSWorkspace.shared.openApplication(at: app, configuration: configuration) { _, error in
                            DispatchQueue.main.async { launchError = error }
                        }
                        launched = true
                    }
                    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
                }
                return .failure("timeout")
            }
        } catch StartupFailure.timedOut {
            return .failure("timeout")
        } catch {
            // Never return arbitrary NSError descriptions: they can contain private paths or document content.
            return .launchFailure(stage, error: error)
        }
    }

    static func preventOutputInheritance() throws {
        for fd: Int32 in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
            let flags = fcntl(fd, F_GETFD)
            if flags < 0 { if errno == EBADF { continue }; throw StartupFailure.io(errno) }
            guard fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0 else { throw StartupFailure.io(errno) }
        }
    }

    /// The persistent GUI and its workers must not keep a calling Agent's stdout/stderr pipes alive.
    static func detachStandardStreams() throws {
        let null = open("/dev/null", O_RDWR | O_CLOEXEC)
        guard null >= 0 else { throw StartupFailure.io(errno) }
        defer { if null > STDERR_FILENO { close(null) } }
        for fd: Int32 in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
            guard dup2(null, fd) >= 0 else { throw StartupFailure.io(errno) }
        }
    }
}
