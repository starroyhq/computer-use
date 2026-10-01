import XCTest
import Darwin
@testable import HostCore

final class UpdateTests: XCTestCase {
    private var directory: URL!
    private let queue = DispatchQueue(label: "update-tests")

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("cu-update-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        _ = try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: 客户端与版本

    func testClientListCarriesGrantsAndAcceptsOlderRuntimes() throws {
        let event = try HostEvent.parse(Data(#"{"event":"clients","clients":[{"id":"a","name":"Agent","appIds":["com.apple.TextEdit"],"browser":false,"foreground":true},{"id":"b","name":"Old"}]}"#.utf8))
        XCTAssertEqual(event.clients, [
            ClientRecord(id: "a", name: "Agent", appIds: ["com.apple.TextEdit"], browser: false, foreground: true),
            ClientRecord(id: "b", name: "Old"),
        ])
        let pair = try HostEvent.parse(Data(#"{"event":"pair_request","clientId":"c","name":"Agent","appIds":[],"browser":true,"foreground":true}"#.utf8))
        XCTAssertEqual(pair.foreground, true)
    }

    func testReleaseVersionsCompareNumericallyAndRejectOtherForms() throws {
        XCTAssertGreaterThan(try XCTUnwrap(ReleaseVersion("0.10.0")), try XCTUnwrap(ReleaseVersion("0.9.9")))
        XCTAssertEqual(ReleaseVersion("1.2.3")?.description, "1.2.3")
        XCTAssertEqual(ReleaseVersion("1.0.0"), ReleaseVersion("1.0.0"))
        for invalid in ["0.5.0-beta.1", "01.0.0", "1.0", "1.0.0.0", "", "a.b.c", "1..0", "١.٢.٣", "1234567890.0.0"] {
            XCTAssertNil(ReleaseVersion(invalid), invalid)
        }
    }

    // MARK: 自动检查

    func testAutomaticChecksRunDailyAndRespectSkippedVersions() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(UpdateSchedule.isDue(lastCheck: nil, now: now))
        XCTAssertFalse(UpdateSchedule.isDue(lastCheck: now.addingTimeInterval(-3600), now: now))
        XCTAssertTrue(UpdateSchedule.isDue(lastCheck: now.addingTimeInterval(-UpdateSchedule.interval), now: now))
        XCTAssertTrue(UpdateSchedule.isDue(lastCheck: now.addingTimeInterval(86_400 * 30), now: now))

        let available = try check(latest: "0.5.0", available: true)
        XCTAssertTrue(UpdateSchedule.shouldAnnounce(available, skipped: nil, manual: false))
        XCTAssertFalse(UpdateSchedule.shouldAnnounce(available, skipped: "0.5.0", manual: false))
        XCTAssertTrue(UpdateSchedule.shouldAnnounce(available, skipped: "0.5.0", manual: true))
        XCTAssertTrue(UpdateSchedule.shouldAnnounce(available, skipped: "0.4.9", manual: false))
        XCTAssertFalse(UpdateSchedule.shouldAnnounce(try check(latest: "0.4.0", available: false), skipped: nil, manual: true))
    }

    func testPreferencesDefaultToAutomaticChecksAndRoundTrip() throws {
        let suite = "com.starroy.computeruse.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = UpdatePreferences(defaults: defaults)
        XCTAssertTrue(preferences.automaticChecks)
        XCTAssertNil(preferences.lastCheck)
        XCTAssertNil(preferences.skippedVersion)
        preferences.automaticChecks = false
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        preferences.lastCheck = date
        preferences.skippedVersion = "0.5.0"
        XCTAssertFalse(UpdatePreferences(defaults: defaults).automaticChecks)
        XCTAssertEqual(UpdatePreferences(defaults: defaults).lastCheck, date)
        XCTAssertEqual(UpdatePreferences(defaults: defaults).skippedVersion, "0.5.0")
        preferences.skippedVersion = nil
        XCTAssertNil(preferences.skippedVersion)
    }

    // MARK: 调用内置 CLI

    func testCheckDecodesTheCommandOutput() throws {
        let command = try fakeCommand(#"""
        [ "$1 $2" = "update check" ] || exit 9
        printf '%s\n' '{"current":"0.4.0","latest":"0.5.0","available":true,"platform":"macos-arm64","tag":"v0.5.0","url":"https://github.com/starroyhq/computer-use/releases/tag/v0.5.0","publishedAt":"2026-10-01T08:00:00Z","notes":"修复","asset":{"name":"computer-use-0.5.0-macos-arm64.zip","size":12,"sha256":"ab"}}'
        """#)
        let result = try wait { done in command.check(queue: self.queue, completion: done) }
        let check = try result.get()
        XCTAssertEqual(check.latest, "0.5.0")
        XCTAssertEqual(check.asset?.size, 12)
        XCTAssertEqual(check.releasePage?.absoluteString, "https://github.com/starroyhq/computer-use/releases/tag/v0.5.0")
    }

    func testCommandErrorsAreReportedAndLocalized() throws {
        let rateLimited = try fakeCommand(#"""
        printf '%s\n' 'warning: noise' '{"error":{"code":"unavailable","message":"GitHub rate limit reached; try again later."}}' >&2
        exit 1
        """#)
        let failure = try wait { done in rateLimited.check(queue: self.queue, completion: done) }
        guard case let .failure(error) = failure else { return XCTFail("Expected a failure") }
        XCTAssertEqual(error, .service(code: "unavailable", message: "GitHub rate limit reached; try again later."))
        XCTAssertEqual(error.describe(language: .chinese), L10n.text(.updateErrorRateLimit, language: .chinese))
        XCTAssertEqual(UpdateFailure.service(code: "timeout", message: "x").describe(language: .english), L10n.text(.updateErrorTimeout, language: .english))
        XCTAssertEqual(UpdateFailure.service(code: "unavailable", message: "Odd failure.").describe(language: .english), "The update service reported: Odd failure.")

        let garbage = try fakeCommand("echo not-json")
        XCTAssertEqual(try wait { done in garbage.check(queue: self.queue, completion: done) }.failureValue, .unreadableOutput)
        let crashed = try fakeCommand("kill -9 $$")
        XCTAssertEqual(try wait { done in crashed.check(queue: self.queue, completion: done) }.failureValue, .unreadableOutput)
        let missing = UpdateCommand(executable: directory.appendingPathComponent("missing"), leadingArguments: [], environment: [:])
        XCTAssertEqual(try wait { done in missing.check(queue: self.queue, completion: done) }.failureValue, .launch)
    }

    func testDownloadReportsProgressAndAcceptsOnlyTheConfirmedVersionInTheStage() throws {
        // 参数：update download --out DIR --release VERSION --progress
        let script = #"""
        [ "$1 $2 $3 $5 $7" = "update download --out --release --progress" ] || exit 9
        printf '%s\n' '{"event":"progress","downloaded":5,"total":10}' '{"event":"progress","downloaded":10,"total":10}' >&2
        printf '{"version":"%s","platform":"macos-arm64","path":"%s/computer-use-%s-macos-arm64.zip","sha256":"ab","bytes":10,"signing":"developer-id-notarized","commit":"%s"}\n' "$VERSION_OUT" "$4" "$6" "cafe"
        """#
        let good = try fakeCommand(script, environment: ["VERSION_OUT": "0.5.0"])
        var progress: [[Int]] = []
        let result = try wait { done in
            good.download(version: "0.5.0", into: self.directory, queue: self.queue, progress: { progress.append([$0, $1]) }, completion: done)
        }
        let download = try result.get()
        XCTAssertEqual(download.path, directory.appendingPathComponent("computer-use-0.5.0-macos-arm64.zip").path)
        XCTAssertEqual(progress, [[5, 10], [10, 10]])
        // 输出的版本与确认的不一致时不接受。
        let other = try fakeCommand(script, environment: ["VERSION_OUT": "0.6.0"])
        XCTAssertEqual(try wait { done in
            other.download(version: "0.5.0", into: self.directory, queue: self.queue, progress: { _, _ in }, completion: done)
        }.failureValue, .unreadableOutput)
    }

    func testCancellingEndsTheCommand() throws {
        // exec：让被结束的进程就是持有管道的进程（真实 CLI 也是单个 Node 进程）。
        let slow = try fakeCommand("exec sleep 20")
        let finished = expectation(description: "cancelled")
        var outcome: Result<UpdateCheck, UpdateFailure>?
        let started = Date()
        let run = slow.check(queue: queue) { outcome = $0; finished.fulfill() }
        run?.cancel()
        wait(for: [finished], timeout: 5)
        XCTAssertEqual(outcome?.failureValue, .cancelled)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    // MARK: 安装前检查

    func testInPlaceInstallRequiresAWritableNonTranslocatedBundle() throws {
        XCTAssertTrue(UpdateInstaller.isTranslocated(URL(fileURLWithPath: "/private/var/folders/x/AppTranslocation/1234/d/Computer Use.app")))
        let parent = directory.appendingPathComponent("Applications", isDirectory: true)
        let app = parent.appendingPathComponent("Computer Use.app", isDirectory: true)
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        XCTAssertNil(UpdateInstaller.blocker(for: app))
        XCTAssertEqual(UpdateInstaller.blocker(for: parent), .notBundle)
        XCTAssertEqual(UpdateInstaller.blocker(for: URL(fileURLWithPath: "/private/var/folders/x/AppTranslocation/1/d/Computer Use.app")), .translocated)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: parent.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path) }
        XCTAssertEqual(UpdateInstaller.blocker(for: app), .notWritable)
    }

    func testSigningRequirementPinsTheTeamAndBundleIdentifier() throws {
        let requirement = try XCTUnwrap(UpdateInstaller.requirement(teamID: "A1B2C3D4E5"))
        XCTAssertTrue(requirement.contains(#"identifier "com.starroy.computeruse""#))
        XCTAssertTrue(requirement.contains(#"certificate leaf[subject.OU] = "A1B2C3D4E5""#))
        XCTAssertTrue(CodeSigning.isValidRequirement(requirement))
        for team in ["a1b2c3d4e5", "A1B2C3D4E", "A1B2C3D4E5F", #"A1B2C3D4E5" or true"#, ""] {
            XCTAssertNil(UpdateInstaller.requirement(teamID: team), team)
        }
        // 系统自带 App 不属于任何第三方团队。
        XCTAssertFalse(CodeSigning.satisfies(URL(fileURLWithPath: "/System/Applications/Calculator.app"), requirement: requirement))
    }

    func testDeveloperIDBuildSatisfiesItsOwnTeamRequirementOnly() throws {
        // 本机打包过 Developer ID 版本时才运行；CI 与开发签名的包跳过。
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("artifacts/Computer Use.app")
        guard let team = CodeSigning.teamIdentifier(at: app) else { throw XCTSkip("No Developer ID build in artifacts") }
        XCTAssertTrue(CodeSigning.satisfies(app, requirement: try XCTUnwrap(UpdateInstaller.requirement(teamID: team))))
        let other = team == "A1B2C3D4E5" ? "Z9Y8X7W6V5" : "A1B2C3D4E5"
        XCTAssertFalse(CodeSigning.satisfies(app, requirement: try XCTUnwrap(UpdateInstaller.requirement(teamID: other))))
    }

    func testPackageMustContainExactlyTheExpectedNewerApp() throws {
        let expanded = directory.appendingPathComponent("expanded", isDirectory: true)
        let app = try makeApp(in: expanded, version: "0.5.0")
        XCTAssertEqual(UpdateInstaller.expandedApp(in: expanded), app)
        XCTAssertEqual(UpdateInstaller.bundleInfo(at: app), .init(identifier: HostPaths.bundleID, version: "0.5.0", build: "7"))
        XCTAssertTrue(UpdateInstaller.matches(app, version: "0.5.0", currentVersion: "0.4.0"))
        XCTAssertFalse(UpdateInstaller.matches(app, version: "0.5.1", currentVersion: "0.4.0"))
        XCTAssertFalse(UpdateInstaller.matches(app, version: "0.5.0", currentVersion: "0.5.0"))
        XCTAssertFalse(UpdateInstaller.matches(app, version: "0.5.0", currentVersion: "0.6.0"))
        let other = try makeApp(in: directory.appendingPathComponent("other"), version: "0.5.0", identifier: "com.example.other")
        XCTAssertFalse(UpdateInstaller.matches(other, version: "0.5.0", currentVersion: "0.4.0"))

        try Data().write(to: expanded.appendingPathComponent(".DS_Store"))
        XCTAssertEqual(UpdateInstaller.expandedApp(in: expanded), app)
        try Data().write(to: expanded.appendingPathComponent("extra.txt"))
        XCTAssertNil(UpdateInstaller.expandedApp(in: expanded))

        let linked = directory.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createDirectory(at: linked, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: linked.appendingPathComponent(UpdateInstaller.appName), withDestinationURL: app)
        XCTAssertNil(UpdateInstaller.expandedApp(in: linked))
    }

    func testPreparationRejectsBrokenMismatchedAndUnsignedPackages() throws {
        let notZip = directory.appendingPathComponent("broken.zip")
        try Data("not a zip".utf8).write(to: notZip)
        XCTAssertEqual(prepare(notZip, version: "0.5.0"), .failure(.verification(.verifyExtract)))

        let source = directory.appendingPathComponent("source", isDirectory: true)
        let app = try makeApp(in: source, version: "0.4.9")
        let older = try zip(app, named: "older.zip")
        XCTAssertEqual(prepare(older, version: "0.5.0"), .failure(.verification(.verifyBundle)))

        try FileManager.default.removeItem(at: source)
        let unsigned = try zip(try makeApp(in: source, version: "0.5.0"), named: "unsigned.zip")
        XCTAssertEqual(prepare(unsigned, version: "0.5.0"), .failure(.verification(.verifySignature)))
    }

    /// 用真实发布的 macOS 安装包走一遍安装前校验（解压、Bundle、签名团队、Gatekeeper）。
    /// 设置 CU_LIVE_UPDATE_ZIP 与 CU_LIVE_UPDATE_VERSION 时运行；团队默认取 artifacts 里的 Developer ID 版本。
    func testLiveReleasePackagePassesInstallVerification() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let zip = environment["CU_LIVE_UPDATE_ZIP"], let version = environment["CU_LIVE_UPDATE_VERSION"] else {
            throw XCTSkip("Set CU_LIVE_UPDATE_ZIP and CU_LIVE_UPDATE_VERSION to verify a real release package")
        }
        let artifacts = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("artifacts/Computer Use.app")
        let team = try XCTUnwrap(environment["CU_LIVE_UPDATE_TEAM"] ?? CodeSigning.teamIdentifier(at: artifacts))
        let download = UpdateDownload(version: version, platform: "macos-arm64", path: zip, sha256: "", bytes: 0,
                                      signing: "developer-id-notarized", commit: "")
        let stage = directory.appendingPathComponent("live", isDirectory: true)
        let app = try UpdateInstaller.prepare(download, stage: stage, currentVersion: "0.0.1", teamID: team).get()
        XCTAssertEqual(UpdateInstaller.bundleInfo(at: app)?.version, version)
        XCTAssertEqual(CodeSigning.teamIdentifier(at: app), team)
        let other = team == "A1B2C3D4E5" ? "Z9Y8X7W6V5" : "A1B2C3D4E5"
        XCTAssertEqual(UpdateInstaller.prepare(download, stage: directory.appendingPathComponent("other"), currentVersion: "0.0.1", teamID: other),
                       .failure(.verification(.verifySignature)))
        XCTAssertEqual(UpdateInstaller.prepare(download, stage: directory.appendingPathComponent("same"), currentVersion: version, teamID: team),
                       .failure(.verification(.verifyBundle)))
    }

    /// 人工验收：在真实位置原位替换一个正在运行的 App，与“安装并重新打开”走同一套校验和替换脚本。
    /// 设置 CU_LIVE_INSTALL_APP、CU_LIVE_INSTALL_PID（该 App 的宿主进程）、CU_LIVE_UPDATE_ZIP 与 CU_LIVE_UPDATE_VERSION 时运行。
    func testLiveInPlaceInstallReplacesTheRunningApp() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let appPath = environment["CU_LIVE_INSTALL_APP"], let pidText = environment["CU_LIVE_INSTALL_PID"], let pid = Int32(pidText),
              let zip = environment["CU_LIVE_UPDATE_ZIP"], let version = environment["CU_LIVE_UPDATE_VERSION"] else {
            throw XCTSkip("Set CU_LIVE_INSTALL_APP, CU_LIVE_INSTALL_PID, CU_LIVE_UPDATE_ZIP and CU_LIVE_UPDATE_VERSION to replace a running app")
        }
        let current = URL(fileURLWithPath: appPath, isDirectory: true).standardizedFileURL
        // 只结束这个 App 自己的宿主进程。
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let executable = proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : ""
        guard executable == current.appendingPathComponent("Contents/MacOS/ComputerUseHost").path else {
            return XCTFail("Process \(pid) is not the host of \(current.path)")
        }
        XCTAssertNil(UpdateInstaller.blocker(for: current))
        let team = try XCTUnwrap(CodeSigning.teamIdentifier(at: current), "The running app must be Developer ID signed")
        let installed = try XCTUnwrap(UpdateInstaller.bundleInfo(at: current))
        let stage = try UpdateInstaller.makeStage(caches: directory.appendingPathComponent("Caches", isDirectory: true), version: version)
        let download = UpdateDownload(version: version, platform: "macos-arm64", path: zip, sha256: "", bytes: 0,
                                      signing: "developer-id-notarized", commit: "")
        let next = try UpdateInstaller.prepare(download, stage: stage, currentVersion: installed.version, teamID: team).get()
        let backup = stage.appendingPathComponent("Previous.app", isDirectory: true)
        let swap = UpdateInstaller.swapCommand(pid: pid, current: current, next: next, backup: backup)
        let process = Process()
        process.executableURL = swap.executable
        process.arguments = swap.arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        // App 内由“安装并重新打开”先停止服务再正常退出；这里先结束驱动与运行时，等它们退出后再结束宿主，
        // 这样新 App 启动时旧服务已释放 socket。
        _ = UpdateInstaller.runTool("/usr/bin/pkill", ["-TERM", "-P", String(pid)])
        let deadline = Date().addingTimeInterval(5)
        while UpdateInstaller.runTool("/usr/bin/pgrep", ["-P", String(pid)]) == 0, Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        XCTAssertEqual(kill(pid, SIGTERM), 0)
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "The swap script reports success")
        XCTAssertEqual(UpdateInstaller.bundleInfo(at: current)?.version, version)
        XCTAssertEqual(UpdateInstaller.bundleInfo(at: backup)?.version, installed.version)
        XCTAssertTrue(CodeSigning.satisfies(current, requirement: try XCTUnwrap(UpdateInstaller.requirement(teamID: team))))
    }

    func testStagesArePrivateAndRemovedTogether() throws {
        let caches = directory.appendingPathComponent("Caches", isDirectory: true)
        let stage = try UpdateInstaller.makeStage(caches: caches, version: "0.5.0")
        XCTAssertTrue(stage.path.hasPrefix(UpdateInstaller.updatesDirectory(caches: caches).path))
        XCTAssertTrue(stage.lastPathComponent.hasPrefix("0.5.0-"))
        for path in [UpdateInstaller.updatesDirectory(caches: caches).path, stage.path, stage.appendingPathComponent("download").path] {
            let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(mode?.intValue, 0o700, path)
        }
        UpdateInstaller.removeStages(caches: caches)
        XCTAssertFalse(FileManager.default.fileExists(atPath: UpdateInstaller.updatesDirectory(caches: caches).path))
    }

    // MARK: 原位替换脚本

    func testSwapReplacesTheAppAfterTheOldProcessExitsAndReopensIt() throws {
        let (current, next, backup) = try swapFixture()
        let old = try spawn("/bin/sleep", ["0.3"])
        let (status, opened) = try runSwap(pid: old.processIdentifier, current: current, next: next, backup: backup)
        XCTAssertEqual(status, 0)
        XCTAssertFalse(old.isRunning)
        XCTAssertEqual(try marker(current), "new")
        XCTAssertEqual(try marker(backup), "old")
        XCTAssertFalse(FileManager.default.fileExists(atPath: next.path))
        XCTAssertEqual(opened, current.path)
    }

    func testSwapRestoresTheOldAppWhenTheNewOneCannotBeMoved() throws {
        let (current, _, backup) = try swapFixture()
        let missing = directory.appendingPathComponent("missing.app")
        let (status, opened) = try runSwap(pid: 999_999, current: current, next: missing, backup: backup)
        XCTAssertEqual(status, 5)
        XCTAssertEqual(try marker(current), "old")
        XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path))
        XCTAssertEqual(opened, current.path)
    }

    func testSwapLeavesEverythingInPlaceWhenTheOldProcessKeepsRunning() throws {
        let (current, next, backup) = try swapFixture()
        let old = try spawn("/bin/sleep", ["10"])
        defer { old.terminate() }
        let (status, opened) = try runSwap(pid: old.processIdentifier, current: current, next: next, backup: backup, waitTenths: 3)
        XCTAssertEqual(status, 3)
        XCTAssertEqual(try marker(current), "old")
        XCTAssertEqual(try marker(next), "new")
        XCTAssertNil(opened)
    }

    // MARK: 辅助

    private func check(latest: String, available: Bool) throws -> UpdateCheck {
        try JSONDecoder().decode(UpdateCheck.self, from: Data(#"{"current":"0.4.0","latest":"\#(latest)","available":\#(available),"platform":"macos-arm64","tag":"v\#(latest)","url":"https://github.com/starroyhq/computer-use/releases/tag/v\#(latest)","notes":""}"#.utf8))
    }

    private func fakeCommand(_ body: String, environment: [String: String] = [:]) throws -> UpdateCommand {
        let script = directory.appendingPathComponent("cli-\(UUID().uuidString).sh")
        try Data(body.utf8).write(to: script)
        return UpdateCommand(executable: URL(fileURLWithPath: "/bin/sh"), leadingArguments: [script.path],
                             environment: environment.merging(["PATH": "/usr/bin:/bin"]) { value, _ in value })
    }

    private func wait<T>(_ start: (@escaping (Result<T, UpdateFailure>) -> Void) -> Any?) throws -> Result<T, UpdateFailure> {
        let finished = expectation(description: "command finished")
        var outcome: Result<T, UpdateFailure>?
        _ = start { outcome = $0; finished.fulfill() }
        wait(for: [finished], timeout: 10)
        return try XCTUnwrap(outcome)
    }

    @discardableResult
    private func makeApp(in parent: URL, version: String, identifier: String = HostPaths.bundleID) throws -> URL {
        let app = parent.appendingPathComponent(UpdateInstaller.appName, isDirectory: true)
        let contents = app.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        let plist: [String: Any] = ["CFBundleIdentifier": identifier, "CFBundleShortVersionString": version, "CFBundleVersion": "7",
                                    "CFBundleExecutable": "ComputerUseHost", "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        let executable = contents.appendingPathComponent("MacOS/ComputerUseHost")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        return app
    }

    private func zip(_ app: URL, named name: String) throws -> URL {
        let archive = directory.appendingPathComponent(name)
        XCTAssertEqual(UpdateInstaller.runTool("/usr/bin/ditto", ["-c", "-k", "--keepParent", app.path, archive.path]), 0)
        return archive
    }

    private func prepare(_ archive: URL, version: String) -> Result<URL, UpdateFailure> {
        let stage = directory.appendingPathComponent("stage-\(UUID().uuidString)", isDirectory: true)
        let download = UpdateDownload(version: version, platform: "macos-arm64", path: archive.path, sha256: "", bytes: 0,
                                      signing: "developer-id-notarized", commit: "")
        return UpdateInstaller.prepare(download, stage: stage, currentVersion: "0.4.0", teamID: "A1B2C3D4E5")
    }

    private func swapFixture() throws -> (URL, URL, URL) {
        let current = directory.appendingPathComponent("Applications/Computer Use.app", isDirectory: true)
        let next = directory.appendingPathComponent("stage/expanded/Computer Use.app", isDirectory: true)
        for (app, value) in [(current, "old"), (next, "new")] {
            try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
            try Data(value.utf8).write(to: app.appendingPathComponent("marker"))
        }
        return (current, next, directory.appendingPathComponent("stage/Previous.app", isDirectory: true))
    }

    private func marker(_ app: URL) throws -> String {
        try String(contentsOf: app.appendingPathComponent("marker"), encoding: .utf8)
    }

    private func spawn(_ path: String, _ arguments: [String]) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        try process.run()
        return process
    }

    /// 用记录参数的假 opener 代替 /usr/bin/open，返回退出码和被打开的路径。
    private func runSwap(pid: Int32, current: URL, next: URL, backup: URL, waitTenths: Int = 100) throws -> (Int32, String?) {
        let record = directory.appendingPathComponent("opened.txt")
        let opener = directory.appendingPathComponent("opener.sh")
        try Data("#!/bin/sh\nprintf '%s' \"$1\" > '\(record.path)'\n".utf8).write(to: opener)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: opener.path)
        let command = UpdateInstaller.swapCommand(pid: pid, current: current, next: next, backup: backup, opener: opener.path, waitTenths: waitTenths)
        let status = UpdateInstaller.runTool(command.executable.path, command.arguments)
        return (status, try? String(contentsOf: record, encoding: .utf8))
    }
}

private extension Result {
    var failureValue: Failure? {
        if case let .failure(error) = self { return error }
        return nil
    }
}
