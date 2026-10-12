import Foundation
import XCTest
@testable import ComputerUseHost
@testable import HostCore

final class ConnectAccessTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!
    private let paths = HostPaths(resources: URL(fileURLWithPath: "/Test App's $Resources/Contents/Resources"),
                                  home: FileManager.default.temporaryDirectory)

    override func setUp() {
        suite = "ConnectAccessTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testProfileValidationAndSavedSelection() {
        for value in ["default", "Work_2-agent", String(repeating: "a", count: 64)] {
            XCTAssertTrue(ConnectAccess.validProfile(value))
        }
        for value in ["", "../secret", "a b", "中文", "a\n", String(repeating: "a", count: 65)] {
            XCTAssertFalse(ConnectAccess.validProfile(value))
        }
        defaults.set("../invalid", forKey: ConnectAccess.selectionKey)
        let access = makeAccess { _, _ in XCTFail("Selecting a profile must not run the CLI") }
        XCTAssertEqual(access.selectedProfile, "default")
        XCTAssertTrue(access.selectProfile("work-agent"))
        XCTAssertFalse(access.selectProfile("bad name"))
        XCTAssertEqual(access.selectedProfile, "work-agent")
        XCTAssertEqual(makeAccess { _, _ in }.selectedProfile, "work-agent")
    }

    func testPeriodicRefreshLoadsOnceButExplicitRefreshRunsAgain() {
        var calls = [[String]]()
        let access = makeAccess { arguments, completion in
            calls.append(arguments)
            completion(.success(Self.preflight(state: "unverified", profiles: ["work", "default", "work"])))
        }
        access.loadIfNeeded()
        access.loadIfNeeded()
        XCTAssertEqual(calls, [["preflight", "--profile", "default"]])
        XCTAssertEqual(access.profileState, .unverified)
        XCTAssertEqual(access.profiles, ["default", "work"])
        access.reload()
        XCTAssertEqual(calls.count, 2)
    }

    func testBusyRequestKeepsProfileAndCompletionConsistent() throws {
        var finish: ((Result<Data, ConnectFailure>) -> Void)?
        var calls = 0
        let access = makeAccess { _, completion in calls += 1; finish = completion }
        access.loadIfNeeded()
        XCTAssertTrue(access.isBusy)
        XCTAssertFalse(access.selectProfile("other"))
        access.reload()
        access.loadIfNeeded()
        XCTAssertEqual(calls, 1)
        try XCTUnwrap(finish)(.success(Self.preflight()))
        XCTAssertFalse(access.isBusy)
        XCTAssertEqual(access.selectedProfile, "default")
        XCTAssertEqual(access.profileState, .missing)
        XCTAssertTrue(access.selectProfile("other"))
        XCTAssertNil(access.profileState)
    }

    func testInvalidMetadataNeverAppearsAsVerifiedPairing() {
        let invalid = [
            Self.preflight(schema: 2),
            Self.preflight(name: "other"),
            Self.preflight(profiles: ["../credentials"]),
            Self.preflight(state: "unknown"),
            Data("not JSON".utf8),
        ]
        for data in invalid {
            let access = makeAccess { _, completion in completion(.success(data)) }
            access.reload()
            XCTAssertEqual(access.failure, .output)
            XCTAssertNil(access.profileState)
        }
        for state in ["missing", "invalid", "unverified", "valid", "unauthorized"] {
            let access = makeAccess { _, completion in completion(.success(Self.preflight(state: state))) }
            access.reload()
            XCTAssertNil(access.failure)
            XCTAssertEqual(access.profileState?.rawValue, state)
        }
    }

    func testSelectedProfileIsSharedByPairingConfigurationAndCompleteInstallationPrompt() throws {
        let prompt = "请为此 Agent 安装 Computer Use Skill。\n\n" + String(repeating: "Detailed installation instructions.\n", count: 600)
        var calls = [[String]]()
        let access = makeAccess { arguments, completion in
            calls.append(arguments)
            completion(.success(Data(prompt.utf8)))
        }
        XCTAssertTrue(access.selectProfile("work-agent"))
        let pair = ConnectAccess.pairCommand(paths: paths, profile: access.selectedProfile)
        XCTAssertTrue(pair.contains("App'\\''s $Resources"), "Shell paths must preserve quotes and dollar signs as literals")
        XCTAssertTrue(pair.hasSuffix("'pair' '--profile' 'work-agent' '--name' 'My Agent'"))
        let config = try XCTUnwrap(ConnectAccess.configuration(paths: paths, profile: access.selectedProfile))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(config.utf8)) as? [String: Any])
        let servers = try XCTUnwrap(object["mcpServers"] as? [String: [String: Any]])
        let server = try XCTUnwrap(servers["computer-use"])
        XCTAssertEqual(server["command"] as? String, paths.node.path)
        XCTAssertEqual(server["args"] as? [String], [paths.cliScript.path, "mcp", "stdio", "--profile", "work-agent"])
        var received: String?
        access.installationPrompt { result in
            switch result {
            case .success(let text): received = text
            case .failure(let error): XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertEqual(received, prompt)
        XCTAssertEqual(calls, [["skill", "prompt", "--profile", "work-agent"]],
                       "Copying the installation prompt must not export files, pair, or start the host")
    }

    func testInstallationPromptKeepsProfileStableUntilCompletion() throws {
        var finish: ((Result<Data, ConnectFailure>) -> Void)?
        var calls = [[String]]()
        let access = makeAccess { arguments, completion in
            calls.append(arguments)
            finish = completion
        }
        XCTAssertTrue(access.selectProfile("work-agent"))
        var received: String?
        access.installationPrompt { result in
            switch result {
            case .success(let text): received = text
            case .failure(let error): XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertTrue(access.isBusy)
        XCTAssertNil(received)
        XCTAssertFalse(access.selectProfile("other"))
        access.loadIfNeeded()
        access.reload()
        XCTAssertEqual(calls, [["skill", "prompt", "--profile", "work-agent"]])
        try XCTUnwrap(finish)(.success(Data("Install using profile work-agent.\n".utf8)))
        XCTAssertEqual(received, "Install using profile work-agent.\n")
        XCTAssertFalse(access.isBusy)
        XCTAssertEqual(access.selectedProfile, "work-agent")
    }

    func testInstallationPromptRejectsEmptyOrNonUTF8OutputAndPreservesSafeFailure() {
        for data in [Data(), Data(" \n".utf8), Data([0xff]), Data("prompt\0tail".utf8)] {
            let access = makeAccess { _, completion in completion(.success(data)) }
            var returnedFailure: ConnectFailure?
            access.installationPrompt { result in
                guard case .failure(let error) = result else { return XCTFail("Invalid prompt must be rejected") }
                returnedFailure = error
            }
            XCTAssertEqual(returnedFailure, .output)
            XCTAssertEqual(access.failure, .output)
        }
        let access = makeAccess { _, completion in completion(.failure(.timeout)) }
        var returnedFailure: ConnectFailure?
        access.installationPrompt { result in
            guard case .failure(let error) = result else { return XCTFail("Expected safe failure category") }
            returnedFailure = error
        }
        XCTAssertEqual(returnedFailure, .timeout)
        XCTAssertEqual(access.failure, .timeout)
    }

    /// These are isolated shell fixtures, never the installed Node, CLI, or desktop host.
    func testCommandRunnerDeliversCompleteStdoutOnMainThreadAndDiscardsStderr() throws {
        let fixture = try makeCommandFixture("printf 'private diagnostic' >&2\nprintf 'Install this Skill.\\nInstructions.\\n'\n")
        defer { try? FileManager.default.removeItem(at: fixture.resources) }
        let completed = expectation(description: "command completed")
        ConnectCommand.run(paths: fixture, arguments: ["skill", "prompt", "--profile", "default"]) { result in
            XCTAssertTrue(Thread.isMainThread)
            switch result {
            case .success(let data): XCTAssertEqual(String(data: data, encoding: .utf8), "Install this Skill.\nInstructions.\n")
            case .failure(let error): XCTFail("Unexpected error: \(error)")
            }
            completed.fulfill()
        }
        wait(for: [completed], timeout: 3)
    }

    func testCommandRunnerBoundsOutputAndElapsedTime() throws {
        let fixtures: [(String, TimeInterval, Int, ConnectFailure)] = [
            ("exec /usr/bin/yes X\n", 2, 1024, .output),
            ("exec /bin/sleep 5\n", 0.15, 1024, .timeout),
            ("printf 'private failure' >&2\nexit 7\n", 2, 1024, .command),
        ]
        for (script, timeout, limit, expected) in fixtures {
            let fixture = try makeCommandFixture(script)
            defer { try? FileManager.default.removeItem(at: fixture.resources) }
            let completed = expectation(description: "bounded command")
            ConnectCommand.run(paths: fixture, arguments: [], timeout: timeout, outputLimit: limit) { result in
                switch result {
                case .success: XCTFail("Expected \(expected)")
                case .failure(let error): XCTAssertEqual(error, expected)
                }
                completed.fulfill()
            }
            wait(for: [completed], timeout: 3)
        }
    }

    private func makeAccess(runner: @escaping ConnectAccess.Runner) -> ConnectAccess {
        ConnectAccess(paths: paths, defaults: defaults, runner: runner)
    }

    private static func preflight(schema: Int = 1, name: String = "default", state: String = "missing", profiles: [String] = []) -> Data {
        try! JSONSerialization.data(withJSONObject: [
            "schemaVersion": schema, "version": "0.6.1", "platform": "macos",
            "paths": ["node": "/package/bin/node", "cli": "/package/runtime/cli.js"],
            "host": ["state": "stopped"], "profiles": profiles,
            "profile": ["name": name, "state": state],
        ])
    }

    private func makeCommandFixture(_ script: String) throws -> HostPaths {
        let resources = FileManager.default.temporaryDirectory.appendingPathComponent("ConnectCommandTests-\(UUID().uuidString)")
        let fixture = HostPaths(resources: resources, home: resources)
        try FileManager.default.createDirectory(at: fixture.node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: fixture.cliScript.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: fixture.node, withDestinationURL: URL(fileURLWithPath: "/bin/sh"))
        try Data(script.utf8).write(to: fixture.cliScript)
        return fixture
    }
}
