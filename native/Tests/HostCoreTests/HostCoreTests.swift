import XCTest
import Darwin
@testable import HostCore

final class HostCoreTests: XCTestCase {
    func testReadyEventArrivesWhileRuntimeKeepsPipeOpen() throws {
        let pipe = Pipe()
        let ready = Data("{\"event\":\"ready\"}\n".utf8)
        let received = expectation(description: "receive ready before the worker exits")
        let finished = expectation(description: "reader finishes")
        DispatchQueue.global().async {
            defer { finished.fulfill() }
            do {
                let chunk = try HostEventReader.readChunk(from: pipe.fileHandleForReading)
                XCTAssertEqual(chunk, ready)
                var framer = LineFramer()
                let lines = try framer.consume(chunk)
                XCTAssertEqual(try HostEvent.parse(XCTUnwrap(lines.first)).event, "ready")
                received.fulfill()
                XCTAssertTrue(try HostEventReader.readChunk(from: pipe.fileHandleForReading).isEmpty)
            } catch { XCTFail("Reader failed: \(error)") }
        }
        try pipe.fileHandleForWriting.write(contentsOf: ready)
        let result = XCTWaiter.wait(for: [received], timeout: 1)
        // Always release the reader, including when a fill-buffer read regresses.
        try pipe.fileHandleForWriting.close()
        wait(for: [finished], timeout: 2)
        try pipe.fileHandleForReading.close()
        XCTAssertEqual(result, .completed, "A persistent worker does not close stdout after ready.")
    }

    func testPrivateEmbeddedLaunchAndEnvironment() throws {
        let paths = HostPaths(resources: URL(fileURLWithPath: "/Applications/Computer Use.app/Contents/Resources"), home: URL(fileURLWithPath: "/Users/test"))
        XCTAssertEqual(paths.driverArguments, ["serve", "--embedded", "--parent-liveness-stdio", "--socket", "/Users/test/Library/Application Support/Computer Use/driver.sock"])
        XCTAssertEqual(paths.runtimeArguments, [paths.runtime.path, "--socket", paths.runtimeSocket, "--driver-socket", paths.driverSocket, "--data-dir", paths.data.path])
        let env = paths.childEnvironment(from: ["PATH": "/usr/bin", "CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS": "1", "CUA_DRIVER_PERMISSION_MODE": "unrestricted", "NODE_OPTIONS": "--require=evil.js", "DYLD_INSERT_LIBRARIES": "evil.dylib"])
        XCTAssertNil(env["CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS"])
        XCTAssertNil(env["NODE_OPTIONS"])
        XCTAssertNil(env["DYLD_INSERT_LIBRARIES"])
        XCTAssertEqual(env["CUA_DRIVER_PERMISSION_MODE"], "standard")
        XCTAssertEqual(env["CUA_DRIVER_EMBEDDED"], "1")
        XCTAssertEqual(env["CUA_DRIVER_HOST_BUNDLE_ID"], "com.starroy.computeruse")
        XCTAssertEqual(env["CUA_DRIVER_RS_TELEMETRY_ENABLED"], "false")
        XCTAssertEqual(env["CUA_DRIVER_RS_UPDATE_CHECK"], "false")
        XCTAssertEqual(env["PATH"], "/usr/bin")
    }

    func testFramerHandlesFragmentedAndBatchedMessages() throws {
        var framer = LineFramer()
        XCTAssertTrue(try framer.consume(Data("{\"event\":\"rea".utf8)).isEmpty)
        let lines = try framer.consume(Data("dy\"}\n\n{\"event\":\"status\",\"message\":\"好\"}\n".utf8))
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(try HostEvent.parse(lines[0]).event, "ready")
        XCTAssertEqual(try HostEvent.parse(lines[1]).message, "好")
    }

    func testFramerRejectsOversizedCompleteAndIncompleteMessages() {
        var complete = LineFramer(maxBytes: 3), incomplete = LineFramer(maxBytes: 3)
        XCTAssertThrowsError(try complete.consume(Data("1234\n".utf8)))
        XCTAssertThrowsError(try incomplete.consume(Data("1234".utf8)))
    }

    func testAuthorizationEventsRequireExplicitIdentityAndScope() throws {
        let valid = Data(#"{"event":"pair_request","clientId":"agent-1","name":"Agent","appIds":["com.apple.TextEdit"],"browser":false}"#.utf8)
        XCTAssertEqual(try HostEvent.parse(valid).appIds, ["com.apple.TextEdit"])
        XCTAssertThrowsError(try HostEvent.parse(Data(#"{"event":"pair_request","name":"Agent"}"#.utf8)))
        XCTAssertThrowsError(try HostEvent.parse(Data(#"{"event":"foreground_request","sessionId":"s","clientName":"a"}"#.utf8)))
        XCTAssertThrowsError(try HostEvent.parse(Data(#"{"event":"unknown"}"#.utf8)))
        XCTAssertEqual(try HostEvent.parse(Data(#"{"event":"control_begin","pid":4242}"#.utf8)).pid, 4242)
        XCTAssertEqual(try HostEvent.parse(Data(#"{"event":"control_end","pid":4242}"#.utf8)).event, "control_end")
        XCTAssertThrowsError(try HostEvent.parse(Data(#"{"event":"control_begin"}"#.utf8)))
        XCTAssertThrowsError(try HostEvent.parse(Data(#"{"event":"control_begin","pid":0}"#.utf8)))
    }

    func testControlLeaseAppliesOnlyOnTheFirstBeginAndLastEnd() {
        var lease = ControlLease()
        XCTAssertTrue(lease.begin(7))
        XCTAssertFalse(lease.begin(7))
        XCTAssertFalse(lease.end(7))
        XCTAssertTrue(lease.end(7))
        XCTAssertFalse(lease.end(7))
        XCTAssertTrue(lease.begin(7))
        XCTAssertEqual(lease.endAll(), [7])
        XCTAssertTrue(lease.counts.isEmpty)
    }

    func testControlReadyFrameCarriesTheProcessId() throws {
        let frame = try HostControl.encode("control_ready", pid: 4242)
        XCTAssertEqual(frame.last, 10)
        let object = try JSONSerialization.jsonObject(with: frame) as? [String: Any]
        XCTAssertEqual(object?["command"] as? String, "control_ready")
        XCTAssertEqual(object?["pid"] as? Int, 4242)
    }

    func testControlFramesEscapeUntrustedStrings() throws {
        let frame = try HostControl.encode("pair_allow", clientID: "id\nwith\"quotes")
        XCTAssertEqual(frame.last, 10)
        XCTAssertEqual(frame.filter { $0 == 10 }.count, 1)
        let object = try JSONSerialization.jsonObject(with: frame) as? [String: String]
        XCTAssertEqual(object?["clientId"], "id\nwith\"quotes")
    }

    func testConfigurationPreservesSpacesInExecutablePath() throws {
        let paths = HostPaths(resources: URL(fileURLWithPath: "/Applications/Computer Use.app/Contents/Resources"))
        let config = try JSONSerialization.jsonObject(with: Data(paths.stdioConfiguration().utf8)) as! [String: Any]
        let servers = config["mcpServers"] as! [String: [String: Any]]
        XCTAssertEqual(servers["computer-use"]?["command"] as? String, paths.cli.path)
        XCTAssertEqual(servers["computer-use"]?["args"] as? [String], ["mcp", "stdio"])
    }

    func testLockEnforcesSingleOwnerAndPrivateDirectory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var first: HostLock? = try HostLock(directory: directory)
        XCTAssertNotNil(first)
        XCTAssertThrowsError(try HostLock(directory: directory))
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        first = nil
        XCTAssertNoThrow(try HostLock(directory: directory))
    }

    func testLockRejectsSymbolicLink() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("destination"), link = root.appendingPathComponent("link")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: destination)
        XCTAssertThrowsError(try HostLock(directory: link))
    }

    func testStaleCleanupPreservesFilesAndLiveSockets() throws {
        let path = "/tmp/cu-test-\(UUID().uuidString).sock"
        defer { unlink(path) }
        try Data("preserve me".utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertThrowsError(try LocalSocket.removeStale(path: path))
        XCTAssertEqual(try String(contentsOfFile: path), "preserve me")
        unlink(path)
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(listen(descriptor, 8), 0)
        XCTAssertTrue(try LocalSocket.acceptsConnections(path: path))
        XCTAssertThrowsError(try LocalSocket.removeStale(path: path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        close(descriptor)
        XCTAssertNoThrow(try LocalSocket.removeStale(path: path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testSocketProbeFailsForMissingAndLongPath() throws {
        XCTAssertFalse(try LocalSocket.acceptsConnections(path: "/tmp/cu-missing-\(UUID().uuidString)"))
        XCTAssertThrowsError(try LocalSocket.acceptsConnections(path: String(repeating: "x", count: 200)))
    }

    func testDecisionFinishedIdentifiesTheRequestToWithdraw() throws {
        let finished = try HostEvent.parse(Data(#"{"event":"decision_finished","requestId":"agent-1","approved":false}"#.utf8))
        XCTAssertEqual(finished.requestId, "agent-1")
        XCTAssertEqual(finished.approved, false)
        for invalid in [
            #"{"event":"decision_finished","approved":true}"#,
            #"{"event":"decision_finished","requestId":"","approved":true}"#,
            #"{"event":"decision_finished","requestId":"agent-1"}"#,
        ] {
            XCTAssertThrowsError(try HostEvent.parse(Data(invalid.utf8)))
        }
    }

    func testApprovalQueueWithdrawsQueuedAndShownRequestsOnceTheRuntimeFinishesThem() throws {
        func request(_ id: String) throws -> HostEvent {
            try HostEvent.parse(Data(#"{"event":"pair_request","clientId":"\#(id)","name":"Agent","appIds":[],"browser":true}"#.utf8))
        }
        var queue = ApprovalQueue()
        for id in ["shown", "queued", "later"] { try queue.enqueue(request(id)) }
        let shown = queue.activateNext()
        XCTAssertEqual(shown?.clientId, "shown")
        XCTAssertEqual(queue.activeID, "shown")

        let droppedQueued = queue.finish("queued")
        XCTAssertTrue(droppedQueued)
        XCTAssertEqual(queue.pending.map(\.clientId), ["later"])
        XCTAssertFalse(queue.activeWithdrawn)

        let withdrewShown = queue.finish("shown")
        XCTAssertTrue(withdrewShown)
        XCTAssertTrue(queue.activeWithdrawn)
        queue.deactivate()
        let late = queue.finish("shown")
        XCTAssertFalse(late)

        let next = queue.activateNext()
        XCTAssertEqual(next?.clientId, "later")
        XCTAssertFalse(queue.activeWithdrawn)
        queue.deactivate()
        try queue.enqueue(request("stopped"))
        queue.removeAll()
        let none = queue.activateNext()
        XCTAssertNil(none)
    }
}
