import Foundation
import Security

/// 发布版本号 MAJOR.MINOR.PATCH（不含预发布后缀），按数值比较。
public struct ReleaseVersion: Comparable, CustomStringConvertible {
    public let major: Int, minor: Int, patch: Int

    public init?(_ text: String) {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var numbers: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 9, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  part == "0" || !part.hasPrefix("0"), let value = Int(part) else { return nil }
            numbers.append(value)
        }
        (major, minor, patch) = (numbers[0], numbers[1], numbers[2])
    }

    public static func < (left: ReleaseVersion, right: ReleaseVersion) -> Bool {
        (left.major, left.minor, left.patch) < (right.major, right.minor, right.patch)
    }

    public var description: String { "\(major).\(minor).\(patch)" }
}

public struct UpdateAsset: Decodable, Equatable {
    public let name: String
    public let size: Int
    public let sha256: String?
}

/// `computer-use update check` 的输出。
public struct UpdateCheck: Decodable, Equatable {
    public let current: String
    public let latest: String
    public let available: Bool
    public let platform: String
    public let tag: String
    public let url: String
    public let publishedAt: String?
    public let notes: String
    public let asset: UpdateAsset?

    /// 只打开本项目的 GitHub 发布页。
    public var releasePage: URL? {
        guard url.hasPrefix("https://github.com/\(UpdateCommand.repository)/releases/") else { return nil }
        return URL(string: url)
    }
}

/// `computer-use update download` 的输出：安装包已通过 SHA-256 与发布元数据校验。
public struct UpdateDownload: Decodable, Equatable {
    public let version: String
    public let platform: String
    public let path: String
    public let sha256: String
    public let bytes: Int
    public let signing: String
    public let commit: String
}

private struct UpdateProgressLine: Decodable {
    let event: String
    let downloaded: Int
    let total: Int
}

private struct CommandErrorLine: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String
    }
    let error: Body
}

public enum UpdateFailure: Error, Equatable, LocalizedError {
    /// 更新组件以 JSON 报告的错误。
    case service(code: String, message: String)
    case launch
    case unreadableOutput
    case cancelled
    case verification(L10nKey)

    // 与 src/update.ts 的错误文案对应；未列出的文案原样附在通用提示后面。
    static let knownMessages: [(prefix: String, key: L10nKey)] = [
        ("Cannot reach the update server", .updateErrorNetwork),
        ("GitHub rate limit reached", .updateErrorRateLimit),
        ("The latest release changed", .updateErrorChanged),
        ("The latest release has no package", .updateErrorNoPackage),
        ("This build is already up to date", .updateErrorUpToDate),
    ]

    public var errorDescription: String? { describe(language: .current) }

    public func describe(language: HostLanguage) -> String {
        switch self {
        case let .service(code, message):
            if code == "timeout" { return L10n.text(.updateErrorTimeout, language: language) }
            if let known = Self.knownMessages.first(where: { message.hasPrefix($0.prefix) }) {
                return L10n.text(known.key, language: language)
            }
            return L10n.format(.updateErrorGeneric, [String(message.prefix(300))], language: language)
        case .launch: return L10n.text(.updateErrorLaunch, language: language)
        case .unreadableOutput: return L10n.text(.updateErrorOutput, language: language)
        case .cancelled: return L10n.text(.commonCancel, language: language)
        case let .verification(reason):
            return L10n.format(.verifyFailed, [L10n.text(reason, language: language)], language: language)
        }
    }
}

public enum UpdateSchedule {
    public static let interval: TimeInterval = 24 * 60 * 60

    public static func isDue(lastCheck: Date?, now: Date, interval: TimeInterval = interval) -> Bool {
        guard let lastCheck else { return true }
        // 系统时间被调回时，上次检查会落在未来；同样视为到期，避免长期不再检查。
        return lastCheck > now || now.timeIntervalSince(lastCheck) >= interval
    }

    /// 自动检查只提示用户没有跳过的新版本；手动检查总是显示结果。
    public static func shouldAnnounce(_ check: UpdateCheck, skipped: String?, manual: Bool) -> Bool {
        check.available && (manual || check.latest != skipped)
    }
}

/// 更新偏好保存在 UserDefaults；自动检查默认开启。
public struct UpdatePreferences {
    public let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    enum Key {
        static let automatic = "updates.automaticChecks"
        static let lastCheck = "updates.lastCheck"
        static let skipped = "updates.skippedVersion"
    }

    public var automaticChecks: Bool {
        get { defaults.object(forKey: Key.automatic) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Key.automatic) }
    }

    public var lastCheck: Date? {
        get { defaults.object(forKey: Key.lastCheck) as? Date }
        nonmutating set { defaults.set(newValue, forKey: Key.lastCheck) }
    }

    public var skippedVersion: String? {
        get { defaults.string(forKey: Key.skipped) }
        nonmutating set { defaults.set(newValue, forKey: Key.skipped) }
    }
}

/// 通过内置 CLI 检查和下载更新：检查逻辑只在 TypeScript 里实现一次，两个宿主共用。
public final class UpdateCommand {
    public static let repository = "starroyhq/computer-use"
    static let outputLimit = 4 * 1024 * 1024

    let executable: URL
    let leadingArguments: [String]
    let environment: [String: String]

    public init(executable: URL, leadingArguments: [String], environment: [String: String]) {
        self.executable = executable
        self.leadingArguments = leadingArguments
        self.environment = environment
    }

    public convenience init(paths: HostPaths, inheritedEnvironment: [String: String]) {
        self.init(executable: paths.node, leadingArguments: [paths.cliScript.path],
                  environment: paths.childEnvironment(from: inheritedEnvironment))
    }

    /// 一次正在运行的命令；取消会结束子进程，结果报告为 `.cancelled`。
    public final class Run {
        let process: Process
        private let lock = NSLock()
        private var cancelledFlag = false
        init(process: Process) { self.process = process }

        var cancelled: Bool {
            lock.lock(); defer { lock.unlock() }
            return cancelledFlag
        }

        public func cancel() {
            lock.lock(); cancelledFlag = true; lock.unlock()
            if process.isRunning { process.terminate() }
        }
    }

    @discardableResult
    public func check(queue: DispatchQueue = .main, completion: @escaping (Result<UpdateCheck, UpdateFailure>) -> Void) -> Run? {
        run(["update", "check"], queue: queue, progress: nil) { result in
            completion(result.flatMap { data in
                guard let check = try? JSONDecoder().decode(UpdateCheck.self, from: data) else { return .failure(.unreadableOutput) }
                return .success(check)
            })
        }
    }

    /// 下载用户确认过的版本到已存在的私有目录；最新版在此期间变化时由 CLI 拒绝。
    @discardableResult
    public func download(version: String, into directory: URL, queue: DispatchQueue = .main,
                         progress: @escaping (Int, Int) -> Void,
                         completion: @escaping (Result<UpdateDownload, UpdateFailure>) -> Void) -> Run? {
        let arguments = ["update", "download", "--out", directory.path, "--release", version, "--progress"]
        return run(arguments, queue: queue, progress: progress) { result in
            completion(result.flatMap { data in
                guard let download = try? JSONDecoder().decode(UpdateDownload.self, from: data), download.version == version,
                      URL(fileURLWithPath: download.path).deletingLastPathComponent().standardizedFileURL.path
                        == directory.standardizedFileURL.path else { return .failure(.unreadableOutput) }
                return .success(download)
            })
        }
    }

    private func run(_ arguments: [String], queue: DispatchQueue, progress: ((Int, Int) -> Void)?,
                     completion: @escaping (Result<Data, UpdateFailure>) -> Void) -> Run? {
        let process = Process()
        process.executableURL = executable
        process.arguments = leadingArguments + arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let stdout = Pipe(), stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        let run = Run(process: process)
        let group = DispatchGroup()
        group.enter()
        process.terminationHandler = { _ in group.leave() }
        do { try process.run() } catch {
            queue.async { completion(.failure(.launch)) }
            return nil
        }
        // 父进程不能保留子进程的写端，否则读不到 EOF。
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()

        // 两个读取线程各自只写自己的变量；group 结束后才读取，DispatchGroup 保证可见性。
        var output = Data()
        var overflow = false
        var reported: CommandErrorLine.Body?
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { group.leave() }
            let handle = stdout.fileHandleForReading
            while let chunk = try? HostEventReader.readChunk(from: handle), !chunk.isEmpty {
                guard output.count + chunk.count <= Self.outputLimit else {
                    overflow = true
                    run.cancel()
                    break
                }
                output.append(chunk)
            }
            try? handle.close()
        }
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { group.leave() }
            let handle = stderr.fileHandleForReading
            var framer = LineFramer(maxBytes: 64 * 1024)
            while let chunk = try? HostEventReader.readChunk(from: handle), !chunk.isEmpty {
                guard let lines = try? framer.consume(chunk) else {
                    framer = LineFramer(maxBytes: 64 * 1024)
                    continue
                }
                for line in lines {
                    if let item = try? JSONDecoder().decode(UpdateProgressLine.self, from: line), item.event == "progress" {
                        if let progress { queue.async { progress(item.downloaded, item.total) } }
                    } else if let item = try? JSONDecoder().decode(CommandErrorLine.self, from: line) {
                        reported = item.error
                    }
                }
            }
            try? handle.close()
        }
        group.notify(queue: .global(qos: .utility)) {
            let result: Result<Data, UpdateFailure>
            if run.cancelled && !overflow {
                result = .failure(.cancelled)
            } else if overflow {
                result = .failure(.unreadableOutput)
            } else if process.terminationReason == .exit && process.terminationStatus == 0 {
                result = .success(output)
            } else if let reported {
                result = .failure(.service(code: reported.code, message: reported.message))
            } else {
                result = .failure(.unreadableOutput)
            }
            queue.async { completion(result) }
        }
        return run
    }
}

/// 安装更新时用到的检查与文件操作；界面流程在 App 里编排。
public enum UpdateInstaller {
    public static let appName = "Computer Use.app"

    public enum Blocker: Equatable {
        /// 从下载位置直接打开时，系统会把 App 放到只读的隔离路径运行。
        case translocated
        case notWritable
        case notBundle
    }

    public static func isTranslocated(_ app: URL) -> Bool { app.path.contains("/AppTranslocation/") }

    /// 只有能在原路径替换时才一键安装：Codex 配置与 ~/.local/bin 的符号链接都使用 App 的绝对路径。
    public static func blocker(for app: URL, fileManager: FileManager = .default) -> Blocker? {
        if isTranslocated(app) { return .translocated }
        guard app.pathExtension == "app" else { return .notBundle }
        guard fileManager.isWritableFile(atPath: app.deletingLastPathComponent().path),
              fileManager.isWritableFile(atPath: app.path) else { return .notWritable }
        return nil
    }

    /// 新 App 必须由同一个 Developer ID 团队签名，且 Bundle ID 相同；这样系统权限（TCC）也会保留。
    public static func requirement(teamID: String, bundleID: String = HostPaths.bundleID) -> String? {
        guard teamID.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
              bundleID.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil else { return nil }
        return "anchor apple generic and identifier \"\(bundleID)\""
            + " and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
            + " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
            + " and certificate leaf[subject.OU] = \"\(teamID)\""
    }

    public struct BundleInfo: Equatable {
        public let identifier: String
        public let version: String
        public let build: String
    }

    public static func bundleInfo(at app: URL) -> BundleInfo? {
        guard let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              let object = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let identifier = object["CFBundleIdentifier"] as? String,
              let version = object["CFBundleShortVersionString"] as? String else { return nil }
        return BundleInfo(identifier: identifier, version: version, build: object["CFBundleVersion"] as? String ?? "")
    }

    /// 解压目录里必须恰好有一个 Computer Use.app，而且是真实目录而不是符号链接。
    public static func expandedApp(in directory: URL) -> URL? {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return nil }
        let visible = names.filter { !$0.hasPrefix(".") && $0 != "__MACOSX" }
        guard visible == [appName] else { return nil }
        let app = directory.appendingPathComponent(appName, isDirectory: true)
        guard let type = try? FileManager.default.attributesOfItem(atPath: app.path)[.type] as? FileAttributeType,
              type == .typeDirectory else { return nil }
        return app
    }

    /// 新 App 的 Bundle ID 与版本必须与下载结果一致，并且比当前版本新（不降级）。
    public static func matches(_ app: URL, version: String, currentVersion: String?) -> Bool {
        guard let info = bundleInfo(at: app), info.identifier == HostPaths.bundleID, info.version == version,
              let next = ReleaseVersion(info.version) else { return false }
        if let currentVersion, let current = ReleaseVersion(currentVersion), next <= current { return false }
        return true
    }

    /// 解压并校验安装包，返回可以放到原路径的新 App。耗时操作，在后台线程调用。
    public static func prepare(_ download: UpdateDownload, stage: URL, currentVersion: String?, teamID: String) -> Result<URL, UpdateFailure> {
        let expanded = stage.appendingPathComponent("expanded", isDirectory: true)
        guard runTool("/usr/bin/ditto", ["-x", "-k", download.path, expanded.path]) == 0,
              let app = expandedApp(in: expanded) else { return .failure(.verification(.verifyExtract)) }
        guard matches(app, version: download.version, currentVersion: currentVersion) else {
            return .failure(.verification(.verifyBundle))
        }
        guard let requirement = requirement(teamID: teamID), CodeSigning.satisfies(app, requirement: requirement) else {
            return .failure(.verification(.verifySignature))
        }
        guard runTool("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path]) == 0 else {
            return .failure(.verification(.verifyGatekeeper))
        }
        return .success(app)
    }

    public static func updatesDirectory(caches: URL) -> URL {
        caches.appendingPathComponent(HostPaths.bundleID, isDirectory: true).appendingPathComponent("Updates", isDirectory: true)
    }

    /// 每次下载使用新的私有目录。
    public static func makeStage(caches: URL, version: String) throws -> URL {
        let root = updatesDirectory(caches: caches)
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let stage = root.appendingPathComponent("\(version)-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try fm.createDirectory(at: stage.appendingPathComponent("download", isDirectory: true), withIntermediateDirectories: false,
                               attributes: [.posixPermissions: 0o700])
        return stage
    }

    /// 启动时清理上次更新留下的目录（下载包、解压结果和被替换的旧 App）。
    public static func removeStages(caches: URL) {
        try? FileManager.default.removeItem(at: updatesDirectory(caches: caches))
    }

    /// 替换脚本：等旧进程退出，把旧 App 移到备份位置，再把新 App 放到原路径；任一步失败都还原并重新打开。
    /// 参数全部按位置传入，不拼接进脚本文本。
    public static let swapScript = """
    pid=$1 current=$2 next=$3 backup=$4 opener=$5 limit=$6
    waited=0
    while /bin/kill -0 "$pid" 2>/dev/null; do
      if [ "$waited" -ge "$limit" ]; then exit 3; fi
      /bin/sleep 0.1
      waited=$((waited + 1))
    done
    if ! /bin/mv "$current" "$backup"; then
      "$opener" "$current"
      exit 4
    fi
    if ! /bin/mv "$next" "$current"; then
      /bin/mv "$backup" "$current"
      "$opener" "$current"
      exit 5
    fi
    "$opener" "$current"
    """

    public static func swapCommand(pid: Int32, current: URL, next: URL, backup: URL,
                                   opener: String = "/usr/bin/open", waitTenths: Int = 600) -> (executable: URL, arguments: [String]) {
        (URL(fileURLWithPath: "/bin/sh"),
         ["-c", swapScript, "computer-use-update", String(pid), current.path, next.path, backup.path, opener, String(waitTenths)])
    }

    /// 同步运行系统工具并返回退出码；输出丢弃。在后台线程调用。
    public static func runTool(_ path: String, _ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return -1 }
        process.waitUntilExit()
        return process.terminationReason == .exit ? process.terminationStatus : -1
    }
}

public enum CodeSigning {
    /// 当前进程的签名团队；ad-hoc 签名或未签名时为 nil（开发版本）。
    public static func currentTeamIdentifier() -> String? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        return teamIdentifier(of: staticCode)
    }

    public static func teamIdentifier(at url: URL) -> String? {
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        return teamIdentifier(of: staticCode)
    }

    static func teamIdentifier(of code: SecStaticCode) -> String? {
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)), &information) == errSecSuccess,
              let dictionary = information as? [String: Any] else { return nil }
        return dictionary[kSecCodeInfoTeamIdentifier as String] as? String
    }

    /// 完整校验签名（所有架构与嵌套代码、严格模式），并要求满足给定的签名要求。
    public static func satisfies(_ url: URL, requirement text: String) -> Bool {
        var staticCode: SecStaticCode?
        var requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess, let staticCode,
              SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else { return false }
        let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSCheckNestedCode) | UInt32(kSecCSStrictValidate))
        return SecStaticCodeCheckValidity(staticCode, flags, requirement) == errSecSuccess
    }

    public static func isValidRequirement(_ text: String) -> Bool {
        var requirement: SecRequirement?
        return SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess && requirement != nil
    }
}
