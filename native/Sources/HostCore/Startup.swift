import Darwin
import Foundation

public enum StartupFailure: Error {
    case unsafeState, invalidState, io(Int32), timedOut
}

public struct HostProcessIdentity: Codable, Equatable {
    public let pid: Int32
    public let uid: UInt32
    public let startTimeMicroseconds: UInt64
    public let executable: String

    public init(pid: Int32, uid: UInt32, startTimeMicroseconds: UInt64, executable: String) {
        self.pid = pid; self.uid = uid; self.startTimeMicroseconds = startTimeMicroseconds
        self.executable = executable
    }

    public static func read(pid: Int32 = getpid()) -> HostProcessIdentity? {
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout.size(ofValue: info)))
                == MemoryLayout.size(ofValue: info) else { return nil }
        // PROC_PIDPATHINFO_MAXSIZE expands to 4 * MAXPATHLEN and is not imported by Swift.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return HostProcessIdentity(pid: pid, uid: info.pbi_uid,
                                   startTimeMicroseconds: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
                                   executable: URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path)
    }
}

public enum StartupPhase: String, Codable { case starting, ready, paused, stopped, failed, permissionsRequired = "permissions_required", exited }
public enum StartupBlock: String, Codable { case paused, stopped }

public struct HostStartupState: Codable, Equatable {
    public var schemaVersion = 1
    public let process: HostProcessIdentity
    public let sessionID: UInt32
    public var state: StartupPhase
    public var autoStartBlocked: Bool
    public var blockedReason: StartupBlock?

    public init(process: HostProcessIdentity, sessionID: UInt32, state: StartupPhase,
                blockedReason: StartupBlock? = nil) {
        self.process = process; self.sessionID = sessionID; self.state = state
        self.autoStartBlocked = blockedReason != nil; self.blockedReason = blockedReason
    }

    public func validate() throws {
        guard schemaVersion == 1, process.pid > 0, process.startTimeMicroseconds > 0,
              process.executable.hasPrefix("/"), autoStartBlocked == (blockedReason != nil) else {
            throw StartupFailure.invalidState
        }
    }
}

/// A stopped reason belongs to the user, not to the lifetime of one process.
/// Only the local Resume/Restart buttons call resume(); launch and quit preserve it.
public struct HostStartupLifecycle {
    public private(set) var state: HostStartupState
    public private(set) var restartRequested = false

    public init(process: HostProcessIdentity, sessionID: UInt32, previous: HostStartupState?) {
        state = HostStartupState(process: process, sessionID: sessionID, state: .starting,
                                 blockedReason: previous?.blockedReason)
        if let reason = state.blockedReason { state.state = reason == .paused ? .paused : .stopped }
    }

    public mutating func block(_ reason: StartupBlock) {
        restartRequested = false
        state.blockedReason = reason; state.autoStartBlocked = true
        state.state = reason == .paused ? .paused : .stopped
    }

    public mutating func resume() {
        restartRequested = false
        state.blockedReason = nil; state.autoStartBlocked = false; state.state = .starting
    }

    @discardableResult public mutating func transition(_ phase: StartupPhase) -> Bool {
        if state.autoStartBlocked && (phase == .ready || phase == .starting) { return false }
        if phase == .exited { restartRequested = false }
        state.state = phase
        return true
    }

    public mutating func requestRestart() { if !state.autoStartBlocked { restartRequested = true } }
    public mutating func cancelRestart() { restartRequested = false }
    public mutating func takeRestart() -> Bool {
        let requested = restartRequested && !state.autoStartBlocked
        restartRequested = false
        return requested
    }
}

public enum HostStartupPolicy {
    public static func socketAcceptsConnections(path: String) throws -> Bool {
        var metadata = stat()
        guard lstat(path, &metadata) == 0 else {
            if errno == ENOENT { return false }
            throw StartupFailure.io(errno)
        }
        guard metadata.st_mode & S_IFMT == S_IFSOCK, metadata.st_uid == getuid(), metadata.st_mode & 0o077 == 0 else {
            throw StartupFailure.unsafeState
        }
        return try LocalSocket.acceptsConnections(path: path)
    }

    public static func blockingCode(_ state: HostStartupState?, live: Bool) -> String? {
        guard let state else { return nil }
        if let blocked = state.blockedReason { return blocked.rawValue }
        if live && [.paused, .stopped, .failed, .permissionsRequired].contains(state.state) { return state.state.rawValue }
        return nil
    }

    public static func matches(_ state: HostStartupState, process: HostProcessIdentity?,
                               executable: String, sessionID: UInt32) -> Bool {
        state.process == process && state.process.executable == executable && state.sessionID == sessionID
    }

    public static func ready(before: HostStartupState, after: HostStartupState?, process: HostProcessIdentity?,
                             executable: String, sessionID: UInt32, socketReady: Bool) -> Bool {
        socketReady && before == after && before.state == .ready && !before.autoStartBlocked
            && matches(before, process: process, executable: executable, sessionID: sessionID)
    }
}

/// Descriptor-based reads never follow a symlink or inspect a different inode after rename.
/// Only the GUI holding host.lock writes state; helpers read atomic snapshots.
public final class HostStartupStore {
    public let directory: URL
    private static let fileName = "host-state.json"
    public init(directory: URL) { self.directory = directory }

    public func read() throws -> HostStartupState? {
        guard let parent = try Self.openDirectory(directory, create: false) else { return nil }
        defer { close(parent) }
        let fd = openat(parent, Self.fileName, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            if errno == ENOENT { return nil }
            throw StartupFailure.io(errno)
        }
        defer { close(fd) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_uid == getuid(),
              metadata.st_mode & S_IFMT == S_IFREG, metadata.st_mode & 0o077 == 0,
              metadata.st_size >= 0, metadata.st_size <= 65_536 else { throw StartupFailure.unsafeState }
        var data = Data(), bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count < 0 { if errno == EINTR { continue }; throw StartupFailure.io(errno) }
            if count == 0 { break }
            data.append(contentsOf: bytes.prefix(count))
            guard data.count <= 65_536 else { throw StartupFailure.invalidState }
        }
        let state = try JSONDecoder().decode(HostStartupState.self, from: data)
        try state.validate()
        guard state.process.uid == getuid() else { throw StartupFailure.unsafeState }
        return state
    }

    public func write(_ state: HostStartupState) throws {
        try state.validate()
        guard state.process.uid == getuid(), let parent = try Self.openDirectory(directory, create: true) else {
            throw StartupFailure.unsafeState
        }
        defer { close(parent) }
        var previous = stat()
        if fstatat(parent, Self.fileName, &previous, AT_SYMLINK_NOFOLLOW) == 0 {
            guard previous.st_uid == getuid(), previous.st_mode & S_IFMT == S_IFREG,
                  previous.st_mode & 0o077 == 0 else { throw StartupFailure.unsafeState }
        } else if errno != ENOENT { throw StartupFailure.io(errno) }
        let temporary = ".host-state-\(UUID().uuidString).tmp"
        let fd = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw StartupFailure.io(errno) }
        defer { close(fd); unlinkat(parent, temporary, 0) }
        let data = try JSONEncoder().encode(state)
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 { if errno == EINTR { continue }; throw StartupFailure.io(errno) }
                guard count > 0 else { throw StartupFailure.io(EIO) }
                offset += count
            }
        }
        guard fsync(fd) == 0, renameat(parent, temporary, parent, Self.fileName) == 0 else { throw StartupFailure.io(errno) }
        guard fsync(parent) == 0 else { throw StartupFailure.io(errno) }
    }

    fileprivate static func openDirectory(_ directory: URL, create: Bool) throws -> Int32? {
        if create {
            // Create the final private mode atomically so concurrent readers cannot observe
            // a newly created directory before a separate permission update.
            if mkdir(directory.path, 0o700) != 0 {
                let failure = errno
                if failure == ENOENT {
                    try FileManager.default.createDirectory(at: directory.deletingLastPathComponent(),
                                                            withIntermediateDirectories: true,
                                                            attributes: [.posixPermissions: 0o700])
                    guard mkdir(directory.path, 0o700) == 0 || errno == EEXIST else { throw StartupFailure.io(errno) }
                } else if failure != EEXIST { throw StartupFailure.io(failure) }
            }
        }
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            if !create && errno == ENOENT { return nil }
            throw StartupFailure.io(errno)
        }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_mode & 0o077 == 0 else { close(fd); throw StartupFailure.unsafeState }
        return fd
    }
}

/// Separate from host.lock: a helper must not prevent its new GUI from taking the singleton lock.
public final class HostStartupGate {
    private let descriptor: Int32
    public init(directory: URL, deadline: TimeInterval) throws {
        guard let parent = try HostStartupStore.openDirectory(directory, create: true) else { throw StartupFailure.unsafeState }
        defer { close(parent) }
        // Concurrent first-use O_CREAT opens can fail with ENOENT on macOS. Resolve ownership
        // of creation explicitly, then open an already existing lock without attempting creation.
        var fd = openat(parent, "startup.lock", O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        if fd < 0 && errno == EEXIST {
            fd = openat(parent, "startup.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        }
        guard fd >= 0 else { throw StartupFailure.io(errno) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_mode & 0o077 == 0 else { close(fd); throw StartupFailure.unsafeState }
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            let failure = errno
            guard failure == EWOULDBLOCK || failure == EINTR else { close(fd); throw StartupFailure.io(failure) }
            guard ProcessInfo.processInfo.systemUptime < deadline else { close(fd); throw StartupFailure.timedOut }
            Thread.sleep(forTimeInterval: 0.05)
        }
        descriptor = fd
    }
    deinit { flock(descriptor, LOCK_UN); close(descriptor) }

    public static func instanceExists(directory: URL) throws -> Bool {
        guard let parent = try HostStartupStore.openDirectory(directory, create: false) else { return false }
        defer { close(parent) }
        let fd = openat(parent, "host.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { if errno == ENOENT { return false }; throw StartupFailure.io(errno) }
        defer { close(fd) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_mode & 0o077 == 0 else { throw StartupFailure.unsafeState }
        if flock(fd, LOCK_EX | LOCK_NB) == 0 { flock(fd, LOCK_UN); return false }
        guard errno == EWOULDBLOCK else { throw StartupFailure.io(errno) }
        return true
    }
}
