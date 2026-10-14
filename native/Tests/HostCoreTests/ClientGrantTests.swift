import XCTest
@testable import HostCore

final class ClientGrantTests: XCTestCase {
    private let client = ClientRecord(id: "legacy", name: "Legacy", appIds: ["com.apple.TextEdit"], foreground: false)

    private func event(request: ClientGrantRequest, ok: Bool, clientID: String? = nil, clients: [String: Any]? = nil, error: [String: String]? = nil) throws -> HostEvent {
        var operation: [String: Any] = ["command": "grant_all_apps", "requestId": request.requestID,
                                      "clientId": clientID ?? request.clientID, "ok": ok]
        if let error { operation["error"] = error }
        let snapshot = clients ?? ["id": request.clientID, "name": "Legacy", "allApps": true, "foreground": true]
        return try HostEvent.parse(JSONSerialization.data(withJSONObject: ["event": "clients", "clients": [snapshot], "operation": operation]))
    }

    func testDesktopEligibilityDoesNotExpandBrowserOnlyOrCompletedGrants() {
        XCTAssertTrue(client.canGrantAllApps)
        XCTAssertFalse(ClientRecord(id: "browser", name: "Browser", appIds: [], browser: true, foreground: true).canGrantAllApps)
        XCTAssertFalse(ClientRecord(id: "unknown", name: "Old").canGrantAllApps)
        XCTAssertFalse(ClientRecord(id: "done", name: "Done", allApps: true, foreground: true).canGrantAllApps)
        XCTAssertTrue(ClientRecord(id: "foreground", name: "Foreground", allApps: true).canGrantAllApps)
    }

    func testMatchingPersistedAckIsRequiredForSuccess() throws {
        var tracker = ClientGrantTracker()
        let generation = UUID()
        let request = try XCTUnwrap(tracker.begin(client: client, generation: generation))
        XCTAssertEqual(tracker.state, .pending(request), "Sending does not imply a persisted grant")
        XCTAssertNil(tracker.begin(client: client, generation: generation), "Do not issue concurrent grant commands")
        let wrongClient = try event(request: request, ok: true, clientID: "different")
        XCTAssertFalse(tracker.receive(try XCTUnwrap(wrongClient.operation), clients: wrongClient.clients!, generation: generation))
        let ack = try event(request: request, ok: true)
        XCTAssertFalse(tracker.receive(try XCTUnwrap(ack.operation), clients: ack.clients!, generation: UUID()))
        XCTAssertEqual(tracker.state, .pending(request))
        XCTAssertTrue(tracker.receive(try XCTUnwrap(ack.operation), clients: ack.clients!, generation: generation))
        XCTAssertEqual(tracker.state, .succeeded(client.id))
        XCTAssertFalse(tracker.receive(try XCTUnwrap(ack.operation), clients: ack.clients!, generation: generation), "Duplicate results are ignored")
    }

    func testTimeoutAndRestartIgnoreLateAckWithoutResending() throws {
        var tracker = ClientGrantTracker()
        let generation = UUID()
        let first = try XCTUnwrap(tracker.begin(client: client, generation: generation))
        let ack = try event(request: first, ok: true)
        XCTAssertTrue(tracker.timeout(first))
        XCTAssertEqual(tracker.state, .unconfirmed(client.id))
        XCTAssertFalse(tracker.receive(try XCTUnwrap(ack.operation), clients: ack.clients!, generation: generation))
        XCTAssertEqual(tracker.visibleClients(ack.clients!).first?.hasAllAppsAccess, true,
                       "A late same-generation snapshot still refreshes the list without claiming confirmed success")
        XCTAssertEqual(tracker.state, .unconfirmed(client.id))
        let second = try XCTUnwrap(tracker.begin(client: client, generation: generation))
        XCTAssertNotEqual(first.requestID, second.requestID)
        XCTAssertFalse(tracker.timeout(first))
        XCTAssertFalse(tracker.receive(try XCTUnwrap(ack.operation), clients: ack.clients!, generation: generation))
        tracker.reset()
        XCTAssertEqual(tracker.state, .idle)
        XCTAssertFalse(tracker.timeout(second))
        XCTAssertFalse(tracker.receive(try XCTUnwrap(ack.operation), clients: ack.clients!, generation: UUID()))
    }

    func testLocalRevocationCannotBeUndoneByALateGrantSnapshot() throws {
        var tracker = ClientGrantTracker()
        let generation = UUID()
        let request = try XCTUnwrap(tracker.begin(client: client, generation: generation))
        let ack = try event(request: request, ok: true)
        XCTAssertTrue(tracker.revoke(client.id))
        XCTAssertEqual(tracker.state, .failed(client.id, "unauthorized"))
        XCTAssertFalse(tracker.receive(try XCTUnwrap(ack.operation), clients: ack.clients!, generation: generation))
        XCTAssertTrue(tracker.visibleClients(ack.clients!).isEmpty)
        XCTAssertNil(tracker.begin(client: client, generation: generation))
        let newClient = ClientRecord(id: "fresh-pair", name: "New", allApps: true, foreground: true)
        XCTAssertEqual(tracker.visibleClients(ack.clients! + [newClient]), [newClient])
        tracker.reset()
        XCTAssertEqual(tracker.visibleClients([newClient]), [newClient])
    }

    func testSaveFailureAndInconsistentSuccessDoNotClaimAuthorization() throws {
        var tracker = ClientGrantTracker()
        let generation = UUID()
        var request = try XCTUnwrap(tracker.begin(client: client, generation: generation))
        let failed = try event(request: request, ok: false, error: ["code": "unavailable", "message": "Disk write failed"])
        XCTAssertTrue(tracker.receive(try XCTUnwrap(failed.operation), clients: failed.clients!, generation: generation))
        XCTAssertEqual(tracker.state, .failed(client.id, "unavailable"))
        request = try XCTUnwrap(tracker.begin(client: client, generation: generation))
        let inconsistent = try event(request: request, ok: true, clients: ["id": client.id, "name": client.name, "allApps": true])
        XCTAssertTrue(tracker.receive(try XCTUnwrap(inconsistent.operation), clients: inconsistent.clients!, generation: generation))
        XCTAssertEqual(tracker.state, .unconfirmed(client.id))
    }

    func testProtocolPreservesLegacyClientsAndEncodesOnlyRequestedFields() throws {
        XCTAssertNil(try HostEvent.parse(Data(#"{"event":"clients","clients":[]}"#.utf8)).operation)
        var tracker = ClientGrantTracker()
        let request = try XCTUnwrap(tracker.begin(client: client, generation: UUID()))
        let encoded = try HostControl.encode("grant_all_apps", clientID: client.id, requestID: request.requestID)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: String])
        XCTAssertEqual(object, ["command": "grant_all_apps", "clientId": client.id, "requestId": request.requestID])
        XCTAssertNotNil(UUID(uuidString: request.requestID))
        let invalid = #"{"event":"clients","clients":[],"operation":{"command":"grant_all_apps","requestId":"bad","clientId":"x","ok":true}}"#
        XCTAssertThrowsError(try HostEvent.parse(Data(invalid.utf8)))
    }
}
