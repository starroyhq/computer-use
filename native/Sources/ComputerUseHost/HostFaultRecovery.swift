import Foundation
import HostCore

/// No credentials or actions travel over this control channel. Its only operation is
/// rebuilding failed workers; business access is still authenticated by the runtime.
struct HostFaultRecoveryRequest: Codable, Equatable {
    var id = UUID().uuidString
    let sender: HostProcessIdentity
    let target: HostProcessIdentity

    var targetKey: String { "\(target.uid):\(target.pid):\(target.startTimeMicroseconds)" }

    func isTrusted(current: HostProcessIdentity, senderActual: HostProcessIdentity?) -> Bool {
        target == current && sender == senderActual && sender.pid != target.pid
            && sender.uid == current.uid && sender.executable == current.executable
            && UUID(uuidString: id) != nil
    }
}

enum HostFaultRecoveryIPC {
    static let requestName = Notification.Name("com.starroy.computeruse.recover-fault")
    static let replyName = Notification.Name("com.starroy.computeruse.recover-fault-result")
    private static let center = DistributedNotificationCenter.default()

    static func observeRequests(current: HostProcessIdentity, handler: @escaping (HostFaultRecoveryRequest) -> Void) -> NSObjectProtocol {
        let key = HostFaultRecoveryRequest(sender: current, target: current).targetKey
        return center.addObserver(forName: requestName, object: key, queue: .main) { notification in
            guard let request = decode(notification),
                  request.isTrusted(current: current, senderActual: HostProcessIdentity.read(pid: request.sender.pid)) else { return }
            handler(request)
        }
    }

    static func observeReply(to request: HostFaultRecoveryRequest, handler: @escaping (String) -> Void) -> NSObjectProtocol {
        center.addObserver(forName: replyName, object: request.id, queue: .main) { notification in
            guard decode(notification) == request,
                  HostProcessIdentity.read(pid: request.target.pid) == request.target,
                  let code = notification.userInfo?["result"] as? String else { return }
            handler(code)
        }
    }

    static func post(_ request: HostFaultRecoveryRequest) {
        center.postNotificationName(requestName, object: request.targetKey,
                                    userInfo: payload(request), deliverImmediately: true)
    }

    static func reply(_ request: HostFaultRecoveryRequest, result: String) {
        var body = payload(request)
        body["result"] = result
        center.postNotificationName(replyName, object: request.id, userInfo: body, deliverImmediately: true)
    }

    private static func payload(_ request: HostFaultRecoveryRequest) -> [String: String] {
        guard let data = try? JSONEncoder().encode(request) else { return [:] }
        return ["request": String(decoding: data, as: UTF8.self)]
    }

    private static func decode(_ notification: Notification) -> HostFaultRecoveryRequest? {
        guard let text = notification.userInfo?["request"] as? String, text.utf8.count <= 16_384 else { return nil }
        return try? JSONDecoder().decode(HostFaultRecoveryRequest.self, from: Data(text.utf8))
    }
}
