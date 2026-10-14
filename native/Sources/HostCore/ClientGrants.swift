import Foundation

public struct ClientGrantOperation: Decodable {
    public struct Failure: Decodable {
        public let code: String
        public let message: String
    }
    public let command: String
    public let requestId: String
    public let clientId: String
    public let ok: Bool
    public let error: Failure?

    func validate() throws {
        guard command == "grant_all_apps", UUID(uuidString: requestId) != nil, !clientId.isEmpty,
              (!ok || error == nil) else { throw HostFailure.invalidEvent }
    }
}

public struct ClientGrantRequest: Equatable {
    public let clientID: String
    public let requestID: String
    public let generation: UUID
}

public enum ClientGrantState: Equatable {
    case idle
    case pending(ClientGrantRequest)
    case succeeded(String)
    case failed(String, String)
    case unconfirmed(String)

    public var clientID: String? {
        switch self {
        case .idle: return nil
        case .pending(let request): return request.clientID
        case .succeeded(let id), .failed(let id, _), .unconfirmed(let id): return id
        }
    }

    public var isPending: Bool {
        if case .pending = self { return true }
        return false
    }
}

/// A sent command is not an authorization result. Only the matching persisted acknowledgement completes it.
public struct ClientGrantTracker {
    public private(set) var state: ClientGrantState = .idle
    private var revokedClientIDs: Set<String> = []
    public init() {}

    public mutating func begin(client: ClientRecord, generation: UUID) -> ClientGrantRequest? {
        guard !state.isPending, !revokedClientIDs.contains(client.id), client.canGrantAllApps else { return nil }
        let request = ClientGrantRequest(clientID: client.id, requestID: UUID().uuidString, generation: generation)
        state = .pending(request)
        return request
    }

    @discardableResult public mutating func receive(_ operation: ClientGrantOperation, clients: [ClientRecord], generation: UUID) -> Bool {
        guard case .pending(let request) = state, request.generation == generation,
              request.requestID == operation.requestId, request.clientID == operation.clientId else { return false }
        if operation.ok {
            // The accompanying snapshot must agree with the successful write.
            state = clients.contains { $0.id == request.clientID && $0.hasAllAppsAccess }
                ? .succeeded(request.clientID) : .unconfirmed(request.clientID)
        } else {
            state = .failed(request.clientID, operation.error?.code ?? "unavailable")
        }
        return true
    }

    @discardableResult public mutating func timeout(_ request: ClientGrantRequest) -> Bool {
        guard state == .pending(request) else { return false }
        state = .unconfirmed(request.clientID)
        return true
    }

    /// A local revoke takes precedence over any older acknowledgement still queued on stdout.
    @discardableResult public mutating func revoke(_ clientID: String) -> Bool {
        revokedClientIDs.insert(clientID)
        let pending = state.isPending && state.clientID == clientID
        if state.clientID == clientID { state = .failed(clientID, "unauthorized") }
        return pending
    }

    public func visibleClients(_ clients: [ClientRecord]) -> [ClientRecord] {
        clients.filter { !revokedClientIDs.contains($0.id) }
    }

    public mutating func reset() {
        state = .idle
        revokedClientIDs.removeAll()
    }
}
