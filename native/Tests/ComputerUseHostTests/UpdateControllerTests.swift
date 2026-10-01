import AppKit
import XCTest
@testable import ComputerUseHost
@testable import HostCore

/// 更新状态机：用假的 CLI 脚本代替内置 Node，不联网，也不弹出确认框（只测到校验为止）。
final class UpdateControllerTests: XCTestCase {
    private var directory: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        _ = NSApplication.shared
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("cu-controller-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        suite = "com.starroy.computeruse.controller-tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
    }

    private static let available = #"{"current":"0.4.0","latest":"0.5.0","available":true,"platform":"macos-arm64","tag":"v0.5.0","url":"https://github.com/starroyhq/computer-use/releases/tag/v0.5.0","notes":"n","asset":{"name":"computer-use-0.5.0-macos-arm64.zip","size":10}}"#

    func testAutomaticChecksRecordTheTimeAndAnnounceOnlyVersionsNotSkipped() throws {
        let controller = try makeController(check: "printf '%s\\n' '\(Self.available)'")
        controller.check(manual: false)
        try waitFor(controller) { if case .available = $0 { return true }; return false }
        XCTAssertNotNil(controller.preferences.lastCheck)
        XCTAssertEqual(controller.announced?.latest, "0.5.0")

        controller.skip()
        XCTAssertTrue(controller.isSkipped)
        XCTAssertNil(controller.announced)
        XCTAssertEqual(controller.preferences.skippedVersion, "0.5.0")
        controller.check(manual: false)
        try waitFor(controller) { if case .available = $0 { return true }; return false }
        XCTAssertNil(controller.announced, "A skipped version is not announced by automatic checks")
        controller.check(manual: true)
        try waitFor(controller) { if case .available = $0 { return true }; return false }
        XCTAssertEqual(controller.announced?.latest, "0.5.0", "A manual check always shows the result")
    }

    func testFailedAutomaticChecksStayQuietButManualChecksShowTheReason() throws {
        let failing = #"printf '%s\n' '{"error":{"code":"unavailable","message":"GitHub rate limit reached; try again later."}}' >&2; exit 1"#
        let controller = try makeController(check: failing)
        controller.check(manual: false)
        try waitFor(controller) { if case .idle = $0 { return true }; return false }
        XCTAssertNil(controller.preferences.lastCheck, "Only a successful check counts toward the daily schedule")
        controller.check(manual: true)
        try waitFor(controller) { if case .failed = $0 { return true }; return false }
        guard case let .failed(reason, _) = controller.phase else { return XCTFail("Expected a failure") }
        XCTAssertEqual(reason, tr(.updateErrorRateLimit))
    }

    func testFailedDownloadsAndPackagesThatFailVerificationLeaveNothingBehind() throws {
        // 下载失败：更新组件报告网络错误。
        let offline = try makeController(check: "printf '%s\\n' '\(Self.available)'",
                                         download: #"printf '%s\n' '{"error":{"code":"unavailable","message":"Cannot reach the update server; check the network connection."}}' >&2; exit 1"#)
        try offer(offline)
        offline.downloadAndInstall()
        try waitFor(offline) { if case .failed = $0 { return true }; return false }
        guard case let .failed(reason, check) = offline.phase else { return XCTFail("Expected a failure") }
        XCTAssertEqual(reason, tr(.updateErrorNetwork))
        XCTAssertEqual(check?.latest, "0.5.0", "The release stays known so the page can still be opened")
        XCTAssertEqual(try stages(), [])

        // 下载“成功”但不是有效安装包：解压失败，下载内容随即删除。
        let broken = try makeController(check: "printf '%s\\n' '\(Self.available)'", download: """
        printf 'not a zip' > "$4/computer-use-0.5.0-macos-arm64.zip"
        printf '{"version":"%s","platform":"macos-arm64","path":"%s/computer-use-0.5.0-macos-arm64.zip","sha256":"ab","bytes":9,"signing":"developer-id-notarized","commit":"c"}\\n' "$6" "$4"
        """)
        try offer(broken)
        broken.downloadAndInstall()
        try waitFor(broken) { if case .failed = $0 { return true }; return false }
        guard case let .failed(failure, _) = broken.phase else { return XCTFail("Expected a failure") }
        XCTAssertEqual(failure, UpdateFailure.verification(.verifyExtract).describe(language: .current))
        XCTAssertEqual(try stages(), [])
    }

    func testCancellingADownloadReturnsToTheOfferAndDiscardsThePartialStage() throws {
        let controller = try makeController(check: "printf '%s\\n' '\(Self.available)'", download: """
        printf '%s\\n' '{"event":"progress","downloaded":5,"total":10}' >&2
        exec sleep 20
        """)
        try offer(controller)
        controller.downloadAndInstall()
        try waitFor(controller) { if case let .downloading(_, downloaded, _) = $0 { return downloaded == 5 }; return false }
        XCTAssertEqual(try stages().count, 1)
        controller.cancelDownload()
        try waitFor(controller) { if case .available = $0 { return true }; return false }
        XCTAssertEqual(try stages(), [])
    }

    func testDevelopmentBuildsNeverDownloadOrInstall() throws {
        let controller = try makeController(check: "printf '%s\\n' '\(Self.available)'", download: "exit 9", teamID: nil)
        XCTAssertFalse(controller.isReleaseBuild)
        try offer(controller)
        controller.downloadAndInstall()
        guard case .available = controller.phase else { return XCTFail("A development build must not start a download") }
        XCTAssertEqual(try stages(), [])
    }

    // MARK: 辅助

    private func makeController(check: String, download: String = "exit 9", teamID: String? = "A1B2C3D4E5") throws -> UpdateController {
        let script = directory.appendingPathComponent("cli-\(UUID().uuidString).sh")
        try Data("if [ \"$2\" = check ]; then\n\(check)\nelse\n\(download)\nfi\n".utf8).write(to: script)
        let command = UpdateCommand(executable: URL(fileURLWithPath: "/bin/sh"), leadingArguments: [script.path], environment: ["PATH": "/usr/bin:/bin"])
        let paths = HostPaths(resources: directory, home: directory)
        return UpdateController(paths: paths, info: ["CFBundleShortVersionString": "0.4.0", "CFBundleVersion": "5"], teamID: teamID,
                                command: command, caches: directory.appendingPathComponent("Caches", isDirectory: true), defaults: defaults)
    }

    private func offer(_ controller: UpdateController) throws {
        controller.check(manual: true)
        try waitFor(controller) { if case .available = $0 { return true }; return false }
    }

    private func stages() throws -> [String] {
        let root = UpdateInstaller.updatesDirectory(caches: directory.appendingPathComponent("Caches", isDirectory: true))
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: root.path)
    }

    /// 回调都投递到主队列；在主线程上转动 run loop 直到状态满足条件。
    private func waitFor(_ controller: UpdateController, timeout: TimeInterval = 10,
                         _ condition: (UpdateController.Phase) -> Bool, file: StaticString = #filePath, line: UInt = #line) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(controller.phase) {
            guard Date() < deadline else {
                XCTFail("Timed out in phase \(controller.phase)", file: file, line: line)
                throw XCTSkip("timed out")
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
    }
}
