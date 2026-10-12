import Darwin
import XCTest
@testable import HostCore

final class StartupTests: XCTestCase {
    private func identity(pid: Int32 = 1234, start: UInt64 = 42, path: String = "/Applications/Computer Use.app/Contents/MacOS/ComputerUseHost") -> HostProcessIdentity {
        HostProcessIdentity(pid: pid, uid: getuid(), startTimeMicroseconds: start, executable: path)
    }

    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("cu-startup-\(UUID().uuidString)") }

    func testPauseAndStopSurviveExitAndEveryNewProcessUntilLocalResume() throws {
        for reason in [StartupBlock.paused, .stopped] {
            var original = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
            original.block(reason)
            original.transition(.exited)
            let directory = directory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = HostStartupStore(directory: directory)
            try store.write(original.state)
            let previous = try store.read()
            XCTAssertEqual(HostStartupPolicy.blockingCode(previous, live: false), reason.rawValue)
            var relaunched = HostStartupLifecycle(process: identity(pid: 2234), sessionID: 7, previous: previous)
            XCTAssertEqual(relaunched.state.blockedReason, reason)
            XCTAssertFalse(relaunched.transition(.starting))
            XCTAssertFalse(relaunched.transition(.ready), "A late ready event must not undo a pause or stop")
            relaunched.resume()
            XCTAssertTrue(relaunched.transition(.ready))
            XCTAssertNil(HostStartupPolicy.blockingCode(relaunched.state, live: true))
        }
    }

    func testEmergencyStopCancelsPendingRestartAndExitDoesNotRestart() {
        var lifecycle = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
        lifecycle.resume()
        lifecycle.requestRestart()
        lifecycle.block(.stopped)
        XCTAssertFalse(lifecycle.takeRestart())
        XCTAssertFalse(lifecycle.transition(.ready))
        lifecycle.resume()
        lifecycle.requestRestart()
        XCTAssertTrue(lifecycle.takeRestart())
        XCTAssertFalse(lifecycle.takeRestart(), "A queued restart is consumed once")
        lifecycle.requestRestart()
        lifecycle.transition(.exited)
        XCTAssertFalse(lifecycle.takeRestart())
    }

    func testFailureBlocksOnlyLiveHostAndNormalExitDoesNotBecomeEmergencyStop() {
        var lifecycle = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
        lifecycle.transition(.failed)
        XCTAssertEqual(HostStartupPolicy.blockingCode(lifecycle.state, live: true), "failed")
        XCTAssertNil(HostStartupPolicy.blockingCode(lifecycle.state, live: false))
        lifecycle.transition(.stopped)
        lifecycle.transition(.exited)
        XCTAssertNil(HostStartupPolicy.blockingCode(lifecycle.state, live: false))
        XCTAssertFalse(lifecycle.state.autoStartBlocked)
    }

    func testFaultRecoveryIsExplicitOnlyForFailedAndNeverClearsUserBlocks() {
        for phase in [StartupPhase.ready, .starting, .paused, .stopped, .permissionsRequired, .exited] {
            var lifecycle = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
            lifecycle.transition(phase)
            XCTAssertFalse(lifecycle.requestFaultRecovery(), phase.rawValue)
            XCTAssertFalse(lifecycle.takeRestart())
        }
        for reason in [StartupBlock.paused, .stopped] {
            var lifecycle = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
            lifecycle.block(reason)
            lifecycle.transition(.failed)
            XCTAssertFalse(lifecycle.requestFaultRecovery())
            XCTAssertEqual(HostStartupPolicy.blockingCode(lifecycle.state, live: true, recoveringFault: true), reason.rawValue)
            XCTAssertEqual(lifecycle.state.blockedReason, reason)
        }
        var lifecycle = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
        lifecycle.transition(.failed)
        XCTAssertEqual(HostStartupPolicy.blockingCode(lifecycle.state, live: true), "failed")
        XCTAssertNil(HostStartupPolicy.blockingCode(lifecycle.state, live: true, recoveringFault: true))
        XCTAssertTrue(lifecycle.requestFaultRecovery())
        XCTAssertEqual(lifecycle.state.state, .starting)
        XCTAssertFalse(lifecycle.requestFaultRecovery(), "Concurrent requests cannot enqueue a second recovery")
        XCTAssertTrue(lifecycle.takeRestart())
        XCTAssertFalse(lifecycle.takeRestart())
    }

    func testFaultRecoveryCannotOutlivePauseStopExitOrAnUnconfirmedWorkerShutdown() {
        for reason in [StartupBlock.paused, .stopped] {
            var lifecycle = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
            lifecycle.transition(.failed)
            XCTAssertTrue(lifecycle.requestFaultRecovery())
            lifecycle.block(reason)
            XCTAssertFalse(lifecycle.takeRestart())
            XCTAssertFalse(lifecycle.transition(.ready))
        }
        var lifecycle = HostStartupLifecycle(process: identity(), sessionID: 7, previous: nil)
        lifecycle.transition(.failed)
        XCTAssertTrue(lifecycle.requestFaultRecovery())
        XCTAssertFalse(lifecycle.takeRestart(childrenExited: false))
        XCTAssertFalse(lifecycle.takeRestart(childrenExited: true), "A failed shutdown consumes rather than delays the restart")
        lifecycle.transition(.failed)
        XCTAssertTrue(lifecycle.requestFaultRecovery())
        lifecycle.transition(.exited)
        XCTAssertFalse(lifecycle.takeRestart())
    }

    func testFaultRecoveryRateLimitExpiresAndDoesNotExtendOnRejectedAttempts() {
        var limiter = HostFaultRecoveryLimiter()
        XCTAssertTrue(limiter.admit(now: 100))
        XCTAssertTrue(limiter.admit(now: 105))
        XCTAssertTrue(limiter.admit(now: 110))
        XCTAssertFalse(limiter.admit(now: 115))
        XCTAssertFalse(limiter.admit(now: 159.9))
        XCTAssertTrue(limiter.admit(now: 160))
        XCTAssertFalse(limiter.admit(now: 164))
        XCTAssertTrue(limiter.admit(now: 165))
    }

    func testCrashRecoveryWaitsForExactOldWorkersAndLegacyStateStillDecodes() throws {
        var state = HostStartupState(process: identity(), sessionID: 7, state: .failed)
        let legacy = try JSONEncoder().encode(state)
        XCTAssertNil(try JSONDecoder().decode(HostStartupState.self, from: legacy).workers)
        let driver = identity(pid: 4567, path: "/Applications/Computer Use.app/Contents/Resources/bin/cua-driver")
        state.workers = [driver]
        XCTAssertFalse(HostStartupPolicy.oldWorkersExited(state, read: { _ in driver }))
        XCTAssertTrue(HostStartupPolicy.oldWorkersExited(state, read: { _ in nil }, processExists: { _ in false }))
        XCTAssertFalse(HostStartupPolicy.oldWorkersExited(state, read: { _ in nil }, processExists: { _ in true }), "Unreadable process identity does not confirm exit")
        XCTAssertTrue(HostStartupPolicy.oldWorkersExited(state, read: { _ in self.identity(pid: 4567, start: 99) }), "PID reuse is not a surviving worker")
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = HostStartupStore(directory: directory)
        try store.write(state)
        XCTAssertEqual(try store.read()?.workers, [driver])
        state.workers = [HostProcessIdentity(pid: -1, uid: getuid(), startTimeMicroseconds: 1, executable: "/test")]
        XCTAssertThrowsError(try store.write(state))
    }

    func testTrackedWorkerMustReallyExitBeforeColdRecoveryCanLaunch() throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["10"]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        var state = HostStartupState(process: identity(), sessionID: 7, state: .failed)
        state.workers = [try XCTUnwrap(HostProcessIdentity.read(pid: child.processIdentifier))]
        XCTAssertFalse(HostStartupPolicy.oldWorkersExited(state))
        child.terminate()
        child.waitUntilExit()
        XCTAssertTrue(HostStartupPolicy.oldWorkersExited(state))
    }

    func testReadyRequiresUnchangedStateSocketAndExactLiveProcessSessionAndPath() {
        let ready = HostStartupState(process: identity(), sessionID: 7, state: .ready)
        func result(after: HostStartupState?, actual: HostProcessIdentity? = nil, session: UInt32 = 7, connected: Bool = true) -> Bool {
            HostStartupPolicy.ready(before: ready, after: after, process: actual ?? identity(), executable: identity().executable,
                                    sessionID: session, socketReady: connected)
        }
        XCTAssertTrue(result(after: ready))
        XCTAssertFalse(result(after: ready, connected: false))
        XCTAssertFalse(result(after: nil))
        XCTAssertFalse(result(after: ready, actual: identity(start: 99)), "PID reuse is not the same process")
        XCTAssertFalse(result(after: ready, actual: identity(path: "/tmp/Other.app/Contents/MacOS/ComputerUseHost")))
        XCTAssertFalse(result(after: ready, session: 8))
        var paused = ready
        paused.state = .paused; paused.autoStartBlocked = true; paused.blockedReason = .paused
        XCTAssertFalse(result(after: paused), "Pause during the socket probe wins")
        XCTAssertFalse(HostStartupPolicy.matches(ready, process: nil, executable: identity().executable, sessionID: 7))
    }

    func testProcessIdentityReadsRealCurrentProcessAndRejectsMissingPID() throws {
        let current = try XCTUnwrap(HostProcessIdentity.read())
        XCTAssertEqual(current.pid, getpid())
        XCTAssertEqual(current.uid, getuid())
        XCTAssertGreaterThan(current.startTimeMicroseconds, 0)
        XCTAssertTrue(current.executable.hasPrefix("/"))
        XCTAssertEqual(current, HostProcessIdentity.read())
        XCTAssertNil(HostProcessIdentity.read(pid: Int32.max))
    }

    func testReadMissingStateIsReadOnlyAndWritesArePrivateAtomicSnapshots() throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = HostStartupStore(directory: directory)
        XCTAssertNil(try store.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        let first = HostStartupState(process: identity(), sessionID: 7, state: .ready)
        try store.write(first)
        let file = directory.appendingPathComponent("host-state.json")
        let old = try FileHandle(forReadingFrom: file)
        defer { try? old.close() }
        let second = HostStartupState(process: identity(), sessionID: 7, state: .paused, blockedReason: .paused)
        try store.write(second)
        XCTAssertEqual(try store.read(), second)
        XCTAssertEqual(try JSONDecoder().decode(HostStartupState.self, from: old.readToEnd()!), first)
        let directoryMode = try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber
        let fileMode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(directoryMode?.intValue, 0o700)
        XCTAssertEqual(fileMode?.intValue, 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["host-state.json"])
    }

    func testStoreRejectsSymlinkUntrustedModesAndMalformedStateWithoutChangingThem() throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = HostStartupStore(directory: directory)
        let state = HostStartupState(process: identity(), sessionID: 7, state: .ready)
        try store.write(state)
        let file = directory.appendingPathComponent("host-state.json")
        let target = directory.appendingPathComponent("original.json")
        try FileManager.default.moveItem(at: file, to: target)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
        XCTAssertThrowsError(try store.read())
        XCTAssertThrowsError(try store.write(state))
        XCTAssertEqual(try JSONDecoder().decode(HostStartupState.self, from: Data(contentsOf: target)), state)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: target, to: file)
        XCTAssertEqual(chmod(file.path, 0o644), 0)
        XCTAssertThrowsError(try store.read())
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o644)
        XCTAssertEqual(chmod(file.path, 0o600), 0)
        var invalid = state; invalid.autoStartBlocked = true
        try JSONEncoder().encode(invalid).write(to: file)
        XCTAssertThrowsError(try store.read())
    }

    func testGateIsSeparateFromSingletonAndBoundedAndReadOnlyProbeDoesNotCreateFiles() throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertFalse(try HostStartupGate.instanceExists(directory: directory))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        var gate: HostStartupGate? = try HostStartupGate(directory: directory, deadline: ProcessInfo.processInfo.systemUptime + 1)
        XCTAssertNotNil(gate)
        let host = try HostLock(directory: directory)
        try withExtendedLifetime(host) {
            XCTAssertTrue(try HostStartupGate.instanceExists(directory: directory))
            XCTAssertThrowsError(try HostStartupGate(directory: directory, deadline: ProcessInfo.processInfo.systemUptime))
            gate = nil
            XCTAssertNoThrow(try HostStartupGate(directory: directory, deadline: ProcessInfo.processInfo.systemUptime + 1))
        }
    }

    func testConcurrentHelpersCreateFreshPrivateDirectoriesWithoutEarlyFailure() throws {
        try assertConcurrentStartupAccess(precreate: false)
    }

    func testConcurrentHelpersShareExistingPrivateDirectoriesWithoutEarlyFailure() throws {
        try assertConcurrentStartupAccess(precreate: true)
    }

    func testConcurrentHelpersShareExistingLockWithoutEarlyFailure() throws {
        try assertConcurrentStartupAccess(precreate: true, precreateLock: true)
    }

    func testExistingGateStillRejectsSymlinksAndSharedModesWithoutChangingThem() throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let lock = directory.appendingPathComponent("startup.lock")
        let original = directory.appendingPathComponent("original")
        let contents = Data("unchanged".utf8)
        XCTAssertTrue(FileManager.default.createFile(atPath: original.path, contents: contents,
                                                    attributes: [.posixPermissions: 0o600]))
        try FileManager.default.createSymbolicLink(at: lock, withDestinationURL: original)
        XCTAssertThrowsError(try HostStartupGate(directory: directory, deadline: ProcessInfo.processInfo.systemUptime + 1))
        XCTAssertEqual(try Data(contentsOf: original), contents)
        try FileManager.default.removeItem(at: lock)
        XCTAssertTrue(FileManager.default.createFile(atPath: lock.path, contents: contents,
                                                    attributes: [.posixPermissions: 0o644]))
        XCTAssertThrowsError(try HostStartupGate(directory: directory, deadline: ProcessInfo.processInfo.systemUptime + 1))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: lock.path)[.posixPermissions] as? NSNumber)?.intValue, 0o644)
        XCTAssertEqual(try Data(contentsOf: lock), contents)
    }

    private func assertConcurrentStartupAccess(precreate: Bool, precreateLock: Bool = false) throws {
        let root = directory()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let failures = StartupAccessFailures()
        let queue = DispatchQueue(label: "computer-use.startup-concurrency-test", attributes: .concurrent)
        for round in 0..<80 {
            let directory = root.appendingPathComponent("round-\(round)")
            if precreate {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
            }
            if precreateLock {
                let lock = directory.appendingPathComponent("startup.lock")
                XCTAssertTrue(FileManager.default.createFile(atPath: lock.path, contents: Data(),
                                                            attributes: [.posixPermissions: 0o600]))
            }
            let start = DispatchSemaphore(value: 0)
            let group = DispatchGroup()
            for worker in 0..<4 {
                group.enter()
                queue.async {
                    defer { group.leave() }
                    start.wait()
                    var stage = "initial-read"
                    do {
                        let store = HostStartupStore(directory: directory)
                        _ = try store.read()
                        stage = "gate"
                        let gate = try HostStartupGate(directory: directory, deadline: ProcessInfo.processInfo.systemUptime + 2)
                        try withExtendedLifetime(gate) {
                            stage = "locked-read"
                            _ = try store.read()
                        }
                    } catch {
                        failures.append("round=\(round) worker=\(worker) stage=\(stage) \(Self.startupFailureCode(error))")
                    }
                }
            }
            for _ in 0..<4 { start.signal() }
            // Gate acquisition is bounded; all work uses this test's empty local directories.
            group.wait()
        }
        let recorded = failures.snapshot()
        XCTAssertTrue(recorded.isEmpty,
                      "\(precreate ? "existing" : "fresh") directories: \(recorded.count)/320 attempts failed; " + recorded.prefix(24).joined(separator: "; "))
    }

    /// Include exact error categories and numeric codes only, never localized error text or paths.
    private static func startupFailureCode(_ error: Error) -> String {
        if let failure = error as? StartupFailure {
            switch failure {
            case .unsafeState: return "StartupFailure.unsafeState"
            case .invalidState: return "StartupFailure.invalidState"
            case .timedOut: return "StartupFailure.timedOut"
            case .io(let code): return "StartupFailure.io(\(code))"
            }
        }
        let cocoa = error as NSError
        let underlying = (cocoa.userInfo[NSUnderlyingErrorKey] as? NSError).map { " underlying=\($0.domain)(\($0.code))" } ?? ""
        return "NSError=\(cocoa.domain)(\(cocoa.code))" + underlying
    }

    func testReadRejectsFIFOWithoutWaitingForAnExternalWriter() throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        XCTAssertEqual(mkfifo(directory.appendingPathComponent("host-state.json").path, 0o600), 0)
        let started = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try HostStartupStore(directory: directory).read())
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 1)
    }

    func testReadinessRejectsNonSocketOrSharedSocketBeforeConnecting() throws {
        let path = "/tmp/cu-ready-\(UUID().uuidString).sock"
        defer { unlink(path) }
        XCTAssertFalse(try HostStartupPolicy.socketAcceptsConnections(path: path))
        try Data("not a socket".utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertThrowsError(try HostStartupPolicy.socketAcceptsConnections(path: path))
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
        XCTAssertEqual(withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }, 0)
        XCTAssertEqual(listen(fd, 4), 0)
        XCTAssertEqual(chmod(path, 0o666), 0)
        XCTAssertThrowsError(try HostStartupPolicy.socketAcceptsConnections(path: path))
        XCTAssertEqual(chmod(path, 0o600), 0)
        XCTAssertTrue(try HostStartupPolicy.socketAcceptsConnections(path: path))
    }
}

private final class StartupAccessFailures: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func append(_ value: String) {
        lock.lock()
        defer { lock.unlock() }
        values.append(value)
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}
