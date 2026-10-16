import Darwin
import XCTest
@testable import ComputerUseHost
@testable import HostCore

final class HostStartupTests: XCTestCase {
    func testLaunchModesDoNotTreatArbitraryArgumentsAsBackgroundOrRecovery() {
        XCTAssertEqual(HostLaunchMode.parse([]), .normal)
        XCTAssertEqual(HostLaunchMode.parse(["--background"]), .background)
        XCTAssertEqual(HostLaunchMode.parse(["--ensure-running"]), .ensureRunning)
        XCTAssertEqual(HostLaunchMode.parse(["--recover-fault"]), .recoverFault)
        XCTAssertEqual(HostLaunchMode.parse(["--recognize-text"]), .recognizeText)
        XCTAssertEqual(HostLaunchMode.parse(["--paste-session"]), .pasteSession)
        XCTAssertNil(HostLaunchMode.parse(["--paste-session", "--background"]))
        XCTAssertNil(HostLaunchMode.parse(["--recover-fault", "--resume"]))
        XCTAssertNil(HostLaunchMode.parse(["--background", "--resume"]))
        XCTAssertNil(HostLaunchMode.parse(["--socket", "/tmp/custom.sock"]))
    }

    func testHelperResultsAreSingleLineBoundedJSONAndPermissionsHaveSpecificCode() throws {
        let cases = [HostStartupResult.ready] + ["paused", "stopped", "failed", "recovery_failed", "recovery_limited", "non_interactive", "timeout", "launch_failed", "permissions_required"].map(HostStartupResult.failure)
        for result in cases {
            let data = try JSONEncoder().encode(result)
            XCTAssertFalse(data.contains(10))
            XCTAssertLessThan(data.count, 1024)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(json["ok"] as? Bool, result.ok)
            if result.ok { XCTAssertEqual(json["state"] as? String, "ready"); XCTAssertNil(json["code"]) }
            else { XCTAssertEqual(json["code"] as? String, result.code); XCTAssertNil(json["state"]) }
        }
        XCTAssertEqual(HostStartupResult.failure("permissions_required").code, "permissions_required")
    }

    func testFaultRecoveryRequestRequiresExactTargetAndLiveSamePackageSender() {
        let executable = "/Applications/Computer Use.app/Contents/MacOS/ComputerUseHost"
        let target = HostProcessIdentity(pid: 1000, uid: getuid(), startTimeMicroseconds: 100, executable: executable)
        let sender = HostProcessIdentity(pid: 2000, uid: getuid(), startTimeMicroseconds: 200, executable: executable)
        let request = HostFaultRecoveryRequest(sender: sender, target: target)
        XCTAssertTrue(request.isTrusted(current: target, senderActual: sender))
        XCTAssertFalse(request.isTrusted(current: target, senderActual: nil))
        XCTAssertFalse(request.isTrusted(current: target, senderActual: HostProcessIdentity(pid: 2000, uid: getuid(), startTimeMicroseconds: 300, executable: executable)))
        XCTAssertFalse(request.isTrusted(current: sender, senderActual: sender))
        let otherPackage = HostProcessIdentity(pid: 2000, uid: getuid(), startTimeMicroseconds: 200, executable: "/tmp/Other.app/Contents/MacOS/ComputerUseHost")
        XCTAssertFalse(HostFaultRecoveryRequest(sender: otherPackage, target: target).isTrusted(current: target, senderActual: otherPackage))
        let otherUser = HostProcessIdentity(pid: 2000, uid: getuid() + 1, startTimeMicroseconds: 200, executable: executable)
        XCTAssertFalse(HostFaultRecoveryRequest(sender: otherUser, target: target).isTrusted(current: target, senderActual: otherUser))
        XCTAssertFalse(HostFaultRecoveryRequest(sender: target, target: target).isTrusted(current: target, senderActual: target))
        var invalid = request
        invalid.id = "not-a-request-id"
        XCTAssertFalse(invalid.isTrusted(current: target, senderActual: sender))
    }

    func testFaultRecoveryReplyTransportKeepsRequestIdentityAndFixedResult() throws {
        let current = try XCTUnwrap(HostProcessIdentity.read())
        let sender = HostProcessIdentity(pid: Int32.max, uid: getuid(), startTimeMicroseconds: 1, executable: current.executable)
        let request = HostFaultRecoveryRequest(sender: sender, target: current)
        let received = expectation(description: "bounded recovery reply")
        let observer = HostFaultRecoveryIPC.observeReply(to: request) { code in
            XCTAssertEqual(code, "recovery_limited")
            received.fulfill()
        }
        defer { DistributedNotificationCenter.default().removeObserver(observer) }
        HostFaultRecoveryIPC.reply(request, result: "recovery_limited")
        wait(for: [received], timeout: 3)
    }

    func testLaunchDiagnosticsKeepStageAndErrorCodeWithoutPrivateDescriptions() throws {
        let sensitive = "/private/user/document-or-token"
        let errors: [(Error, String)] = [
            (StartupFailure.io(EACCES), "errno_\(EACCES)"),
            (StartupFailure.unsafeState, "unsafe_state"),
            (NSError(domain: NSCocoaErrorDomain, code: 4, userInfo: [NSLocalizedDescriptionKey: sensitive]), "NSCocoaErrorDomain_4"),
            (NSError(domain: sensitive, code: 19, userInfo: [NSFilePathErrorKey: sensitive]), "other_19")
        ]
        for (error, expected) in errors {
            let result = HostStartupResult.launchFailure(.initialState, error: error)
            XCTAssertEqual(result.code, "launch_failed")
            XCTAssertTrue(result.message?.contains("[initialState:\(expected)]") == true)
            let data = try JSONEncoder().encode(result)
            XCTAssertLessThan(data.count, 1024)
            XCTAssertFalse(data.contains(10))
            XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(sensitive))
        }
    }

    func testPackageValidationRequiresSameExecutableIDAndReceipt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cu-package-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("Computer Use.app")
        let resources = app.appendingPathComponent("Contents/Resources")
        for subdirectory in ["Contents/MacOS", "Contents/Resources/bin", "Contents/Resources/runtime"] {
            try FileManager.default.createDirectory(at: app.appendingPathComponent(subdirectory), withIntermediateDirectories: true)
        }
        let executable = app.appendingPathComponent("Contents/MacOS/ComputerUseHost").resolvingSymlinksInPath().path
        try Data("test fixture".utf8).write(to: URL(fileURLWithPath: executable))
        XCTAssertEqual(chmod(executable, 0o700), 0)
        let info: [String: Any] = ["CFBundleIdentifier": HostPaths.bundleID, "CFBundleShortVersionString": "0.6.1"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        for name in ["bin/cua-driver", "bin/node", "bin/computer-use", "runtime/host.js", "runtime/cli.js"] {
            let file = resources.appendingPathComponent(name)
            try Data("test fixture".utf8).write(to: file)
            XCTAssertEqual(chmod(file.path, 0o700), 0)
        }
        let receipt = resources.appendingPathComponent("build-receipt.json")
        try Data(#"{"owner":"computer-use-package-v1"}"#.utf8).write(to: receipt)
        XCTAssertNoThrow(try HostStartup.validatePackage(app: app, executable: executable))
        XCTAssertThrowsError(try HostStartup.validatePackage(app: app, executable: "/tmp/Other.app/Contents/MacOS/ComputerUseHost"))
        try Data(#"{"owner":"other-package"}"#.utf8).write(to: receipt)
        XCTAssertThrowsError(try HostStartup.validatePackage(app: app, executable: executable))
    }

    func testClosingOnExecDoesNotCloseOrReplaceCallerStandardStreams() throws {
        let original = [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO].map { fcntl($0, F_GETFD) }
        defer {
            for (fd, flags) in zip([STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO], original) where flags >= 0 {
                _ = fcntl(fd, F_SETFD, flags)
            }
        }
        try HostStartup.preventOutputInheritance()
        for (fd, previous) in zip([STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO], original) where previous >= 0 {
            let flags = fcntl(fd, F_GETFD)
            XCTAssertGreaterThanOrEqual(flags, 0)
            XCTAssertNotEqual(flags & FD_CLOEXEC, 0)
        }
    }
}
