import Foundation
import Darwin

public enum HostFailure: Error, LocalizedError {
    case unsafeDirectory, alreadyRunning, resourcesUnavailable, lineTooLong, invalidEvent, socketPathTooLong, socketOccupied
    public var errorDescription: String? {
        switch self {
        case .unsafeDirectory: return tr(.errorUnsafeDirectory)
        case .alreadyRunning: return tr(.errorAlreadyRunning)
        case .resourcesUnavailable: return tr(.errorResourcesUnavailable)
        case .lineTooLong: return tr(.errorLineTooLong)
        case .invalidEvent: return tr(.errorInvalidEvent)
        case .socketPathTooLong: return tr(.errorSocketPathTooLong)
        case .socketOccupied: return tr(.errorSocketOccupied)
        }
    }
}

public struct HostPaths {
    public static let bundleID = "com.starroy.computeruse"
    public let resources: URL
    public let data: URL
    public init(resources: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.resources = resources
        self.data = home.appendingPathComponent("Library/Application Support/Computer Use", isDirectory: true)
    }
    public var driver: URL { resources.appendingPathComponent("bin/cua-driver") }
    public var node: URL { resources.appendingPathComponent("bin/node") }
    public var runtime: URL { resources.appendingPathComponent("runtime/host.js") }
    public var cli: URL { resources.appendingPathComponent("bin/computer-use") }
    /// 宿主直接用内置 Node 运行 CLI 脚本（检查更新），不经过 shell 包装。
    public var cliScript: URL { resources.appendingPathComponent("runtime/cli.js") }
    public var licenses: URL { resources.appendingPathComponent("licenses", isDirectory: true) }
    public var driverSocket: String { data.appendingPathComponent("driver.sock").path }
    public var runtimeSocket: String { data.appendingPathComponent("runtime.sock").path }
    public var driverArguments: [String] { ["serve", "--embedded", "--parent-liveness-stdio", "--socket", driverSocket] }
    public var runtimeArguments: [String] {
        [runtime.path, "--socket", runtimeSocket, "--driver-socket", driverSocket, "--data-dir", data.path]
    }
    public func validateResources() throws {
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: driver.path), fm.isExecutableFile(atPath: node.path),
              fm.isReadableFile(atPath: runtime.path) else { throw HostFailure.resourcesUnavailable }
    }
    /// Agent-controlled environment must never select a driver approval mode or socket.
    public func childEnvironment(from inherited: [String: String]) -> [String: String] {
        var env = inherited.filter { !$0.key.hasPrefix("CUA_") && !$0.key.hasPrefix("NODE_") && !$0.key.hasPrefix("DYLD_") }
        env["CUA_DRIVER_EMBEDDED"] = "1"
        env["CUA_DRIVER_HOST_BUNDLE_ID"] = Self.bundleID
        env["CUA_DRIVER_PERMISSION_MODE"] = "standard"
        env["DO_NOT_TRACK"] = "1"
        env["CUA_DRIVER_RS_TELEMETRY_ENABLED"] = "false"
        env["CUA_DRIVER_RS_UPDATE_CHECK"] = "false"
        return env
    }
    public func stdioConfiguration() throws -> String {
        let value: [String: Any] = ["mcpServers": ["computer-use": ["command": cli.path, "args": ["mcp", "stdio"]]]]
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)
    }
}

public final class HostLock {
    private var descriptor: Int32 = -1
    public init(directory: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var statBuffer = stat()
        guard lstat(directory.path, &statBuffer) == 0,
              (statBuffer.st_mode & S_IFMT) == S_IFDIR, statBuffer.st_uid == getuid() else {
            throw HostFailure.unsafeDirectory
        }
        guard chmod(directory.path, 0o700) == 0 else { throw HostFailure.unsafeDirectory }
        let lockPath = directory.appendingPathComponent("host.lock").path
        let fd = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw HostFailure.unsafeDirectory }
        guard fstat(fd, &statBuffer) == 0, statBuffer.st_uid == getuid(),
              (statBuffer.st_mode & S_IFMT) == S_IFREG else {
            close(fd); throw HostFailure.unsafeDirectory
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw HostFailure.alreadyRunning }
        descriptor = fd
    }
    deinit { if descriptor >= 0 { flock(descriptor, LOCK_UN); close(descriptor) } }
}

public struct ClientRecord: Decodable, Equatable {
    public let id: String
    public let name: String
    /// 授权范围只用于展示；旧版运行时不发送这些字段。
    public let appIds: [String]?
    public let browser: Bool?
    public let foreground: Bool?

    public init(id: String, name: String, appIds: [String]? = nil, browser: Bool? = nil, foreground: Bool? = nil) {
        self.id = id
        self.name = name
        self.appIds = appIds
        self.browser = browser
        self.foreground = foreground
    }
}

public struct HostEvent: Decodable {
    public let event: String
    public let clientId: String?
    public let name: String?
    public let appIds: [String]?
    public let browser: Bool?
    public let foreground: Bool?
    public let sessionId: String?
    public let clientName: String?
    public let targetTitle: String?
    public let message: String?
    public let clients: [ClientRecord]?
    public let pid: Int?
    public let requestId: String?
    public let approved: Bool?

    public static func parse(_ data: Data) throws -> HostEvent {
        let item = try JSONDecoder().decode(Self.self, from: data)
        switch item.event {
        case "pair_request":
            guard let id = item.clientId, !id.isEmpty, item.name != nil,
                  item.appIds != nil, item.browser != nil else { throw HostFailure.invalidEvent }
        case "foreground_request":
            guard let id = item.sessionId, !id.isEmpty, item.clientName != nil,
                  item.targetTitle != nil else { throw HostFailure.invalidEvent }
        case "clients": guard item.clients != nil else { throw HostFailure.invalidEvent }
        case "decision_finished":
            guard let id = item.requestId, !id.isEmpty, item.approved != nil else { throw HostFailure.invalidEvent }
        case "fatal", "status": guard item.message != nil else { throw HostFailure.invalidEvent }
        case "ready": break
        case "control_begin", "control_end":
            guard let pid = item.pid, pid > 0, pid <= Int(Int32.max) else { throw HostFailure.invalidEvent }
        default: throw HostFailure.invalidEvent
        }
        return item
    }
}

public enum HostEventReader {
    public static func readChunk(from handle: FileHandle) throws -> Data {
        // FileHandle.read(upToCount:) can wait to fill the buffer on a pipe.
        // A persistent worker keeps stdout open, so deliver each available chunk.
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(handle.fileDescriptor, bytes.baseAddress!, bytes.count)
            }
            if count >= 0 { return Data(buffer.prefix(count)) }
            let code = errno
            if code == EINTR { continue }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
    }
}

public struct LineFramer {
    private var buffer = Data()
    public let maxBytes: Int
    public init(maxBytes: Int = 1_048_576) { self.maxBytes = maxBytes }
    public mutating func consume(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 10) {
            guard buffer.distance(from: buffer.startIndex, to: newline) <= maxBytes else { throw HostFailure.lineTooLong }
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            if !line.isEmpty { lines.append(line) }
        }
        guard buffer.count <= maxBytes else { throw HostFailure.lineTooLong }
        return lines
    }
}

public enum HostControl {
    public static func encode(_ command: String, clientID: String? = nil, sessionID: String? = nil, pid: Int? = nil) throws -> Data {
        var object: [String: Any] = ["command": command]
        if let clientID { object["clientId"] = clientID }
        if let sessionID { object["sessionId"] = sessionID }
        if let pid { object["pid"] = pid }
        var result = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        result.append(10)
        return result
    }
}

/// Reference count for the macOS controlled-window mark. The first begin and the last end are the transitions the host applies.
public struct ControlLease {
    public private(set) var counts: [Int: Int] = [:]
    public init() {}
    public mutating func begin(_ pid: Int) -> Bool {
        let next = (counts[pid] ?? 0) + 1
        counts[pid] = next
        return next == 1
    }
    public mutating func end(_ pid: Int) -> Bool {
        guard let count = counts[pid] else { return false }
        if count > 1 {
            counts[pid] = count - 1
            return false
        }
        counts[pid] = nil
        return true
    }
    public mutating func endAll() -> [Int] {
        let pids = Array(counts.keys)
        counts.removeAll()
        return pids
    }
}

/// 审批请求队列。运行时回报某个请求已结束（批准、拒绝或过期）时，排队中的同一请求直接丢弃，
/// 正在显示的同一请求标记为撤回；宿主据此关闭弹窗，且不再发送迟到的决定。
public struct ApprovalQueue {
    public private(set) var pending: [HostEvent] = []
    public private(set) var activeID: String?
    public private(set) var activeWithdrawn = false
    public init() {}

    public static func requestID(of event: HostEvent) -> String? {
        event.event == "pair_request" ? event.clientId : event.sessionId
    }

    public mutating func enqueue(_ event: HostEvent) {
        pending.append(event)
    }

    /// 取出下一条请求并登记为正在显示；没有请求时返回 nil。
    public mutating func activateNext() -> HostEvent? {
        guard !pending.isEmpty else { return nil }
        let event = pending.removeFirst()
        activeID = Self.requestID(of: event)
        activeWithdrawn = false
        return event
    }

    /// 当前弹窗已结束（用户作答、被撤回或宿主停止）。
    public mutating func deactivate() {
        activeID = nil
        activeWithdrawn = false
    }

    /// 运行时回报请求结束。返回 true 表示有排队中或正在显示的弹窗因此失效。
    @discardableResult
    public mutating func finish(_ id: String) -> Bool {
        let queued = pending.count
        pending.removeAll { Self.requestID(of: $0) == id }
        let active = activeID == id
        if active { activeWithdrawn = true }
        return active || pending.count != queued
    }

    /// 停止服务时丢弃所有排队请求；正在显示的弹窗由宿主关闭。
    public mutating func removeAll() {
        pending.removeAll()
    }
}

public enum LocalSocket {
    public static func acceptsConnections(path: String) throws -> Bool {
        try connectionError(path: path) == 0
    }

    public static func removeStale(path: String) throws {
        var metadata = stat()
        guard lstat(path, &metadata) == 0 else {
            if errno == ENOENT { return }
            throw HostFailure.socketOccupied
        }
        guard (metadata.st_mode & S_IFMT) == S_IFSOCK, metadata.st_uid == getuid() else {
            throw HostFailure.socketOccupied
        }
        let failure = try connectionError(path: path)
        if failure == ENOENT { return }
        guard failure == ECONNREFUSED else { throw HostFailure.alreadyRunning }
        // Only a proven stale socket owned by this user can be removed.
        guard unlink(path) == 0 || errno == ENOENT else { throw HostFailure.socketOccupied }
    }

    private static func connectionError(path: String) throws -> Int32 {
        var address = sockaddr_un()
        let bytes = Array(path.utf8) + [UInt8(0)]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw HostFailure.socketPathTooLong }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { pointer in pointer.copyBytes(from: bytes) }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return errno }
        defer { close(descriptor) }
        guard fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 else { return errno }
        return withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 ? 0 : errno
            }
        }
    }
}
